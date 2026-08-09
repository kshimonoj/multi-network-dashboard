// Coach(67)— 学習者の発話が「文脈の継続」か「新しい問い」かの区別。
//
// 65 番の実測(66_findings.md §5-(a)(b))で 2 つの症状が出ていた。原因は同じ 1 点、
// **「発話の中身を見ずに、そのターンの検索文と話題キーを作り直していたこと」**だった。
//
//   (a) 「もう答えを教えて」(ボタン = 発話なし)を押すと教材が 0 件になる。
//       検索文が空 or 直前ターンの空文字列になり、教材を引けないまま hintLevel=3 に
//       到達する。**開示の保証が空振りする**(答えの根拠が何も出ない)。
//   (b) 「わからない」「まだ何も確認していなかった。」のような相槌で往復数が 1 に戻る。
//       発話から話題キーが取れないと `extractTopicKeys()` が**素材のタグ**に
//       フォールバックし、直前と無関係なキー([rf,RF-14] / [pmf,methodology,…])が
//       立って「話題が変わった」と誤判定される。3 ターン規則が遠のく。
//
// どちらも「短い相槌・ボタンだけのターン」を、独立した新しい問いとして扱ってしまう形。
// ここで**発話そのものを機械的に分類**して、以降の処理の入力を切り替える。
//
// **これはモデル出力の自然文パースではない**(CLAUDE.md 第 3 項)。
// 見るのは**学習者の入力**であり、materials.ts の JA_SYNONYMS / topicKeysOf() と同じ立場。
// 判定に使うのは「長さ」と「話題キーが取れたか」だけで、意味の読み取りはしない。

import type { CoachLang } from "./types.js";

export type UtteranceKind =
  /** 発話なし(💡 ヒントをもう 1 つ / 🔓 もう答えを教えて のボタンだけ)。 */
  | "empty"
  /** 相槌・短い返事。前のターンの続きとして扱う。 */
  | "continuation"
  /** 中身のある発話。話題キーが立てば論点の切り替えになりうる。 */
  | "substantive";

/**
 * 相槌の語彙(日英)。**全体一致**で見る(部分一致にすると「はい」が
 * 「配線」「はいっている」等を巻き込む)。
 *
 * 長さの規則(下の SHORT_CHARS / SHORT_WORDS)だけでもほとんど拾えるが、
 * 相槌がたまたま長かった場合(「なるほど、ありがとうございます」)の取りこぼしを防ぐ。
 */
const ACK_WORDS: Record<CoachLang, string[]> = {
  ja: [
    "はい", "うん", "ええ", "そう", "そうです", "そうですね", "そっか", "そうか", "なるほど",
    "なるほどね", "たしかに", "確かに", "わかった", "わかりました", "了解", "りょうかい",
    "ok", "おけ", "おｋ", "ふむ", "へえ", "へー", "ありがとう", "ありがとうございます",
    "いいえ", "いや", "わからない", "わかりません", "分からない", "思いつかない",
    "つづき", "続き", "もっと", "もう少し", "次", "はいはい", "うーん", "うん、なるほど",
  ],
  en: [
    "yes", "yeah", "yep", "yup", "ok", "okay", "k", "sure", "right", "got it", "gotit",
    "i see", "isee", "understood", "makes sense", "thanks", "thank you", "no", "nope",
    "hmm", "hm", "idk", "i dont know", "i don't know", "not sure", "no idea",
    "more", "tell me more", "go on", "continue", "next", "ah", "oh", "cool", "nice",
  ],
};

const ACK_SET = new Set([...ACK_WORDS.ja, ...ACK_WORDS.en].map((w) => w.toLowerCase()));

/**
 * 「短い」の境界。**実測に合わせてある**:
 *   「まだ何も確認していなかった。」= 14 文字 / 「うーん、思いつかない」= 10 文字
 *   「Multi Network Dashboard」= 3 語
 * 一方で「rogue AP のアラートが出たときは?」のような**短い新しい問い**は、
 * 話題キー(rogue-ap)が立つので長さの規則より先に substantive に倒れる。
 */
const SHORT_CHARS = 24;
const SHORT_WORDS = 6;

/** 相槌の判定用に、記号・空白・絵文字を落とした形にする。 */
function ackNormalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s、。，．,.!?！？…・「」『』()（）\-~〜:：;；]/g, "")
    .trim();
}

function charCount(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function wordCount(text: string): number {
  const w = text.trim().split(/\s+/).filter(Boolean);
  return w.length;
}

/**
 * 和文かどうか。**語数の規則は和文に使えない**(空白で切れないので常に 1 語になり、
 * どんなに長い日本語の質問も「短い」と判定されてしまう。実装中に踏んだ)。
 * 和文は文字数だけで測る。
 */
const CJK_RE = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;

function isShort(text: string): boolean {
  if (CJK_RE.test(text)) return charCount(text) <= SHORT_CHARS;
  return wordCount(text) <= SHORT_WORDS || charCount(text) <= SHORT_CHARS;
}

/**
 * 発話を分類する。
 *
 * @param text        学習者の発話(ボタンだけなら空文字列)
 * @param spokenKeys  **その発話自体から**取れた話題キー(素材由来のものは渡さないこと)
 */
export function classifyUtterance(text: string, spokenKeys: string[]): UtteranceKind {
  const t = (text ?? "").trim();
  if (!t) return "empty";
  if (ACK_SET.has(ackNormalize(t))) return "continuation";
  // 自分の言葉で話題を名指しした = 新しい論点になりうる。長さより優先する。
  if (spokenKeys.length > 0) return "substantive";
  if (isShort(t)) return "continuation";
  return "substantive";
}

/**
 * 教材を引くための検索文を作る。
 *
 * 継続のターン(相槌 / ボタンだけ)は**それ自体に検索価値が無い**ので、
 * 直近の実質的な質問と、今の論点の話題キーを足して引く。
 * これが無いと「もう答えを教えて」で教材 0 件になり、hintLevel=3 なのに
 * 「うちの記録には無い」と返る(= 開示の保証が空振りする)。
 *
 * 話題キーをそのまま文字列として混ぜているのは、materials.ts 側の入口
 * (topicKeysOf → contains)が**タグ表記そのもの**を拾えるため。
 * 新しい受け渡し口を増やさずに、履歴層の門(話題キー一致)も通せる。
 */
export function buildRetrievalQuery(opts: {
  kind: UtteranceKind;
  question: string;
  /** 直近の「発話のあったターン」の質問文(無ければ空)。 */
  lastSubstantive: string;
  /** 今の論点の話題キー(セッションが持っているもの)。 */
  topicKeys: string[];
}): string {
  if (opts.kind === "substantive") return opts.question.trim();
  const parts = [opts.question.trim(), opts.lastSubstantive.trim(), opts.topicKeys.join(" ")];
  return parts.filter(Boolean).join(" ").trim();
}

/**
 * 直近の「実質的な発話があったターン」の質問文を後ろから探す。
 *
 * 相槌のターン(「わからない」)を拾ってしまうと検索文にならないので、
 * substantive のものを優先し、1 つも無ければ**空でない最後の発話**に落とす
 * (それすら無いのは 1 ターン目にいきなりボタンを押した場合で、教材 0 件になる)。
 *
 * @param isSubstantive 発話 1 件を分類する述語。話題キーの抽出が要るので呼び出し側で組む。
 */
export function lastSubstantiveQuestion(
  turns: Array<{ question: string }>,
  isSubstantive: (question: string) => boolean,
): string {
  let fallback = "";
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const q = (turns[i]?.question ?? "").trim();
    if (!q) continue;
    if (isSubstantive(q)) return q;
    if (!fallback) fallback = q;
  }
  return fallback;
}
