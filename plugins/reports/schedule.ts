// 日次レポート(41 Task 3)— 定期生成(node-cron)。
//
// network-investigation/schedule.ts と同じ形にしてある(コンテナに launchd が無いので、
// このプロセス内に cron ジョブを 1 本持ち、設定が変わるたびに張り替える)。
// 違いは「毎日 9:00 に **前日分** を作る」点だけ。時刻は設定から変更できる(Task 3-2)。

import cron, { type ScheduledTask } from "node-cron";
import { generateDaily } from "./generate.js";
import { generatePeriod } from "./period-generate.js";
import { getSettings } from "./store.js";
import type { PeriodType } from "./types.js";
import { REPORT_TZ, previousPeriodKey, yesterdayKey } from "./time.js";

let task: ScheduledTask | null = null;
let expression: string | null = null;
let lastRunAt: string | null = null;
let lastRunResult: string | null = null;

export interface ReportScheduleState {
  enabled: boolean;
  expression: string | null;
  loaded: boolean;
  timeZone: string;
  /** 次の発火時刻(ローカル "YYYY-MM-DD HH:mm")。無効なら null */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunResult: string | null;
}

/** ScheduleConfig → cron 式(分 時 * * *)。毎日固定なので曜日は使わない。 */
export function buildCronExpression(hour: number, minute: number): string {
  return `${minute} ${hour} * * *`;
}

function nextRunLabel(hour: number, minute: number): string {
  // 「次にこの時刻が来るのはいつか」をローカル時刻の文字列で返す(表示・確認用)。
  const now = new Date();
  const local = new Date(now.toLocaleString("en-US", { timeZone: REPORT_TZ }));
  const target = new Date(local);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= local.getTime()) target.setDate(target.getDate() + 1);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${target.getFullYear()}-${p(target.getMonth() + 1)}-${p(target.getDate())} ${p(target.getHours())}:${p(target.getMinutes())}`;
}

/** 現在の設定で cron ジョブを張り直す。enabled=false ならジョブを破棄するだけ。 */
export function applySchedule(): ReportScheduleState {
  if (task) {
    task.stop();
    task = null;
    expression = null;
  }

  const { enabled, hour, minute } = getSettings();
  if (!enabled) {
    console.log("[reports] 定期生成は無効です(cron ジョブを停止しました)");
    return {
      enabled: false,
      expression: null,
      loaded: false,
      timeZone: REPORT_TZ,
      nextRunAt: null,
      lastRunAt,
      lastRunResult,
    };
  }

  const expr = buildCronExpression(hour, minute);
  if (!cron.validate(expr)) {
    console.warn(`[reports] cron 式が不正です: ${expr}`);
    return {
      enabled: true,
      expression: expr,
      loaded: false,
      timeZone: REPORT_TZ,
      nextRunAt: null,
      lastRunAt,
      lastRunResult,
    };
  }

  task = cron.schedule(
    expr,
    () => {
      // 9:00 に走るので対象は「前日 0:00〜24:00」。
      const target = yesterdayKey();
      lastRunAt = new Date().toISOString();
      console.log(`[reports] 定期生成を開始します: 対象日=${target}(cron "${expr}" / TZ=${REPORT_TZ})`);
      void generateDaily(target, "schedule")
        .then((r) => {
          lastRunResult = `${r.date}: ${r.status}${r.reason ? ` — ${r.reason}` : ""}`;
          console.log(`[reports] 定期生成が完了しました: ${lastRunResult}`);
        })
        .catch((err) => {
          lastRunResult = `error: ${err instanceof Error ? err.message : String(err)}`;
          console.error("[reports] 定期生成に失敗しました:", err);
        });
    },
    { timezone: REPORT_TZ },
  );
  expression = expr;

  const hhmm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  console.log(
    `[reports] 定期生成を設定しました: 毎日 ${hhmm} に前日分(cron "${expr}" / TZ=${REPORT_TZ} / 次回 ${nextRunLabel(hour, minute)})`,
  );

  return {
    enabled: true,
    expression: expr,
    loaded: true,
    timeZone: REPORT_TZ,
    nextRunAt: nextRunLabel(hour, minute),
    lastRunAt,
    lastRunResult,
  };
}

export function scheduleState(): ReportScheduleState {
  const { enabled, hour, minute } = getSettings();
  return {
    enabled,
    expression,
    loaded: task !== null,
    timeZone: REPORT_TZ,
    nextRunAt: task ? nextRunLabel(hour, minute) : null,
    lastRunAt,
    lastRunResult,
  };
}

// ---- 45: 週次 / 月次の定期生成 ----
//
// 日次と同じ形(このプロセス内に cron ジョブを持ち、設定が変わるたびに張り替える)。
// 対象は必ず「直前の完了した期間」= 今の週 / 月の 1 つ前(previousPeriodKey)。
// 発火する曜日 / 日を設定で変えても対象がずれないよう、前日を見る形にはしていない。

interface PeriodJob {
  task: ScheduledTask | null;
  expression: string | null;
  lastRunAt: string | null;
  lastRunResult: string | null;
}

const jobs: Record<PeriodType, PeriodJob> = {
  weekly: { task: null, expression: null, lastRunAt: null, lastRunResult: null },
  monthly: { task: null, expression: null, lastRunAt: null, lastRunResult: null },
};

export interface PeriodScheduleState {
  enabled: boolean;
  expression: string | null;
  loaded: boolean;
  timeZone: string;
  /** 対象になる期間キー(いま発火したら何を作るか) */
  targetKey: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunResult: string | null;
}

/** 週次: 分 時 * * 曜日 / 月次: 分 時 日 * * */
export function buildPeriodCronExpression(
  periodType: PeriodType,
  hour: number,
  minute: number,
  dayOrWeekday: number,
): string {
  return periodType === "weekly"
    ? `${minute} ${hour} * * ${dayOrWeekday}`
    : `${minute} ${hour} ${dayOrWeekday} * *`;
}

/** 次に発火する日時(ローカル "YYYY-MM-DD HH:mm")。表示・確認用。 */
function nextPeriodRunLabel(
  periodType: PeriodType,
  hour: number,
  minute: number,
  dayOrWeekday: number,
): string {
  const now = new Date();
  const local = new Date(now.toLocaleString("en-US", { timeZone: REPORT_TZ }));
  const target = new Date(local);
  target.setHours(hour, minute, 0, 0);

  if (periodType === "weekly") {
    const diff = (dayOrWeekday - target.getDay() + 7) % 7;
    target.setDate(target.getDate() + diff);
    if (target.getTime() <= local.getTime()) target.setDate(target.getDate() + 7);
  } else {
    target.setDate(dayOrWeekday);
    if (target.getTime() <= local.getTime()) target.setMonth(target.getMonth() + 1, dayOrWeekday);
  }
  const p = (n: number) => String(n).padStart(2, "0");
  return `${target.getFullYear()}-${p(target.getMonth() + 1)}-${p(target.getDate())} ${p(target.getHours())}:${p(target.getMinutes())}`;
}

function periodParams(periodType: PeriodType): {
  enabled: boolean;
  hour: number;
  minute: number;
  dayOrWeekday: number;
} {
  const s = getSettings();
  return periodType === "weekly"
    ? { enabled: s.weeklyEnabled, hour: s.weeklyHour, minute: s.weeklyMinute, dayOrWeekday: s.weeklyWeekday }
    : { enabled: s.monthlyEnabled, hour: s.monthlyHour, minute: s.monthlyMinute, dayOrWeekday: s.monthlyDay };
}

export function applyPeriodSchedule(periodType: PeriodType): PeriodScheduleState {
  const job = jobs[periodType];
  const label = periodType === "weekly" ? "週次" : "月次";
  if (job.task) {
    job.task.stop();
    job.task = null;
    job.expression = null;
  }

  const { enabled, hour, minute, dayOrWeekday } = periodParams(periodType);
  const base = {
    timeZone: REPORT_TZ,
    targetKey: previousPeriodKey(periodType),
    lastRunAt: job.lastRunAt,
    lastRunResult: job.lastRunResult,
  };
  if (!enabled) {
    console.log(`[reports] ${label}レポートの定期生成は無効です(cron ジョブを停止しました)`);
    return { ...base, enabled: false, expression: null, loaded: false, nextRunAt: null };
  }

  const expr = buildPeriodCronExpression(periodType, hour, minute, dayOrWeekday);
  if (!cron.validate(expr)) {
    console.warn(`[reports] ${label}の cron 式が不正です: ${expr}`);
    return { ...base, enabled: true, expression: expr, loaded: false, nextRunAt: null };
  }

  job.task = cron.schedule(
    expr,
    () => {
      const target = previousPeriodKey(periodType);
      job.lastRunAt = new Date().toISOString();
      console.log(`[reports] ${label}レポートの定期生成を開始します: 対象=${target}(cron "${expr}" / TZ=${REPORT_TZ})`);
      // その期間の日次レポートが後から揃っていることがあるので、既存があっても作り直す。
      void generatePeriod(periodType, target, "schedule", { force: true })
        .then((r) => {
          job.lastRunResult = `${r.key}: ${r.status}${r.reason ? ` — ${r.reason}` : ""}`;
          console.log(`[reports] ${label}レポートの定期生成が完了しました: ${job.lastRunResult}`);
        })
        .catch((err) => {
          job.lastRunResult = `error: ${err instanceof Error ? err.message : String(err)}`;
          console.error(`[reports] ${label}レポートの定期生成に失敗しました:`, err);
        });
    },
    { timezone: REPORT_TZ },
  );
  job.expression = expr;

  const hhmm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const when =
    periodType === "weekly"
      ? `毎週${["日", "月", "火", "水", "木", "金", "土"][dayOrWeekday]}曜 ${hhmm}`
      : `毎月 ${dayOrWeekday} 日 ${hhmm}`;
  console.log(
    `[reports] ${label}レポートの定期生成を設定しました: ${when} に直前の期間ぶん ` +
      `(cron "${expr}" / TZ=${REPORT_TZ} / 次回 ${nextPeriodRunLabel(periodType, hour, minute, dayOrWeekday)} / いまの対象 ${base.targetKey})`,
  );

  return {
    ...base,
    enabled: true,
    expression: expr,
    loaded: true,
    nextRunAt: nextPeriodRunLabel(periodType, hour, minute, dayOrWeekday),
  };
}

export function periodScheduleState(periodType: PeriodType): PeriodScheduleState {
  const job = jobs[periodType];
  const { enabled, hour, minute, dayOrWeekday } = periodParams(periodType);
  return {
    enabled,
    expression: job.expression,
    loaded: job.task !== null,
    timeZone: REPORT_TZ,
    targetKey: previousPeriodKey(periodType),
    nextRunAt: job.task ? nextPeriodRunLabel(periodType, hour, minute, dayOrWeekday) : null,
    lastRunAt: job.lastRunAt,
    lastRunResult: job.lastRunResult,
  };
}

/** 週次・月次の cron をまとめて張り直す。 */
export function applyAllPeriodSchedules(): Record<PeriodType, PeriodScheduleState> {
  return { weekly: applyPeriodSchedule("weekly"), monthly: applyPeriodSchedule("monthly") };
}
