// ナレッジ(46 Task 1)— 調査結果から知見候補を抽出する。
//
// ---- 位置づけ ----
// 調査そのもの(Insight Agent)は MCP を繋いでライブ情報を取りに行く重い処理だが、
// こちらは **既に出ている回答本文を読み直すだけ** なので、
// reports/analyze.ts と同じ「MCP なしの claude CLI」で足りる(--strict-mcp-config + 空 config)。
// 外部ツールも塞ぐ。1 調査あたり 1 回の呼び出しで終わる。
//
// ---- 発火条件(ノイズとコストを絞る)----
//  1. 設定が有効(settings.enabled)。
//  2. 調査の実行経路が対象に入っている(settings.sources)。
//     既定は manual + auto。scheduled(定期実行)は毎日同じ観点の定点観測で、
//     同じ知見が毎日出て承認待ちが埋まるため既定では対象外。
//  3. 失敗した調査(isError)からは抽出しない。
//  4. 回答本文が settings.minAnswerChars(既定 200 文字)未満なら抽出しない。
//     「データが取れませんでした」で終わった調査を弾く安いフィルタ。
//  5. 同じ runId からは一度だけ(store の抽出済み記録)。
//  6. 「明確な原因が特定できた調査か」の最終判断は LLM に委ねる。
//     原因が特定できていない / 単なる状態報告で終わっている調査では
//     candidates を空配列で返すようプロンプトで明示している。
//  7. claude CLI は同時に 1 本だけ(直列キュー)。調査本体と食い合わせない。
//
// ---- 言語 ----
// 候補の本文は「実行時の記録」なので後から翻訳しない(CLAUDE.md の方針)。
// 元調査の回答言語(query-history.jsonl の lang。旧履歴には無いので既定 ja)で書かせ、
// entry.lang に残す。画面のラベルだけが表示言語に追従する。

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findSimilar } from "./similarity.js";
import {
  addEntries,
  getSettings,
  isExtracted,
  listByStatus,
  markExtracted,
  pushLog,
} from "./store.js";
import type {
  ExtractionLogEntry,
  KnowledgeEntry,
  KnowledgePlatform,
  KnowledgeScope,
  KnowledgeSource,
  RawCandidate,
} from "./types.js";

const AGENT_CWD = path.join(os.tmpdir(), "multi-network-dashboard-knowledge");
const DEFAULT_MODEL = process.env.NETINV_MODEL || process.env.CORSTACK_NETINV_MODEL || "sonnet";
const TIMEOUT_MS = Math.max(30_000, Number(process.env.KNOWLEDGE_LLM_TIMEOUT_MS ?? 180_000));

/** 抽出に外部ツールは要らない(調査結果はプロンプトに全部載っている)。組み込みツールも塞ぐ。 */
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

export type ExtractLang = "ja" | "en";

/** 抽出の入力(query-history.jsonl のレコードから必要な項目だけを写したもの)。 */
export interface InvestigationInput {
  runId: string;
  sessionId: string;
  origin: "manual" | "scheduled" | "auto";
  ts: string;
  query: string;
  site: string | null;
  answer: string;
  isError: boolean;
  platformsUsed: string[];
  lang: ExtractLang;
}

// ---- プロンプト ----

const OUTPUT_SCHEMA = `{
  "candidates": [
    {
      "title": "一行の見出し(何の問題か)",
      "symptom": "どんな状況で当てはまるか(次に同じ状況に出会った人が「これだ」と気付ける粒度)",
      "rootCause": "根本原因",
      "action": "対処法 / 次に取るべきアクション",
      "scope": "general | site | device",
      "tags": ["短いタグ", "最大 5 個"],
      "platform": "central | mist | both | null",
      "site": "サイト名 または null",
      "device": "対象機器名/シリアル/MAC または null"
    }
  ]
}`;

const SYSTEM_PROMPT: Record<ExtractLang, string> = {
  ja:
    "あなたは HPE Aruba Networking Central / Juniper Mist を運用しているネットワークチームのナレッジ管理者。\n" +
    "1 件のネットワーク調査(クエリと、その回答本文)を読み、**今後の調査に役立つ知見**だけを抜き出して JSON にする。\n" +
    "\n" +
    "【厳守】\n" +
    "- 出力は JSON オブジェクト 1 個のみ。前置き・後書き・コードフェンス(```)・説明文を一切付けない。\n" +
    "- 入力に無い事実を作らない。機器名・サイト名・数値は入力に現れた値をそのまま使う。\n" +
    "- 外部ツールは使わない(調査結果はすべて入力に含まれている)。\n" +
    "- 文章は日本語で書く。JSON のキー名と列挙値(general / site / device / central / mist / both)は英語のまま変えない。\n" +
    "\n" +
    "【候補を作らない場合】\n" +
    "次のいずれかに当てはまるなら、必ず {\"candidates\": []} を返す。無理に知見をひねり出さない。\n" +
    "- 原因が特定できていない(データ不足・調査が途中で終わっている)。\n" +
    "- 単なる現況報告(「全サイト正常」「アラートなし」等)で、次に活かせる因果関係が無い。\n" +
    "- その場限りの一過性の事象で、同じ状況が再び起きても参考にならない。\n" +
    "\n" +
    "【候補を作る場合】\n" +
    "- 最大 {MAX} 件。1 件 = 1 つの因果関係。複数の話題を 1 件に混ぜない。\n" +
    "- symptom は「どんな症状・状況で当てはまるか」を書く。調査そのものの経緯ではない。\n" +
    "- rootCause は回答本文が根拠を示している範囲で書く。断定できない場合は推定であることが分かる書き方にする。\n" +
    "- action は次に同じ状況に出会った人が取れる具体的な行動にする。\n" +
    "- scope は適用範囲: general(機種・サイトによらず当てはまる)/ site(特定サイトの構成に紐づく)/\n" +
    "  device(特定の機器 1 台または型番固有)。\n" +
    "- tags は検索・絞り込み用の短い語(例: rogue-ap, offline, dhcp, roaming)。半角小文字英数とハイフンを推奨。\n" +
    "\n" +
    "出力する JSON の形:\n" +
    OUTPUT_SCHEMA,
  en:
    "You are the knowledge curator for a network operations team running HPE Aruba Networking Central and Juniper Mist.\n" +
    "Read one network investigation (the query and its answer) and extract only the insights that will help future investigations, as JSON.\n" +
    "\n" +
    "[Strict rules]\n" +
    "- Output exactly one JSON object. No preamble, no trailing prose, no code fences, no explanation.\n" +
    "- Never invent facts that are not in the input. Reuse device names, site names and numbers exactly as they appear.\n" +
    "- Do not use external tools (the whole investigation is in the input).\n" +
    "- Write the prose in English. Keep JSON keys and enum values (general / site / device / central / mist / both) in English as-is.\n" +
    "\n" +
    "[When to produce nothing]\n" +
    'Return {"candidates": []} — do not manufacture insight — if any of the following holds:\n' +
    "- The root cause was not identified (not enough data, or the investigation stopped halfway).\n" +
    "- It is a plain status report (\"all sites healthy\", \"no alerts\") with no reusable cause-and-effect.\n" +
    "- It is a one-off event that would not help anyone meeting the same situation again.\n" +
    "\n" +
    "[When you do produce candidates]\n" +
    "- At most {MAX}. One candidate = one cause-and-effect. Never merge several topics into one.\n" +
    "- `symptom` describes the situation in which this entry applies, not the story of the investigation.\n" +
    "- `rootCause` must stay within what the answer actually supports; phrase it as a hypothesis when it is one.\n" +
    "- `action` must be something concrete the next person can do.\n" +
    "- `scope`: general (independent of site and model) / site (tied to one site's setup) / device (one device or model).\n" +
    "- `tags`: short search keys (e.g. rogue-ap, offline, dhcp, roaming). Prefer lowercase ASCII with hyphens.\n" +
    "\n" +
    "Shape of the JSON to output:\n" +
    OUTPUT_SCHEMA,
};

const RETRY_SUFFIX: Record<ExtractLang, string> = {
  ja: "\n\n前回の応答は JSON として解釈できなかった。今回は JSON オブジェクト 1 個だけを、余計な文字を一切付けずに出力すること。",
  en: "\n\nThe previous response could not be parsed as JSON. This time output exactly one JSON object and nothing else.",
};

/** 回答本文が長すぎるとプロンプトが膨らむので上限を切る(調査回答は通常 1〜3KB)。 */
const ANSWER_MAX = 12_000;

export function buildPrompt(input: InvestigationInput, lang: ExtractLang): string {
  const payload = {
    investigatedAt: input.ts,
    origin: input.origin,
    site: input.site,
    platformsUsed: input.platformsUsed,
    query: input.query,
    answer: input.answer.slice(0, ANSWER_MAX),
  };
  const head =
    lang === "ja"
      ? "以下は 1 件のネットワーク調査の記録です。これだけを根拠に知見候補の JSON を出力してください。\n\n"
      : "Below is the record of one network investigation. Produce the candidate JSON based only on this.\n\n";
  return head + JSON.stringify(payload, null, 1);
}

// ---- claude CLI(MCP なし)。reports/analyze.ts と同じ形 ----

interface RunResult {
  text: string;
  isError: boolean;
  reason: string | null;
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

// ---- 応答のパースと正規化 ----

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

function str(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

function strOrNull(v: unknown, max: number): string | null {
  const s = str(v, max);
  if (!s) return null;
  // モデルが "null" / "不明" を文字列で返してくることがあるので落とす。
  const low = s.toLowerCase();
  if (low === "null" || low === "none" || low === "unknown" || s === "不明") return null;
  return s;
}

function scopeOf(v: unknown): KnowledgeScope {
  const s = String(v ?? "").toLowerCase();
  if (s === "site" || s === "site-specific") return "site";
  if (s === "device" || s === "device-specific") return "device";
  return "general";
}

function platformOf(v: unknown, fallback: string[]): KnowledgePlatform {
  const s = String(v ?? "").toLowerCase();
  if (s === "central" || s === "mist" || s === "both") return s as KnowledgePlatform;
  // モデルが埋めてこなかった場合は、その調査が実際に使ったプラットフォームから決める。
  const used = new Set(fallback.map((p) => String(p).toLowerCase()));
  if (used.has("central") && used.has("mist")) return "both";
  if (used.has("central")) return "central";
  if (used.has("mist")) return "mist";
  return null;
}

export function normalizeTags(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : [];
  const out: string[] = [];
  for (const t of raw) {
    const s = String(t ?? "")
      .trim()
      .normalize("NFKC")
      .replace(/^[#\s]+/, "")
      .slice(0, 24);
    if (!s) continue;
    // 半角英数のタグだけ小文字に揃える(日本語タグはそのまま)。
    const key = /^[A-Za-z0-9._-]+$/.test(s) ? s.toLowerCase() : s;
    if (!out.includes(key)) out.push(key);
    if (out.length >= 5) break;
  }
  return out;
}

/** LLM の生 JSON 1 件 → 保存する候補(status="pending")。中身が薄いものは null。 */
export function normalizeCandidate(
  raw: RawCandidate,
  input: InvestigationInput,
  now: string,
): KnowledgeEntry | null {
  const title = str(raw.title, 160);
  const symptom = str(raw.symptom, 800);
  const rootCause = str(raw.rootCause, 800);
  const action = str(raw.action, 800);
  // タイトルと、症状/原因/対処のどれかが埋まっていないものは候補として成立しない。
  if (!title || (!symptom && !rootCause && !action)) return null;

  const source: KnowledgeSource = {
    runId: input.runId,
    sessionId: input.sessionId,
    origin: input.origin,
    query: input.query,
    at: input.ts,
    extractedAt: now,
  };

  return {
    id: randomUUID(),
    status: "pending",
    title,
    symptom,
    rootCause,
    action,
    scope: scopeOf(raw.scope),
    tags: normalizeTags(raw.tags),
    platform: platformOf(raw.platform, input.platformsUsed),
    site: strOrNull(raw.site, 120) ?? input.site,
    device: strOrNull(raw.device, 160),
    lang: input.lang,
    sources: [source],
    createdAt: now,
    updatedAt: now,
    approvedAt: null,
    rejectedAt: null,
    edited: false,
    // 47: 調査プロンプトへの注入実績。承認されて初めて注入対象になるので、生成時は 0 / 未参照。
    refCount: 0,
    lastReferencedAt: null,
    similar: [],
    mergedInto: null,
    mergedFrom: [],
  };
}

// ---- 直列キュー(claude CLI を同時に何本も起こさない)----

let queue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch((err) => {
    console.error("[knowledge] 抽出キューでエラー:", err);
  });
}

// ---- 入口 ----

export interface ExtractOutcome {
  runId: string;
  status: ExtractionLogEntry["status"];
  created: KnowledgeEntry[];
  duplicatePending: number;
  similarApproved: number;
  reasonCode: string | null;
  reasonDetail: string | null;
}

/**
 * 抽出にかける価値がある調査か(LLM を起こす前の安いフィルタ)。
 * 「明確な原因が特定できたか」の判断は LLM 側(プロンプト)に任せる。
 */
export function preCheck(input: InvestigationInput, force: boolean): { ok: boolean; code: string | null } {
  const settings = getSettings();
  if (!force) {
    if (!settings.enabled) return { ok: false, code: "disabled" };
    if (!settings.sources[input.origin]) return { ok: false, code: "sourceExcluded" };
  }
  if (input.isError) return { ok: false, code: "investigationError" };
  if ((input.answer ?? "").trim().length < settings.minAnswerChars) {
    return { ok: false, code: "answerTooShort" };
  }
  if (!force && isExtracted(input.runId)) return { ok: false, code: "alreadyExtracted" };
  return { ok: true, code: null };
}

/**
 * 1 件の調査から候補を抽出して保存する(LLM 呼び出しを含むので数十秒かかる)。
 * 失敗しても throw しない。ログに残して呼び出し側へ結果を返す。
 */
export async function extractFromInvestigation(
  input: InvestigationInput,
  opts: { force?: boolean } = {},
): Promise<ExtractOutcome> {
  const startedAt = Date.now();
  const settings = getSettings();
  const model = settings.model || DEFAULT_MODEL;
  const outcome: ExtractOutcome = {
    runId: input.runId,
    status: "skipped",
    created: [],
    duplicatePending: 0,
    similarApproved: 0,
    reasonCode: null,
    reasonDetail: null,
  };

  const pre = preCheck(input, opts.force === true);
  if (!pre.ok) {
    outcome.reasonCode = pre.code;
    pushLog(toLog(input, outcome, Date.now() - startedAt, null));
    return outcome;
  }

  // 実行前に「抽出済み」を立てる。実行中に別の経路から同じ runId が来ても二重に起こさない
  // (Webhook / レポートの自動事前調査と同じ順序)。
  await markExtracted(input.runId);

  const lang: ExtractLang = input.lang === "en" ? "en" : "ja";
  const prompt = buildPrompt(input, lang);
  const maxPerRun = settings.maxPerRun;

  let parsed: any = null;
  let lastReason: string | null = null;
  // JSON として読めなかったときだけ 1 回だけ言い直させる(2 回目で駄目なら諦める)。
  for (let i = 0; i < 2; i += 1) {
    const system =
      SYSTEM_PROMPT[lang].replace("{MAX}", String(maxPerRun)) + (i > 0 ? RETRY_SUFFIX[lang] : "");
    const res = await runClaudePlain(prompt, system, model);
    if (res.isError) {
      lastReason = res.reason ?? "claude の実行に失敗しました";
      break; // 実行そのものの失敗はリトライしない(認証切れ等でコストを重ねない)
    }
    parsed = extractJsonObject(res.text);
    if (parsed) break;
    lastReason = `応答を JSON として解釈できませんでした(先頭 200 文字: ${res.text.slice(0, 200)})`;
  }

  if (!parsed) {
    outcome.status = "error";
    outcome.reasonCode = "llmFailed";
    outcome.reasonDetail = lastReason;
    pushLog(toLog(input, outcome, Date.now() - startedAt, model));
    console.error(`[knowledge] 抽出に失敗: runId=${input.runId} reason=${lastReason?.slice(0, 200)}`);
    return outcome;
  }

  const now = new Date().toISOString();
  const rawList: RawCandidate[] = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  const normalized = rawList
    .filter((c) => c && typeof c === "object")
    .map((c) => normalizeCandidate(c, input, now))
    .filter((c): c is KnowledgeEntry => c !== null)
    .slice(0, maxPerRun);

  if (normalized.length === 0) {
    outcome.status = "empty";
    outcome.reasonCode = "noInsight";
    pushLog(toLog(input, outcome, Date.now() - startedAt, model));
    console.log(`[knowledge] 知見なしと判定: runId=${input.runId}`);
    return outcome;
  }

  // ---- 重複検出(Task 2)----
  // 未承認の候補と重複するものは **作らない**(承認待ちが同じ内容で埋まるのを防ぐ)。
  // 承認済みと類似するものは作り、マージ提案(similar)として承認画面に出す。
  const threshold = settings.similarityThreshold;
  const pendingPool = listByStatus("pending");
  const approvedPool = listByStatus("approved");
  const keep: KnowledgeEntry[] = [];

  for (const cand of normalized) {
    const dupPending = findSimilar(cand, [...pendingPool, ...keep], threshold, 1);
    if (dupPending.length > 0) {
      outcome.duplicatePending += 1;
      console.log(
        `[knowledge] 未承認の候補と重複するため見送り: "${cand.title.slice(0, 40)}" ` +
          `(既存 "${dupPending[0].entry.title.slice(0, 40)}" と ${dupPending[0].score})`,
      );
      continue;
    }
    const similar = findSimilar(cand, approvedPool, threshold, 3);
    if (similar.length > 0) {
      cand.similar = similar.map((h) => ({ id: h.entry.id, score: h.score, title: h.entry.title }));
      outcome.similarApproved += 1;
    }
    keep.push(cand);
  }

  await addEntries(keep);
  outcome.created = keep;
  outcome.status = keep.length > 0 ? "created" : "empty";
  if (keep.length === 0) outcome.reasonCode = "allDuplicates";
  pushLog(toLog(input, outcome, Date.now() - startedAt, model));
  console.log(
    `[knowledge] 候補を ${keep.length} 件作成: runId=${input.runId} origin=${input.origin}` +
      (outcome.duplicatePending ? ` / 重複で見送り ${outcome.duplicatePending} 件` : "") +
      (outcome.similarApproved ? ` / マージ提案 ${outcome.similarApproved} 件` : ""),
  );
  return outcome;
}

function toLog(
  input: InvestigationInput,
  outcome: ExtractOutcome,
  durationMs: number,
  model: string | null,
): ExtractionLogEntry {
  return {
    runId: input.runId,
    at: new Date().toISOString(),
    origin: input.origin,
    status: outcome.status,
    created: outcome.created.length,
    duplicatePending: outcome.duplicatePending,
    similarApproved: outcome.similarApproved,
    reasonCode: outcome.reasonCode,
    reasonDetail: outcome.reasonDetail,
    durationMs,
    model,
  };
}

/**
 * 調査完了フック(network-investigation/api.ts が呼ぶ)から使う入口。
 * 抽出は直列キューでバックグラウンド実行するので、この関数はすぐ返る。
 */
export function scheduleExtraction(input: InvestigationInput): void {
  // 安いフィルタはキューに積む前に見る(定期実行の分でキューを詰まらせない)。
  const pre = preCheck(input, false);
  if (!pre.ok) {
    pushLog(
      toLog(
        input,
        { ...emptyOutcome(input.runId), reasonCode: pre.code },
        0,
        null,
      ),
    );
    return;
  }
  enqueue(async () => {
    await extractFromInvestigation(input);
  });
}

function emptyOutcome(runId: string): ExtractOutcome {
  return {
    runId,
    status: "skipped",
    created: [],
    duplicatePending: 0,
    similarApproved: 0,
    reasonCode: null,
    reasonDetail: null,
  };
}
