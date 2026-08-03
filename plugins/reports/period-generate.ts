// 週次 / 月次レポート(45 Task 2・Task 3-2)— 生成の入口と、起動時の後追い生成。
//
// 日次(generate.ts)と役割は同じだが、中身は大きく違う:
//   - **LLM を呼ばない**(集計は aggregate.ts の純粋な計算)。数十 ms で終わるので直列キューも要らない
//   - **外部 API を呼ばない**。読むのは data/reports/daily/*.json だけ
//   - 44 番の自動事前調査も **仕掛けない**(対象期間の日次生成時に実行済みのものを画面側で参照する)
//
// 欠落の扱い(Task 2-3 / 2-4):
//   - 期間内の日次レポートが一部欠けている → 揃っている日だけで集計し、coverage.missingDays に残す
//   - 1 件も無い → レポートを作らず、その旨をログに残す(status="skipped-no-data")

import { aggregatePeriod } from "./aggregate.js";
import {
  getSettings,
  listPeriodKeys,
  readDaily,
  readPeriod,
  writePeriod,
} from "./store.js";
import type { DailyReport, PeriodReport, PeriodType } from "./types.js";
import {
  addMonthKeys,
  addWeekKeys,
  currentPeriodKey,
  periodWindow,
  todayKey,
  weekKeyOf,
} from "./time.js";

export type PeriodTrigger = "schedule" | "manual" | "catchup";

export interface PeriodGenerateOutcome {
  periodType: PeriodType;
  key: string;
  status: "generated" | "skipped-exists" | "skipped-no-data" | "failed";
  reason: string | null;
  report: PeriodReport | null;
  durationMs: number;
}

/** 期間内に存在する日次レポートを読み集める(欠けている日は黙って飛ばす)。 */
async function loadDaysIn(periodType: PeriodType, key: string): Promise<DailyReport[]> {
  const { days } = periodWindow(periodType, key);
  const out: DailyReport[] = [];
  for (const date of days) {
    const r = await readDaily(date);
    if (r) out.push(r);
  }
  return out;
}

/**
 * 週次 / 月次レポートを生成して保存する。
 *
 * @param opts.force  既にファイルがあっても作り直す
 * @param opts.refreshStale
 *   既存ファイルが stale(進行中の期間 / 日次の欠落あり)なら作り直す。
 *   定期実行・後追い生成で使う。手動生成は force を明示しない限り既存を返す。
 */
export async function generatePeriod(
  periodType: PeriodType,
  key: string,
  trigger: PeriodTrigger,
  opts: { force?: boolean; refreshStale?: boolean } = {},
): Promise<PeriodGenerateOutcome> {
  const startedAt = Date.now();
  const label = periodType === "weekly" ? "週次" : "月次";
  try {
    const existing = await readPeriod(periodType, key);
    if (existing && !opts.force) {
      // stale(進行中 / 日次の欠落あり)なものは、後から日次が揃えば内容が変わる。
      // 定期実行・後追いのときだけ作り直す(日次の partial と同じ考え方)。
      if (!(opts.refreshStale && existing.stale)) {
        return {
          periodType,
          key,
          status: "skipped-exists",
          reason: "既に生成済みです(force=true で作り直せます)",
          report: existing,
          durationMs: Date.now() - startedAt,
        };
      }
      console.log(`[reports] ${key}: 日次の欠落 / 進行中のまま作られた${label}レポートを作り直します`);
    }

    const reports = await loadDaysIn(periodType, key);
    if (reports.length === 0) {
      const window = periodWindow(periodType, key);
      console.log(
        `[reports] ${key}(${window.startDate}〜${window.endDate}): ` +
          `対象期間の日次レポートが 1 件も無いため${label}レポートを生成しませんでした`,
      );
      return {
        periodType,
        key,
        status: "skipped-no-data",
        reason: "対象期間の日次レポートが 1 件もありません",
        report: null,
        durationMs: Date.now() - startedAt,
      };
    }

    const report = aggregatePeriod({
      periodType,
      key,
      reports,
      today: todayKey(),
      generatedBy: trigger,
    });
    const file = await writePeriod(report);

    const cov = report.coverage;
    console.log(
      `[reports] ${key} の${label}レポートを保存しました: ${file} ` +
        `(${report.startDate}〜${report.endDate} / 日次 ${cov.availableDays}/${cov.expectedDays} 日` +
        `${cov.missingDays.length > 0 ? ` ・欠落 ${cov.missingDays.join(",")}` : ""}` +
        `${cov.inProgress ? " ・進行中" : ""} / ` +
        `問題 ${report.issues.length} 件 ・起きたこと ${report.highlights.length} 件 ・` +
        `イベント ${report.kpi.events.total} 件 / ${Date.now() - startedAt}ms)`,
    );

    return {
      periodType,
      key,
      status: "generated",
      reason: null,
      report,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[reports] ${key} の${label}レポート生成に失敗:`, err);
    return { periodType, key, status: "failed", reason, report: null, durationMs: Date.now() - startedAt };
  }
}

// ---- 起動時の後追い生成(Task 3-2)----

export interface PeriodCatchUpResult {
  ranAt: string;
  weekly: { checked: string[]; results: Array<{ key: string; status: string }> };
  monthly: { checked: string[]; results: Array<{ key: string; status: string }> };
}

let lastCatchUp: PeriodCatchUpResult | null = null;

export function lastPeriodCatchUpInfo(): PeriodCatchUpResult | null {
  return lastCatchUp;
}

/**
 * 直近 n 期間ぶんを **古い順に** 確認し、欠けている / stale なものを作る。
 *
 * 進行中の期間(今週・今月)も対象に含める。日次と違って生成コストがほぼ 0 なので、
 * 「今週の途中経過」を画面から見られるようにしたほうが有用なため
 * (作られたものは stale=true になり、週が終わってから作り直される)。
 */
async function catchUpOne(
  periodType: PeriodType,
  count: number,
): Promise<{ checked: string[]; results: Array<{ key: string; status: string }> }> {
  const checked: string[] = [];
  const results: Array<{ key: string; status: string }> = [];
  if (count <= 0) return { checked, results };

  const current = currentPeriodKey(periodType);
  const step = (n: number): string =>
    periodType === "weekly" ? addWeekKeys(current, n) : addMonthKeys(current, n);

  for (let i = count - 1; i >= 0; i -= 1) {
    const key = step(-i);
    checked.push(key);
    const r = await generatePeriod(periodType, key, "catchup", { refreshStale: true });
    results.push({ key, status: r.status });
  }
  return { checked, results };
}

export async function catchUpPeriods(): Promise<PeriodCatchUpResult> {
  const { catchUpWeeks, catchUpMonths } = getSettings();
  const weekly = await catchUpOne("weekly", catchUpWeeks);
  const monthly = await catchUpOne("monthly", catchUpMonths);

  const count = (r: { results: Array<{ status: string }> }, s: string): number =>
    r.results.filter((x) => x.status === s).length;
  console.log(
    `[reports] 週次 / 月次の後追い確認が完了: ` +
      `週次 ${weekly.checked.length} 期間(生成 ${count(weekly, "generated")} / データ無し ${count(weekly, "skipped-no-data")} / 既存 ${count(weekly, "skipped-exists")}) ・ ` +
      `月次 ${monthly.checked.length} 期間(生成 ${count(monthly, "generated")} / データ無し ${count(monthly, "skipped-no-data")} / 既存 ${count(monthly, "skipped-exists")})`,
  );

  lastCatchUp = { ranAt: new Date().toISOString(), weekly, monthly };
  return lastCatchUp;
}

/**
 * 日次レポートが 1 日ぶん出来た後に、その日を含む週 / 月を作り直す。
 * 定期実行の 9:00(日次)→ 9:30(週次)の順を待たずに、画面がすぐ最新を見られるようにする。
 * 生成コストがほぼ 0 なので、日次生成のたびに呼んで構わない。
 */
export async function refreshPeriodsForDate(dateKey: string): Promise<void> {
  const targets: Array<[PeriodType, string]> = [
    ["weekly", weekKeyOf(dateKey)],
    ["monthly", dateKey.slice(0, 7)],
  ];
  for (const [periodType, key] of targets) {
    // 中身が変わっているので、既存があっても作り直す(force)。
    await generatePeriod(periodType, key, "catchup", { force: true });
  }
}

/** 生成済みの週 / 月キー(動作確認・status 表示用)。 */
export async function periodKeys(periodType: PeriodType): Promise<string[]> {
  return listPeriodKeys(periodType);
}
