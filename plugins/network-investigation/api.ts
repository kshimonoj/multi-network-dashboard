// Network Investigation — APIルート
//
// CLAUDE.md の原則:
//  - filesystem as database。真実は data/network-investigation/ 配下のファイル
//    (site-platform-map.json = 対応表 / query-history.jsonl = 実行履歴 / site-status.json = 状態キャッシュ)。
//  - jsonl(query-history)は追記専用。キャッシュ(site-status.json)の整合性管理は、
//    書き込みを起こしたハンドラ(refreshSiteStatus)だけの責務。
//  - View はキャッシュ・楽観的更新を持たない。進捗・変更は SSE(pub/sub)で通知し、
//    View は「今表示中のデータ」だけ refetch する。
//
// エンドポイント:
//  - GET  /site-map           … 現在の対応表を返す
//  - POST /site-map/refresh   … 対応表を再生成して上書き
//  - GET  /events             … SSE。MCP 呼び出しの見える化・履歴更新通知をリアルタイム配信
//  - POST /query              … Insight Agent をバックグラウンド起動(即 runId を返し、進捗は SSE)
//  - GET  /history            … 過去クエリ履歴(query-history.jsonl)を新しい順に返す
//  - GET  /history/session/:id… 同一セッション(「続けて調べる」で繋がった一連)を古い順に返す
//  - GET  /site-status        … サイト状態キャッシュ(health 等)を返す
//  - POST /site-status/refresh… サイト状態を再取得して上書き
//  - GET  /schedule           … スケジュール設定(対象クエリ・有効/無効)を返す

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile, appendFile, writeFile, mkdir } from "node:fs/promises";
import { generateSitePlatformMap, readSiteMap, resolvePlatformForSite } from "./site-map.js";
import { runInsightAgent, type McpCallEvent, type PlatformJudgmentEvent, type SuggestedAction } from "./insight-agent.js";
import {
  ALL_PLATFORMS,
  PLATFORM_TO_MCP_SERVER,
  evaluateMcpHealth,
  runClaudeWithMcp,
  type McpHealth,
  type Platform,
} from "./mcp.js";
import {
  readScheduledQueries,
  writeScheduledQueries,
  readScheduleConfig,
  writeScheduleConfig,
  normalizeScheduleConfig,
  applySchedule,
  type ScheduledQuery,
} from "./schedule.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本アプリ独自の data/ ディレクトリ(Corstack のリポジトリ配下ではない)。
// __dirname = <app>/plugins/network-investigation → <app>/data/network-investigation。
// Docker では <app>/data をホストの ./data にバインドマウントして永続化する。
// site-map.ts にも同じ定数がある(移植時に書き換えた 2 箇所のうちの 1 つ)。
const DATA_DIR =
  process.env.NETINV_DATA_DIR || path.resolve(__dirname, "../../data/network-investigation");
const HISTORY_PATH = path.join(DATA_DIR, "query-history.jsonl");
const STATUS_PATH = path.join(DATA_DIR, "site-status.json");

export const router = Router();

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

// ---- SSE(pub/sub)。MCP 呼び出しの見える化はこのチャネルで流す ----

const sseClients = new Set<Response>();

// SSE で流すイベントの型(View 側 types.ts と一致させる)。
type NIEvent =
  | { type: "run_start"; runId: string; sessionId: string; query: string; site: string | null; ts: string }
  | {
      type: "routing_decision";
      runId: string;
      used: string[]; // 使う MCP サーバー名
      skipped: string[]; // スキップした MCP サーバー名
      reason: string;
      resolvedPlatform: Platform | null;
    }
  | ({ type: "mcp_call"; runId: string } & McpCallEvent)
  | ({ type: "platform_judgment"; runId: string } & PlatformJudgmentEvent)
  | {
      type: "answer";
      runId: string;
      answer: string;
      suggestedActions: SuggestedAction[];
      isError: boolean;
      reason: string | null;
      resolvedPlatform: Platform | null;
      platformsUsed: Platform[];
      mcpServers: string[];
      /** MCP サーバーの接続健全性(09)。level!=="ok" なら警告表示にする。 */
      mcpHealth: McpHealth | null;
    }
  | { type: "history"; runId: string; sessionId: string }; // 履歴が1件増えた(タイムラインを refetch させる)

function broadcast(event: NIEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

router.get("/events", (req: Request, res: Response) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  res.write(": connected\n\n");
  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });
});

// ---- 対応表(site-platform-map.json) ----

router.get("/site-map", async (_req, res) => {
  try {
    const entries = await readSiteMap();
    res.json({ entries });
  } catch (err) {
    console.error("[network-investigation] GET /site-map 失敗:", err);
    res.status(500).json({ error: "failed to read site map" });
  }
});

router.post("/site-map/refresh", async (_req, res) => {
  try {
    const result = await generateSitePlatformMap();
    res.json(result);
  } catch (err) {
    console.error("[network-investigation] POST /site-map/refresh 失敗:", err);
    res.status(500).json({ error: "failed to generate site map", detail: err instanceof Error ? err.message : String(err) });
  }
});

// ---- ルーティング判定(= ルーティングスキップの見える化の材料) ----

interface RoutingDecision {
  resolvedPlatform: Platform | null;
  used: string[];
  skipped: string[];
  reason: string;
}

const ALL_SERVERS = ALL_PLATFORMS.map((p) => PLATFORM_TO_MCP_SERVER[p]);
const platformLabel = (p: Platform) => (p === "central" ? "Central" : "Mist");

// サイト指定から「どの MCP を使い、どちらをスキップするか」を判定する。
// resolvePlatformForSite と同じ対応表を引く(判定材料を SSE の routing_decision で先に見せるため、
// runInsightAgent 実行前にここで1度引く。小さな JSON の二重読みだが害はない)。
async function computeRouting(site?: string): Promise<RoutingDecision> {
  const s = (site || "").trim();
  if (!s) {
    return {
      resolvedPlatform: null,
      used: [...ALL_SERVERS],
      skipped: [],
      reason: "サイト指定なし — Central / Mist 両方に問い合わせます",
    };
  }
  const hit = await resolvePlatformForSite(s);
  if (!hit) {
    return {
      resolvedPlatform: null,
      used: [...ALL_SERVERS],
      skipped: [],
      reason: `サイト「${s}」が対応表に見つからないため、両プラットフォームに問い合わせます`,
    };
  }
  const usedP = hit.platform;
  const otherP: Platform = usedP === "central" ? "mist" : "central";
  const usedServer = PLATFORM_TO_MCP_SERVER[usedP];
  const skippedServer = PLATFORM_TO_MCP_SERVER[otherP];
  return {
    resolvedPlatform: usedP,
    used: [usedServer],
    skipped: [skippedServer],
    reason: `${hit.entry.siteName} は ${platformLabel(usedP)} 管理のため、${skippedServer} への問い合わせをスキップしました`,
  };
}

// ---- クエリ履歴(query-history.jsonl・追記専用) ----

// タイムラインのクリックで開く詳細ビュー(Task 4)のために、1件呼び出したツールの最終状態を残す。
export interface HistoryToolCall {
  server: string;
  platform: Platform | null;
  tool: string;
  status: "calling" | "done" | "error";
  detail?: string;
  count?: number | null;
  // 失敗時の詳細(08 Task 1)。履歴からも失敗理由を辿れるように残す。古い履歴には無い。
  error?: string;
  errorStatus?: number | null;
  input?: string;
}

export interface QueryHistoryRecord {
  id: string;
  // 「続けて調べる」で繋がった一連の実行をまとめるID(04 Task 2)。
  // 初回クエリで View が採番し、追い質問では同じ値を送る。未指定ならサーバーが採番する。
  // 旧履歴(セッション化以前)には無いので、読み込み側は sessionKey() で id にフォールバックする。
  sessionId?: string;
  ts: string;
  query: string;
  site: string | null;
  resolvedPlatform: Platform | null;
  platformsUsed: Platform[];
  mcpServers: string[];
  // manual    … 画面から人が実行した
  // scheduled … 定期実行(schedule.ts)
  // auto      … Webhook ログの重大アラートに対する自動事前調査(17 Task 4)。
  //             ユーザー操作なしで走るので、タイムライン上で区別できるようにする。
  source: "manual" | "scheduled" | "auto";
  answerExcerpt: string;
  isError: boolean;
  reason?: string;
  model?: string; // この実行に使ったモデル(旧履歴には無い。未指定なら CORSTACK_NETINV_MODEL → "sonnet")
  // ---- 詳細ビュー用(Task 4)。古い履歴には無いので View 側はオプショナル扱いにする ----
  answer?: string; // 回答全文(suggested-actions ブロック除去済み)
  calls?: HistoryToolCall[]; // 呼び出したツール一覧(最終状態)
  judgments?: PlatformJudgmentEvent[]; // モデル判断によるプラットフォーム省略
  suggestedActions?: SuggestedAction[]; // クリック可能な追い質問(Task 1)
  // MCP サーバーの接続健全性(09)。古い履歴には無い。level!=="ok" のターンには警告を出す。
  mcpHealth?: McpHealth;
}

async function readHistory(): Promise<QueryHistoryRecord[]> {
  let raw: string;
  try {
    raw = await readFile(HISTORY_PATH, "utf-8");
  } catch {
    return [];
  }
  const records: QueryHistoryRecord[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const p = JSON.parse(s);
      if (p && typeof p.id === "string") records.push(p as QueryHistoryRecord);
    } catch {
      /* 壊れた行は無視 */
    }
  }
  return records;
}

async function appendHistory(rec: QueryHistoryRecord): Promise<void> {
  await ensureDataDir();
  await appendFile(HISTORY_PATH, JSON.stringify(rec) + "\n", "utf-8");
}

// セッションの正規化キー(後方互換の唯一の分岐点)。
// sessionId を持たない旧履歴は「自分1件だけのセッション」として扱う。
// View 側(view/session.ts の sessionKey)と同じ規則にする。
export function sessionKey(rec: QueryHistoryRecord): string {
  return rec.sessionId && rec.sessionId.trim() ? rec.sessionId : rec.id;
}

// View から渡る sessionId の検証。jsonl へ書き、URL パスにも載るので文字種を絞る
// (randomUUID() が通る範囲)。不正な値は「未指定」と同じ扱いにして採番し直す。
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
function normalizeSessionId(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return SESSION_ID_RE.test(s) ? s : undefined;
}

// 新しい順(タイムライン表示用)。
router.get("/history", async (_req, res) => {
  try {
    const records = await readHistory();
    records.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    res.json({ history: records });
  } catch (err) {
    console.error("[network-investigation] GET /history 失敗:", err);
    res.status(500).json({ error: "failed to read history" });
  }
});

// 1セッション(= 「続けて調べる」で繋がった一連の実行)を古い順に返す(04 Task 2)。
// :sessionId には sessionKey() の値(新: sessionId / 旧: レコードの id)を渡す。
router.get("/history/session/:sessionId", async (req, res) => {
  try {
    const key = req.params.sessionId;
    const records = (await readHistory()).filter((r) => sessionKey(r) === key);
    records.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    if (records.length === 0) {
      res.status(404).json({ error: "session not found", sessionId: key });
      return;
    }
    res.json({ sessionId: key, records });
  } catch (err) {
    console.error("[network-investigation] GET /history/session 失敗:", err);
    res.status(500).json({ error: "failed to read session" });
  }
});

// ---- Insight Agent の実行(対話・スケジューラ共通) ----

// UI / scheduled-queries.json から来たモデル指定を検証する。エイリアス(opus/sonnet/haiku)や
// フルのモデルID を許可し、想定外の文字を含む値は無視する(--model には spawn の引数配列で渡す)。
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/;
export function normalizeModel(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s) return undefined;
  return MODEL_RE.test(s) ? s : undefined;
}

// 1クエリを実行し、進捗を SSE で流し、完了後に履歴へ追記する。
// 対話(POST /query)とスケジューラ(runScheduledInvestigation)の両方から呼ぶ。
async function runQuery(
  runId: string,
  sessionId: string,
  query: string,
  site: string | null,
  source: "manual" | "scheduled" | "auto",
  model?: string,
): Promise<{ result: Awaited<ReturnType<typeof runInsightAgent>>; record: QueryHistoryRecord }> {
  const ts = new Date().toISOString();
  broadcast({ type: "run_start", runId, sessionId, query, site, ts });

  // ルーティングスキップを最初のイベントとして流す(サイト指定あり/なしで内容が変わる)。
  const routing = await computeRouting(site ?? undefined);
  broadcast({
    type: "routing_decision",
    runId,
    used: routing.used,
    skipped: routing.skipped,
    reason: routing.reason,
    resolvedPlatform: routing.resolvedPlatform,
  });

  // MCP 呼び出しをリアルタイムに配信しつつ、履歴詳細(Task 4)用に呼び出し・判断を蓄積する。
  const callsById = new Map<string, HistoryToolCall>();
  const judgments: PlatformJudgmentEvent[] = [];
  const result = await runInsightAgent(query, site ?? undefined, {
    model,
    onMcpCall: (e: McpCallEvent) => {
      // 同じ id は calling → done/error と上書きし、最終状態だけを詳細に残す。
      callsById.set(e.id, {
        server: e.server,
        platform: e.platform,
        tool: e.tool,
        status: e.status,
        detail: e.detail,
        count: e.count,
        // 失敗時の詳細(08 Task 1)。calling → error と上書きされるので最終状態だけが残る。
        error: e.error,
        errorStatus: e.errorStatus,
        input: e.input,
      });
      broadcast({ type: "mcp_call", runId, ...e });
    },
    onPlatformJudgment: (e: PlatformJudgmentEvent) => {
      judgments.push(e);
      broadcast({ type: "platform_judgment", runId, ...e });
    },
  });

  broadcast({
    type: "answer",
    runId,
    answer: result.answer,
    suggestedActions: result.suggestedActions,
    isError: result.isError,
    reason: result.reason ?? null,
    resolvedPlatform: result.resolvedPlatform,
    platformsUsed: result.platformsUsed,
    mcpServers: result.mcpServers,
    mcpHealth: result.mcpHealth ?? null,
  });

  const record: QueryHistoryRecord = {
    id: runId,
    sessionId,
    ts,
    query,
    site,
    resolvedPlatform: result.resolvedPlatform,
    platformsUsed: result.platformsUsed,
    mcpServers: result.mcpServers,
    source,
    answerExcerpt: (result.answer || "").replace(/\s+/g, " ").trim().slice(0, 200),
    isError: result.isError,
    reason: result.reason,
    ...(model ? { model } : {}),
    answer: result.answer || "",
    calls: [...callsById.values()],
    judgments,
    suggestedActions: result.suggestedActions,
    // 警告のあった実行だけ残す(ok のときに全履歴を膨らませない)。
    ...(result.mcpHealth && result.mcpHealth.level !== "ok" ? { mcpHealth: result.mcpHealth } : {}),
  };
  await appendHistory(record);
  broadcast({ type: "history", runId, sessionId });

  return { result, record };
}

/**
 * Webhook ログの重大アラートに対する自動事前調査(17 Task 4)。
 *
 * 対話・定期実行と同じ runQuery を通すので、SSE の見える化も query-history.jsonl への
 * 追記も同じように行われる。違いは source="auto" だけで、タイムラインでは
 * 「自動調査」タグが付いて手動実行と区別できる。
 *
 * 呼び出し側(plugins/webhook-feed/enrich.ts)が「同一アラートには 1 回だけ」「1 巡あたり N 件まで」
 * を担保しているので、ここでは重複制御は行わない。
 */
export async function runAutoInvestigation(
  query: string,
  site: string | null,
): Promise<{ result: Awaited<ReturnType<typeof runInsightAgent>>; record: QueryHistoryRecord }> {
  // 自動実行は派生関係を持たないので 1 実行 = 1 セッション(定期実行と同じ扱い)。
  // 画面から「続けて調べる」で追い質問すると、そのセッションに繋がる。
  return runQuery(randomUUID(), randomUUID(), query.trim(), site, "auto");
}

// 対話エンドポイント。即 runId を返し、進捗・結果は SSE(/events)で配信する。
router.post("/query", async (req, res) => {
  try {
    const body = req.body ?? {};
    const query = typeof body.query === "string" ? body.query : "";
    const site = typeof body.site === "string" && body.site.trim() ? body.site.trim() : null;
    const model = normalizeModel(body.model);
    if (!query.trim()) {
      res.status(400).json({ error: "query is required" });
      return;
    }
    const runId = randomUUID();
    // 「続けて調べる」なら View が前回と同じ sessionId を送ってくる。初回・不正値なら新規採番。
    const sessionId = normalizeSessionId(body.sessionId) ?? randomUUID();
    res.status(202).json({ runId, sessionId });
    // バックグラウンド実行(SSE で進捗が流れる)。失敗しても answer(isError)で通知済み。
    void runQuery(runId, sessionId, query.trim(), site, "manual", model).catch((err) => {
      console.error("[network-investigation] runQuery 失敗:", err);
    });
  } catch (err) {
    console.error("[network-investigation] POST /query 失敗:", err);
    res.status(500).json({ error: "insight agent failed", detail: err instanceof Error ? err.message : String(err) });
  }
});

// ---- MCP サーバーの接続確認(09)----
// クエリを走らせずに central-mcp / mist-cloud の生死だけを見たいときの口。
// callCounts を空にして evaluateMcpHealth を呼ぶ = 両サーバーとも必ず直接 probe される。
// (画面の警告は実行結果に付くが、こちらは運用時の単独確認・切り分け用。)
router.get("/mcp-health", async (_req, res) => {
  try {
    const health = await evaluateMcpHealth({
      serverNames: ALL_SERVERS,
      callCounts: {},
      events: [],
    });
    res.json(health);
  } catch (err) {
    console.error("[network-investigation] GET /mcp-health 失敗:", err);
    res.status(500).json({ error: "failed to check mcp health", detail: err instanceof Error ? err.message : String(err) });
  }
});

// ---- サイト状態キャッシュ(site-status.json) ----
// 地図ピンのクリック時に platform と一緒に見せる「簡易ステータス(health 等)」。
// 真実は Central / Mist 側。ここはその導出キャッシュ(再生成可能)。整合性は refresh 側の責務。

interface SiteStatusEntry {
  siteId: string;
  platform: Platform;
  health: number | null;
  devices: number | null;
  clients: number | null;
  alerts: number | null;
}
interface SiteStatusFile {
  statuses: Record<string, SiteStatusEntry>; // key = siteId
  updatedAt: string | null;
}

async function readSiteStatus(): Promise<SiteStatusFile> {
  try {
    const raw = await readFile(STATUS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.statuses) return parsed as SiteStatusFile;
  } catch {
    /* 未生成 */
  }
  return { statuses: {}, updatedAt: null };
}

const STATUS_JSON_TAIL =
  "出力は JSON 配列のみ。前置き・後置き・コードフェンス(```)・説明文を一切付けない。" +
  "各要素は {\"siteId\": string, \"health\": number|null, \"devices\": number|null, \"clients\": number|null, \"alerts\": number|null}。" +
  "取得できない値は null にする。";

const CENTRAL_STATUS_PROMPT =
  "あなたは HPE Aruba Networking Central の MCP ツールを使える。\n" +
  "central_get_summary を1回呼び、各サイトについて site_id・health・total_devices・total_clients・total_alerts を得る。\n" +
  "siteId=site_id、health=health、devices=total_devices、clients=total_clients、alerts=total_alerts。\n" +
  STATUS_JSON_TAIL;

const MIST_STATUS_PROMPT =
  "あなたは Juniper Mist の MCP ツールを使える。\n" +
  "1. get_mist_self で org_id を得る。\n" +
  "2. get_mist_stats(resource_type='sites', org_id=...) で各サイトの統計(num_devices / num_clients 等)を得る。\n" +
  "siteId=各サイトの id、devices=num_devices(無ければ null)、clients=num_clients(無ければ null)、health/alerts は取得できなければ null。\n" +
  STATUS_JSON_TAIL;

function toNumOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseStatusArray(text: string): Array<Record<string, unknown>> {
  const t = (text || "").trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

// サイト状態を Central / Mist からそれぞれ専用 narrowing で取得し、siteId キーのキャッシュへ上書きする。
// 片方が失敗しても他方は残す(全体を倒さない)。
export async function refreshSiteStatus(): Promise<SiteStatusFile> {
  const statuses: Record<string, SiteStatusEntry> = {};

  const fetchOne = async (platform: Platform, prompt: string) => {
    try {
      const res = await runClaudeWithMcp({ prompt, platforms: [platform] });
      if (res.isError) return;
      for (const r of parseStatusArray(res.text)) {
        const siteId = r.siteId == null ? "" : String(r.siteId);
        if (!siteId) continue;
        statuses[siteId] = {
          siteId,
          platform,
          health: toNumOrNull(r.health),
          devices: toNumOrNull(r.devices),
          clients: toNumOrNull(r.clients),
          alerts: toNumOrNull(r.alerts),
        };
      }
    } catch (err) {
      console.warn(`[network-investigation] refreshSiteStatus(${platform}) 失敗:`, err);
    }
  };

  await Promise.all([
    fetchOne("central", CENTRAL_STATUS_PROMPT),
    fetchOne("mist", MIST_STATUS_PROMPT),
  ]);

  const file: SiteStatusFile = { statuses, updatedAt: new Date().toISOString() };
  // 少なくとも1件取れたときだけ上書き(全滅時は既存キャッシュを壊さない)。
  if (Object.keys(statuses).length > 0) {
    await ensureDataDir();
    await writeFile(STATUS_PATH, JSON.stringify(file, null, 2) + "\n", "utf-8");
  }
  return file;
}

router.get("/site-status", async (_req, res) => {
  try {
    res.json(await readSiteStatus());
  } catch (err) {
    console.error("[network-investigation] GET /site-status 失敗:", err);
    res.status(500).json({ error: "failed to read site status" });
  }
});

router.post("/site-status/refresh", async (_req, res) => {
  try {
    res.json(await refreshSiteStatus());
  } catch (err) {
    console.error("[network-investigation] POST /site-status/refresh 失敗:", err);
    res.status(500).json({ error: "failed to refresh site status", detail: err instanceof Error ? err.message : String(err) });
  }
});

// ---- スケジュール設定(Task 5) ----
// 真実は2ファイル: scheduled-queries.json(何を) / schedule-config.json(いつ)。
// 詳細な読み書き・plist 再生成は schedule.ts に閉じている。ここは HTTP 境界だけ。

// 定期実行するクエリの一覧(CRUD)。
router.get("/scheduled-queries", async (_req, res) => {
  try {
    res.json({ queries: await readScheduledQueries() });
  } catch (err) {
    console.error("[network-investigation] GET /scheduled-queries 失敗:", err);
    res.status(500).json({ error: "failed to read scheduled queries" });
  }
});

router.post("/scheduled-queries", async (req, res) => {
  try {
    const body = req.body ?? {};
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      res.status(400).json({ error: "query is required" });
      return;
    }
    const site = typeof body.site === "string" && body.site.trim() ? body.site.trim() : null;
    const enabled = body.enabled !== false;
    const model = normalizeModel(body.model) ?? null;
    const item: ScheduledQuery = { id: randomUUID(), query, site, enabled, model };
    const queries = await readScheduledQueries();
    queries.push(item);
    await writeScheduledQueries(queries);
    res.status(201).json({ queries, created: item });
  } catch (err) {
    console.error("[network-investigation] POST /scheduled-queries 失敗:", err);
    res.status(500).json({ error: "failed to add scheduled query" });
  }
});

router.put("/scheduled-queries/:id", async (req, res) => {
  try {
    const queries = await readScheduledQueries();
    const idx = queries.findIndex((q) => q.id === req.params.id);
    if (idx < 0) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const body = req.body ?? {};
    const cur = queries[idx];
    if (typeof body.query === "string" && body.query.trim()) cur.query = body.query.trim();
    if ("site" in body) cur.site = typeof body.site === "string" && body.site.trim() ? body.site.trim() : null;
    if ("enabled" in body) cur.enabled = body.enabled !== false;
    if ("model" in body) cur.model = normalizeModel(body.model) ?? null;
    await writeScheduledQueries(queries);
    res.json({ queries, updated: cur });
  } catch (err) {
    console.error("[network-investigation] PUT /scheduled-queries 失敗:", err);
    res.status(500).json({ error: "failed to update scheduled query" });
  }
});

router.delete("/scheduled-queries/:id", async (req, res) => {
  try {
    const queries = await readScheduledQueries();
    const next = queries.filter((q) => q.id !== req.params.id);
    if (next.length === queries.length) {
      res.status(404).json({ error: "not found" });
      return;
    }
    await writeScheduledQueries(next);
    res.json({ queries: next });
  } catch (err) {
    console.error("[network-investigation] DELETE /scheduled-queries 失敗:", err);
    res.status(500).json({ error: "failed to delete scheduled query" });
  }
});

// 実行時刻・頻度(schedule-config.json)。PUT は node-cron のジョブを張り直す
// (移植元では launchd plist の再生成 + unload→load だった箇所)。
router.get("/schedule-config", async (_req, res) => {
  try {
    res.json(await readScheduleConfig());
  } catch (err) {
    console.error("[network-investigation] GET /schedule-config 失敗:", err);
    res.status(500).json({ error: "failed to read schedule config" });
  }
});

router.put("/schedule-config", async (req, res) => {
  try {
    const cfg = normalizeScheduleConfig(req.body ?? {});
    await writeScheduleConfig(cfg);
    // 時刻・頻度・有効状態の変更を node-cron に反映する(既存ジョブを止めて張り直す)。
    // レスポンスのキー名 `launchd` は View(ScheduleEditor)の型と合わせるためそのまま。
    // 中身は ScheduleSyncResult(cron 式・登録可否・説明文)。
    let launchd;
    try {
      launchd = applySchedule(cfg);
    } catch (err) {
      launchd = {
        ok: false,
        expression: null,
        loaded: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    res.json({ config: cfg, launchd });
  } catch (err) {
    console.error("[network-investigation] PUT /schedule-config 失敗:", err);
    res.status(500).json({ error: "failed to update schedule config" });
  }
});

// launchd(scripts/network-investigation-refresh.ts)から呼ばれる共通ランナー。
// scheduled-queries.json の enabled:true を逐次実行し、それぞれ query-history.jsonl へ追記する。
// 最後にサイト状態キャッシュも更新する(地図ピンの health 表示を新鮮に保つ)。
export async function runScheduledInvestigation(): Promise<{
  ok: boolean;
  processed: number;
  results: Array<{ query: string; site: string | null; isError: boolean; reason?: string }>;
  skipped?: string;
}> {
  const cfg = await readScheduleConfig();
  if (!cfg.enabled) {
    return { ok: true, processed: 0, results: [], skipped: "schedule disabled" };
  }
  const queries = (await readScheduledQueries()).filter((q) => q.enabled && q.query.trim());
  const results: Array<{ query: string; site: string | null; isError: boolean; reason?: string }> = [];
  for (const q of queries) {
    const site = q.site && q.site.trim() ? q.site.trim() : null;
    try {
      // 定期実行は派生関係を持たないので 1 実行 = 1 セッション(毎回採番)。
      const { result } = await runQuery(
        randomUUID(),
        randomUUID(),
        q.query.trim(),
        site,
        "scheduled",
        normalizeModel(q.model),
      );
      results.push({ query: q.query, site, isError: result.isError, reason: result.reason });
    } catch (err) {
      results.push({ query: q.query, site, isError: true, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  // ベストエフォートでサイト状態も更新(失敗しても定期実行全体は成功扱い)。
  await refreshSiteStatus().catch(() => {});
  return { ok: results.every((r) => !r.isError), processed: results.length, results };
}

// ---- 共通検索(query-history.jsonl を検索対象に含める) ----

export interface SearchItem {
  id: string;
  pluginId: string;
  title: string;
  excerpt: string;
  url: string;
}

export async function searchIndex(): Promise<SearchItem[]> {
  const records = await readHistory();
  return records.map((r) => {
    const plat = r.resolvedPlatform ?? "both";
    return {
      id: r.id,
      pluginId: "network-investigation",
      title: r.query,
      excerpt: `[${plat}${r.site ? " / " + r.site : ""}] ${r.answerExcerpt}`,
      url: `/p/network-investigation?focus=${r.id}`,
    };
  });
}

// ---- Home 概要(GET /api/home/summary へ申告) ----
// 対応表に載っているサイト数を出す。lastUpdatedAt はファイルシステムが真実なので保持しない(null)。
export async function getSummary(): Promise<{
  label: string;
  count: number;
  countLabel: string;
  lastUpdatedAt: string | null;
}> {
  const entries = await readSiteMap();
  const central = entries.filter((e) => e.platform === "central").length;
  const mist = entries.filter((e) => e.platform === "mist").length;
  return {
    label: "ネットワーク調査",
    count: entries.length,
    countLabel: `サイト(Central ${central} / Mist ${mist})`,
    lastUpdatedAt: null,
  };
}
