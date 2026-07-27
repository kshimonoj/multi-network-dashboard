// Global Overview — ポーリングとキャッシュ
//
// レート制限への配慮(instructions/05_findings.md の Task 2):
//  - refresh 1 回で出る HTTP は Central 3 本 + Mist 3 本 = 6 本(トークンは約 2 時間キャッシュ)。
//  - 既定のポーリング間隔は 5 分(GLOBAL_OVERVIEW_POLL_MS。12 番で 3 分→5 分)。6 req / 300s = 0.02 req/sec。
//    Central の枠は 10 req/sec(アカウント共有)なので、平均使用率は 0.2% 程度に収まる。
//    間隔は画面のプルダウンから 1/3/5/10/15 分に変更でき、settings.json に永続化される(下限 1 分)。
//  - 手動 refresh は最短間隔(GLOBAL_OVERVIEW_MIN_REFRESH_MS、既定 60 秒)でガードする。
//    連打されても Central/Mist には出さず、キャッシュを返す(force=1 でも従う)。
//  - 同時に複数の refresh が走らないよう、進行中の Promise を共有する。
//
// キャッシュ:
//  - プロセス内メモリが一次。data/global-overview/snapshot.json に書き出して、
//    再起動直後でも(古いことを明示したうえで)即座に返せるようにする。
//    CLAUDE.md の "filesystem as database" に沿い、書き込みは refresh を起こした側だけの責務。

import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { CentralClient } from "./central-client.js";
import { MistClient } from "./mist-client.js";
import { buildSnapshot, type Snapshot } from "./aggregate.js";
import type { LimiterStats } from "./rate-limit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR =
  process.env.GLOBAL_OVERVIEW_DATA_DIR || path.resolve(__dirname, "../../data/global-overview");
const SNAPSHOT_PATH = path.join(DATA_DIR, "snapshot.json");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

// ポーリング間隔の下限/上限(レート制限を圧迫しない範囲。1 分未満は選べない)。
export const POLL_MIN_MS = 60_000;
export const POLL_MAX_MS = 3_600_000;
/** 画面のプルダウンに出す選択肢(1 / 3 / 5 / 10 / 15 分)。 */
export const POLL_OPTIONS_MS = [60_000, 180_000, 300_000, 600_000, 900_000];

function clampPoll(ms: number): number {
  if (!Number.isFinite(ms)) return 300_000;
  return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round(ms)));
}

// 既定は 5 分(12 番で 3 分→5 分に変更)。env は初期値のみに効き、以後は settings.json が優先。
const POLL_ENV_DEFAULT_MS = clampPoll(Number(process.env.GLOBAL_OVERVIEW_POLL_MS ?? 300_000));
export const MIN_REFRESH_MS = Math.max(30_000, Number(process.env.GLOBAL_OVERVIEW_MIN_REFRESH_MS ?? 60_000));

// 現在のポーリング間隔(可変)。settings.json / API から変更でき、setInterval を張り直して反映する。
let pollIntervalMs = POLL_ENV_DEFAULT_MS;

/** 現在のポーリング間隔(ms)。 */
export function getPollIntervalMs(): number {
  return pollIntervalMs;
}

let central: CentralClient | null = null;
let centralInitError: string | null = null;
let mist: MistClient | null = null;
let mistInitError: string | null = null;

/**
 * ポーラーが使っているのと同じ Central/Mist クライアント実体を返す。
 * トークンキャッシュとレートリミッタを詳細取得(site-detail.ts)と共有するため公開する。
 */
export function getClients(): { central: CentralClient | null; mist: MistClient | null } {
  return clients();
}

function clients(): { central: CentralClient | null; mist: MistClient | null } {
  if (!central && !centralInitError) {
    try {
      central = CentralClient.isConfigured() ? new CentralClient() : null;
      if (!central) centralInitError = "Central の認証情報が未設定です(CENTRAL_BASE_URL / CENTRAL_CLIENT_ID / CENTRAL_CLIENT_SECRET)";
    } catch (err) {
      centralInitError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!mist && !mistInitError) {
    try {
      mist = MistClient.isConfigured() ? new MistClient() : null;
      if (!mist) mistInitError = "Mist の認証情報が未設定です(MIST_API_TOKEN)";
    } catch (err) {
      mistInitError = err instanceof Error ? err.message : String(err);
    }
  }
  return { central, mist };
}

let cached: Snapshot | null = null;
let cachedAt = 0;
let inFlight: Promise<Snapshot> | null = null;
let timer: NodeJS.Timeout | null = null;

export interface SnapshotEnvelope {
  snapshot: Snapshot | null;
  /** キャッシュ生成からの経過ミリ秒 */
  ageMs: number | null;
  /** ポーリング間隔より古い = 次の巡回待ち */
  stale: boolean;
  pollIntervalMs: number;
  minRefreshMs: number;
  rateLimit: { central: LimiterStats | null; mist: LimiterStats | null };
}

function envelope(): SnapshotEnvelope {
  const { central: c, mist: m } = clients();
  const ageMs = cached ? Date.now() - cachedAt : null;
  return {
    snapshot: cached,
    ageMs,
    stale: ageMs === null || ageMs > pollIntervalMs * 1.5,
    pollIntervalMs,
    minRefreshMs: MIN_REFRESH_MS,
    rateLimit: { central: c ? c.getLimiterStats() : null, mist: m ? m.getLimiterStats() : null },
  };
}

async function persist(snapshot: Snapshot): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    // 書き込み途中のファイルを読ませないよう、一時ファイル → rename で差し替える。
    const tmp = `${SNAPSHOT_PATH}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
    await rename(tmp, SNAPSHOT_PATH);
  } catch (err) {
    console.warn(`[global-overview] スナップショットの保存に失敗:`, err);
  }
}

/** ポーリング間隔の設定を settings.json に永続化する(コンテナ再作成後も保持)。 */
async function persistSettings(): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = `${SETTINGS_PATH}.tmp`;
    await writeFile(tmp, JSON.stringify({ pollIntervalMs }, null, 2) + "\n", "utf-8");
    await rename(tmp, SETTINGS_PATH);
  } catch (err) {
    console.warn(`[global-overview] 設定の保存に失敗:`, err);
  }
}

/**
 * 起動時に settings.json を読んでポーリング間隔を復元する(env 既定より優先)。
 * startPolling() より前に呼ぶこと。
 */
export async function loadSettings(): Promise<void> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { pollIntervalMs?: unknown };
    const n = Number(parsed?.pollIntervalMs);
    if (Number.isFinite(n)) {
      pollIntervalMs = clampPoll(n);
      console.log(`[global-overview] ポーリング間隔を settings.json から復元: ${pollIntervalMs / 1000}s`);
    }
  } catch {
    /* 無ければ env 既定(5 分)のまま */
  }
}

export interface PollSettings {
  pollIntervalMs: number;
  minRefreshMs: number;
  minMs: number;
  maxMs: number;
  optionsMs: number[];
}

export function getSettings(): PollSettings {
  return {
    pollIntervalMs,
    minRefreshMs: MIN_REFRESH_MS,
    minMs: POLL_MIN_MS,
    maxMs: POLL_MAX_MS,
    optionsMs: POLL_OPTIONS_MS,
  };
}

/**
 * ポーリング間隔を変更する。下限/上限にクランプし、settings.json に永続化して
 * 走行中のタイマーを新しい間隔で張り直す(即反映)。
 */
export async function setPollInterval(ms: number): Promise<PollSettings> {
  const next = clampPoll(ms);
  const changed = next !== pollIntervalMs;
  pollIntervalMs = next;
  await persistSettings();
  if (changed && timer) {
    clearInterval(timer);
    timer = null;
    startPolling(); // 新しい間隔でタイマーを張り直す(startPolling は timer が null のときだけ動く)
    console.log(`[global-overview] ポーリング間隔を変更: ${pollIntervalMs / 1000}s`);
  }
  return getSettings();
}

/** 起動時に、前回プロセスが残したスナップショットを読み戻す(API を叩かない)。 */
export async function loadPersisted(): Promise<void> {
  if (cached) return;
  try {
    const raw = await readFile(SNAPSHOT_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Snapshot;
    if (parsed?.generatedAt) {
      cached = parsed;
      cachedAt = new Date(parsed.generatedAt).getTime() || 0;
      console.log(`[global-overview] 前回のスナップショットを読み込みました(${parsed.generatedAt})`);
    }
  } catch {
    /* 無ければ何もしない */
  }
}

/** 実際に Central / Mist を叩いてスナップショットを作り直す。 */
async function doRefresh(): Promise<Snapshot> {
  const { central: c, mist: m } = clients();

  const [centralRes, mistRes] = await Promise.all([
    (async () => {
      if (!c) return { error: centralInitError ?? "Central クライアント未初期化" };
      try {
        return { raw: await c.getRaw() };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[global-overview/central] 取得に失敗: ${msg}`);
        return { error: msg };
      }
    })(),
    (async () => {
      if (!m) return { error: mistInitError ?? "Mist クライアント未初期化" };
      try {
        return { raw: await m.getRaw() };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[global-overview/mist] 取得に失敗: ${msg}`);
        return { error: msg };
      }
    })(),
  ]);

  const snapshot = await buildSnapshot({ central: centralRes, mist: mistRes });

  // 両方失敗したときは既存キャッシュを壊さない(site-map.ts と同じ方針)。
  if (!snapshot.platforms.central.ok && !snapshot.platforms.mist.ok && cached) {
    console.warn("[global-overview] 両プラットフォームの取得に失敗。既存キャッシュを保持します。");
    return cached;
  }

  cached = snapshot;
  cachedAt = Date.now();
  await persist(snapshot);
  console.log(
    `[global-overview] refresh 完了: sites=${snapshot.totals.sites} devices=${snapshot.totals.devices}` +
      ` (up ${snapshot.totals.devicesUp}) clients=${snapshot.totals.clients} alerts=${snapshot.totals.alerts}` +
      ` / HTTP central=${snapshot.platforms.central.requests} mist=${snapshot.platforms.mist.requests}`,
  );
  return snapshot;
}

/**
 * キャッシュを尊重した refresh。
 * - 進行中のものがあれば、それに相乗りする(同時実行しない)。
 * - 最短間隔 MIN_REFRESH_MS 以内の再要求はキャッシュを返す(API を叩かない)。
 */
export async function refresh(opts: { force?: boolean } = {}): Promise<SnapshotEnvelope> {
  if (inFlight) {
    await inFlight.catch(() => undefined);
    return envelope();
  }
  const age = cached ? Date.now() - cachedAt : Infinity;
  // 定期ポーリングの閾値は間隔ちょうどではなく 5% 手前にする。setInterval の揺らぎで
  // age がわずかに間隔未満になり、その巡回が丸ごと空振りする(実質 2 倍間隔になる)のを避ける。
  const minAge = opts.force ? MIN_REFRESH_MS : pollIntervalMs * 0.95;
  if (age < minAge) return envelope();

  inFlight = doRefresh();
  try {
    await inFlight;
  } catch (err) {
    console.error("[global-overview] refresh でエラー:", err);
  } finally {
    inFlight = null;
  }
  return envelope();
}

/** キャッシュをそのまま返す(API は叩かない)。 */
export function getCached(): SnapshotEnvelope {
  return envelope();
}

/** 定期ポーリングを開始する。多重起動は無視する。 */
export function startPolling(): void {
  if (timer) return;
  const tick = () => {
    refresh().catch((err) => console.error("[global-overview] ポーリング失敗:", err));
  };
  // 起動直後に 1 回(キャッシュが十分新しければ refresh() 側で API を叩かずに戻る)。
  tick();
  timer = setInterval(tick, pollIntervalMs);
  timer.unref?.();
  console.log(
    `[global-overview] ポーリング開始: ${pollIntervalMs / 1000}s 間隔 / 1 巡につき HTTP 6 本` +
      `(Central 3 + Mist 3。Central の枠 10 req/sec に対し平均 ${(6 / (pollIntervalMs / 1000) / 10 * 100).toFixed(1)}%)`,
  );
}
