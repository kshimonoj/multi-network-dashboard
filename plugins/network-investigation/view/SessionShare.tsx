import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Markdown } from "./Markdown";
import { fillPrintSessionRichSlots } from "./printClone";
import { copyText, usePrintOnMount, useTransientMessage } from "./shareUi";
import type { SessionTurn } from "./session";
import {
  buildSessionMailtoHref,
  buildSessionShareText,
  formatTimestamp,
  platformLabel,
  sessionModels,
  sessionPeriodLabel,
  sessionPlatforms,
  sessionSiteLabel,
  sessionTools,
  siteLabel,
  uniqueTools,
  type SessionShareReport,
  type ShareReport,
} from "./shareText";

// セッション全体(「続けて調べる」で繋がった一連のスレッド)の共有・報告(04 Task 4)。
//
// 単発版(ShareActions)と同じ 3 つの手段を、スレッド全体に対して提供する。
//   印刷 / PDF … 全ターンを 1 つの印刷ツリーに連結する。ターンの区切りに見出し(実行時刻)を挟む。
//                 グラフ / トポロジ図は printClone の仕組みで画面側の SVG を複製するが、
//                 data-ni-index はターン内の通し番号なので、ターン(data-ni-turn)ごとに突き合わせる。
//   メール     … 全ターンを入れると mailto: の URL 長を確実に超えるため、各ターンの要点だけを
//                 並べた要約にし、「詳細はダッシュボードで」を添える(shareText.ts)。
//   コピー     … 全ターンのプレーンテキスト(こちらは長さ制限なし)。

export function turnToShareReport(turn: SessionTurn): ShareReport {
  return {
    query: turn.query,
    site: turn.site,
    ts: turn.ts,
    model: turn.model,
    tools: turn.calls.map((c) => c.tool),
    platforms: turn.platformsUsed,
    answer: turn.answer,
    errorNote: turn.isError ? turn.reason || "実行に失敗しました" : null,
  };
}

export function toSessionReport(sessionId: string, turns: SessionTurn[]): SessionShareReport {
  return { sessionId, turns: turns.map(turnToShareReport) };
}

// 紙面に出すスレッドレポート。画面には出ない(display:none、@media print でのみ表示)。
function PrintSessionReport({
  report,
  screenRef,
}: {
  report: SessionShareReport;
  screenRef: RefObject<HTMLElement>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const platforms = sessionPlatforms(report);
  const tools = sessionTools(report);
  const models = sessionModels(report).filter(Boolean);

  // window.print() より前(親の effect より先に走る子の layout effect)で SVG を差し込む。
  useLayoutEffect(() => {
    if (rootRef.current) fillPrintSessionRichSlots(rootRef.current, screenRef.current);
  });

  return (
    <div id="ni-print-root" ref={rootRef}>
      <div className="ni-print-doc">
        <div className="ni-print-head">
          <h1 className="ni-print-title">ネットワーク調査レポート(調査スレッド)</h1>
          <div className="ni-print-sub">Multi Network Dashboard — Central / Mist 横断</div>
        </div>

        <table className="ni-print-meta">
          <tbody>
            <tr>
              <th>対象サイト</th>
              <td>{sessionSiteLabel(report)}</td>
            </tr>
            <tr>
              <th>期間</th>
              <td>{sessionPeriodLabel(report)}</td>
            </tr>
            <tr>
              <th>ターン数</th>
              <td>{report.turns.length}</td>
            </tr>
            <tr>
              <th>最初のクエリ</th>
              <td>{report.turns[0]?.query ?? "—"}</td>
            </tr>
            <tr>
              <th>対象基盤</th>
              <td>{platforms.length > 0 ? platforms.map(platformLabel).join(" / ") : "—"}</td>
            </tr>
            <tr>
              <th>使用ツール</th>
              <td>{tools.length > 0 ? tools.join(", ") : "(記録なし)"}</td>
            </tr>
            <tr>
              <th>モデル</th>
              <td>{models.length > 0 ? models.join(", ") : "—"}</td>
            </tr>
          </tbody>
        </table>

        {report.turns.map((t, i) => (
          <section className="ni-print-turn" key={`${t.ts}-${i}`} data-ni-turn={t.turnId}>
            <h2 className="ni-print-h2">
              ターン {i + 1}/{report.turns.length} ・ {formatTimestamp(t.ts)} ・ {siteLabel(t.site)}
            </h2>
            <div className="ni-print-turn-query">クエリ: {t.query}</div>
            <div className="ni-print-turn-tools ni-mono">
              使用ツール: {uniqueTools(t.tools).join(", ") || "(記録なし)"}
              {t.model ? ` ・ モデル: ${t.model}` : ""}
            </div>
            <div className="ni-print-body">
              {t.errorNote ? <p>(このターンは失敗しました){t.errorNote}</p> : <Markdown text={t.answer} print />}
            </div>
          </section>
        ))}

        <div className="ni-print-foot">
          出力: {formatTimestamp(new Date().toISOString())} ・ {window.location.origin}
        </div>
      </div>
    </div>
  );
}

export function SessionShareActions({
  sessionId,
  turns,
  screenRef,
}: {
  sessionId: string;
  turns: SessionTurn[];
  /** 画面に描画済みのスレッド(グラフ / トポロジ図の複製元)のコンテナ */
  screenRef: RefObject<HTMLElement>;
}) {
  const [printing, setPrinting] = useState(false);
  const [message, showMessage] = useTransientMessage();

  usePrintOnMount(printing, useCallback(() => setPrinting(false), []));

  // 印刷ツリーはターンと画面側 DOM を data-ni-turn で対応付けるので、runId を持ち回る。
  const report: SessionShareReport = {
    sessionId,
    turns: turns.map((t) => ({ ...turnToShareReport(t), turnId: t.id })),
  };

  const onPrint = useCallback(() => setPrinting(true), []);

  const onMail = useCallback(() => {
    const { href, truncated } = buildSessionMailtoHref(report, { sourceUrl: window.location.href });
    window.location.href = href;
    showMessage(truncated ? "メールを作成しました(各ターンの要点のみ)" : "メールを作成しました");
    // report は毎描画で作り直す軽い値なので依存に入れない(turns/sessionId が実体)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, turns, showMessage]);

  const onCopy = useCallback(async () => {
    const ok = await copyText(buildSessionShareText(report, { sourceUrl: window.location.href }));
    showMessage(ok ? `スレッド全体(${turns.length}ターン)をコピーしました` : "コピーに失敗しました");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, turns, showMessage]);

  return (
    <div className="ni-share ni-share-session">
      <span className="ni-share-label ni-mono">スレッド全体を共有</span>
      <button className="ni-btn sm" onClick={onPrint} title="このスレッドの全ターンを 1 つのレポートとして印刷します(ダイアログで「PDF として保存」を選べば PDF 化できます)">
        印刷 / PDF
      </button>
      <button className="ni-btn sm" onClick={onMail} title="各ターンの要点をまとめた要約をメール本文にします">
        メール(要約)
      </button>
      <button className="ni-btn sm" onClick={onCopy} title="このスレッドの全ターンをプレーンテキストでコピーします">
        コピー
      </button>
      {message && <span className="ni-share-msg ni-mono">{message}</span>}
      {printing && createPortal(<PrintSessionReport report={report} screenRef={screenRef} />, document.body)}
    </div>
  );
}
