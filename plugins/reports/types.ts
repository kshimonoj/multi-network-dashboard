// 日次レポート(41)— サーバ / View 共有のデータ型。
//
// ---- 設計方針 ----
// 1) **週次 / 月次(43 番)は日次レポートの再集計で作る**。生データへ遡って問い合わせ直さない。
//    そのため日次レポートには「文章」だけでなく、足し算・平均が取れる **数値と件数** を必ず残す。
//    平均を再計算できるよう、平均値には必ず母数(sampleCount / days)を添える。
// 2) 問題(issue)には **安定キー(key)** を持たせる。43 番はこのキーで日をまたいだ名寄せをする。
//    キーは LLM に作らせるが、過去日との突き合わせ(previousDates)は
//    サーバ側で機械的に行う(LLM の記憶に依存しない)。
// 3) LLM が落ちてもレポートは成立させる。analysis.status="error" でも data 部は完全な形で残す。

export type ReportPlatform = "central" | "mist" | "glp" | "other";
export type IssueSeverity = "critical" | "warning" | "info";
/** new = 当日が初出 / recurring = 過去にも出ていて間が空いた / continuing = 前日から継続 */
export type RecurrenceStatus = "new" | "recurring" | "continuing";

// ---- Task 1: 収集した当日分の生データ集約 ----

export interface MinMaxAvg {
  avg: number | null;
  min: number | null;
  max: number | null;
  /** この統計の母数(サンプル数)。43 番が日をまたいで平均を取り直すのに要る */
  samples: number;
}

export interface DailySiteStat {
  siteName: string;
  platform: "central" | "mist";
  siteId: string | null;
  /** Central のサイト健全性スコア(0-100)。Mist は null */
  centralHealth: MinMaxAvg | null;
  /** Mist SLE 総合スコア(0-100。取得できた指標の平均)。Central は null */
  mistSle: MinMaxAvg | null;
  /** Mist SLE の指標別の当日平均(Coverage / Capacity / …)。Central は空配列 */
  mistSleMetrics: Array<{ label: string; avg: number | null }>;
  clients: MinMaxAvg;
  devices: { total: number; upMin: number | null; downMax: number | null };
  alerts: { max: number | null; criticalMax: number | null };
  /** このサイトが載っていたサンプル数 */
  samples: number;
}

export interface DailyOverview {
  /**
   * samples          … 当日 5 分間隔で溜めたサンプルを平均した(通常運用)
   * current-snapshot … 当日分のサンプルが無く、実行時点のスナップショットで代用した
   * none             … どちらも無い(Global Overview 未設定 / 蓄積開始前)
   */
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
  /**
   * トラフィック量(bps / バイト)。既存の取得経路には該当 API が無いため、
   * 取れなかった理由を機械可読に残す(42/43 が「未計測」と表示できるように)。
   */
  traffic: { available: false; reason: string };
  notes: string[];
}

export interface DailyWebhookAlert {
  at: string | null;
  source: string;
  severity: string;
  severityRaw: string | null;
  siteName: string | null;
  deviceLabel: string | null;
  category: string | null;
  type: string | null;
  message: string;
  alertKey: string;
}

export interface DailyWebhook {
  available: boolean;
  /** 取れなかった理由。available=true でも「途中から記録」等の注記が入ることがある(42) */
  reason: string | null;
  /**
   * 42: 集計の出どころ。
   *   archive … data/webhook-feed/daily/YYYY-MM-DD.jsonl(保持上限に左右されない正本)
   *   memory  … 旧方式(表示用キャッシュを期間で絞ったもの。上限で切られている可能性あり)
   */
  source?: "archive" | "memory";
  /** その日のアーカイブが 0:00 からではなく途中から始まっている(移行日・保存開始日) */
  partial?: boolean;
  total: number;
  bySeverity: Record<string, number>;
  bySource: Record<string, number>;
  byCategory: Record<string, number>;
  byType: Record<string, number>;
  /** 個別に残す重大アラート(critical。多い日は上限で打ち切り、truncated に残数を出す) */
  critical: DailyWebhookAlert[];
  /** warning のうち代表的なもの(件数把握は bySeverity 側で行う) */
  warning: DailyWebhookAlert[];
  truncated: { critical: number; warning: number };
}

export interface DailyAuditEvent {
  at: string | null;
  stream: string;
  typeLabel: string;
  category: string | null;
  actor: string | null;
  siteName: string | null;
  deviceLabel: string | null;
  summary: string;
}

export interface DailyStreaming {
  available: boolean;
  reason: string | null;
  total: number;
  byStream: Record<string, number>;
  auditTrail: { total: number; items: DailyAuditEvent[]; truncated: number };
}

export interface DailyInvestigation {
  at: string;
  runId: string;
  query: string;
  site: string | null;
  source: "manual" | "scheduled" | "auto";
  model: string | null;
  isError: boolean;
}

export interface DailyInvestigations {
  total: number;
  bySource: Record<string, number>;
  errors: number;
  items: DailyInvestigation[];
  truncated: number;
  /** 同じ内容が繰り返し調べられている手がかり(正規化クエリ + サイトでまとめた) */
  repeated: Array<{ query: string; site: string | null; count: number; firstAt: string; lastAt: string }>;
}

export interface DailyRawSummary {
  overview: DailyOverview;
  webhook: DailyWebhook;
  streaming: DailyStreaming;
  investigations: DailyInvestigations;
}

// ---- Task 2: LLM 分析 ----

/** 「この期間に起きたこと」1 件。 */
export interface DailyHighlight {
  /** 発生日時(ISO)。特定できなければ null */
  at: string | null;
  /** 対象機器(シリアル / MAC / ホスト名)。無ければ null */
  device: string | null;
  site: string | null;
  platform: ReportPlatform | null;
  severity: IssueSeverity;
  /** 一行の見出し */
  title: string;
  /** 内容(何が起きたか) */
  detail: string;
  /** 根拠にしたデータ源(webhook / streaming / overview / investigation) */
  source: string;
}

/**
 * 44: 重大な問題に対する「MCP 込みの本格調査」1 回ぶんの記録。
 *
 * 実体は data/reports/auto-investigations.json(名寄せキー単位)に置き、
 * 日次レポート JSON には焼き込まない。理由は 2 つ:
 *   - 調査はレポート保存後にバックグラウンドで走る(running → done と状態が変わる)。
 *     レポート本体に書くと、その都度 30〜60KB のファイルを書き直すことになる。
 *   - 同じ問題(名寄せキー)は翌日以降のレポートにも出る。キー単位で 1 本持てば
 *     「過去に調査済み」をどの日のレポートからも同じように参照できる。
 */
export interface IssueAutoInvestigation {
  status: "running" | "done" | "error";
  /** 発火した日次レポートの対象日(YYYY-MM-DD) */
  date: string;
  /** Insight Agent の実行 ID(= query-history の record.id)。画面の「調査結果を見る」はこれで飛ぶ */
  runId: string | null;
  sessionId: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** 実際に投げたクエリ文(実行時の記録なので後から翻訳しない) */
  query: string;
  /** 回答の冒頭(行を開いたときに出す要約) */
  summary: string;
  error: string | null;
}

/** 名寄せキー単位で永続化する 1 レコード(state ファイルの中身)。 */
export interface AutoInvestigationEntry extends IssueAutoInvestigation {
  key: string;
  issueName: string;
  site: string | null;
  device: string | null;
  severity: IssueSeverity;
  recurrence: RecurrenceStatus;
}

/** 「検出された問題」1 件。42 番が表としてそのまま描ける粒度にする。 */
export interface DailyIssue {
  /**
   * 日をまたいだ名寄せキー。小文字英数とハイフンのみ。
   * 例: "ap-offline:ap-1f-north" / "wan-latency:site-tokyo"
   * LLM に作らせるが、サーバ側で正規化してから採用する。
   */
  key: string;
  name: string;
  device: string | null;
  site: string | null;
  platform: ReportPlatform | null;
  severity: IssueSeverity;
  /** 初回発生日時(当日分の中での最初。過去日を含む初出は recurrence.firstSeenDate) */
  firstSeenAt: string | null;
  occurrences: number;
  rootCause: string;
  impact: string;
  nextAction: string;
  recurrence: {
    status: RecurrenceStatus;
    /** 同じ key を持つ過去の日次レポートの日付(新しい順。サーバ側で機械的に付ける) */
    previousDates: string[];
    /** 過去日を含めた初出日。過去に無ければ当日 */
    firstSeenDate: string;
    /** LLM が書いた再発性の補足 */
    note: string;
  };
}

export interface DailyAnalysis {
  status: "ok" | "error" | "skipped";
  /** 1〜2 行の総括 */
  summary: string;
  highlights: DailyHighlight[];
  issues: DailyIssue[];
  error: string | null;
}

// ---- レポート本体 ----

export const REPORT_SCHEMA_VERSION = 1;

export interface DailyReport {
  schemaVersion: number;
  /** 対象日(ローカル TZ の暦日) */
  date: string;
  timeZone: string;
  window: { startIso: string; endIso: string };
  generatedAt: string;
  generatedBy: "schedule" | "manual" | "catchup";
  /**
   * その日が終わる前に作られたレポート(= 当日分を途中で生成した)。
   * 定期実行・後追い生成は、これを「未完成」とみなして作り直す
   * (手動で当日分を覗いた結果が、翌朝の正式なレポートを塞がないようにするため)。
   */
  partial: boolean;
  /** 分析文の言語(記録として残る文言なので、後から翻訳はしない) */
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

/** 一覧 API が返す軽量メタ(本文を読まずに件数だけ見せる用)。 */
export interface DailyReportMeta {
  date: string;
  generatedAt: string;
  generatedBy: string;
  /** その日が終わる前に作られた未完成レポートか */
  partial: boolean;
  analysisStatus: string;
  highlights: number;
  issues: number;
  criticalIssues: number;
  webhookTotal: number;
  bytes: number;
}

// ---- 週次 / 月次(45)----
//
// ---- 設計方針 ----
// 1) **生データへ問い合わせ直さない**。蓄積済みの日次レポート(data/reports/daily/*.json)だけを
//    材料にする(41 番の時点で決まっていた前提。日次レポートが「数値 + 母数」を持っているのはこのため)。
// 2) **LLM を使わない**。集計材料はすべて確定済みなので、平均・合算・名寄せは機械的に出せる。
//    文章化が要る部分(総括)は、サーバで文を組み立てず **機械可読なコード + 値**(PeriodNote)を返し、
//    画面側の辞書で日英の文にする(CLAUDE.md「サーバ生成の文言を画面に出すとき」)。
// 3) 対象期間の日次レポートが一部欠けていても **エラーにせず**、揃っている日だけで集計して
//    coverage に欠落を残す(Task 2-3)。1 件も無いときだけ生成しない(Task 2-4)。

export type PeriodType = "weekly" | "monthly";

export const PERIOD_REPORT_SCHEMA_VERSION = 1;

/** 対象期間のうち、どれだけの日次レポートが揃っていたか。 */
export interface PeriodCoverage {
  /** 期間の暦日数(週=7 / 月=28〜31) */
  periodDays: number;
  /**
   * 「揃っているべき日」の数 = 期間内で **既に終わった日**(生成時点の前日まで)。
   * 進行中の週 / 月を集計したとき、まだ来ていない日を「欠落」と数えないための区別。
   */
  expectedDays: number;
  availableDays: number;
  /** 実際に集計に使った日(昇順) */
  days: string[];
  /** 終わっているのに日次レポートが無かった日(昇順) */
  missingDays: string[];
  /** 未完成(partial=true)のまま取り込んだ日 */
  partialDays: string[];
  /** 日次の LLM 分析が失敗していた日(数値は使えるが、問題 / 起きたことが空) */
  analysisFailedDays: string[];
  /** 期間の終わりがまだ来ていない(進行中の週 / 月を集計した) */
  inProgress: boolean;
  /** 終わった日がすべて揃っている(欠落なし) */
  complete: boolean;
}

/** 期間内の推移統計(母数と、最大 / 最小を記録した日を添える)。 */
export interface PeriodStat {
  avg: number | null;
  min: number | null;
  max: number | null;
  minDate: string | null;
  maxDate: string | null;
  /** この統計に寄与した日数 */
  days: number;
}

export interface PeriodKpi {
  /** 総イベント数(Webhook ログ)。期間合算 */
  events: {
    total: number;
    perDayAvg: number | null;
    /** 集計に使えた日数(Webhook が未取得だった日は除く) */
    countedDays: number;
    unavailableDays: string[];
    busiestDate: string | null;
    busiestValue: number;
  };
  /** 重大アラート数(Webhook の critical)。期間合算 */
  alerts: {
    critical: number;
    warning: number;
    perDayAvgCritical: number | null;
    worstDate: string | null;
    worstValue: number;
  };
  /** 接続端末数。日次平均をサンプル数で重み付けして平均する */
  clients: PeriodStat;
  /** 問題の件数。unique = 名寄せ後の件数 / dayTotal = 日次の延べ件数 */
  issues: {
    unique: number;
    /** 期間内が初出の問題(期間より前から続いていないもの) */
    new: number;
    /** 期間より前から続いている問題 */
    carried: number;
    critical: number;
    warning: number;
    info: number;
    dayTotal: number;
  };
  investigations: { total: number; errors: number; bySource: Record<string, number> };
}

/** グラフ用の 1 点。週次は 1 日 = 1 点、月次は 1 週 = 1 点に間引く。 */
export interface PeriodTrendPoint {
  /** 日次点なら "YYYY-MM-DD"、週次点なら "YYYY-Www" */
  key: string;
  startDate: string;
  endDate: string;
  /** ロケール非依存の軸ラベル("7/27" / "7/27–8/2") */
  label: string;
  /** この点に寄与した日次レポートの日数 */
  days: number;
  centralHealth: number | null;
  mistSle: number | null;
  clients: number | null;
  events: number;
  criticalAlerts: number;
  issues: number;
}

/** サイト別の期間集計(サイト詳細ページへの導線に使う)。 */
export interface PeriodSiteStat {
  siteName: string;
  platform: "central" | "mist";
  siteId: string | null;
  /** 期間平均(サンプル数で重み付け) */
  centralHealth: number | null;
  mistSle: number | null;
  clients: number | null;
  clientsMax: number | null;
  /** このサイトが載っていた日数 */
  days: number;
}

/** 「この期間に起きたこと」1 件(日次の highlights から重要度順に抜粋・統合したもの)。 */
export interface PeriodHighlight {
  /** 代表日(この内容が最後に出た日) */
  date: string;
  /** 同じ内容が出た日(昇順) */
  dates: string[];
  at: string | null;
  device: string | null;
  site: string | null;
  platform: ReportPlatform | null;
  severity: IssueSeverity;
  title: string;
  detail: string;
  source: string;
  /** 期間内で同じ内容が何件あったか(日次 highlights の延べ件数) */
  count: number;
}

/** 「検出された問題」1 件(名寄せキーで日をまたいで集約したもの)。 */
export interface PeriodIssue {
  key: string;
  /** 期間内で最後に出た日の表記を採用する */
  name: string;
  device: string | null;
  site: string | null;
  platform: ReportPlatform | null;
  /** 期間内で最も重い重要度 */
  severity: IssueSeverity;
  /** 期間内でこの問題が出た日(昇順) */
  dates: string[];
  /** dates.length。「7 日中 5 日」の分子 */
  days: number;
  /** 期間内の発生回数の合計(日次 occurrences の和) */
  occurrences: number;
  /** 期間内で最初に観測された日時 */
  firstSeenAt: string | null;
  /** 期間内での最長連続日数(3 なら 3 日連続で出ていた) */
  streak: number;
  /** 期間より前から続いているか */
  carriedOver: boolean;
  /** 期間内が初出か、期間より前からの持ち越しか */
  status: "new" | "carried";
  /** 過去日を含めた初出日(日次 recurrence.firstSeenDate の最小) */
  firstSeenDate: string;
  /** 期間より前に検出されていた日(新しい順) */
  previousDates: string[];
  /** 最終日の日次レポートから引き継ぐ内容 */
  rootCause: string;
  impact: string;
  nextAction: string;
  recurrenceNote: string;
}

/**
 * 画面に出す注記。**サーバで文章にしない**(閲覧者の表示言語を知らないため)。
 * code と params だけを返し、画面側の辞書 reports.periodNote.<code> で文にする。
 */
export interface PeriodNote {
  code:
    | "in-progress"
    | "missing-days"
    | "partial-days"
    | "analysis-failed-days"
    | "webhook-unavailable-days"
    | "mixed-lang";
  params?: Record<string, string | number>;
}

/** 集計に使った日次レポート 1 件の素性(どの日をどう取り込んだかの記録)。 */
export interface PeriodSourceReport {
  date: string;
  generatedAt: string;
  analysisStatus: string;
  lang: string;
  partial: boolean;
  highlights: number;
  issues: number;
  events: number;
}

export interface PeriodReport {
  schemaVersion: number;
  periodType: PeriodType;
  /** 週次 "YYYY-Www"(ISO 週 / 月曜始まり)/ 月次 "YYYY-MM" */
  key: string;
  startDate: string;
  endDate: string;
  timeZone: string;
  generatedAt: string;
  generatedBy: "schedule" | "manual" | "catchup";
  /**
   * 後から作り直す価値がある状態(進行中の期間 / 日次レポートの欠落あり)。
   * 定期実行・後追い生成はこれを見て作り直す(日次レポートの partial と同じ考え方)。
   */
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
  /** 重要度で絞った結果、落とした件数 */
  highlightsTruncated: number;
  issues: PeriodIssue[];
  sourceReports: PeriodSourceReport[];
  /** 日次レポート本文の言語の内訳(本文を翻訳しないので、混在していれば画面で注記する) */
  langs: Record<string, number>;
  notes: PeriodNote[];
}

/** 一覧 API が返す軽量メタ(カレンダーの「生成済み」判定に使う)。 */
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

// ---- 設定 ----

export interface ReportSettings {
  /** 定期生成の有効/無効 */
  enabled: boolean;
  /** 生成時刻(ローカル TZ)。既定 9:00 = 前日分を生成する */
  hour: number;
  minute: number;
  /** 日次レポートの保持日数。0 = 無期限(既定) */
  retentionDays: number;
  /**
   * Global Overview サンプル(samples/*.jsonl)の保持日数。
   * レポートを作り直すための素材なので、後追い生成が届く範囲(catchUpDays)より少し長く持てば足りる。
   * レポート本体と違って行数が多いため、既定は無期限にしない。
   */
  sampleRetentionDays: number;
  /** 起動時に何日ぶん遡って欠落を確認するか */
  catchUpDays: number;
  // ---- 45: 週次 / 月次 ----
  /** 週次レポートの定期生成 */
  weeklyEnabled: boolean;
  /** 発火する曜日(0=日 … 6=土)。既定 1 = 月曜 */
  weeklyWeekday: number;
  /** 発火時刻。既定 9:30 = 同じ朝 9:00 の日次生成(日曜ぶん)が終わってから走る */
  weeklyHour: number;
  weeklyMinute: number;
  /** 月次レポートの定期生成 */
  monthlyEnabled: boolean;
  /** 発火する日(1〜28)。既定 1 = 毎月 1 日 */
  monthlyDay: number;
  /** 発火時刻。既定 9:40 = 日次(月末ぶん)→ 週次 の後 */
  monthlyHour: number;
  monthlyMinute: number;
  /** 週次レポートの保持週数。0 = 無期限(既定) */
  weeklyRetentionWeeks: number;
  /** 月次レポートの保持月数。0 = 無期限(既定) */
  monthlyRetentionMonths: number;
  /** 起動時に何週ぶん遡って欠落を確認するか */
  catchUpWeeks: number;
  /** 起動時に何か月ぶん遡って欠落を確認するか */
  catchUpMonths: number;
  /** 分析に使うモデル(null なら NETINV_MODEL → sonnet) */
  model: string | null;
  lang: "ja" | "en";
  /** Global Overview のサンプリング間隔(ms) */
  sampleIntervalMs: number;
  /** 44: 重大な問題の自動事前調査(MCP 込み)を行うか */
  autoInvestigateEnabled: boolean;
  /** 44: 1 回のレポート生成につき自動事前調査を仕掛ける最大件数(0 = 実質無効) */
  autoInvestigateMaxPerReport: number;
  /** Mist SLE の取得間隔(ms)。SLE は org 一括で 1 本の HTTP を要するので粗くする */
  sleIntervalMs: number;
}
