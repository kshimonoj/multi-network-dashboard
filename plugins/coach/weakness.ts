// Coach(65)— 弱点の算出。
//
// **記録するのはコードで観測できる事実だけ**(64_findings.md §5-2(a))。
// モデルの自然文評価は保存しない(正誤は [VERDICT:...] マーカー由来の 3 値だけ)。
//
// **attempts >= minAttempts(既定 3)になるまで「弱点」として扱わない。**
// 1 回間違えただけで弱点認定すると、その話題ばかり出されて嫌になる
// (この機能で最も起こりやすい失敗)。
//
// 学習者 ID は持たない(デモ用途のため認証機構を作らないという確定事項)。
// 記録は 1 つのプロファイルに集約し、誰でも見られる形で表示する。

import { getSettings, getWeakness } from "./store.js";
import type { WeaknessView } from "./types.js";

/**
 * 弱点スコア(0〜1)。
 *   誤答率     = (wrong + partial * 0.5) / attempts
 *   ヒント依存 = 平均 hintLevel / 3
 * の合成。壁打ちしかしていない話題(attempts=0)はヒント依存だけで測る。
 */
function computeScore(stat: {
  attempts: number;
  wrong: number;
  partial: number;
  hintSum: number;
  hintCount: number;
}): number | null {
  const hasQuiz = stat.attempts > 0;
  const hasChat = stat.hintCount > 0;
  if (!hasQuiz && !hasChat) return null;
  const missRate = hasQuiz ? (stat.wrong + stat.partial * 0.5) / stat.attempts : null;
  const hintRate = hasChat ? stat.hintSum / stat.hintCount / 3 : null;
  if (missRate !== null && hintRate !== null) {
    return Math.round((0.7 * missRate + 0.3 * hintRate) * 1000) / 1000;
  }
  return Math.round(((missRate ?? hintRate) as number) * 1000) / 1000;
}

export function weaknessViews(): WeaknessView[] {
  const settings = getSettings();
  const { topics } = getWeakness();
  const out: WeaknessView[] = [];
  for (const stat of Object.values(topics)) {
    const score = computeScore(stat);
    // 「弱点」を名乗るには、クイズの回答が minAttempts 以上あるか、
    // 壁打ちで同じ話題を minAttempts 回以上扱っているかのどちらかが要る。
    const enough = stat.attempts >= settings.minAttempts || stat.hintCount >= settings.minAttempts;
    out.push({
      topicKey: stat.topicKey,
      attempts: stat.attempts,
      correct: stat.correct,
      partial: stat.partial,
      wrong: stat.wrong,
      avgHintLevel: stat.hintCount > 0 ? Math.round((stat.hintSum / stat.hintCount) * 100) / 100 : null,
      escalations: stat.escalations,
      score: enough ? score : null,
      isWeak: enough && score !== null && score >= settings.weaknessThreshold,
      lastAt: stat.lastAt,
    });
  }
  out.sort((a, b) => {
    if (a.isWeak !== b.isWeak) return a.isWeak ? -1 : 1;
    return (b.score ?? -1) - (a.score ?? -1);
  });
  return out;
}

/** 弱点と判定済みの話題キー(hintLevel の開始値・3 ターン規則・クイズ選択に効く)。 */
export function weakTopicKeys(): string[] {
  return weaknessViews()
    .filter((w) => w.isWeak)
    .map((w) => w.topicKey);
}
