// Coach(65)— 教材の取得と優先順位付け。
//
// 3 層の担当は代替関係ではなく、持っているものが違う(64_findings.md §1-4):
//   ナレッジ(承認済み) … 結論。「この症状ならここを疑う」
//   調査履歴            … 手順。`calls[]` に熟練者がどの順でツールを叩いたかが残っている
//   ベストプラクティス   … 語彙と一般論。「そもそも何が推奨なのか」
//
// **層の選択はコードで行い、LLM に選ばせない**(47 番と同じ設計)。3 層すべてを渡して
// 「適切なものを選べ」と指示すると、何を根拠にしたかが自然文でしか分からなくなり、
// CLAUDE.md の禁止事項(モデル出力の自然文パース)に触れる。
//
// **ナレッジの refCount は絶対に加算しない**(64 §1-1(d))。
// buildInjection() は内部で recordReferences() を呼ぶので使わず、
// 副作用の無い relevantEntries() だけを呼ぶ。Coach 側の利用実績は store.ts の
// material-usage.json に別立てで持つ。

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { listHistoryRecords, type QueryHistoryRecord } from "../network-investigation/api.js";
import { listByStatus } from "../knowledge/store.js";
import { relevantEntries } from "../knowledge/retrieve.js";
import { bigrams, normalizeText, textSimilarity } from "../knowledge/similarity.js";
import { RULES } from "../best-practice/rules.js";
import type { BestPracticeRule } from "../best-practice/types.js";
import type { KnowledgeEntry } from "../knowledge/types.js";
import type { CoachLang, CoachMaterial, MaterialKind } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- ルールの文言(辞書から読む)----
//
// ルールの title / desc は i18n 辞書にしかない(rules.ts が持つのは titleKey / descriptionKey)。
// サーバはここを **素材の原文**として使うので、起動時に両言語ぶん読み込んでおく。
// 読めなくても Coach は動く(ルール層が ID だけになるだけ)。

type Dict = Record<string, unknown>;
const ruleDicts: Record<CoachLang, Dict> = { ja: {}, en: {} };

function lookup(dict: Dict, key: string): string | null {
  let cur: unknown = dict;
  for (const seg of key.split(".")) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Dict)[seg];
  }
  return typeof cur === "string" ? cur : null;
}

export async function loadRuleDictionaries(): Promise<void> {
  for (const lang of ["ja", "en"] as CoachLang[]) {
    try {
      const file = path.resolve(__dirname, `../../src/i18n/${lang}.json`);
      ruleDicts[lang] = JSON.parse(await readFile(file, "utf-8")) as Dict;
    } catch {
      ruleDicts[lang] = {};
    }
  }
  const n = Object.keys(ruleDicts.ja).length;
  console.log(`[coach] ルール文言の辞書を読み込みました(ja: ${n > 0 ? "あり" : "なし"})`);
}

export function ruleText(rule: BestPracticeRule, lang: CoachLang): { title: string; desc: string } {
  const d = ruleDicts[lang] ?? {};
  const fallback = ruleDicts.ja ?? {};
  return {
    title: lookup(d, rule.titleKey) ?? lookup(fallback, rule.titleKey) ?? rule.id,
    desc: lookup(d, rule.descriptionKey) ?? lookup(fallback, rule.descriptionKey) ?? "",
  };
}

// ---- 共通のテキスト一致(knowledge/similarity.ts の刻み方をそのまま再利用)----

/** 重なり係数。短い側がどれだけ相手に含まれるか(retrieve.ts と同じ式)。 */
function overlap(a: string, b: string): number {
  const A = bigrams(normalizeText(a));
  const B = bigrams(normalizeText(b));
  if (A.size === 0 || B.size === 0) return 0;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  let inter = 0;
  for (const g of small) if (large.has(g)) inter += 1;
  return inter / small.size;
}

function contains(haystackNorm: string, needle: string | null | undefined): boolean {
  const n = normalizeText(needle ?? "");
  return n.length >= 2 && haystackNorm.includes(n);
}

function clip(s: string, max: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * ISO 文字列からの経過日数。パースできなければ null。
 *
 * 68 番でライブ層の門(「静的な素材が古ければライブで裏を取る」)に使う。
 * **表示用の整形ではない**ので src/i18n/format.ts は通さない(数値のまま扱う)。
 */
export function ageDaysOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 86_400_000));
}

// ---- 話題キー(topicKey)----
//
// **新しい分類体系を作らない**(64 §5-2(b))。承認済みナレッジのタグ語彙と
// ベストプラクティスのカテゴリ / ルール ID をそのまま軸に使う。
// 他タブとの相互リンクが素直になるのと、語彙が既に揃っているため。

/**
 * 日本語の言い回しからタグ語彙へ橋渡しする最小の対応表。
 * タグは英語表記が多く(実測: rogue-ap / switch-offline / roaming …)、
 * 和文の質問だと文字 bigram では当たらないため、ここだけは明示的に持つ。
 * **これはユーザーの入力を見る処理**であり、モデル出力の自然文パースではない。
 */
const JA_SYNONYMS: Array<[RegExp, string[]]> = [
  [/アラート|アラーム|alert|alarm/i, ["alert-triage"]],
  // 69 番で修正: 以前は /ap\b|アクセスポイント/ が単独で ap-offline(= AP がオフライン
  // という特定の事象のタグ)に対応付けられており、AP に触れる質問すべてが
  // ap-offline を背負って弱点プロファイルを汚染していた(68_findings.md §1-5)。
  // 「AP」への言及 **かつ** オフライン系の言い回しが同じ発話内にある場合だけに絞る
  // (前後どちらの順序でもよいので先読みで判定する)。
  [
    /(?=.*(?:\bap\b|アクセスポイント))(?=.*(?:オフライン|offline|落ち|切断|disconnect|停止|応答しない|反応しない))/i,
    ["ap-offline"],
  ],
  [/rogue|ローグ|不正ap|野良ap/i, ["rogue-ap"]],
  [/evil.?twin|なりすまし|詐称|偽装/i, ["evil-twin", "ssid-spoofing"]],
  [/オフライン|offline|落ちて|切断|disconnect|停止/i, ["offline"]],
  [/スイッチ|switch/i, ["switch-offline"]],
  [/ローミング|roaming|roam/i, ["roaming"]],
  [/繋がら|つながら|接続でき|connect|接続不良/i, ["client-impact"]],
  [/wpa3|wpa2|暗号化|認証方式|セキュリティ/i, ["wireless-security", "security"]],
  [/ssid/i, ["ssid"]],
  [/電波|信号|rssi|snr|弱い|weak/i, ["rssi", "weak-signal"]],
  [/ファーム|firmware|アップグレード|upgrade/i, ["firmware-upgrade"]],
  [/marvis|マービス/i, ["marvis"]],
  [/sle/i, ["sle"]],
  [/iot|レガシー|legacy/i, ["iot"]],
  [/6ghz|6 ?ギガ/i, ["6ghz"]],
  [/5ghz|5 ?ギガ/i, ["5ghz"]],
  [/pmf|管理フレーム/i, ["pmf"]],
  [/切り分け|優先|トリアージ|triage|どれから/i, ["triage"]],
];

/**
 * 承認済みナレッジのタグ語彙(重複除去)。
 *
 * topicKeysOf() は 1 リクエストで履歴 150 件ぶん呼ばれるので、短い TTL で使い回す
 * (listByStatus は毎回 76 件を並べ替える)。承認は人が押す操作なので、
 * 新しいタグが語彙に載るのが数秒遅れても実害は無い。
 */
const VOCAB_TTL_MS = 30_000;
let vocabCache: { at: number; tags: string[] } | null = null;

export function tagVocabulary(): string[] {
  const now = Date.now();
  if (vocabCache && now - vocabCache.at < VOCAB_TTL_MS) return vocabCache.tags;
  const set = new Set<string>();
  for (const e of listByStatus("approved")) for (const t of e.tags) set.add(t);
  vocabCache = { at: now, tags: [...set] };
  return vocabCache.tags;
}

/**
 * 学習者の発話から話題キーを抜き出す。
 * 直接一致(タグ語彙 / ルール ID)→ 同義語表 → マッチした素材のタグ、の順に埋める。
 * 何も取れなければ空配列を返す(呼び出し側が「話題は変わっていない」と扱う)。
 */
export function topicKeysOf(text: string): Set<string> {
  const norm = normalizeText(text);
  const out = new Set<string>();
  for (const tag of tagVocabulary()) {
    if (contains(norm, tag)) out.add(tag);
  }
  for (const rule of RULES) {
    if (contains(norm, rule.id)) out.add(rule.id);
  }
  for (const [re, keys] of JA_SYNONYMS) {
    if (re.test(text)) for (const k of keys) out.add(k);
  }
  return out;
}

/**
 * 当たった素材のタグから話題キーを借りる(発話から 1 つも取れなかったときの穴埋め)。
 *
 * **これを「話題が変わったか」の判定に使ってはいけない**(67 番)。
 * 相槌のように話題キーが取れない発話でも素材検索は必ず何かを返すので、
 * 借りたキーで判定すると毎ターン別の論点に見えて往復数がリセットされる
 * (実測: 「わからない」→ [pmf,methodology,marvis,resolved])。
 * 用途は**弱点プロファイルの軸**と画面表示に限る。
 */
export function materialTopicKeys(matched: CoachMaterial[]): string[] {
  const out = new Set<string>();
  for (const m of matched.slice(0, 2)) for (const t of m.meta.tags.slice(0, 2)) out.add(t);
  return [...out].slice(0, 4);
}

export function extractTopicKeys(text: string, matched?: CoachMaterial[]): string[] {
  const out = topicKeysOf(text);
  if (out.size === 0 && matched) {
    for (const k of materialTopicKeys(matched)) out.add(k);
  }
  return [...out].slice(0, 4);
}

/** 2 つの話題キー集合が「同じ論点」と言えるか(1 つでも重なれば同じ扱い)。 */
export function sameTopic(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((x) => b.includes(x));
}

// ---- Layer A: 承認済みナレッジ ----

const KNOWLEDGE_LIMIT = 3;

function knowledgeMaterial(entry: KnowledgeEntry, score: number, hits: string[]): CoachMaterial {
  // 「その会社ならでは」の強度(64 §1-5(d))。すべてコードで計算できる値だけを使う。
  let boost = 0;
  if (entry.scope === "site") boost += 0.15;
  if (entry.scope === "device") boost += 0.1;
  if (entry.refCount > 0) boost += Math.min(0.1, entry.refCount * 0.01);
  const src = entry.sources[0] ?? null;
  if (src?.origin === "auto") boost += 0.05;

  const body = [
    `タイトル: ${clip(entry.title, 160)}`,
    entry.symptom ? `症状: ${clip(entry.symptom, 260)}` : "",
    `適用範囲: ${entry.scope}${entry.site ? ` / site` : ""}${entry.platform ? ` / ${entry.platform}` : ""}`,
    entry.tags.length ? `タグ: ${entry.tags.map((t) => `#${t}`).join(" ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const answerBody = [
    entry.rootCause ? `根本原因: ${clip(entry.rootCause, 320)}` : "",
    entry.action ? `対処: ${clip(entry.action, 320)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    kind: "knowledge",
    id: entry.id,
    title: entry.title,
    score,
    boost,
    hits,
    body,
    answerBody,
    meta: {
      tags: entry.tags,
      lang: entry.lang,
      runId: src?.runId ?? null,
      // 鮮度。承認済みナレッジは「人が目を通した時刻」を鮮度とする(68 番)。
      at: entry.approvedAt ?? entry.updatedAt ?? null,
      ageDays: ageDaysOf(entry.approvedAt ?? entry.updatedAt ?? null),
    },
  };
}

// ---- Layer B: 調査履歴 ----

/**
 * 教材適格(64 §1-2(a) の実測フィルタ)。
 * scheduled は定点観測で distinct なクエリが 2 種類しかなく教材価値が低いので既定で外す。
 */
export function isTeachable(rec: QueryHistoryRecord): boolean {
  if (rec.isError) return false;
  if (rec.source === "scheduled") return false;
  const answer = rec.answer ?? rec.answerExcerpt ?? "";
  if (answer.length < 400) return false;
  return Array.isArray(rec.calls) && rec.calls.length > 0;
}

const HISTORY_LIMIT = 3;

/**
 * 履歴 1 件が扱っている話題キー。クエリ文と回答の冒頭から抜く。
 * **これが履歴層の必須の門になる**(store.ts の DEFAULT_HISTORY_THRESHOLD のコメント参照)。
 */
export function historyTopicKeys(rec: QueryHistoryRecord): Set<string> {
  const answer = (rec.answer ?? rec.answerExcerpt ?? "").slice(0, 600);
  return topicKeysOf(`${rec.query} ${answer}`);
}

function historyMaterial(rec: QueryHistoryRecord, score: number, hits: string[]): CoachMaterial {
  let boost = 0;
  // 実アラート起点(auto)= 実際に鳴った事象。作り物でない。
  if (rec.source === "auto") boost += 0.08;
  // ナレッジの元にもなった調査は、A と B が同じ事象を指す = 重要度が高い。
  if (rec.knowledgeRefs && rec.knowledgeRefs.length > 0) boost += 0.05;

  const calls = rec.calls ?? [];
  // 手順の教材はここにしかない。1 手目だけを見せ、2 手目以降は答えとして隠す。
  const firstCall = calls[0];
  const answer = rec.answer ?? rec.answerExcerpt ?? "";

  const body = [
    `調べたこと: ${clip(rec.query, 200)}`,
    firstCall ? `最初に叩いたツール: ${firstCall.server}/${firstCall.tool}` : "",
    `使ったツールの数: ${calls.length}`,
  ]
    .filter(Boolean)
    .join("\n");

  const answerBody = [
    `実際のツール呼び出しの順番: ${calls.map((c, i) => `${i + 1}. ${c.tool}`).join(" → ")}`,
    `そのときの結論: ${clip(answer, 420)}`,
  ].join("\n");

  return {
    kind: "history",
    id: rec.id,
    title: clip(rec.query, 90),
    score,
    boost,
    hits,
    body,
    answerBody,
    meta: {
      // tags は**話題キー**にする。実行経路(manual / auto)は話題ではないので
      // 別のフィールドに置く(弱点記録の軸に "auto" が混ざるのを防ぐ)。
      tags: [...historyTopicKeys(rec)].slice(0, 6),
      runId: rec.id,
      source: rec.source,
      platform: rec.resolvedPlatform,
      at: rec.ts ?? null,
      ageDays: ageDaysOf(rec.ts),
    },
  };
}

// ---- Layer C: ベストプラクティス(補助のみ。単独で主素材にはしない)----

const RULE_LIMIT = 2;

function ruleMaterial(rule: BestPracticeRule, score: number, hits: string[], lang: CoachLang): CoachMaterial {
  const { title, desc } = ruleText(rule, lang);
  return {
    kind: "rule",
    id: rule.id,
    title,
    score,
    boost: 0,
    hits,
    body: [
      `ルール ${rule.id}(${rule.category} / ${rule.severity}): ${title}`,
      desc ? `説明: ${clip(desc, 300)}` : "",
      rule.references.length ? `出典: ${rule.references.map((r) => r.title).join(" / ")}` : "",
      // 封じ込め系(SEC-10 / SEC-11)は「有効にすべき」と教えない(49 §3-5 / 64 §1-3(c))。
      rule.requiresLegalReview
        ? "注意: このルールは法務・セキュリティ部門の承認が要る領域。「有効にすべき」とは教えず、誰の承認が要るかを考えさせること。"
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    answerBody: "",
    meta: {
      tags: [rule.category, rule.id],
      references: rule.references,
      severity: rule.severity,
      requiresLegalReview: rule.requiresLegalReview,
    },
  };
}

// ---- 入口 ----

export interface RetrievalResult {
  materials: CoachMaterial[];
  /**
   * 主素材がどの層から来たか。**画面に必ず出す**(自社の事実か一般論かを混ぜない)。
   * ここに "live" は入らない(collectMaterials は静的層だけを見る。ライブは api.ts が後段で足す)。
   */
  primaryLayer: MaterialKind | null;
  /** ルール層だけが当たった = 「うちの記録には無い話」。画面が辞書で文にする。 */
  generalOnly: boolean;
  threshold: number;
}

/**
 * 質問文から教材を集める。段階的フォールバック(A → B → C)だが、
 * **A と B は排他ではない**(結論と手順は担当が違うので、揃うほど教材として良くなる)。
 */
export async function collectMaterials(opts: {
  query: string;
  /** ナレッジ層のしきい値(既定 0.15)。 */
  threshold: number;
  /** 履歴層のしきい値(既定 0.05)。話題キーの門を通ったあとの順位付けの床。 */
  historyThreshold: number;
  max: number;
  lang: CoachLang;
  /** 弱点タグ。同じ話題の素材を少しだけ前に出す。 */
  weakTopics?: string[];
}): Promise<RetrievalResult> {
  const query = (opts.query || "").trim();
  const weak = new Set(opts.weakTopics ?? []);
  if (!query) return { materials: [], primaryLayer: null, generalOnly: false, threshold: opts.threshold };

  const out: CoachMaterial[] = [];

  const askTopics = topicKeysOf(query);

  // Layer A — 副作用なし。**buildInjection() は使わない**(内部で recordReferences() を
  // 呼び、ナレッジの refCount を汚染するため。64 §1-1(d))。
  //
  // relevantEntries() のしきい値判定はそのまま使えるが、Coach では 1 つ足りない。
  // retrieve.ts 自身が「和文はタグが英語で当たりにくい」と書いているとおり、
  // 「スイッチが落ちた」という質問は switch-offline タグの知見に文字 bigram では当たらない。
  // 調査タブはサイト選択という別の手掛かりがあるが、Coach は質問文しか持っていない。
  // そこで **話題キーが一致したら加点する**(履歴層の門と同じ語彙を使う)。
  // 無関係な質問では話題キーが 0 個になるので、加点は発火せず従来どおりの挙動になる。
  const approved = listByStatus("approved");
  const TOPIC_BONUS = 0.15;
  const kMatches = relevantEntries(
    approved,
    { query, site: null, platform: null, lang: opts.lang },
    0,
    approved.length,
  )
    .map((m) => {
      const shared = m.entry.tags.filter((t) => askTopics.has(t));
      const score = shared.length ? Math.min(1, m.score + TOPIC_BONUS) : m.score;
      const hits = shared.length ? [...m.hits, `topic=${shared.join("+")}`] : m.hits;
      return { entry: m.entry, score: Math.round(score * 1000) / 1000, hits };
    })
    .filter((m) => m.score >= opts.threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, KNOWLEDGE_LIMIT);
  for (const m of kMatches) out.push(knowledgeMaterial(m.entry, m.score, m.hits));

  // Layer B — 履歴には検索機構が無いので、ここで軽量に測る(埋め込み検索は使わない)。
  //
  // **話題キーの一致を必須の門にする。** 文字 bigram だけで測ると、日本語の定型部分
  // (「〜を教えてください」)が当たるだけで無関係な質問が履歴を拾う(実測済み。
  // 詳細は store.ts の DEFAULT_HISTORY_THRESHOLD のコメント)。
  // 順位付けは Dice 係数で行う(重なり係数と違い、短い質問 ⇄ 長い回答が当たりにくい)。
  const hMatches: CoachMaterial[] = [];
  if (askTopics.size > 0) {
    const history = (await listHistoryRecords()).filter(isTeachable);
    // 同じクエリ文の調査が何度も走っている(実測 152 件中 distinct 130)。
    // 同じ問いの記録を 3 件並べても教材にならないので、クエリ文で 1 件に畳む。
    const seenQuery = new Set<string>();
    for (const rec of history) {
      const shared = [...historyTopicKeys(rec)].filter((k) => askTopics.has(k));
      if (shared.length === 0) continue;
      const key = normalizeText(rec.query);
      if (seenQuery.has(key)) continue;
      // しきい値で落ちた場合も「この問いはもう見た」と印を付ける。後ろ(= 古い方)に
      // 同じ問いの記録が並んでいるので、印を付けないと同じ問いを何度も評価してしまう。
      seenQuery.add(key);
      const answer = rec.answer ?? rec.answerExcerpt ?? "";
      const q = textSimilarity(query, rec.query);
      const a = textSimilarity(query, answer.slice(0, 1200));
      const score = Math.round((0.8 * q + 0.2 * a) * 1000) / 1000;
      if (score < opts.historyThreshold) continue;
      hMatches.push(historyMaterial(rec, score, [`topic=${shared.join("+")}`, `query=${q.toFixed(2)}`]));
    }
  }
  hMatches.sort((x, y) => y.score + y.boost - (x.score + x.boost));
  out.push(...hMatches.slice(0, HISTORY_LIMIT));

  // Layer C — 語彙と一般論。**単独で主素材にはしない**が、当たれば必ず添える。
  const norm = normalizeText(query);
  const rMatches: CoachMaterial[] = [];
  for (const rule of RULES) {
    const { title, desc } = ruleText(rule, opts.lang);
    let score = 0;
    const hits: string[] = [];
    if (contains(norm, rule.id)) {
      score = 1;
      hits.push(`id=${rule.id}`);
    } else {
      const t = overlap(query, title);
      const d = desc ? overlap(query, desc) : 0;
      score = Math.round((0.6 * t + 0.4 * d) * 1000) / 1000;
      if (t >= 0.2) hits.push(`title=${t.toFixed(2)}`);
    }
    if (score < opts.threshold) continue;
    rMatches.push(ruleMaterial(rule, score, hits, opts.lang));
  }
  rMatches.sort((x, y) => y.score - x.score);
  out.push(...rMatches.slice(0, RULE_LIMIT));

  // 並べ替え: 層の優先(A → B → C)を守りつつ、層の中では score + boost + 弱点加点。
  // live(68 番)はここでは出てこない(collectMaterials は静的層だけを見る)が、
  // 呼び出し側が結合したあとに同じ比較関数を使うので順位を定義しておく。
  // **live は静的層より後ろ**にする。ユーザー決定の「過去の調査結果・ナレッジを優先し、
  // 薄い / 古い / 対象外のときにライブで補強する」がそのまま順位になる。
  const layerRank: Record<MaterialKind, number> = { knowledge: 0, history: 1, live: 2, rule: 3 };
  const weakBonus = (m: CoachMaterial) => (m.meta.tags.some((t) => weak.has(t)) ? 0.05 : 0);
  out.sort((a, b) => {
    if (layerRank[a.kind] !== layerRank[b.kind]) return layerRank[a.kind] - layerRank[b.kind];
    return b.score + b.boost + weakBonus(b) - (a.score + a.boost + weakBonus(a));
  });

  // 上限で切る。ただし**ルール層に必ず 1 枠残す**。
  // ルールは「一般論としてはこう推奨されている」を添える層で、
  // 自社の記録だけで枠が埋まると三段重ね(結論 + 手順 + 一般論)が作れなくなる。
  const max = Math.max(1, opts.max);
  let materials = out.slice(0, max);
  const topRule = out.find((m) => m.kind === "rule");
  if (topRule && max >= 2 && !materials.some((m) => m.kind === "rule")) {
    materials = [...materials.slice(0, max - 1), topRule];
  }
  const primaryLayer = materials.length ? materials[0].kind : null;
  const generalOnly = materials.length > 0 && materials.every((m) => m.kind === "rule");
  return { materials, primaryLayer, generalOnly, threshold: opts.threshold };
}

/** 教材適格な調査履歴のプール(クイズが使う)。 */
export async function teachableHistory(): Promise<QueryHistoryRecord[]> {
  return (await listHistoryRecords()).filter(isTeachable);
}

export { historyMaterial, knowledgeMaterial, ruleMaterial };
