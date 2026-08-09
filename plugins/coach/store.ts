// Coach(65)— 設定・永続化。
//
// 置き場(data/ 配下。イメージを作り直しても消えない):
//   data/coach/settings.json        … しきい値・3 ターン規則・弱点判定の各設定
//   data/coach/sessions.jsonl       … 壁打ち / クイズのセッション記録(追記専用)
//   data/coach/weakness.json        … 話題キーごとの実績(= 弱点プロファイル)
//   data/coach/material-usage.json  … クイズで使った素材の実績
//
// **material-usage.json を別立てにしているのが 65 番で最も重要な点**:
// ナレッジの refCount は 47 番で「調査プロンプトに注入された回数」と定義済みで、
// Coach が同じカウンタを回すと「その知見が調査で役に立ったか」の指標が壊れる。
// よって Coach は buildInjection()(内部で recordReferences() を呼ぶ)を**使わず**、
// 副作用の無い relevantEntries() / buildSection() だけを使い、
// Coach 側の利用実績はこのファイルに持つ(64_findings.md §1-1(d) / §3-3)。
//
// 書き込みは既存プラグインと同じ「一時ファイル → rename + 同一ファイルへの直列化」。

import { fileURLToPath } from "node:url";
import path from "node:path";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import type {
  CoachSession,
  CoachSessionSummary,
  CoachSettings,
  HintLevel,
  MaterialKind,
  MaterialUsage,
  QuizVerdict,
  TopicStat,
  UsageFile,
  WeaknessFile,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.COACH_DATA_DIR || path.resolve(__dirname, "../../data/coach");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const SESSIONS_PATH = path.join(DATA_DIR, "sessions.jsonl");
const WEAKNESS_PATH = path.join(DATA_DIR, "weakness.json");
const USAGE_PATH = path.join(DATA_DIR, "material-usage.json");

/**
 * 関連度しきい値の既定値 0.15 は**実データで測って決めた**(65 の実測)。
 *
 * 承認済みナレッジ 24 件に対して、サイト指定なしの junior 風の質問を投げた実測:
 *   - ネットワークと無関係な質問(有給申請 / ランチ / プリンタ)の最高点 = 0.079
 *     → これがノイズ床。0.15 はその約 2 倍で、無関係な質問では 1 件も通らない。
 *   - 関連する質問 7 問のうち何問が 1 件以上拾えるか:
 *       0.10 → 6/7 、0.15 → 6/7 、**0.18 → 3/7**(ここで急落)
 *     → 0.15〜0.18 の間に崖がある。0.15 より下げても拾える数は増えない。
 *   - 1 質問あたりの該当件数: 0.15 で 0〜5 件(上限 3 で足りる)/ 0.10 だと最大 9 件
 *
 * 既存の調査プロンプト注入(retrieve.ts)が 0.30 なのは、サイト一致ボーナス 0.20 が
 * 乗る前提で「内容が当たって初めて注入される」性質を作るため。Coach は原則サイトを
 * 指定しない(junior は「どのサイトか」から分かっていない)ので、その加点が発火しない。
 * さらに教材用途では、外した素材が混ざる害が「誤診断」ではなく「話が少し逸れる」で済む。
 * 両方の理由から Coach は 0.15 を採る。
 */
export const DEFAULT_THRESHOLD = 0.15;

/**
 * 調査履歴の関連度しきい値の既定 0.05 は、**ナレッジとは別の測り方**に対応している。
 *
 * 最初はナレッジと同じ 0.15 / 同じ式(重なり係数)で作ったが、実データで測ったところ
 * 「有給休暇の申請方法を教えてください」のような**ネットワークと無関係な質問**が
 * 履歴 3 件を 0.194 で拾った。原因は式にある:
 *   - 重なり係数は分母が min(|A|,|B|) なので、短い質問の bigram が
 *     1200 文字の回答本文のどこかに散らばって当たるだけで高く出る。
 *   - 日本語の定型部分(「〜を教えてください」「確認すべき点を」)が共通で当たる。
 * ナレッジ層でこれが起きなかったのは、タイトル・症状が質問と同じくらい短いため。
 *
 * そこで履歴層は 2 段構えにした:
 *   (1) **話題キーの一致を必須の門にする**(質問と履歴が同じ話題タグを共有すること)
 *   (2) 順位付けは Dice 係数(長さの差で不利になる = 短い質問と長い回答が当たりにくい)
 * 実測(教材適格 152 件):
 *   無関係な質問 5 問 → **すべて 0 件**(門で落ちる)
 *   ネットワークだが該当の無い質問(VLAN 設計 / PoE)2 問 → **0 件**
 *   関連する質問 5 問 → 5 問すべてが 1 件以上(最小 0.051)
 * 門が実質的な判別をしているので、この数値は「取りこぼしを防ぐ床」として低くしてある。
 */
export const DEFAULT_HISTORY_THRESHOLD = 0.05;

/**
 * ライブ層(68 番)の既定値。
 *
 * 「静的な蓄積を優先し、薄い / 古い / 対象外のときだけライブで裏を取る」ための数値。
 * 一番効くのは **liveCacheTtlMs** で、同じ話題を続けて壁打ちしても MCP 問い合わせは
 * 1 回で済む。Central API のレート制限は**アカウント全体で共有**(秒 10 回程度)なので、
 * 「1 往復ごとに Central を叩く Coach」を作らないことが設計の前提になる。
 *
 * liveStaticFloor(0.45)は実測から決めた:
 *   rogue AP の質問 → ナレッジ最高 score 0.553(= 厚い。ライブ不要側)
 *   一般的な言い回しだけの質問 → 0.2 台〜該当なし(= 薄い。ライブで補強したい)
 * 0.45 はこの 2 群のあいだにあり、「うちの記録にちゃんと当たった」ときだけ静的で完結する。
 */
export const DEFAULT_LIVE_STATIC_FLOOR = 0.45;
/** 静的素材がこれより古ければ鮮度不足と見なす(調査履歴の実データが 2 週間強のため 14 日)。 */
export const DEFAULT_LIVE_STALE_DAYS = 14;

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

const DEFAULT_SETTINGS: CoachSettings = {
  model: null,
  threshold: clampFloat(process.env.COACH_THRESHOLD, 0.05, 0.99, DEFAULT_THRESHOLD),
  historyThreshold: clampFloat(process.env.COACH_HISTORY_THRESHOLD, 0.01, 0.99, DEFAULT_HISTORY_THRESHOLD),
  maxMaterials: clampInt(process.env.COACH_MAX_MATERIALS, 1, 8, 5),
  turnRule: clampInt(process.env.COACH_TURN_RULE, 2, 5, 3),
  weakTurnRule: clampInt(process.env.COACH_WEAK_TURN_RULE, 1, 4, 2),
  quizRounds: clampInt(process.env.COACH_QUIZ_ROUNDS, 1, 4, 2),
  minAttempts: clampInt(process.env.COACH_MIN_ATTEMPTS, 1, 10, 3),
  weaknessThreshold: clampFloat(process.env.COACH_WEAKNESS_THRESHOLD, 0.05, 0.99, 0.4),
  weakBias: clampFloat(process.env.COACH_WEAK_BIAS, 0, 1, 1 / 3),
  liveEnabled: process.env.COACH_LIVE_ENABLED !== "0",
  liveStaticFloor: clampFloat(process.env.COACH_LIVE_STATIC_FLOOR, 0, 1, DEFAULT_LIVE_STATIC_FLOOR),
  liveStaleDays: clampInt(process.env.COACH_LIVE_STALE_DAYS, 1, 365, DEFAULT_LIVE_STALE_DAYS),
  liveTimeoutMs: clampInt(process.env.COACH_LIVE_TIMEOUT_MS, 15_000, 240_000, 90_000),
  liveCacheTtlMs: clampInt(process.env.COACH_LIVE_CACHE_TTL_MS, 0, 3_600_000, 300_000),
  liveMinIntervalMs: clampInt(process.env.COACH_LIVE_MIN_INTERVAL_MS, 0, 600_000, 15_000),
  liveMaxPerSession: clampInt(process.env.COACH_LIVE_MAX_PER_SESSION, 0, 20, 4),
};

let settings: CoachSettings = { ...DEFAULT_SETTINGS };

// ---- 同一ファイルへの同時書き込みを直列化する(knowledge/store.ts と同じ)----

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

export function normalizeSettings(raw: unknown, base: CoachSettings = DEFAULT_SETTINGS): CoachSettings {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const model =
    typeof p.model === "string" && p.model.trim() && MODEL_RE.test(p.model.trim())
      ? p.model.trim()
      : p.model === null || p.model === ""
        ? null
        : base.model;
  return {
    model,
    threshold: p.threshold === undefined ? base.threshold : clampFloat(p.threshold, 0.05, 0.99, base.threshold),
    historyThreshold:
      p.historyThreshold === undefined
        ? base.historyThreshold
        : clampFloat(p.historyThreshold, 0.01, 0.99, base.historyThreshold),
    maxMaterials:
      p.maxMaterials === undefined ? base.maxMaterials : clampInt(p.maxMaterials, 1, 8, base.maxMaterials),
    turnRule: p.turnRule === undefined ? base.turnRule : clampInt(p.turnRule, 2, 5, base.turnRule),
    weakTurnRule:
      p.weakTurnRule === undefined ? base.weakTurnRule : clampInt(p.weakTurnRule, 1, 4, base.weakTurnRule),
    quizRounds: p.quizRounds === undefined ? base.quizRounds : clampInt(p.quizRounds, 1, 4, base.quizRounds),
    minAttempts:
      p.minAttempts === undefined ? base.minAttempts : clampInt(p.minAttempts, 1, 10, base.minAttempts),
    weaknessThreshold:
      p.weaknessThreshold === undefined
        ? base.weaknessThreshold
        : clampFloat(p.weaknessThreshold, 0.05, 0.99, base.weaknessThreshold),
    weakBias: p.weakBias === undefined ? base.weakBias : clampFloat(p.weakBias, 0, 1, base.weakBias),
    // ---- ライブ層(68 番)----
    liveEnabled: typeof p.liveEnabled === "boolean" ? p.liveEnabled : base.liveEnabled,
    liveStaticFloor:
      p.liveStaticFloor === undefined
        ? base.liveStaticFloor
        : clampFloat(p.liveStaticFloor, 0, 1, base.liveStaticFloor),
    liveStaleDays:
      p.liveStaleDays === undefined ? base.liveStaleDays : clampInt(p.liveStaleDays, 1, 365, base.liveStaleDays),
    liveTimeoutMs:
      p.liveTimeoutMs === undefined
        ? base.liveTimeoutMs
        : clampInt(p.liveTimeoutMs, 15_000, 240_000, base.liveTimeoutMs),
    liveCacheTtlMs:
      p.liveCacheTtlMs === undefined
        ? base.liveCacheTtlMs
        : clampInt(p.liveCacheTtlMs, 0, 3_600_000, base.liveCacheTtlMs),
    liveMinIntervalMs:
      p.liveMinIntervalMs === undefined
        ? base.liveMinIntervalMs
        : clampInt(p.liveMinIntervalMs, 0, 600_000, base.liveMinIntervalMs),
    liveMaxPerSession:
      p.liveMaxPerSession === undefined
        ? base.liveMaxPerSession
        : clampInt(p.liveMaxPerSession, 0, 20, base.liveMaxPerSession),
  };
}

export function getSettings(): CoachSettings {
  return { ...settings };
}

export async function loadSettings(): Promise<CoachSettings> {
  try {
    settings = normalizeSettings(JSON.parse(await readFile(SETTINGS_PATH, "utf-8")));
    console.log(
      `[coach] settings.json を復元: しきい値 ${settings.threshold} / 素材上限 ${settings.maxMaterials} / ` +
        `${settings.turnRule} ターン規則(弱点 ${settings.weakTurnRule})/ クイズ ${settings.quizRounds} 往復`,
    );
  } catch {
    settings = { ...DEFAULT_SETTINGS };
    console.log(`[coach] settings.json がありません。既定で始めます(しきい値 ${settings.threshold})。`);
  }
  return getSettings();
}

export async function saveSettings(patch: unknown): Promise<CoachSettings> {
  settings = normalizeSettings(patch, settings);
  await atomicWrite(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  return getSettings();
}

// ---- セッション(メモリ上が正、jsonl は記録)----
//
// 壁打ちは「入力途中の文とセッション状態」を抱えるので、進行中はメモリに置く。
// 1 ターンごとに jsonl へ**セッション全体のスナップショットを追記**し、
// 再起動しても直近の記録が画面に出るようにする(最後の 1 行が最新)。

const sessions = new Map<string, CoachSession>();

/** 進行中セッションの上限。超えたら古い順に捨てる(記録は jsonl 側に残る)。 */
const LIVE_MAX = 50;

export function getSession(id: string): CoachSession | null {
  return sessions.get(id) ?? null;
}

export function putSession(s: CoachSession): void {
  sessions.delete(s.sessionId);
  sessions.set(s.sessionId, s);
  while (sessions.size > LIVE_MAX) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

export function listLiveSessions(): CoachSession[] {
  return [...sessions.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/**
 * sessions.jsonl のローテーション上限(バイト)。壁打ちは往復が多く、
 * 調査履歴(215 件 / 748KB)より増えやすいので上限を切る。
 * 超えたら古い方を捨てて後半だけを残す(行の途中で切らない)。
 */
const SESSIONS_MAX_BYTES = Number(process.env.COACH_SESSIONS_MAX_BYTES || 4_000_000);

export async function appendSessionSnapshot(s: CoachSession): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(SESSIONS_PATH, JSON.stringify(s) + "\n", "utf-8");
    await rotateSessionsIfNeeded();
  } catch (err) {
    // 記録の失敗で壁打ちそのものを壊さない(recordReferences と同じ流儀)。
    console.error("[coach] セッションの記録に失敗しました:", err);
  }
}

async function rotateSessionsIfNeeded(): Promise<void> {
  let size = 0;
  try {
    size = (await stat(SESSIONS_PATH)).size;
  } catch {
    return;
  }
  if (size <= SESSIONS_MAX_BYTES) return;
  const raw = await readFile(SESSIONS_PATH, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const keep = lines.slice(Math.floor(lines.length / 2));
  await atomicWrite(SESSIONS_PATH, keep.join("\n") + "\n");
  console.log(`[coach] sessions.jsonl をローテーションしました(${lines.length} → ${keep.length} 行)`);
}

/**
 * 記録済みセッションを新しい順に読む。同じ sessionId は最後の 1 行(= 最新)だけを採る。
 * 進行中(メモリ上)のセッションが同 id であればそちらを優先する。
 */
export async function readRecordedSessions(limit = 50): Promise<CoachSession[]> {
  let raw: string;
  try {
    raw = await readFile(SESSIONS_PATH, "utf-8");
  } catch {
    raw = "";
  }
  const latest = new Map<string, CoachSession>();
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const p = JSON.parse(s) as CoachSession;
      if (p && typeof p.sessionId === "string") latest.set(p.sessionId, p);
    } catch {
      /* 壊れた行は無視 */
    }
  }
  for (const live of sessions.values()) latest.set(live.sessionId, live);
  return [...latest.values()]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, Math.max(1, limit));
}

// ---- 履歴の閲覧(70 番)----
//
// 一覧は要約・詳細は全文に分ける。一覧に CoachSession をそのまま載せると、
// 1 セッションぶんの materials(根拠リンク全件)まで運ぶことになる。

/** 1 セッションを一覧用に畳む。**文章は作らない**(コード / 数値 / 記録だけ)。 */
export function summarizeSession(s: CoachSession): CoachSessionSummary {
  const turns = s.turns ?? [];
  const topicKeys: string[] = [];
  for (const t of turns) {
    for (const k of t.topicKeys ?? []) if (!topicKeys.includes(k)) topicKeys.push(k);
  }
  // 見出しは「最初に本人が書いた発話」。ボタンだけのターン(空)は飛ばす。
  const firstQuestion = turns.find((t) => (t.question ?? "").trim())?.question.trim() ?? "";
  const maxHintLevel = turns.reduce<HintLevel>((m, t) => (t.hintLevel > m ? t.hintLevel : m), 0);
  const totalDurationMs = turns.reduce(
    (sum, t) => sum + (t.durationMs || 0) + (t.live?.durationMs || 0),
    0,
  );
  return {
    sessionId: s.sessionId,
    mode: s.mode,
    incidentMode: s.incidentMode,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    turnCount: turns.length,
    topicKeys,
    firstQuestion,
    maxHintLevel,
    // escalated はセッションのフラグだけでなくターンの intent も見る
    // (失敗したターンではフラグを進めない設計のため。api.ts の 7 節)。
    escalated: s.escalated || turns.some((t) => t.intent === "escalate"),
    forcedDisclosure: turns.some((t) => t.forcedDisclosure),
    usedLive: turns.some((t) => t.live?.used === true),
    hasError: turns.some((t) => t.isError),
    level: s.level,
    quizVerdict: s.quiz?.verdict ?? null,
    totalDurationMs,
  };
}

/**
 * 一覧用の要約を新しい順に返す。
 *
 * **中身の無いセッションは出さない。** 壁打ちを 1 往復もせずにクイズだけ出して
 * 終わった記録や、送信前に画面を離れた記録が一覧を埋めると、探しにくくなる。
 */
export async function readSessionSummaries(limit = 50): Promise<CoachSessionSummary[]> {
  const all = await readRecordedSessions(Number.MAX_SAFE_INTEGER);
  return all
    .filter((s) => (s.turns?.length ?? 0) > 0 || s.quiz !== null)
    .slice(0, Math.max(1, limit))
    .map(summarizeSession);
}

/** 詳細(全文)を 1 件返す。進行中のセッションがあればそちらを優先する。 */
export async function readRecordedSession(sessionId: string): Promise<CoachSession | null> {
  const live = sessions.get(sessionId);
  if (live) return live;
  let raw: string;
  try {
    raw = await readFile(SESSIONS_PATH, "utf-8");
  } catch {
    return null;
  }
  // 同じ sessionId は追記のたびに増えるので、**最後の 1 行**が最新。
  let found: CoachSession | null = null;
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || !s.includes(sessionId)) continue;
    try {
      const p = JSON.parse(s) as CoachSession;
      if (p && p.sessionId === sessionId) found = p;
    } catch {
      /* 壊れた行は無視 */
    }
  }
  return found;
}

// ---- 弱点プロファイル ----
//
// 学習者 ID は持たない(デモ用途のため認証機構を作らないという確定事項)。
// 話題キーごとの実績を 1 つのプロファイルに集約し、誰でも見られる形で表示する。

let weakness: WeaknessFile = { version: 1, topics: {}, updatedAt: new Date().toISOString() };

function emptyStat(topicKey: string): TopicStat {
  return {
    topicKey,
    attempts: 0,
    correct: 0,
    partial: 0,
    wrong: 0,
    sessions: 0,
    hintSum: 0,
    hintCount: 0,
    escalations: 0,
    forcedDisclosures: 0,
    lastAt: null,
  };
}

export async function loadWeakness(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(WEAKNESS_PATH, "utf-8")) as WeaknessFile;
    const topics: Record<string, TopicStat> = {};
    for (const [k, v] of Object.entries(parsed?.topics ?? {})) {
      topics[k] = { ...emptyStat(k), ...(v as TopicStat), topicKey: k };
    }
    weakness = { version: 1, topics, updatedAt: parsed?.updatedAt ?? new Date().toISOString() };
    console.log(`[coach] weakness.json を復元: 話題 ${Object.keys(topics).length} 件`);
  } catch {
    weakness = { version: 1, topics: {}, updatedAt: new Date().toISOString() };
    console.log("[coach] weakness.json はまだありません(未作成)");
  }
}

export function getWeakness(): WeaknessFile {
  return { ...weakness, topics: { ...weakness.topics } };
}

async function persistWeakness(): Promise<void> {
  weakness.updatedAt = new Date().toISOString();
  try {
    await atomicWrite(WEAKNESS_PATH, JSON.stringify(weakness, null, 2) + "\n");
  } catch (err) {
    console.error("[coach] 弱点プロファイルの保存に失敗しました(メモリ上の値は更新済み):", err);
  }
}

/** 壁打ち 1 ターンぶんの記録。話題キーごとに hintLevel を積む。 */
export async function recordChatTurn(opts: {
  topicKeys: string[];
  hintLevel: number;
  escalated: boolean;
  forcedDisclosure: boolean;
  newTopic: boolean;
  at: string;
}): Promise<void> {
  for (const key of opts.topicKeys) {
    const cur = weakness.topics[key] ?? emptyStat(key);
    weakness.topics[key] = {
      ...cur,
      sessions: cur.sessions + (opts.newTopic ? 1 : 0),
      hintSum: cur.hintSum + opts.hintLevel,
      hintCount: cur.hintCount + 1,
      escalations: cur.escalations + (opts.escalated ? 1 : 0),
      forcedDisclosures: cur.forcedDisclosures + (opts.forcedDisclosure ? 1 : 0),
      lastAt: opts.at,
    };
  }
  if (opts.topicKeys.length) await persistWeakness();
}

/** クイズ 1 問ぶんの記録。 */
export async function recordQuizResult(opts: {
  topicKeys: string[];
  verdict: QuizVerdict;
  at: string;
}): Promise<void> {
  for (const key of opts.topicKeys) {
    const cur = weakness.topics[key] ?? emptyStat(key);
    weakness.topics[key] = {
      ...cur,
      attempts: cur.attempts + 1,
      correct: cur.correct + (opts.verdict === "correct" ? 1 : 0),
      partial: cur.partial + (opts.verdict === "partial" ? 1 : 0),
      wrong: cur.wrong + (opts.verdict === "wrong" ? 1 : 0),
      lastAt: opts.at,
    };
  }
  if (opts.topicKeys.length) await persistWeakness();
}

// ---- 素材の利用実績(ナレッジの refCount とは完全に別のカウンタ)----

let usage: UsageFile = { version: 1, materials: [], updatedAt: new Date().toISOString() };

export async function loadUsage(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(USAGE_PATH, "utf-8")) as UsageFile;
    usage = {
      version: 1,
      materials: Array.isArray(parsed?.materials) ? parsed.materials : [],
      updatedAt: parsed?.updatedAt ?? new Date().toISOString(),
    };
    console.log(`[coach] material-usage.json を復元: 素材 ${usage.materials.length} 件`);
  } catch {
    usage = { version: 1, materials: [], updatedAt: new Date().toISOString() };
    console.log("[coach] material-usage.json はまだありません(未作成)");
  }
}

export function getUsage(): UsageFile {
  return { version: usage.version, materials: usage.materials.slice(), updatedAt: usage.updatedAt };
}

export function findUsage(kind: MaterialKind, id: string): MaterialUsage | null {
  return usage.materials.find((m) => m.kind === kind && m.id === id) ?? null;
}

/**
 * 出題した時点で +1(recordReferences と同じ流儀 — 使った時点で数え、
 * 保存に失敗しても throw しない。記録の失敗で出題そのものを壊さない)。
 */
export async function recordQuizUsage(kind: MaterialKind, id: string, at: string): Promise<void> {
  const i = usage.materials.findIndex((m) => m.kind === kind && m.id === id);
  if (i < 0) {
    usage.materials.push({ kind, id, quizCount: 1, lastQuizAt: at, lastVerdict: null, reviewAfter: null });
  } else {
    usage.materials[i] = { ...usage.materials[i], quizCount: usage.materials[i].quizCount + 1, lastQuizAt: at };
  }
  await persistUsage();
}

/** 間隔反復(64 §3-3(d))。正解した素材は寝かせ、間違えた素材は 3 日後に戻す。 */
const REVIEW_AFTER_MS: Record<QuizVerdict, number> = {
  correct: 30 * 24 * 3600_000,
  partial: 10 * 24 * 3600_000,
  wrong: 3 * 24 * 3600_000,
};

export async function recordQuizVerdict(
  kind: MaterialKind,
  id: string,
  verdict: QuizVerdict,
  at: string,
): Promise<void> {
  const i = usage.materials.findIndex((m) => m.kind === kind && m.id === id);
  const reviewAfter = new Date(Date.parse(at) + REVIEW_AFTER_MS[verdict]).toISOString();
  if (i < 0) {
    usage.materials.push({ kind, id, quizCount: 1, lastQuizAt: at, lastVerdict: verdict, reviewAfter });
  } else {
    usage.materials[i] = { ...usage.materials[i], lastVerdict: verdict, reviewAfter };
  }
  await persistUsage();
}

async function persistUsage(): Promise<void> {
  usage.updatedAt = new Date().toISOString();
  try {
    await atomicWrite(USAGE_PATH, JSON.stringify(usage, null, 2) + "\n");
  } catch (err) {
    console.error("[coach] 素材の利用実績の保存に失敗しました(メモリ上の値は更新済み):", err);
  }
}

export async function ensureDirs(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}
