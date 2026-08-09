// ナレッジ(71)— MCP なしの claude CLI 呼び出し。
//
// 46 では extract.ts の中に閉じていたが、71 で重複判定(dedupe.ts)からも
// 同じ呼び方をするようになったので、共有の口として切り出した。挙動は 46 のまま。
//
// 抽出も重複判定も「既に手元にある文章を読み直すだけ」なので、
// reports/analyze.ts と同じ「MCP なしの claude CLI」で足りる
// (--strict-mcp-config + 空 config)。組み込みツールも塞ぐ。

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const AGENT_CWD = path.join(os.tmpdir(), "multi-network-dashboard-knowledge");
export const DEFAULT_MODEL =
  process.env.NETINV_MODEL || process.env.CORSTACK_NETINV_MODEL || "sonnet";
export const TIMEOUT_MS = Math.max(30_000, Number(process.env.KNOWLEDGE_LLM_TIMEOUT_MS ?? 180_000));

/** 外部ツールは要らない(判断材料はプロンプトに全部載っている)。組み込みツールも塞ぐ。 */
const DISALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "NotebookEdit",
];

export interface RunResult {
  text: string;
  isError: boolean;
  reason: string | null;
}

export async function runClaudePlain(
  prompt: string,
  systemPrompt: string,
  model: string,
): Promise<RunResult> {
  await mkdir(AGENT_CWD, { recursive: true });
  const args = [
    "--print",
    "--output-format",
    "json",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
    "--append-system-prompt",
    systemPrompt,
    "--model",
    model,
  ];

  return await new Promise<RunResult>((resolve) => {
    const child = spawn("claude", args, { cwd: AGENT_CWD, env: process.env });
    let out = "";
    let err = "";
    let settled = false;

    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ text: "", isError: true, reason: `claude timed out after ${TIMEOUT_MS}ms` });
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) =>
      done({ text: "", isError: true, reason: e instanceof Error ? e.message : String(e) }),
    );
    child.on("close", (code) => {
      let envelope: any = null;
      try {
        envelope = JSON.parse(out);
      } catch {
        /* パースできない場合は下でそのまま扱う */
      }
      if (code !== 0) {
        const detail =
          (envelope && typeof envelope.result === "string" && envelope.result.trim()) ||
          err.trim().slice(0, 300) ||
          "(stderr・result ともに情報なし)";
        done({ text: "", isError: true, reason: `claude exited ${code}: ${detail}` });
        return;
      }
      if (envelope && envelope.is_error === true) {
        done({
          text: typeof envelope.result === "string" ? envelope.result : "",
          isError: true,
          reason: `claude result is_error: ${envelope.api_error_status ?? envelope.subtype ?? "unknown"}`,
        });
        return;
      }
      const text = envelope && typeof envelope.result === "string" ? envelope.result : out;
      done({ text: text.trim(), isError: false, reason: null });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** 応答テキストから JSON オブジェクトを取り出す(reports/analyze.ts と同じ救済順)。 */
export function extractJsonObject(text: string): any | null {
  const src = (text || "").trim();
  if (!src) return null;
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(src))) candidates.push(m[1].trim());
  candidates.push(src);
  const first = src.indexOf("{");
  const last = src.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(src.slice(first, last + 1));
  for (const c of candidates) {
    if (!c) continue;
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* 次の候補へ */
    }
  }
  return null;
}
