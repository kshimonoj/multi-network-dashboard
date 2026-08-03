import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useT, type TFunc } from "../../../src/i18n";
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

// 失敗したターンの注記は「そのターンが失敗した」という事実の説明なので、共有・印刷の
// 生成時点(= 押した人)の表示言語で出す。サーバ由来の reason があればそれを優先する。
export function turnToShareReport(t: TFunc, turn: SessionTurn): ShareReport {
  return {
    query: turn.query,
    site: turn.site,
    ts: turn.ts,
    model: turn.model,
    tools: turn.calls.map((c) => c.tool),
    platforms: turn.platformsUsed,
    answer: turn.answer,
    errorNote: turn.isError ? turn.reason || t("networkInvestigation.turn.errorDefault") : null,
  };
}

export function toSessionReport(t: TFunc, sessionId: string, turns: SessionTurn[]): SessionShareReport {
  return { sessionId, turns: turns.map((turn) => turnToShareReport(t, turn)) };
}

// 紙面に出すスレッドレポート。画面には出ない(display:none、@media print でのみ表示)。
function PrintSessionReport({
  report,
  screenRef,
  t,
}: {
  report: SessionShareReport;
  screenRef: RefObject<HTMLElement>;
  t: TFunc;
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
          <h1 className="ni-print-title">{t("networkInvestigation.report.sessionTitle")}</h1>
          <div className="ni-print-sub">{t("networkInvestigation.report.sub")}</div>
        </div>

        <table className="ni-print-meta">
          <tbody>
            <tr>
              <th>{t("networkInvestigation.report.meta.site")}</th>
              <td>{sessionSiteLabel(report)}</td>
            </tr>
            <tr>
              <th>{t("networkInvestigation.report.meta.period")}</th>
              <td>{sessionPeriodLabel(report)}</td>
            </tr>
            <tr>
              <th>{t("networkInvestigation.report.meta.turns")}</th>
              <td>{report.turns.length}</td>
            </tr>
            <tr>
              <th>{t("networkInvestigation.report.meta.firstQuery")}</th>
              <td>{report.turns[0]?.query ?? t("networkInvestigation.report.none")}</td>
            </tr>
            <tr>
              <th>{t("networkInvestigation.report.meta.platforms")}</th>
              <td>
                {platforms.length > 0
                  ? platforms.map(platformLabel).join(" / ")
                  : t("networkInvestigation.report.none")}
              </td>
            </tr>
            <tr>
              <th>{t("networkInvestigation.report.meta.tools")}</th>
              <td>{tools.length > 0 ? tools.join(", ") : t("networkInvestigation.report.toolsNone")}</td>
            </tr>
            <tr>
              <th>{t("networkInvestigation.report.meta.model")}</th>
              <td>{models.length > 0 ? models.join(", ") : t("networkInvestigation.report.none")}</td>
            </tr>
          </tbody>
        </table>

        {report.turns.map((turn, i) => (
          <section className="ni-print-turn" key={`${turn.ts}-${i}`} data-ni-turn={turn.turnId}>
            <h2 className="ni-print-h2">
              {t("networkInvestigation.report.turnHeading", {
                i: i + 1,
                n: report.turns.length,
                ts: formatTimestamp(turn.ts),
                site: siteLabel(turn.site),
              })}
            </h2>
            <div className="ni-print-turn-query">
              {t("networkInvestigation.report.turnQuery", { query: turn.query })}
            </div>
            <div className="ni-print-turn-tools ni-mono">
              {t("networkInvestigation.report.turnTools", {
                tools: uniqueTools(turn.tools).join(", ") || t("networkInvestigation.report.toolsNone"),
              })}
              {turn.model ? t("networkInvestigation.report.turnModel", { model: turn.model }) : ""}
            </div>
            <div className="ni-print-body">
              {turn.errorNote ? (
                <p>{t("networkInvestigation.report.turnFailed", { note: turn.errorNote })}</p>
              ) : (
                <Markdown text={turn.answer} print />
              )}
            </div>
          </section>
        ))}

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
  const t = useT();
  const [printing, setPrinting] = useState(false);
  const [message, showMessage] = useTransientMessage();

  usePrintOnMount(printing, useCallback(() => setPrinting(false), []));

  // 印刷ツリーはターンと画面側 DOM を data-ni-turn で対応付けるので、runId を持ち回る。
  const report: SessionShareReport = {
    sessionId,
    turns: turns.map((turn) => ({ ...turnToShareReport(t, turn), turnId: turn.id })),
  };

  const onPrint = useCallback(() => setPrinting(true), []);

  const onMail = useCallback(() => {
    const { href, truncated } = buildSessionMailtoHref(report, { sourceUrl: window.location.href });
    window.location.href = href;
    showMessage(
      truncated
        ? t("networkInvestigation.share.msgMailSummary")
        : t("networkInvestigation.share.msgMailCreated"),
    );
    // report は毎描画で作り直す軽い値なので依存に入れない(turns/sessionId が実体)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, turns, showMessage, t]);

  const onCopy = useCallback(async () => {
    const ok = await copyText(buildSessionShareText(report, { sourceUrl: window.location.href }));
    showMessage(
      ok
        ? t("networkInvestigation.share.msgCopiedSession", { n: turns.length })
        : t("networkInvestigation.share.msgCopyFailed"),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, turns, showMessage, t]);

  return (
    <div className="ni-share ni-share-session">
      <span className="ni-share-label ni-mono">{t("networkInvestigation.share.sessionLabel")}</span>
      <button className="ni-btn sm" onClick={onPrint} title={t("networkInvestigation.share.printSessionTitle")}>
        {t("networkInvestigation.share.print")}
      </button>
      <button className="ni-btn sm" onClick={onMail} title={t("networkInvestigation.share.mailSessionTitle")}>
        {t("networkInvestigation.share.mailSummary")}
      </button>
      <button className="ni-btn sm" onClick={onCopy} title={t("networkInvestigation.share.copySessionTitle")}>
        {t("networkInvestigation.share.copy")}
      </button>
      {message && <span className="ni-share-msg ni-mono">{message}</span>}
      {printing &&
        createPortal(
          <PrintSessionReport report={report} screenRef={screenRef} t={t} />,
          document.body,
        )}
    </div>
  );
}
