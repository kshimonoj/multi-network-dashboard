// Coach(65)— 機械可読マーカーの検出と除去。
//
// CLAUDE.md 第 3 項:「モデル出力を自然言語でパースする実装を作らない」。
// 出典宣言・正誤判定・理解段階の見立ては、すべて**言語非依存のマーカー**で受け取る。
// 方式は insight-agent.ts の `[SKIP:central]`(detectPlatformJudgments /
// stripPlatformJudgments)とまったく同じで、日英どちらの system prompt でも
// 同じ形を指示し、翻訳・全角化を禁じる一文を入れる。
//
// 検出は**内部判定にだけ**使い、ユーザーに見せる本文からは必ず取り除く
// (残すと画面に `[SRC:knowledge:...]` がそのまま出る)。

import type { LearnerLevel, MaterialKind, QuizVerdict } from "./types.js";

// ---- 検出用(厳密)と除去用(緩い)を意図的に分けてある ----
//
// **除去は検出より必ず広く取る。** モデルは仕様に無い値も出す:
// 実際に `[LEVEL:L0]`(L1〜L3 しか指示していないのに)を出してきて、
// L1|L2|L3 しか見ない正規表現をすり抜けて画面に生で表示された。
// 「検出できないものは除去もできない」と、そのままユーザーに見える。
//
// よって:
//   検出 … 想定した値だけを受け取る(想定外は「宣言なし」として扱う)
//   除去 … `[SRC:...]` / `[LEVEL:...]` / `[VERDICT:...]` の**形をしたものは全部**落とす

// 検出用(厳密)。許容する揺れは大文字小文字だけ。
const SRC_RE = /\[SRC:(knowledge|history|live|rule):([^\]\s]{1,120})\]/gi;
const LEVEL_RE = /\[LEVEL:(L[123])\]/gi;
const VERDICT_RE = /\[VERDICT:(correct|partial|wrong)\]/gi;

// 除去用(緩い)。値の中身は問わない。
const ANY_MARKER_RE = /\[(?:SRC|LEVEL|VERDICT):[^\]\n]{0,160}\]/gi;

/** マーカーだけの行(箇条書き記号付きも含む)をまるごと落とすための形。 */
const MARKER_LINE_RE = /^[ \t]*(?:[-*>][ \t]*)?(?:\[(?:SRC|LEVEL|VERDICT):[^\]\n]{0,160}\][ \t]*)+$/gim;

export interface DetectedSource {
  kind: MaterialKind;
  id: string;
}

/**
 * `[SRC:knowledge:<id>]` 等を検出する。
 *
 * **渡した素材の id 集合に含まれるものだけを採用する**(64 §5-3(a))。
 * 存在しない id を出してきた場合は捨てる(捏造対策)。allowed を渡さない場合は
 * 検出したものをそのまま返す(検証はしない)。
 */
export function detectSources(text: string, allowed?: Set<string>): DetectedSource[] {
  if (!text || !/\[SRC:/i.test(text)) return [];
  const out: DetectedSource[] = [];
  const seen = new Set<string>();
  SRC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SRC_RE.exec(text))) {
    const kind = m[1].toLowerCase() as MaterialKind;
    const id = m[2].trim();
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    if (allowed && !allowed.has(key)) continue;
    seen.add(key);
    out.push({ kind, id });
  }
  return out;
}

/** `[LEVEL:L2]` を検出する(最後に出たものを採る)。 */
export function detectLevel(text: string): LearnerLevel | null {
  if (!text || !/\[LEVEL:/i.test(text)) return null;
  LEVEL_RE.lastIndex = 0;
  let last: LearnerLevel | null = null;
  let m: RegExpExecArray | null;
  while ((m = LEVEL_RE.exec(text))) last = m[1].toUpperCase() as LearnerLevel;
  return last;
}

/** `[VERDICT:partial]` を検出する(最初に出たものを採る = 判定は 1 回だけ)。 */
export function detectVerdict(text: string): QuizVerdict | null {
  if (!text || !/\[VERDICT:/i.test(text)) return null;
  VERDICT_RE.lastIndex = 0;
  const m = VERDICT_RE.exec(text);
  return m ? (m[1].toLowerCase() as QuizVerdict) : null;
}

/**
 * 本文からマーカーをすべて取り除く。行ごと消せる場合は行ごと消す。
 *
 * **値の中身は問わない**(ANY_MARKER_RE)。仕様に無い値(`[LEVEL:L0]` 等)を
 * モデルが出しても画面には出さない。検出側が受け取れなくても、表示は必ず綺麗にする。
 */
export function stripMarkers(text: string): string {
  if (!text) return "";
  if (!/\[(?:SRC|LEVEL|VERDICT):/i.test(text)) return text.trim();
  return text
    .replace(MARKER_LINE_RE, "")
    // 行頭でない位置(文中に混ぜられた場合)の保険。
    .replace(ANY_MARKER_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 素材 id の集合(`kind:id` 形式)。detectSources の allowed に渡す。 */
export function materialKeySet(materials: Array<{ kind: MaterialKind; id: string }>): Set<string> {
  return new Set(materials.map((m) => `${m.kind}:${m.id}`));
}
