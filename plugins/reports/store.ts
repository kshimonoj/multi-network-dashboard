// 日次レポート(41)— 設定・ファイル入出力・Retention。
//
// 置き場(すべて data/ 配下。イメージを作り直しても消えない):
//   data/reports/settings.json                 … 生成時刻 / 保持日数 / モデル等
//   data/reports/daily/YYYY-MM-DD.json         … 日次レポート本体(43 番の週次/月次はこれを再集計する)
//   data/reports/samples/YYYY-MM-DD.jsonl      … Global Overview の当日サンプル(1 行 1 サンプル)
//
// 書き込みは既存プラグインと同じ「一時ファイル → rename」(書き込み途中を読ませない)。
// Retention は Streaming(central-streaming/store.ts)の方式を踏襲しつつ、
// **既定を「無期限」** にしてある(41 Task 4。0 = 期限なし)。

import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, readFile, readdir, rename, unlink, writeFile, stat } from "node:fs/promises";
import type {
  DailyReport,
  DailyReportMeta,
  PeriodReport,
  PeriodReportMeta,
  PeriodType,
  ReportSettings,
} from "./types.js";
import {
  REPORT_TZ,
  addDays,
  addMonthKeys,
  addWeekKeys,
  currentPeriodKey,
  isDateKey,
  isMonthKey,
  isWeekKey,
  monthStartOfKey,
  todayKey,
  weekStartOfKey,
} from "./time.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR =
  process.env.REPORTS_DATA_DIR || path.resolve(__dirname, "../../data/reports");
export const DAILY_DIR = path.join(DATA_DIR, "daily");
export const SAMPLES_DIR = path.join(DATA_DIR, "samples");
export const WEEKLY_DIR = path.join(DATA_DIR, "weekly");
export const MONTHLY_DIR = path.join(DATA_DIR, "monthly");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

/** 画面(42 番)のプルダウンに出す保持日数。0 = 無期限。 */
export const RETENTION_OPTIONS_DAYS = [0, 30, 90, 180, 365];
/** 45: 週次 / 月次の保持期間の選択肢。0 = 無期限。 */
export const RETENTION_OPTIONS_WEEKS = [0, 8, 13, 26, 52];
export const RETENTION_OPTIONS_MONTHS = [0, 6, 12, 24, 36];

const DEFAULT_SETTINGS: ReportSettings = {
  enabled: true,
  hour: 9,
  minute: 0,
  retentionDays: 0, // 既定は無期限保持(41 の前提)
  sampleRetentionDays: 14,
  catchUpDays: 7,
  model: null,
  lang: "ja",
  sampleIntervalMs: 300_000,
  sleIntervalMs: 1_800_000,
  // 44: 重大な問題の自動事前調査。既定値だけ env で与え、以後は settings.json が優先される
  // (Webhook ログの WEBHOOK_FEED_AUTO_* と同じ扱い)。
  autoInvestigateEnabled: String(process.env.REPORTS_AUTO_ENABLED ?? "1") !== "0",
  autoInvestigateMaxPerReport: clampInt(process.env.REPORTS_AUTO_MAX_PER_REPORT, 0, 10, 2),
  // 45: 週次 / 月次。既定は「毎週月曜 9:30」「毎月 1 日 9:40」。
  // 日次(9:00)が終わってから走らせたいので、少しずらしてある
  //   9:00 日次(前日ぶん) → 9:30 週次(前週ぶん) → 9:40 月次(前月ぶん)
  // 日次が間に合わなくても、その日を欠落として集計するだけでエラーにはしない。
  weeklyEnabled: true,
  weeklyWeekday: 1,
  weeklyHour: 9,
  weeklyMinute: 30,
  monthlyEnabled: true,
  monthlyDay: 1,
  monthlyHour: 9,
  monthlyMinute: 40,
  weeklyRetentionWeeks: 0,
  monthlyRetentionMonths: 0,
  catchUpWeeks: 4,
  catchUpMonths: 2,
};

let settings: ReportSettings = { ...DEFAULT_SETTINGS };

// 同じファイルへの同時書き込みを直列化する(webhook-feed/poller.ts と同じ理由)。
const writeChains = new Map<string, Promise<unknown>>();

export async function atomicWrite(file: string, data: string): Promise<void> {
  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev.then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, data, "utf-8");
    await rename(tmp, file);
  });
  writeChains.set(
    file,
    next.catch(() => undefined),
  );
  return next;
}

export async function ensureDirs(): Promise<void> {
  await mkdir(DAILY_DIR, { recursive: true });
  await mkdir(SAMPLES_DIR, { recursive: true });
  await mkdir(WEEKLY_DIR, { recursive: true });
  await mkdir(MONTHLY_DIR, { recursive: true });
}

// ---- 設定 ----

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? Math.floor(v) : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/;

export function normalizeSettings(raw: unknown, base: ReportSettings = DEFAULT_SETTINGS): ReportSettings {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const model =
    typeof p.model === "string" && p.model.trim() && MODEL_RE.test(p.model.trim())
      ? p.model.trim()
      : p.model === null || p.model === ""
        ? null
        : base.model;
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : base.enabled,
    hour: p.hour === undefined ? base.hour : clampInt(p.hour, 0, 23, base.hour),
    minute: p.minute === undefined ? base.minute : clampInt(p.minute, 0, 59, base.minute),
    // 0 = 無期限。1 日未満の指定は 0(無期限)ではなく 1 日に倒す。
    retentionDays:
      p.retentionDays === undefined ? base.retentionDays : clampInt(p.retentionDays, 0, 3650, base.retentionDays),
    sampleRetentionDays:
      p.sampleRetentionDays === undefined
        ? base.sampleRetentionDays
        : clampInt(p.sampleRetentionDays, 1, 365, base.sampleRetentionDays),
    catchUpDays: p.catchUpDays === undefined ? base.catchUpDays : clampInt(p.catchUpDays, 0, 31, base.catchUpDays),
    model,
    lang: p.lang === "en" ? "en" : p.lang === "ja" ? "ja" : base.lang,
    sampleIntervalMs:
      p.sampleIntervalMs === undefined
        ? base.sampleIntervalMs
        : clampInt(p.sampleIntervalMs, 60_000, 3_600_000, base.sampleIntervalMs),
    sleIntervalMs:
      p.sleIntervalMs === undefined
        ? base.sleIntervalMs
        : clampInt(p.sleIntervalMs, 300_000, 21_600_000, base.sleIntervalMs),
    autoInvestigateEnabled:
      typeof p.autoInvestigateEnabled === "boolean" ? p.autoInvestigateEnabled : base.autoInvestigateEnabled,
    autoInvestigateMaxPerReport:
      p.autoInvestigateMaxPerReport === undefined
        ? base.autoInvestigateMaxPerReport
        : clampInt(p.autoInvestigateMaxPerReport, 0, 10, base.autoInvestigateMaxPerReport),
    // ---- 45: 週次 / 月次 ----
    weeklyEnabled: typeof p.weeklyEnabled === "boolean" ? p.weeklyEnabled : base.weeklyEnabled,
    weeklyWeekday:
      p.weeklyWeekday === undefined ? base.weeklyWeekday : clampInt(p.weeklyWeekday, 0, 6, base.weeklyWeekday),
    weeklyHour: p.weeklyHour === undefined ? base.weeklyHour : clampInt(p.weeklyHour, 0, 23, base.weeklyHour),
    weeklyMinute:
      p.weeklyMinute === undefined ? base.weeklyMinute : clampInt(p.weeklyMinute, 0, 59, base.weeklyMinute),
    monthlyEnabled: typeof p.monthlyEnabled === "boolean" ? p.monthlyEnabled : base.monthlyEnabled,
    // 29〜31 日は月によって存在しないので 28 までにする(その月に発火しない事故を避ける)。
    monthlyDay: p.monthlyDay === undefined ? base.monthlyDay : clampInt(p.monthlyDay, 1, 28, base.monthlyDay),
    monthlyHour: p.monthlyHour === undefined ? base.monthlyHour : clampInt(p.monthlyHour, 0, 23, base.monthlyHour),
    monthlyMinute:
      p.monthlyMinute === undefined ? base.monthlyMinute : clampInt(p.monthlyMinute, 0, 59, base.monthlyMinute),
    weeklyRetentionWeeks:
      p.weeklyRetentionWeeks === undefined
        ? base.weeklyRetentionWeeks
        : clampInt(p.weeklyRetentionWeeks, 0, 520, base.weeklyRetentionWeeks),
    monthlyRetentionMonths:
      p.monthlyRetentionMonths === undefined
        ? base.monthlyRetentionMonths
        : clampInt(p.monthlyRetentionMonths, 0, 120, base.monthlyRetentionMonths),
    catchUpWeeks: p.catchUpWeeks === undefined ? base.catchUpWeeks : clampInt(p.catchUpWeeks, 0, 52, base.catchUpWeeks),
    catchUpMonths:
      p.catchUpMonths === undefined ? base.catchUpMonths : clampInt(p.catchUpMonths, 0, 24, base.catchUpMonths),
  };
}

export function getSettings(): ReportSettings {
  return { ...settings };
}

export async function loadSettings(): Promise<ReportSettings> {
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_PATH, "utf-8"));
    settings = normalizeSettings(parsed);
    console.log(
      `[reports] settings.json を復元: 定期生成=${settings.enabled ? "有効" : "無効"} ` +
        `${String(settings.hour).padStart(2, "0")}:${String(settings.minute).padStart(2, "0")} ` +
        `保持=${settings.retentionDays === 0 ? "無期限" : `${settings.retentionDays}日`} ` +
        `モデル=${settings.model ?? "既定"}`,
    );
  } catch {
    console.log("[reports] settings.json がありません。既定(毎日 9:00 / 無期限保持)で始めます。");
    settings = { ...DEFAULT_SETTINGS };
  }
  return getSettings();
}

export async function saveSettings(patch: unknown): Promise<ReportSettings> {
  settings = normalizeSettings(patch, settings);
  await atomicWrite(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  return getSettings();
}

// ---- 日次レポート本体 ----

export function dailyPath(dateKey: string): string {
  return path.join(DAILY_DIR, `${dateKey}.json`);
}

export async function readDaily(dateKey: string): Promise<DailyReport | null> {
  try {
    const parsed = JSON.parse(await readFile(dailyPath(dateKey), "utf-8")) as DailyReport;
    return parsed && typeof parsed === "object" && parsed.date ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeDaily(report: DailyReport): Promise<string> {
  const file = dailyPath(report.date);
  await atomicWrite(file, JSON.stringify(report, null, 2) + "\n");
  return file;
}

export async function hasDaily(dateKey: string): Promise<boolean> {
  try {
    await stat(dailyPath(dateKey));
    return true;
  } catch {
    return false;
  }
}

/** 生成済みの日次レポートの日付キー(新しい順)。 */
export async function listDailyDates(): Promise<string[]> {
  try {
    const files = await readdir(DAILY_DIR);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter(isDateKey)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** 一覧用の軽量メタ。件数だけ欲しい画面(42 番)向け。 */
export async function listDailyMeta(limit = 60): Promise<DailyReportMeta[]> {
  const dates = (await listDailyDates()).slice(0, Math.max(1, limit));
  const out: DailyReportMeta[] = [];
  for (const date of dates) {
    const r = await readDaily(date);
    if (!r) continue;
    let bytes = 0;
    try {
      bytes = (await stat(dailyPath(date))).size;
    } catch {
      /* 消えていたら 0 のまま */
    }
    out.push({
      date: r.date,
      generatedAt: r.generatedAt,
      generatedBy: r.generatedBy,
      partial: r.partial === true,
      analysisStatus: r.analysis?.status ?? "unknown",
      highlights: r.analysis?.highlights?.length ?? 0,
      issues: r.analysis?.issues?.length ?? 0,
      criticalIssues: (r.analysis?.issues ?? []).filter((i) => i.severity === "critical").length,
      webhookTotal: r.data?.webhook?.total ?? 0,
      bytes,
    });
  }
  return out;
}

/**
 * 直近 n 日ぶんの「問題」履歴(再発性の判定材料)。
 * LLM のプロンプトに入れる材料であると同時に、previousDates をサーバ側で機械的に
 * 埋めるための照合表でもある(LLM の記憶に頼らない)。
 */
export async function readRecentIssueHistory(
  beforeDateKey: string,
  days: number,
): Promise<Array<{ date: string; key: string; name: string; device: string | null; site: string | null; severity: string }>> {
  const out: Array<{ date: string; key: string; name: string; device: string | null; site: string | null; severity: string }> = [];
  for (let i = 1; i <= days; i++) {
    const d = addDays(beforeDateKey, -i);
    const r = await readDaily(d);
    if (!r) continue;
    for (const issue of r.analysis?.issues ?? []) {
      out.push({
        date: r.date,
        key: issue.key,
        name: issue.name,
        device: issue.device ?? null,
        site: issue.site ?? null,
        severity: issue.severity,
      });
    }
  }
  return out;
}

// ---- 週次 / 月次レポート(45)----
//
// data/reports/weekly/YYYY-Www.json  … 週次(ISO 週 / 月曜始まり)
// data/reports/monthly/YYYY-MM.json  … 月次
//
// 日次と違って LLM を使わないので、作り直しは軽い(ファイル読み + 集計のみ)。

function periodDir(periodType: PeriodType): string {
  return periodType === "weekly" ? WEEKLY_DIR : MONTHLY_DIR;
}

export function isPeriodKey(periodType: PeriodType, key: unknown): key is string {
  return periodType === "weekly" ? isWeekKey(key) : isMonthKey(key);
}

export function periodPath(periodType: PeriodType, key: string): string {
  return path.join(periodDir(periodType), `${key}.json`);
}

export async function readPeriod(periodType: PeriodType, key: string): Promise<PeriodReport | null> {
  try {
    const parsed = JSON.parse(await readFile(periodPath(periodType, key), "utf-8")) as PeriodReport;
    return parsed && typeof parsed === "object" && parsed.key ? parsed : null;
  } catch {
    return null;
  }
}

export async function writePeriod(report: PeriodReport): Promise<string> {
  const file = periodPath(report.periodType, report.key);
  await atomicWrite(file, JSON.stringify(report, null, 2) + "\n");
  return file;
}

/** 生成済みの週 / 月キー(新しい順)。 */
export async function listPeriodKeys(periodType: PeriodType): Promise<string[]> {
  try {
    const files = await readdir(periodDir(periodType));
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((k) => isPeriodKey(periodType, k))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** 一覧用の軽量メタ(カレンダーの「生成済み」判定用)。 */
export async function listPeriodMeta(periodType: PeriodType, limit = 60): Promise<PeriodReportMeta[]> {
  const keys = (await listPeriodKeys(periodType)).slice(0, Math.max(1, limit));
  const out: PeriodReportMeta[] = [];
  for (const key of keys) {
    const r = await readPeriod(periodType, key);
    if (!r) continue;
    let bytes = 0;
    try {
      bytes = (await stat(periodPath(periodType, key))).size;
    } catch {
      /* 消えていたら 0 のまま */
    }
    out.push({
      key: r.key,
      periodType: r.periodType,
      startDate: r.startDate,
      endDate: r.endDate,
      generatedAt: r.generatedAt,
      generatedBy: r.generatedBy,
      availableDays: r.coverage?.availableDays ?? 0,
      expectedDays: r.coverage?.expectedDays ?? 0,
      periodDays: r.coverage?.periodDays ?? 0,
      complete: r.coverage?.complete ?? false,
      inProgress: r.coverage?.inProgress ?? false,
      stale: r.stale === true,
      issues: r.issues?.length ?? 0,
      criticalIssues: (r.issues ?? []).filter((i) => i.severity === "critical").length,
      newIssues: r.kpi?.issues?.new ?? 0,
      events: r.kpi?.events?.total ?? 0,
      criticalAlerts: r.kpi?.alerts?.critical ?? 0,
      bytes,
    });
  }
  return out;
}

// ---- サンプル(Global Overview の当日分)----

export function samplePath(dateKey: string): string {
  return path.join(SAMPLES_DIR, `${dateKey}.jsonl`);
}

export async function appendSample(dateKey: string, line: unknown): Promise<void> {
  await mkdir(SAMPLES_DIR, { recursive: true });
  const file = samplePath(dateKey);
  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev.then(async () => {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, JSON.stringify(line) + "\n", "utf-8");
  });
  writeChains.set(
    file,
    next.catch(() => undefined),
  );
  await next;
}

export async function readSamples<T>(dateKey: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(samplePath(dateKey), "utf-8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as T);
    } catch {
      /* 追記中にプロセスが落ちて切れた行は捨てる */
    }
  }
  return out;
}

// ---- Retention(Task 4)----

export interface PurgeResult {
  retentionDays: number;
  sampleRetentionDays: number;
  /** レポートの削除境界(この日より前を消す)。無期限なら null */
  cutoffDate: string | null;
  sampleCutoffDate: string;
  removedReports: string[];
  removedSamples: string[];
  // ---- 45: 週次 / 月次 ----
  weeklyRetentionWeeks: number;
  monthlyRetentionMonths: number;
  /** 削除境界。無期限なら null */
  weeklyCutoffKey: string | null;
  monthlyCutoffKey: string | null;
  removedWeekly: string[];
  removedMonthly: string[];
  ranAt: string;
}

let lastPurge: PurgeResult | null = null;

/** dir 配下の "YYYY-MM-DD<suffix>" のうち、cutoff より前の日付のものを消す。 */
async function unlinkOlderThan(dir: string, suffix: string, cutoffDate: string): Promise<string[]> {
  const removed: string[] = [];
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return removed;
  }
  for (const f of files) {
    if (!f.endsWith(suffix)) continue;
    const key = f.slice(0, -suffix.length);
    if (!isDateKey(key)) continue;
    if (key >= cutoffDate) continue;
    try {
      await unlink(path.join(dir, f));
      removed.push(key);
    } catch {
      /* 消せなくても次の巡回で拾う */
    }
  }
  return removed;
}

/**
 * 週 / 月のレポートのうち、境界キーより前のものを消す(45)。
 * キー文字列の比較ではなく **期間の開始日** で比較する
 * ("2026-W53" と "2027-W01" のような ISO 週年をまたぐ並びで取り違えないため)。
 */
async function unlinkPeriodsBefore(periodType: PeriodType, cutoffKey: string): Promise<string[]> {
  const startOf = (key: string): string =>
    periodType === "weekly" ? weekStartOfKey(key) : monthStartOfKey(key);
  const cutoffStart = startOf(cutoffKey);
  const removed: string[] = [];
  for (const key of await listPeriodKeys(periodType)) {
    if (startOf(key) >= cutoffStart) continue;
    try {
      await unlink(periodPath(periodType, key));
      removed.push(key);
    } catch {
      /* 消せなくても次の巡回で拾う */
    }
  }
  return removed;
}

/**
 * 保持期間を超えたファイルを削除する。
 * - 日次レポート … settings.retentionDays。0(既定)なら削除しない = 無期限保持
 * - サンプル      … settings.sampleRetentionDays(レポートを作り直すための素材。既定 14 日)
 * - 週次 / 月次   … settings.weeklyRetentionWeeks / monthlyRetentionMonths(45。既定 無期限)
 * 「保持 N 日 / N 週 / N か月」= 今(今日を含む期間)から数えて直近 N 個を残す、と定義する。
 */
export async function purgeOld(): Promise<PurgeResult> {
  const ranAt = new Date().toISOString();
  const days = settings.retentionDays;
  const sampleDays = settings.sampleRetentionDays;

  const cutoffDate = days > 0 ? addDays(todayKey(), -(days - 1)) : null;
  const sampleCutoffDate = addDays(todayKey(), -(sampleDays - 1));

  const removedReports = cutoffDate ? await unlinkOlderThan(DAILY_DIR, ".json", cutoffDate) : [];
  const removedSamples = await unlinkOlderThan(SAMPLES_DIR, ".jsonl", sampleCutoffDate);

  const weeks = settings.weeklyRetentionWeeks;
  const months = settings.monthlyRetentionMonths;
  const weeklyCutoffKey = weeks > 0 ? addWeekKeys(currentPeriodKey("weekly"), -(weeks - 1)) : null;
  const monthlyCutoffKey = months > 0 ? addMonthKeys(todayKey().slice(0, 7), -(months - 1)) : null;
  const removedWeekly = weeklyCutoffKey ? await unlinkPeriodsBefore("weekly", weeklyCutoffKey) : [];
  const removedMonthly = monthlyCutoffKey ? await unlinkPeriodsBefore("monthly", monthlyCutoffKey) : [];

  if (removedReports.length || removedSamples.length || removedWeekly.length || removedMonthly.length) {
    console.log(
      `[reports] Retention: 日次 ${removedReports.length} 件(境界 ${cutoffDate ?? "無期限"}) / ` +
        `サンプル ${removedSamples.length} 件(境界 ${sampleCutoffDate}) / ` +
        `週次 ${removedWeekly.length} 件(境界 ${weeklyCutoffKey ?? "無期限"}) / ` +
        `月次 ${removedMonthly.length} 件(境界 ${monthlyCutoffKey ?? "無期限"})を削除しました(TZ=${REPORT_TZ})`,
    );
  }
  lastPurge = {
    retentionDays: days,
    sampleRetentionDays: sampleDays,
    cutoffDate,
    sampleCutoffDate,
    removedReports,
    removedSamples,
    weeklyRetentionWeeks: weeks,
    monthlyRetentionMonths: months,
    weeklyCutoffKey,
    monthlyCutoffKey,
    removedWeekly,
    removedMonthly,
    ranAt,
  };
  return lastPurge;
}

export function lastPurgeInfo(): PurgeResult | null {
  return lastPurge;
}

/** Retention の定期ジョブ(1 日 1 回で十分。起動時にも 1 回走らせる)。 */
const PURGE_INTERVAL_MS = Math.max(600_000, Number(process.env.REPORTS_PURGE_MS ?? 86_400_000));
let purgeTimer: NodeJS.Timeout | null = null;

export function startRetentionJob(): void {
  if (purgeTimer) return;
  purgeTimer = setInterval(() => {
    purgeOld().catch((err) => console.error("[reports] Retention ジョブ失敗:", err));
  }, PURGE_INTERVAL_MS);
  purgeTimer.unref?.();
  console.log(
    `[reports] Retention ジョブ開始: ${PURGE_INTERVAL_MS / 3_600_000} 時間ごと ` +
      `(保持 ${settings.retentionDays === 0 ? "無期限" : `${settings.retentionDays} 日`})`,
  );
}
