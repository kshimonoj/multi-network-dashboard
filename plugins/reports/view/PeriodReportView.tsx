// 週次 / 月次レポートの表示(45 Task 4-2)。43 番の「準備中」パネルを置き換えるもの。
//
// 骨格は日次と揃えてある(総括 → KPI → グラフ → 起きたこと → 検出された問題)。
// 日次と違う点は 3 つ:
//
//  1) **総括の文章はサーバから来ない**。週次 / 月次は LLM を使わない機械集計なので、
//     サーバは coverage / kpi(数値)と notes(コード + 値)しか返さない。
//     ここで t() を通して日英の文にする(CLAUDE.md「サーバ生成の文言を画面に出すとき」)。
//     → 言語を切り替えると総括・注記もその場で切り替わる。
//  2) 問題の表が「期間内で何日出たか」「延べ発生回数」「最長連続日数」を持つ
//     (名寄せキーで日をまたいで 1 行にまとめているため)。
//  3) 「起きたこと」「問題」の本文は **生成時の日次レポートの文言のまま**(実行時の記録は翻訳しない)。
//
// 44 の自動事前調査は日次レポート生成時に名寄せキー単位で走っているので、
// 週次 / 月次でも同じキーで引き当てて「調査結果を見る」を出せる(新たな調査は仕掛けない)。

import { useMemo, useState } from "react";
import { useLanguage } from "../../../src/i18n/LanguageContext";
import { formatDateTime, formatNumber } from "../../../src/i18n";
import type { InvestigationRequest, PendingHistoryFocus, SiteFocusRequest } from "../../../src/shell";
import { AutoPanel } from "./AutoPanel";
import { formatDayLabel } from "./dates";
import { buildPeriodHighlightQuery, buildPeriodIssueQuery } from "./investigate";
import { ClientsTrend, HealthTrend, type TrendPoint } from "./Trends";
import type {
  AutoInvestigationEntry,
  PeriodIssue,
  PeriodReport,
  PeriodSiteStat,
  PeriodType,
} from "./types";

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

/** 注記に埋める日付リストの表示上限。全部出すと 1 か月ぶん(最大 31 個)並んで読めなくなる。 */
const NOTE_DATES_MAX = 6;

/**
 * 注記の {dates} を「先頭 6 件 + …」に切り詰める。
 * 完全な一覧は注記の title(ツールチップ)側に残してあるので、情報は落ちない。
 */
function shortenDates(params: Record<string, string | number> | undefined): Record<string, string | number> {
  const p = { ...(params ?? {}) };
  if (typeof p.dates !== "string") return p;
  const all = p.dates.split(", ");
  if (all.length > NOTE_DATES_MAX) p.dates = `${all.slice(0, NOTE_DATES_MAX).join(", ")} …`;
  return p;
}

/** サーバの trend.points → Trends.tsx が受け取る形。日次のグラフと同じ部品を使い回す。 */
function toTrendPoints(report: PeriodReport): TrendPoint[] {
  return report.trend.points.map((p) => ({
    date: p.startDate,
    label: p.label,
    centralHealth: p.centralHealth,
    mistSle: p.mistSle,
    clients: p.clients === null ? null : Math.round(p.clients),
    // 母数はサイト数ではなく「この点に寄与した日数」。tooltip には出さないので 0 でよいが、
    // 型を満たすために日数を入れておく(0 だと「データ無し」と読めてしまう)。
    centralSites: p.days,
    mistSites: p.days,
  }));
}

function SiteLinks({
  sites,
  onOpenSite,
}: {
  sites: PeriodSiteStat[];
  onOpenSite?: (req: SiteFocusRequest) => void;
}) {
  const { t } = useLanguage();
  const ordered = useMemo(() => {
    const score = (s: PeriodSiteStat): number => {
      const v = s.platform === "central" ? s.centralHealth : s.mistSle;
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
          const v = s.platform === "central" ? s.centralHealth : s.mistSle;
          const tone =
            typeof v !== "number" ? "" : v >= 80 ? " rp-chip-ok" : v >= 50 ? " rp-chip-warn" : " rp-chip-bad";
          return (
            <button
              key={`${s.platform}:${s.siteName}`}
              className={`rp-chip rp-chip-${s.platform}${tone}`}
              onClick={() => onOpenSite?.({ siteName: s.siteName, platform: s.platform })}
              title={t("reports.periodReport.siteChipTitle", { site: s.siteName, n: s.days })}
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

function PeriodIssueRow({
  issue,
  report,
  open,
  onToggle,
  onInvestigate,
  auto,
  onOpenHistoryFocus,
  onOpenDay,
}: {
  issue: PeriodIssue;
  report: PeriodReport;
  open: boolean;
  onToggle: () => void;
  onInvestigate?: (req: InvestigationRequest) => void;
  auto?: AutoInvestigationEntry;
  onOpenHistoryFocus?: (runId: PendingHistoryFocus) => void;
  /** 発生日をクリックしたら、その日の日次レポートを開く */
  onOpenDay: (date: string) => void;
}) {
  const { lang, t } = useLanguage();
  const hasResult = Boolean(onOpenHistoryFocus && auto?.status === "done" && auto.runId);
  const goInvestigate = () =>
    onInvestigate?.(buildPeriodIssueQuery(report.periodType, report.startDate, report.endDate, issue));
  const goResult = () => onOpenHistoryFocus?.(auto!.runId!);

  return (
    <>
      <tr
        className={`rp-issue-row${open ? " rp-row-open" : ""}`}
        onClick={hasResult ? goResult : goInvestigate}
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
            <span
              className={`rp-auto-tag rp-auto-${auto.status}`}
              title={t("reports.auto.tagTitle", { date: auto.date })}
            >
              {t(`reports.auto.tag.${auto.status}`)}
            </span>
          )}
        </td>
        <td className="rp-c-device">{issue.device ?? <span className="go-zero">—</span>}</td>
        <td className="rp-c-site">{issue.site ?? <span className="go-zero">—</span>}</td>
        <td className="rp-c-days">
          <span className="rp-days-n">
            {t("reports.periodReport.daysOf", { n: issue.days, of: report.coverage.availableDays })}
          </span>
          {issue.streak > 1 && (
            <span className="rp-days-streak" title={t("reports.periodReport.streakTitle", { n: issue.streak })}>
              {t("reports.periodReport.streak", { n: issue.streak })}
            </span>
          )}
        </td>
        <td className="rp-c-occ">{formatNumber(issue.occurrences, lang)}</td>
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
          <span className={`rp-rec rp-rec-${issue.status === "new" ? "new" : "continuing"}`}>
            {t(`reports.periodIssue.status.${issue.status}`)}
          </span>
          {issue.carriedOver && (
            <span className="rp-rec-n" title={t("reports.periodReport.firstSeenTitle", { date: issue.firstSeenDate })}>
              {issue.firstSeenDate}
            </span>
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
          <td colSpan={11}>
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
                <span className="rp-detail-label">{t("reports.periodReport.firstSeenAt")}</span>
                <span className="rp-detail-value">{formatDateTime(issue.firstSeenAt, lang)}</span>
              </div>
              <div>
                <span className="rp-detail-label">{t("reports.issues.firstSeenDate")}</span>
                <span className="rp-detail-value">{issue.firstSeenDate}</span>
              </div>
              <div className="rp-detail-wide">
                <span className="rp-detail-label">{t("reports.periodReport.occurredOn")}</span>
                <span className="rp-detail-value">
                  <span className="rp-chips rp-chips-inline">
                    {issue.dates.map((d) => (
                      <button
                        key={d}
                        className="rp-chip rp-chip-day"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenDay(d);
                        }}
                        title={t("reports.periodReport.openDay", { date: d })}
                      >
                        <span className="rp-chip-name go-mono">{d}</span>
                      </button>
                    ))}
                  </span>
                </span>
              </div>
              {issue.recurrenceNote && (
                <div className="rp-detail-wide">
                  <span className="rp-detail-label">{t("reports.issues.recurrenceNote")}</span>
                  <span className="rp-detail-value">{issue.recurrenceNote}</span>
                </div>
              )}
              {issue.previousDates.length > 0 && (
                <div className="rp-detail-wide">
                  <span className="rp-detail-label">{t("reports.periodReport.beforePeriod")}</span>
                  <span className="rp-detail-value go-mono">{issue.previousDates.join(", ")}</span>
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

export interface PeriodReportViewProps {
  periodType: PeriodType;
  /** 選択中の期間キー("YYYY-Www" / "YYYY-MM")。未選択なら null */
  periodKey: string | null;
  /** 期間の暦上の範囲(レポートが未生成でも見出しに出す) */
  startDate: string | null;
  endDate: string | null;
  report: PeriodReport | null;
  loading: boolean;
  error: string | null;
  /** 期間内の生成済み日次レポートの日付(未生成のときの導線に使う) */
  dailyDays: string[];
  autoByKey: Record<string, AutoInvestigationEntry>;
  onOpenDay: (date: string) => void;
  onInvestigate?: (req: InvestigationRequest) => void;
  onOpenSite?: (req: SiteFocusRequest) => void;
  onOpenHistoryFocus?: (runId: PendingHistoryFocus) => void;
}

/**
 * 上段(カレンダーの右列)に出す「総括 + KPI」。
 *
 * 画面の骨格は日次と揃えてあるので、レポート本体は 2 つに分けて描く:
 *   PeriodSummaryPanel … .rp-top-main(カレンダーの右)に入る総括 + KPI カード
 *   PeriodDetailPanels … .rp-top の下に全幅で続くグラフ・起きたこと・問題の表
 * (1 コンポーネントで全部描くと、週次だけカレンダー横の狭い列に押し込まれてしまう)
 */
export function PeriodSummaryPanel(props: PeriodReportViewProps) {
  const { lang, t } = useLanguage();
  const { periodType, report } = props;

  const rangeLabel =
    props.startDate && props.endDate
      ? t("reports.periodReport.range", {
          from: formatDayLabel(props.startDate, lang),
          to: formatDayLabel(props.endDate, lang),
        })
      : "—";
  const title =
    periodType === "weekly"
      ? t("reports.periodReport.weeklyTitle", { key: props.periodKey ?? "—", range: rangeLabel })
      : t("reports.periodReport.monthlyTitle", { key: props.periodKey ?? "—", range: rangeLabel });

  // ---- レポートがまだ無いとき ----
  if (!report) {
    return (
      <section className="go-panel rp-soon">
        <header className="go-panel-head">
          <span className="go-panel-title">{title}</span>
          {!props.loading && !props.error && <span className="go-tag go-tag-warn">{t("reports.periodReport.notGeneratedBadge")}</span>}
        </header>
        <div className="rp-soon-body">
          {props.loading && <div className="go-loading">{t("reports.loading")}</div>}
          {!props.loading && props.error && <div className="go-inline-error">{props.error}</div>}
          {!props.loading && !props.error && (
            <>
              <p className="rp-soon-text">
                {t(
                  props.dailyDays.length > 0
                    ? "reports.periodReport.notGeneratedYet"
                    : "reports.periodReport.noDailyAtAll",
                )}
              </p>
              <div className="go-note">{t("reports.periodReport.daysNote", { n: props.dailyDays.length })}</div>
              <div className="rp-chips">
                {props.dailyDays.map((d) => (
                  <button
                    key={d}
                    className="rp-chip rp-chip-day"
                    onClick={() => props.onOpenDay(d)}
                    title={t("reports.periodReport.openDay", { date: d })}
                  >
                    <span className="rp-chip-name go-mono">{d}</span>
                  </button>
                ))}
                {props.dailyDays.length === 0 && <span className="go-zero">{t("reports.periodReport.noDays")}</span>}
              </div>
            </>
          )}
        </div>
      </section>
    );
  }

  const cov = report.coverage;
  const kpi = report.kpi;
  // 総括はサーバの文章ではなく、数値から辞書で組み立てる(言語切替に追従する)。
  const summary = t("reports.periodReport.summary", {
    days: cov.availableDays,
    of: cov.periodDays,
    events: formatNumber(kpi.events.total, lang),
    critical: formatNumber(kpi.alerts.critical, lang),
    issues: formatNumber(kpi.issues.unique, lang),
    newIssues: formatNumber(kpi.issues.new, lang),
    carried: formatNumber(kpi.issues.carried, lang),
  });

  return (
    <>
      <section className="go-panel rp-summary">
        <header className="go-panel-head">
          <span className="go-panel-title">
            {title}
            {cov.inProgress && (
              <span className="go-tag go-tag-warn rp-partial">{t("reports.periodReport.inProgressBadge")}</span>
            )}
            {!cov.complete && (
              <span className="go-tag go-tag-warn rp-partial">{t("reports.periodReport.partialBadge")}</span>
            )}
          </span>
          <span className="go-panel-note">
            {t("reports.generatedAt", { at: formatDateTime(report.generatedAt, lang) })}
            {" ・ "}
            {t(`reports.generatedBy.${report.generatedBy}`)}
            {" ・ "}
            {t("reports.periodReport.aggregatedFrom", { n: cov.availableDays })}
          </span>
        </header>
        <div className="rp-summary-body">
          <p className="rp-summary-text">{summary}</p>
          {report.notes.map((n) => (
            <div className="go-note go-note-warn" key={n.code} title={String(n.params?.dates ?? "")}>
              {t(`reports.periodNote.${n.code}`, shortenDates(n.params))}
            </div>
          ))}
          <div className="go-note">{t("reports.periodReport.noLlmNote")}</div>
        </div>
      </section>

      <div className="go-cards rp-cards">
        <KpiCard
          label={t("reports.kpi.events")}
          value={formatNumber(kpi.events.total, lang)}
          sub={
            kpi.events.countedDays === 0 ? (
              <span className="go-zero">{t("reports.kpi.eventsUnavailable")}</span>
            ) : (
              t("reports.periodReport.eventsSub", {
                avg: formatNumber(Math.round(kpi.events.perDayAvg ?? 0), lang),
                n: kpi.events.countedDays,
              })
            )
          }
          title={
            kpi.events.unavailableDays.length > 0
              ? t("reports.periodNote.webhook-unavailable-days", {
                  n: kpi.events.unavailableDays.length,
                  dates: kpi.events.unavailableDays.join(", "),
                })
              : undefined
          }
        />
        <KpiCard
          label={t("reports.kpi.critical")}
          value={formatNumber(kpi.alerts.critical, lang)}
          tone={kpi.alerts.critical > 0 ? "bad" : "ok"}
          sub={
            kpi.alerts.worstDate
              ? t("reports.periodReport.criticalSub", {
                  warning: formatNumber(kpi.alerts.warning, lang),
                  date: kpi.alerts.worstDate,
                  n: formatNumber(kpi.alerts.worstValue, lang),
                })
              : t("reports.kpi.criticalSub", { n: formatNumber(kpi.alerts.warning, lang) })
          }
        />
        <KpiCard
          label={t("reports.kpi.clients")}
          value={kpi.clients.avg === null ? "—" : formatNumber(Math.round(kpi.clients.avg), lang)}
          sub={t("reports.periodReport.clientsSub", {
            min: kpi.clients.min ?? "—",
            max: kpi.clients.max ?? "—",
            n: kpi.clients.days,
          })}
          title={kpi.clients.maxDate ? t("reports.periodReport.clientsPeak", { date: kpi.clients.maxDate }) : undefined}
        />
        <KpiCard
          label={t("reports.kpi.newIssues")}
          value={formatNumber(kpi.issues.new, lang)}
          tone={kpi.issues.new > 0 ? "warn" : "ok"}
          sub={t("reports.periodReport.newIssuesSub", {
            carried: formatNumber(kpi.issues.carried, lang),
            unique: formatNumber(kpi.issues.unique, lang),
          })}
        />
      </div>
    </>
  );
}

/** 下段(全幅)に出すグラフ・起きたこと・検出された問題・集計元。 */
export function PeriodDetailPanels(props: PeriodReportViewProps) {
  const { lang, t } = useLanguage();
  const { report } = props;
  const [openIssue, setOpenIssue] = useState<string | null>(null);
  const points = useMemo(() => (report ? toTrendPoints(report) : []), [report]);

  if (!report) return null;
  const cov = report.coverage;
  const kpi = report.kpi;

  return (
    <>
      {/* ---- グラフ ---- */}
      <div className="rp-charts">
        <section className="go-panel">
          <header className="go-panel-head">
            <span className="go-panel-title">{t("reports.charts.healthTitle")}</span>
            <span className="go-panel-note">
              {t(
                report.trend.granularity === "day"
                  ? "reports.periodReport.trendNoteDay"
                  : "reports.periodReport.trendNoteWeek",
                { n: points.length },
              )}
            </span>
          </header>
          <div className="rp-panel-body">
            <HealthTrend points={points} />
            <SiteLinks sites={report.sites} onOpenSite={props.onOpenSite} />
          </div>
        </section>

        <section className="go-panel">
          <header className="go-panel-head">
            <span className="go-panel-title">{t("reports.charts.clientsTitle")}</span>
            <span className="go-panel-note">
              {t(
                report.trend.granularity === "day"
                  ? "reports.periodReport.trendNoteDay"
                  : "reports.periodReport.trendNoteWeek",
                { n: points.length },
              )}
            </span>
          </header>
          <div className="rp-panel-body">
            <ClientsTrend points={points} />
            <div className="go-note">{t("reports.charts.trafficNote")}</div>
          </div>
        </section>
      </div>

      {/* ---- この期間に起きたこと ---- */}
      <section className="go-panel">
        <header className="go-panel-head">
          <span className="go-panel-title">{t("reports.highlights.title")}</span>
          <span className="go-panel-note">{t("reports.highlights.count", { n: report.highlights.length })}</span>
          {report.highlightsTruncated > 0 && (
            <span className="go-panel-note">
              {t("reports.periodReport.highlightsTruncated", { n: report.highlightsTruncated })}
            </span>
          )}
          <span className="go-panel-note rp-hint">{t("reports.highlights.hint")}</span>
        </header>
        <div className="rp-hl-list">
          {report.highlights.map((h, i) => (
            <button
              key={`${h.title}-${i}`}
              className="rp-hl"
              onClick={() =>
                props.onInvestigate?.(
                  buildPeriodHighlightQuery(report.periodType, report.startDate, report.endDate, h),
                )
              }
              title={t("reports.investigateBtnTitle")}
            >
              <span className={`rp-sev rp-sev-${h.severity}`}>{t(`reports.severity.${h.severity}`)}</span>
              <span className="rp-hl-body">
                <span className="rp-hl-title">{h.title}</span>
                <span className="rp-hl-meta">
                  <span
                    className="go-mono rp-hl-date"
                    role="link"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onOpenDay(h.date);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.stopPropagation();
                      props.onOpenDay(h.date);
                    }}
                    title={t("reports.periodReport.openDay", { date: h.date })}
                  >
                    {h.date}
                  </span>
                  {h.dates.length > 1 && (
                    <span className="rp-hl-tag">{t("reports.periodReport.onNDays", { n: h.dates.length })}</span>
                  )}
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
          {report.highlights.length === 0 && <div className="go-loading">{t("reports.highlights.empty")}</div>}
        </div>
      </section>

      {/* ---- 検出された問題(名寄せキーで集約)---- */}
      <section className="go-panel">
        <header className="go-panel-head">
          <span className="go-panel-title">{t("reports.issues.title")}</span>
          <span className="go-panel-note">
            {t("reports.periodReport.issuesCount", { n: report.issues.length, total: kpi.issues.dayTotal })}
          </span>
          <span className="go-panel-note rp-hint">{t("reports.periodReport.issuesHint")}</span>
        </header>
        <div className="go-table-scroll rp-issues-scroll">
          <table className="go-table rp-issues">
            <thead>
              <tr>
                <th className="rp-c-exp" />
                <th>{t("reports.issues.colName")}</th>
                <th>{t("reports.issues.colDevice")}</th>
                <th>{t("reports.issues.colSite")}</th>
                <th>{t("reports.periodReport.colDays")}</th>
                <th>{t("reports.periodReport.colOccurrences")}</th>
                <th>{t("reports.issues.colPlatform")}</th>
                <th>{t("reports.issues.colSeverity")}</th>
                <th>{t("reports.periodReport.colStatus")}</th>
                <th>{t("reports.issues.colNextAction")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {report.issues.map((issue) => (
                <PeriodIssueRow
                  key={issue.key}
                  issue={issue}
                  report={report}
                  open={openIssue === issue.key}
                  onToggle={() => setOpenIssue((k) => (k === issue.key ? null : issue.key))}
                  onInvestigate={props.onInvestigate}
                  auto={props.autoByKey[issue.key]}
                  onOpenHistoryFocus={props.onOpenHistoryFocus}
                  onOpenDay={props.onOpenDay}
                />
              ))}
              {report.issues.length === 0 && (
                <tr>
                  <td className="go-empty-row" colSpan={11}>
                    {t("reports.issues.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- 集計に使った日次レポート ---- */}
      <section className="go-panel">
        <header className="go-panel-head">
          <span className="go-panel-title">{t("reports.periodReport.sourceTitle")}</span>
          <span className="go-panel-note">
            {t("reports.periodReport.sourceCount", { n: cov.availableDays, of: cov.expectedDays })}
          </span>
        </header>
        <div className="rp-soon-body">
          <div className="rp-chips">
            {report.sourceReports.map((s) => (
              <button
                key={s.date}
                className={`rp-chip rp-chip-day${s.analysisStatus !== "ok" ? " rp-chip-bad" : ""}`}
                onClick={() => props.onOpenDay(s.date)}
                title={t("reports.periodReport.sourceChipTitle", {
                  date: s.date,
                  issues: s.issues,
                  events: s.events,
                  status: s.analysisStatus,
                })}
              >
                <span className="rp-chip-name go-mono">{s.date}</span>
                <span className="rp-chip-score">{s.issues}</span>
              </button>
            ))}
          </div>
          {cov.missingDays.length > 0 && (
            <div className="go-note go-note-warn" title={cov.missingDays.join(", ")}>
              {t("reports.periodNote.missing-days", {
                n: cov.missingDays.length,
                of: cov.expectedDays,
                dates: cov.missingDays.slice(0, 8).join(", ") + (cov.missingDays.length > 8 ? " …" : ""),
              })}
            </div>
          )}
        </div>
      </section>

      <div className="go-foot go-mono">
        {t("reports.periodReport.footer", {
          key: report.key,
          from: report.startDate,
          to: report.endDate,
          tz: report.timeZone,
          days: cov.availableDays,
          events: formatNumber(kpi.events.total, lang),
          investigations: formatNumber(kpi.investigations.total, lang),
        })}
      </div>
    </>
  );
}
