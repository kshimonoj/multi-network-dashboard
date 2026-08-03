// 日次レポート(41)— API ルート。
//
// エンドポイント(View は 42 番で作るので、ここでは生成基盤の口だけ用意する):
//   GET    /status                 … 設定 / スケジュール / サンプラー / 後追い結果 / Retention の現況
//   GET    /settings               … 設定の現在値 + 選択肢
//   PUT    /settings               … 設定変更(cron とサンプラーへ即反映)
//   GET    /daily                  … 生成済みレポートの一覧(軽量メタ)
//   GET    /daily/:date            … 1 日ぶんのレポート全体
//   POST   /daily/generate         … 手動生成(?date=YYYY-MM-DD&force=1)
//   POST   /daily/catchup          … 後追い生成を今すぐ走らせる(動作確認用)
//   GET    /auto-investigations    … 44: 重大な問題の自動事前調査(名寄せキー単位の既調査履歴)
//   POST   /daily/:date/auto-investigate … 44: 保存済みレポートに自動事前調査を仕掛ける(?force=1)
//   POST   /purge                  … Retention を今すぐ走らせる
//   POST   /sample                 … Global Overview のサンプルを 1 行いま記録する(動作確認用)
//
// 生成は LLM を起こすため時間がかかる(数十秒〜)。POST /daily/generate は
// 既定では完了まで待って結果を返す(?wait=0 で即 202 を返すこともできる)。

import { Router } from "express";
import {
  autoInvestigationStatus,
  listAutoInvestigations,
  loadAutoState,
  triggerAutoInvestigations,
} from "./auto-investigate.js";
import { collectDay } from "./collect.js";
import { catchUpMissing, generateDaily, lastCatchUpInfo, runningDate } from "./generate.js";
import { catchUpPeriods, generatePeriod, lastPeriodCatchUpInfo } from "./period-generate.js";
import { restartSampling, sampleOnce, samplerStatus, startSampling } from "./sampler.js";
import { applyAllPeriodSchedules, applyPeriodSchedule, applySchedule, periodScheduleState, scheduleState } from "./schedule.js";
import {
  RETENTION_OPTIONS_DAYS,
  RETENTION_OPTIONS_MONTHS,
  RETENTION_OPTIONS_WEEKS,
  ensureDirs,
  getSettings,
  isPeriodKey,
  lastPurgeInfo,
  listDailyMeta,
  listPeriodMeta,
  loadSettings,
  purgeOld,
  readDaily,
  readPeriod,
  saveSettings,
  startRetentionJob,
} from "./store.js";
import type { PeriodType } from "./types.js";
import { REPORT_TZ, currentPeriodKey, isDateKey, previousPeriodKey, todayKey, yesterdayKey } from "./time.js";

export const router = Router();

/** 起動時の後追い生成をどれだけ遅らせるか。Global Overview / Webhook の初回取得を待つ。 */
const CATCHUP_DELAY_MS = Math.max(0, Number(process.env.REPORTS_CATCHUP_DELAY_MS ?? 90_000));

/**
 * 起動時の初期化。
 *   設定読み込み → ディレクトリ用意 → Retention → サンプリング開始 → cron 登録
 *   → (少し待ってから)欠けている日次レポートの後追い生成
 */
export async function initReports(): Promise<void> {
  await ensureDirs();
  await loadSettings();
  // 44: 既に自動事前調査を済ませた問題(名寄せキー)の履歴。生成より前に読む。
  await loadAutoState();
  await purgeOld();
  startRetentionJob();
  startSampling();
  applySchedule();
  applyAllPeriodSchedules();

  // 45: 週次 / 月次は日次レポートを読むだけ(LLM も外部 API も無し)なので、
  // 日次の後追い生成を待たずにここで先に走らせてよい。
  // 日次が後から生成されれば、その時点で該当する週 / 月が作り直される
  // (generate.ts → refreshPeriodsForDate)。
  await catchUpPeriods().catch((err) => console.error("[reports] 週次 / 月次の後追い生成に失敗:", err));

  if (getSettings().catchUpDays > 0) {
    // 他プラグインの初回ポーリング(Global Overview 5 分間隔 / Webhook ログ)が
    // 走る前に集計すると「データ無し」と誤判定するので、少し待ってから確認する。
    const t = setTimeout(() => {
      catchUpMissing().catch((err) => console.error("[reports] 後追い生成に失敗:", err));
    }, CATCHUP_DELAY_MS);
    t.unref?.();
    console.log(
      `[reports] 起動時の後追い確認を ${Math.round(CATCHUP_DELAY_MS / 1000)} 秒後に実行します(直近 ${getSettings().catchUpDays} 日)`,
    );
  }
}

function statusPayload() {
  return {
    timeZone: REPORT_TZ,
    today: todayKey(),
    yesterday: yesterdayKey(),
    // 45: いま定期実行が発火したら何を作るか / 進行中の期間はどれか
    currentWeek: currentPeriodKey("weekly"),
    previousWeek: previousPeriodKey("weekly"),
    currentMonth: currentPeriodKey("monthly"),
    previousMonth: previousPeriodKey("monthly"),
    settings: getSettings(),
    schedule: scheduleState(),
    weeklySchedule: periodScheduleState("weekly"),
    monthlySchedule: periodScheduleState("monthly"),
    sampler: samplerStatus(),
    retention: lastPurgeInfo(),
    catchUp: lastCatchUpInfo(),
    periodCatchUp: lastPeriodCatchUpInfo(),
    generating: runningDate(),
    autoInvestigation: autoInvestigationStatus(),
  };
}

router.get("/status", async (_req, res) => {
  try {
    res.json({ ...statusPayload(), reports: await listDailyMeta(10) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/settings", (_req, res) => {
  res.json({
    settings: getSettings(),
    retentionOptionsDays: RETENTION_OPTIONS_DAYS,
    retentionOptionsWeeks: RETENTION_OPTIONS_WEEKS,
    retentionOptionsMonths: RETENTION_OPTIONS_MONTHS,
    timeZone: REPORT_TZ,
  });
});

router.put("/settings", async (req, res) => {
  try {
    const before = getSettings();
    const next = await saveSettings(req.body ?? {});
    // 時刻・有効/無効が変わったら cron を張り直す。サンプリング間隔が変わったらタイマーも張り直す。
    if (before.enabled !== next.enabled || before.hour !== next.hour || before.minute !== next.minute) {
      applySchedule();
    }
    if (
      before.weeklyEnabled !== next.weeklyEnabled ||
      before.weeklyWeekday !== next.weeklyWeekday ||
      before.weeklyHour !== next.weeklyHour ||
      before.weeklyMinute !== next.weeklyMinute
    ) {
      applyPeriodSchedule("weekly");
    }
    if (
      before.monthlyEnabled !== next.monthlyEnabled ||
      before.monthlyDay !== next.monthlyDay ||
      before.monthlyHour !== next.monthlyHour ||
      before.monthlyMinute !== next.monthlyMinute
    ) {
      applyPeriodSchedule("monthly");
    }
    if (before.sampleIntervalMs !== next.sampleIntervalMs) restartSampling();
    if (
      before.retentionDays !== next.retentionDays ||
      before.sampleRetentionDays !== next.sampleRetentionDays ||
      before.weeklyRetentionWeeks !== next.weeklyRetentionWeeks ||
      before.monthlyRetentionMonths !== next.monthlyRetentionMonths
    ) {
      await purgeOld();
    }
    res.json({
      settings: next,
      schedule: scheduleState(),
      weeklySchedule: periodScheduleState("weekly"),
      monthlySchedule: periodScheduleState("monthly"),
      retention: lastPurgeInfo(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/daily", async (req, res) => {
  const n = Number(req.query.limit);
  try {
    res.json({ reports: await listDailyMeta(Number.isFinite(n) && n > 0 ? n : 60) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 収集だけを確認する口(LLM を起こさない)。動作確認・デバッグ用。
router.get("/daily/:date/preview", async (req, res) => {
  const date = req.params.date;
  if (!isDateKey(date)) {
    res.status(400).json({ error: "date は YYYY-MM-DD 形式で指定してください" });
    return;
  }
  try {
    const { window, data } = await collectDay(date);
    res.json({ date, window, data });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/daily/:date", async (req, res) => {
  const date = req.params.date;
  if (!isDateKey(date)) {
    res.status(400).json({ error: "date は YYYY-MM-DD 形式で指定してください" });
    return;
  }
  const report = await readDaily(date);
  if (!report) {
    res.status(404).json({ error: "その日のレポートはまだ生成されていません", date });
    return;
  }
  res.json(report);
});

// 手動生成(Task 5-1)。date 省略時は前日分。
router.post("/daily/generate", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const date = String(req.query.date ?? body.date ?? yesterdayKey());
  const force = String(req.query.force ?? body.force ?? "") === "1" || body.force === true;
  const wait = String(req.query.wait ?? "1") !== "0";

  if (!isDateKey(date)) {
    res.status(400).json({ error: "date は YYYY-MM-DD 形式で指定してください", date });
    return;
  }
  if (date > todayKey()) {
    res.status(400).json({ error: "未来の日付は指定できません", date });
    return;
  }

  if (!wait) {
    res.status(202).json({ accepted: true, date, force });
    void generateDaily(date, "manual", { force }).catch((err) =>
      console.error("[reports] 手動生成に失敗:", err),
    );
    return;
  }

  try {
    const outcome = await generateDaily(date, "manual", { force });
    res.status(outcome.status === "failed" ? 500 : 200).json(outcome);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- 45: 週次 / 月次 ----
//
//   GET  /weekly            … 生成済みの週次レポート一覧(軽量メタ)
//   GET  /weekly/:key       … 週次レポート本体("YYYY-Www" / ISO 週・月曜始まり)
//   POST /weekly/generate   … 手動生成(?key=YYYY-Www&force=1。省略時は直前の週)
//   GET  /monthly           … 月次の一覧
//   GET  /monthly/:key      … 月次レポート本体("YYYY-MM")
//   POST /monthly/generate  … 手動生成(?key=YYYY-MM&force=1。省略時は前月)
//   POST /periods/catchup   … 週次 / 月次の後追い生成を今すぐ走らせる
//
// 生成は日次レポートを読んで集計するだけ(LLM なし)なので、必ず完了まで待って結果を返す。

function periodRoutes(periodType: PeriodType): void {
  const base = periodType === "weekly" ? "/weekly" : "/monthly";
  const shape = periodType === "weekly" ? "YYYY-Www(ISO 週)" : "YYYY-MM";

  router.get(base, async (req, res) => {
    const n = Number(req.query.limit);
    try {
      res.json({
        periodType,
        current: currentPeriodKey(periodType),
        reports: await listPeriodMeta(periodType, Number.isFinite(n) && n > 0 ? n : 60),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post(`${base}/generate`, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = String(req.query.key ?? body.key ?? previousPeriodKey(periodType));
    const force = String(req.query.force ?? body.force ?? "") === "1" || body.force === true;
    if (!isPeriodKey(periodType, key)) {
      res.status(400).json({ error: `key は ${shape} 形式で指定してください`, key });
      return;
    }
    try {
      const outcome = await generatePeriod(periodType, key, "manual", { force });
      res.status(outcome.status === "failed" ? 500 : 200).json(outcome);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get(`${base}/:key`, async (req, res) => {
    const key = req.params.key;
    if (!isPeriodKey(periodType, key)) {
      res.status(400).json({ error: `key は ${shape} 形式で指定してください`, key });
      return;
    }
    const report = await readPeriod(periodType, key);
    if (!report) {
      res.status(404).json({ error: "その期間のレポートはまだ生成されていません", key });
      return;
    }
    res.json(report);
  });
}

periodRoutes("weekly");
periodRoutes("monthly");

router.post("/periods/catchup", async (_req, res) => {
  try {
    res.json(await catchUpPeriods());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- 44: 重大な問題の自動事前調査 ----

// 名寄せキー単位の既調査履歴。画面(レポートタブ)はこれを日次レポートの issue.key と
// 突き合わせて「調査結果を見る」/「調査中」を出す。レポート本体(30〜60KB)とは別に取るので、
// 実行中 → 完了の状態変化だけを軽くポーリングできる。
router.get("/auto-investigations", (_req, res) => {
  const entries = listAutoInvestigations();
  res.json({
    ...autoInvestigationStatus(),
    entries: Object.fromEntries(entries.map((e) => [e.key, e])),
  });
});

// 保存済みレポートに対して自動事前調査を今すぐ仕掛ける(動作確認用)。
// force=1 は「対象日の古さ」と「設定の有効/無効」だけを無視する。
// 重複防止(名寄せキー)と上限件数は force でも必ず効く。
router.post("/daily/:date/auto-investigate", async (req, res) => {
  const date = req.params.date;
  if (!isDateKey(date)) {
    res.status(400).json({ error: "date は YYYY-MM-DD 形式で指定してください" });
    return;
  }
  const report = await readDaily(date);
  if (!report) {
    res.status(404).json({ error: "その日のレポートはまだ生成されていません", date });
    return;
  }
  const force = String(req.query.force ?? "") === "1";
  try {
    res.json(await triggerAutoInvestigations(report, { force }));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 後追い生成を今すぐ(Task 5-4 の確認用)。
router.post("/daily/catchup", async (_req, res) => {
  try {
    res.json(await catchUpMissing());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/purge", async (_req, res) => {
  try {
    res.json(await purgeOld());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// サンプルを 1 行いま記録する(Task 5 の確認用。force=1 で同じスナップショットでも書く)。
router.post("/sample", async (req, res) => {
  const force = String(req.query.force ?? "") === "1";
  try {
    const sample = await sampleOnce(force);
    res.json({ recorded: sample !== null, sample, sampler: samplerStatus() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
