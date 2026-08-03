// レポートタブ(43)。
//
// 41 番で蓄積している日次レポート(data/reports/daily/YYYY-MM-DD.json)を読んで見せる画面。
// サーバ側は 41 番の口(GET /api/reports/daily, /daily/:date)をそのまま使い、ここでは足さない。
//
// 画面の骨格:
//   ┌ 期間タブ(日次 / 週次 / 月次)
//   ├ 左: カレンダー的な期間ピッカー(PeriodPicker)/ 右: 総括 + KPI カード
//   ├ グラフ 2 枚(健全性・SLE の 2 系列 / 接続端末数)
//   ├ この期間に起きたこと(クリックでネットワーク調査タブへ)
//   └ 検出された問題(表。行クリックでネットワーク調査タブへ、▸ で詳細を展開)
//
// 週次 / 月次(45)は PeriodReportView が描く。日次レポートを機械的に集計したものなので
// LLM 由来の総括文が無く、注記・総括は辞書側で組み立てる(PeriodReportView の冒頭を参照)。
//
// 文言はすべて src/i18n(ja/en 両方に追加済み)。レポート本文(総括・起きたこと・問題)は
// **生成時の言語のまま出す**。実行時の記録として残る文言は翻訳しない、という CLAUDE.md の方針に従う
// (後から別言語で開いても「その実行が何を答えたか」は変わらないため)。表示言語と違う場合だけ注記を出す。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "../../../src/i18n/LanguageContext";
import { formatDateTime, formatNumber } from "../../../src/i18n";
import type { InvestigationRequest, PendingHistoryFocus, SiteFocusRequest } from "../../../src/shell";
import {
  clearReportCache,
  fetchAutoInvestigations,
  fetchDaily,
  fetchDailyList,
  fetchDailyMany,
  fetchPeriod,
  fetchPeriodList,
} from "./api";
import { addDays, monthOf, today, weekKeyOf, weekStartOfKey } from "./dates";
import { buildHighlightQuery, buildIssueQuery } from "./investigate";
import { AutoPanel } from "./AutoPanel";
import { PeriodPicker } from "./PeriodPicker";
import { PeriodDetailPanels, PeriodSummaryPanel } from "./PeriodReportView";
import { ClientsTrend, HealthTrend, toTrendPoints } from "./Trends";
import type {
  AutoInvestigationEntry,
  DailyIssue,
  DailyReport,
  DailyReportMeta,
  DailySiteStat,
  PeriodReport,
  PeriodReportMeta,
  PeriodType,
  ReportPeriod,
} from "./types";
import "./styles.css";

/** トレンドに並べる日数(Task 3-4 の「直近 N 日」)。 */
const TREND_DAYS = 7;

const PERIODS: ReportPeriod[] = ["daily", "weekly", "monthly"];

function KpiCard({
  label,
  value,
  sub,
  tone,
  title,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "ok" | "warn" | "bad";
  title?: string;
}) {
  return (
    <div className={`go-card${tone ? ` go-card-${tone}` : ""}`} title={title}>
      <div className="go-card-label">{label}</div>
      <div className="go-card-value">{value}</div>
      {sub && <div className="go-card-sub">{sub}</div>}
    </div>
  );
}

/** サイト詳細ページ(Global Overview)へのチップ。健全性 / SLE の低い順に並べる。 */
function SiteLinks({
  sites,
  onOpenSite,
}: {
  sites: DailySiteStat[];
  onOpenSite?: (req: SiteFocusRequest) => void;
}) {
  const { t } = useLanguage();
  const ordered = useMemo(() => {
    const score = (s: DailySiteStat): number => {
      const v = s.platform === "central" ? s.centralHealth?.avg : s.mistSle?.avg;
      // スコアが無いサイトは末尾へ(値が悪いわけではないので先頭に出さない)。
      return typeof v === "number" ? v : Number.POSITIVE_INFINITY;
    };
    return sites.slice().sort((a, b) => score(a) - score(b) || a.siteName.localeCompare(b.siteName));
  }, [sites]);

  if (ordered.length === 0) return null;
  return (
    <div className="rp-sitelinks">
      <div className="go-note">{t("reports.charts.siteDetailNote")}</div>
      <div className="rp-chips">
        {ordered.map((s) => {
          const v = s.platform === "central" ? s.centralHealth?.avg : s.mistSle?.avg;
          const tone = typeof v !== "number" ? "" : v >= 80 ? " rp-chip-ok" : v >= 50 ? " rp-chip-warn" : " rp-chip-bad";
          return (
            <button
              key={`${s.platform}:${s.siteName}`}
              className={`rp-chip rp-chip-${s.platform}${tone}`}
              onClick={() => onOpenSite?.({ siteName: s.siteName, platform: s.platform })}
              title={t("reports.charts.siteDetailLinkTitle", { site: s.siteName })}
            >
              <span className="rp-chip-name">{s.siteName}</span>
              <span className="rp-chip-score">{typeof v === "number" ? Math.round(v) : "—"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function IssueRow({
  issue,
  date,
  open,
  onToggle,
  onInvestigate,
  auto,
  onOpenHistoryFocus,
}: {
  issue: DailyIssue;
  date: string;
  open: boolean;
  onToggle: () => void;
  onInvestigate?: (req: InvestigationRequest) => void;
  /** 44: この問題の自動事前調査(名寄せキー一致)。まだ無ければ undefined */
  auto?: AutoInvestigationEntry;
  /** 44: 調査済みの問題から、その実行スレッドへ直接ジャンプする(18/19 番と同じ経路) */
  onOpenHistoryFocus?: (runId: PendingHistoryFocus) => void;
}) {
  const { lang, t } = useLanguage();
  // 44: 自動事前調査が完了していれば「調査する」の代わりに「調査結果を見る」を出す。
  // 実行中・失敗のときは結果がまだ無いので、従来どおりクエリ事前入力の導線を残す。
  const hasResult = Boolean(onOpenHistoryFocus && auto?.status === "done" && auto.runId);
  const goInvestigate = () => onInvestigate?.(buildIssueQuery(date, issue));
  const goResult = () => onOpenHistoryFocus?.(auto!.runId!);
  const go = hasResult ? goResult : goInvestigate;
  return (
    <>
      <tr
        className={`rp-issue-row${open ? " rp-row-open" : ""}`}
        onClick={go}
        title={t(hasResult ? "reports.auto.rowTitleResult" : "reports.issues.rowTitle")}
      >
        <td className="rp-c-exp">
          <button
            className="rp-exp-btn"
            aria-expanded={open}
            aria-label={t(open ? "reports.issues.collapse" : "reports.issues.expand")}
            title={t(open ? "reports.issues.collapse" : "reports.issues.expand")}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            {open ? "▾" : "▸"}
          </button>
        </td>
        <td className="rp-c-name">
          {issue.name}
          {auto && (
            <span className={`rp-auto-tag rp-auto-${auto.status}`} title={t("reports.auto.tagTitle", { date: auto.date })}>
              {t(`reports.auto.tag.${auto.status}`)}
            </span>
          )}
        </td>
        <td className="rp-c-device">{issue.device ?? <span className="go-zero">—</span>}</td>
        <td className="rp-c-site">{issue.site ?? <span className="go-zero">—</span>}</td>
        <td className="rp-c-first">{formatDateTime(issue.firstSeenAt, lang)}</td>
        <td className="rp-c-plat">
          {issue.platform ? (
            <span className={`rp-plat rp-plat-${issue.platform}`}>{t(`reports.platform.${issue.platform}`)}</span>
          ) : (
            <span className="go-zero">—</span>
          )}
        </td>
        <td className="rp-c-sev">
          <span className={`rp-sev rp-sev-${issue.severity}`}>{t(`reports.severity.${issue.severity}`)}</span>
        </td>
        <td className="rp-c-rec">
          <span className={`rp-rec rp-rec-${issue.recurrence.status}`}>
            {t(`reports.recurrence.${issue.recurrence.status}`)}
          </span>
          {issue.recurrence.previousDates.length > 0 && (
            <span className="rp-rec-n">{t("reports.issues.prevDays", { n: issue.recurrence.previousDates.length })}</span>
          )}
        </td>
        <td className="rp-c-action">{issue.nextAction}</td>
        <td className="rp-c-go">
          {hasResult ? (
            <button
              className="rp-result-btn"
              onClick={(e) => {
                e.stopPropagation();
                goResult();
              }}
              title={t("reports.auto.resultBtnTitle", { date: auto!.date })}
            >
              {t("reports.auto.resultBtn")}
            </button>
          ) : (
            <button
              className="rp-go-btn"
              onClick={(e) => {
                e.stopPropagation();
                goInvestigate();
              }}
              title={t("reports.investigateBtnTitle")}
            >
              {t("reports.investigateBtn")}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="rp-issue-detail">
          <td colSpan={10}>
            <div className="rp-detail-grid">
              <div>
                <span className="rp-detail-label">{t("reports.issues.rootCause")}</span>
                <span className="rp-detail-value">{issue.rootCause || "—"}</span>
              </div>
              <div>
                <span className="rp-detail-label">{t("reports.issues.impact")}</span>
                <span className="rp-detail-value">{issue.impact || "—"}</span>
              </div>
              <div>
                <span className="rp-detail-label">{t("reports.issues.occurrences")}</span>
                <span className="rp-detail-value">{formatNumber(issue.occurrences, lang)}</span>
              </div>
              <div>
                <span className="rp-detail-label">{t("reports.issues.firstSeenDate")}</span>
                <span className="rp-detail-value">{issue.recurrence.firstSeenDate}</span>
              </div>
              <div className="rp-detail-wide">
                <span className="rp-detail-label">{t("reports.issues.recurrenceNote")}</span>
                <span className="rp-detail-value">{issue.recurrence.note || "—"}</span>
              </div>
              {issue.recurrence.previousDates.length > 0 && (
                <div className="rp-detail-wide">
                  <span className="rp-detail-label">{t("reports.issues.previousDates")}</span>
                  <span className="rp-detail-value go-mono">{issue.recurrence.previousDates.join(", ")}</span>
                </div>
              )}
              <div className="rp-detail-wide">
                <span className="rp-detail-label">{t("reports.issues.key")}</span>
                <span className="rp-detail-value go-mono">{issue.key}</span>
              </div>
            </div>
            {auto && <AutoPanel auto={auto} onOpenHistoryFocus={onOpenHistoryFocus} />}
          </td>
        </tr>
      )}
    </>
  );
}

export function Reports({
  active,
  onInvestigate,
  onOpenSite,
  onOpenHistoryFocus,
}: {
  active: boolean;
  /** 起きたこと / 問題のクリック → ネットワーク調査タブへ(15 番と同じ共有 state 経由) */
  onInvestigate?: (req: InvestigationRequest) => void;
  /** サイト詳細ページ(Global Overview)を開く(43 Task 3-2 の注記リンク) */
  onOpenSite?: (req: SiteFocusRequest) => void;
  /** 44: 自動事前調査済みの問題から、その実行スレッドへ直接ジャンプする(18/19 番と同じ共有 state) */
  onOpenHistoryFocus?: (runId: PendingHistoryFocus) => void;
}) {
  const { lang, t } = useLanguage();
  const [period, setPeriod] = useState<ReportPeriod>("daily");
  const [list, setList] = useState<DailyReportMeta[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string>(() => monthOf(today()));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  /** 45: 選択中の週は ISO 週キー("YYYY-Www")。カレンダーの 1 行 = 1 つの週次レポート。 */
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [loading, setLoading] = useState(false);
  // 45: 週次 / 月次。一覧(カレンダーの点)と、選択中の期間の本体を別々に持つ。
  const [weeklyList, setWeeklyList] = useState<PeriodReportMeta[]>([]);
  const [monthlyList, setMonthlyList] = useState<PeriodReportMeta[]>([]);
  const [periodReport, setPeriodReport] = useState<PeriodReport | null>(null);
  const [periodLoading, setPeriodLoading] = useState(false);
  const [periodError, setPeriodError] = useState<string | null>(null);
  /** 「更新」を押すたびに増やす。キャッシュを捨てた後、期間レポートを取り直させるための合図。 */
  const [reloadToken, setReloadToken] = useState(0);
  // 取得失敗の生メッセージ(サーバ / ネットワークの文言。翻訳しない)と、
  // 「その日は未生成」の状態は分けて持つ。後者は言語で文面が変わるので、
  // 文章ではなくフラグを state に置いて描画時に t() で組み立てる(CLAUDE.md)。
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [trend, setTrend] = useState<DailyReport[]>([]);
  const [openIssue, setOpenIssue] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  // 44: 自動事前調査の履歴(名寄せキー → 記録)。レポート本体とは別に取る。
  const [autoByKey, setAutoByKey] = useState<Record<string, AutoInvestigationEntry>>({});
  const [autoRunning, setAutoRunning] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reports = useMemo(() => {
    const m = new Map<string, DailyReportMeta>();
    for (const r of list ?? []) m.set(r.date, r);
    return m;
  }, [list]);

  const latestDate = useMemo(() => {
    let latest: string | null = null;
    for (const d of reports.keys()) if (!latest || d > latest) latest = d;
    return latest;
  }, [reports]);

  const weeklyReports = useMemo(() => {
    const m = new Map<string, PeriodReportMeta>();
    for (const r of weeklyList) m.set(r.key, r);
    return m;
  }, [weeklyList]);

  const monthlyReports = useMemo(() => {
    const m = new Map<string, PeriodReportMeta>();
    for (const r of monthlyList) m.set(r.key, r);
    return m;
  }, [monthlyList]);

  const loadList = useCallback(async () => {
    try {
      // 日次・週次・月次の一覧をまとめて取る(いずれも軽量メタ)。
      // 週次 / 月次の一覧はカレンダーの点(生成済みかどうか)に要るので、
      // 期間タブを開いていなくても最初に取っておく。
      const [rows, weekly, monthly] = await Promise.all([
        fetchDailyList(),
        fetchPeriodList("weekly").catch(() => [] as PeriodReportMeta[]),
        fetchPeriodList("monthly").catch(() => [] as PeriodReportMeta[]),
      ]);
      if (!mounted.current) return;
      setList(rows);
      setWeeklyList(weekly);
      setMonthlyList(monthly);
      setListError(null);
    } catch (err) {
      if (!mounted.current) return;
      setListError(err instanceof Error ? err.message : String(err));
      setList([]);
    }
  }, []);

  // 初回(タブを開いたとき)だけ一覧を取る。以降は「更新」ボタンで取り直す。
  useEffect(() => {
    if (!active || list !== null) return;
    void loadList();
  }, [active, list, loadList]);

  // 44: 自動事前調査の履歴。タブを開いている間だけ取る(数 KB の軽い応答)。
  // 実行中のものがあるうちは短い間隔で、無ければ 1 分間隔で取り直し、
  // 「調査中」→「調査結果を見る」の切り替わりを待たずに反映する。
  const loadAuto = useCallback(async () => {
    try {
      const r = await fetchAutoInvestigations();
      if (!mounted.current) return;
      setAutoByKey(r.entries);
      setAutoRunning(r.running);
    } catch {
      /* 取れなくてもレポート表示そのものは成立させる(従来の「調査する」に倒れるだけ) */
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadAuto();
    const timer = setInterval(() => void loadAuto(), autoRunning > 0 ? 10_000 : 60_000);
    return () => clearInterval(timer);
  }, [active, autoRunning, loadAuto]);

  // 一覧が来たら、まだ何も選んでいなければ最新の日を開く。
  useEffect(() => {
    if (!latestDate || selectedDate !== null) return;
    setSelectedDate(latestDate);
    setSelectedWeek(weekKeyOf(latestDate));
    setSelectedMonth(monthOf(latestDate));
    setCursor(monthOf(latestDate));
  }, [latestDate, selectedDate]);

  // 選択日のレポート本体 + トレンド用の直近 N 日を取る(どちらもキャッシュ経由)。
  useEffect(() => {
    if (!selectedDate) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setMissing(false);
    setOpenIssue(null);
    void (async () => {
      try {
        const r = await fetchDaily(selectedDate);
        if (!alive) return;
        setReport(r);
        setMissing(r === null);
      } catch (err) {
        if (!alive) return;
        setReport(null);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
      // トレンドは「選択日を右端とした直近 N 日のうち、生成済みの日」だけを並べる。
      const days: string[] = [];
      for (let i = TREND_DAYS - 1; i >= 0; i -= 1) {
        const d = addDays(selectedDate, -i);
        if (reports.has(d)) days.push(d);
      }
      const many = await fetchDailyMany(days);
      if (alive) setTrend(many);
    })();
    return () => {
      alive = false;
    };
  }, [selectedDate, reports]);

  // 45: 選択中の週 / 月のレポート本体。期間タブを開いているときだけ取る。
  // 未生成(404)は例外にせず null にして、「まだ生成されていない」パネルを出す。
  const periodType: PeriodType | null = period === "daily" ? null : period;
  const periodKey = period === "weekly" ? selectedWeek : period === "monthly" ? selectedMonth : null;

  useEffect(() => {
    if (!periodType || !periodKey) {
      setPeriodReport(null);
      return;
    }
    let alive = true;
    setPeriodLoading(true);
    setPeriodError(null);
    void (async () => {
      try {
        const r = await fetchPeriod(periodType, periodKey);
        if (!alive) return;
        setPeriodReport(r);
      } catch (err) {
        if (!alive) return;
        setPeriodReport(null);
        setPeriodError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setPeriodLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [periodType, periodKey, reloadToken]);

  // 「更新」: キャッシュを捨てて一覧を取り直す。一覧の再取得で reports の同一性が変わるため、
  // 上の effect が選択日のレポートとトレンドを取り直す(ここで個別に fetch しない)。
  const onReload = useCallback(async () => {
    setReloading(true);
    clearReportCache();
    setTrend([]);
    setPeriodReport(null);
    setReloadToken((n) => n + 1);
    await Promise.all([loadList(), loadAuto()]);
    if (mounted.current) setReloading(false);
  }, [loadList, loadAuto]);

  const points = useMemo(() => toTrendPoints(trend), [trend]);

  // 週次 / 月次で選ばれた期間に含まれる、生成済みの日次レポート
  // (期間レポートがまだ無いときに「代わりにこの日を見る」導線として出す)。
  const periodDays = useMemo(() => {
    if (period === "weekly" && selectedWeek) {
      const start = weekStartOfKey(selectedWeek);
      return Array.from({ length: 7 }, (_, i) => addDays(start, i)).filter((d) => reports.has(d));
    }
    if (period === "monthly" && selectedMonth) {
      return Array.from(reports.keys())
        .filter((d) => monthOf(d) === selectedMonth)
        .sort();
    }
    return [];
  }, [period, selectedWeek, selectedMonth, reports]);

  /** 期間ピッカーで選ばれている期間の暦上の範囲(レポート未生成でも見出しに出す)。 */
  const periodRange = useMemo<{ start: string | null; end: string | null }>(() => {
    if (period === "weekly" && selectedWeek) {
      const start = weekStartOfKey(selectedWeek);
      return { start, end: addDays(start, 6) };
    }
    if (period === "monthly" && selectedMonth) {
      const [y, m] = selectedMonth.split("-").map(Number);
      return { start: `${selectedMonth}-01`, end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
    }
    return { start: null, end: null };
  }, [period, selectedWeek, selectedMonth]);

  /** 期間レポートから日次レポートへ飛ぶ(日付チップ・発生日クリック)。 */
  const openDayForPeriod = useCallback((date: string) => {
    setPeriod("daily");
    setSelectedDate(date);
    setSelectedWeek(weekKeyOf(date));
    setSelectedMonth(monthOf(date));
    setCursor(monthOf(date));
  }, []);

  /** 週次 / 月次のパネル 2 つ(上段の総括 + KPI / 下段の全幅)に同じ props を渡す。 */
  const periodViewProps = {
    periodType: (period === "monthly" ? "monthly" : "weekly") as PeriodType,
    periodKey,
    startDate: periodRange.start,
    endDate: periodRange.end,
    report: periodReport,
    loading: periodLoading,
    error: periodError,
    dailyDays: periodDays,
    autoByKey,
    onOpenDay: openDayForPeriod,
    onInvestigate,
    onOpenSite,
    onOpenHistoryFocus,
  };

  const analysis = report?.analysis ?? null;
  const overview = report?.data.overview ?? null;
  const webhook = report?.data.webhook ?? null;
  const newIssues = analysis?.issues.filter((i) => i.recurrence.status === "new").length ?? 0;
  const continuing = analysis?.issues.filter((i) => i.recurrence.status !== "new").length ?? 0;
  const criticalAlerts = webhook?.bySeverity?.critical ?? 0;
  const warningAlerts = webhook?.bySeverity?.warning ?? 0;
  const clientsAvg = overview?.totals.clients.avg ?? null;

  return (
    <div className="go-root rp-root">
      <div className="go-head">
        <div className="go-head-main">
          <h1 className="go-h1">{t("reports.title")}</h1>
          <span className="go-head-sub">{t("reports.headerSub")}</span>
        </div>
        <div className="go-head-meta rp-head-meta">
          <nav className="rp-periods" role="tablist" aria-label={t("reports.periodAria")}>
            {PERIODS.map((p) => (
              <button
                key={p}
                role="tab"
                aria-selected={period === p}
                className={`rp-period${period === p ? " rp-period-on" : ""}`}
                onClick={() => setPeriod(p)}
              >
                {t(`reports.period.${p}`)}
              </button>
            ))}
          </nav>
          <button className="go-refresh" onClick={() => void onReload()} disabled={reloading}>
            {reloading ? t("reports.reloading") : t("reports.reload")}
          </button>
        </div>
      </div>

      {listError && <div className="go-inline-error">{listError}</div>}

      <div className="rp-top">
        <PeriodPicker
          period={period}
          cursor={cursor}
          onCursor={setCursor}
          reports={reports}
          weeklyReports={weeklyReports}
          monthlyReports={monthlyReports}
          selectedDate={selectedDate}
          selectedWeek={selectedWeek}
          selectedMonth={selectedMonth}
          onSelectDate={(d) => {
            setSelectedDate(d);
            setSelectedWeek(weekKeyOf(d));
            setSelectedMonth(monthOf(d));
          }}
          onSelectWeek={setSelectedWeek}
          onSelectMonth={setSelectedMonth}
          latestDate={latestDate}
        />

        <div className="rp-top-main">
          {period !== "daily" ? (
            // ---- 45: 週次 / 月次(蓄積済みの日次レポートを集計したもの)----
            // ここは総括 + KPI まで。グラフ以降は .rp-top の下に全幅で続ける(日次と同じ骨格)。
            <PeriodSummaryPanel {...periodViewProps} />
          ) : (
            <>
              <section className="go-panel rp-summary">
                <header className="go-panel-head">
                  <span className="go-panel-title">
                    {selectedDate ?? "—"}
                    {report?.partial && <span className="go-tag go-tag-warn rp-partial">{t("reports.partial")}</span>}
                  </span>
                  {report && (
                    <span className="go-panel-note">
                      {t("reports.generatedAt", { at: formatDateTime(report.generatedAt, lang) })}
                      {" ・ "}
                      {t(`reports.generatedBy.${report.generatedBy}`)}
                      {report.llm.model && ` ・ ${report.llm.model}`}
                    </span>
                  )}
                </header>
                <div className="rp-summary-body">
                  {loading && <div className="go-loading">{t("reports.loading")}</div>}
                  {!loading && error && <div className="go-inline-error">{error}</div>}
                  {!loading && !error && missing && (
                    <div className="go-note go-note-warn">
                      {t("reports.error.notGenerated", { date: selectedDate ?? "—" })}
                    </div>
                  )}
                  {!loading && !error && analysis && (
                    <>
                      {analysis.status !== "ok" && (
                        <div className="go-note go-note-warn">
                          {t("reports.analysisFailed", { reason: analysis.error ?? "—" })}
                        </div>
                      )}
                      <p className="rp-summary-text">{analysis.summary || t("reports.noSummary")}</p>
                      {report && report.lang !== lang && (
                        <div className="go-note">{t("reports.langNote", { lang: t(`language.${report.lang}`) })}</div>
                      )}
                    </>
                  )}
                  {!loading && !error && !analysis && !selectedDate && (
                    <div className="go-loading">{t("reports.pickDay")}</div>
                  )}
                </div>
              </section>

              <div className="go-cards rp-cards">
                <KpiCard
                  label={t("reports.kpi.events")}
                  value={formatNumber(webhook?.total ?? 0, lang)}
                  sub={
                    webhook?.available === false ? (
                      <span className="go-zero">{t("reports.kpi.eventsUnavailable")}</span>
                    ) : (
                      t("reports.kpi.eventsSub")
                    )
                  }
                  title={webhook?.reason ?? undefined}
                />
                <KpiCard
                  label={t("reports.kpi.critical")}
                  value={formatNumber(criticalAlerts, lang)}
                  tone={criticalAlerts > 0 ? "bad" : "ok"}
                  sub={t("reports.kpi.criticalSub", { n: formatNumber(warningAlerts, lang) })}
                />
                <KpiCard
                  label={t("reports.kpi.clients")}
                  value={clientsAvg === null ? "—" : formatNumber(Math.round(clientsAvg), lang)}
                  sub={
                    overview?.source === "current-snapshot"
                      ? t("reports.kpi.clientsSnapshot")
                      : t("reports.kpi.clientsSub", {
                          min: overview?.totals.clients.min ?? "—",
                          max: overview?.totals.clients.max ?? "—",
                        })
                  }
                  title={overview?.notes.join("\n")}
                />
                <KpiCard
                  label={t("reports.kpi.newIssues")}
                  value={formatNumber(newIssues, lang)}
                  tone={newIssues > 0 ? "warn" : "ok"}
                  sub={t("reports.kpi.newIssuesSub", { n: formatNumber(continuing, lang) })}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---- 45: 週次 / 月次の続き(グラフ・起きたこと・問題の表)。全幅で出す ---- */}
      {period !== "daily" && periodReport && <PeriodDetailPanels {...periodViewProps} />}

      {period === "daily" && report && (
        <>
          {/* ---- グラフ(直近 N 日を並べた簡易トレンド)---- */}
          <div className="rp-charts">
            <section className="go-panel">
              <header className="go-panel-head">
                <span className="go-panel-title">{t("reports.charts.healthTitle")}</span>
                <span className="go-panel-note">{t("reports.charts.rangeNote", { n: points.length })}</span>
              </header>
              <div className="rp-panel-body">
                <HealthTrend points={points} />
                <SiteLinks sites={overview?.sites ?? []} onOpenSite={onOpenSite} />
              </div>
            </section>

            <section className="go-panel">
              <header className="go-panel-head">
                <span className="go-panel-title">{t("reports.charts.clientsTitle")}</span>
                <span className="go-panel-note">{t("reports.charts.rangeNote", { n: points.length })}</span>
              </header>
              <div className="rp-panel-body">
                <ClientsTrend points={points} />
                <div className="go-note" title={overview?.traffic.reason ?? undefined}>
                  {t("reports.charts.trafficNote")}
                </div>
              </div>
            </section>
          </div>

          {/* ---- この期間に起きたこと ---- */}
          <section className="go-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">{t("reports.highlights.title")}</span>
              <span className="go-panel-note">
                {t("reports.highlights.count", { n: analysis?.highlights.length ?? 0 })}
              </span>
              <span className="go-panel-note rp-hint">{t("reports.highlights.hint")}</span>
            </header>
            <div className="rp-hl-list">
              {(analysis?.highlights ?? []).map((h, i) => (
                <button
                  key={`${h.title}-${i}`}
                  className="rp-hl"
                  onClick={() => onInvestigate?.(buildHighlightQuery(report.date, h))}
                  title={t("reports.investigateBtnTitle")}
                >
                  <span className={`rp-sev rp-sev-${h.severity}`}>{t(`reports.severity.${h.severity}`)}</span>
                  <span className="rp-hl-body">
                    <span className="rp-hl-title">{h.title}</span>
                    <span className="rp-hl-meta">
                      <span className="go-mono">{formatDateTime(h.at, lang)}</span>
                      {h.site && <span className="rp-hl-tag">{h.site}</span>}
                      {h.device && <span className="rp-hl-tag go-mono">{h.device}</span>}
                      {h.platform && (
                        <span className={`rp-plat rp-plat-${h.platform}`}>{t(`reports.platform.${h.platform}`)}</span>
                      )}
                      <span className="rp-hl-src">{t("reports.highlights.source", { source: h.source })}</span>
                    </span>
                    <span className="rp-hl-detail">{h.detail}</span>
                  </span>
                  <span className="rp-hl-go">{t("reports.investigateBtn")} →</span>
                </button>
              ))}
              {(analysis?.highlights.length ?? 0) === 0 && (
                <div className="go-loading">{t("reports.highlights.empty")}</div>
              )}
            </div>
          </section>

          {/* ---- 検出された問題 ---- */}
          <section className="go-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">{t("reports.issues.title")}</span>
              <span className="go-panel-note">{t("reports.issues.count", { n: analysis?.issues.length ?? 0 })}</span>
              {autoRunning > 0 && (
                <span className="go-tag go-tag-warn rp-auto-running">
                  {t("reports.auto.runningCount", { n: autoRunning })}
                </span>
              )}
              <span className="go-panel-note rp-hint">{t("reports.issues.hint")}</span>
            </header>
            <div className="go-table-scroll rp-issues-scroll">
              <table className="go-table rp-issues">
                <thead>
                  <tr>
                    <th className="rp-c-exp" />
                    <th>{t("reports.issues.colName")}</th>
                    <th>{t("reports.issues.colDevice")}</th>
                    <th>{t("reports.issues.colSite")}</th>
                    <th>{t("reports.issues.colFirstSeen")}</th>
                    <th>{t("reports.issues.colPlatform")}</th>
                    <th>{t("reports.issues.colSeverity")}</th>
                    <th>{t("reports.issues.colRecurrence")}</th>
                    <th>{t("reports.issues.colNextAction")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(analysis?.issues ?? []).map((issue) => (
                    <IssueRow
                      key={issue.key}
                      issue={issue}
                      date={report.date}
                      open={openIssue === issue.key}
                      onToggle={() => setOpenIssue((k) => (k === issue.key ? null : issue.key))}
                      onInvestigate={onInvestigate}
                      auto={autoByKey[issue.key]}
                      onOpenHistoryFocus={onOpenHistoryFocus}
                    />
                  ))}
                  {(analysis?.issues.length ?? 0) === 0 && (
                    <tr>
                      <td className="go-empty-row" colSpan={10}>
                        {t("reports.issues.empty")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <div className="go-foot go-mono">
            {t("reports.footer", {
              date: report.date,
              tz: report.timeZone,
              events: formatNumber(webhook?.total ?? 0, lang),
              investigations: formatNumber(report.data.investigations.total, lang),
            })}
          </div>
        </>
      )}
    </div>
  );
}
