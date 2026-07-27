// Network Investigation — MCP プラミング(共通)
//
// CLAUDE.md / PRECONDITIONS の原則:
//  - Corstack は central-mcp / mist-cloud に「接続するだけ」。常駐化・キャッシュは別プロジェクト
//    (~/claude/central-mcp-http/)で完了済み。ここではそれらへ問い合わせる術だけを持つ。
//  - 問い合わせは Anthropic API 直叩きではなく、既存プラグイン(Discussion Panel)と同じ
//    `claude` CLI subprocess 方式を踏襲する。
//  - 「ルーティングスキップ」= サイト→プラットフォーム対応表で判明したプラットフォームだけを
//    `--mcp-config` に含めることで、無関係なプラットフォーム(例: Central 専用サイトに対する
//    Mist 呼び出し)を発生させない。narrowing の実体はこのファイルの writeNarrowedMcpConfig()。
//
// MCP サーバー定義(central-mcp / mist-cloud)は、リポジトリに複製せず
// ユーザーのグローバル ~/.claude.json から読む(Mist の Bearer トークン等の秘匿情報を
// git 管理下に持ち込まないため。CLAUDE.md「情報漏洩には気を付ける」)。

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { probeMcpServerDef, type McpProbeResult, type McpServerDef } from "./mcp-health.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- プラットフォーム ⇄ MCP サーバー名の対応 ----
// 対象は Central / Mist のみ(CLAB は対象外。PRECONDITIONS)。
export type Platform = "central" | "mist";

export const PLATFORM_TO_MCP_SERVER: Record<Platform, string> = {
  central: "central-mcp",
  mist: "mist-cloud",
};

export const ALL_PLATFORMS: Platform[] = ["central", "mist"];

// MCP サーバー名 → platform の逆引き。
export const MCP_SERVER_TO_PLATFORM: Record<string, Platform> = {
  "central-mcp": "central",
  "mist-cloud": "mist",
};

/**
 * MCP ツール名(例 "mcp__central-mcp__central_get_summary")を
 * { platform, server, tool } に分解する。MCP ツールでなければ null。
 * SSE の見える化(どの MCP サーバーのどのツールを呼んだか)に使う。
 */
export function parseMcpToolName(
  name: string,
): { platform: Platform | null; server: string; tool: string } | null {
  if (typeof name !== "string" || !name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  const server = parts[1];
  const tool = parts.slice(2).join("__");
  return { platform: MCP_SERVER_TO_PLATFORM[server] ?? null, server, tool };
}

// ---- ストリーミング(stream-json)で拾う MCP ツールイベント ----
// claude を --output-format stream-json --verbose で起動すると、NDJSON で
// assistant(tool_use を含む)/ user(tool_result を含む)/ result などが1行ずつ流れる。
// このうち MCP ツールの呼び出し/完了だけを抜き出したものが McpStreamEvent。
export interface McpToolUseEvent {
  kind: "tool_use";
  id: string; // tool_use の id(tool_result の tool_use_id と対応する)
  name: string; // 完全なツール名(mcp__server__tool)
  input: unknown; // ツール入力(引数)
}
export interface McpToolResultEvent {
  kind: "tool_result";
  toolUseId: string; // 対応する tool_use の id
  isError: boolean;
  text: string; // 結果本文(件数推定・表示用に平坦化した文字列)
}
// assistant が地の文で出力したテキスト(tool_use ではない text ブロック)。
// 「モデル判断でどちらかのプラットフォームを省略した」宣言(`[判断] …`)を拾うために使う。
export interface McpAssistantTextEvent {
  kind: "assistant_text";
  text: string;
}
export type McpStreamEvent = McpToolUseEvent | McpToolResultEvent | McpAssistantTextEvent;

// tool_result の content(配列 or 文字列)を1本の文字列へ平坦化する。
function flattenToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && typeof (c as any).text === "string") return (c as any).text;
        return "";
      })
      .join("");
  }
  return "";
}

// 1件の NDJSON イベントから MCP の tool_use / tool_result を取り出して onEvent に流す。
// stream-json の形: assistant イベントは message.content[] に {type:"tool_use", id, name, input}、
// tool_result は user イベントの message.content[] に {type:"tool_result", tool_use_id, content, is_error}。
function emitMcpEvents(ev: any, onEvent: (e: McpStreamEvent) => void): void {
  if (!ev || typeof ev !== "object") return;
  const content = ev.message?.content;
  if (!Array.isArray(content)) return;
  if (ev.type === "assistant") {
    for (const c of content) {
      if (c && c.type === "tool_use" && typeof c.name === "string" && typeof c.id === "string") {
        onEvent({ kind: "tool_use", id: c.id, name: c.name, input: c.input });
      } else if (c && c.type === "text" && typeof c.text === "string") {
        onEvent({ kind: "assistant_text", text: c.text });
      }
    }
  } else if (ev.type === "user") {
    for (const c of content) {
      if (c && c.type === "tool_result" && typeof c.tool_use_id === "string") {
        onEvent({
          kind: "tool_result",
          toolUseId: c.tool_use_id,
          isError: c.is_error === true,
          text: flattenToolResultContent(c.content),
        });
      }
    }
  }
}

// claude CLI を走らせる中立な作業ディレクトリ。リポジトリの CLAUDE.md 等の
// コンテキストを拾わせない(Discussion Panel の PANEL_CWD と同じ考え方)。
const AGENT_CWD = path.join(os.tmpdir(), "multi-network-dashboard-agent");

// narrowing 用に書き出す一時 mcp-config の置き場。
// この config には Mist の Bearer トークン等の秘匿情報が含まれるため、世界読み取り可能な
// 共有 /tmp ではなく、ユーザー専用の ~/.cache 配下(dir 0700 / file 0600)に置き、
// 使用後は必ず unlink する(トークン材料をディスクに残さない。CLAUDE.md「情報漏洩に気を付ける」)。
const MCP_CONFIG_DIR = path.join(os.homedir(), ".cache", "multi-network-dashboard-mcp");

// MCP サーバー定義の供給元。Docker ではホストの ~/.claude.json を read-only で
// /host/claude.json にマウントし、NETINV_CLAUDE_JSON でその位置を指す。
// 未設定ならホスト実行時と同じ ~/.claude.json を読む。
const GLOBAL_CLAUDE_JSON =
  process.env.NETINV_CLAUDE_JSON || path.join(os.homedir(), ".claude.json");

// ホストの ~/.claude.json では central-mcp の url が http://127.0.0.1:8011/mcp(TTL キャッシュ
// プロキシ)になっている。コンテナ内の 127.0.0.1 はコンテナ自身を指すため、そのままでは接続に
// 失敗する(01 スパイクの D-1)。CENTRAL_MCP_HOST が設定されているときだけ、ループバック宛の
// ホスト名をそこへ差し替える。ホスト直実行時は未設定 → 書き換えなし。
const LOOPBACK_REWRITE_HOST = process.env.CENTRAL_MCP_HOST || "";
const LOOPBACK_RE = /\b(?:127\.0\.0\.1|localhost)\b/g;

function rewriteLoopback(s: string): string {
  return LOOPBACK_REWRITE_HOST ? s.replace(LOOPBACK_RE, LOOPBACK_REWRITE_HOST) : s;
}

// MCP サーバー定義 1 件のうち、接続先を表す文字列(url / args)のループバックだけを書き換える。
// headers / env(トークン類)には触らない。
function rewriteServerDefHost(def: McpServerDef): McpServerDef {
  if (!LOOPBACK_REWRITE_HOST) return def;
  const next: McpServerDef = { ...def };
  if (typeof next.url === "string") next.url = rewriteLoopback(next.url);
  if (Array.isArray(next.args)) next.args = next.args.map((a) => (typeof a === "string" ? rewriteLoopback(a) : a));
  return next;
}

// ---- グローバル ~/.claude.json から MCP サーバー定義を読む ----
// McpServerDef の実体は mcp-health.ts(probe 側と共有する型)。

// ---- 供給元ファイルが壊れて読めないときの last-known-good フォールバック ----
//
// 背景(07 の実際の原因): docker-compose は ${HOME}/.claude.json を「単一ファイル」で
// bind mount している。単一ファイルのマウントはコンテナ作成時の inode に固定されるため、
// ホスト側の claude CLI が ~/.claude.json を書き換える(temp 書き出し → rename で差し替え)と、
// コンテナからは「差し替え前の、しかも書き込み途中で切れたスナップショット」が見え続ける。
// 実測: ホスト 137,279 文字 / 3,712 行に対し、コンテナ内は 136,654 文字 / 3,689 行で
// link count 0(= ホストで unlink 済みの inode)。この状態は再作成するまで直らないため、
// JSON.parse は毎回同じ位置で "Unterminated string in JSON at position 136653" を投げていた。
//
// 対策: 読めた定義をメモリ + (Docker 実行時のみ)ディスクに last-known-good として保持し、
// 供給元が壊れている間はそれで走り続ける。マウントが新鮮なコンテナ起動直後に
// primeMcpServerCache() で必ず1回読んでおくことで、良好なコピーを確実に確保する。
const LKG_PATH = path.join(MCP_CONFIG_DIR, "mcp-servers-last-known-good.json");

// ホスト直実行時(NETINV_CLAUDE_JSON 未設定)は供給元が常に新鮮なのでディスクに残さない。
// トークン材料を不必要にディスクへ書かない(CLAUDE.md「情報漏洩には気を付ける」)。
const PERSIST_LKG = Boolean(process.env.NETINV_CLAUDE_JSON);

// 書き込み途中を掴んだだけの一過性の破損に備えた軽いリトライ。
const READ_RETRIES = 2;
const READ_RETRY_DELAY_MS = 150;

let lastKnownGood: Record<string, McpServerDef> | null = null;
let lastSource: "live" | "fallback" | "unavailable" = "unavailable";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 本アプリが使う 2 サーバー(central-mcp / mist-cloud)だけを取り出す。
// 他サーバーの定義(= 無関係なトークン)をキャッシュへ持ち込まないためでもある。
function pickOurServers(all: Record<string, McpServerDef>): Record<string, McpServerDef> {
  const out: Record<string, McpServerDef> = {};
  for (const p of ALL_PLATFORMS) {
    const name = PLATFORM_TO_MCP_SERVER[p];
    if (all[name]) out[name] = all[name];
  }
  return out;
}

async function loadLkgFromDisk(): Promise<Record<string, McpServerDef> | null> {
  if (!PERSIST_LKG) return null;
  try {
    const parsed = JSON.parse(await readFile(LKG_PATH, "utf-8")) as Record<string, McpServerDef>;
    const servers = pickOurServers(parsed ?? {});
    return Object.keys(servers).length > 0 ? servers : null;
  } catch {
    return null;
  }
}

async function saveLkgToDisk(servers: Record<string, McpServerDef>): Promise<void> {
  if (!PERSIST_LKG) return;
  try {
    await mkdir(MCP_CONFIG_DIR, { recursive: true, mode: 0o700 });
    await writeFile(LKG_PATH, JSON.stringify(servers, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch {
    /* 保存できなくてもメモリ上のキャッシュで走る */
  }
}

async function readGlobalMcpServers(): Promise<Record<string, McpServerDef>> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= READ_RETRIES; attempt++) {
    try {
      const raw = await readFile(GLOBAL_CLAUDE_JSON, "utf-8");
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerDef> };
      const servers = pickOurServers(parsed.mcpServers ?? {});
      if (Object.keys(servers).length > 0) {
        lastKnownGood = servers;
        lastSource = "live";
        void saveLkgToDisk(servers);
        return servers;
      }
      // パースは通ったが central-mcp / mist-cloud が1つも無い = 供給元として使えない。
      // リトライしても変わらないので、そのままフォールバックへ落とす。
      lastErr = new Error(`${GLOBAL_CLAUDE_JSON} に central-mcp / mist-cloud の定義がありません`);
      break;
    } catch (err) {
      lastErr = err;
    }
    if (attempt < READ_RETRIES) await sleep(READ_RETRY_DELAY_MS);
  }

  const fallback = lastKnownGood ?? (await loadLkgFromDisk());
  if (fallback) {
    lastKnownGood = fallback;
    lastSource = "fallback";
    console.warn(
      `[network-investigation] ${GLOBAL_CLAUDE_JSON} を読めませんでした(${lastErr instanceof Error ? lastErr.message : String(lastErr)})。` +
        ` 直近に読めた MCP サーバー定義(${Object.keys(fallback).join(", ")})で継続します。` +
        ` Docker では単一ファイル bind mount が古い inode に固定されるため、` +
        ` ホストの ~/.claude.json を更新したら \`docker compose up -d --force-recreate\` でマウントを張り直してください。`,
    );
    return fallback;
  }

  lastSource = "unavailable";
  throw new Error(
    `MCP サーバー定義を ${GLOBAL_CLAUDE_JSON} から読めず、フォールバックもありません` +
      `(${lastErr instanceof Error ? lastErr.message : String(lastErr)})。` +
      ` Docker の場合は \`docker compose up -d --force-recreate\` でマウントを張り直してください。`,
  );
}

/**
 * 起動時に1回だけ MCP サーバー定義を読んで last-known-good を作る。
 * コンテナ作成直後はマウントが新鮮なので、ここで良好なコピーを確保しておく。
 * 失敗しても起動は止めない(既存のディスクキャッシュがあればそれで走れる)。
 */
export async function primeMcpServerCache(): Promise<{
  source: "live" | "fallback" | "unavailable";
  servers: string[];
}> {
  try {
    const servers = await readGlobalMcpServers();
    return { source: lastSource, servers: Object.keys(servers) };
  } catch (err) {
    console.error("[network-investigation] MCP サーバー定義の初期読み込みに失敗:", err instanceof Error ? err.message : err);
    return { source: "unavailable", servers: [] };
  }
}

/** /health 等に出す、MCP サーバー定義の供給状態。 */
export function mcpServerSourceStatus(): { source: "live" | "fallback" | "unavailable"; servers: string[] } {
  return { source: lastSource, servers: lastKnownGood ? Object.keys(lastKnownGood) : [] };
}

/**
 * 指定プラットフォームに対応する MCP サーバーだけを含む一時 mcp-config を書き出し、
 * その絶対パスを返す。これが「ルーティングスキップ」の実体。
 *
 * - platforms が ["central"] なら central-mcp だけ、["mist"] なら mist-cloud だけを含める。
 * - 両方指定(プラットフォーム不明時)なら両方含める。
 * - claude 側は --strict-mcp-config と併用して「この config のサーバーだけ使う」を強制する。
 */
export async function writeNarrowedMcpConfig(platforms: Platform[]): Promise<{
  path: string;
  serverNames: string[];
}> {
  const all = await readGlobalMcpServers();
  const wanted = platforms.length ? platforms : ALL_PLATFORMS;

  const mcpServers: Record<string, McpServerDef> = {};
  for (const p of wanted) {
    const name = PLATFORM_TO_MCP_SERVER[p];
    const def = all[name];
    if (!def) {
      throw new Error(
        `MCP サーバー "${name}"(platform=${p})が ~/.claude.json に見つかりません`,
      );
    }
    // Docker 内ではループバック宛(central-mcp)を host.docker.internal へ差し替える。
    mcpServers[name] = rewriteServerDefHost(def);
  }

  // ディレクトリは owner のみ(0700)、ファイルは owner read/write のみ(0600)で書く。
  await mkdir(MCP_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const filePath = path.join(MCP_CONFIG_DIR, `mcp-${randomUUID()}.json`);
  await writeFile(filePath, JSON.stringify({ mcpServers }, null, 2), { encoding: "utf-8", mode: 0o600 });
  return { path: filePath, serverNames: Object.keys(mcpServers) };
}

/**
 * 指定プラットフォームで許可すべき MCP ツールのワイルドカードを返す
 * (--allowedTools に渡す)。--dangerously-skip-permissions と併用するが、
 * 意図を明示するため allowedTools も渡す。
 */
export function allowedToolsFor(platforms: Platform[]): string[] {
  const wanted = platforms.length ? platforms : ALL_PLATFORMS;
  return wanted.map((p) => `mcp__${PLATFORM_TO_MCP_SERVER[p]}__*`);
}

// ---- MCP サーバーの接続健全性(09)----
//
// 08 3-5 で残した穴: MCP サーバーの認証が切れているとハンドシェイクで失敗し、
// そのサーバーのツールが 1 つも登録されないまま実行が「成功」で終わる。
// tool_result の失敗は 08 で可視化したが、そもそも呼べていないケースは何も残らない。
//
// 判定材料は 3 つ:
//   (1) system(init)イベントの mcp_servers[].status  … "failed" は信頼できるが
//       stdio サーバーは正常時も "pending" のままなので、これ単独では判定できない
//   (2) その実行で実際に tool_use が出たか            … 1 回でも出ていれば接続できていた証拠
//   (3) 直接ハンドシェイク probe(mcp-health.ts)      … (2) が 0 件のときだけ実行する確認
//
// 「0 件だったから壊れている」とは決して言わない。必ず probe で裏を取ってから警告する
// (本当にツールを使う必要がない質問だった場合に誤検知しないため。09 Task 2-3)。

export type McpInitStatus = "connected" | "pending" | "failed" | "unknown";
export type McpHealthLevel = "ok" | "warn" | "unreachable";

export interface McpServerHealth {
  server: string;
  platform: Platform | null;
  /** claude CLI の init イベントが報告した接続状態 */
  initStatus: McpInitStatus;
  /** この実行でそのサーバーのツールを呼んだ回数 */
  toolCalls: number;
  /** 直接 probe の結果。true=到達 / false=到達せず / null=probe していない・判定不能 */
  reachable: boolean | null;
  /** probe で数えたツール数 */
  tools: number | null;
  /** サーバー単位の判定 */
  level: McpHealthLevel;
  /** level が ok でないときの理由(そのまま画面に出す) */
  reason?: string;
}

export interface McpHealth {
  level: McpHealthLevel;
  servers: McpServerHealth[];
  /** level が ok でないサーバーだけを抜いたもの(UI はこれを並べる) */
  problems: McpServerHealth[];
}

const platformJa = (p: Platform | null) => (p === "central" ? "Central" : p === "mist" ? "Mist" : "不明");

/** init イベントの mcp_servers[] を { サーバー名 → status } に均す。 */
function initStatusesFromEvents(events: any[]): Record<string, McpInitStatus> {
  const out: Record<string, McpInitStatus> = {};
  const init = events.find((e) => e && e.type === "system" && e.subtype === "init");
  const list = init?.mcp_servers;
  if (!Array.isArray(list)) return out;
  for (const s of list) {
    if (!s || typeof s.name !== "string") continue;
    const st = String(s.status ?? "").toLowerCase();
    out[s.name] =
      st === "connected" || st === "pending" || st === "failed" ? (st as McpInitStatus) : "unknown";
  }
  return out;
}

/**
 * 1 実行ぶんの MCP 接続健全性を判定する。
 * probe は「config に含めたのに 1 度も呼ばれなかった」サーバーに対してだけ、並列で走らせる。
 */
export async function evaluateMcpHealth(opts: {
  /** --mcp-config に含めたサーバー名 */
  serverNames: string[];
  /** サーバー名 → この実行での tool_use 回数 */
  callCounts: Record<string, number>;
  /** 収集済みの NDJSON イベント(init を探す) */
  events: any[];
}): Promise<McpHealth> {
  const initStatuses = initStatusesFromEvents(opts.events);
  let defs: Record<string, McpServerDef> = {};
  try {
    defs = await readGlobalMcpServers();
  } catch {
    /* 定義が読めないときは probe できない。init と呼び出し実績だけで判定する */
  }

  const servers = await Promise.all(
    opts.serverNames.map(async (server): Promise<McpServerHealth> => {
      const platform = MCP_SERVER_TO_PLATFORM[server] ?? null;
      const initStatus = initStatuses[server] ?? "unknown";
      const toolCalls = opts.callCounts[server] ?? 0;
      const base = { server, platform, initStatus, toolCalls };

      // 1 回でも呼べていれば接続できていた。probe せず ok。
      if (toolCalls > 0) return { ...base, reachable: true, tools: null, level: "ok" };

      const def = defs[server];
      let probe: McpProbeResult = def
        ? await probeMcpServerDef(rewriteServerDefHost(def))
        : { method: "none", ok: null, tools: null, status: null, reason: "サーバー定義を読めませんでした" };

      if (probe.ok === false) {
        return {
          ...base,
          reachable: false,
          tools: probe.tools,
          level: "unreachable",
          reason: probe.reason || "接続できませんでした",
        };
      }
      if (probe.ok === true) {
        // 到達できたのに claude 側は failed と言っている = claude 起動時だけ失敗していた。
        if (initStatus === "failed") {
          return {
            ...base,
            reachable: true,
            tools: probe.tools,
            level: "warn",
            reason:
              "claude CLI の初期化時に接続失敗と報告されましたが、直接確認では到達できました(一時的な失敗の可能性があります)",
          };
        }
        // 到達できるのに使われなかった = モデルが必要としなかっただけ。警告しない。
        return { ...base, reachable: true, tools: probe.tools, level: "ok" };
      }

      // probe できなかった。init の申告だけで判断する(断定はしない)。
      if (initStatus === "failed") {
        return {
          ...base,
          reachable: null,
          tools: null,
          level: "unreachable",
          reason: "claude CLI の初期化時に接続に失敗しました(mcp_servers.status=failed)",
        };
      }
      if (initStatus === "connected") return { ...base, reachable: null, tools: null, level: "ok" };
      return {
        ...base,
        reachable: null,
        tools: null,
        level: "warn",
        reason: `接続状態を確認できませんでした(初期化時 status=${initStatus}、直接確認は非対応: ${probe.reason ?? "-"})`,
      };
    }),
  );

  const problems = servers.filter((s) => s.level !== "ok");
  const level: McpHealthLevel = problems.some((s) => s.level === "unreachable")
    ? "unreachable"
    : problems.length > 0
      ? "warn"
      : "ok";
  return { level, servers, problems };
}

/** サーバー名を「mist-cloud(Mist)」の形で表示する。UI・ログ共通。 */
export function describeMcpServer(h: McpServerHealth): string {
  return `${h.server}(${platformJa(h.platform)})`;
}

// ---- claude CLI 呼び出し ----

// クエリでモデルが指定されないときの既定。--model は常に明示的な値を伴わせる方針のため、
// 環境変数が未設定でも "sonnet" にフォールバックし、フラグ無しで claude を呼ぶケースを作らない。
// (UI からのクエリは必ず opus/sonnet を送るので、この既定は主に旧・未指定の定期クエリのための保険。)
// NETINV_MODEL が本アプリのキー。CORSTACK_NETINV_MODEL は移植元との互換のため残す。
const DEFAULT_AGENT_MODEL =
  process.env.NETINV_MODEL || process.env.CORSTACK_NETINV_MODEL || "sonnet";
const DEFAULT_TIMEOUT_MS = 240_000;

export interface McpAskResult {
  text: string;
  isError: boolean;
  reason?: string;
  /** 実際に --mcp-config に含めた MCP サーバー名(narrowing の確認用) */
  mcpServers: string[];
  /** MCP サーバーの接続健全性(checkHealth:true のときだけ)。09 */
  mcpHealth?: McpHealth;
}

// result イベント(is_error:true)から、人が読める失敗理由を組み立てる。
// 認証失敗のときは api_error_status(401)と result(本文)の両方が載るので、両方残す
// (どちらか一方だけだと「なぜ落ちたか」が画面から分からない。08 Task 3 で判明)。
function describeResultError(result: any): string {
  const parts: string[] = [];
  if (result.api_error_status) parts.push(`HTTP ${result.api_error_status}`);
  const msg = typeof result.result === "string" ? result.result.trim() : "";
  if (msg) parts.push(msg.slice(0, 200));
  if (parts.length === 0) parts.push(result.subtype || "unknown");
  return parts.join(" — ");
}

/**
 * 収集済みイベントから「失敗の理由」だけを拾う(非ゼロ終了時に使う)。
 * claude CLI は認証失敗などで exit 1 になるが、stderr が空のまま
 * stdout の result イベントにだけ原因が載ることがある。
 *   {"type":"result","is_error":true,"api_error_status":401,
 *    "result":"Failed to authenticate. API Error: 401 Invalid bearer token"}
 * これを拾わないと UI には「claude exited 1:」しか出ない。
 */
function failureReasonFromEvents(events: any[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === "result" && e.is_error === true) return describeResultError(e);
  }
  return null;
}

// 収集済みの NDJSON イベント配列から result テキストを取り出す。
// stream-json では末尾に {type:"result", result, is_error, ...} が1件来る。
function extractResultFromEvents(events: any[]): { text: string; isError: boolean; reason?: string } {
  const result = events.find((e) => e && e.type === "result");
  if (result) {
    if (result.is_error === true) {
      return {
        text: typeof result.result === "string" ? result.result : "",
        isError: true,
        reason: `claude result is_error: ${describeResultError(result)}`,
      };
    }
    if (typeof result.result === "string") return { text: result.result, isError: false };
  }
  // フォールバック: result イベントが無い場合、末尾の result 文字列を拾う。
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i] && typeof events[i].result === "string") {
      return { text: events[i].result, isError: false };
    }
  }
  return { text: "", isError: true, reason: "claude の応答から result を取得できませんでした" };
}

/**
 * narrowing した MCP サーバー付きで claude CLI を1回起動する(共通プリミティブ)。
 * runInsightAgent と generateSitePlatformMap が共に呼ぶ。
 *
 * 失敗しても reject せず McpAskResult(isError) を resolve する。
 */
export async function runClaudeWithMcp(opts: {
  prompt: string;
  platforms: Platform[];
  systemPrompt?: string;
  timeoutMs?: number;
  /**
   * MCP ツールの呼び出し/完了を逐次受け取るコールバック(SSE 見える化用)。
   * 渡すと stdout を1行ずつパースしながら tool_use/tool_result をリアルタイムに流す。
   * 渡さなくても最終結果の取り出しには影響しない(スケジューラ・対応表生成はこれを使わない)。
   */
  onEvent?: (e: McpStreamEvent) => void;
  /** 使用モデル(エイリアス or フルID)。未指定なら CORSTACK_NETINV_MODEL → "sonnet"。 */
  model?: string;
  /**
   * 実行後に MCP サーバーの接続健全性を判定する(09)。
   * 一度も呼ばれなかったサーバーだけを直接 probe するので、正常時のコストはほぼ無い。
   * 対話・定期実行の調査(runInsightAgent)では true。内部用途(対応表生成・状態取得)では不要。
   */
  checkHealth?: boolean;
}): Promise<McpAskResult> {
  const { prompt, platforms, systemPrompt, timeoutMs = DEFAULT_TIMEOUT_MS, onEvent, model, checkHealth } = opts;

  let configPath: string;
  let serverNames: string[];
  try {
    const cfg = await writeNarrowedMcpConfig(platforms);
    configPath = cfg.path;
    serverNames = cfg.serverNames;
  } catch (err) {
    // ここで落ちると「ツール0件・原因不明のエラー文字列」だけが UI に出て、ログには何も残らない。
    // 供給元(~/.claude.json)の読み取り失敗はここに来るので、必ずサーバーログにも出す。
    console.error("[network-investigation] MCP config の生成に失敗:", err instanceof Error ? err.message : err);
    return { text: "", isError: true, reason: err instanceof Error ? err.message : String(err), mcpServers: [] };
  }

  await mkdir(AGENT_CWD, { recursive: true });

  // Discussion Panel は --output-format json で全出力を一括パースするが、ここでは MCP 呼び出しを
  // リアルタイム配信するため stream-json --verbose(NDJSON)で起動し、行が来るたびに解釈する。
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--mcp-config",
    configPath,
    "--dangerously-skip-permissions",
    "--allowedTools",
    ...allowedToolsFor(platforms),
  ];
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  // model は空文字も既定へ倒す(|| を使う)。DEFAULT_AGENT_MODEL は常に真値なので、
  // --model は必ず明示的な値付きで push される(フラグ無し呼び出しは発生しない)。
  const chosenModel = model || DEFAULT_AGENT_MODEL;
  args.push("--model", chosenModel);

  return await new Promise<McpAskResult>((resolve) => {
    const child = spawn("claude", args, { cwd: AGENT_CWD, env: process.env });

    const events: any[] = []; // result 取り出し用に全 NDJSON イベントを溜める
    // サーバー名 → この実行で tool_use が出た回数(09 の健全性判定の材料)。
    // onEvent(見える化)の有無に関係なく常に数える。
    const callCounts: Record<string, number> = {};
    let lineBuf = ""; // 行の途中で切れたチャンクを保持する行バッファ
    let err = "";
    let settled = false;

    const countToolUses = (ev: any) => {
      if (!ev || ev.type !== "assistant") return;
      const content = ev.message?.content;
      if (!Array.isArray(content)) return;
      for (const c of content) {
        if (!c || c.type !== "tool_use" || typeof c.name !== "string") continue;
        const parsed = parseMcpToolName(c.name);
        if (!parsed) continue;
        callCounts[parsed.server] = (callCounts[parsed.server] ?? 0) + 1;
      }
    };

    const handleLine = (line: string) => {
      const s = line.trim();
      if (!s) return;
      let ev: any;
      try {
        ev = JSON.parse(s);
      } catch {
        return; // 非JSON行は無視
      }
      events.push(ev);
      countToolUses(ev);
      if (onEvent) {
        try {
          emitMcpEvents(ev, onEvent);
        } catch {
          /* 見える化の失敗で本体を倒さない */
        }
      }
    };

    const done = (r: McpAskResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // トークン材料を含む一時 mcp-config は、使い終わったら必ず削除する(ディスクに残さない)。
      unlink(configPath).catch(() => {
        /* 既に無い/削除できない場合は無視(0600 なので露出は最小) */
      });
      if (!checkHealth) {
        resolve(r);
        return;
      }
      // 接続健全性の判定(09)。probe が走るのは「config に入れたのに 1 度も呼ばれなかった」
      // サーバーだけなので、正常な実行ではほぼ即座に返る。判定に失敗しても本体は倒さない。
      evaluateMcpHealth({ serverNames, callCounts, events })
        .then((mcpHealth) => {
          if (mcpHealth.level !== "ok") {
            console.warn(
              `[network-investigation] MCP 接続の警告(${mcpHealth.level}): ` +
                mcpHealth.problems.map((p) => `${describeMcpServer(p)} — ${p.reason ?? "-"}`).join(" / "),
            );
          }
          resolve({ ...r, mcpHealth });
        })
        .catch((e) => {
          console.warn("[network-investigation] MCP 健全性の判定に失敗:", e instanceof Error ? e.message : e);
          resolve(r);
        });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ text: "", isError: true, reason: `claude timed out after ${timeoutMs}ms`, mcpServers: serverNames });
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      lineBuf += d.toString();
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        handleLine(line);
      }
    });
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) =>
      done({ text: "", isError: true, reason: e instanceof Error ? e.message : String(e), mcpServers: serverNames }),
    );
    child.on("close", (code) => {
      if (lineBuf.trim()) handleLine(lineBuf); // 末尾に改行が無い最終行を処理
      if (code !== 0) {
        // stderr は空のことがある(認証失敗など)。その場合でも stdout の result イベントに
        // 原因が載っているので、そちらを優先して理由に載せる(08 Task 3)。
        const detail = failureReasonFromEvents(events) || err.trim().slice(0, 200) || "(stderr・result ともに情報なし)";
        done({ text: "", isError: true, reason: `claude exited ${code}: ${detail}`, mcpServers: serverNames });
        return;
      }
      const { text, isError, reason } = extractResultFromEvents(events);
      done({ text: text.trim(), isError, reason, mcpServers: serverNames });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
