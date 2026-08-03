// 44: 問題行を展開したときに出す「自動事前調査」パネル。
//
// 45 で日次(Reports.tsx)と週次 / 月次(PeriodReportView.tsx)の両方から使うようになったので、
// Reports.tsx から切り出した(中身は 44 番のまま)。
//
// 自動事前調査は **日次レポートの生成時** に名寄せキー単位で走る。週次 / 月次は同じキーで
// 引き当てるだけで、新たな調査は追加実行しない(45 の前提)。
// 回答本文そのもの(実行時の記録)は翻訳せず、そのまま出す。

import { useLanguage } from "../../../src/i18n/LanguageContext";
import { formatDateTime } from "../../../src/i18n";
import type { PendingHistoryFocus } from "../../../src/shell";
import type { AutoInvestigationEntry } from "./types";

export function AutoPanel({
  auto,
  onOpenHistoryFocus,
}: {
  auto: AutoInvestigationEntry;
  onOpenHistoryFocus?: (runId: PendingHistoryFocus) => void;
}) {
  const { lang, t } = useLanguage();
  return (
    <div className="rp-auto-panel">
      <div className="rp-auto-head">
        <span className="rp-detail-label">{t("reports.auto.panelTitle")}</span>
        <span className={`rp-auto-tag rp-auto-${auto.status}`}>{t(`reports.auto.tag.${auto.status}`)}</span>
        <span className="go-note rp-auto-meta">
          {t("reports.auto.meta", {
            date: auto.date,
            at: formatDateTime(auto.startedAt, lang),
          })}
        </span>
      </div>
      <div className="rp-auto-query go-mono">{t("reports.auto.queryLabel", { query: auto.query })}</div>
      {auto.status === "running" && <div className="go-note">{t("reports.auto.runningBody")}</div>}
      {auto.status === "error" && (
        <div className="go-inline-error">{auto.error ?? t("reports.auto.errorDefault")}</div>
      )}
      {auto.status === "done" && (
        <div className="rp-auto-body">{auto.summary || t("reports.auto.emptyAnswer")}</div>
      )}
      {auto.status === "done" && auto.runId && onOpenHistoryFocus && (
        <button className="rp-result-btn" onClick={() => onOpenHistoryFocus(auto.runId!)}>
          {t("reports.auto.resultBtn")}
        </button>
      )}
    </div>
  );
}
