import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useT, type TFunc } from "../../../src/i18n";
import { Markdown } from "./Markdown";
import { fillPrintRichSlots, findAnswerPanel } from "./printClone";
import { copyText, usePrintOnMount, useTransientMessage } from "./shareUi";
import { waitForTopologyRenders } from "./topologyRenders";
import {
  buildMailtoHref,
  buildPrintDocTitle,
  buildShareText,
  formatTimestamp,
  platformLabel,
  siteLabel,
  uniqueTools,
  type ShareReport,
} from "./shareText";

// 調査結果 1 件の共有・報告(03 Task 2)。
//
// 3 つの手段を並べる。サイト指定あり/なし(横断調査)のどちらの結果でも同じ部品を使う。
//   印刷 / PDF … 印刷用のレポートを body 直下へポータルで生やし、window.print() を呼ぶ。
//                 印刷ダイアログの「PDF として保存」でそのまま PDF 化にもなる。
//                 @media print では body 直下のそれ以外を隠し、このレポートだけを紙面に出す(styles.css)。
//   メール     … mailto: を生成。URL 長の実装上限(概ね 2000 文字)に収まるよう、
//                 長い回答は冒頭だけ引用して「詳細はダッシュボードで」の注記を添える。
//   コピー     … 回答本文(+ メタ情報)をプレーンテキストでクリップボードへ。

// 紙面に出すレポート本体。画面には出ない(display:none、@media print でのみ表示)。
//
// グラフ / トポロジ図(03b): 回答本文はそのまま Markdown に渡すが、chart / topology は
// 印刷ツリーでは空スロットとして描かれる。描画直後(= window.print() より前)に、画面側の
// 回答パネルにある描画済み SVG を複製してスロットへ差し込む。
// sourceRef は共有ボタン(.ni-share)の位置。そこから複製元の回答パネルを辿る。
function PrintReport({
  report,
  sourceRef,
  t,
}: {
  report: ShareReport;
  sourceRef: RefObject<HTMLElement>;
  t: TFunc;
}) {
  const tools = uniqueTools(report.tools);
  const rootRef = useRef<HTMLDivElement>(null);

  // 子(この PrintReport)の layout effect は親 ShareActions の effect より先に走るため、
  // window.print() を呼ぶ時点では既に SVG が差し込まれている。
  useLayoutEffect(() => {
    if (rootRef.current) fillPrintRichSlots(rootRef.current, findAnswerPanel(sourceRef.current));
  });

  return (
    <div id="ni-print-root" ref={rootRef}>
      <div className="ni-print-doc">
        <div className="ni-print-head">
          <h1 className="ni-print-title">{t("networkInvestigation.report.title")}</h1>
          <div className="ni-print-sub">{t("networkInvestigation.report.sub")}</div>
        </div>

        <table className="ni-print-meta">
          <tbody>
            <tr>
              <th>{t("networkInvestigation.report.meta.site")}</th>
              <td>{siteLabel(report.site)}</td>
            </tr>
            <tr>
              <th>{t("networkInvestigation.report.meta.ts")}</th>
              <td>{formatTimestamp(report.ts)}</td>
            </tr>
            <tr>
              <th>{t("networkInvestigation.report.meta.query")}</th>
              <td>{report.query}</td>
            </tr>
            <tr>
              <th>{t("networkInvestigation.report.meta.platforms")}</th>
              <td>
                {report.platforms.length > 0
                  ? report.platforms.map(platformLabel).join(" / ")
                  : t("networkInvestigation.report.none")}
              </td>
            </tr>
            <tr>
              <th>{t("networkInvestigation.report.meta.tools")}</th>
              <td>{tools.length > 0 ? tools.join(", ") : t("networkInvestigation.report.toolsNone")}</td>
            </tr>
            <tr>
              <th>{t("networkInvestigation.report.meta.model")}</th>
              <td>{report.model || t("networkInvestigation.report.none")}</td>
            </tr>
          </tbody>
        </table>

        <h2 className="ni-print-h2">{t("networkInvestigation.report.resultHeading")}</h2>
        <div className="ni-print-body">
          <Markdown text={report.answer} print site={report.site} />
        </div>

        <div className="ni-print-foot">
          {t("networkInvestigation.report.foot", {
            ts: formatTimestamp(new Date().toISOString()),
            origin: window.location.origin,
          })}
        </div>
      </div>
    </div>
  );
}

export function ShareActions({ report, compact = false }: { report: ShareReport; compact?: boolean }) {
  const t = useT();
  const [printing, setPrinting] = useState(false);
  // トポロジ図の描画待ち(83 Task 2)。押してから印刷ツリーを生やすまでの短い間だけ立つ。
  const [preparing, setPreparing] = useState(false);
  const [message, showMessage] = useTransientMessage();
  // 複製元(画面に描画済みのグラフ / トポロジ図)を探す起点。
  const rootRef = useRef<HTMLDivElement>(null);

  // 印刷用ツリーを描画したフレームの直後に印刷ダイアログを開き、afterprint で畳む。
  // 印刷中だけ document.title を差し替え、PDF 保存の既定ファイル名を調査ごとに変える(81 Task 1)。
  usePrintOnMount(printing, useCallback(() => setPrinting(false), []), buildPrintDocTitle(report));

  // 印刷ツリーは画面の SVG を複製するだけなので、mermaid が描き終わる前に押されると
  // 図が注記に置き換わる。進行中の描画が片付くまで待ってから印刷ツリーを生やす。
  const onPrint = useCallback(async () => {
    setPreparing(true);
    try {
      await waitForTopologyRenders();
    } finally {
      setPreparing(false);
      setPrinting(true);
    }
  }, []);

  const onMail = useCallback(() => {
    const { href, truncated } = buildMailtoHref(report, { sourceUrl: window.location.href });
    window.location.href = href;
    showMessage(
      truncated
        ? t("networkInvestigation.share.msgMailTruncated")
        : t("networkInvestigation.share.msgMailCreated"),
    );
  }, [report, showMessage, t]);

  const onCopy = useCallback(async () => {
    const ok = await copyText(buildShareText(report, { sourceUrl: window.location.href }));
    showMessage(
      ok ? t("networkInvestigation.share.msgCopied") : t("networkInvestigation.share.msgCopyFailed"),
    );
  }, [report, showMessage, t]);

  return (
    <div className={`ni-share${compact ? " compact" : ""}`} ref={rootRef}>
      <span className="ni-share-label ni-mono">{t("networkInvestigation.share.label")}</span>
      <button
        className="ni-btn sm"
        onClick={onPrint}
        disabled={preparing}
        title={t("networkInvestigation.share.printTitle")}
      >
        {t(`networkInvestigation.share.print${preparing ? "Busy" : ""}`)}
      </button>
      <button className="ni-btn sm" onClick={onMail} title={t("networkInvestigation.share.mailTitle")}>
        {t("networkInvestigation.share.mail")}
      </button>
      <button className="ni-btn sm" onClick={onCopy} title={t("networkInvestigation.share.copyTitle")}>
        {t("networkInvestigation.share.copy")}
      </button>
      {message && <span className="ni-share-msg ni-mono">{message}</span>}
      {printing && createPortal(<PrintReport report={report} sourceRef={rootRef} t={t} />, document.body)}
    </div>
  );
}
