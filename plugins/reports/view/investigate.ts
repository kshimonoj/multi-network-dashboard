// レポートタブ →「ネットワーク調査」タブへの連携(43 Task 4)。
//
// Event/Alert(global-overview/view/investigate.ts)・Webhook ログと同じ流儀:
//   ・文章はここで文字列連結せず、辞書のテンプレート(日英両方)に値を埋める
//     (CLAUDE.md「動的に組み立てる文字列も日英両方のテンプレートを用意する」)
//   ・組み立てるのはクエリ文だけで、実行はしない(タブを切り替えて入力欄に載せるところまで)
//   ・site は NetworkInvestigation 側のサイト一覧と突き合わせるのでそのまま渡す

import type { InvestigationRequest } from "../../../src/shell";
import { getLang, translate } from "../../../src/i18n/i18n";
import { formatDateTime } from "../../../src/i18n";
import type { DailyHighlight, DailyIssue, PeriodHighlight, PeriodIssue, PeriodType } from "./types";

/** null / 空文字を「不明」(en: unknown)に倒す。テンプレートの穴を空けないため。 */
function orUnknown(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  return s === "" ? translate(getLang(), "reports.investigateQuery.unknown") : s;
}

function platformLabel(p: string | null): string {
  const lang = getLang();
  if (!p) return translate(lang, "reports.investigateQuery.unknown");
  return translate(lang, `reports.platform.${p}`);
}

function severityLabel(sev: string): string {
  return translate(getLang(), `reports.severity.${sev}`);
}

function recurrenceLabel(status: string): string {
  return translate(getLang(), `reports.recurrence.${status}`);
}

/** 「この期間に起きたこと」1 件 → 調査クエリ。 */
export function buildHighlightQuery(date: string, h: DailyHighlight): InvestigationRequest {
  const lang = getLang();
  const query = translate(lang, "reports.investigateQuery.highlight", {
    date,
    time: h.at ? formatDateTime(h.at, lang) : translate(lang, "reports.investigateQuery.unknown"),
    site: orUnknown(h.site),
    device: orUnknown(h.device),
    platform: platformLabel(h.platform),
    severity: severityLabel(h.severity),
    title: h.title,
    detail: h.detail,
  });
  return { query, site: h.site };
}

// ---- 45: 週次 / 月次 ----
//
// 日次との違いは「1 日の出来事」ではなく「期間の集計結果」を渡すこと。
// 期間(from〜to)・何日出たか・延べ発生回数・最長連続日数を添えて、
// 単発なのか慢性的なのかが調査側に伝わるようにする。

function periodLabel(periodType: PeriodType): string {
  return translate(getLang(), `reports.period.${periodType}`);
}

/** 週次 / 月次の「この期間に起きたこと」1 件 → 調査クエリ。 */
export function buildPeriodHighlightQuery(
  periodType: PeriodType,
  from: string,
  to: string,
  h: PeriodHighlight,
): InvestigationRequest {
  const lang = getLang();
  const query = translate(lang, "reports.investigateQuery.periodHighlight", {
    period: periodLabel(periodType),
    from,
    to,
    days: h.dates.length,
    dates: h.dates.join(", "),
    site: orUnknown(h.site),
    device: orUnknown(h.device),
    platform: platformLabel(h.platform),
    severity: severityLabel(h.severity),
    title: h.title,
    detail: h.detail,
  });
  return { query, site: h.site };
}

/** 週次 / 月次の「検出された問題」1 行 → 調査クエリ。 */
export function buildPeriodIssueQuery(
  periodType: PeriodType,
  from: string,
  to: string,
  issue: PeriodIssue,
): InvestigationRequest {
  const lang = getLang();
  const query = translate(lang, "reports.investigateQuery.periodIssue", {
    period: periodLabel(periodType),
    from,
    to,
    name: issue.name,
    site: orUnknown(issue.site),
    device: orUnknown(issue.device),
    platform: platformLabel(issue.platform),
    severity: severityLabel(issue.severity),
    days: issue.days,
    occurrences: issue.occurrences,
    streak: issue.streak,
    dates: issue.dates.join(", "),
    firstSeen: issue.firstSeenDate,
    status: translate(lang, `reports.periodIssue.status.${issue.status}`),
    rootCause: orUnknown(issue.rootCause),
    impact: orUnknown(issue.impact),
    nextAction: orUnknown(issue.nextAction),
  });
  return { query, site: issue.site };
}

/** 「検出された問題」1 行 → 調査クエリ。 */
export function buildIssueQuery(date: string, issue: DailyIssue): InvestigationRequest {
  const lang = getLang();
  const query = translate(lang, "reports.investigateQuery.issue", {
    date,
    name: issue.name,
    site: orUnknown(issue.site),
    device: orUnknown(issue.device),
    platform: platformLabel(issue.platform),
    severity: severityLabel(issue.severity),
    recurrence: recurrenceLabel(issue.recurrence.status),
    firstSeen: issue.recurrence.firstSeenDate,
    occurrences: issue.occurrences,
    rootCause: orUnknown(issue.rootCause),
    impact: orUnknown(issue.impact),
    nextAction: orUnknown(issue.nextAction),
  });
  return { query, site: issue.site };
}
