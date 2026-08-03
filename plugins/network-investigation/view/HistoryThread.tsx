import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../../src/i18n";
import { fetchSession } from "./api";
import { LogoBadge } from "./LogoBadge";
import { SessionShareActions } from "./SessionShare";
import { Turn } from "./Turn";
import { sortTurnsAsc, turnFromRecord, type SessionTurn } from "./session";
import type { HistoryRecord } from "./types";

// タイムラインのカードをクリックして開く「調査スレッド」(04 Task 3)。
// 03 までの HistoryDetail(1 レコードだけを表示)を置き換える。
//
// 同一セッション(= 「続けて調べる」で繋がった一連)のターンを古い順に積み、スクロールで
// 連続して読めるようにする。セッションID を持たない旧履歴は 1 ターンのスレッドとして開く
// (後方互換の分岐は session.ts の sessionKey() だけ。ここには無い)。
//
// データはサーバーから取り直す(View はキャッシュを持たない)。SSE の history イベントで
// 同じセッションに新しいターンが増えたら、開いたまま追記される。

function fmt(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function HistoryThread({
  sessionId,
  focusRecordId,
  reloadKey,
  onBack,
  onLoadQuery,
  onRunAction,
}: {
  sessionId: string;
  /** タイムラインでクリックされたターン(そこまでスクロールする) */
  focusRecordId?: string | null;
  /** これが変わるとサーバーから取り直す(SSE で同セッションにターンが増えたとき) */
  reloadKey?: number;
  onBack: () => void;
  onLoadQuery: (rec: HistoryRecord) => void;
  /** 続けて調べる(このスレッドの続きとして実行する) */
  onRunAction: (query: string, site: string | null, sessionId: string) => void;
}) {
  const t = useT();
  const [records, setRecords] = useState<HistoryRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    fetchSession(sessionId)
      .then((recs) => {
        if (alive) setRecords(recs);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [sessionId, reloadKey]);

  // クリックしたターンまでスクロールする(1 ターンだけのスレッドでは何もしない)。
  useEffect(() => {
    if (focusRecordId && focusRef.current) {
      focusRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [focusRecordId, records]);

  const onTurnAction = useCallback(
    (query: string, site: string | null) => onRunAction(query, site, sessionId),
    [onRunAction, sessionId],
  );

  const onTurnLoadQuery = useCallback(
    (turn: SessionTurn) => {
      const rec = (records ?? []).find((r) => r.id === turn.id);
      if (rec) onLoadQuery(rec);
    },
    [records, onLoadQuery],
  );

  if (error) {
    return (
      <div className="ni-detail">
        <div className="ni-detail-top">
          <button className="ni-btn sm" onClick={onBack}>
            {t("networkInvestigation.thread.backBtn")}
          </button>
        </div>
        <div className="ni-error">{t("networkInvestigation.thread.loadFailed", { error })}</div>
      </div>
    );
  }

  if (!records) {
    return (
      <div className="ni-detail">
        <div className="ni-detail-top">
          <button className="ni-btn sm" onClick={onBack}>
            {t("networkInvestigation.thread.backBtn")}
          </button>
        </div>
        <div className="ni-dim sm">{t("networkInvestigation.thread.loading")}</div>
      </div>
    );
  }

  const turns = sortTurnsAsc(records.map(turnFromRecord));
  const first = turns[0];
  const last = turns[turns.length - 1];
  const servers = Array.from(new Set(turns.flatMap((t) => t.mcpServers)));

  return (
    <div className="ni-detail">
      <div className="ni-detail-top">
        <button className="ni-btn sm" onClick={onBack}>
          {t("networkInvestigation.thread.backBtn")}
        </button>
        {last && (
          <button
            className="ni-btn sm"
            onClick={() => {
              const rec = records.find((r) => r.id === last.id);
              if (rec) onLoadQuery(rec);
            }}
            title={t("networkInvestigation.thread.loadLastTitle")}
          >
            {t("networkInvestigation.thread.loadLastBtn")}
          </button>
        )}
      </div>

      <div className="ni-detail-head">
        <div className="ni-tl-top">
          <span className="ni-turn-no ni-mono">
            {t(`networkInvestigation.timeline.threadTag${turns.length === 1 ? "One" : "Other"}`, {
              n: turns.length,
            })}
          </span>
          <span className="ni-mono ni-dim">
            {first ? fmt(first.ts) : ""}
            {turns.length > 1 && last
              ? t("networkInvestigation.thread.periodTail", { time: fmt(last.ts).slice(11) })
              : ""}
          </span>
          {servers.map((s) => (
            <LogoBadge key={s} target={s} size={16} title={s} />
          ))}
          {first?.site && <span className="ni-mono ni-dim">site={first.site}</span>}
        </div>
        <div className="ni-detail-query">{first?.query}</div>
        {/* セッション全体の共有・報告(04 Task 4)。単発の共有は各ターンの見出しにある。 */}
        <div className="ni-thread-share">
          <SessionShareActions sessionId={sessionId} turns={turns} screenRef={threadRef} />
        </div>
      </div>

      <div className="ni-thread" ref={threadRef}>
        {turns.map((t, i) => (
          <div key={t.id} ref={focusRecordId === t.id ? focusRef : undefined}>
            <Turn
              turn={t}
              index={i}
              total={turns.length}
              onRunAction={onTurnAction}
              onLoadQuery={onTurnLoadQuery}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
