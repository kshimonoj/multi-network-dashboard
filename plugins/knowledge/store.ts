// ナレッジ(46)— 設定・永続化。
//
// 置き場(data/ 配下。イメージを作り直しても消えない):
//   data/knowledge/settings.json   … 抽出の有効/無効・対象経路・モデル・しきい値
//   data/knowledge/entries.json    … 候補と承認済みナレッジ(1 ファイル)
//   data/knowledge/extracted.json  … 抽出済み runId(同じ調査から二重に候補を作らないため)
//
// エントリは数十〜数百件を想定しているので、日付で分けず 1 ファイルにまとめる
// (レポートの日次 JSON と違い、全件を横断検索・タグ絞り込みするのが常なので分割の利が無い)。
// 書き込みは既存プラグインと同じ「一時ファイル → rename」(書き込み途中を読ませない)。

import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type {
  ExtractionLogEntry,
  KnowledgeEntry,
  KnowledgeSettings,
  KnowledgeSource,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR =
  process.env.KNOWLEDGE_DATA_DIR || path.resolve(__dirname, "../../data/knowledge");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const ENTRIES_PATH = path.join(DATA_DIR, "entries.json");
const EXTRACTED_PATH = path.join(DATA_DIR, "extracted.json");

const ENTRIES_VERSION = 1;

/** 抽出の記録は現況把握用なので直近だけ持つ(永続化しない)。 */
const LOG_MAX = 50;

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? Math.floor(v) : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function clampFloat(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/;

const DEFAULT_SETTINGS: KnowledgeSettings = {
  enabled: String(process.env.KNOWLEDGE_EXTRACT_ENABLED ?? "1") !== "0",
  // 既定では手動調査と自動事前調査(Webhook / レポート由来)を対象にする。
  // 定期実行(scheduled)は「毎日同じ観点で全サイトを見る」定点観測で、同じ知見が
  // 毎日出て承認待ちが埋まるため既定では対象外にしてある。
  sources: {
    manual: String(process.env.KNOWLEDGE_SOURCE_MANUAL ?? "1") !== "0",
    auto: String(process.env.KNOWLEDGE_SOURCE_AUTO ?? "1") !== "0",
    scheduled: String(process.env.KNOWLEDGE_SOURCE_SCHEDULED ?? "0") !== "0",
  },
  model: null,
  minAnswerChars: clampInt(process.env.KNOWLEDGE_MIN_ANSWER_CHARS, 0, 5000, 200),
  maxPerRun: clampInt(process.env.KNOWLEDGE_MAX_PER_RUN, 1, 5, 2),
  // 既定 0.35 は実データで測って決めた(46 の動作確認)。
  // 同じ rogue_ap アラートを別々に調査した 2 件 = 0.42 / まったく別の事象(AP オフライン)= 0.04。
  // 言い回しが変わると 0.5 では取りこぼすが、0.3 を切ると無関係な組も拾い始める。
  similarityThreshold: clampFloat(process.env.KNOWLEDGE_SIMILARITY_THRESHOLD, 0.1, 0.99, 0.35),
  // 47: 調査プロンプトへの注入。既定 3 件 / しきい値 0.3 の根拠は retrieve.ts の冒頭に書いた。
  inject: {
    enabled: String(process.env.KNOWLEDGE_INJECT_ENABLED ?? "1") !== "0",
    maxEntries: clampInt(process.env.KNOWLEDGE_INJECT_MAX, 1, 5, 3),
    threshold: clampFloat(process.env.KNOWLEDGE_INJECT_THRESHOLD, 0.05, 0.99, 0.3),
  },
  // 71: 承認済みとの重複判定。既定で LLM 判定を使い、duplicate は候補にしない。
  // 一致度だけの 46 の挙動に戻したい場合は KNOWLEDGE_DEDUPE_LLM=0。
  dedupe: {
    llm: String(process.env.KNOWLEDGE_DEDUPE_LLM ?? "1") !== "0",
    shortlistMax: clampInt(process.env.KNOWLEDGE_DEDUPE_SHORTLIST_MAX, 1, 10, 5),
    suppressDuplicates: String(process.env.KNOWLEDGE_DEDUPE_SUPPRESS ?? "1") !== "0",
  },
};

let settings: KnowledgeSettings = { ...DEFAULT_SETTINGS };

// ---- 同一ファイルへの同時書き込みを直列化する(reports/store.ts と同じ) ----

const writeChains = new Map<string, Promise<unknown>>();

export async function atomicWrite(file: string, data: string): Promise<void> {
  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev.then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, data, "utf-8");
    await rename(tmp, file);
  });
  writeChains.set(
    file,
    next.catch(() => undefined),
  );
  return next;
}

// ---- 設定 ----

export function normalizeSettings(
  raw: unknown,
  base: KnowledgeSettings = DEFAULT_SETTINGS,
): KnowledgeSettings {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (p.sources && typeof p.sources === "object" ? p.sources : {}) as Record<string, unknown>;
  const inj = (p.inject && typeof p.inject === "object" ? p.inject : {}) as Record<string, unknown>;
  const ded = (p.dedupe && typeof p.dedupe === "object" ? p.dedupe : {}) as Record<string, unknown>;
  const model =
    typeof p.model === "string" && p.model.trim() && MODEL_RE.test(p.model.trim())
      ? p.model.trim()
      : p.model === null || p.model === ""
        ? null
        : base.model;
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : base.enabled,
    sources: {
      manual: typeof s.manual === "boolean" ? s.manual : base.sources.manual,
      auto: typeof s.auto === "boolean" ? s.auto : base.sources.auto,
      scheduled: typeof s.scheduled === "boolean" ? s.scheduled : base.sources.scheduled,
    },
    model,
    minAnswerChars:
      p.minAnswerChars === undefined
        ? base.minAnswerChars
        : clampInt(p.minAnswerChars, 0, 5000, base.minAnswerChars),
    maxPerRun: p.maxPerRun === undefined ? base.maxPerRun : clampInt(p.maxPerRun, 1, 5, base.maxPerRun),
    similarityThreshold:
      p.similarityThreshold === undefined
        ? base.similarityThreshold
        : clampFloat(p.similarityThreshold, 0.1, 0.99, base.similarityThreshold),
    inject: {
      enabled: typeof inj.enabled === "boolean" ? inj.enabled : base.inject.enabled,
      maxEntries:
        inj.maxEntries === undefined
          ? base.inject.maxEntries
          : clampInt(inj.maxEntries, 1, 5, base.inject.maxEntries),
      threshold:
        inj.threshold === undefined
          ? base.inject.threshold
          : clampFloat(inj.threshold, 0.05, 0.99, base.inject.threshold),
    },
    dedupe: {
      llm: typeof ded.llm === "boolean" ? ded.llm : base.dedupe.llm,
      shortlistMax:
        ded.shortlistMax === undefined
          ? base.dedupe.shortlistMax
          : clampInt(ded.shortlistMax, 1, 10, base.dedupe.shortlistMax),
      suppressDuplicates:
        typeof ded.suppressDuplicates === "boolean"
          ? ded.suppressDuplicates
          : base.dedupe.suppressDuplicates,
    },
  };
}

export function getSettings(): KnowledgeSettings {
  return {
    ...settings,
    sources: { ...settings.sources },
    inject: { ...settings.inject },
    dedupe: { ...settings.dedupe },
  };
}

export async function loadSettings(): Promise<KnowledgeSettings> {
  try {
    settings = normalizeSettings(JSON.parse(await readFile(SETTINGS_PATH, "utf-8")));
    console.log(
      `[knowledge] settings.json を復元: 抽出=${settings.enabled ? "有効" : "無効"} ` +
        `対象=[${Object.entries(settings.sources)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(", ")}] ` +
        `1 調査あたり最大 ${settings.maxPerRun} 件 / 類似しきい値 ${settings.similarityThreshold} / ` +
        `プロンプト注入=${settings.inject.enabled ? "有効" : "無効"}` +
        `(最大 ${settings.inject.maxEntries} 件 / しきい値 ${settings.inject.threshold})`,
    );
  } catch {
    settings = { ...DEFAULT_SETTINGS };
    console.log("[knowledge] settings.json がありません。既定で始めます。");
  }
  return getSettings();
}

export async function saveSettings(patch: unknown): Promise<KnowledgeSettings> {
  settings = normalizeSettings(patch, settings);
  await atomicWrite(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  return getSettings();
}

// ---- エントリ(候補 + 承認済み)----

interface EntriesFile {
  version: number;
  entries: KnowledgeEntry[];
}

let entries: KnowledgeEntry[] = [];

function isEntry(v: unknown): v is KnowledgeEntry {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as KnowledgeEntry).id === "string" &&
    typeof (v as KnowledgeEntry).title === "string"
  );
}

/**
 * 47 で足した項目(参照回数・最終参照日時)を、46 以前に作られたエントリにも補う。
 * 保存側は常に値を持つので、これは読み込み時 1 回だけの後方互換処理。
 */
function withDefaults(e: KnowledgeEntry): KnowledgeEntry {
  return {
    ...e,
    refCount: typeof e.refCount === "number" && Number.isFinite(e.refCount) ? e.refCount : 0,
    lastReferencedAt: typeof e.lastReferencedAt === "string" ? e.lastReferencedAt : null,
  };
}

export async function loadEntries(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(ENTRIES_PATH, "utf-8")) as EntriesFile;
    const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
    entries = list.filter(isEntry).map(withDefaults);
    const pending = entries.filter((e) => e.status === "pending").length;
    console.log(
      `[knowledge] entries.json を復元: 全 ${entries.length} 件` +
        `(未承認 ${pending} / 承認済み ${entries.filter((e) => e.status === "approved").length})`,
    );
  } catch {
    entries = [];
    console.log("[knowledge] entries.json はまだありません(未作成)");
  }
}

async function persistEntries(): Promise<void> {
  const file: EntriesFile = { version: ENTRIES_VERSION, entries };
  await atomicWrite(ENTRIES_PATH, JSON.stringify(file, null, 2) + "\n");
}

/** 全件(新しい順)。 */
export function listEntries(): KnowledgeEntry[] {
  return entries.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export function listByStatus(status: KnowledgeEntry["status"]): KnowledgeEntry[] {
  return listEntries().filter((e) => e.status === status);
}

export function getEntry(id: string): KnowledgeEntry | null {
  return entries.find((e) => e.id === id) ?? null;
}

export function pendingCount(): number {
  return entries.filter((e) => e.status === "pending").length;
}

export async function addEntries(list: KnowledgeEntry[]): Promise<void> {
  if (list.length === 0) return;
  entries.push(...list);
  await persistEntries();
}

/** 既存エントリを差し替える(承認・却下・編集・マージのすべてがここを通る)。 */
export async function replaceEntry(next: KnowledgeEntry): Promise<KnowledgeEntry> {
  const i = entries.findIndex((e) => e.id === next.id);
  if (i < 0) throw new Error(`entry not found: ${next.id}`);
  entries[i] = next;
  await persistEntries();
  return next;
}

/** 複数まとめて差し替える(まとめて承認・マージの 2 件同時更新)。書き込みは 1 回。 */
export async function replaceEntries(list: KnowledgeEntry[]): Promise<void> {
  for (const next of list) {
    const i = entries.findIndex((e) => e.id === next.id);
    if (i >= 0) entries[i] = next;
  }
  await persistEntries();
}

/**
 * 再確認の記録(71)。承認済みエントリと同じ知見が別の調査からもう一度出てきたとき、
 * 候補は作らずに **出典だけ** を既存エントリに足す。
 *
 * 本文には一切手を入れない(承認は必ず人が押す、という 46 の原則を崩さないため)。
 * 足すのは「その知見が今回の調査でも当てはまった」という事実だけで、
 * 承認画面の出典一覧からその調査へ飛べるようになる。
 * 同じ runId は二重に足さない。
 */
export async function addSources(id: string, list: KnowledgeSource[]): Promise<KnowledgeEntry | null> {
  const i = entries.findIndex((e) => e.id === id);
  if (i < 0) return null;
  const known = new Set(entries[i].sources.map((s) => s.runId));
  const fresh = list.filter((s) => !known.has(s.runId));
  if (fresh.length === 0) return entries[i];
  entries[i] = {
    ...entries[i],
    sources: [...entries[i].sources, ...fresh],
    updatedAt: new Date().toISOString(),
  };
  await persistEntries();
  return entries[i];
}

/**
 * 参照実績の記録(47 Task 3)。調査プロンプトに注入したエントリの
 * 参照回数を +1 し、最終参照日時を今にする。書き込みは 1 回にまとめる。
 *
 * 呼び出し元(retrieve.ts)は調査の実行経路上にいるので、ここで throw させない
 * (記録に失敗しても調査そのものは続けるべき)。
 */
export async function recordReferences(ids: string[], at = new Date().toISOString()): Promise<number> {
  let touched = 0;
  for (const id of ids) {
    const i = entries.findIndex((e) => e.id === id);
    if (i < 0) continue;
    entries[i] = {
      ...entries[i],
      refCount: (entries[i].refCount ?? 0) + 1,
      lastReferencedAt: at,
    };
    touched += 1;
  }
  if (touched === 0) return 0;
  try {
    await persistEntries();
  } catch (err) {
    console.error("[knowledge] 参照実績の保存に失敗しました(メモリ上の値は更新済み):", err);
  }
  return touched;
}

// ---- 抽出済み runId ----
//
// 同じ調査から二重に候補を作らないための記録。候補を却下しても「もう抽出した」事実は
// 残るので、却下した候補が次の起動で復活することはない。

interface ExtractedFile {
  version: number;
  runIds: string[];
}

/** 記録しておく runId の上限(古いものから捨てる。履歴自体は jsonl 側にある)。 */
const EXTRACTED_MAX = 2000;

let extracted: string[] = [];
let extractedSet = new Set<string>();

export async function loadExtracted(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(EXTRACTED_PATH, "utf-8")) as ExtractedFile;
    extracted = Array.isArray(parsed?.runIds) ? parsed.runIds.filter((v) => typeof v === "string") : [];
  } catch {
    extracted = [];
  }
  extractedSet = new Set(extracted);
  console.log(`[knowledge] 抽出済みの調査: ${extracted.length} 件`);
}

export function isExtracted(runId: string): boolean {
  return extractedSet.has(runId);
}

export async function markExtracted(runId: string): Promise<void> {
  if (extractedSet.has(runId)) return;
  extractedSet.add(runId);
  extracted.push(runId);
  if (extracted.length > EXTRACTED_MAX) {
    const dropped = extracted.splice(0, extracted.length - EXTRACTED_MAX);
    for (const d of dropped) extractedSet.delete(d);
  }
  await atomicWrite(
    EXTRACTED_PATH,
    JSON.stringify({ version: 1, runIds: extracted } satisfies ExtractedFile, null, 2) + "\n",
  );
}

// ---- 抽出ログ(メモリのみ)----

const log: ExtractionLogEntry[] = [];

export function pushLog(entry: ExtractionLogEntry): void {
  log.unshift(entry);
  if (log.length > LOG_MAX) log.length = LOG_MAX;
}

export function listLog(limit = 20): ExtractionLogEntry[] {
  return log.slice(0, Math.max(1, limit));
}

export async function ensureDirs(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}
