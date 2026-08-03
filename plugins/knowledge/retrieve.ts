// ナレッジ(47)— 承認済みナレッジを次の調査プロンプトへ注入する。
//
// ---- 位置づけ ----
// 46 で「調査 → 知見候補 → 承認 → 蓄積」まで来た。ここはその出口で、
// 次の調査(手動 / 自動事前調査 / 定期実行のいずれも同じ runQuery を通る)の
// system prompt に「関連する既知の情報」を差し込み、Loop を閉じる。
//
// ---- マッチングの方針(指示の確定事項)----
// 埋め込み検索・ベクトル DB は使わない。46 の重複検出(similarity.ts)と同じ
// **文字 bigram + タグ + 対象の一致** という軽量な手法で測る。
// 違いは「候補 ⇄ 既存エントリ」ではなく「調査クエリ ⇄ 承認済みエントリ」を比べる点で、
// 入力の長さが極端に違う(クエリは 1 行、エントリの症状は数行)。
// そのため Dice 係数(長さの差で不利になる)ではなく **重なり係数**
// (|A∩B| / min(|A|,|B|))を使う。短い側がどれだけ相手に含まれるかを見る。
//
// ---- しきい値 ----
// 既定 0.3 / 上位 3 件。実データ(data/knowledge/entries.json の承認済み 4 件)で測った値:
//   「rogue ap アラームの脅威度を評価して」(サイト指定なし)  → 該当 2 件 0.535 / 0.513、無関係 0.06 未満
//   「3_HPEN_Osaka で rogue AP のアラートが出ている」        → 0.605 / 0.436、無関係 0.10 未満
//   「Check the roaming problem」(site=1_Kyobashi)          → Roaming SLE 0.662
//   「1_Kyobashi でローミングが不安定という申告があった」     → Roaming SLE 0.302(和文はタグが英語で当たりにくい)
//   「AP のファームウェア更新手順を教えて」                   → 全件 0.06 未満(注入なし)
//   「1_Kyobashi でオフラインの機器はある?」                 → 同サイトの 2 件が 0.271(注入なし)
//
// 最後の 1 件が 0.3 という数字の根拠でもある。対象加点はサイト一致 0.20 + プラットフォーム一致 0.05 =
// 最大 0.25 なので、**「同じサイトを見ている」だけでは決してしきい値に届かない**。
// 内容(タイトル / 症状 / タグ)が少しでも当たって初めて注入される。
// 0.2 まで下げるとこの性質が崩れて同サイトの無関係な知見がぶら下がり始め、
// 0.4 を超えると和文クエリ(タグが英語のエントリ)を取りこぼす。
//
// ---- 参照実績 ----
// 注入した時点で参照回数 +1 / 最終参照日時を更新する(store.recordReferences)。
// 「モデルの回答が実際にその知見に言及したか」で数えないのは、それが自然言語の
// パースになるため(CLAUDE.md: モデル出力を自然言語でパースする実装を作らない)。

import { bigrams, normalizeText } from "./similarity.js";
import { getSettings, listByStatus, recordReferences } from "./store.js";
import type { KnowledgeEntry, KnowledgeRef } from "./types.js";

export type RetrieveLang = "ja" | "en";

/** 注入の判断に使う「今からやる調査」の情報。runQuery が持っている値だけで足りる。 */
export interface RetrievalContext {
  /** 調査クエリ(自然文)。 */
  query: string;
  /** 対象サイト(未指定なら null)。 */
  site?: string | null;
  /** ルーティングで確定したプラットフォーム(両方使う場合は null)。 */
  platform?: "central" | "mist" | null;
  /** 回答言語。注入セクションの見出し・注意書きをこの言語で書く。 */
  lang?: RetrieveLang;
}

export interface KnowledgeMatch {
  entry: KnowledgeEntry;
  score: number;
  /** どの要素で当たったか(ログ・デバッグ用。画面には出さない)。 */
  hits: string[];
}

export interface KnowledgeInjection {
  /** system prompt の末尾に足す「関連する既知の情報」セクション。 */
  text: string;
  /** 注入したエントリ(SSE・調査履歴に載せる)。 */
  refs: KnowledgeRef[];
}

// ---- 関連度 ----

/** 重なり係数。短い側がどれだけ相手に含まれるか(0〜1)。 */
function overlap(a: string, b: string): number {
  const A = bigrams(normalizeText(a));
  const B = bigrams(normalizeText(b));
  if (A.size === 0 || B.size === 0) return 0;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  let inter = 0;
  for (const g of small) if (large.has(g)) inter += 1;
  return inter / small.size;
}

/** 文字列 needle が正規化済みテキストに含まれるか(全角半角・大小・記号の揺れを吸収済み)。 */
function contains(haystackNorm: string, needle: string | null | undefined): boolean {
  const n = normalizeText(needle ?? "");
  // 1 文字のタグ・機器名は誤爆するので見ない。
  return n.length >= 2 && haystackNorm.includes(n);
}

/**
 * タグの当たり具合(0〜1)。
 * タグは 5〜8 個付くうえ英語表記が混ざるため、「全タグ中の何割」で測ると
 * 日本語クエリではほぼ 0 になる。1 個当たれば 0.6、2 個以上で 1.0 とする。
 */
function tagScore(tags: string[], queryNorm: string): { score: number; hit: string[] } {
  const hit = tags.filter((t) => contains(queryNorm, t));
  if (hit.length === 0) return { score: 0, hit };
  return { score: hit.length >= 2 ? 1 : 0.6, hit };
}

/**
 * 調査クエリとナレッジ 1 件の関連度(0〜1)。
 *
 * 重み:
 *   タイトル 0.45 … 「何の問題か」を一番よく表す
 *   症状     0.20 … タイトルの言い回しが違っても症状で拾う
 *   タグ     0.35 … 短い語の一致は日本語クエリでも効きやすい
 *   + 対象加点: 同じサイト 0.20 / 機器名がクエリに出てくる 0.15 / 同じプラットフォーム 0.05
 *
 * サイト固有(scope="site")の知見を、別サイトの調査に持ち込まないようにするのは
 * relevantEntries() 側の除外規則で担保する(スコアの加減では漏れるため)。
 */
export function relevance(entry: KnowledgeEntry, ctx: RetrievalContext): KnowledgeMatch {
  const query = ctx.query || "";
  // サイト名は「クエリ本文には出てこないがサイト選択で指定されている」ことが多いので、
  // テキスト照合の対象にはクエリ + サイト名を使う。
  const haystack = ctx.site ? `${query} ${ctx.site}` : query;
  const queryNorm = normalizeText(haystack);
  const hits: string[] = [];

  const title = overlap(haystack, entry.title);
  if (title >= 0.3) hits.push(`title=${title.toFixed(2)}`);
  const symptom = entry.symptom ? overlap(haystack, entry.symptom) : 0;
  if (symptom >= 0.3) hits.push(`symptom=${symptom.toFixed(2)}`);
  const tags = tagScore(entry.tags, queryNorm);
  if (tags.hit.length) hits.push(`tags=${tags.hit.join("+")}`);

  let bonus = 0;
  const siteMatch =
    !!entry.site &&
    ((!!ctx.site && normalizeText(entry.site) === normalizeText(ctx.site)) || contains(queryNorm, entry.site));
  if (siteMatch) {
    bonus += 0.2;
    hits.push(`site=${entry.site}`);
  }
  if (entry.device && contains(queryNorm, entry.device)) {
    bonus += 0.15;
    hits.push(`device=${entry.device}`);
  }
  if (ctx.platform && entry.platform && (entry.platform === ctx.platform || entry.platform === "both")) {
    bonus += 0.05;
    hits.push(`platform=${entry.platform}`);
  }

  const score = Math.min(1, 0.45 * title + 0.2 * symptom + 0.35 * tags.score + bonus);
  return { entry, score: Math.round(score * 1000) / 1000, hits };
}

/**
 * 承認済みナレッジの中から、この調査に関連しそうなものを上位 limit 件返す。
 *
 * 除外規則: サイト固有(scope="site")の知見は、対象サイトが分かっていて
 * それが別サイトなら候補にしない。「1_Kyobashi の構成に紐づく知見」を
 * 3_HPEN_Osaka の調査に持ち込むと、モデルが現地の事実と取り違える。
 */
export function relevantEntries(
  pool: KnowledgeEntry[],
  ctx: RetrievalContext,
  threshold: number,
  limit: number,
): KnowledgeMatch[] {
  const site = (ctx.site || "").trim();
  const out: KnowledgeMatch[] = [];
  for (const entry of pool) {
    if (entry.scope === "site" && entry.site && site && normalizeText(entry.site) !== normalizeText(site)) {
      continue;
    }
    const m = relevance(entry, ctx);
    if (m.score >= threshold) out.push(m);
  }
  out.sort((a, b) => b.score - a.score || (a.entry.createdAt < b.entry.createdAt ? 1 : -1));
  return out.slice(0, Math.max(1, limit));
}

// ---- プロンプトに載せる文面 ----
//
// 「簡潔に」(指示 Task 2-2)。出典の調査結果本文は載せず、4 項目の要点だけにする。
// 1 項目あたりの上限を切り、セクション全体でも上限を切る(コンテキストを圧迫しないため)。

const FIELD_MAX = 220;
const SECTION_MAX = 2400;

function clip(s: string, max = FIELD_MAX): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const HEADER: Record<RetrieveLang, string> = {
  ja:
    "【関連する既知の情報(過去の調査から人が承認したナレッジ)】\n" +
    "以下は今回のクエリに関連しそうな既知の知見。調べる観点の当たりを付けるために使ってよい。\n" +
    "- ただし **現在の状態は必ず MCP ツールで確認する**。ナレッジは過去の記録であって、今の事実ではない。\n" +
    "- ツールの結果とナレッジが食い違う場合は、必ずツールの結果を優先する。\n" +
    "- 参考にした場合だけ、回答の中でどの知見を踏まえたかを一言添える。関係が無ければ触れない。\n" +
    "- ナレッジは生成時の言語のまま載せている。回答は指示された言語で書く。",
  en:
    "[Related known information — knowledge entries approved by a human from past investigations]\n" +
    "The entries below may relate to this query. Use them to decide where to look first.\n" +
    "- Always confirm the CURRENT state with the MCP tools. These are past records, not present facts.\n" +
    "- When the tool results and an entry disagree, the tool results always win.\n" +
    "- Mention which entry you relied on only if you actually used it; say nothing if none applied.\n" +
    "- Entries are kept in the language they were written in. Answer in the language you were told to use.",
};

const FIELD_LABEL: Record<RetrieveLang, { symptom: string; rootCause: string; action: string; target: string }> = {
  ja: { symptom: "症状", rootCause: "根本原因", action: "対処", target: "対象" },
  en: { symptom: "Symptom", rootCause: "Root cause", action: "Action", target: "Scope" },
};

function targetLine(entry: KnowledgeEntry, lang: RetrieveLang): string {
  const parts: string[] = [];
  if (entry.site) parts.push(lang === "ja" ? `サイト=${entry.site}` : `site=${entry.site}`);
  if (entry.device) parts.push(lang === "ja" ? `機器=${entry.device}` : `device=${entry.device}`);
  if (entry.platform) parts.push(`platform=${entry.platform}`);
  if (entry.tags.length) parts.push(entry.tags.map((t) => `#${t}`).join(" "));
  return parts.join(" / ");
}

/** マッチしたナレッジを「関連する既知の情報」セクションのテキストにする。 */
export function buildSection(matches: KnowledgeMatch[], lang: RetrieveLang = "ja"): string {
  if (matches.length === 0) return "";
  const l: RetrieveLang = lang === "en" ? "en" : "ja";
  const label = FIELD_LABEL[l];
  const lines: string[] = [HEADER[l]];
  matches.forEach((m, i) => {
    const e = m.entry;
    const body: string[] = [`${i + 1}. ${clip(e.title, 160)}`];
    if (e.symptom) body.push(`   - ${label.symptom}: ${clip(e.symptom)}`);
    if (e.rootCause) body.push(`   - ${label.rootCause}: ${clip(e.rootCause)}`);
    if (e.action) body.push(`   - ${label.action}: ${clip(e.action)}`);
    const target = targetLine(e, l);
    if (target) body.push(`   - ${label.target}: ${target}`);
    lines.push(body.join("\n"));
  });
  const text = lines.join("\n");
  return text.length > SECTION_MAX ? `${text.slice(0, SECTION_MAX)}…` : text;
}

// ---- 入口(調査の実行経路から呼ばれる)----

/**
 * この調査に注入するナレッジを決め、セクション本文と参照記録を返す。
 * 該当が無ければ null(呼び出し側は従来どおり注入なしで実行する)。
 *
 * 参照実績の更新はここで行う(= 注入したものが必ず 1 回数えられる)。
 * 保存は待たずに投げっぱなしにはせず await するが、失敗しても throw しない
 * (store.recordReferences 側で握り潰している)。
 */
export async function buildInjection(ctx: RetrievalContext): Promise<KnowledgeInjection | null> {
  const settings = getSettings();
  if (!settings.inject.enabled) return null;
  const query = (ctx.query || "").trim();
  if (!query) return null;

  const approved = listByStatus("approved");
  if (approved.length === 0) return null;

  const matches = relevantEntries(approved, ctx, settings.inject.threshold, settings.inject.maxEntries);
  if (matches.length === 0) return null;

  const lang: RetrieveLang = ctx.lang === "en" ? "en" : "ja";
  const text = buildSection(matches, lang);
  if (!text) return null;

  const refs: KnowledgeRef[] = matches.map((m) => ({ id: m.entry.id, title: m.entry.title, score: m.score }));
  await recordReferences(refs.map((r) => r.id));

  console.log(
    `[knowledge] 調査プロンプトへナレッジを ${refs.length} 件注入: ` +
      matches.map((m) => `"${m.entry.title.slice(0, 30)}"(${m.score} ${m.hits.join(" ")})`).join(" / "),
  );
  return { text, refs };
}

/** 注入せずに「何がマッチするか」だけを見る(動作確認用の API から使う)。 */
export function previewMatches(ctx: RetrievalContext): {
  threshold: number;
  limit: number;
  enabled: boolean;
  matches: Array<{ id: string; title: string; score: number; hits: string[] }>;
} {
  const settings = getSettings();
  const matches = relevantEntries(
    listByStatus("approved"),
    ctx,
    settings.inject.threshold,
    settings.inject.maxEntries,
  );
  return {
    threshold: settings.inject.threshold,
    limit: settings.inject.maxEntries,
    enabled: settings.inject.enabled,
    matches: matches.map((m) => ({ id: m.entry.id, title: m.entry.title, score: m.score, hits: m.hits })),
  };
}
