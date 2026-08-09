// Coach View(65)— 弱点プロファイルの表示。
//
// 学習者 ID は持たない(デモ用途のため認証機構を作らないという確定事項)。
// 記録は 1 つのプロファイルに集約し、誰でも見られる形で出す。
//
// **attempts / hintCount が minAttempts(既定 3)に届くまで「弱点」と呼ばない**
// (64_findings.md §5-2(c))。1 回間違えただけで弱点認定すると、その話題ばかり
// 出されて嫌になる。届いていないものは「まだ様子見」として別に並べる。

import type { Lang, TFunc } from "../../../src/i18n";
import { formatDateTime } from "../../../src/i18n";
import type { WeaknessResponse } from "./types";

interface Props {
  t: TFunc;
  lang: Lang;
  data: WeaknessResponse | null;
}

export function WeaknessPanel({ t, lang, data }: Props) {
  if (!data) return null;
  const weak = data.topics.filter((w) => w.isWeak);
  const watching = data.topics.filter((w) => !w.isWeak).slice(0, 8);

  return (
    <section className="go-panel co-panel">
      <div className="go-panel-head">
        <span className="go-panel-title">
          <span aria-hidden>📊</span> {t("coach.weakness.title")}
        </span>
        <span className="go-panel-note">
          {t("coach.weakness.rule", { n: data.settings.minAttempts })}
        </span>
      </div>

      {data.topics.length === 0 ? (
        <div className="co-empty-text">{t("coach.weakness.empty")}</div>
      ) : (
        <>
          {weak.length > 0 && (
            <>
              <div className="go-note co-weak-note">{t("coach.weakness.weakNote")}</div>
              <ul className="co-weak-list">
                {weak.map((w) => (
                  <li key={w.topicKey} className="co-weak-item co-weak-item-on">
                    <span className="co-topic co-topic-weak">#{w.topicKey}</span>
                    <span className="co-weak-stats">
                      {t("coach.weakness.quizStats", {
                        attempts: w.attempts,
                        correct: w.correct,
                        partial: w.partial,
                        wrong: w.wrong,
                      })}
                      {w.avgHintLevel !== null && (
                        <>
                          {" / "}
                          {t("coach.weakness.avgHint", { v: w.avgHintLevel })}
                        </>
                      )}
                      {w.escalations > 0 && (
                        <>
                          {" / "}
                          {t("coach.weakness.escalations", { n: w.escalations })}
                        </>
                      )}
                    </span>
                    {w.lastAt && <span className="co-weak-at">{formatDateTime(w.lastAt, lang)}</span>}
                  </li>
                ))}
              </ul>
              <div className="go-note co-weak-effect">{t("coach.weakness.effect")}</div>
            </>
          )}

          {watching.length > 0 && (
            <>
              <div className="go-note co-weak-note">{t("coach.weakness.watchingNote")}</div>
              <ul className="co-weak-list">
                {watching.map((w) => (
                  <li key={w.topicKey} className="co-weak-item">
                    <span className="co-topic">#{w.topicKey}</span>
                    <span className="co-weak-stats">
                      {t("coach.weakness.quizStats", {
                        attempts: w.attempts,
                        correct: w.correct,
                        partial: w.partial,
                        wrong: w.wrong,
                      })}
                      {w.avgHintLevel !== null && (
                        <>
                          {" / "}
                          {t("coach.weakness.avgHint", { v: w.avgHintLevel })}
                        </>
                      )}
                    </span>
                    {w.lastAt && <span className="co-weak-at">{formatDateTime(w.lastAt, lang)}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
