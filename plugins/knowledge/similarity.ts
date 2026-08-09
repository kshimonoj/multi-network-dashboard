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

// ---- 71: 重複判定の下ごしらえ(絞り込み)----
//
// score() は「同じことを言っているか」の **判定** には使えない。
// 実データ(data/knowledge)で測ると、日本語の言い換えでほぼ同義の rogue AP 系エントリが
// 0.25〜0.38、まったく別の事象(スイッチ全断 ⇄ 仮想ラボ再起動)が 0.32 で、
// 両者の帯が重なっていて 1 本のしきい値では切れない(71 の調査結果)。
//
// そこで 71 では役割を分けた:
//   ここ(lexical)  … 再現率だけを重視して「比べる価値のある相手」を数件に絞る
//   dedupe.ts(LLM) … 絞り込んだ相手と本当に同じ知見かを判定する
//
// 絞り込みでタグの共有も見るのは、**言語をまたぐため**。タグは日英どちらの
// エントリでも英語(rogue-ap 等)で付くので、和文エントリと英文エントリの
// 唯一の橋渡しになる(文字 bigram はまったく重ならない)。

/** 共有しているタグの数(正規化して比較)。 */
export function sharedTagCount(a: string[], b: string[]): number {
  const B = new Set((b || []).map(normalizeText).filter(Boolean));
  let n = 0;
  for (const t of new Set((a || []).map(normalizeText).filter(Boolean))) if (B.has(t)) n += 1;
  return n;
}

export interface ShortlistHit extends SimilarHit {
  /** 共有タグ数(絞り込みの根拠。ログ・動作確認用)。 */
  sharedTags: number;
}

export interface ShortlistOptions {
  /** これ以上の一致度なら相手に含める(既定 0.15。判定用ではなく絞り込み用の低い値)。 */
  threshold?: number;
  /** 共有タグがこの数以上なら、一致度が低くても相手に含める(既定 1)。 */
  minSharedTags?: number;
  /** 返す上限。 */
  limit?: number;
}

/**
 * LLM に投げる前の絞り込み。「一致度が低くない」か「タグを共有している」相手を、
 * タグ共有ぶんを加点した順に上位 limit 件返す。
 *
 * ここで取りこぼすと LLM が判定する機会そのものが無くなるので、
 * しきい値は **判定用(similarityThreshold)より意図的に低く** してある。
 */
export function shortlistSimilar(
  candidate: KnowledgeEntry,
  pool: KnowledgeEntry[],
  opts: ShortlistOptions = {},
): ShortlistHit[] {
  const threshold = opts.threshold ?? 0.15;
  const minSharedTags = opts.minSharedTags ?? 1;
  const limit = opts.limit ?? 5;
  const hits: ShortlistHit[] = [];
  for (const e of pool) {
    if (e.id === candidate.id) continue;
    const s = score(candidate, e);
    const shared = sharedTagCount(candidate.tags, e.tags);
    if (s < threshold && shared < minSharedTags) continue;
    hits.push({ entry: e, score: s, sharedTags: shared });
  }
  // 並び順は「一致度 + タグ共有ぶんの加点」。タグは 2 個までしか効かせない
  // (mist / security のような広いタグが 3 個並んだだけで上位に来ないように)。
  const rank = (h: ShortlistHit) => h.score + 0.15 * Math.min(2, h.sharedTags);
  hits.sort((x, y) => rank(y) - rank(x));
  return hits.slice(0, limit);
}
