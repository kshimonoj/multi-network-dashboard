// Network Investigation — MCP サーバーの生死確認(直接ハンドシェイク probe)
//
// 背景(09。08 3-5 で残した穴):
//   MCP サーバー自体の認証が切れていると、claude CLI はハンドシェイク段階で失敗し、
//   そのサーバーのツールを 1 つも登録しないまま実行が「成功」で終わる。
//   モデルは地の文で「ツールが見つかりません」と書くだけなので、画面には何も出ない。
//
//   claude CLI の system(init)イベントには mcp_servers[].status が載るが、
//   stdio サーバー(mist-cloud = npx mcp-remote)は正常時も認証切れ時も等しく "pending" で、
//   init 以降に状態を更新するイベントは来ない(09 findings 1-1)。
//   → init だけでは判定できないので、こちらから直接ハンドシェイクを叩いて確かめる。
//
// ここでやること: claude CLI も mcp-remote も経由せず、素の HTTP で MCP の
//   initialize → notifications/initialized → tools/list
// を実行し、「ツールが 1 件以上返るか」で生死を判定する。
// 認証切れなら initialize が JSON-RPC エラー(実測: Mist は
// `authentication failed: Mist API rejected credentials (HTTP 401)`)を返すので、
// その本文をそのまま理由として持ち帰る。

// MCP サーバー定義(~/.claude.json の mcpServers 1 件分)。
// mcp.ts もこれを使う。型をここに置くのは、mcp.ts → mcp-health.ts の一方向依存に保つため。
export interface McpServerDef {
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/** probe の実施方式。"none" は「この定義は直接叩けない = 判定不能」。 */
export type McpProbeMethod = "http" | "none";

export interface McpProbeResult {
  method: McpProbeMethod;
  /** true=到達してツールが返った / false=到達できない or ツール 0 件 / null=判定不能 */
  ok: boolean | null;
  /** tools/list で返ったツール数(取れたときだけ) */
  tools: number | null;
  /** 拾えた HTTP ステータス(取れたときだけ) */
  status: number | null;
  /** ok=false のときの理由(MCP サーバーが返した文言をそのまま使う) */
  reason?: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 8000;
const REASON_MAX = 300;

function truncate(s: string, max = REASON_MAX): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// ---- 定義 → HTTP エンドポイント ----

interface Endpoint {
  url: string;
  headers: Record<string, string>;
}

// `npx mcp-remote <url> --header "K:V" --header "K:V"` の args から url とヘッダを取り出す。
// mcp-remote は「リモートの streamable-HTTP サーバーへヘッダ付きで中継する」だけなので、
// ここで同じ url に同じヘッダで直接繋げば、mcp-remote 経由と同じ認証結果になる。
function endpointFromMcpRemoteArgs(args: string[]): Endpoint | null {
  if (!args.some((a) => a === "mcp-remote" || a.endsWith("/mcp-remote"))) return null;
  const url = args.find((a) => /^https?:\/\//i.test(a));
  if (!url) return null;
  const headers: Record<string, string> = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "--header") continue;
    const raw = args[i + 1];
    if (typeof raw !== "string") continue;
    const sep = raw.indexOf(":");
    if (sep <= 0) continue;
    headers[raw.slice(0, sep).trim()] = raw.slice(sep + 1).trim();
  }
  return { url, headers };
}

/**
 * MCP サーバー定義から、直接叩ける HTTP エンドポイントを割り出す。
 * 割り出せない(未知の stdio サーバー、レガシーな type:"sse" 等)なら null を返し、
 * 呼び出し側は「判定不能」として扱う。誤って "壊れている" と断定しないため。
 */
export function endpointFromServerDef(def: McpServerDef): Endpoint | null {
  const type = (def.type || "").toLowerCase();
  // type:"sse" は POST 先が別エンドポイントになる旧トランスポート。同じ叩き方ができないので触らない。
  if (type === "sse") return null;
  if (typeof def.url === "string" && def.url) {
    return { url: def.url, headers: { ...(def.headers ?? {}) } };
  }
  if (Array.isArray(def.args)) return endpointFromMcpRemoteArgs(def.args);
  return null;
}

// ---- JSON-RPC over HTTP(streamable-HTTP)----

// MCP の streamable-HTTP は、同じ POST に対して application/json でも
// text/event-stream(`event: message` / `data: {…}`)でも応答してよい。両方を受ける。
function parseRpcBody(body: string): any | null {
  const t = body.trim();
  if (!t) return null;
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }
  for (const line of t.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    try {
      return JSON.parse(s.slice(5).trim());
    } catch {
      /* 次の data: 行を試す */
    }
  }
  return null;
}

// エラー文言に HTTP ステータスが埋め込まれていることがある
// (実測: "authentication failed: Mist API rejected credentials (HTTP 401)")。
function statusFromText(text: string): number | null {
  const m = text.match(/\bHTTP[\s/]?(\d{3})\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 100 && n <= 599 ? n : null;
}

async function rpc(
  ep: Endpoint,
  body: unknown,
  sessionId: string | null,
  timeoutMs: number,
): Promise<{ res: Response; text: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...ep.headers,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(ep.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { res, text: await res.text() };
}

const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "multi-network-dashboard-health-probe", version: "1.0" },
  },
};

/**
 * 1 サーバーぶんの生死確認。例外は投げず、必ず McpProbeResult を返す。
 *
 * 判定:
 *   - initialize が HTTP エラー / JSON-RPC エラー → ok:false(理由付き)
 *   - tools/list がエラー、またはツール 0 件 → ok:false
 *     (「ツールが 1 件も返らないならその場でエラー扱い」= 指示書 Task 1-2 の基準)
 *   - ツールが 1 件以上 → ok:true
 */
export async function probeMcpServerDef(
  def: McpServerDef,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<McpProbeResult> {
  const ep = endpointFromServerDef(def);
  if (!ep) {
    return { method: "none", ok: null, tools: null, status: null, reason: "この定義は直接確認できません" };
  }

  let sessionId: string | null = null;
  try {
    const init = await rpc(ep, INITIALIZE_BODY, null, timeoutMs);
    if (!init.res.ok) {
      return {
        method: "http",
        ok: false,
        tools: null,
        status: init.res.status,
        reason: truncate(`initialize が HTTP ${init.res.status}: ${init.text.trim() || "(本文なし)"}`),
      };
    }
    const parsed = parseRpcBody(init.text);
    if (parsed?.error) {
      const msg = String(parsed.error.message ?? JSON.stringify(parsed.error));
      return { method: "http", ok: false, tools: null, status: statusFromText(msg), reason: truncate(msg) };
    }
    if (!parsed?.result) {
      return {
        method: "http",
        ok: false,
        tools: null,
        status: init.res.status,
        reason: truncate(`initialize の応答を解釈できませんでした: ${init.text.trim().slice(0, 120)}`),
      };
    }
    sessionId = init.res.headers.get("mcp-session-id");

    // 仕様準拠のサーバーは initialized 通知を受けてからでないと tools/list を通さない。
    // 通知は応答を持たないので、失敗しても致命ではない(ベストエフォート)。
    await rpc(ep, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId, timeoutMs).catch(() => {});

    const list = await rpc(ep, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId, timeoutMs);
    if (!list.res.ok) {
      return {
        method: "http",
        ok: false,
        tools: null,
        status: list.res.status,
        reason: truncate(`tools/list が HTTP ${list.res.status}: ${list.text.trim() || "(本文なし)"}`),
      };
    }
    const listed = parseRpcBody(list.text);
    if (listed?.error) {
      const msg = String(listed.error.message ?? JSON.stringify(listed.error));
      return { method: "http", ok: false, tools: null, status: statusFromText(msg), reason: truncate(msg) };
    }
    const tools = Array.isArray(listed?.result?.tools) ? listed.result.tools.length : 0;
    if (tools === 0) {
      return {
        method: "http",
        ok: false,
        tools: 0,
        status: list.res.status,
        reason: "ハンドシェイクは通りましたが、ツールが 1 件も登録されていません",
      };
    }
    return { method: "http", ok: true, tools, status: list.res.status };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { method: "http", ok: false, tools: null, status: null, reason: truncate(msg) };
  } finally {
    // セッションを張りっぱなしにしない(サーバー側に溜めない)。対応していなくても害はない。
    if (sessionId) {
      try {
        await fetch(ep.url, {
          method: "DELETE",
          headers: { ...ep.headers, "mcp-session-id": sessionId },
          signal: AbortSignal.timeout(2000),
        });
      } catch {
        /* DELETE 非対応のサーバーもある。無視してよい */
      }
    }
  }
}
