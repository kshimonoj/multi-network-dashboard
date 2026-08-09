// ナレッジ(71)— 承認済みナレッジとの重複判定。
//
// ---- なぜ LLM で判定するか ----
// 46 の重複検出は文字 bigram の一致度(similarity.ts の score())だけで判断していた。
// 実データで測ると、この値では「同じ知見の言い換え」と「別の事象」の帯が重なる:
//
//   同じ知見(rogue AP の切り分け手順を別々の調査から抽出)  … 0.25〜0.38
//   別の事象(スイッチ全断 ⇄ 仮想ラボ一括再起動)            … 0.32
//
// 1 本のしきい値では切れない。下げれば別事象を潰し、上げれば重複を通す。
// 日本語は語順・助詞・言い回しの自由度が高く、同義の 2 文が文字レベルでは
// ほとんど重ならないため(英文候補と和文エントリなら bigram はゼロになる)。
//
// そこで役割を分けた:
//   similarity.ts shortlistSimilar()  … 再現率だけを見て相手を数件に絞る(無料)
//   ここ                              … 絞った相手と同じ知見かを LLM が判定する
//
// LLM 呼び出しは「絞り込みで相手が 1 件でも残った候補がある」ときだけ 1 回。
// 候補が全部新規(タグも文面も既存とかすりもしない)なら呼ばない。
//
// ---- 失敗時の振る舞い ----
// LLM が落ちた / 応答が壊れていた場合は **46 の挙動へ縮退する**
// (一致度がしきい値以上なら related = マージ提案、それ以外は new)。
// 判定できないことを理由に候補を握り潰さない。取りこぼしより誤った抹消の方が高くつく。
//
// ---- CLAUDE.md との整合 ----
// モデルの出力は自然言語でパースしない。判定は JSON の列挙値
// ("duplicate" / "related" / "new")と参照キー("K3")だけを読み、
// 参照キーは **その候補の絞り込み結果に実在するものだけ** を採用する。

import { shortlistSimilar, type ShortlistHit } from "./similarity.js";
import { extractJsonObject, runClaudePlain } from "./llm.js";
import type { KnowledgeEntry } from "./types.js";

export type DedupeLang = "ja" | "en";

/**
 * 候補と承認済みエントリの関係。
 *   duplicate … 既に承認済みの知見と同じことを言っている(候補にしない)
 *   related   … 関連はするが別の知見(候補として出し、マージ提案を添える)
 *   new       … 新規
 */
export type DuplicateRelation = "duplicate" | "related" | "new";

export interface DuplicateVerdict {
  candidateId: string;
  relation: DuplicateRelation;
  /** duplicate / related のときの相手(承認済みエントリの id)。 */
  targetId: string | null;
  /** 相手のタイトル(画面・ログ用)。 */
  targetTitle: string | null;
  /** 絞り込み時の一致度(参考値。判定そのものには使っていない)。 */
  score: number;
  /** 判定の出どころ。lexical は LLM を使わなかった / 使えなかった場合。 */
  by: "llm" | "lexical" | "none";
  /**
   * 「既存に無い要素」としてモデルが挙げたもの(related のときだけ埋まる)。
   *
   * これは **判定を強制するための出力** であって、判定材料としては読まない
   * (自然言語をパースして分岐しない、という CLAUDE.md の方針)。relation は
   * あくまで列挙値だけを見て決めている。ここはサーバのログに出して、
   * 判定が渋い / 甘いときに原因を追えるようにするためだけに持つ。
   */
  novelty: string;
}

export interface JudgeOptions {
  lang?: DedupeLang;
  model: string;
  /** false なら LLM を呼ばず、一致度だけで判定する(46 の挙動)。 */
  useLlm?: boolean;
  /** related と見なす一致度(= settings.similarityThreshold)。 */
  relatedThreshold: number;
  /** 絞り込みで 1 候補あたり何件まで LLM に見せるか。 */
  shortlistMax?: number;
}

export interface JudgeResult {
  verdicts: Map<string, DuplicateVerdict>;
  /** 実際に走らせた LLM 呼び出しの回数(0 なら絞り込みで全部片付いた)。 */
  llmCalls: number;
  /** LLM が使えなかった場合の理由(縮退したことを呼び出し側がログに残せるように)。 */
  error: string | null;
}

/** 1 回の LLM 呼び出しに載せる候補の数(プロンプトが膨らみすぎないように)。 */
const BATCH = 8;

/** プロンプトに載せる 1 項目の上限。判定に要るのは要点だけ。 */
const FIELD_MAX = 200;

function clip(s: string, max = FIELD_MAX): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const SYSTEM_PROMPT: Record<DedupeLang, string> = {
  ja:
    "あなたはネットワーク運用チームのナレッジ管理者。新しく抽出された知見候補が、\n" +
    "既に承認済みのナレッジと **同じことを言っているか** を判定する。\n" +
    "\n" +
    "【厳守】\n" +
    "- 出力は JSON オブジェクト 1 個のみ。前置き・後書き・コードフェンス(```)・説明文を付けない。\n" +
    "- relation は duplicate / related / new のいずれか。英語の小文字のまま返す。\n" +
    "- existing には、その候補に提示された参照キー(K1 等)だけを書く。提示されていないキーを作らない。\n" +
    "- 候補とナレッジは日本語・英語が混ざる。**言語が違っても内容が同じなら duplicate** とする。\n" +
    "\n" +
    "【判定の手順】\n" +
    "候補ごとに、まず novelty(既存エントリに書かれていない要素)を一言で書く。\n" +
    "「既存を読んで済ませた運用者が、この候補を読むことで **新しく取れるようになる行動** は何か」だけを見る。\n" +
    "言い方が丁寧・具体的になっただけ、手順の番号が増えただけ、例に挙げた機器やサイトが違うだけ、\n" +
    "は novelty ではない。その場合 novelty は空文字にする。\n" +
    "\n" +
    "【判定基準】\n" +
    "- duplicate: novelty が空。症状・根本原因・対処が同じ筋なら、言い回しや粒度が違っても duplicate。\n" +
    "  同じ事象を別の日・別のサイト・別のプラットフォームで調査しただけのものも duplicate。\n" +
    "- related: novelty を具体的に書けた(既存に無い切り分け軸・原因・対処が実際に含まれる)。\n" +
    "- new: 既存のどれとも別の話。\n" +
    "\n" +
    "novelty を書けないのに related にしない。**判断に迷う程度に似ているなら duplicate** にする\n" +
    "(統合しても既存の本文は変わらず、候補は統合済みとして残るので、取り違えても取り返しがつく)。\n" +
    "\n" +
    "【duplicate にしてはいけない場合】\n" +
    "- 候補の「対処」が、既存の「対処」とは **別の操作** を指している\n" +
    "  (例: 既存が「一覧を個別に確認する」、候補が「設定を再同期する」→ 別の知見)。\n" +
    "- 既存エントリが **例として名前を挙げているだけ** の事象について、候補がその事象そのものの\n" +
    "  原因・対処を述べている(同じ固有名詞が出てくるだけで同じ知見とは限らない)。\n" +
    "この 2 つに当てはまるものは、文面がどれだけ似ていても duplicate ではない。\n" +
    "\n" +
    "出力する JSON の形:\n" +
    '{"verdicts":[{"candidate":"C1","novelty":"","relation":"duplicate","existing":"K2"}]}\n' +
    "relation が new のときは existing に null を入れる。候補は全件返す。",
  en:
    "You are the knowledge curator for a network operations team. Decide whether each newly extracted\n" +
    "candidate says the **same thing** as an already-approved knowledge entry.\n" +
    "\n" +
    "[Strict rules]\n" +
    "- Output exactly one JSON object. No preamble, no trailing prose, no code fences, no explanation.\n" +
    "- `relation` is one of duplicate / related / new, returned as lowercase English.\n" +
    "- `existing` must be one of the reference keys offered for that candidate (K1, …). Never invent a key.\n" +
    "- Candidates and entries mix Japanese and English. **Different language, same content = duplicate.**\n" +
    "\n" +
    "[Procedure]\n" +
    "For each candidate, first write `novelty`: in one phrase, what this candidate contains that the\n" +
    "existing entry does not. Judge only by **what the reader could newly do** having already read the\n" +
    "existing entry. Being phrased more politely, more specifically, having more numbered steps, or\n" +
    "naming a different example device or site is NOT novelty — leave `novelty` empty in that case.\n" +
    "\n" +
    "[Criteria]\n" +
    "- duplicate: `novelty` is empty. Same symptom, root cause and action reasoning counts as duplicate\n" +
    "  even when the wording or level of detail differs. The same phenomenon investigated on another\n" +
    "  day, another site or the other platform is also a duplicate.\n" +
    "- related: you could write a concrete `novelty` (a triage angle, cause or action the entry lacks).\n" +
    "- new: unrelated to any of the entries offered.\n" +
    "\n" +
    "Never choose related without being able to write `novelty`. **When the two are close enough that\n" +
    "you hesitate, choose duplicate** (merging leaves the approved text untouched and keeps the\n" +
    "candidate as merged, so the call is reversible).\n" +
    "\n" +
    "[Never duplicate when]\n" +
    "- The candidate's action points at a **different operation** than the entry's action\n" +
    "  (entry: \"check the alert list one by one\" vs candidate: \"re-sync the config\" → different insight).\n" +
    "- The entry only **names the phenomenon as an example**, while the candidate explains that\n" +
    "  phenomenon's own cause and fix (sharing a proper noun does not make them the same insight).\n" +
    "Neither of these is a duplicate, however similar the wording looks.\n" +
    "\n" +
    "Shape of the JSON to output:\n" +
    '{"verdicts":[{"candidate":"C1","novelty":"","relation":"duplicate","existing":"K2"}]}\n' +
    "Use null for `existing` when relation is new. Return a verdict for every candidate.",
};

interface Batch {
  /** C1, C2, … → 候補 */
  candidates: Array<{ key: string; entry: KnowledgeEntry; hits: ShortlistHit[] }>;
  /** K1, K2, … → 承認済みエントリ(バッチ内で共有する参照表) */
  known: Map<string, KnowledgeEntry>;
  /** 承認済みエントリ id → 参照キー */
  keyOf: Map<string, string>;
}

function entryLines(e: KnowledgeEntry, lang: DedupeLang): string[] {
  const l = lang === "en" ? "en" : "ja";
  const label =
    l === "ja"
      ? { symptom: "症状", rootCause: "根本原因", action: "対処", tags: "タグ", target: "対象" }
      : { symptom: "Symptom", rootCause: "Root cause", action: "Action", tags: "Tags", target: "Scope" };
  const out: string[] = [];
  if (e.symptom) out.push(`   ${label.symptom}: ${clip(e.symptom)}`);
  if (e.rootCause) out.push(`   ${label.rootCause}: ${clip(e.rootCause)}`);
  if (e.action) out.push(`   ${label.action}: ${clip(e.action)}`);
  if (e.tags.length) out.push(`   ${label.tags}: ${e.tags.join(", ")}`);
  const target = [e.site ? `site=${e.site}` : "", e.device ? `device=${e.device}` : ""]
    .filter(Boolean)
    .join(" / ");
  if (target) out.push(`   ${label.target}: ${target}`);
  return out;
}

export function buildJudgePrompt(batch: Batch, lang: DedupeLang): string {
  const l = lang === "en" ? "en" : "ja";
  const head =
    l === "ja"
      ? "【承認済みナレッジ(参照表)】\n"
      : "[Approved knowledge entries — reference table]\n";
  const lines: string[] = [head];
  for (const [key, e] of batch.known) {
    lines.push(`${key}. ${clip(e.title, 160)}`);
    lines.push(...entryLines(e, l));
  }
  lines.push("");
  lines.push(l === "ja" ? "【判定する候補】" : "[Candidates to judge]");
  for (const c of batch.candidates) {
    const keys = c.hits.map((h) => batch.keyOf.get(h.entry.id)).filter(Boolean).join(", ");
    lines.push(
      `${c.key}. ${clip(c.entry.title, 160)}` +
        (l === "ja" ? `  (比較対象: ${keys})` : `  (compare against: ${keys})`),
    );
    lines.push(...entryLines(c.entry, l));
  }
  lines.push("");
  lines.push(
    l === "ja"
      ? "各候補について relation を判定し、JSON を出力してください。"
      : "Judge the relation of each candidate and output the JSON.",
  );
  return lines.join("\n");
}

function relationOf(v: unknown): DuplicateRelation | null {
  const s = String(v ?? "").toLowerCase().trim();
  return s === "duplicate" || s === "related" || s === "new" ? s : null;
}

/** 一致度だけで決める縮退版(LLM を使わない / 使えなかったとき)。46 の挙動と同じ。 */
function lexicalVerdict(
  entry: KnowledgeEntry,
  hits: ShortlistHit[],
  relatedThreshold: number,
  by: DuplicateVerdict["by"],
): DuplicateVerdict {
  const top = hits.find((h) => h.score >= relatedThreshold) ?? null;
  return {
    candidateId: entry.id,
    relation: top ? "related" : "new",
    targetId: top?.entry.id ?? null,
    targetTitle: top?.entry.title ?? null,
    score: top?.score ?? hits[0]?.score ?? 0,
    by,
    novelty: "",
  };
}

/**
 * 候補群を承認済みエントリ群と突き合わせ、1 件ずつ関係を判定する。
 * throw しない(判定できなければ縮退した結果を返す)。
 */
export async function judgeAgainstApproved(
  candidates: KnowledgeEntry[],
  approved: KnowledgeEntry[],
  opts: JudgeOptions,
): Promise<JudgeResult> {
  const lang: DedupeLang = opts.lang === "en" ? "en" : "ja";
  const verdicts = new Map<string, DuplicateVerdict>();
  const result: JudgeResult = { verdicts, llmCalls: 0, error: null };
  if (candidates.length === 0) return result;

  // ---- 絞り込み(無料)----
  const shortlists = new Map<string, ShortlistHit[]>();
  for (const c of candidates) {
    shortlists.set(
      c.id,
      approved.length === 0 ? [] : shortlistSimilar(c, approved, { limit: opts.shortlistMax ?? 5 }),
    );
  }

  // 相手が 1 件も無い候補は、それだけで新規と言い切れる(LLM に見せる意味が無い)。
  const needsJudge: KnowledgeEntry[] = [];
  for (const c of candidates) {
    const hits = shortlists.get(c.id) ?? [];
    if (hits.length === 0) {
      verdicts.set(c.id, {
        candidateId: c.id,
        relation: "new",
        targetId: null,
        targetTitle: null,
        score: 0,
        by: "none",
        novelty: "",
      });
      continue;
    }
    needsJudge.push(c);
  }
  if (needsJudge.length === 0) return result;

  if (opts.useLlm === false) {
    for (const c of needsJudge) {
      verdicts.set(c.id, lexicalVerdict(c, shortlists.get(c.id) ?? [], opts.relatedThreshold, "lexical"));
    }
    return result;
  }

  // ---- LLM 判定 ----
  for (let i = 0; i < needsJudge.length; i += BATCH) {
    const slice = needsJudge.slice(i, i + BATCH);
    const known = new Map<string, KnowledgeEntry>();
    const keyOf = new Map<string, string>();
    const batch: Batch = { candidates: [], known, keyOf };
    for (const c of slice) {
      const hits = shortlists.get(c.id) ?? [];
      for (const h of hits) {
        if (!keyOf.has(h.entry.id)) {
          const key = `K${keyOf.size + 1}`;
          keyOf.set(h.entry.id, key);
          known.set(key, h.entry);
        }
      }
      batch.candidates.push({ key: `C${batch.candidates.length + 1}`, entry: c, hits });
    }

    const res = await runClaudePlain(buildJudgePrompt(batch, lang), SYSTEM_PROMPT[lang], opts.model);
    result.llmCalls += 1;
    const parsed = res.isError ? null : extractJsonObject(res.text);
    const rows: unknown[] = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
    if (!parsed || rows.length === 0) {
      result.error =
        res.reason ?? `応答を JSON として解釈できませんでした(先頭 200 文字: ${res.text.slice(0, 200)})`;
      for (const c of slice) {
        verdicts.set(c.id, lexicalVerdict(c, shortlists.get(c.id) ?? [], opts.relatedThreshold, "lexical"));
      }
      continue;
    }

    const byKey = new Map(batch.candidates.map((c) => [c.key, c]));
    const seen = new Set<string>();
    for (const raw of rows) {
      const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const c = byKey.get(String(r.candidate ?? "").trim());
      const relation = relationOf(r.relation);
      if (!c || !relation) continue;
      // existing は「その候補に提示した相手」の中にあるものだけを採用する。
      const allowed = new Set(c.hits.map((h) => keyOf.get(h.entry.id)));
      const key = String(r.existing ?? "").trim();
      const target = allowed.has(key) ? (known.get(key) ?? null) : null;
      const hit = target ? c.hits.find((h) => h.entry.id === target.id) : null;
      // duplicate / related には必ず相手が要る。相手が引けなければ new に倒す
      // (相手不明のまま握り潰さない)。
      const safe: DuplicateRelation = relation === "new" || target ? relation : "new";
      verdicts.set(c.entry.id, {
        candidateId: c.entry.id,
        relation: safe,
        targetId: safe === "new" ? null : (target?.id ?? null),
        targetTitle: safe === "new" ? null : (target?.title ?? null),
        score: hit?.score ?? 0,
        by: "llm",
        novelty: String(r.novelty ?? "").trim().slice(0, 160),
      });
      seen.add(c.key);
    }
    // 返ってこなかった候補は縮退で埋める(黙って落とさない)。
    for (const c of batch.candidates) {
      if (seen.has(c.key)) continue;
      verdicts.set(c.entry.id, lexicalVerdict(c.entry, c.hits, opts.relatedThreshold, "lexical"));
    }
  }

  return result;
}
