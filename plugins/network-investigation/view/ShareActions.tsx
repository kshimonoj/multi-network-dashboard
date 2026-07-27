import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Markdown } from "./Markdown";
import { fillPrintRichSlots, findAnswerPanel } from "./printClone";
import { copyText, usePrintOnMount, useTransientMessage } from "./shareUi";
import {
  buildMailtoHref,
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
//                 @media print では #root を隠し、このレポートだけを紙面に出す(styles.css)。
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
}: {
  report: ShareReport;
  sourceRef: RefObject<HTMLElement>;
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
          <h1 className="ni-print-title">ネットワーク調査レポート</h1>
          <div className="ni-print-sub">Multi Network Dashboard — Central / Mist 横断</div>
        </div>

        <table className="ni-print-meta">
          <tbody>
            <tr>
              <th>対象サイト</th>
              <td>{siteLabel(report.site)}</td>
            </tr>
            <tr>
              <th>実行日時</th>
              <td>{formatTimestamp(report.ts)}</td>
            </tr>
            <tr>
              <th>調査クエリ</th>
              <td>{report.query}</td>
            </tr>
            <tr>
              <th>対象基盤</th>
              <td>{report.platforms.length > 0 ? report.platforms.map(platformLabel).join(" / ") : "—"}</td>
            </tr>
            <tr>
              <th>使用ツール</th>
              <td>{tools.length > 0 ? tools.join(", ") : "(記録なし)"}</td>
            </tr>
            <tr>
              <th>モデル</th>
              <td>{report.model || "—"}</td>
            </tr>
          </tbody>
        </table>

        <h2 className="ni-print-h2">調査結果</h2>
        <div className="ni-print-body">
          <Markdown text={report.answer} print />
        </div>

        <div className="ni-print-foot">
          出力: {formatTimestamp(new Date().toISOString())} ・ {window.location.origin}
        </div>
      </div>
    </div>
  );
}

export function ShareActions({ report, compact = false }: { report: ShareReport; compact?: boolean }) {
  const [printing, setPrinting] = useState(false);
  const [message, showMessage] = useTransientMessage();
  // 複製元(画面に描画済みのグラフ / トポロジ図)を探す起点。
  const rootRef = useRef<HTMLDivElement>(null);

  // 印刷用ツリーを描画したフレームの直後に印刷ダイアログを開き、afterprint で畳む。
  usePrintOnMount(printing, useCallback(() => setPrinting(false), []));

  const onPrint = useCallback(() => setPrinting(true), []);

  const onMail = useCallback(() => {
    const { href, truncated } = buildMailtoHref(report, { sourceUrl: window.location.href });
    window.location.href = href;
    showMessage(
      truncated
        ? "メールを作成しました(本文が長いため冒頭のみ引用)"
        : "メールを作成しました",
    );
  }, [report, showMessage]);

  const onCopy = useCallback(async () => {
    const ok = await copyText(buildShareText(report, { sourceUrl: window.location.href }));
    showMessage(ok ? "クリップボードにコピーしました" : "コピーに失敗しました");
  }, [report, showMessage]);

  return (
    <div className={`ni-share${compact ? " compact" : ""}`} ref={rootRef}>
      <span className="ni-share-label ni-mono">共有</span>
      <button className="ni-btn sm" onClick={onPrint} title="印刷用レイアウトで印刷します(ダイアログで「PDF として保存」を選べば PDF 化できます)">
        印刷 / PDF
      </button>
      <button className="ni-btn sm" onClick={onMail} title="この調査結果を本文に入れたメールを作成します">
        メール
      </button>
      <button className="ni-btn sm" onClick={onCopy} title="この調査結果をプレーンテキストでコピーします">
        コピー
      </button>
      {message && <span className="ni-share-msg ni-mono">{message}</span>}
      {printing && createPortal(<PrintReport report={report} sourceRef={rootRef} />, document.body)}
    </div>
  );
}
