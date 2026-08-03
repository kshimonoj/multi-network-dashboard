// Streaming(Central)(20 Task 2-6 / Task 3)— 設定の永続化・イベントの保存・Retention。
//
// ---- 保存形式の判断 ----
// Global Overview / Webhook ログは「数百〜数千件のスナップショットを JSON で丸ごと書き直す」
// 方式だが、Streaming は **追記が主で、しかも高頻度**(Location / RSSI は秒あたり数件)。
// 毎回 JSON 全体を書き直すのは無駄なので、ここは **JSON Lines への追記** にした。
//   data/central-streaming/events.jsonl   … 1 行 1 イベント
//   data/central-streaming/settings.json  … トグル・購読・Retention(小さいので JSON のまま)
// SQLite を入れるほどの規模でも要件でもない(全文検索も集計もしない)。
//
// ---- Retention(Task 3-2)----
// 保持期間(日)と保持件数の 2 本立てで、どちらか厳しいほうが効く。
// 定期ジョブ(既定 10 分ごと)がメモリ上の配列を切り詰め、jsonl を書き直す。
// 追記は都度 fs.appendFile ではなく 2 秒ぶんをまとめてフラッシュする(高頻度対策)。

import { fileURLToPath } from "node:url";
import path from "node:path";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { STREAM_KEYS, isStreamKey, type StreamKey } from "./catalog.js";
import type { StreamEvent, StreamSettings, StreamSubscription } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR =
  process.env.CENTRAL_STREAMING_DATA_DIR || path.resolve(__dirname, "../../data/central-streaming");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const EVENTS_PATH = path.join(DATA_DIR, "events.jsonl");

/** 画面のプルダウンに出す保持期間(日)。 */
export const RETENTION_OPTIONS_DAYS = [1, 3, 7, 30];
/** 画面のプルダウンに出す保持件数。 */
export const MAX_EVENTS_OPTIONS = [1_000, 5_000, 20_000, 50_000];

const RETENTION_MIN_DAYS = 1;
const RETENTION_MAX_DAYS = 90;
const MAX_EVENTS_HARD_CAP = 200_000;

/** Retention ジョブの実行間隔。 */
const PURGE_INTERVAL_MS = Math.max(60_000, Number(process.env.CENTRAL_STREAMING_PURGE_MS ?? 600_000));
/** 追記のフラッシュ間隔。 */
const FLUSH_MS = 2_000;
/** 一覧 API が返す最大件数(保持件数とは別。画面に一度に流し込む量の上限)。 */
export const API_MAX_ITEMS = Math.max(100, Number(process.env.CENTRAL_STREAMING_API_MAX ?? 1_000));

// ---- 既定値 ----
// 既定で購読するのは Audit Trail だけにする。Location / RSSI / AP stats は
// 秒あたり数件〜が流れ続けるため、初期状態で全部 ON にすると意図せず
// ディスクとメモリを食う(20 番の疎通確認で実測)。ユーザーが明示的に選ぶ形にした。
function defaultSubscriptions(): Record<StreamKey, StreamSubscription> {
  const out = {} as Record<StreamKey, StreamSubscription>;
  for (const k of STREAM_KEYS) out[k] = { enabled: k === "audit-trail", eventTypes: [] };
  return out;
}

function defaultSettings(): StreamSettings {
  return {
    enabled: false, // 起動しただけでは繋がない。画面のトグルで明示的に有効化する。
    streams: defaultSubscriptions(),
    retentionDays: 7,
    maxEvents: 20_000,
  };
}

let settings: StreamSettings = defaultSettings();
let events: StreamEvent[] = []; // 新しい順
let seen = new Set<string>(); // CloudEvent id による重複排除(再接続時のキュー再送対策)
let pending: StreamEvent[] = []; // まだ jsonl に書いていないぶん
let flushTimer: NodeJS.Timeout | null = null;
let purgeTimer: NodeJS.Timeout | null = null;
let lastPurgeAt: string | null = null;
let lastPurged = 0;
/** 追記した行数。compact 後にリセットされる(jsonl の実際の行数と一致させるため) */
let appended = 0;

let writeChain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn);
  writeChain = next.catch(() => undefined);
  return next;
}

async function atomicWrite(file: string, data: string): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, data, "utf-8");
  await rename(tmp, file);
}

// ---- 設定 ----

export function getSettings(): StreamSettings {
  return {
    enabled: settings.enabled,
    retentionDays: settings.retentionDays,
    maxEvents: settings.maxEvents,
    streams: Object.fromEntries(
      STREAM_KEYS.map((k) => [k, { ...settings.streams[k], eventTypes: [...settings.streams[k].eventTypes] }]),
    ) as Record<StreamKey, StreamSubscription>,
  };
}

function clampDays(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 7;
  return Math.min(RETENTION_MAX_DAYS, Math.max(RETENTION_MIN_DAYS, Math.round(v)));
}

function clampMax(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 20_000;
  return Math.min(MAX_EVENTS_HARD_CAP, Math.max(100, Math.round(v)));
}

/** 起動時に settings.json / events.jsonl を読み戻す(WebSocket は張らない)。 */
export async function loadPersisted(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_PATH, "utf-8")) as Partial<StreamSettings>;
    const next = defaultSettings();
    next.enabled = parsed.enabled === true;
    next.retentionDays = clampDays(parsed.retentionDays ?? next.retentionDays);
    next.maxEvents = clampMax(parsed.maxEvents ?? next.maxEvents);
    if (parsed.streams && typeof parsed.streams === "object") {
      for (const [k, v] of Object.entries(parsed.streams)) {
        if (!isStreamKey(k) || !v || typeof v !== "object") continue;
        next.streams[k] = {
          enabled: (v as StreamSubscription).enabled === true,
          eventTypes: Array.isArray((v as StreamSubscription).eventTypes)
            ? (v as StreamSubscription).eventTypes.filter((t): t is string => typeof t === "string")
            : [],
        };
      }
    }
    settings = next;
    console.log(
      `[central-streaming] settings.json を復元: 全体=${settings.enabled ? "有効" : "無効"} ` +
        `購読=[${STREAM_KEYS.filter((k) => settings.streams[k].enabled).join(", ") || "なし"}] ` +
        `保持=${settings.retentionDays}日/${settings.maxEvents}件`,
    );
  } catch {
    console.log("[central-streaming] settings.json がありません。既定(無効・Audit Trail のみ選択)で始めます。");
  }

  try {
    const raw = await readFile(EVENTS_PATH, "utf-8");
    const loaded: StreamEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as StreamEvent;
        if (ev && typeof ev.id === "string" && isStreamKey(ev.stream)) loaded.push(ev);
      } catch {
        /* 途中で切れた行は捨てる(追記中にプロセスが落ちた場合) */
      }
    }
    // ファイルは追記順(古い順)。メモリは新しい順で持つ。
    loaded.reverse();
    events = loaded;
    seen = new Set(events.map((e) => e.id));
    appended = events.length;
    console.log(`[central-streaming] events.jsonl を読み込みました(${events.length} 件)`);
    // 起動時に一度 Retention を効かせる(止めていた間に期限切れになったぶんを捨てる)。
    await purge();
  } catch {
    /* 無ければ空から始める */
  }
}

async function persistSettings(): Promise<void> {
  await serialize(() => atomicWrite(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n"));
}

export async function updateSettings(patch: {
  enabled?: unknown;
  retentionDays?: unknown;
  maxEvents?: unknown;
  streams?: unknown;
}): Promise<StreamSettings> {
  if (typeof patch.enabled === "boolean") settings.enabled = patch.enabled;
  if (patch.retentionDays !== undefined) settings.retentionDays = clampDays(patch.retentionDays);
  if (patch.maxEvents !== undefined) settings.maxEvents = clampMax(patch.maxEvents);
  if (patch.streams && typeof patch.streams === "object") {
    for (const [k, v] of Object.entries(patch.streams as Record<string, unknown>)) {
      if (!isStreamKey(k) || !v || typeof v !== "object") continue;
      const sub = v as Partial<StreamSubscription>;
      const cur = settings.streams[k];
      settings.streams[k] = {
        enabled: typeof sub.enabled === "boolean" ? sub.enabled : cur.enabled,
        eventTypes: Array.isArray(sub.eventTypes)
          ? [...new Set(sub.eventTypes.filter((t): t is string => typeof t === "string"))]
          : cur.eventTypes,
      };
    }
  }
  await persistSettings();
  return getSettings();
}

// ---- イベントの追加 ----

/**
 * 受信したイベントを保持する。
 * 戻り値は「新規として受け入れたか」(false = 同じ CloudEvent id を見たことがある)。
 * Central は切断後 15 分ぶんをキューして再送するため、再接続直後は重複が来る。
 */
export function addEvent(ev: StreamEvent): boolean {
  if (seen.has(ev.id)) return false;
  seen.add(ev.id);
  events.unshift(ev);
  pending.push(ev);

  // 件数の上限はここで即座に効かせる(メモリを守るため。日数の判定は定期ジョブ)。
  if (events.length > settings.maxEvents) {
    const dropped = events.splice(settings.maxEvents);
    for (const d of dropped) seen.delete(d.id);
  }

  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_MS);
    flushTimer.unref?.();
  }
  return true;
}

async function flush(): Promise<void> {
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  const body = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
  try {
    await serialize(async () => {
      await mkdir(DATA_DIR, { recursive: true });
      await appendFile(EVENTS_PATH, body, "utf-8");
    });
    appended += batch.length;
  } catch (err) {
    console.warn("[central-streaming] events.jsonl への追記に失敗:", err);
  }
}

/** 停止時など、確実に書き切りたいときに呼ぶ。 */
export async function flushNow(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flush();
}

// ---- Retention ----

/**
 * 保持期間・保持件数を超えたイベントを捨て、jsonl を書き直す。
 * 何も捨てるものが無ければファイルには触らない(高頻度で無駄な書き込みをしない)。
 */
export async function purge(): Promise<number> {
  const cutoff = Date.now() - settings.retentionDays * 86_400_000;
  const before = events.length;

  let kept = events.filter((e) => {
    const t = Date.parse(e.receivedAt);
    return Number.isFinite(t) ? t >= cutoff : true;
  });
  if (kept.length > settings.maxEvents) kept = kept.slice(0, settings.maxEvents);

  const removed = before - kept.length;
  lastPurgeAt = new Date().toISOString();
  lastPurged = removed;

  if (removed > 0) {
    events = kept;
    seen = new Set(events.map((e) => e.id));
    await compact();
    console.log(
      `[central-streaming] Retention: ${removed} 件を削除(保持 ${settings.retentionDays} 日 / 最大 ${settings.maxEvents} 件 → 残り ${events.length} 件)`,
    );
  } else if (appended > events.length + 1000) {
    // 捨てるものは無いが、ファイルにだけ古い行が溜まっている(件数上限で splice したぶん)。
    await compact();
  }
  return removed;
}

/** メモリ上の保持内容で jsonl を書き直す(追記の積み上がりを解消する)。 */
async function compact(): Promise<void> {
  await flushNow();
  const body = events
    .slice()
    .reverse() // ファイルは古い順
    .map((e) => JSON.stringify(e))
    .join("\n");
  try {
    await serialize(() => atomicWrite(EVENTS_PATH, body ? body + "\n" : ""));
    appended = events.length;
  } catch (err) {
    console.warn("[central-streaming] events.jsonl の書き直しに失敗:", err);
  }
}

export function startRetentionJob(): void {
  if (purgeTimer) return;
  purgeTimer = setInterval(() => {
    purge().catch((err) => console.error("[central-streaming] Retention ジョブ失敗:", err));
  }, PURGE_INTERVAL_MS);
  purgeTimer.unref?.();
  console.log(
    `[central-streaming] Retention ジョブ開始: ${PURGE_INTERVAL_MS / 60_000} 分ごと ` +
      `(保持 ${settings.retentionDays} 日 / 最大 ${settings.maxEvents} 件)`,
  );
}

// ---- 読み出し ----

export function getEvents(limit = API_MAX_ITEMS): StreamEvent[] {
  return events.slice(0, Math.min(limit, API_MAX_ITEMS));
}

export function storedCount(): number {
  return events.length;
}

/**
 * 指定区間([fromMs, toMs))に発生したイベントを新しい順で返す(41 の日次レポート用)。
 *
 * 一覧 API(getEvents)は画面に流し込む量の上限 API_MAX_ITEMS で頭打ちになるが、
 * 日次集計は「その日に起きた全件」が要るので、保持しているメモリ上の配列を
 * 期間で絞ってそのまま返す(Retention の範囲内にあるものが対象)。
 * 判定は eventAt(発生時刻)を優先し、無ければ receivedAt を使う。
 */
export function getEventsInRange(fromMs: number, toMs: number): StreamEvent[] {
  return events.filter((e) => {
    const t = Date.parse(e.eventAt ?? e.receivedAt);
    return Number.isFinite(t) && t >= fromMs && t < toMs;
  });
}

/** Retention の現在値(日次レポートが「その日のデータが残っているか」を判断するのに使う)。 */
export function retentionDays(): number {
  return settings.retentionDays;
}

export function purgeInfo(): { lastPurgeAt: string | null; lastPurged: number } {
  return { lastPurgeAt, lastPurged };
}

/** 保存済みイベントを全消しする(画面の「保存済みイベントを削除」用)。 */
export async function clearEvents(): Promise<number> {
  const n = events.length;
  events = [];
  seen = new Set();
  pending = [];
  await compact();
  return n;
}
