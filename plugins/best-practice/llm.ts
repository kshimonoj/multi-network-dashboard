/**
 * LLM 所見(SEC-12 / SEC-13 / RF-15 / RF-16)。
 *
 * 機械判定では決められない「環境依存の判断」だけを LLM に投げる(49 §3-1 の 2)。
 * **合否は出さない**。status は "info" で、所見テキストだけを返す。
 *
 * 機微情報(49 §1-5(a) の 3):
 *   LLM に渡すのは `buildContext()` が組み立てた**正規化済みの構造体のみ**。
 *   生の running-config は collect-central.ts のスコープを出ておらず、
 *   ここに届く SsidProfileConfig 等には鍵・パスフレーズ・ハッシュ・RADIUS シークレットが
 *   そもそも入っていない。加えて `assertNoSecrets()` で送信直前に検査し、
 *   混入があれば LLM を起こさずに失敗させる(黙って送らない)。
 *
 * 実行は MCP を持たない軽い claude CLI 呼び出し(knowledge/extract.ts と同じ方式)。
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CentralSiteSnapshot, Finding, MistSiteSnapshot, SiteSnapshot } from "./types.js";

const AGENT_CWD = path.join(os.tmpdir(), "multi-network-dashboard-agent");
const TIMEOUT_MS = Number(process.env.BEST_PRACTICE_LLM_TIMEOUT_MS || 180_000);
const DEFAULT_MODEL = process.env.BEST_PRACTICE_LLM_MODEL || "sonnet";

const DISALLOWED_TOOLS = ["Bash", "Edit", "Write", "WebFetch", "WebSearch", "Task"];

export type LlmLang = "ja" | "en";

/** LLM 所見を出すルール */
export const LLM_RULE_IDS = ["SEC-12", "SEC-13", "RF-15", "RF-16"] as const;
export type LlmRuleId = (typeof LLM_RULE_IDS)[number];

// ── 機微情報の最終検査 ──────────────────────────────────────

/**
 * 送信直前の保険。構造体に鍵らしき値が紛れ込んでいないことを機械的に確かめる。
 * 「入れない設計にしてある」だけに頼らず、実際に送る文字列を見る。
 */
const SECRET_KEY_RE = /"(psk|passphrase|wpa[-_]?passphrase|wep[-_]?key|key|secret|password|hash|token|virtual[-_]?controller[-_]?key)"\s*:/i;
/** 32 文字以上の連続 hex(鍵・ハッシュの形) */
const HEXBLOB_RE = /\b[0-9a-f]{32,}\b/i;

export function assertNoSecrets(payload: string): void {
  if (SECRET_KEY_RE.test(payload)) {
    throw new Error("LLM へ渡す構造体に鍵らしきキーが含まれています(送信を中止しました)");
  }
  if (HEXBLOB_RE.test(payload)) {
    throw new Error("LLM へ渡す構造体に鍵らしき hex 文字列が含まれています(送信を中止しました)");
  }
}

// ── LLM に渡すコンテキスト ──────────────────────────────────

function centralContext(snap: CentralSiteSnapshot, mechanical: Finding[]) {
  return {
    platform: "central",
    site: { name: snap.siteName, apCount: snap.aps.length },
    aps: snap.aps.map((a) => ({
      model: a.model,
      firmware: a.firmware,
      generation: a.generation,
      status: a.status,
    })),
    radios: snap.radios.map((r) => ({
      band: r.band,
      bandwidthMhz: r.bandwidthMhz,
      channel: r.channel,
      powerDbm: r.powerDbm,
      status: r.status,
    })),
    ssids: snap.representatives.flatMap((rep) =>
      rep.ssids.map((s) => ({
        essid: s.essid ?? s.name,
        type: s.ssidType,
        opmode: s.opmode,
        enabled: s.enabled,
        bands: s.bands,
        // 認証サーバは「名前」だけ。IP・共有シークレットは構造体に存在しない
        authServers: s.authServers,
        usesPassphrase: s.hasPassphrase,
        mfpCapable: s.mfpCapable,
        mfpRequired: s.mfpRequired,
        opmodeTransition: s.opmodeTransition,
      })),
    ),
    radioProfiles: snap.representatives.flatMap((rep) =>
      rep.radioProfiles.map((r) => ({
        section: r.section,
        maxChannelBandwidthMhz: r.maxChannelBandwidthMhz,
        minChannelBandwidthMhz: r.minChannelBandwidthMhz,
        maxTxPower: r.maxTxPower,
        minTxPower: r.minTxPower,
        allowedChannels: r.allowedChannels,
      })),
    ),
    arm: snap.representatives.map((rep) => rep.arm).filter(Boolean),
    mechanicalFindings: mechanical
      .filter((f) => f.status === "fail" || f.status === "warn")
      .map((f) => ({ ruleId: f.ruleId, status: f.status, target: f.targetLabel, observed: f.observed })),
  };
}

function mistContext(snap: MistSiteSnapshot, mechanical: Finding[]) {
  return {
    platform: "mist",
    site: { name: snap.siteName, apCount: snap.aps.length },
    aps: snap.aps.map((a) => ({ model: a.model, version: a.version, status: a.status })),
    wlans: snap.wlans.map((w) => ({
      ssid: w.ssid,
      authType: w.authType,
      pairwise: w.pairwise,
      bands: w.bands,
      enabled: w.enabled,
      scope: w.scope,
      usesPsk: w.hasPsk,
    })),
    rfTemplate: snap.rfTemplate
      ? {
          name: snap.rfTemplate.name,
          countryCode: snap.rfTemplate.countryCode,
          band24Usage: snap.rfTemplate.band24Usage,
          hasModelSpecific: snap.rfTemplate.hasModelSpecific,
          bands: snap.rfTemplate.bands.map((b) => ({
            band: b.band,
            bandwidthMhz: b.bandwidthMhz,
            // null = 自動(RRM 任せ)。RF-16 はここが要点
            channels: b.channels,
            power: b.power,
            powerMin: b.powerMin,
            powerMax: b.powerMax,
            disabled: b.disabled,
          })),
        }
      : null,
    mechanicalFindings: mechanical
      .filter((f) => f.status === "fail" || f.status === "warn")
      .map((f) => ({ ruleId: f.ruleId, status: f.status, target: f.targetLabel, observed: f.observed })),
  };
}

export function buildContext(snap: SiteSnapshot, mechanical: Finding[]): string {
  const ctx = snap.platform === "central" ? centralContext(snap, mechanical) : mistContext(snap, mechanical);
  const payload = JSON.stringify(ctx, null, 2);
  assertNoSecrets(payload);
  return payload;
}

// ── プロンプト ──────────────────────────────────────────────

const SYSTEM: Record<LlmLang, string> = {
  ja:
    "あなたは無線 LAN の設計レビューを行うネットワークエンジニアです。" +
    "与えられた設定スナップショット(正規化済み JSON)だけを根拠に所見を書いてください。" +
    "推測で設定値を補わず、スナップショットに無い情報は「不明」と書くこと。" +
    "合否の判定は別途機械判定で行っているので、あなたは合否を出さず所見だけを述べること。" +
    "必ず指定された JSON オブジェクトだけを出力し、前後に説明文を付けないこと。",
  en:
    "You are a network engineer reviewing wireless LAN design. " +
    "Base your observations only on the given normalized configuration snapshot (JSON). " +
    "Do not invent configuration values; state 'unknown' for anything absent from the snapshot. " +
    "Pass/fail judgement is handled separately by mechanical rules — give observations only. " +
    "Output only the specified JSON object with no surrounding prose.",
};

const ASK: Record<LlmLang, Record<LlmRuleId, string>> = {
  ja: {
    "SEC-12":
      "認証・鍵配布構成の総合所見。認証サーバの冗長性、SSID の用途(ゲスト/IoT/従業員)と認証方式の整合、MPSK の使いどころについて述べる。",
    "SEC-13":
      "SSID 構成全体のセキュリティ姿勢。機械判定で挙がった問題のうちどれから直すべきかの優先順位と、機械判定に出ていない構成上の懸念を述べる。",
    "RF-15":
      "高密度環境における 2.4GHz の扱い。2.4GHz を使っている SSID・AP 台数から、この環境で 2.4GHz をクライアント用途に開けておくべきかを述べる。環境依存であることを明記する。",
    "RF-16":
      "静的なチャネル・電力割当と RRM(AirMatch / ARM / Mist RRM)運用の妥当性。実効チャネル・電力と設定レンジから、RRM に任せられているかを述べる。",
  },
  en: {
    "SEC-12":
      "Overall assessment of authentication and key distribution: auth server redundancy, whether each SSID's purpose (guest/IoT/employee) matches its auth method, and where MPSK fits.",
    "SEC-13":
      "Overall security posture of the SSID set: which mechanical findings to fix first, and structural concerns the mechanical rules do not cover.",
    "RF-15":
      "2.4 GHz handling in high-density environments: given the SSIDs using 2.4 GHz and the AP count, should 2.4 GHz stay open for client use here? State explicitly that this is environment-dependent.",
    "RF-16":
      "Validity of static channel/power assignment versus RRM (AirMatch / ARM / Mist RRM): from effective channels/power and configured ranges, is RRM being left to do its job?",
  },
};

export function buildPrompt(context: string, lang: LlmLang): string {
  const asks = LLM_RULE_IDS.map((id) => `- "${id}": ${ASK[lang][id]}`).join("\n");
  const header =
    lang === "ja"
      ? "以下は 1 サイト分の設定スナップショットです。4 つの観点それぞれについて所見を書いてください。"
      : "Below is a configuration snapshot for one site. Write an observation for each of the four topics.";
  const format =
    lang === "ja"
      ? '出力形式(この JSON オブジェクトだけを出力する。各値は日本語 3〜5 文の平文):\n{"SEC-12":"…","SEC-13":"…","RF-15":"…","RF-16":"…"}'
      : 'Output format (this JSON object only; each value is 3-5 plain sentences):\n{"SEC-12":"…","SEC-13":"…","RF-15":"…","RF-16":"…"}';

  return `${header}\n\n${asks}\n\n${format}\n\n<snapshot>\n${context}\n</snapshot>`;
}

// ── claude CLI(MCP なし)────────────────────────────────────

interface RunResult {
  text: string;
  isError: boolean;
  reason?: string;
}

async function runClaudePlain(prompt: string, systemPrompt: string, model: string): Promise<RunResult> {
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
    child.on("close", (codeNum) => {
      let envelope: any = null;
      try {
        envelope = JSON.parse(out);
      } catch {
        /* パースできない場合は下でそのまま扱う */
      }
      if (codeNum !== 0) {
        const detail =
          (envelope && typeof envelope.result === "string" && envelope.result.trim()) ||
          err.trim().slice(0, 300) ||
          "(stderr・result ともに情報なし)";
        done({ text: "", isError: true, reason: `claude exited ${codeNum}: ${detail}` });
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
      done({ text, isError: false });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** ```json フェンス等に包まれていても最初の JSON オブジェクトを取り出す */
export function extractJsonObject(text: string): any | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ── 入口 ────────────────────────────────────────────────────

export interface LlmOutcome {
  findings: Finding[];
  model: string;
  error: string | null;
}

/**
 * 4 件の LLM 所見をまとめて 1 回の呼び出しで生成する。
 * 失敗しても throw せず、4 件を status:"unknown" にして理由コードを返す
 * (機械判定の結果は生かしたまま保存する)。
 */
export async function runLlmFindings(
  snap: SiteSnapshot,
  mechanical: Finding[],
  opts: { model?: string | null; lang?: LlmLang; collectedAt: string },
): Promise<LlmOutcome> {
  const model = opts.model || DEFAULT_MODEL;
  const lang: LlmLang = opts.lang === "en" ? "en" : "ja";
  const collectedAt = opts.collectedAt;

  const base = (ruleId: string, status: Finding["status"], messageCode: string, note?: string): Finding => ({
    ruleId,
    status,
    platform: snap.platform,
    targetType: "site",
    targetId: snap.siteId,
    targetLabel: snap.siteName,
    siteId: snap.siteId,
    observed: {},
    messageCode,
    messageParams: {},
    collectedAt,
    ...(note ? { note } : {}),
  });

  const fail = (reason: string): LlmOutcome => ({
    findings: LLM_RULE_IDS.map((id) =>
      base(id, "unknown", `bestPractice.findings.${id}.llmFailed`),
    ),
    model,
    error: reason,
  });

  let context: string;
  try {
    context = buildContext(snap, mechanical);
  } catch (err) {
    // 機微情報の検査に引っかかった。LLM は起こさない
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[best-practice] LLM 所見を中止しました: ${reason}`);
    return fail(reason);
  }

  const res = await runClaudePlain(buildPrompt(context, lang), SYSTEM[lang], model);
  if (res.isError) return fail(res.reason ?? "claude の実行に失敗しました");

  const parsed = extractJsonObject(res.text);
  if (!parsed) {
    return fail(`応答を JSON として解釈できませんでした(先頭 200 文字: ${res.text.slice(0, 200)})`);
  }

  const findings = LLM_RULE_IDS.map((id) => {
    const note = typeof parsed[id] === "string" ? parsed[id].trim() : "";
    if (!note) return base(id, "unknown", `bestPractice.findings.${id}.llmEmpty`);
    // 所見本文は**実行時の記録**なので翻訳しない(CLAUDE.md「サーバ生成の文言」の項)
    return base(id, "info", `bestPractice.findings.${id}.note`, note.slice(0, 2000));
  });

  return { findings, model, error: null };
}
