// レポートタブ(43 Task 2 / 45 Task 4-3)— カレンダー的な期間ピッカー。
//
// 横スクロールのピル一覧ではなく「暦」で選ばせる。3 つのモードで同じ枠を使い回す:
//   daily   … 月表示のグリッドから 1 日を選ぶ。生成済みの日だけ押せる(未生成日は薄く出して無効化)
//   weekly  … 同じ月表示のグリッドを「行」で選ぶ。左端に ISO 週(7/27–8/2)を出す
//   monthly … 年表示に切り替え、12 か月のマスから選ぶ
//
// 45 での変更点:
//   - 週は **月曜始まり(ISO 8601)** にした。カレンダーの 1 行 = 1 つの週次レポートの対象期間に
//     なるようにするため(週次レポートは月曜〜日曜で作る)。
//   - 週 / 月のマスの「点」は、**その期間の週次 / 月次レポートが生成済みか** で決まる。
//     日次レポートがあるだけの期間は薄い点(生成待ち)にして、押したときに
//     「まだ生成されていない」と分かるようにする(空振りのクリックを許す代わりに理由を出す)。
//
// 「その日にレポートがあるか」はサーバの一覧(GET /api/reports/daily ・/weekly ・/monthly)だけで決める。
// 重大な問題があった期間は点の色を変え、暦を見ただけで荒れた週に当たりが付くようにする。

import { useMemo } from "react";
import { useLanguage } from "../../../src/i18n/LanguageContext";
import {
  WEEKDAY_KEYS,
  addMonths,
  endOfWeek,
  formatAxisDay,
  formatMonthLabel,
  formatMonthShort,
  monthGrid,
  monthOf,
  weekKeyOf,
  today,
} from "./dates";
import type { DailyReportMeta, PeriodReportMeta, ReportPeriod } from "./types";

export interface PickerProps {
  period: ReportPeriod;
  /** 表示中の月("YYYY-MM")。monthly のときは年だけを使う */
  cursor: string;
  onCursor: (ym: string) => void;
  /** 生成済み日次レポート(日付キー → メタ) */
  reports: Map<string, DailyReportMeta>;
  /** 45: 生成済み週次レポート("YYYY-Www" → メタ) */
  weeklyReports: Map<string, PeriodReportMeta>;
  /** 45: 生成済み月次レポート("YYYY-MM" → メタ) */
  monthlyReports: Map<string, PeriodReportMeta>;
  selectedDate: string | null;
  /** 45: 選択中の週は ISO 週キー("YYYY-Www") */
  selectedWeek: string | null;
  selectedMonth: string | null;
  onSelectDate: (date: string) => void;
  onSelectWeek: (weekKey: string) => void;
  onSelectMonth: (ym: string) => void;
  /** 「最新」ボタンの飛び先(生成済みの最も新しい日)。無ければ null */
  latestDate: string | null;
}

/** 日セルの状態色。重大な問題があった日を赤、問題ありを黄、それ以外を緑にする。 */
function dotTone(meta: { criticalIssues: number; issues: number } | undefined): "bad" | "warn" | "ok" | null {
  if (!meta) return null;
  if (meta.criticalIssues > 0) return "bad";
  if (meta.issues > 0) return "warn";
  return "ok";
}

export function PeriodPicker(props: PickerProps) {
  const { lang, t } = useLanguage();
  const { period, cursor, reports, weeklyReports, monthlyReports } = props;
  const todayKey = today();

  const weeks = useMemo(() => monthGrid(cursor), [cursor]);
  const year = Number(cursor.slice(0, 4));
  const months = useMemo(
    () => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`),
    [year],
  );

  // 月 / 年の移動幅。monthly のときだけ 12 か月単位で送る。
  const step = period === "monthly" ? 12 : 1;
  const headLabel = period === "monthly" ? String(year) : formatMonthLabel(cursor, lang);

  /** その月に生成済み日次レポートが何日ぶんあるか。 */
  const countIn = (ym: string): number => {
    let n = 0;
    for (const date of reports.keys()) if (monthOf(date) === ym) n += 1;
    return n;
  };

  return (
    <section className="go-panel rp-picker">
      <header className="go-panel-head rp-picker-head">
        <button
          className="rp-nav"
          onClick={() => props.onCursor(addMonths(cursor, -step))}
          aria-label={t(period === "monthly" ? "reports.picker.prevYear" : "reports.picker.prevMonth")}
          title={t(period === "monthly" ? "reports.picker.prevYear" : "reports.picker.prevMonth")}
        >
          ‹
        </button>
        <span className="rp-picker-title">{headLabel}</span>
        <button
          className="rp-nav"
          onClick={() => props.onCursor(addMonths(cursor, step))}
          aria-label={t(period === "monthly" ? "reports.picker.nextYear" : "reports.picker.nextMonth")}
          title={t(period === "monthly" ? "reports.picker.nextYear" : "reports.picker.nextMonth")}
        >
          ›
        </button>
        {props.latestDate && (
          <button
            className="rp-latest"
            onClick={() => {
              props.onCursor(monthOf(props.latestDate!));
              if (period === "daily") props.onSelectDate(props.latestDate!);
              else if (period === "weekly") props.onSelectWeek(weekKeyOf(props.latestDate!));
              else props.onSelectMonth(monthOf(props.latestDate!));
            }}
            title={t("reports.picker.latestTitle", { date: props.latestDate })}
          >
            {t("reports.picker.latest")}
          </button>
        )}
      </header>

      <div className="rp-picker-body">
        {period === "monthly" ? (
          <div className="rp-months">
            {months.map((ym) => {
              const days = countIn(ym);
              const meta = monthlyReports.get(ym);
              const on = props.selectedMonth === ym;
              const tone = dotTone(meta);
              // 月次レポートも日次も無い月は押せない(見る中身が無い)。
              const empty = !meta && days === 0;
              return (
                <button
                  key={ym}
                  className={`rp-month${on ? " rp-month-on" : ""}${empty ? " rp-month-empty" : ""}`}
                  aria-pressed={on}
                  disabled={empty}
                  onClick={() => props.onSelectMonth(ym)}
                  title={
                    meta
                      ? t("reports.picker.monthReportTitle", {
                          month: ym,
                          n: meta.availableDays,
                          of: meta.periodDays,
                          issues: meta.issues,
                          critical: meta.criticalIssues,
                        })
                      : t("reports.picker.monthTitle", { month: ym, n: days })
                  }
                >
                  <span className="rp-month-name">{formatMonthShort(ym, lang)}</span>
                  <span className="rp-month-count">
                    {meta ? t("reports.picker.daysCount", { n: meta.availableDays }) : days === 0 ? "—" : t("reports.picker.daysCountPending", { n: days })}
                  </span>
                  <span className={`rp-day-dot${tone ? ` rp-dot-${tone}` : ""}${meta ? "" : " rp-dot-pending"}`} aria-hidden />
                </button>
              );
            })}
          </div>
        ) : (
          <div className={`rp-grid${period === "weekly" ? " rp-grid-weekly" : ""}`}>
            {period === "weekly" && <div className="rp-wd rp-wd-range">{t("reports.picker.weekColumn")}</div>}
            {WEEKDAY_KEYS.map((k) => (
              <div key={k} className={`rp-wd rp-wd-${k}`}>
                {t(`reports.weekday.${k}`)}
              </div>
            ))}

            {weeks.map((week) => {
              const wStart = week[0].date;
              const wKey = weekKeyOf(wStart);
              const wMeta = weeklyReports.get(wKey);
              const weekSelected = period === "weekly" && props.selectedWeek === wKey;
              const dailyInWeek = week.filter((c) => reports.has(c.date)).length;
              const weekHas = Boolean(wMeta) || dailyInWeek > 0;
              const weekTone = dotTone(wMeta);
              return (
                // 親(.rp-grid)の CSS グリッドに 7 列で並べたいので、週の箱は display:contents。
                <div className="rp-week" key={wStart}>
                  {period === "weekly" && (
                    <button
                      className={`rp-week-range${weekSelected ? " rp-week-on" : ""}`}
                      aria-pressed={weekSelected}
                      disabled={!weekHas}
                      onClick={() => props.onSelectWeek(wKey)}
                      title={
                        wMeta
                          ? t("reports.picker.weekReportTitle", {
                              key: wKey,
                              from: wStart,
                              to: endOfWeek(wStart),
                              n: wMeta.availableDays,
                              of: wMeta.periodDays,
                              issues: wMeta.issues,
                              critical: wMeta.criticalIssues,
                            })
                          : t("reports.picker.weekTitle", {
                              key: wKey,
                              from: wStart,
                              to: endOfWeek(wStart),
                              n: dailyInWeek,
                            })
                      }
                    >
                      {/* 週の範囲はロケール依存の「7月27日」だと 1 列に収まらないので、
                          日英どちらでも誤読しない M/D 表記にする(完全な日付は title に出す)。 */}
                      {formatAxisDay(wStart)}–{formatAxisDay(endOfWeek(wStart))}
                      {weekHas && (
                        <span
                          className={`rp-week-dot${weekTone ? ` rp-dot-${weekTone}` : ""}${wMeta ? "" : " rp-dot-pending"}`}
                          aria-hidden
                        />
                      )}
                    </button>
                  )}
                  {week.map((cell) => {
                    const meta = reports.get(cell.date);
                    const tone = dotTone(meta);
                    const has = Boolean(meta);
                    const selected = period === "daily" ? props.selectedDate === cell.date : weekSelected;
                    const cls = [
                      "rp-day",
                      cell.inMonth ? "" : "rp-day-out",
                      has ? "rp-day-has" : "rp-day-none",
                      selected ? "rp-day-on" : "",
                      cell.date === todayKey ? "rp-day-today" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    // daily は未生成日を押させない。weekly は「週」を選ぶので、その週に
                    // 週次レポートか日次レポートがあれば押せる(空の週だけ無効)。
                    const disabled = period === "daily" ? !has : !weekHas;
                    return (
                      <button
                        key={cell.date}
                        className={cls}
                        disabled={disabled}
                        aria-pressed={selected}
                        onClick={() =>
                          period === "daily" ? props.onSelectDate(cell.date) : props.onSelectWeek(wKey)
                        }
                        title={
                          has
                            ? t("reports.picker.dayTitle", {
                                date: cell.date,
                                issues: meta!.issues,
                                critical: meta!.criticalIssues,
                              })
                            : t("reports.picker.dayEmpty", { date: cell.date })
                        }
                      >
                        <span className="rp-day-n">{Number(cell.date.slice(8))}</span>
                        <span className={`rp-day-dot${tone ? ` rp-dot-${tone}` : ""}`} aria-hidden />
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <footer className="rp-picker-foot">
        <span className="rp-legend">
          <span className="rp-day-dot rp-dot-ok" aria-hidden /> {t("reports.picker.legendOk")}
        </span>
        <span className="rp-legend">
          <span className="rp-day-dot rp-dot-warn" aria-hidden /> {t("reports.picker.legendWarn")}
        </span>
        <span className="rp-legend">
          <span className="rp-day-dot rp-dot-bad" aria-hidden /> {t("reports.picker.legendBad")}
        </span>
        {period === "daily" ? (
          <span className="rp-legend rp-legend-none">{t("reports.picker.legendNone")}</span>
        ) : (
          <span className="rp-legend">
            <span className="rp-day-dot rp-dot-pending" aria-hidden /> {t("reports.picker.legendPending")}
          </span>
        )}
      </footer>
    </section>
  );
}
