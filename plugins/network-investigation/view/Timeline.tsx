import { useEffect, useMemo, useRef, useState } from "react";
import { LogoBadge } from "./LogoBadge";
import { mcpHealthTagLabel } from "./McpHealthNotice";
import { ScheduleEditor } from "./ScheduleEditor";
import { SOURCE_LABEL, groupSessions } from "./session";
import type { ScheduleConfig, SiteEntry, HistoryRecord } from "./types";

// スケジュール実行 + 手動実行の履歴を時系列タイムラインで表示する(Task 6)。
// query-history.jsonl(サーバーが新しい順で返す)をセッション単位にまとめて描画する(04 Task 3)。
// 「続けて調べる」で繋がった一連はカード 1 枚(N ターン)になり、クリックでスレッド表示へ遷移する。
// 定期実行の設定(時刻・頻度・対象クエリ)はここから編集できる(Task 5 → ScheduleEditor)。
// 共通検索から遷移してきた場合は focusId を含むセッションのカードをハイライトしてスクロールする。

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function fmt(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function scheduleSummary(cfg: ScheduleConfig | null, count: number): string {
  if (!cfg) return "定期実行: 読み込み中…";
  const hhmm = `${String(cfg.hour).padStart(2, "0")}:${String(cfg.minute).padStart(2, "0")}`;
  const when = cfg.frequency === "weekly" ? `毎週${WEEKDAYS[cfg.dayOfWeek ?? 1]}曜 ${hhmm}` : `毎日 ${hhmm}`;
  return `定期実行: ${cfg.enabled ? "有効" : "無効"} ・ ${when} ・ 対象 ${count} 件`;
}

export function Timeline({
  history,
  scheduleConfig,
  scheduledCount,
  entries,
  focusId,
  onOpen,
  onScheduleChanged,
}: {
  history: HistoryRecord[];
  scheduleConfig: ScheduleConfig | null;
  scheduledCount: number;
  entries: SiteEntry[];
  focusId: string | null;
  /** セッションキーと、クリックされたターン(スレッド内でそこへスクロールする) */
  onOpen: (sessionKey: string, recordId: string) => void;
  onScheduleChanged: () => void;
}) {
  const focusRef = useRef<HTMLDivElement | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const sessions = useMemo(() => groupSessions(history), [history]);

  useEffect(() => {
    if (focusId && focusRef.current) {
      focusRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusId, history]);

  return (
    <section className="ni-timeline">
      <div className="ni-timeline-head">
        <div className="ni-panel-title">実行タイムライン</div>
        <div className="ni-timeline-head-right">
          <span className="ni-mono ni-dim ni-sched-note">{scheduleSummary(scheduleConfig, scheduledCount)}</span>
          <button className="ni-btn sm" onClick={() => setShowEditor((v) => !v)}>
            {showEditor ? "定期実行の設定を閉じる" : "定期実行を設定"}
          </button>
        </div>
      </div>

      {showEditor && <ScheduleEditor entries={entries} onChanged={onScheduleChanged} />}

      {sessions.length === 0 ? (
        <div className="ni-empty">まだ実行履歴がありません。クエリを実行するか、定期実行を待つと、ここに時系列で並びます。</div>
      ) : (
        <div className="ni-timeline-list">
          {sessions.map((s) => {
            // 検索・共有リンク(?focus=<runId>)は 1 ターンを指すので、それを含むセッションを開く。
            const focusedRec = focusId ? s.records.find((r) => r.id === focusId) : undefined;
            const focused = Boolean(focusedRec);
            const multi = s.records.length > 1;
            return (
              <div
                key={s.key}
                ref={focused ? focusRef : undefined}
                className={`ni-tl-card${focused ? " focused" : ""}${s.hasError ? " error" : ""}`}
                onClick={() => onOpen(s.key, focusedRec?.id ?? s.last.id)}
                title={multi ? "クリックでこの調査スレッド(全ターン)を表示" : "クリックでこの実行の詳細を表示"}
              >
                <div className="ni-tl-rail">
                  <span className="ni-tl-dot" />
                </div>
                <div className="ni-tl-body">
                  <div className="ni-tl-top">
                    <span className="ni-mono ni-dim">{fmt(s.latestTs)}</span>
                    <span className={`ni-tag ${s.first.source}`}>{SOURCE_LABEL[s.first.source] ?? "手動"}</span>
                    {multi && <span className="ni-tag thread">{s.records.length} ターン</span>}
                    {s.mcpServers.map((srv) => (
                      <LogoBadge key={srv} target={srv} size={16} title={srv} />
                    ))}
                    {s.first.site && <span className="ni-mono ni-dim">site={s.first.site}</span>}
                    {s.hasError && <span className="ni-tag error">失敗</span>}
                    {/* MCP サーバーに接続できていなかった実行を一覧からも気付けるようにする(09)。 */}
                    {s.mcpHealthLevel !== "ok" && (
                      <span
                        className={`ni-tag mcp-${s.mcpHealthLevel}`}
                        title="一部の MCP サーバーに接続できていませんでした(認証切れの可能性)"
                      >
                        {mcpHealthTagLabel(s.mcpHealthLevel)}
                      </span>
                    )}
                  </div>
                  <div className="ni-tl-query">{s.first.query}</div>
                  {/* 複数ターンなら「どこまで掘り下げたか」が分かるよう最後のクエリも出す。 */}
                  {multi && <div className="ni-tl-lastq ni-dim">└ 最後: {s.last.query}</div>}
                  {s.last.answerExcerpt && <div className="ni-tl-excerpt ni-dim">{s.last.answerExcerpt}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
