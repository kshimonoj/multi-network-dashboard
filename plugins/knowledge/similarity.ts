// ナレッジ(46 Task 2)— 重複検出。
//
// 「新しい候補が、既に承認済みのナレッジと同じことを言っていないか」を測る。
// 指示どおり **簡易的な一致度** で判定する(埋め込み検索・ベクトル DB は使わない)。
//
// 方式: 文字 bigram の Dice 係数 + タグの Jaccard + 対象(機器 / サイト / プラットフォーム)の一致。
//  - 文字 bigram にしたのは、日本語(分かち書きが無い)と英語の両方を同じ式で扱うため。
//    形態素解析器を足さずに「AP がオフラインになる」/「AP のオフライン多発」を近いと言える。
//  - 正規化は NFKC + 小文字化 + 記号/空白の除去。全角半角・大文字小文字・句読点の揺れを潰す。
//
// しきい値は設定(similarityThreshold、既定 0.5)。超えたら「類似候補あり」として
// 承認画面にマージ提案を出す。**自動でマージはしない**(承認は必ず人が押す)。

import type { KnowledgeEntry } from "./types.js";

/** 比較用の正規化。日本語の助詞まで落とすと別物が一致しやすくなるので、記号だけを削る。 */
export function normalizeText(v: string): string {
  return (v || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[!-/:-@[-`{-~、。「」『』・…ー〜]/g, "");
}

/** 文字 bigram の集合。47 の関連度判定(retrieve.ts)も同じ刻み方を使う。 */
export function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length === 0) return out;
  if (s.length === 1) {
    out.add(s);
    return out;
  }
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/** 文字 bigram の Dice 係数(0〜1)。どちらかが空なら 0。 */
export function textSimilarity(a: string, b: string): number {
  const A = bigrams(normalizeText(a));
  const B = bigrams(normalizeText(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

/** タグ集合の Jaccard 係数(0〜1)。どちらも空なら「情報なし」として 0。 */
export function tagSimilarity(a: string[], b: string[]): number {
  const A = new Set(a.map(normalizeText).filter(Boolean));
  const B = new Set(b.map(normalizeText).filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function sameOrNull(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return normalizeText(a) === normalizeText(b);
}

/**
 * 候補 a と既存 b の一致度(0〜1)。
 *
 * 重み:
 *   タイトル 0.45 … 「何の問題か」を一番よく表す
 *   症状     0.25 … タイトルが違う言い回しでも症状が同じなら拾える
 *   タグ     0.15
 *   対象     0.15 … 同じ機器 0.10 / 同じサイト 0.03 / 同じプラットフォーム 0.02
 *
 * 対象が違っていても、一般的なパターン(scope=general)同士ならタイトル・症状だけで
 * しきい値を超えうる。逆に「別サイトの同じ事象」は対象点が入らないぶん超えにくく、
 * サイト固有の知見が取り違えられにくい。
 */
export function score(a: KnowledgeEntry, b: KnowledgeEntry): number {
  const title = textSimilarity(a.title, b.title);
  const symptom = textSimilarity(a.symptom, b.symptom);
  const tags = tagSimilarity(a.tags, b.tags);
  let target = 0;
  if (sameOrNull(a.device, b.device)) target += 0.1;
  if (sameOrNull(a.site, b.site)) target += 0.03;
  if (a.platform && a.platform === b.platform) target += 0.02;
  const s = 0.45 * title + 0.25 * symptom + 0.15 * tags + target;
  return Math.min(1, Math.round(s * 1000) / 1000);
}

export interface SimilarHit {
  entry: KnowledgeEntry;
  score: number;
}

/** candidate に似ている既存エントリを、スコアの高い順に返す(しきい値以上のみ)。 */
export function findSimilar(
  candidate: KnowledgeEntry,
  pool: KnowledgeEntry[],
  threshold: number,
  limit = 3,
): SimilarHit[] {
  const hits: SimilarHit[] = [];
  for (const e of pool) {
    if (e.id === candidate.id) continue;
    const s = score(candidate, e);
    if (s >= threshold) hits.push({ entry: e, score: s });
  }
  hits.sort((x, y) => y.score - x.score);
  return hits.slice(0, limit);
}
