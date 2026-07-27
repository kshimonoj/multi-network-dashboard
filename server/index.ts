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
