// Coach(65)— claude CLI(MCP なし)の実行。
//
// **Coach は MCP を繋がない**(64_findings.md §2-1(b))。理由 3 つ:
//   1. 役割の分離。「今うちの AP はどうなってる?」は Coach の仕事ではなく調査タブの仕事。
//      Coach が現在の状態を語れるようにすると、junior は調査タブを覚えなくなる。
//   2. 速度。実測した調査 1 件の durationMs は 113,636ms(約 113 秒)。対話に成立しない。
//   3. 教材の再現性。ライブデータが混ざると「昨日と今日で言うことが違うコーチ」になる。
//
// 呼び出しの形は knowledge/extract.ts / best-practice/llm.ts と同じ。2 プラグインで
// 実績のあるパターンをそのまま踏襲する。

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const AGENT_CWD = path.join(os.tmpdir(), "multi-network-dashboard-agent");

/**
 * 壁打ちは対話なので、抽出・所見生成(180 秒)より短くする。
 * MCP を持たないぶん応答は速いはずで、待たされ続けるより失敗が見えた方がよい。
 */
const TIMEOUT_MS = Number(process.env.COACH_TIMEOUT_MS || 90_000);

const DISALLOWED_TOOLS = ["Bash", "Edit", "Write", "WebFetch", "WebSearch", "Task"];

export function defaultModel(): string {
  return process.env.COACH_MODEL || process.env.NETINV_MODEL || "sonnet";
}

export interface RunResult {
  text: string;
  isError: boolean;
  /** 失敗理由。**実行時の記録なので翻訳しない**(CLAUDE.md)。 */
  reason: string | null;
  durationMs: number;
  model: string;
}

export async function runCoachAgent(
  prompt: string,
  systemPrompt: string,
  model: string,
): Promise<RunResult> {
  const startedAt = Date.now();
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

    const done = (r: Omit<RunResult, "durationMs" | "model">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, durationMs: Date.now() - startedAt, model });
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
      let envelope: { result?: unknown; is_error?: boolean; api_error_status?: unknown; subtype?: unknown } | null =
        null;
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
