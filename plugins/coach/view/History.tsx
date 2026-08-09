// Coach View(70)— 壁打ち履歴の閲覧。
//
// 65 番から `data/coach/sessions.jsonl` に全セッションのスナップショットを追記していたが、
// **画面から読む導線が無かった**(見られるのは弱点プロファイルの集計値だけ)。
// 「いつ・どんな話題で・何往復したか」を一覧し、開くとやり取り全文が読める形にする。
//
// ---- 一覧 / 詳細の分け方 ----
// Webhook ログ・調査履歴と同じで、**一覧は要約・詳細は全文**。
// 一覧に CoachSession をそのまま載せると、1 セッションぶんの materials(根拠リンク全件)
// まで運ぶことになるので、サーバ側で畳んだ CoachSessionSummary を引く。
// 詳細は行を開いたときに 1 件だけ引く。
//
// ---- 翻訳しないもの ----
// 記録された発話・回答・話題キー・モデル名は **実行時の記録なので翻訳しない**
// (CLAUDE.md。履歴を後から別言語で開いても「その実行が何を答えたか」は変わらない)。
// 翻訳するのは、画面がコード / 数値から組み立てるラベル(段階・往復数・バッジ)だけ。

import { useCallback, useEffect, useState } from "react";
import { formatDateTime, formatNumber, type Lang, type TFunc } from "../../../src/i18n";
import { ApiError, fetchSession, fetchSessions } from "./api";
import { Evidence } from "./Evidence";
import type { CoachSessionDetail, CoachSessionSummary } from "./types";

interface Props {
  t: TFunc;
  lang: Lang;
  /** タブが表示されているか。開いたときだけ読みに行く。 */
  active: boolean;
  onOpenKnowledge: (id: string) => void;
  onOpenHistory: (runId: string) => void;
  onOpenRule: (ruleId: string) => void;
}

function errorKey(err: unknown): { key: string; raw: string } {
  if (err instanceof ApiError && err.code) return { key: `coach.error.${err.code}`, raw: err.message };
  return { key: "coach.error.generic", raw: err instanceof Error ? err.message : String(err) };
}

/** 秒に丸める。ミリ秒まで出しても読み手には意味が無い。 */
function seconds(ms: number, lang: Lang): string {
  return formatNumber(Math.round(ms / 100) / 10, lang);
}

export function History({ t, lang, active, onOpenKnowledge, onOpenHistory, onOpenRule }: Props) {
  const [rows, setRows] = useState<CoachSessionSummary[] | null>(null);
  const [listError, setListError] = useState<{ key: string; raw: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CoachSessionDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<{ key: string; raw: string } | null>(null);

  const reload = useCallback(() => {
    setListError(null);
    void fetchSessions(50)
      .then((r) => setRows(r.sessions))
      .catch((err) => {
        setRows([]);
        setListError(errorKey(err));
      });
  }, []);

  useEffect(() => {
    if (active) reload();
  }, [active, reload]);

  const open = useCallback(
    (sessionId: string) => {
      // 同じ行をもう一度押したら閉じる(一覧に戻る導線を別に置かなくて済む)。
      if (selected === sessionId) {
        setSelected(null);
        setDetail(null);
        return;
      }
      setSelected(sessionId);
      setDetail(null);
      setDetailError(null);
      setDetailBusy(true);
      void fetchSession(sessionId)
        .then((r) => setDetail(r.session))
        .catch((err) => setDetailError(errorKey(err)))
        .finally(() => setDetailBusy(false));
    },
    [selected],
  );

  const evidenceProps = { onOpenKnowledge, onOpenHistory, onOpenRule };

  return (
    <section className="go-panel co-panel">
      <div className="go-panel-head">
        <span className="go-panel-title">{t("coach.history.title")}</span>
        {rows && <span className="co-hist-count">{t("coach.history.count", { n: rows.length })}</span>}
        <button className="co-btn co-btn-ghost" onClick={reload}>
          {t("coach.history.reload")}
        </button>
      </div>

      {listError && (
        <div className="go-inline-error">
          {t(listError.key)}
          <span className="co-reason go-mono"> {listError.raw}</span>
        </div>
      )}

      {rows === null && <div className="go-loading">{t("coach.history.loading")}</div>}
      {rows !== null && rows.length === 0 && !listError && (
        <div className="co-empty-text">{t("coach.history.empty")}</div>
      )}

      {rows !== null && rows.length > 0 && (
        <ul className="co-hist-list">
          {rows.map((s) => {
            const isOpen = selected === s.sessionId;
            return (
              <li key={s.sessionId} className={`co-hist-item${isOpen ? " co-hist-item-open" : ""}`}>
                <button
                  className="co-hist-row"
                  onClick={() => open(s.sessionId)}
                  aria-expanded={isOpen}
                >
                  <span className="co-hist-caret" aria-hidden>
                    {isOpen ? "▾" : "▸"}
                  </span>
                  <span className="co-hist-when">{formatDateTime(s.startedAt, lang)}</span>
                  <span className="co-hist-mode" title={t(`coach.mode.${s.mode}`)} aria-hidden>
                    {s.mode === "quiz" ? "📋" : "💬"}
                  </span>
                  {/* 見出しは記録された発話そのもの。翻訳しない。 */}
                  <span className="co-hist-q">
                    {s.firstQuestion || <em className="co-hist-noq">{t("coach.history.noQuestion")}</em>}
                  </span>
                  <span className="co-hist-badges">
                    <span className="co-hist-turns">{t("coach.history.turns", { n: s.turnCount })}</span>
                    <span className="co-hint-level">
                      <span aria-hidden>💡</span> {t("coach.hint.level", { n: s.maxHintLevel, max: 3 })}
                    </span>
                    {s.escalated && <span className="co-tag co-tag-esc">{t("coach.hint.escalated")}</span>}
                    {s.forcedDisclosure && (
                      <span className="co-tag co-tag-forced">{t("coach.hint.forced")}</span>
                    )}
                    {s.incidentMode && (
                      <span className="co-tag co-tag-incident">{t("coach.history.incident")}</span>
                    )}
                    {s.usedLive && (
                      <span className="co-layer co-layer-live">
                        <span aria-hidden>📡</span> {t("coach.live.badge")}
                      </span>
                    )}
                    {s.quizVerdict && (
                      <span className={`co-tag co-verdict-tag-${s.quizVerdict}`}>
                        {t(`coach.quiz.verdict.${s.quizVerdict}`)}
                      </span>
                    )}
                    {s.hasError && <span className="co-tag co-tag-error">{t("coach.history.hasError")}</span>}
                  </span>
                </button>

                {/* 話題キーは記録された値なので翻訳しない(# を付けて出すのは画面の仕事)。 */}
                {s.topicKeys.length > 0 && (
                  <div className="co-hist-topics">
                    {s.topicKeys.map((k) => (
                      <span key={k} className="co-topic">
                        #{k}
                      </span>
                    ))}
                    <span className="co-hist-dur">
                      {t("coach.history.duration", { s: seconds(s.totalDurationMs, lang) })}
                    </span>
                  </div>
                )}

                {isOpen && (
                  <div className="co-hist-detail">
                    {detailBusy && <div className="go-loading">{t("coach.history.loadingDetail")}</div>}
                    {detailError && (
                      <div className="go-inline-error">
                        {t(detailError.key)}
                        <span className="co-reason go-mono"> {detailError.raw}</span>
                      </div>
                    )}
                    {detail && detail.turns.length === 0 && !detail.quiz && (
                      <div className="co-empty-text">{t("coach.history.emptyDetail")}</div>
                    )}

                    {detail?.quiz && (
                      <div className="co-hist-quiz">
                        <div className="co-hist-turn-head">
                          <span className="co-quiz-format">{t(`coach.quiz.format.${detail.quiz.format}`)}</span>
                          <span className="co-quiz-rounds">
                            {t("coach.quiz.rounds", { n: detail.quiz.rounds, max: detail.quiz.rounds })}
                          </span>
                          <span className="co-hist-at">{formatDateTime(detail.quiz.askedAt, lang)}</span>
                        </div>
                        {/* 出題文は実行時の記録なので翻訳しない。 */}
                        <div className="co-quiz-question">{detail.quiz.question}</div>
                      </div>
                    )}

                    {detail?.turns.map((turn, i) => (
                      <div key={`${turn.at}-${i}`} className="co-hist-turn">
                        <div className="co-hist-turn-head">
                          <span className="co-hist-turn-no">#{i + 1}</span>
                          <span className="co-hint-level">
                            <span aria-hidden>💡</span>{" "}
                            {t("coach.hint.level", { n: turn.hintLevel, max: 3 })}
                          </span>
                          {turn.intent !== "ask" && (
                            <span className="co-tag co-tag-intent">
                              {t(`coach.history.intent.${turn.intent}`)}
                            </span>
                          )}
                          {turn.forcedDisclosure && (
                            <span className="co-tag co-tag-forced">{t("coach.hint.forced")}</span>
                          )}
                          {turn.live?.used && (
                            <span
                              className="co-layer co-layer-live"
                              title={t("coach.live.badgeTitle", {
                                tools: (turn.live.tools ?? []).join(", ") || "-",
                              })}
                            >
                              <span aria-hidden>📡</span> {t("coach.live.badge")}
                            </span>
                          )}
                          {turn.level && <span className="co-tag">{turn.level}</span>}
                          <span className="co-hist-at">{formatDateTime(turn.at, lang)}</span>
                          <span className="co-hist-dur">
                            {t("coach.history.duration", {
                              s: seconds(turn.durationMs + (turn.live?.durationMs ?? 0), lang),
                            })}
                          </span>
                          {/* モデル名は実行時の記録。翻訳しない。 */}
                          <span className="co-hist-model go-mono">{turn.model}</span>
                        </div>

                        {/* 発話が無いターン(ボタンだけ)は発話の吹き出しを出さない(70 番)。
                            「発言なし」という偽の発話を画面にも作らないため。 */}
                        {turn.question && (
                          <div className="co-row co-row-learner">
                            <div className="co-bubble co-bubble-learner">
                              <div className="co-bubble-text">{turn.question}</div>
                            </div>
                            <div className="co-avatar co-avatar-learner" aria-hidden>
                              🙋
                            </div>
                          </div>
                        )}

                        <div className="co-row co-row-coach">
                          <div className="co-avatar" aria-hidden>
                            🐤
                          </div>
                          <div className="co-bubble co-bubble-coach">
                            {turn.isError ? (
                              <div className="co-bubble-error">
                                <div>{t("coach.chat.failed")}</div>
                                {/* 失敗理由は実行時の記録なので翻訳しない。 */}
                                {turn.reason && <div className="co-reason go-mono">{turn.reason}</div>}
                              </div>
                            ) : (
                              <div className="co-bubble-text">{turn.answer}</div>
                            )}
                            {/* 履歴では根拠を常に開けるようにする(unlocked)。
                                ネタバレの制御は「その場で考えている最中」の話で、
                                読み返しているときは元記録を辿れることの方が学習になる(64 §5-3(c))。 */}
                            {turn.materials.length > 0 && (
                              <div className="co-bubble-foot">
                                <Evidence
                                  t={t}
                                  materials={turn.materials}
                                  citedIds={turn.citedIds}
                                  unlocked
                                  {...evidenceProps}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
