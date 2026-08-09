// Coach タブ(65)。
//
// 画面の骨格:
//   ┌ 見出し + モード切替(壁打ち | クイズ)+ 障害対応中トグル
//   ├ 壁打ち: チャット吹き出し + ヒント段階 + 根拠リンク + エスカレーション
//   ├ クイズ: 出題 → 解答 → フィードバック(2 往復で必ず解説)
//   └ 最近つまずいたところ(弱点プロファイル)
//
// UI トーン(64_findings.md §4-3):
// 既存タブのアクセントは実測で **teal**(--accent #4fd1c5 / #0f9488)。
// 「既存の配色を避ける」の実体は teal を避けることなので、Coach は既存の
// --accent-amber を主色にする(新しいグローバルトークンは足さない)。
// 角丸は既存 3px に対して Coach だけ 14px、アバターは絵文字 1 つ。
//
// **用語は崩さない。** SSID を「電波の名前」と言い換えない。
// 用語は正しいまま、地の文だけをやわらかくする(崩すと現場で通じない人が育つ)。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "../../../src/i18n/LanguageContext";
import { formatDateTime } from "../../../src/i18n";
import { ApiError, answerQuiz, fetchStatus, fetchWeakness, sendChat, startQuiz } from "./api";
import { Evidence } from "./Evidence";
import { History } from "./History";
import { WeaknessPanel } from "./WeaknessPanel";
import type {
  Bubble,
  CoachStatus,
  QuizAnswerResponse,
  QuizState,
  TurnIntent,
  WeaknessResponse,
} from "./types";
import "./styles.css";

/** 70 番で "history"(壁打ち履歴の閲覧)を追加。 */
type Mode = "chat" | "quiz" | "history";
const MODES: Mode[] = ["chat", "quiz", "history"];
const MODE_ICON: Record<Mode, string> = { chat: "💬", quiz: "📋", history: "🗂" };

interface Props {
  active: boolean;
  /** ナレッジタブの該当エントリを開く(65 で新設した deep-link)。 */
  onOpenKnowledgeEntry: (id: string) => void;
  /** ネットワーク調査タブの該当実行を開く(既存の onOpenHistoryFocus)。 */
  onOpenHistoryFocus: (runId: string) => void;
  /** ベストプラクティスタブの該当ルールを開く(65 で受け渡しを追加)。 */
  onOpenRule: (ruleId: string) => void;
  /** 「今の状態は調査タブで」の導線。文面を用意してタブを切り替えるだけで、実行はしない。 */
  onInvestigate: (req: { query: string; site: string | null }) => void;
}

/** サーバの `code` を辞書のキーに変える。文章はサーバで組み立てない(CLAUDE.md)。 */
function errorKey(err: unknown): { key: string; raw: string } {
  if (err instanceof ApiError && err.code) return { key: `coach.error.${err.code}`, raw: err.message };
  return { key: "coach.error.generic", raw: err instanceof Error ? err.message : String(err) };
}

let bubbleSeq = 0;
const nextBubbleId = () => `b${(bubbleSeq += 1)}`;

// 聞き方の例チップ(75)。プールは i18n 辞書側(coach.chat.example.pool.p01..p26)。
// Fisher-Yates で全体をシャッフルしてから先頭 n 件を取る = 偏りなく毎回違う組み合わせになる。
const EXAMPLE_POOL_KEYS = Array.from({ length: 26 }, (_, i) => `p${String(i + 1).padStart(2, "0")}`);

function pickRandomExamples(keys: string[], count: number): string[] {
  const pool = [...keys];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

export function Coach({ active, onOpenKnowledgeEntry, onOpenHistoryFocus, onOpenRule, onInvestigate }: Props) {
  const { t, lang } = useLanguage();

  const [mode, setMode] = useState<Mode>("chat");
  const [incidentMode, setIncidentMode] = useState(false);
  const [status, setStatus] = useState<CoachStatus | null>(null);
  const [weakness, setWeakness] = useState<WeaknessResponse | null>(null);

  // ---- 壁打ち ----
  // sessionId は View が採番してサーバが受け取る(調査タブと同じ設計)。
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [chatError, setChatError] = useState<{ key: string; raw: string } | null>(null);
  const [hintLevel, setHintLevel] = useState(0);
  const [maxHint] = useState(3);
  const [topicKeys, setTopicKeys] = useState<string[]>([]);

  // ---- クイズ ----
  const [quiz, setQuiz] = useState<QuizState | null>(null);
  const [quizFeedback, setQuizFeedback] = useState<QuizAnswerResponse | null>(null);
  const [quizDraft, setQuizDraft] = useState("");
  const [quizBusy, setQuizBusy] = useState(false);
  const [quizError, setQuizError] = useState<{ key: string; raw: string } | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const reloadSide = useCallback(() => {
    void fetchStatus()
      .then(setStatus)
      .catch(() => undefined);
    void fetchWeakness()
      .then(setWeakness)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (active) reloadSide();
  }, [active, reloadSide]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [bubbles.length, busy]);

  // ---- 壁打ちの送信 ----

  const send = useCallback(
    async (intent: TurnIntent, question: string) => {
      if (busy) return;
      setBusy(true);
      setChatError(null);
      if (question) {
        setBubbles((prev) => [...prev, { id: nextBubbleId(), who: "learner", text: question }]);
      }
      try {
        const res = await sendChat({ sessionId, question, intent, incidentMode });
        setBubbles((prev) => [
          ...prev,
          {
            id: nextBubbleId(),
            who: "coach",
            text: res.answer,
            meta: {
              hintLevel: res.hintLevel,
              maxHintLevel: res.maxHintLevel,
              forcedDisclosure: res.forcedDisclosure,
              escalated: res.escalated,
              generalOnly: res.generalOnly,
              primaryLayer: res.primaryLayer,
              live: res.live,
              materials: res.materials,
              citedIds: res.citedIds,
              isError: res.isError,
              reason: res.reason,
              durationMs: res.durationMs,
            },
          },
        ]);
        setHintLevel(res.hintLevel);
        setTopicKeys(res.topicKeys);
        reloadSide();
      } catch (err) {
        setChatError(errorKey(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, sessionId, incidentMode, reloadSide],
  );

  const onSubmit = useCallback(() => {
    const q = draft.trim();
    if (!q) return;
    setDraft("");
    void send("ask", q);
  }, [draft, send]);

  const onNewSession = useCallback(() => {
    setSessionId(crypto.randomUUID());
    setBubbles([]);
    setHintLevel(0);
    setTopicKeys([]);
    setChatError(null);
  }, []);

  // 「今の状態が知りたい」は Coach の仕事ではない(64 §5-1(b))。
  // 学習者の発話をそのまま調査タブへ渡す(サーバ側で文章を組み立てない)。
  const lastQuestion = useMemo(
    () => [...bubbles].reverse().find((b) => b.who === "learner")?.text ?? "",
    [bubbles],
  );

  // 壁打ち開始画面(例文チップ)は sessionId が変わるたび = 起動時 / 新しく始めるたびに引き直す(75)。
  const exampleKeys = useMemo(() => pickRandomExamples(EXAMPLE_POOL_KEYS, 3), [sessionId]);

  // ---- クイズ ----

  const onStartQuiz = useCallback(async () => {
    if (quizBusy) return;
    setQuizBusy(true);
    setQuizError(null);
    setQuizFeedback(null);
    setQuizDraft("");
    try {
      const res = await startQuiz(sessionId);
      setQuiz(res.quiz);
      reloadSide();
    } catch (err) {
      setQuizError(errorKey(err));
    } finally {
      setQuizBusy(false);
    }
  }, [quizBusy, sessionId, reloadSide]);

  const onAnswerQuiz = useCallback(
    async (reveal: boolean) => {
      if (quizBusy || !quiz) return;
      const a = quizDraft.trim();
      if (!a && !reveal) return;
      setQuizBusy(true);
      setQuizError(null);
      try {
        const res = await answerQuiz({ sessionId, answer: a, reveal });
        setQuizFeedback(res);
        setQuiz((prev) =>
          prev ? { ...prev, rounds: res.rounds, verdict: res.verdict, revealed: res.revealed } : prev,
        );
        setQuizDraft("");
        reloadSide();
      } catch (err) {
        setQuizError(errorKey(err));
      } finally {
        setQuizBusy(false);
      }
    },
    [quizBusy, quiz, quizDraft, sessionId, reloadSide],
  );

  const evidenceProps = {
    onOpenKnowledge: onOpenKnowledgeEntry,
    onOpenHistory: onOpenHistoryFocus,
    onOpenRule,
  };

  return (
    <div className="go-root co-root">
      <div className="go-head">
        <div className="go-head-main">
          <h1 className="go-h1">
            <span className="co-mascot" aria-hidden>
              🐤
            </span>
            {t("coach.title")}
          </h1>
          <div className="go-head-sub">{t("coach.sub")}</div>
        </div>
        <div className="co-head-tools">
          <div className="co-modes" role="tablist" aria-label={t("coach.modeAria")}>
            {MODES.map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                className={`co-mode${mode === m ? " co-mode-on" : ""}`}
                onClick={() => setMode(m)}
              >
                <span aria-hidden>{MODE_ICON[m]}</span> {t(`coach.mode.${m}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {status && (
        <div className="go-note co-pool">
          {t("coach.pool", {
            knowledge: status.pool.knowledge,
            history: status.pool.history,
            rules: status.pool.rules,
          })}
          {/* ライブ確認(68)の在/不在。教材の在庫と同じ行に出す —
              「何を根拠に答えるコーチなのか」は最初に伝えるべき情報なので。 */}
          {"  "}
          {t("coach.live.pool", {
            state: status.settings.liveEnabled ? t("coach.live.on") : t("coach.live.off"),
          })}
        </div>
      )}

      {mode === "chat" ? (
        <section className="go-panel co-panel">
          <div className="go-panel-head">
            <span className="go-panel-title">{t("coach.chat.title")}</span>
            <label className="co-incident" title={t("coach.chat.incidentTitle")}>
              <input
                type="checkbox"
                checked={incidentMode}
                onChange={(e) => setIncidentMode(e.target.checked)}
              />
              <span aria-hidden>🚨</span> {t("coach.chat.incident")}
            </label>
            <button className="co-btn co-btn-ghost" onClick={onNewSession} disabled={busy}>
              {t("coach.chat.newSession")}
            </button>
          </div>

          {incidentMode && <div className="co-banner co-banner-incident">{t("coach.chat.incidentNote")}</div>}

          <div className="co-thread" ref={scrollRef}>
            {bubbles.length === 0 && !busy && (
              <div className="co-empty">
                <div className="co-empty-mascot" aria-hidden>
                  🐤
                </div>
                <div className="co-empty-text">{t("coach.chat.greeting")}</div>
                <div className="co-chips">
                  {/* L1 の相手に白紙の入力欄を出すと固まる。聞き方の例をチップで出す(64 §2-2(d))。
                      25 個超のプールから毎回 3 つランダム抽出する(75)。 */}
                  {exampleKeys.map((k) => {
                    const ex = t(`coach.chat.example.pool.${k}`);
                    return (
                      <button key={k} className="co-chip" onClick={() => void send("ask", ex)} disabled={busy}>
                        {ex}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {bubbles.map((b) => (
              <div key={b.id} className={`co-row co-row-${b.who}`}>
                {b.who === "coach" && (
                  <div className="co-avatar" aria-hidden>
                    🐤
                  </div>
                )}
                <div
                  className={`co-bubble co-bubble-${b.who}`}
                  aria-label={b.who === "coach" ? t("coach.aria.coach") : t("coach.aria.learner")}
                >
                  {b.meta?.isError ? (
                    <div className="co-bubble-error">
                      <div>{t("coach.chat.failed")}</div>
                      {/* 失敗理由は実行時の記録なので翻訳しない。 */}
                      {b.meta.reason && <div className="co-reason go-mono">{b.meta.reason}</div>}
                    </div>
                  ) : (
                    <div className="co-bubble-text">{b.text}</div>
                  )}

                  {b.meta && !b.meta.isError && (
                    <div className="co-bubble-foot">
                      {b.meta.generalOnly && (
                        <div className="co-banner co-banner-general">{t("coach.chat.generalOnly")}</div>
                      )}
                      <div className="co-hint-row">
                        <span className="co-hint-level">
                          <span aria-hidden>💡</span>{" "}
                          {t("coach.hint.level", { n: b.meta.hintLevel, max: b.meta.maxHintLevel })}
                        </span>
                        {b.meta.forcedDisclosure && (
                          <span className="co-tag co-tag-forced">{t("coach.hint.forced")}</span>
                        )}
                        {b.meta.escalated && (
                          <span className="co-tag co-tag-esc">{t("coach.hint.escalated")}</span>
                        )}
                        {b.meta.primaryLayer && (
                          <span className={`co-layer co-layer-${b.meta.primaryLayer}`}>
                            {t(`coach.layer.${b.meta.primaryLayer}`)}
                          </span>
                        )}
                        {/* ライブ確認をしたターンだけバッジを出す(68 番)。
                            「今の値まで見て答えている」のか「過去の記録だけか」は、
                            junior にとって回答の重みがまるで違うので必ず区別できるようにする。 */}
                        {b.meta.live?.used && (
                          <span
                            className="co-layer co-layer-live"
                            title={t("coach.live.badgeTitle", {
                              tools: (b.meta.live.tools ?? []).join(", ") || "-",
                            })}
                          >
                            <span aria-hidden>📡</span> {t("coach.live.badge")}
                          </span>
                        )}
                      </div>
                      <Evidence
                        t={t}
                        materials={b.meta.materials}
                        citedIds={b.meta.citedIds}
                        unlocked={b.meta.hintLevel >= 3}
                        {...evidenceProps}
                      />
                    </div>
                  )}
                </div>
                {b.who === "learner" && (
                  <div className="co-avatar co-avatar-learner" aria-hidden>
                    🙋
                  </div>
                )}
              </div>
            ))}

            {busy && (
              <div className="co-row co-row-coach">
                <div className="co-avatar" aria-hidden>
                  🐤
                </div>
                <div className="co-bubble co-bubble-coach co-thinking">{t("coach.chat.thinking")}</div>
              </div>
            )}
          </div>

          {chatError && (
            <div className="go-inline-error">
              {t(chatError.key)}
              <span className="co-reason go-mono"> {chatError.raw}</span>
            </div>
          )}

          {bubbles.length > 0 && (
            <div className="co-actions">
              <button
                className="co-btn"
                disabled={busy || hintLevel >= maxHint}
                onClick={() => void send("hintMore", "")}
                title={t("coach.chat.hintMoreTitle")}
              >
                <span aria-hidden>💡</span> {t("coach.chat.hintMore")}
              </button>
              {/* エスカレーション。押した回数は弱点シグナルとして記録するが、責めない。 */}
              <button
                className="co-btn co-btn-escalate"
                disabled={busy}
                onClick={() => void send("escalate", "")}
                title={t("coach.chat.escalateTitle")}
              >
                <span aria-hidden>🔓</span> {t("coach.chat.escalate")}
              </button>
              {lastQuestion && (
                <button
                  className="co-btn co-btn-ghost"
                  onClick={() => onInvestigate({ query: lastQuestion, site: null })}
                  title={t("coach.chat.investigateTitle")}
                >
                  <span aria-hidden>🔎</span> {t("coach.chat.investigate")}
                </button>
              )}
              {topicKeys.length > 0 && (
                <span className="co-topics">
                  {t("coach.chat.topics")}
                  {topicKeys.map((k) => (
                    <span key={k} className="co-topic">
                      #{k}
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}

          <div className="co-compose">
            <textarea
              className="co-input"
              rows={2}
              value={draft}
              placeholder={t("coach.chat.placeholder")}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onSubmit();
                }
              }}
            />
            <button className="co-btn co-btn-primary" disabled={busy || !draft.trim()} onClick={onSubmit}>
              {t("coach.chat.send")}
            </button>
          </div>
        </section>
      ) : mode === "quiz" ? (
        <section className="go-panel co-panel">
          <div className="go-panel-head">
            <span className="go-panel-title">{t("coach.quiz.title")}</span>
            <button className="co-btn co-btn-primary" onClick={() => void onStartQuiz()} disabled={quizBusy}>
              <span aria-hidden>📋</span> {quiz ? t("coach.quiz.next") : t("coach.quiz.start")}
            </button>
          </div>

          {quizError && (
            <div className="go-inline-error">
              {t(quizError.key)}
              <span className="co-reason go-mono"> {quizError.raw}</span>
            </div>
          )}

          {!quiz && !quizBusy && <div className="co-empty-text">{t("coach.quiz.empty")}</div>}
          {quizBusy && !quiz && <div className="go-loading">{t("coach.quiz.making")}</div>}

          {quiz && (
            <div className="co-quiz">
              <div className="co-quiz-head">
                <span className="co-quiz-format">{t(`coach.quiz.format.${quiz.format}`)}</span>
                <span className="co-quiz-diff" title={t("coach.quiz.difficulty")}>
                  {"★".repeat(quiz.difficulty)}
                  {"☆".repeat(3 - quiz.difficulty)}
                </span>
                <span className={`co-layer co-layer-${quiz.material.kind}`}>
                  {t(`coach.layer.${quiz.material.kind}`)}
                </span>
                <span className="co-quiz-rounds">
                  {t("coach.quiz.rounds", { n: quiz.rounds, max: status?.settings.quizRounds ?? 2 })}
                </span>
                <span className="co-quiz-at">{formatDateTime(quiz.askedAt, lang)}</span>
              </div>
              {/* 出題文は実行時の記録なので翻訳しない。 */}
              <div className="co-quiz-question">{quiz.question}</div>

              {quizFeedback && (
                <div className={`co-verdict co-verdict-${quizFeedback.verdict ?? "revealed"}`}>
                  <div className="co-verdict-head">
                    <span aria-hidden>
                      {quizFeedback.verdict === "correct"
                        ? "🎉"
                        : quizFeedback.verdict === "partial"
                          ? "👍"
                          : quizFeedback.verdict === "wrong"
                            ? "🤔"
                            : "📖"}
                    </span>{" "}
                    {t(`coach.quiz.verdict.${quizFeedback.verdict ?? "revealed"}`)}
                  </div>
                  <div className="co-bubble-text">{quizFeedback.feedback}</div>
                  {quizFeedback.reason && <div className="co-reason go-mono">{quizFeedback.reason}</div>}
                  <Evidence
                    t={t}
                    materials={quizFeedback.materials}
                    citedIds={quizFeedback.citedIds}
                    unlocked={quizFeedback.revealed}
                    {...evidenceProps}
                  />
                </div>
              )}

              {!quiz.revealed && (
                <>
                  <div className="co-compose">
                    <textarea
                      className="co-input"
                      rows={3}
                      value={quizDraft}
                      placeholder={t("coach.quiz.placeholder")}
                      disabled={quizBusy}
                      onChange={(e) => setQuizDraft(e.target.value)}
                    />
                    <button
                      className="co-btn co-btn-primary"
                      disabled={quizBusy || !quizDraft.trim()}
                      onClick={() => void onAnswerQuiz(false)}
                    >
                      {t("coach.quiz.answer")}
                    </button>
                  </div>
                  <div className="co-actions">
                    <button
                      className="co-btn co-btn-escalate"
                      disabled={quizBusy}
                      onClick={() => void onAnswerQuiz(true)}
                    >
                      <span aria-hidden>🔓</span> {t("coach.quiz.reveal")}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      ) : (
        <History t={t} lang={lang} active={active && mode === "history"} {...evidenceProps} />
      )}

      <WeaknessPanel t={t} lang={lang} data={weakness} />
    </div>
  );
}
