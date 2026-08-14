// multi-network-dashboard — Express 起動口。
//
// Corstack の server/index.ts から「単一プラグインを動かすのに必要な骨格」だけを取り出したもの。
// プラグイン一覧(registry)・共通検索・Home 概要・テーマ API などシェル固有の機能は持たない。
//
// 役割:
//   1. .env の読み込み(CLAUDE_CODE_OAUTH_TOKEN / NETINV_MODEL 等)
//   2. /api/network-investigation/* に プラグインの router をマウント
//   3. /api/global-overview/* に Central/Mist 直接 REST ダッシュボードの router をマウント
//   4. 定期実行(node-cron)の初期化 — 移植元では launchd が担っていた部分
//   5. フロントエンド配信(dev: Vite middleware / prod: dist/ 静的配信)

import express from "express";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// .env(gitignore 対象。CLAUDE_CODE_OAUTH_TOKEN を含む)。
// Docker では docker-compose が env として渡すので、ファイルが無くても動く。
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  /* .env が無くても、既に環境変数が入っていれば動く */
}

const PORT = Number(process.env.PORT ?? 8092);
const isProd = process.env.NODE_ENV === "production";

const { router: networkInvestigationRouter, runScheduledInvestigation } = await import(
  "../plugins/network-investigation/api.js"
);
const { initSchedule } = await import("../plugins/network-investigation/schedule.js");
const { primeMcpServerCache, mcpServerSourceStatus } = await import(
  "../plugins/network-investigation/mcp.js"
);
const { router: globalOverviewRouter, initGlobalOverview } = await import(
  "../plugins/global-overview/api.js"
);
const { router: webhookFeedRouter, initWebhookFeed } = await import(
  "../plugins/webhook-feed/api.js"
);
const { router: centralStreamingRouter, initCentralStreaming } = await import(
  "../plugins/central-streaming/api.js"
);
const { router: reportsRouter, initReports } = await import("../plugins/reports/api.js");
const { router: knowledgeRouter, initKnowledge } = await import("../plugins/knowledge/api.js");
const { router: bestPracticeRouter, initBestPractice } = await import(
  "../plugins/best-practice/api.js"
);
const { router: taggedTargetsRouter, initTaggedTargets } = await import(
  "../plugins/tagged-targets/api.js"
);
const { router: coachRouter, initCoach } = await import("../plugins/coach/api.js");

// ---- 配信中のビルドの識別(82)----
//
// 81 の修正が実機で効かなかった原因はここにある。`docker compose up -d --build` で
// サーバ側(prompt など *.ts)は新しくなるが、**開いたままのタブは古い JS を持ち続ける**。
// SPA なので画面を触っているだけでは再読み込みが起きず、
// 「サーバ側の修正だけ効いて、画面側の修正は効いていない」という紛らわしい状態になる。
//
// dist/index.html が指すエントリ JS のファイル名には Vite が内容ハッシュを入れているので、
// これをそのまま「今配信しているビルドの識別子」として返す。画面側(src/buildCheck.ts)は
// 自分が読み込んだ <script src> と突き合わせ、食い違ったら再読み込みを促す。
// dev(Vite middleware)ではハッシュ付きの成果物が無いので null を返し、画面は何もしない。
let buildEntryCache: { mtimeMs: number; entry: string | null } | null = null;

function currentBuildEntry(): string | null {
  if (!isProd) return null;
  const file = path.resolve(ROOT, "dist", "index.html");
  try {
    const { mtimeMs } = fs.statSync(file);
    if (buildEntryCache && buildEntryCache.mtimeMs === mtimeMs) return buildEntryCache.entry;
    const html = fs.readFileSync(file, "utf8");
    const m = html.match(/<script[^>]*\ssrc="([^"]*\/assets\/[^"]+\.js)"/);
    const entry = m ? m[1] : null;
    buildEntryCache = { mtimeMs, entry };
    return entry;
  } catch {
    // dist が無い/読めない場合は「判定しない」に倒す(画面に誤った警告を出さない)。
    return null;
  }
}

async function createServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // 疎通確認用(01 スパイクから引き継ぎ)。
  // mcpConfig は MCP サーバー定義の供給状態(07)。source が "fallback" なら
  // マウント済みの ~/.claude.json が壊れていて last-known-good で走っている。
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "multi-network-dashboard",
      port: PORT,
      mcpConfig: mcpServerSourceStatus(),
      ts: new Date().toISOString(),
    });
  });

  // 配信中のビルド(82)。SPA 側の「古い JS のまま開きっぱなし」検知に使う。
  // SPA のフォールバック(app.get("*"))より前に置く必要がある。
  app.get("/api/build", (_req, res) => {
    res.json({ entry: currentBuildEntry() });
  });

  // ---- プラグイン API ----
  // View 側(plugins/network-investigation/view/api.ts)の BASE と一致させる。
  app.use("/api/network-investigation", networkInvestigationRouter);

  // ---- Global Overview API(Central / Mist 直接 REST。MCP を経由しない)----
  // 認証情報は .env の CENTRAL_* / MIST_* を使う(instructions/05_findings.md)。
  // 未設定でもルート自体はマウントし、/status で「未設定」と分かるようにする。
  app.use("/api/global-overview", globalOverviewRouter);
  await initGlobalOverview();

  // ---- Webhook ログ API(17)----
  // Central / Mist の Webhook を Google Apps Script が書き込んでいるスプレッドシートを、
  // サービスアカウントで読み取って 3 ソース統合フィードにする。
  // WEBHOOK_LOG_SPREADSHEET_ID / secrets の鍵が未設定でもルートはマウントし、
  // /api/webhook-feed/status で「未設定」と分かるようにする(Global Overview と同じ方針)。
  app.use("/api/webhook-feed", webhookFeedRouter);
  await initWebhookFeed();

  // ---- Streaming(Central)API(20)----
  // New Central の Streaming API(WSS)をサーバ側が購読する。Webhook と違い
  // こちらから張りに行くアウトバウンド接続なので、公開 IP もポート開放も要らない
  // (13_findings.md Task 3 の結論)。ペイロードは CloudEvents + protobuf の二段エンコード。
  // 既定は「停止中」で、画面のトグルで明示的に有効化するまで接続しない。
  app.use("/api/central-streaming", centralStreamingRouter);
  await initCentralStreaming();

  // ---- 日次レポート(41)----
  // 他の 4 機能が既に持っているデータ(Global Overview のスナップショット / Webhook ログ /
  // Streaming の Audit Trail / ネットワーク調査の履歴)から「その日ぶん」を集約し、
  // LLM に分析させて data/reports/daily/YYYY-MM-DD.json に蓄積する。
  // 外部 API を新たに叩き直さないため、ここより後(各プラグインの init 済み)で初期化する。
  // 画面(レポートタブ)は 42 番。ここでは生成基盤と API だけを載せる。
  app.use("/api/reports", reportsRouter);
  await initReports();

  // ---- ナレッジ(46)----
  // ネットワーク調査(手動・自動事前調査)が終わるたびに、その結果から知見候補を抽出して
  // 承認待ちに積む。抽出は MCP を使わない軽い claude CLI 呼び出し(plugins/knowledge/extract.ts)。
  // 調査完了フックを network-investigation に登録するので、その router を載せた後に初期化する。
  // 蓄積したナレッジを次の調査プロンプトへ注入する(調査への反映)のは 47 番。
  app.use("/api/knowledge", knowledgeRouter);
  await initKnowledge();

  // ---- ベストプラクティス診断(51)----
  // Central / Mist の設定を公開ベストプラクティス(セキュリティ・RF)と突き合わせる。
  // 収集は claude CLI を経由せず MCP を直接呼ぶ(決定的な取得に LLM を挟まない)。
  // **実行はユーザーが「診断実行」を押したときだけ**で、定期実行の口は持たない(51 の確定事項)。
  // 画面(タブ UI)は未実装。ここでは実行エンジンと API まで。
  app.use("/api/best-practice", bestPracticeRouter);
  await initBestPractice();

  // ---- タグ付き Client / Device(59)----
  // 「今気にしている特定の端末・機器」だけに絞った専用ビュー。タグはこのダッシュボード固有の
  // ローカル機能で、Central / Mist の設定には一切書き込まない(data/tagged-targets/tags.json)。
  // 取得は MCP を経由せず Global Overview の CentralClient / MistClient を共有した直接 REST
  // (cache-proxy の 300 秒 TTL を挟まず即時性を優先。57 §2-4 / 58 §4 判断事項 #2)。
  // Global Overview の初期化(getClients のトークン・レート制御)より後に載せる。
  app.use("/api/tagged-targets", taggedTargetsRouter);
  await initTaggedTargets();

  // ---- Coach(65)----
  // 経験の浅いメンバー向けの「壁打ち + クイズ」。教材は自社の記録(承認済みナレッジ・
  // 調査履歴)を最優先し、ベンダーのベストプラクティスは補助として使う。
  // **MCP は繋がない**(現在の状態は語らせず、調査タブへ誘導する。64_findings.md §2-1(b))。
  // 「いつ答えを出すか」はモデルに判断させず、サーバが hintLevel 0→3 の状態機械として持つ。
  // ナレッジの参照回数(refCount)は 47 番で「調査プロンプトに注入された回数」と定義済みなので、
  // Coach は buildInjection() を使わず、Coach 側の利用実績を data/coach/ に別立てで持つ。
  // ナレッジ・ベストプラクティスの読み取りに依存するので、両者の初期化より後に載せる。
  app.use("/api/coach", coachRouter);
  await initCoach();

  // ---- MCP サーバー定義の初期読み込み(07)----
  // 単一ファイル bind mount はコンテナ作成時の inode に固定され、ホスト側が
  // ~/.claude.json を差し替えると古い(しばしば書き込み途中で切れた)内容が見え続ける。
  // マウントがまだ新鮮な起動直後に読んで last-known-good を確保しておく。
  const mcpPrime = await primeMcpServerCache();
  console.log(
    `[network-investigation] MCP サーバー定義: source=${mcpPrime.source} servers=[${mcpPrime.servers.join(", ")}]`,
  );

  // ---- 定期実行(node-cron)----
  // 移植元は launchd + scripts/network-investigation-refresh.ts の別プロセス実行だったが、
  // コンテナ内に launchd が無いため、このプロセス内の cron ジョブとして自己完結させる。
  // 実行対象の runScheduledInvestigation() は移植元から無改変。
  const sync = await initSchedule(runScheduledInvestigation);
  console.log(`[network-investigation] スケジュール: ${sync.detail}`);

  // ---- フロントエンド配信 ----
  if (!isProd) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: ROOT,
      server: { middlewareMode: true },
      appType: "custom",
    });
    app.use(vite.middlewares);
    app.use("*", async (req, res, next) => {
      try {
        const { readFile } = await import("node:fs/promises");
        let template = await readFile(path.resolve(ROOT, "index.html"), "utf-8");
        template = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ "Content-Type": "text/html" }).end(template);
      } catch (err) {
        vite.ssrFixStacktrace(err as Error);
        next(err);
      }
    });
  } else {
    const dist = path.resolve(ROOT, "dist");
    app.use(express.static(dist));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve(dist, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n  ⛁  multi-network-dashboard running at http://0.0.0.0:${PORT}  (${isProd ? "prod" : "dev"})\n`);
  });
}

createServer().catch((err) => {
  console.error("[multi-network-dashboard] 起動に失敗しました:", err);
  process.exit(1);
});
