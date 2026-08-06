// Network Investigation — Ollama(ローカルLLM)版 Insight Agent(25 Task 2)
//
// claude CLI 版(insight-agent.ts の runInsightAgent)と同じ入出力インターフェース
// (InsightAgentResult / McpCallEvent / PlatformJudgmentEvent)を持つ、Ollama 経由の実装。
// api.ts はモデル指定が "local"(ローカルモデル)のときだけこちらを呼ぶ。
//
// claude CLI はサブプロセス自身がツール呼び出しループを回すが、Ollama にはその機構が無いため、
// ここで /api/chat ⇄ MCP ツール実行 のループを手で組む(数ターンで終わらない場合の上限つき)。

import { randomUUID } from "node:crypto";
import { PLATFORM_TO_MCP_SERVER, parseMcpToolName, type Platform } from "./mcp.js";
import { connectMcpTools, type OllamaToolDef } from "./ollama-mcp-client.js";
import { classifyToolAiSource } from "./ai-source.js";
import {
  buildSystemPrompt,
  detectPlatformJudgments,
  estimateCount,
  extractStatusCode,
  extractSuggestedActions,
  resolveRouting,
  stringifyInput,
  stripPlatformJudgments,
  summarizeInput,
  truncate,
  DEFAULT_AGENT_LANG,
  type AgentLang,
  type InsightAgentResult,
  type McpCallEvent,
  type PlatformJudgmentEvent,
} from "./insight-agent.js";
import type { McpHealth, McpServerHealth } from "./mcp.js";

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma4:12b";
// ツール呼び出し→結果→再問い合わせ、の往復回数の上限。1往復で最終回答が出るのが大半だが、
// 「片方のプラットフォームを判断してから他方も呼ぶ」ケース等を見込んで少し余裕を持たせる。
const MAX_TOOL_TURNS = Number(process.env.OLLAMA_MAX_TOOL_TURNS || 6);
const REQUEST_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 240_000);
const ERROR_TEXT_MAX = 1200;

// ---- Ollama /api/chat の型(必要な範囲だけ) ----
interface OllamaToolCall {
  id?: string;
  function: { name: string; arguments: Record<string, unknown> };
}
interface OllamaMessage {
  role: string;
  content?: string;
  tool_calls?: OllamaToolCall[];
}
interface OllamaChatResponse {
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
}

async function callOllamaChat(model: string, messages: ChatMessage[], tools: OllamaToolDef[]): Promise<OllamaChatResponse> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools, stream: false }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama /api/chat が HTTP ${res.status} を返しました: ${truncate(body.trim(), 300)}`);
  }
  return (await res.json()) as OllamaChatResponse;
}

// connectMcpTools() の接続結果 + このクエリで実際に呼んだ回数から、claude CLI 版の
// evaluateMcpHealth(mcp.ts)と同じ形の McpHealth を組み立てる。Ollama 版は claude CLI の
// stream-json init イベントが無い代わりに、SDK の connect() 自体が接続確認そのものなので、
// probe を別途走らせる必要が無い(接続できていれば initStatus は必ず "connected")。
function buildMcpHealth(
  serverNames: string[],
  connectFailures: Record<string, string>,
  callCounts: Record<string, number>,
): McpHealth {
  const servers: McpServerHealth[] = [];
  for (const server of serverNames) {
    const platform = (Object.entries(PLATFORM_TO_MCP_SERVER).find(([, v]) => v === server)?.[0] ?? null) as
      | Platform
      | null;
    servers.push({
      server,
      platform,
      initStatus: "connected",
      toolCalls: callCounts[server] ?? 0,
      reachable: true,
      tools: null,
      level: "ok",
    });
  }
  for (const [server, reason] of Object.entries(connectFailures)) {
    const platform = (Object.entries(PLATFORM_TO_MCP_SERVER).find(([, v]) => v === server)?.[0] ?? null) as
      | Platform
      | null;
    servers.push({
      server,
      platform,
      initStatus: "failed",
      toolCalls: 0,
      reachable: false,
      tools: null,
      level: "unreachable",
      reason,
    });
  }
  const problems = servers.filter((s) => s.level !== "ok");
  const level = problems.some((s) => s.level === "unreachable") ? "unreachable" : problems.length ? "warn" : "ok";
  return { level, servers, problems };
}

/**
 * Ollama 版 Insight Agent。runInsightAgent(claude CLI 版)と同じシグネチャ・同じ戻り値の形。
 * api.ts は model==="local" のときだけこちらを呼ぶ(呼び出し元からは実質差し替え可能)。
 */
export async function runOllamaAgent(
  query: string,
  siteNameOrId?: string,
  opts?: {
    onMcpCall?: (e: McpCallEvent) => void;
    onPlatformJudgment?: (e: PlatformJudgmentEvent) => void;
    /** Ollama のモデル名。未指定なら OLLAMA_MODEL → "gemma4:12b"。 */
    model?: string;
    /** 回答言語(29 Task 4)。claude CLI 版と同じく system prompt を切り替える。 */
    lang?: AgentLang;
    /**
     * 承認済みナレッジの「関連する既知の情報」セクション(47)。
     * claude CLI 版とまったく同じ扱い(buildSystemPrompt の末尾に足すだけ)。
     * ローカルモデルでも同じ前提で答えさせるため、経路による差を作らない。
     */
    knowledge?: string;
  },
): Promise<InsightAgentResult> {
  const q = (query || "").trim();
  if (!q) {
    return {
      answer: "",
      suggestedActions: [],
      isError: true,
      reason: "query が空です",
      resolvedPlatform: null,
      platformsUsed: [],
      mcpServers: [],
      matchedSite: null,
    };
  }

  const { resolvedPlatform, matchedSite, platformsUsed, bothPlatforms } = await resolveRouting(siteNameOrId);
  const model = opts?.model || DEFAULT_OLLAMA_MODEL;

  let session: Awaited<ReturnType<typeof connectMcpTools>>;
  try {
    session = await connectMcpTools(platformsUsed);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      answer: "",
      suggestedActions: [],
      isError: true,
      reason,
      resolvedPlatform,
      platformsUsed,
      mcpServers: [],
      matchedSite,
    };
  }

  const callCounts: Record<string, number> = {};
  const judgedPlatforms = new Set<Platform>();

  try {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(bothPlatforms, opts?.lang ?? DEFAULT_AGENT_LANG, opts?.knowledge),
      },
      { role: "user", content: q },
    ];

    let finalText = "";
    let sawJudgmentDetector = (text: string) => {
      if (!opts?.onPlatformJudgment || !text) return;
      for (const j of detectPlatformJudgments(text)) {
        if (judgedPlatforms.has(j.platform)) continue;
        judgedPlatforms.add(j.platform);
        opts.onPlatformJudgment(j);
      }
    };

    let turn = 0;
    let incomplete = false;
    for (; turn < MAX_TOOL_TURNS; turn++) {
      const turnT0 = Date.now();
      console.error(`[network-investigation] ollama-agent: turn ${turn + 1}/${MAX_TOOL_TURNS} を ${model} に送信します`);
      const res = await callOllamaChat(model, messages, session.tools);
      console.error(`[network-investigation] ollama-agent: turn ${turn + 1} 応答(${Date.now() - turnT0}ms, tool_calls=${(res.message.tool_calls ?? []).length})`);
      const msg = res.message;
      const content = msg.content || "";
      const toolCalls = msg.tool_calls || [];

      if (toolCalls.length === 0) {
        finalText = content;
        sawJudgmentDetector(content);
        break;
      }

      sawJudgmentDetector(content);
      messages.push({ role: "assistant", content, tool_calls: toolCalls });

      for (const call of toolCalls) {
        const fullName = call.function.name;
        const args = call.function.arguments ?? {};
        const callId = call.id || randomUUID();
        const parsed = parseMcpToolName(fullName);
        const detail = summarizeInput(args);
        const inputJson = stringifyInput(args);
        // 出所(56)。claude CLI 版(insight-agent.ts)と同じ分類関数を通す。
        const aiSource = parsed ? classifyToolAiSource(parsed.tool, args) : null;

        if (parsed) {
          callCounts[parsed.server] = (callCounts[parsed.server] ?? 0) + 1;
          opts?.onMcpCall?.({
            id: callId,
            server: parsed.server,
            platform: parsed.platform,
            tool: parsed.tool,
            status: "calling",
            detail,
            ...(aiSource ? { aiSource } : {}),
          });
        }

        const outcome = await session.callTool(fullName, args);

        if (parsed) {
          opts?.onMcpCall?.({
            id: callId,
            server: parsed.server,
            platform: parsed.platform,
            tool: parsed.tool,
            status: outcome.isError ? "error" : "done",
            detail,
            count: estimateCount(outcome.text),
            ...(aiSource ? { aiSource } : {}),
            ...(outcome.isError
              ? {
                  error: outcome.text ? truncate(outcome.text, ERROR_TEXT_MAX) : "エラー本文が空でした",
                  errorStatus: extractStatusCode(outcome.text),
                  input: inputJson,
                }
              : {}),
          });
        }

        messages.push({
          role: "tool",
          tool_call_id: callId,
          content: outcome.text || (outcome.isError ? "(エラー: 応答本文なし)" : "(応答本文なし)"),
        });
      }

      if (turn === MAX_TOOL_TURNS - 1) {
        // 上限に達した。最後の assistant content(あれば)をそのまま答えとして使う。
        incomplete = true;
        finalText = content;
      }
    }

    const mcpHealth = buildMcpHealth(session.serverNames, session.connectFailures, callCounts);

    if (incomplete && !finalText.trim()) {
      return {
        answer: "",
        suggestedActions: [],
        isError: true,
        reason: `ツール呼び出しが ${MAX_TOOL_TURNS} 往復に達しても完了しませんでした`,
        resolvedPlatform,
        platformsUsed,
        mcpServers: session.serverNames,
        matchedSite,
        mcpHealth,
      };
    }

    const { answer, suggestedActions } = extractSuggestedActions(stripPlatformJudgments(finalText));
    return {
      answer,
      suggestedActions,
      isError: false,
      resolvedPlatform,
      platformsUsed,
      mcpServers: session.serverNames,
      matchedSite,
      mcpHealth,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      answer: "",
      suggestedActions: [],
      isError: true,
      reason: `Ollama 実行に失敗しました: ${reason}`,
      resolvedPlatform,
      platformsUsed,
      mcpServers: session.serverNames,
      matchedSite,
    };
  } finally {
    await session.close().catch(() => {/* 切断失敗は無視 */});
  }
}
