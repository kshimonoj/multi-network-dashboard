// 日次レポート(44)— 重大な問題の自動事前調査(MCP 込みの本格調査を先に済ませておく)。
//
// レポートの「検出された問題」に付いている根本原因・影響範囲は、analyze.ts が
// **集計データだけ**(MCP なし)を見て書いた見立てにすぎない。画面の「調査する」を押すと
// ネットワーク調査タブへ文面が渡るが、そこから claude CLI + MCP が動き出すので
// 結果が出るまで待たされる。そこで、重要度の高い問題に限ってレポート生成時に
// 先回りして本格調査(runAutoInvestigation = 対話と同じ経路)を走らせておく。
//
// ---- 発火条件(コストを絞る)----
//  1. 重要度が critical。
//  2. 再発性が new(新規)または continuing(前日から継続)。
//     recurring(間が空いた再発)は既定では対象外。REPORTS_AUTO_RECURRENCE で変えられる。
//  3. 同じ名寄せキー(issue.key)は **一生に 1 度だけ**。実行済みキーは
//     data/reports/auto-investigations.json に永続化し、翌日以降のレポートに同じ問題が
//     出ても再実行しない(Webhook ログの「同一アラートは 1 回だけ」と同じ考え方。
//     ただし時間窓ではなく名寄せキーの既調査履歴で判定する)。
//  4. 1 回のレポート生成につき settings.autoInvestigateMaxPerReport 件まで(既定 2)。
//     溢れた問題は記録を残さないので、翌日以降のレポートで枠が空いていれば拾われる。
//  5. 対象日が古すぎるレポート(REPORTS_AUTO_MAX_AGE_DAYS 既定 2 日より前)では発火しない。
//     起動時の後追い生成(catchUpMissing)が 7 日ぶんまとめて走るときに、
//     もう現況と噛み合わない過去の問題で claude CLI が量産されるのを防ぐ。
//  6. 分析そのものが失敗している(analysis.status !== "ok")レポートでは発火しない。
//  7. Insight Agent は同時に 1 本だけ走らせる(直列キュー)。
//
// 実行結果は query-history.jsonl に source="auto" で残るので、ネットワーク調査タブの
// タイムラインにも「自動調査」タグ付きで現れる。画面(Reports.tsx)は runId を使って
// その実行スレッドへ直接ジャンプする(18/19 番の pendingHistoryFocus)。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { runAutoInvestigation } from "../network-investigation/api.js";
import { DATA_DIR, atomicWrite, getSettings } from "./store.js";
import { todayKey } from "./time.js";
import type {
  AutoInvestigationEntry,
  DailyIssue,
  DailyReport,
  RecurrenceStatus,
} from "./types.js";

const STATE_PATH = path.join(DATA_DIR, "auto-investigations.json");
const STATE_VERSION = 1;

/** 回答要約(画面の詳細パネルに出す)の最大文字数。webhook-feed/enrich.ts と同じ。 */
const SUMMARY_MAX = 600;

/** これより古い対象日のレポートでは発火しない(定期生成は「前日分」= 1 日前なので既定 2 日)。 */
const MAX_AGE_DAYS = Math.max(0, Number(process.env.REPORTS_AUTO_MAX_AGE_DAYS ?? 2));

/** 対象にする再発性。既定は「新規」と「継続」(間が空いた再発 recurring は対象外)。 */
const TARGET_RECURRENCE: RecurrenceStatus[] = String(
  process.env.REPORTS_AUTO_RECURRENCE ?? "new,continuing",
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s): s is RecurrenceStatus => s === "new" || s === "recurring" || s === "continuing");

// ---- state(名寄せキー単位の既調査履歴)----

interface AutoState {
  version: number;
  entries: Record<string, AutoInvestigationEntry>;
}

let state: AutoState = { version: STATE_VERSION, entries: {} };
let loaded = false;

export async function loadAutoState(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf-8")) as AutoState;
    const entries = parsed && typeof parsed === "object" ? (parsed.entries ?? {}) : {};
    state = { version: STATE_VERSION, entries: {} };
    for (const [k, v] of Object.entries(entries)) {
      if (v && typeof v === "object" && typeof v.key === "string") state.entries[k] = v;
    }
    // 起動前に落ちた「実行中」は、結果が返ってくる先が既に無いので失敗として確定させる。
    // (残したままだと画面が永遠に「調査中」を出し、再実行も抑止され続ける。)
    let revived = 0;
    for (const e of Object.values(state.entries)) {
      if (e.status === "running") {
        e.status = "error";
        e.finishedAt = new Date().toISOString();
        e.error = "アプリの再起動により中断されました";
        revived += 1;
      }
    }
    console.log(
      `[reports] 自動事前調査の履歴を復元: ${Object.keys(state.entries).length} 件` +
        (revived ? `(うち中断扱いにしたもの ${revived} 件)` : ""),
    );
    if (revived) await persist();
  } catch {
    state = { version: STATE_VERSION, entries: {} };
    console.log("[reports] 自動事前調査の履歴はまだありません(auto-investigations.json 未作成)");
  }
  loaded = true;
}

async function persist(): Promise<void> {
  await atomicWrite(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

/** 名寄せキー単位の既調査履歴(画面・API 用。実行順ではなく開始時刻の新しい順)。 */
export function listAutoInvestigations(): AutoInvestigationEntry[] {
  return Object.values(state.entries).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function getAutoInvestigation(key: string): AutoInvestigationEntry | null {
  return state.entries[key] ?? null;
}

// ---- クエリ生成 ----

function orUnknown(v: string | null | undefined, lang: "ja" | "en"): string {
  const s = (v ?? "").trim();
  return s === "" ? (lang === "ja" ? "不明" : "unknown") : s;
}

/**
 * 問題 1 件 → Insight Agent へ投げるクエリ文。
 * 文字列連結でその場に文章を作らず、日英のテンプレートに値を埋める(CLAUDE.md の i18n 方針)。
 * サーバ生成だが「実行時の記録」として履歴に残る文言なので、後から翻訳はしない。
 */
export function buildIssueAutoQuery(dateKey: string, issue: DailyIssue, lang: "ja" | "en"): string {
  const site = orUnknown(issue.site, lang);
  const device = orUnknown(issue.device, lang);
  const prev = issue.recurrence.previousDates.length;

  if (lang === "en") {
    const recurrence =
      issue.recurrence.status === "new"
        ? `This problem was detected for the first time on ${dateKey}.`
        : `This problem has also been detected on ${prev} earlier day(s), first on ${issue.recurrence.firstSeenDate}.`;
    return (
      `A critical issue was detected in the daily report for ${dateKey}. ` +
      `Check the current state through the available tools and investigate the likely cause, the blast radius and what to verify next: ` +
      `"${issue.name}" (site: ${site} / device: ${device} / occurrences that day: ${issue.occurrences}). ` +
      `${recurrence} ` +
      `The report's offline analysis guessed the root cause as "${orUnknown(issue.rootCause, lang)}", ` +
      `the impact as "${orUnknown(issue.impact, lang)}" and the next action as "${orUnknown(issue.nextAction, lang)}". ` +
      `Verify whether that guess holds against live data, and correct it if it does not.`
    );
  }

  const recurrence =
    issue.recurrence.status === "new"
      ? `この問題は ${dateKey} が初出です。`
      : `この問題は過去 ${prev} 日にも検出されており、初出は ${issue.recurrence.firstSeenDate} です。`;
  return (
    `${dateKey} の日次レポートで重大な問題が検出されました。現在の状態をツールで確認し、` +
    `原因の見立てと影響範囲、確認すべき点を調査してください: ` +
    `「${issue.name}」(サイト: ${site} / 対象機器: ${device} / 当日の発生回数: ${issue.occurrences} 回)。` +
    `${recurrence}` +
    `レポートの簡易分析(集計データのみ・ライブ取得なし)では、根本原因は「${orUnknown(issue.rootCause, lang)}」、` +
    `影響範囲は「${orUnknown(issue.impact, lang)}」、次のアクションは「${orUnknown(issue.nextAction, lang)}」と推定されています。` +
    `この見立てが実データと整合するかを確認し、違っていれば訂正してください。`
  );
}

// ---- 直列キュー(claude CLI を同時に何本も起こさない)----

let queue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch((err) => {
    console.error("[reports] 自動事前調査キューでエラー:", err);
  });
}

// ---- トリガー ----

export interface AutoTriggerResult {
  date: string;
  enabled: boolean;
  /** 発火条件(重要度・再発性)を満たした問題の数 */
  candidates: number;
  fired: Array<{ key: string; name: string; site: string | null; query: string }>;
  /** 既に調査済み(名寄せキー一致)で見送った */
  skippedDone: string[];
  /** 1 回あたりの上限に達して見送った(次回以降に回る) */
  skippedLimit: string[];
  maxPerReport: number;
  /** 発火しなかった理由(条件を満たす問題が無い場合は null) */
  reason: string | null;
}

function daysAgo(dateKey: string): number {
  const a = Date.parse(`${dateKey}T00:00:00Z`);
  const b = Date.parse(`${todayKey()}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.round((b - a) / 86_400_000);
}

function isTarget(issue: DailyIssue): boolean {
  return issue.severity === "critical" && TARGET_RECURRENCE.includes(issue.recurrence.status);
}

/**
 * 保存済みの日次レポートに対して自動事前調査を仕掛ける。
 * 実際の実行はバックグラウンド(直列キュー)なので、この関数はすぐ返る。
 *
 * @param opts.force  対象日の古さ判定と enabled 設定を無視する(動作確認用)。
 *                    既調査キーの重複防止と上限件数は force でも必ず効く。
 */
export async function triggerAutoInvestigations(
  report: DailyReport,
  opts: { force?: boolean } = {},
): Promise<AutoTriggerResult> {
  if (!loaded) await loadAutoState();
  const settings = getSettings();
  const max = settings.autoInvestigateMaxPerReport;
  const result: AutoTriggerResult = {
    date: report.date,
    enabled: settings.autoInvestigateEnabled,
    candidates: 0,
    fired: [],
    skippedDone: [],
    skippedLimit: [],
    maxPerReport: max,
    reason: null,
  };

  if (!settings.autoInvestigateEnabled && !opts.force) {
    result.reason = "自動事前調査は設定で無効です";
    return result;
  }
  if (report.analysis.status !== "ok") {
    result.reason = "分析が失敗しているレポートなので自動事前調査は行いません";
    return result;
  }
  const age = daysAgo(report.date);
  if (!opts.force && age > MAX_AGE_DAYS) {
    result.reason = `対象日が ${age} 日前(上限 ${MAX_AGE_DAYS} 日)なので自動事前調査は行いません`;
    return result;
  }

  // 重大かつ新規/継続の問題を、当日の発生回数が多い順に見る(上限枠を重い問題から使う)。
  const candidates = report.analysis.issues.filter(isTarget).sort((a, b) => b.occurrences - a.occurrences);
  result.candidates = candidates.length;
  if (candidates.length === 0) {
    result.reason = "条件(重大 かつ 新規/継続)に該当する問題がありません";
    return result;
  }

  const pending: Array<{ issue: DailyIssue; entry: AutoInvestigationEntry }> = [];
  for (const issue of candidates) {
    if (state.entries[issue.key]) {
      result.skippedDone.push(issue.key);
      continue;
    }
    if (pending.length >= max) {
      result.skippedLimit.push(issue.key);
      continue;
    }
    const query = buildIssueAutoQuery(report.date, issue, report.lang);
    // 実行前に「調査中」を立てて永続化する。実行中に別のレポート生成が走っても
    // 同じ問題を二重に起こさないため(Webhook 側の markDone と同じ順序)。
    const entry: AutoInvestigationEntry = {
      key: issue.key,
      issueName: issue.name,
      site: issue.site,
      device: issue.device,
      severity: issue.severity,
      recurrence: issue.recurrence.status,
      status: "running",
      date: report.date,
      runId: null,
      sessionId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      query,
      summary: "",
      error: null,
    };
    state.entries[issue.key] = entry;
    pending.push({ issue, entry });
    result.fired.push({ key: issue.key, name: issue.name, site: issue.site, query });
  }

  if (pending.length > 0) await persist();

  console.log(
    `[reports] ${report.date} の自動事前調査: 該当 ${result.candidates} 件 → ` +
      `発火 ${result.fired.length} 件 / 調査済みで見送り ${result.skippedDone.length} 件 / ` +
      `上限(${max} 件)で見送り ${result.skippedLimit.length} 件`,
  );

  for (const { entry } of pending) enqueue(() => runOne(entry));
  return result;
}

async function runOne(entry: AutoInvestigationEntry): Promise<void> {
  console.log(
    `[reports] 自動事前調査を開始: ${entry.date} / ${entry.key} / ` +
      `${entry.site ?? "サイト不明"} / ${entry.issueName.slice(0, 60)}`,
  );
  try {
    const { record } = await runAutoInvestigation(entry.query, entry.site);
    entry.runId = record.id;
    entry.sessionId = record.sessionId ?? record.id;
    entry.finishedAt = new Date().toISOString();
    if (record.isError) {
      entry.status = "error";
      entry.error = record.reason ?? "Insight Agent の実行に失敗しました";
    } else {
      entry.status = "done";
      entry.summary = (record.answer ?? "").trim().slice(0, SUMMARY_MAX);
    }
  } catch (err) {
    entry.status = "error";
    entry.finishedAt = new Date().toISOString();
    entry.error = err instanceof Error ? err.message : String(err);
  }
  state.entries[entry.key] = entry;
  await persist();
  console.log(
    `[reports] 自動事前調査が完了: ${entry.key} status=${entry.status} runId=${entry.runId ?? "-"}` +
      (entry.error ? ` reason=${entry.error.slice(0, 120)}` : ""),
  );
}

/** GET /status に載せる現況。 */
export function autoInvestigationStatus() {
  const entries = listAutoInvestigations();
  return {
    enabled: getSettings().autoInvestigateEnabled,
    maxPerReport: getSettings().autoInvestigateMaxPerReport,
    maxAgeDays: MAX_AGE_DAYS,
    targetRecurrence: TARGET_RECURRENCE,
    total: entries.length,
    running: entries.filter((e) => e.status === "running").length,
    done: entries.filter((e) => e.status === "done").length,
    error: entries.filter((e) => e.status === "error").length,
    latest: entries.slice(0, 5).map((e) => ({
      key: e.key,
      date: e.date,
      status: e.status,
      runId: e.runId,
      startedAt: e.startedAt,
    })),
  };
}
