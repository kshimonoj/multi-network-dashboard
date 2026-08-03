// Network Investigation — Ollama 用の薄い MCP クライアント(25 Task 2)
//
// claude CLI 版(mcp.ts の runClaudeWithMcp)は `claude` サブプロセスに --mcp-config を渡し、
// MCP への接続・ツール呼び出しは claude CLI 自身に任せている。Ollama にはその CLI が無いため、
// ここでは @modelcontextprotocol/sdk の Client を使い、central-mcp / mist-cloud へ直接つなぐ。
//
// - central-mcp(type:"http")… StreamableHTTPClientTransport で直結。
// - mist-cloud(command:"npx" mcp-remote 経由の stdio)… サーバー定義をそのまま
//   StdioClientTransport に渡し、mcp-remote プロセスを1回だけ立てて使い回す
//   (narrowing・ホスト書き換え(rewriteServerDefHost)は mcp.ts 側で既に適用済みの定義を使う)。
//
// 1 クエリの実行中(runOllamaAgent 1回分)だけ接続を張り、終わったら close() する。
// 複数ツール呼び出しをまたいで同じ接続を使い回すことで、呼び出しごとに
// ハンドシェイクし直すコスト(mist-cloud は npx 起動を含む)を避ける。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getNarrowedServerDefs, type Platform } from "./mcp.js";
import type { McpServerDef } from "./mcp-health.js";

// Ollama の /api/chat に渡す tools 定義。claude CLI 側の "mcp__<server>__<tool>" と
// 同じ命名にすることで、既存の parseMcpToolName(mcp.ts)をそのまま流用できる
// (SSE 見える化・ログの形を Claude 実行と揃えるため)。
export interface OllamaToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
  };
}

export interface McpCallOutcome {
  text: string;
  isError: boolean;
}

export interface McpToolSession {
  /** 接続できたサーバー名一覧(narrowing した中で実際に繋がったものだけ)。 */
  serverNames: string[];
  /** 接続に失敗したサーバー(サーバー名→理由)。呼び出し元が MCP 健全性表示に使える。 */
  connectFailures: Record<string, string>;
  tools: OllamaToolDef[];
  callTool(fullName: string, args: unknown): Promise<McpCallOutcome>;
  close(): Promise<void>;
}

function makeTransport(def: McpServerDef): Transport {
  const type = (def.type || "").toLowerCase();
  if (type !== "stdio" && typeof def.url === "string" && def.url) {
    const headers = { ...(def.headers ?? {}) };
    return new StreamableHTTPClientTransport(new URL(def.url), {
      requestInit: Object.keys(headers).length ? { headers } : undefined,
    });
  }
  if (typeof def.command === "string" && def.command) {
    return new StdioClientTransport({
      command: def.command,
      args: def.args ?? [],
      env: { ...getDefaultEnvironment(), ...(def.env ?? {}) },
      // mist-cloud は `npx mcp-remote <url> --header "Authorization:Bearer ..."` を子プロセスとして
      // 起動する(def.args に Bearer トークンが平文で入っている)。mcp-remote 自身が起動時に
      // 自分の引数(ヘッダ含む)を stderr にデバッグ出力するため、既定の "inherit" のままだと
      // このプロセスの stderr 経由でトークンが Docker のログ等に流出する。"ignore" で握りつぶす。
      stderr: "ignore",
    });
  }
  throw new Error(`未対応の MCP サーバー定義です(type=${def.type ?? "unknown"})`);
}

// tool_result の content(配列)を1本の文字列へ平坦化する。mcp.ts の同名ロジックと同じ考え方。
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c && typeof c === "object" && typeof (c as any).text === "string") return (c as any).text;
        return "";
      })
      .join("");
  }
  return "";
}

// mist-cloud(npx mcp-remote 経由の stdio)はプロセス起動 + リモートへのハンドシェイクを含むため、
// 環境によっては claude CLI 版より時間がかかる。SDK の Client#connect() 自体にはタイムアウトが
// 無く、リモート側が応答しないと無期限に待ち続けてしまうので、ここで上限を切る
// (1 サーバーがハングしても、他方だけで実行を続けられるようにするため)。
const CONNECT_TIMEOUT_MS = Number(process.env.OLLAMA_MCP_CONNECT_TIMEOUT_MS || 45_000);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} が ${ms}ms 以内に完了しませんでした`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * narrowing したプラットフォームぶんの MCP サーバーへ接続し、ツール一覧を集約する。
 * 1 サーバーの接続に失敗しても他方は使える状態で返す(connectFailures に理由を積む)。
 * 全滅した場合のみ例外を投げる(呼び出せるツールが1つも無い状態で実行を続ける意味が無いため)。
 * 各サーバーの接続は並行して行う(mist-cloud の起動が遅くても central-mcp を待たせない)。
 */
export async function connectMcpTools(platforms: Platform[]): Promise<McpToolSession> {
  const defs = await getNarrowedServerDefs(platforms);
  const clients = new Map<string, Client>();
  const connectFailures: Record<string, string> = {};
  const tools: OllamaToolDef[] = [];

  await Promise.all(
    Object.entries(defs).map(async ([serverName, def]) => {
      const t0 = Date.now();
      try {
        const client = new Client({ name: "multi-network-dashboard-ollama-agent", version: "1.0" });
        const transport = makeTransport(def);
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `${serverName} への接続`);
        const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `${serverName} の tools/list`);
        for (const t of listed.tools) {
          tools.push({
            type: "function",
            function: {
              name: `mcp__${serverName}__${t.name}`,
              description: t.description,
              parameters: t.inputSchema ?? { type: "object", properties: {} },
            },
          });
        }
        clients.set(serverName, client);
        console.error(`[network-investigation] ollama-mcp: ${serverName} に接続しました(${Date.now() - t0}ms, tools=${listed.tools.length})`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        connectFailures[serverName] = reason;
        console.error(`[network-investigation] ollama-mcp: ${serverName} への接続に失敗しました(${Date.now() - t0}ms): ${reason}`);
      }
    }),
  );

  if (clients.size === 0) {
    const reasons = Object.entries(connectFailures)
      .map(([n, r]) => `${n}: ${r}`)
      .join(" / ");
    throw new Error(`MCP サーバーに1つも接続できませんでした(${reasons || "理由不明"})`);
  }

  const close = async () => {
    await Promise.all(
      [...clients.values()].map((c) => c.close().catch(() => {/* 既に切れていても無視 */})),
    );
  };

  const callTool = async (fullName: string, args: unknown): Promise<McpCallOutcome> => {
    const parts = fullName.split("__");
    if (parts.length < 3 || parts[0] !== "mcp") {
      return { text: `不正なツール名です: ${fullName}`, isError: true };
    }
    const serverName = parts[1];
    const toolName = parts.slice(2).join("__");
    const client = clients.get(serverName);
    if (!client) {
      return { text: `サーバー "${serverName}" は接続されていません`, isError: true };
    }
    try {
      const result = await client.callTool({ name: toolName, arguments: (args ?? {}) as Record<string, unknown> });
      const text = flattenContent(result.content);
      return { text, isError: result.isError === true };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true };
    }
  };

  return { serverNames: [...clients.keys()], connectFailures, tools, callTool, close };
}
