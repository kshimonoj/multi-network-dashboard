// Coach(65)— hintLevel の状態機械。
//
// **この機能で最も重要な部分**(64_findings.md §2-3)。
// 「いつ答えを出すか」をモデルに判断させると、プロンプトの言い回しやモデル更新で
// 無言に挙動が変わり、しかも「出し渋りすぎている」ことは画面から見えない。
// サーバが決定的に進める状態機械として持ち、**必ず開示に到達する経路を 3 つ**用意する:
//
//   (1) 3 ターン規則     … 同じ論点で turnRule 往復したら、次のターンで必ず hintLevel=3
//   (2) 明示エスカレーション … 「もう答えを教えて」でいつでも hintLevel=3
//   (3) 障害対応中モード   … セッション開始時に選んでいれば最初から hintLevel=3
//
// 弱点タグ(= 過去につまずいている話題)では:
//   - 開始レベルを 0 ではなく 1 にする(苦手なところで空振りさせない)
//   - 3 ターン規則を weakTurnRule(既定 2)に短縮する

import { sameTopic } from "./materials.js";
import type { CoachSession, CoachSettings, HintLevel, TurnIntent } from "./types.js";

export interface HintDecision {
  hintLevel: HintLevel;
  /** 今の論点で何往復目か(このターンを含む)。 */
  turnsOnTopic: number;
  /** 論点が変わったか(弱点記録の「セッション数」の数え方に使う)。 */
  newTopic: boolean;
  /** 3 ターン規則で強制的に開示へ飛ばしたか。 */
  forcedDisclosure: boolean;
  /** 「もう答えを教えて」が押されたターンか。 */
  escalated: boolean;
  /** このターンで採用した 3 ターン規則の値(弱点なら短縮版)。 */
  turnRule: number;
  /** 弱点タグの話題か。 */
  weakTopic: boolean;
}

function clampLevel(n: number): HintLevel {
  return Math.min(3, Math.max(0, Math.round(n))) as HintLevel;
}

/**
 * このターンの hintLevel を決める。
 *
 * @param session   直前までのセッション(1 ターン目なら turns が空)
 * @param intent    View のボタン(ask / hintMore / escalate)
 * @param topicKeys このターンの話題キー。**学習者の発話から取れたものだけ**を渡すこと
 *                  (67 番。当たった素材のタグを借りた「素材由来のキー」を渡すと、
 *                   相槌のたびに別の論点に見えて往復数がリセットされる)
 * @param weakTopics 弱点と判定済みの話題キー
 */
export function decideHintLevel(
  session: CoachSession,
  intent: TurnIntent,
  topicKeys: string[],
  weakTopics: string[],
  settings: CoachSettings,
): HintDecision {
  const keys = topicKeys.length ? topicKeys : session.topicKeys;
  const weakTopic = keys.some((k) => weakTopics.includes(k));
  const turnRule = weakTopic ? settings.weakTurnRule : settings.turnRule;

  // 話題が変わったら往復数をリセットする。「同じ論点で 3 往復」の判定なので、
  // 別の話に移ったのに前の論点の往復数を引きずってはいけない。
  // 逆に **話題キーが 1 つも取れない発話(相槌・ボタンだけ)ではリセットしない**
  // (67 番。`topicKeys.length > 0` の条件がその門になっている)。
  const firstTurn = session.turns.length === 0;
  const newTopic = firstTurn || (topicKeys.length > 0 && !sameTopic(session.topicKeys, topicKeys));
  const turnsOnTopic = newTopic ? 1 : session.turnsOnTopic + 1;

  // (3) 障害対応中モード — 最初から開示。エスカレーションを「押させる」設計より安全
  //     (押していいのかの判断を junior に負わせない)。
  if (session.incidentMode) {
    return {
      hintLevel: 3,
      turnsOnTopic,
      newTopic,
      forcedDisclosure: false,
      escalated: intent === "escalate",
      turnRule,
      weakTopic,
    };
  }

  // (2) 明示エスカレーション — いつでも即開示。
  if (intent === "escalate") {
    return {
      hintLevel: 3,
      turnsOnTopic,
      newTopic,
      forcedDisclosure: false,
      escalated: true,
      turnRule,
      weakTopic,
    };
  }

  // 開始レベル。弱点タグでは 1 から始める(苦手なところで空振りさせない)。
  const base: HintLevel = weakTopic ? 1 : 0;

  // 論点が変わったら開始レベルに戻し、同じ論点を続けているなら 1 段上げる。
  // 「💡 ヒントをもう 1 つ」を押した場合も同じ扱いにしてある(押した本人にとっては
  // 「もう一段ほしい」で、通常のターンで一段進むのと結果が同じであるべきなので、
  // ここを分けると同じ操作感に 2 つの挙動ができてしまう)。
  const level0: HintLevel = newTopic ? base : clampLevel(session.hintLevel + 1);
  let level = level0;

  // (1) 3 ターン規則 — 同じ論点で turnRule 往復に達したら必ず開示。
  // 生産的な苦戦(productive struggle)には有限の閾値があり、
  // 成功体験のない反復は「自分には無理だ」の学習になる。
  let forcedDisclosure = false;
  if (!newTopic && turnsOnTopic >= turnRule && level < 3) {
    level = 3;
    forcedDisclosure = true;
  }

  return { hintLevel: level, turnsOnTopic, newTopic, forcedDisclosure, escalated: false, turnRule, weakTopic };
}

/** 新しいセッションの初期状態。 */
export function newSession(sessionId: string, mode: "chat" | "quiz", incidentMode: boolean): CoachSession {
  const now = new Date().toISOString();
  return {
    sessionId,
    mode,
    incidentMode,
    startedAt: now,
    updatedAt: now,
    hintLevel: incidentMode ? 3 : 0,
    turnsOnTopic: 0,
    topicKeys: [],
    level: null,
    escalated: false,
    liveCount: 0,
    turns: [],
    quiz: null,
  };
}
