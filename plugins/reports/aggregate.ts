// 週次 / 月次レポート(45 Task 1)— 蓄積済みの日次レポートを機械的に集計する。
//
// ここには **外部 API 呼び出しも LLM 呼び出しも無い**。入力は data/reports/daily/*.json だけで、
// 出力は PeriodReport(types.ts)。純関数なので、同じ日次レポート群からは常に同じ結果が出る。
//
// ---- 集計の原則 ----
//  平均は必ず母数で重み付けする。日次レポートは平均値に samples(サンプル数)を添えて
//  持っている(41 の設計方針 1)。単純に日次平均の平均を取ると、サンプルが 1 点しか無い日と
//  288 点ある日が同じ重みになってしまう。
//
//  ただし「サイト健全性 / SLE」だけは **日ごとにサイト間平均を出してから、日をまたいで平均** する。
//  日次のトレンドグラフ(view/Trends.tsx)が同じ計算をしており、
//  「週次の点」と「その週の日次の点」が食い違わないようにするため。

import type {
  DailyIssue,
  DailyReport,
  IssueSeverity,
  PeriodCoverage,
  PeriodHighlight,
  PeriodIssue,
  PeriodKpi,
  PeriodNote,
  PeriodReport,
  PeriodSiteStat,
  PeriodSourceReport,
  PeriodStat,
  PeriodTrendPoint,
  PeriodType,
  ReportPlatform,
} from "./types.js";
import { PERIOD_REPORT_SCHEMA_VERSION } from "./types.js";
import { REPORT_TZ, addDays, periodWindow, weekKeyOf, weekStartOf } from "./time.js";

/** 「起きたこと」に載せる上限(週次 / 月次)。超えた分は highlightsTruncated に残す。 */
const HIGHLIGHT_LIMIT: Record<PeriodType, number> = { weekly: 20, monthly: 30 };

const SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 };

function round(v: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** 重み付き平均。重みの合計が 0 なら null。 */
function weightedAvg(pairs: Array<[value: number, weight: number]>): number | null {
  let sum = 0;
  let w = 0;
  for (const [v, weight] of pairs) {
    if (!Number.isFinite(v) || !Number.isFinite(weight) || weight <= 0) continue;
    sum += v * weight;
    w += weight;
  }
  return w > 0 ? round(sum / w) : null;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((a, b) => a + b, 0) / values.length);
}

function addCounts(into: Record<string, number>, from: Record<string, number> | undefined | null): void {
  for (const [k, v] of Object.entries(from ?? {})) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    into[k] = (into[k] ?? 0) + v;
  }
}

/** 件数の多い順に並べ替えた Record(画面がそのまま上から出せるように)。 */
function sortCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function worstSeverity(a: IssueSeverity, b: IssueSeverity): IssueSeverity {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

/** ロケール非依存の軸ラベル("7/27")。view/dates.ts の formatAxisDay と同じ表記。 */
function axisDay(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}`;
}

// ---- 1 日ぶんから取り出す素材 ----

interface DayFacts {
  date: string;
  events: number;
  eventsAvailable: boolean;
  critical: number;
  warning: number;
  clients: { avg: number | null; min: number | null; max: number | null; samples: number };
  centralHealth: number | null;
  mistSle: number | null;
  issues: number;
}

/** 日次レポート 1 件 → グラフ・KPI に使う素材。 */
function factsOf(r: DailyReport): DayFacts {
  const sites = r.data?.overview?.sites ?? [];
  const central = sites
    .filter((s) => s.platform === "central" && typeof s.centralHealth?.avg === "number")
    .map((s) => s.centralHealth!.avg as number);
  const mist = sites
    .filter((s) => s.platform === "mist" && typeof s.mistSle?.avg === "number")
    .map((s) => s.mistSle!.avg as number);
  const webhook = r.data?.webhook;
  const clients = r.data?.overview?.totals?.clients;
  return {
    date: r.date,
    events: webhook?.total ?? 0,
    eventsAvailable: webhook?.available !== false,
    critical: webhook?.bySeverity?.critical ?? 0,
    warning: webhook?.bySeverity?.warning ?? 0,
    clients: {
      avg: typeof clients?.avg === "number" ? clients.avg : null,
      min: typeof clients?.min === "number" ? clients.min : null,
      max: typeof clients?.max === "number" ? clients.max : null,
      samples: clients?.samples ?? 0,
    },
    centralHealth: mean(central),
    mistSle: mean(mist),
    issues: r.analysis?.issues?.length ?? 0,
  };
}

// ---- KPI ----

function buildClientsStat(facts: DayFacts[]): PeriodStat {
  const pairs: Array<[number, number]> = [];
  let min: number | null = null;
  let max: number | null = null;
  let minDate: string | null = null;
  let maxDate: string | null = null;
  let days = 0;

  for (const f of facts) {
    if (f.clients.avg === null) continue;
    days += 1;
    // サンプル数が 0 の日(スナップショット代用)も 1 点として数える。
    pairs.push([f.clients.avg, Math.max(1, f.clients.samples)]);
    if (f.clients.min !== null && (min === null || f.clients.min < min)) {
      min = f.clients.min;
      minDate = f.date;
    }
    if (f.clients.max !== null && (max === null || f.clients.max > max)) {
      max = f.clients.max;
      maxDate = f.date;
    }
  }
  return { avg: weightedAvg(pairs), min, max, minDate, maxDate, days };
}

function buildKpi(reports: DailyReport[], facts: DayFacts[], issues: PeriodIssue[]): PeriodKpi {
  let events = 0;
  let countedDays = 0;
  const unavailableDays: string[] = [];
  let busiestDate: string | null = null;
  let busiestValue = 0;
  let critical = 0;
  let warning = 0;
  let worstDate: string | null = null;
  let worstValue = 0;

  for (const f of facts) {
    if (!f.eventsAvailable) {
      unavailableDays.push(f.date);
      continue;
    }
    countedDays += 1;
    events += f.events;
    critical += f.critical;
    warning += f.warning;
    if (f.events > busiestValue) {
      busiestValue = f.events;
      busiestDate = f.date;
    }
    if (f.critical > worstValue) {
      worstValue = f.critical;
      worstDate = f.date;
    }
  }

  const investigations = { total: 0, errors: 0, bySource: {} as Record<string, number> };
  for (const r of reports) {
    investigations.total += r.data?.investigations?.total ?? 0;
    investigations.errors += r.data?.investigations?.errors ?? 0;
    addCounts(investigations.bySource, r.data?.investigations?.bySource);
  }
  investigations.bySource = sortCounts(investigations.bySource);

  return {
    events: {
      total: events,
      perDayAvg: countedDays > 0 ? round(events / countedDays) : null,
      countedDays,
      unavailableDays,
      busiestDate,
      busiestValue,
    },
    alerts: {
      critical,
      warning,
      perDayAvgCritical: countedDays > 0 ? round(critical / countedDays) : null,
      worstDate,
      worstValue,
    },
    clients: buildClientsStat(facts),
    issues: {
      unique: issues.length,
      new: issues.filter((i) => i.status === "new").length,
      carried: issues.filter((i) => i.status === "carried").length,
      critical: issues.filter((i) => i.severity === "critical").length,
      warning: issues.filter((i) => i.severity === "warning").length,
      info: issues.filter((i) => i.severity === "info").length,
      dayTotal: facts.reduce((a, f) => a + f.issues, 0),
    },
    investigations,
  };
}

// ---- トレンド ----

/** 日次点(週次で使う)。1 日 = 1 点。 */
function dayPoints(facts: DayFacts[]): PeriodTrendPoint[] {
  return facts.map((f) => ({
    key: f.date,
    startDate: f.date,
    endDate: f.date,
    label: axisDay(f.date),
    days: 1,
    centralHealth: f.centralHealth,
    mistSle: f.mistSle,
    clients: f.clients.avg === null ? null : Math.round(f.clients.avg),
    events: f.eventsAvailable ? f.events : 0,
    criticalAlerts: f.critical,
    issues: f.issues,
  }));
}

/**
 * 週次点(月次で使う)。月内を ISO 週(月曜始まり)で束ね、月をまたぐ端の週は
 * **その月に入っている日だけ** で集計する(隣の月の数字が混ざらないようにする)。
 */
function weekPoints(facts: DayFacts[]): PeriodTrendPoint[] {
  const groups = new Map<string, DayFacts[]>();
  for (const f of facts) {
    const key = weekKeyOf(f.date);
    const list = groups.get(key);
    if (list) list.push(f);
    else groups.set(key, [f]);
  }
  return Array.from(groups.entries())
    .sort((a, b) => a[1][0].date.localeCompare(b[1][0].date))
    .map(([key, list]) => {
      const startDate = list[0].date;
      const endDate = list[list.length - 1].date;
      return {
        key,
        startDate,
        endDate,
        label: startDate === endDate ? axisDay(startDate) : `${axisDay(startDate)}–${axisDay(endDate)}`,
        days: list.length,
        centralHealth: mean(list.map((f) => f.centralHealth).filter((v): v is number => v !== null)),
        mistSle: mean(list.map((f) => f.mistSle).filter((v): v is number => v !== null)),
        clients: weightedAvg(
          list
            .filter((f) => f.clients.avg !== null)
            .map((f) => [f.clients.avg as number, Math.max(1, f.clients.samples)] as [number, number]),
        ),
        events: list.reduce((a, f) => a + (f.eventsAvailable ? f.events : 0), 0),
        criticalAlerts: list.reduce((a, f) => a + f.critical, 0),
        issues: list.reduce((a, f) => a + f.issues, 0),
      };
    });
}

// ---- サイト別 ----

function buildSites(reports: DailyReport[]): PeriodSiteStat[] {
  interface Acc {
    siteName: string;
    platform: "central" | "mist";
    siteId: string | null;
    health: Array<[number, number]>;
    sle: Array<[number, number]>;
    clients: Array<[number, number]>;
    clientsMax: number | null;
    days: number;
  }
  const acc = new Map<string, Acc>();
  for (const r of reports) {
    for (const s of r.data?.overview?.sites ?? []) {
      const key = `${s.platform}:${s.siteName}`;
      let a = acc.get(key);
      if (!a) {
        a = {
          siteName: s.siteName,
          platform: s.platform,
          siteId: s.siteId ?? null,
          health: [],
          sle: [],
          clients: [],
          clientsMax: null,
          days: 0,
        };
        acc.set(key, a);
      }
      a.days += 1;
      if (!a.siteId && s.siteId) a.siteId = s.siteId;
      const w = Math.max(1, s.samples ?? 1);
      if (typeof s.centralHealth?.avg === "number") a.health.push([s.centralHealth.avg, w]);
      if (typeof s.mistSle?.avg === "number") a.sle.push([s.mistSle.avg, w]);
      if (typeof s.clients?.avg === "number") a.clients.push([s.clients.avg, w]);
      if (typeof s.clients?.max === "number" && (a.clientsMax === null || s.clients.max > a.clientsMax)) {
        a.clientsMax = s.clients.max;
      }
    }
  }
  return Array.from(acc.values())
    .map((a) => ({
      siteName: a.siteName,
      platform: a.platform,
      siteId: a.siteId,
      centralHealth: weightedAvg(a.health),
      mistSle: weightedAvg(a.sle),
      clients: weightedAvg(a.clients),
      clientsMax: a.clientsMax,
      days: a.days,
    }))
    .sort((a, b) => a.siteName.localeCompare(b.siteName));
}

// ---- 「この期間に起きたこと」----

/**
 * 同じ出来事を日をまたいで束ねるためのキー。
 * 見出しは LLM が日ごとに書くので文字が揺れる。数字を落とし、記号と空白を潰して比較する
 * (「AP再起動(3回)」と「AP再起動(5回)」を同じ出来事として扱いたい)。
 */
function highlightKey(h: { title: string; site: string | null; device: string | null; severity: string }): string {
  const norm = h.title
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/[\s　_\-–—/()()[\]「」『』、,.。:：]/g, "")
    .slice(0, 48);
  return `${h.severity}|${h.site ?? ""}|${h.device ?? ""}|${norm}`;
}

function buildHighlights(
  reports: DailyReport[],
  periodType: PeriodType,
): { highlights: PeriodHighlight[]; truncated: number } {
  interface Acc extends PeriodHighlight {
    rank: number;
  }
  const acc = new Map<string, Acc>();

  // 日付の昇順に見て、後の日の内容で上書きする(= 代表は最新日のもの)。
  for (const r of [...reports].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const h of r.analysis?.highlights ?? []) {
      const key = highlightKey(h);
      const prev = acc.get(key);
      if (prev) {
        prev.count += 1;
        if (!prev.dates.includes(r.date)) prev.dates.push(r.date);
        prev.date = r.date;
        prev.at = h.at ?? prev.at;
        prev.title = h.title;
        prev.detail = h.detail;
        prev.rank = Math.min(prev.rank, SEVERITY_RANK[h.severity] ?? 2);
        continue;
      }
      acc.set(key, {
        date: r.date,
        dates: [r.date],
        at: h.at ?? null,
        device: h.device ?? null,
        site: h.site ?? null,
        platform: (h.platform ?? null) as ReportPlatform | null,
        severity: h.severity,
        title: h.title,
        detail: h.detail,
        source: h.source,
        count: 1,
        rank: SEVERITY_RANK[h.severity] ?? 2,
      });
    }
  }

  // 重要度 → 出た日数 → 新しい順。重要度の高いものから埋めるので、
  // 上限で切られるのは必ず info / warning の末尾側になる。
  const ordered = Array.from(acc.values()).sort(
    (a, b) =>
      a.rank - b.rank ||
      b.dates.length - a.dates.length ||
      b.count - a.count ||
      b.date.localeCompare(a.date),
  );
  const limit = HIGHLIGHT_LIMIT[periodType];
  const kept = ordered.slice(0, limit).map(({ rank: _rank, ...h }) => h);
  return { highlights: kept, truncated: Math.max(0, ordered.length - kept.length) };
}

// ---- 「検出された問題」の名寄せ ----

/** 日付配列(昇順)の中の最長連続日数。 */
function longestStreak(dates: string[]): number {
  let best = 0;
  let cur = 0;
  let prev: string | null = null;
  for (const d of dates) {
    cur = prev !== null && addDays(prev, 1) === d ? cur + 1 : 1;
    prev = d;
    if (cur > best) best = cur;
  }
  return best;
}

function buildIssues(reports: DailyReport[], startDate: string): PeriodIssue[] {
  interface Acc {
    key: string;
    latest: DailyIssue;
    latestDate: string;
    dates: string[];
    occurrences: number;
    severity: IssueSeverity;
    firstSeenAt: string | null;
    firstSeenDate: string;
    previousDates: Set<string>;
  }
  const acc = new Map<string, Acc>();

  for (const r of [...reports].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const issue of r.analysis?.issues ?? []) {
      const key = issue.key;
      const prev = acc.get(key);
      const firstSeenDate = issue.recurrence?.firstSeenDate ?? r.date;
      if (!prev) {
        acc.set(key, {
          key,
          latest: issue,
          latestDate: r.date,
          dates: [r.date],
          occurrences: issue.occurrences ?? 0,
          severity: issue.severity,
          firstSeenAt: issue.firstSeenAt ?? null,
          firstSeenDate,
          previousDates: new Set((issue.recurrence?.previousDates ?? []).filter((d) => d < startDate)),
        });
        continue;
      }
      prev.latest = issue;
      prev.latestDate = r.date;
      if (!prev.dates.includes(r.date)) prev.dates.push(r.date);
      prev.occurrences += issue.occurrences ?? 0;
      prev.severity = worstSeverity(prev.severity, issue.severity);
      if (issue.firstSeenAt && (!prev.firstSeenAt || issue.firstSeenAt < prev.firstSeenAt)) {
        prev.firstSeenAt = issue.firstSeenAt;
      }
      if (firstSeenDate < prev.firstSeenDate) prev.firstSeenDate = firstSeenDate;
      for (const d of issue.recurrence?.previousDates ?? []) if (d < startDate) prev.previousDates.add(d);
    }
  }

  return Array.from(acc.values())
    .map((a) => {
      const dates = a.dates.slice().sort();
      const carriedOver = a.firstSeenDate < startDate;
      return {
        key: a.key,
        name: a.latest.name,
        device: a.latest.device ?? null,
        site: a.latest.site ?? null,
        platform: (a.latest.platform ?? null) as ReportPlatform | null,
        severity: a.severity,
        dates,
        days: dates.length,
        occurrences: a.occurrences,
        firstSeenAt: a.firstSeenAt,
        streak: longestStreak(dates),
        carriedOver,
        status: (carriedOver ? "carried" : "new") as "new" | "carried",
        firstSeenDate: a.firstSeenDate,
        previousDates: Array.from(a.previousDates).sort().reverse(),
        rootCause: a.latest.rootCause ?? "",
        impact: a.latest.impact ?? "",
        nextAction: a.latest.nextAction ?? "",
        recurrenceNote: a.latest.recurrence?.note ?? "",
      };
    })
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        b.days - a.days ||
        b.occurrences - a.occurrences ||
        a.key.localeCompare(b.key),
    );
}

// ---- 入口 ----

export interface AggregateInput {
  periodType: PeriodType;
  key: string;
  /** 期間内で見つかった日次レポート(順不同でよい) */
  reports: DailyReport[];
  /** 生成時点の「今日」。期間が進行中かどうかの判定に使う */
  today: string;
  generatedBy: "schedule" | "manual" | "catchup";
}

/**
 * 日次レポート群 → 週次 / 月次レポート。
 *
 * 呼び出し側(period-generate.ts)は「期間内の日次レポートを読む」ところまでを担当し、
 * ここは読めたものだけで集計する。1 件も無い場合は呼ばれない(生成しない)。
 */
export function aggregatePeriod(input: AggregateInput): PeriodReport {
  const { periodType, key, today, generatedBy } = input;
  const window = periodWindow(periodType, key);
  const reports = [...input.reports].sort((a, b) => a.date.localeCompare(b.date));
  const have = new Set(reports.map((r) => r.date));

  // 「揃っているべき日」= 期間内で既に終わった日(= 前日まで)。
  // 進行中の週 / 月で、まだ来ていない日を欠落として数えないための線引き。
  const yesterday = addDays(today, -1);
  const expected = window.days.filter((d) => d <= yesterday);
  const missingDays = expected.filter((d) => !have.has(d));

  const coverage: PeriodCoverage = {
    periodDays: window.days.length,
    expectedDays: expected.length,
    availableDays: reports.length,
    days: reports.map((r) => r.date),
    missingDays,
    partialDays: reports.filter((r) => r.partial === true).map((r) => r.date),
    analysisFailedDays: reports.filter((r) => (r.analysis?.status ?? "ok") !== "ok").map((r) => r.date),
    inProgress: window.endDate >= today,
    complete: missingDays.length === 0,
  };

  const facts = reports.map(factsOf);
  const issues = buildIssues(reports, window.startDate);
  const { highlights, truncated } = buildHighlights(reports, periodType);
  const kpi = buildKpi(reports, facts, issues);

  const breakdownWebhook = {
    bySeverity: {} as Record<string, number>,
    bySource: {} as Record<string, number>,
    byCategory: {} as Record<string, number>,
    byType: {} as Record<string, number>,
  };
  const byStream: Record<string, number> = {};
  let streamingTotal = 0;
  let auditTrail = 0;
  const langs: Record<string, number> = {};
  const sourceReports: PeriodSourceReport[] = [];

  for (const r of reports) {
    if (r.data?.webhook?.available !== false) {
      addCounts(breakdownWebhook.bySeverity, r.data?.webhook?.bySeverity);
      addCounts(breakdownWebhook.bySource, r.data?.webhook?.bySource);
      addCounts(breakdownWebhook.byCategory, r.data?.webhook?.byCategory);
      addCounts(breakdownWebhook.byType, r.data?.webhook?.byType);
    }
    streamingTotal += r.data?.streaming?.total ?? 0;
    auditTrail += r.data?.streaming?.auditTrail?.total ?? 0;
    addCounts(byStream, r.data?.streaming?.byStream);
    langs[r.lang ?? "ja"] = (langs[r.lang ?? "ja"] ?? 0) + 1;
    sourceReports.push({
      date: r.date,
      generatedAt: r.generatedAt,
      analysisStatus: r.analysis?.status ?? "unknown",
      lang: r.lang ?? "ja",
      partial: r.partial === true,
      highlights: r.analysis?.highlights?.length ?? 0,
      issues: r.analysis?.issues?.length ?? 0,
      events: r.data?.webhook?.total ?? 0,
    });
  }

  // 注記は文章にせず、コード + 値だけを返す(画面側の辞書で日英の文にする)。
  const notes: PeriodNote[] = [];
  if (coverage.inProgress) {
    notes.push({ code: "in-progress", params: { days: coverage.availableDays, of: coverage.periodDays } });
  }
  if (missingDays.length > 0) {
    notes.push({
      code: "missing-days",
      params: { n: missingDays.length, of: expected.length, dates: missingDays.join(", ") },
    });
  }
  if (coverage.partialDays.length > 0) {
    notes.push({ code: "partial-days", params: { n: coverage.partialDays.length, dates: coverage.partialDays.join(", ") } });
  }
  if (coverage.analysisFailedDays.length > 0) {
    notes.push({
      code: "analysis-failed-days",
      params: { n: coverage.analysisFailedDays.length, dates: coverage.analysisFailedDays.join(", ") },
    });
  }
  if (kpi.events.unavailableDays.length > 0) {
    notes.push({
      code: "webhook-unavailable-days",
      params: { n: kpi.events.unavailableDays.length, dates: kpi.events.unavailableDays.join(", ") },
    });
  }
  if (Object.keys(langs).length > 1) {
    notes.push({ code: "mixed-lang", params: { langs: Object.keys(langs).sort().join(" / ") } });
  }

  return {
    schemaVersion: PERIOD_REPORT_SCHEMA_VERSION,
    periodType,
    key,
    startDate: window.startDate,
    endDate: window.endDate,
    timeZone: REPORT_TZ,
    generatedAt: new Date().toISOString(),
    generatedBy,
    stale: coverage.inProgress || missingDays.length > 0,
    coverage,
    kpi,
    trend: {
      granularity: periodType === "weekly" ? "day" : "week",
      points: periodType === "weekly" ? dayPoints(facts) : weekPoints(facts),
    },
    sites: buildSites(reports),
    breakdown: {
      webhook: {
        bySeverity: sortCounts(breakdownWebhook.bySeverity),
        bySource: sortCounts(breakdownWebhook.bySource),
        byCategory: sortCounts(breakdownWebhook.byCategory),
        byType: sortCounts(breakdownWebhook.byType),
      },
      streaming: { total: streamingTotal, byStream: sortCounts(byStream), auditTrail },
    },
    highlights,
    highlightsTruncated: truncated,
    issues,
    sourceReports,
    langs,
    notes,
  };
}

/** 週の月曜日を返す(呼び出し側が view と同じ定義を使えるように再輸出する)。 */
export { weekStartOf };
