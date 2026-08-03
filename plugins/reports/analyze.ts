// 日次レポート(41 Task 2)— 1 日分のデータを LLM に渡して「起きたこと」「問題」を作る。
//
// ---- 既存の自動事前調査(webhook-feed/enrich.ts)との違い ----
// enrich.ts は「重大アラート 1 件」を自然文クエリにして Insight Agent に渡し、
// MCP ツールで **その場のライブ情報を取りに行かせる**。
// こちらは「1 日分のデータ全体」が既に手元にあるので、
//   - MCP を一切繋がない(--strict-mcp-config + 空 config)。外部ツールも禁止する。
//   - 出力は散文ではなく **JSON**。表(42 番)と再集計(43 番)に直接使える形にする。
// という別設計にしてある。ライブ取得をさせないので、実行時間もコストも 1 回ぶんで収まる。
//
// ---- 言語まわり(CLAUDE.md の i18n 方針)----
//  - モデル出力を自然言語でパースしない。パースするのは JSON の構造だけで、
//    キー名は日英どちらのプロンプトでも同じ(言語非依存)。
//  - 生成された分析文は「実行時の記録」なので後から翻訳しない。生成時の言語を report.lang に残す。
//
// ---- 再発性の判定 ----
// LLM には過去 N 日ぶんの問題一覧(日付 + key + 名前 + 対象機器)を渡して所見を書かせるが、
// **previousDates はサーバ側で機械的に突き合わせて上書きする**。
// 「過去に同じ問題があったか」は照合で確定できる事実で、モデルの記憶に委ねる必要が無いため。

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { mkdir } from "node:fs/promises";
import type {
  DailyAnalysis,
  DailyHighlight,
  DailyIssue,
  DailyRawSummary,
  IssueSeverity,
  RecurrenceStatus,
  ReportPlatform,
} from "./types.js";
import { addDays } from "./time.js";

const AGENT_CWD = path.join(os.tmpdir(), "multi-network-dashboard-reports");
const DEFAULT_MODEL = process.env.NETINV_MODEL || process.env.CORSTACK_NETINV_MODEL || "sonnet";
const TIMEOUT_MS = Math.max(60_000, Number(process.env.REPORTS_LLM_TIMEOUT_MS ?? 300_000));

/** 分析に外部ツールは要らない(データはプロンプトに全部載っている)。組み込みツールも塞ぐ。 */
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

export type AnalyzeLang = "ja" | "en";

export interface PastIssue {
  date: string;
  key: string;
  name: string;
  device: string | null;
  site: string | null;
  severity: string;
}

// ---- プロンプト ----

const OUTPUT_SCHEMA = `{
  "summary": "その日の総括(1〜2 文)",
  "highlights": [
    {
      "at": "ISO8601 または null",
      "device": "対象機器名/シリアル/MAC。特定できなければ null",
      "site": "サイト名。無ければ null",
      "platform": "central | mist | glp | other | null",
      "severity": "critical | warning | info",
      "title": "一行の見出し",
      "detail": "何が起きたか(1〜2 文)",
      "source": "webhook | streaming | overview | investigation"
    }
  ],
  "issues": [
    {
      "key": "日をまたいで同じ問題を指す安定キー。半角小文字英数とハイフン/コロンのみ。例 ap-offline:ap-1f-north",
      "name": "問題名",
      "device": "対象機器 または null",
      "site": "サイト名 または null",
      "platform": "central | mist | glp | other | null",
      "severity": "critical | warning | info",
      "firstSeenAt": "当日の初回発生日時(ISO8601)または null",
      "occurrences": 当日の発生件数(整数),
      "rootCause": "根本原因の見立て",
      "impact": "影響範囲",
      "nextAction": "次のアクション",
      "recurrenceNote": "再発性についての所見"
    }
  ]
}`;

const SYSTEM_PROMPT: Record<AnalyzeLang, string> = {
  ja:
    "あなたは HPE Aruba Networking Central / Juniper Mist を監視しているネットワーク運用チームのアナリスト。\n" +
    "入力として与えられる「ある 1 日ぶんの監視データ(JSON)」だけを根拠に、日次レポートの分析部分を作る。\n" +
    "\n" +
    "【厳守】\n" +
    "- 出力は JSON オブジェクト 1 個のみ。前置き・後書き・コードフェンス(```)・説明文を一切付けない。\n" +
    "- 入力に無い事実を作らない。機器名・時刻・件数は入力に現れた値をそのまま使う。\n" +
    "- 推測を書く場合は rootCause / nextAction の中に限り、断定しない書き方にする。\n" +
    "- 外部ツールは使わない(データはすべて入力に含まれている)。\n" +
    "- 文章は日本語で書く。JSON のキー名と列挙値(critical / warning / info など)は英語のまま変えない。\n" +
    "\n" +
    "【highlights(この期間に起きたこと)】\n" +
    "- 3〜8 件。重要度の高いもの・運用者が知るべきものを優先する。\n" +
    "- 「対象機器・発生日時・内容」が分かる粒度で書く。単なる件数の羅列にしない。\n" +
    "- 何も起きていない静かな日なら、その旨を 1〜3 件に絞って書く(無理に 8 件作らない)。\n" +
    "\n" +
    "【issues(検出された問題)】\n" +
    "- 表に並べる前提。0〜10 件。重複する事象は 1 件にまとめ、occurrences に件数を入れる。\n" +
    "- key は日をまたいで同じ問題を指せる安定した値にする。同じ機器の同じ事象なら、\n" +
    "  過去の問題一覧(pastIssues)に同じ key があればそれと **完全に同じ文字列** を使う。\n" +
    "- 問題が無い日は issues を空配列にする。無理に問題をひねり出さない。\n" +
    "\n" +
    "出力する JSON の形:\n" +
    OUTPUT_SCHEMA,
  en:
    "You are an analyst on the network operations team monitoring HPE Aruba Networking Central and Juniper Mist.\n" +
    "Produce the analysis section of a daily report, based only on the single day of monitoring data (JSON) given as input.\n" +
    "\n" +
    "[Strict rules]\n" +
    "- Output exactly one JSON object. No preamble, no trailing prose, no code fences, no explanation.\n" +
    "- Never invent facts that are not in the input. Reuse device names, timestamps and counts exactly as they appear.\n" +
    "- Any speculation must stay inside rootCause / nextAction and must be phrased as a hypothesis.\n" +
    "- Do not use external tools (all data is in the input).\n" +
    "- Write the prose in English. Keep JSON keys and enum values (critical / warning / info, …) in English as-is.\n" +
    "\n" +
    "[highlights — what happened during the period]\n" +
    "- 3 to 8 entries, most important first.\n" +
    "- Each must make the affected device, the time and what happened clear. Do not just restate counts.\n" +
    "- On a quiet day, write 1 to 3 entries saying so rather than padding to 8.\n" +
    "\n" +
    "[issues — problems detected]\n" +
    "- Meant to be rendered as a table. 0 to 10 entries. Merge duplicates and put the count in occurrences.\n" +
    "- `key` must be stable across days. If the same problem on the same device already appears in pastIssues,\n" +
    "  reuse that exact same key string.\n" +
    "- If there is no problem, return an empty issues array. Do not manufacture problems.\n" +
    "\n" +
    "Shape of the JSON to output:\n" +
    OUTPUT_SCHEMA,
};

const RETRY_SUFFIX: Record<AnalyzeLang, string> = {
  ja: "\n\n前回の応答は JSON として解釈できなかった。今回は JSON オブジェクト 1 個だけを、余計な文字を一切付けずに出力すること。",
  en: "\n\nThe previous response could not be parsed as JSON. This time output exactly one JSON object and nothing else.",
};

/**
 * プロンプトに載せるデータ。レポート本体(data)から、
 * モデルが読んでも意味の薄い / 量が膨らむ部分を落として整える。
 */
function buildPromptPayload(dateKey: string, data: DailyRawSummary, past: PastIssue[]) {
  return {
    date: dateKey,
    overview: {
      source: data.overview.source,
      sampleCount: data.overview.sampleCount,
      totals: data.overview.totals,
      trafficUnavailableReason: data.overview.traffic.reason,
      notes: data.overview.notes,
      // 全サイトを渡す(22 サイト程度)。指標別 SLE は総合スコアで足りるので落とす。
      sites: data.overview.sites.map((s) => ({
        site: s.siteName,
        platform: s.platform,
        centralHealthAvg: s.centralHealth?.avg ?? null,
        centralHealthMin: s.centralHealth?.min ?? null,
        mistSleAvg: s.mistSle?.avg ?? null,
        mistSleMin: s.mistSle?.min ?? null,
        clientsAvg: s.clients.avg,
        clientsPeak: s.clients.max,
        devicesTotal: s.devices.total,
        devicesDownMax: s.devices.downMax,
        alertsMax: s.alerts.max,
        criticalAlertsMax: s.alerts.criticalMax,
      })),
    },
    webhook: {
      available: data.webhook.available,
      // 42: 集計の出どころ(archive = 日別保存 / memory = 旧方式の表示キャッシュ)と、
      // その日が途中からしか記録されていない場合の注記。件数の読み方が変わるので必ず渡す。
      source: data.webhook.source ?? null,
      partial: data.webhook.partial ?? false,
      note: data.webhook.reason,
      total: data.webhook.total,
      bySeverity: data.webhook.bySeverity,
      bySource: data.webhook.bySource,
      byType: data.webhook.byType,
      criticalAlerts: data.webhook.critical,
      warningAlerts: data.webhook.warning,
      truncated: data.webhook.truncated,
    },
    streamingAuditTrail: {
      available: data.streaming.available,
      total: data.streaming.auditTrail.total,
      events: data.streaming.auditTrail.items,
      truncated: data.streaming.auditTrail.truncated,
    },
    investigations: {
      total: data.investigations.total,
      bySource: data.investigations.bySource,
      errors: data.investigations.errors,
      queries: data.investigations.items.map((i) => ({
        at: i.at,
        query: i.query,
        site: i.site,
        source: i.source,
        isError: i.isError,
      })),
      repeatedQueries: data.investigations.repeated,
    },
    pastIssues: past,
  };
}

function buildPrompt(dateKey: string, data: DailyRawSummary, past: PastIssue[], lang: AnalyzeLang): string {
  const payload = JSON.stringify(buildPromptPayload(dateKey, data, past), null, 1);
  const head =
    lang === "ja"
      ? `対象日: ${dateKey}(ローカル時刻の 0:00〜24:00)\n以下がその日の監視データです。これだけを根拠に分析 JSON を出力してください。\n\n`
      : `Target day: ${dateKey} (00:00–24:00 local time)\nBelow is that day's monitoring data. Produce the analysis JSON based only on this.\n\n`;
  const tail =
    lang === "ja"
      ? "\n\npastIssues は過去の日次レポートで検出済みの問題一覧です。同じ問題が再び起きている場合は同じ key を使い、recurrenceNote にその旨を書いてください。"
      : "\n\n`pastIssues` lists problems already detected in earlier daily reports. If the same problem recurs, reuse its key and say so in recurrenceNote.";
  return head + payload + tail;
}

// ---- claude CLI(MCP なし)----

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
    // MCP は 1 つも繋がない。--strict-mcp-config を付けることで ~/.claude.json 側の定義も無視される。
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
    child.on("error", (e) => done({ text: "", isError: true, reason: e instanceof Error ? e.message : String(e) }));
    child.on("close", (code) => {
      // --output-format json は {type:"result", result:"...", is_error:bool, ...} を 1 個返す。
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

/** 応答テキストから JSON オブジェクトを取り出す(コードフェンス・前後の地の文に耐える)。 */
export function extractJsonObject(text: string): any | null {
  const src = (text || "").trim();
  if (!src) return null;

  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(src))) candidates.push(m[1].trim());
  candidates.push(src);
  // 最初の { から最後の } まで(地の文が前後に付いた場合の救済)。
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

function str(v: unknown, max = 600): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

function strOrNull(v: unknown, max = 200): string | null {
  const s = str(v, max);
  return s ? s : null;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function severityOf(v: unknown): IssueSeverity {
  const s = String(v ?? "").toLowerCase();
  if (s === "critical" || s === "major" || s === "fatal") return "critical";
  if (s === "warning" || s === "warn" || s === "minor") return "warning";
  return "info";
}

function platformOf(v: unknown): ReportPlatform | null {
  const s = String(v ?? "").toLowerCase();
  if (s === "central" || s === "mist" || s === "glp" || s === "other") return s;
  return null;
}

/** key を安定な形に正規化する(日をまたいだ突き合わせに使うので、揺れを潰す)。 */
export function normalizeIssueKey(v: unknown, fallback: string): string {
  const s = String(v ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-:]+|[-:]+$/g, "")
    .slice(0, 80);
  return s || fallback;
}

/**
 * LLM の生 JSON を DailyAnalysis に落とす。
 * recurrence は過去日の照合結果(サーバ側の事実)で上書きする。
 */
export function normalizeAnalysis(
  parsed: any,
  dateKey: string,
  past: PastIssue[],
): { summary: string; highlights: DailyHighlight[]; issues: DailyIssue[] } {
  const highlightsRaw = Array.isArray(parsed?.highlights) ? parsed.highlights : [];
  const issuesRaw = Array.isArray(parsed?.issues) ? parsed.issues : [];

  const highlights: DailyHighlight[] = highlightsRaw
    .filter((h: any) => h && typeof h === "object")
    .map((h: any) => ({
      at: isoOrNull(h.at),
      device: strOrNull(h.device, 120),
      site: strOrNull(h.site, 120),
      platform: platformOf(h.platform),
      severity: severityOf(h.severity),
      title: str(h.title, 200),
      detail: str(h.detail, 800),
      source: str(h.source, 40) || "unknown",
    }))
    .filter((h: DailyHighlight) => h.title || h.detail)
    .slice(0, 12);

  // 過去の問題を key で索引化する(新しい日付が先)。
  const pastByKey = new Map<string, string[]>();
  for (const p of [...past].sort((a, b) => (a.date < b.date ? 1 : -1))) {
    const k = normalizeIssueKey(p.key, "");
    if (!k) continue;
    const arr = pastByKey.get(k) ?? [];
    if (!arr.includes(p.date)) arr.push(p.date);
    pastByKey.set(k, arr);
  }

  const yesterday = addDays(dateKey, -1);

  const issues: DailyIssue[] = issuesRaw
    .filter((i: any) => i && typeof i === "object")
    .map((i: any, idx: number) => {
      const name = str(i.name, 200) || `問題 ${idx + 1}`;
      const key = normalizeIssueKey(i.key, normalizeIssueKey(name, `issue-${idx + 1}`));
      const previousDates = (pastByKey.get(key) ?? []).slice(0, 30);
      const status: RecurrenceStatus =
        previousDates.length === 0 ? "new" : previousDates.includes(yesterday) ? "continuing" : "recurring";
      const occ = Number(i.occurrences);
      return {
        key,
        name,
        device: strOrNull(i.device, 160),
        site: strOrNull(i.site, 120),
        platform: platformOf(i.platform),
        severity: severityOf(i.severity),
        firstSeenAt: isoOrNull(i.firstSeenAt),
        occurrences: Number.isFinite(occ) && occ > 0 ? Math.floor(occ) : 1,
        rootCause: str(i.rootCause, 800),
        impact: str(i.impact, 600),
        nextAction: str(i.nextAction, 600),
        recurrence: {
          status,
          previousDates,
          firstSeenDate: previousDates.length ? previousDates[previousDates.length - 1] : dateKey,
          note: str(i.recurrenceNote ?? i.recurrence?.note, 400),
        },
      } satisfies DailyIssue;
    })
    .slice(0, 20);

  return { summary: str(parsed?.summary, 600), highlights, issues };
}

// ---- 入口 ----

export interface AnalyzeResult {
  analysis: DailyAnalysis;
  model: string;
  durationMs: number;
  attempts: number;
  error: string | null;
}

/**
 * 1 日分のデータを LLM に渡して分析 JSON を得る。
 * 失敗しても throw しない。analysis.status="error" を返し、レポート自体は成立させる。
 */
export async function analyzeDay(opts: {
  dateKey: string;
  data: DailyRawSummary;
  past: PastIssue[];
  model?: string | null;
  lang?: AnalyzeLang;
}): Promise<AnalyzeResult> {
  const lang: AnalyzeLang = opts.lang === "en" ? "en" : "ja";
  const model = opts.model || DEFAULT_MODEL;
  const prompt = buildPrompt(opts.dateKey, opts.data, opts.past, lang);
  const startedAt = Date.now();

  let attempts = 0;
  let lastReason: string | null = null;

  // JSON として読めなかったときだけ 1 回だけ言い直させる(2 回目で駄目なら諦める)。
  for (let i = 0; i < 2; i++) {
    attempts += 1;
    const system = SYSTEM_PROMPT[lang] + (i > 0 ? RETRY_SUFFIX[lang] : "");
    const res = await runClaudePlain(prompt, system, model);
    if (res.isError) {
      lastReason = res.reason ?? "claude の実行に失敗しました";
      break; // 実行そのものの失敗はリトライしない(認証切れ等でコストを重ねない)
    }
    const parsed = extractJsonObject(res.text);
    if (!parsed) {
      lastReason = `応答を JSON として解釈できませんでした(先頭 200 文字: ${res.text.slice(0, 200)})`;
      continue;
    }
    const { summary, highlights, issues } = normalizeAnalysis(parsed, opts.dateKey, opts.past);
    return {
      analysis: { status: "ok", summary, highlights, issues, error: null },
      model,
      durationMs: Date.now() - startedAt,
      attempts,
      error: null,
    };
  }

  return {
    analysis: {
      status: "error",
      summary: "",
      highlights: [],
      issues: [],
      error: lastReason ?? "分析に失敗しました",
    },
    model,
    durationMs: Date.now() - startedAt,
    attempts,
    error: lastReason ?? "分析に失敗しました",
  };
}
