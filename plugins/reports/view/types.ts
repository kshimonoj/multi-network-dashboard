// レポートタブ View(43)— サーバ型のミラー。
//
// 実体は plugins/reports/types.ts。View から server 側の .ts を直接 import しないのは
// 既存プラグイン(global-overview / webhook-feed / central-streaming)の流儀に合わせるため。
// サーバ側の型を変えたらここも合わせる。
//
// 43 番の画面が実際に読むフィールドだけを写す(生成基盤側の設定型 ReportSettings 等は持たない)。

export type ReportPlatform = "central" | "mist" | "glp" | "other";
export type IssueSeverity = "critical" | "warning" | "info";
export type RecurrenceStatus = "new" | "recurring" | "continuing";

export interface MinMaxAvg {
  avg: number | null;
  min: number | null;
  max: number | null;
  samples: number;
}

export interface DailySiteStat {
  siteName: string;
  platform: "central" | "mist";
  siteId: string | null;
  centralHealth: MinMaxAvg | null;
  mistSle: MinMaxAvg | null;
  mistSleMetrics: Array<{ label: string; avg: number | null }>;
  clients: MinMaxAvg;
  devices: { total: number; upMin: number | null; downMax: number | null };
  alerts: { max: number | null; criticalMax: number | null };
  samples: number;
}

export interface DailyOverview {
  source: "samples" | "current-snapshot" | "none";
  sampleCount: number;
  firstSampleAt: string | null;
  lastSampleAt: string | null;
  totals: {
    sites: number;
    devices: number;
    devicesUp: MinMaxAvg;
    devicesDown: MinMaxAvg;
    clients: MinMaxAvg;
    alerts: MinMaxAvg;
  };
  sites: DailySiteStat[];
  traffic: { available: false; reason: string };
  notes: string[];
}

export interface DailyWebhook {
  available: boolean;
  reason: string | null;
  source?: "archive" | "memory";
  partial?: boolean;
  total: number;
  bySeverity: Record<string, number>;
  bySource: Record<string, number>;
  byCategory: Record<string, number>;
  byType: Record<string, number>;
  critical: Array<{
    at: string | null;
    source: string;
    severity: string;
    siteName: string | null;
    deviceLabel: string | null;
    message: string;
  }>;
  truncated: { critical: number; warning: number };
}

export interface DailyStreaming {
  available: boolean;
  reason: string | null;
  total: number;
  auditTrail: { total: number; truncated: number };
}

export interface DailyInvestigations {
  total: number;
  bySource: Record<string, number>;
  errors: number;
  truncated: number;
}

export interface DailyRawSummary {
  overview: DailyOverview;
  webhook: DailyWebhook;
  streaming: DailyStreaming;
  investigations: DailyInvestigations;
}

/** 「この期間に起きたこと」1 件。 */
export interface DailyHighlight {
  at: string | null;
  device: string | null;
  site: string | null;
  platform: ReportPlatform | null;
  severity: IssueSeverity;
  title: string;
  detail: string;
  source: string;
}

/**
 * 44: 重大な問題の自動事前調査 1 件(名寄せキー単位)。
 * レポート本体には入っていない。GET /api/reports/auto-investigations で別途取り、
 * 画面側で issue.key と突き合わせる(実行中 → 完了の変化を軽くポーリングするため)。
 */
export interface AutoInvestigationEntry {
  key: string;
  issueName: string;
  site: string | null;
  device: string | null;
  severity: IssueSeverity;
  recurrence: RecurrenceStatus;
  status: "running" | "done" | "error";
  /** 発火した日次レポートの対象日 */
  date: string;
  runId: string | null;
  sessionId: string | null;
  startedAt: string;
  finishedAt: string | null;
  query: string;
  summary: string;
  error: string | null;
}

/** GET /api/reports/auto-investigations の応答。 */
export interface AutoInvestigationsResponse {
  enabled: boolean;
  maxPerReport: number;
  maxAgeDays: number;
  total: number;
  running: number;
  done: number;
  error: number;
  entries: Record<string, AutoInvestigationEntry>;
}

/** 「検出された問題」1 件。 */
export interface DailyIssue {
  key: string;
  name: string;
  device: string | null;
  site: string | null;
  platform: ReportPlatform | null;
  severity: IssueSeverity;
  firstSeenAt: string | null;
  occurrences: number;
  rootCause: string;
  impact: string;
  nextAction: string;
  recurrence: {
    status: RecurrenceStatus;
    previousDates: string[];
    firstSeenDate: string;
    note: string;
  };
}

export interface DailyAnalysis {
  status: "ok" | "error" | "skipped";
  summary: string;
  highlights: DailyHighlight[];
  issues: DailyIssue[];
  error: string | null;
}

export interface DailyReport {
  schemaVersion: number;
  date: string;
  timeZone: string;
  window: { startIso: string; endIso: string };
  generatedAt: string;
  generatedBy: "schedule" | "manual" | "catchup";
  partial: boolean;
  lang: "ja" | "en";
  llm: {
    status: "ok" | "error" | "skipped";
    model: string | null;
    durationMs: number | null;
    attempts: number;
    error: string | null;
  };
  data: DailyRawSummary;
  analysis: DailyAnalysis;
}

/** GET /api/reports/daily が返す軽量メタ。カレンダーの「生成済みの日」判定に使う。 */
export interface DailyReportMeta {
  date: string;
  generatedAt: string;
  generatedBy: string;
  partial: boolean;
  analysisStatus: string;
  highlights: number;
  issues: number;
  criticalIssues: number;
  webhookTotal: number;
  bytes: number;
}

/** 期間タブ。 */
export type ReportPeriod = "daily" | "weekly" | "monthly";

// ---- 45: 週次 / 月次 ----
//
// 実体は plugins/reports/types.ts の Period*。ここも「画面が読むフィールドだけ」を写す。
// 週次 / 月次は LLM を使わない機械集計なので、analysis(総括の文章)を持たない。
// 総括・注記は notes(コード + 値)を辞書で文にして出す(CLAUDE.md「サーバ生成の文言」)。

export type PeriodType = "weekly" | "monthly";

export interface PeriodCoverage {
  periodDays: number;
  expectedDays: number;
  availableDays: number;
  days: string[];
  missingDays: string[];
  partialDays: string[];
  analysisFailedDays: string[];
  inProgress: boolean;
  complete: boolean;
}

export interface PeriodStat {
  avg: number | null;
  min: number | null;
  max: number | null;
  minDate: string | null;
  maxDate: string | null;
  days: number;
}

export interface PeriodKpi {
  events: {
    total: number;
    perDayAvg: number | null;
    countedDays: number;
    unavailableDays: string[];
    busiestDate: string | null;
    busiestValue: number;
  };
  alerts: {
    critical: number;
    warning: number;
    perDayAvgCritical: number | null;
    worstDate: string | null;
    worstValue: number;
  };
  clients: PeriodStat;
  issues: {
    unique: number;
    new: number;
    carried: number;
    critical: number;
    warning: number;
    info: number;
    dayTotal: number;
  };
  investigations: { total: number; errors: number; bySource: Record<string, number> };
}

export interface PeriodTrendPoint {
  key: string;
  startDate: string;
  endDate: string;
  label: string;
  days: number;
  centralHealth: number | null;
  mistSle: number | null;
  clients: number | null;
  events: number;
  criticalAlerts: number;
  issues: number;
}

export interface PeriodSiteStat {
  siteName: string;
  platform: "central" | "mist";
  siteId: string | null;
  centralHealth: number | null;
  mistSle: number | null;
  clients: number | null;
  clientsMax: number | null;
  days: number;
}

export interface PeriodHighlight {
  date: string;
  dates: string[];
  at: string | null;
  device: string | null;
  site: string | null;
  platform: ReportPlatform | null;
  severity: IssueSeverity;
  title: string;
  detail: string;
  source: string;
  count: number;
}

export interface PeriodIssue {
  key: string;
  name: string;
  device: string | null;
  site: string | null;
  platform: ReportPlatform | null;
  severity: IssueSeverity;
  dates: string[];
  days: number;
  occurrences: number;
  firstSeenAt: string | null;
  streak: number;
  carriedOver: boolean;
  status: "new" | "carried";
  firstSeenDate: string;
  previousDates: string[];
  rootCause: string;
  impact: string;
  nextAction: string;
  recurrenceNote: string;
}

/** 画面側の辞書 reports.periodNote.<code> で文にする注記。 */
export interface PeriodNote {
  code: string;
  params?: Record<string, string | number>;
}

export interface PeriodReport {
  schemaVersion: number;
  periodType: PeriodType;
  key: string;
  startDate: string;
  endDate: string;
  timeZone: string;
  generatedAt: string;
  generatedBy: "schedule" | "manual" | "catchup";
  stale: boolean;
  coverage: PeriodCoverage;
  kpi: PeriodKpi;
  trend: { granularity: "day" | "week"; points: PeriodTrendPoint[] };
  sites: PeriodSiteStat[];
  breakdown: {
    webhook: {
      bySeverity: Record<string, number>;
      bySource: Record<string, number>;
      byCategory: Record<string, number>;
      byType: Record<string, number>;
    };
    streaming: { total: number; byStream: Record<string, number>; auditTrail: number };
  };
  highlights: PeriodHighlight[];
  highlightsTruncated: number;
  issues: PeriodIssue[];
  sourceReports: Array<{
    date: string;
    generatedAt: string;
    analysisStatus: string;
    lang: string;
    partial: boolean;
    highlights: number;
    issues: number;
    events: number;
  }>;
  langs: Record<string, number>;
  notes: PeriodNote[];
}

/** GET /api/reports/weekly ・/monthly が返す軽量メタ。カレンダーの「生成済み」判定に使う。 */
export interface PeriodReportMeta {
  key: string;
  periodType: PeriodType;
  startDate: string;
  endDate: string;
  generatedAt: string;
  generatedBy: string;
  availableDays: number;
  expectedDays: number;
  periodDays: number;
  complete: boolean;
  inProgress: boolean;
  stale: boolean;
  issues: number;
  criticalIssues: number;
  newIssues: number;
  events: number;
  criticalAlerts: number;
  bytes: number;
}
