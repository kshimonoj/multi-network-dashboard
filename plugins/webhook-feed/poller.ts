// Webhook ログ(17 Task 1-4 / Task 2)— ポーリング・差分検知・キャッシュ・設定の永続化。
//
// Global Overview の poller.ts と同じ骨格(settings.json による間隔の永続化、in-flight 共有、
// 最短間隔ガード、スナップショットのファイル書き出し)を踏襲しているが、**設定は完全に別物**。
// data/webhook-feed/settings.json は Global Overview の data/global-overview/settings.json とは
// 独立していて、片方を変えてももう片方には影響しない(Task 3-4)。
//
// 差分検知(Task 1-4):
//   data/webhook-feed/state.json に「シートごとの最終読み取り行番号」を持つ。
//   次回は A{lastRow+1}:Z だけを読むので、行が増えていなければ Sheets からは空配列が返り、
//   キャッシュをそのまま使い回す(Task 2-4)。読み終わっていて次の行がグリッドの外なら
//   範囲自体を投げない(84)。HTTP はメタ 1 本 + シートごとに 1 本(84 で分割。1 シートの
//   失敗が他シートを巻き込まないようにするため。詳細は sheets-client.ts)。
//
// Google Sheets API の読み取り枠は「1 分あたり 300 リクエスト/プロジェクト」。
// 既定 5 分間隔 × HTTP 4 本 = 0.8 req/min なので、枠のほぼ全域が空いたままになる。

import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import type {
  AutoInvestigation,
  SitePrefetch,
  WebhookFeedEnvelope,
  WebhookFeedItem,
  WebhookPollSettings,
  WebhookSheetState,
} from "./feed-types.js";
import { SHEET_SPECS, mapRow } from "./mapping.js";
import { readMeta, readNewRows, SheetsConfigError, spreadsheetId } from "./sheets-client.js";
import {
  AUTO_ENABLED,
  AUTO_MAX_AGE_MS,
  AUTO_MAX_PER_CYCLE,
  annotateSite,
  trigger,
} from "./enrich.js";
import {
  ARCHIVE_RETENTION_ENV_DEFAULT,
  ARCHIVE_RETENTION_OPTIONS_DAYS,
  appendItems,
  clampRetention,
  initArchive,
  prune,
  summarize,
  type ArchiveSummary,
} from "./archive.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR =
  process.env.WEBHOOK_FEED_DATA_DIR || path.resolve(__dirname, "../../data/webhook-feed");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const FEED_PATH = path.join(DATA_DIR, "feed.json");

/** ポーリング間隔の下限/上限。Sheets の枠は緩いが、無駄なポーリングはしない。 */
export const POLL_MIN_MS = 60_000;
export const POLL_MAX_MS = 86_400_000;
/** 画面のプルダウンに出す選択肢(1 / 3 / 5 / 10 / 15 / 30 分 / 1 時間 / 24 時間)。 */
export const POLL_OPTIONS_MS = [
  60_000, 180_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 86_400_000,
];

/**
 * **表示用**にメモリ・feed.json へ持つ行数の上限(古いものから捨てる)。
 *
 * 42 番以降、これは「見せる量」の制限でしかない。**保存の上限ではない。**
 * 受信した行は必ず archive.ts が data/webhook-feed/daily/YYYY-MM-DD.jsonl へ
 * 追記しているので、ここから溢れた行も日次レポートからは正しく数えられる。
 */
const VIEW_MAX_ITEMS = Math.max(200, Number(process.env.WEBHOOK_FEED_MAX_ITEMS ?? 3000));

function clampPoll(ms: number): number {
  if (!Number.isFinite(ms)) return 300_000;
  return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round(ms)));
}

// 既定は 5 分(Task 2-3)。env は初期値のみに効き、以後は settings.json が優先。
const POLL_ENV_DEFAULT_MS = clampPoll(Number(process.env.WEBHOOK_FEED_POLL_MS ?? 300_000));
export const MIN_REFRESH_MS = Math.max(
  15_000,
  Number(process.env.WEBHOOK_FEED_MIN_REFRESH_MS ?? 30_000),
);

let pollIntervalMs = POLL_ENV_DEFAULT_MS;
/** 日別アーカイブの保持日数(0 = 無期限)。表示上限とは完全に別枠(42)。 */
let archiveRetentionDays = ARCHIVE_RETENTION_ENV_DEFAULT;
let timer: NodeJS.Timeout | null = null;

/** /snapshot は 15 秒ごとに叩かれるので、アーカイブの集計結果はキャッシュして返す。 */
let archiveSummary: ArchiveSummary | null = null;
/** 保持期間の整理を最後に実行した時刻(日単位の判定なので毎巡は回さない)。 */
let lastPrunedAt = 0;

async function refreshArchiveSummary(): Promise<void> {
  try {
    archiveSummary = await summarize(archiveRetentionDays);
  } catch (err) {
    console.warn("[webhook-feed] アーカイブ集計に失敗:", err);
  }
}

// ---- 状態(差分検知 + 自動調査の実行済みキー) ----

interface PersistedState {
  /** シート名 → 前回読んだ最終行番号(1 = ヘッダのみ = 未読) */
  lastRows: Record<string, number>;
  /**
   * alertKey → 実行情報。Task 4-3 の「同一アラートには 1 回だけ」を担保する。
   * auto に結果そのものも入れておくので、feed.json を作り直しても調査結果は失われず、
   * 同じアラートの別の行(Active / Cleared)にも同じ結果を出せる。
   */
  autoInvestigated: Record<
    string,
    {
      at: string;
      runId: string | null;
      reason: string;
      auto?: AutoInvestigation;
      siteContext?: SitePrefetch;
    }
  >;
  updatedAt: string | null;
}

let state: PersistedState = { lastRows: {}, autoInvestigated: {}, updatedAt: null };
/** state.json がまだ存在しない = 初回バックフィル。自動調査を発火させない(enrich.ts の条件 5)。 */
let stateLoadedFromDisk = false;

let items: WebhookFeedItem[] = [];
let itemById = new Map<string, WebhookFeedItem>();
let sheetStates: WebhookSheetState[] = SHEET_SPECS.map((s) => ({
  sheet: s.sheet,
  label: s.label,
  source: s.source,
  lastRow: 1,
  newRows: 0,
  items: 0,
  status: "ok",
  error: null,
}));
let spreadsheetTitle: string | null = null;
let sheetTimeZone = "Asia/Tokyo";
let generatedAt: string | null = null;
let cachedAt = 0;
let configError: string | null = null;
let inFlight: Promise<void> | null = null;

// 同じファイルへの書き込みが重なると、片方が先に rename して tmp を消した後で
// もう片方が rename に失敗する(ENOENT)。自動調査の markDone は複数件が同時に走るため、
// ファイルごとに書き込みを直列化する。
const writeChains = new Map<string, Promise<unknown>>();

function atomicWrite(file: string, data: string): Promise<void> {
  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, data, "utf-8");
    await rename(tmp, file);
  });
  // チェーンが 1 度の失敗で止まらないよう、保持するのは catch 済みの Promise にする。
  writeChains.set(
    file,
    next.catch(() => undefined),
  );
  return next;
}

async function persistState(): Promise<void> {
  state.updatedAt = new Date().toISOString();
  try {
    await atomicWrite(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    console.warn("[webhook-feed] state.json の保存に失敗:", err);
  }
}

// 行の更新(自動調査の進行など)は連続して起きるので、書き出しは 1 秒でまとめる。
let feedPersistTimer: NodeJS.Timeout | null = null;
function persistFeedSoon(): void {
  if (feedPersistTimer) return;
  feedPersistTimer = setTimeout(() => {
    feedPersistTimer = null;
    void persistFeed();
  }, 1000);
  feedPersistTimer.unref?.();
}

async function persistFeed(): Promise<void> {
  try {
    await atomicWrite(
      FEED_PATH,
      JSON.stringify({ generatedAt, spreadsheetTitle, sheetTimeZone, sheetStates, items }, null, 2) + "\n",
    );
  } catch (err) {
    console.warn("[webhook-feed] feed.json の保存に失敗:", err);
  }
}

/** 起動時に state.json / feed.json / settings.json を読み戻す(Sheets は叩かない)。 */
export async function loadPersisted(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf-8")) as Partial<PersistedState>;
    state = {
      lastRows: parsed.lastRows ?? {},
      autoInvestigated: parsed.autoInvestigated ?? {},
      updatedAt: parsed.updatedAt ?? null,
    };
    stateLoadedFromDisk = true;
    console.log(
      `[webhook-feed] state.json を読み込みました(lastRows=${JSON.stringify(state.lastRows)} ` +
        `自動調査済み ${Object.keys(state.autoInvestigated).length} 件)`,
    );
  } catch {
    console.log("[webhook-feed] state.json がありません。初回はシート全件を読み込みます(自動調査は発火させません)。");
  }

  try {
    const parsed = JSON.parse(await readFile(FEED_PATH, "utf-8")) as {
      generatedAt?: string;
      spreadsheetTitle?: string;
      sheetTimeZone?: string;
      sheetStates?: WebhookSheetState[];
      items?: WebhookFeedItem[];
    };
    if (Array.isArray(parsed.items)) {
      items = parsed.items;
      itemById = new Map(items.map((i) => [i.id, i]));
      generatedAt = parsed.generatedAt ?? null;
      cachedAt = generatedAt ? new Date(generatedAt).getTime() || 0 : 0;
      spreadsheetTitle = parsed.spreadsheetTitle ?? null;
      sheetTimeZone = parsed.sheetTimeZone ?? sheetTimeZone;
      if (Array.isArray(parsed.sheetStates) && parsed.sheetStates.length) sheetStates = parsed.sheetStates;
      // 前回プロセスが「実行中」のまま落ちた自動調査は、再開できないので失敗扱いにする。
      for (const i of items) {
        if (i.auto?.status === "running") {
          i.auto.status = "error";
          i.auto.error = "アプリの再起動により中断されました";
          i.auto.finishedAt = new Date().toISOString();
        }
      }
      for (const rec of Object.values(state.autoInvestigated)) {
        if (rec.auto?.status === "running") {
          rec.auto.status = "error";
          rec.auto.error = "アプリの再起動により中断されました";
          rec.auto.finishedAt = new Date().toISOString();
        }
      }
      console.log(`[webhook-feed] 前回のフィードを読み込みました(${items.length} 件 / ${generatedAt})`);
    }
  } catch {
    /* 無ければ空から始める */
  }
}

// ---- 設定(ポーリング間隔)----

export function getPollIntervalMs(): number {
  return pollIntervalMs;
}

export function getSettings(): WebhookPollSettings {
  return {
    pollIntervalMs,
    minRefreshMs: MIN_REFRESH_MS,
    minMs: POLL_MIN_MS,
    maxMs: POLL_MAX_MS,
    optionsMs: POLL_OPTIONS_MS,
    archiveRetentionDays,
    archiveRetentionOptionsDays: ARCHIVE_RETENTION_OPTIONS_DAYS,
    viewMaxItems: VIEW_MAX_ITEMS,
  };
}

async function persistSettings(): Promise<void> {
  await atomicWrite(
    SETTINGS_PATH,
    JSON.stringify({ pollIntervalMs, archiveRetentionDays }, null, 2) + "\n",
  );
}

export async function loadSettings(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_PATH, "utf-8")) as {
      pollIntervalMs?: unknown;
      archiveRetentionDays?: unknown;
    };
    const n = Number(parsed?.pollIntervalMs);
    if (Number.isFinite(n)) {
      pollIntervalMs = clampPoll(n);
      console.log(`[webhook-feed] ポーリング間隔を settings.json から復元: ${pollIntervalMs / 1000}s`);
    }
    if (parsed?.archiveRetentionDays !== undefined) {
      archiveRetentionDays = clampRetention(parsed.archiveRetentionDays);
      console.log(
        `[webhook-feed] アーカイブ保持日数を settings.json から復元: ` +
          `${archiveRetentionDays === 0 ? "無期限" : `${archiveRetentionDays} 日`}`,
      );
    }
  } catch {
    /* 無ければ env 既定(5 分 / 90 日)*/
  }
}

export async function setPollInterval(ms: number): Promise<WebhookPollSettings> {
  const next = clampPoll(ms);
  const changed = next !== pollIntervalMs;
  pollIntervalMs = next;
  try {
    await persistSettings();
  } catch (err) {
    console.warn("[webhook-feed] 設定の保存に失敗:", err);
  }
  if (changed && timer) {
    clearInterval(timer);
    timer = null;
    startPolling();
    console.log(`[webhook-feed] ポーリング間隔を変更: ${pollIntervalMs / 1000}s`);
  }
  return getSettings();
}

/** 日別アーカイブの保持日数を変える。短くした場合はその場で古い日を消す。 */
export async function setArchiveRetentionDays(days: number): Promise<WebhookPollSettings> {
  archiveRetentionDays = clampRetention(days);
  try {
    await persistSettings();
  } catch (err) {
    console.warn("[webhook-feed] 設定の保存に失敗:", err);
  }
  await prune(archiveRetentionDays);
  await refreshArchiveSummary();
  console.log(
    `[webhook-feed] アーカイブ保持日数を変更: ${archiveRetentionDays === 0 ? "無期限" : `${archiveRetentionDays} 日`}`,
  );
  return getSettings();
}

export function getArchiveRetentionDays(): number {
  return archiveRetentionDays;
}

export function getArchiveSummary(): ArchiveSummary | null {
  return archiveSummary;
}

/**
 * 起動時のアーカイブ初期化(移行 + 整理)。loadPersisted / loadSettings の後に呼ぶ。
 * 移行元は feed.json から読み戻した表示用キャッシュ = 旧方式で残っていた全件。
 */
export async function initArchiveStore(): Promise<void> {
  try {
    await initArchive(items);
    await prune(archiveRetentionDays);
    await refreshArchiveSummary();
    const s = archiveSummary;
    if (s) {
      console.log(
        `[webhook-feed] アーカイブ: ${s.days} 日分 / ${s.items} 件 / ${(s.bytes / 1048576).toFixed(1)}MB ` +
          `(${s.oldestDay ?? "-"} 〜 ${s.newestDay ?? "-"} / 保持 ${s.retentionDays === 0 ? "無期限" : `${s.retentionDays} 日`}` +
          ` / 表示は直近 ${VIEW_MAX_ITEMS} 件)`,
      );
    }
  } catch (err) {
    console.warn("[webhook-feed] アーカイブの初期化に失敗:", err);
  }
}

// ---- 封筒 ----

function envelope(): WebhookFeedEnvelope {
  const ageMs = generatedAt ? Date.now() - cachedAt : null;
  return {
    generatedAt,
    ageMs,
    stale: ageMs === null || ageMs > pollIntervalMs * 1.5,
    pollIntervalMs,
    minRefreshMs: MIN_REFRESH_MS,
    configured: configError === null,
    configError,
    spreadsheetTitle,
    sheets: sheetStates,
    items,
    auto: {
      enabled: AUTO_ENABLED,
      maxPerCycle: AUTO_MAX_PER_CYCLE,
      maxAgeMs: AUTO_MAX_AGE_MS,
      investigatedCount: Object.keys(state.autoInvestigated).length,
    },
    // 42: 「表示している件数」と「保存している件数」は別物。画面のフッタで両方を出す。
    storage: {
      viewMaxItems: VIEW_MAX_ITEMS,
      viewItems: items.length,
      retentionDays: archiveRetentionDays,
      days: archiveSummary?.days ?? 0,
      items: archiveSummary?.items ?? 0,
      bytes: archiveSummary?.bytes ?? 0,
      oldestDay: archiveSummary?.oldestDay ?? null,
      newestDay: archiveSummary?.newestDay ?? null,
    },
  };
}

export function getCachedFeed(): WebhookFeedEnvelope {
  return envelope();
}

// ---- 取得 ----

function sortItems(): void {
  // 受信時刻の新しい順。時刻が取れない行は末尾へ。
  items.sort((a, b) => {
    const av = a.receivedAt ?? a.eventAt ?? "";
    const bv = b.receivedAt ?? b.eventAt ?? "";
    if (av === bv) return b.rowIndex - a.rowIndex;
    if (!av) return 1;
    if (!bv) return -1;
    return av < bv ? 1 : -1;
  });
  // 表示用キャッシュの頭打ち。ここで捨てた行は archive(日別 jsonl)に残っている。
  if (items.length > VIEW_MAX_ITEMS) items = items.slice(0, VIEW_MAX_ITEMS);
  itemById = new Map(items.map((i) => [i.id, i]));
}

async function doRefresh(): Promise<void> {
  // 設定チェック(スプレッドシート ID / サービスアカウント鍵)。
  try {
    spreadsheetId();
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
    console.warn(`[webhook-feed] ${configError}`);
    return;
  }

  const initialBackfill = !stateLoadedFromDisk;

  let meta: Awaited<ReturnType<typeof readMeta>>;
  try {
    meta = await readMeta();
  } catch (err) {
    configError =
      err instanceof SheetsConfigError
        ? err.message
        : `スプレッドシートのメタ取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[webhook-feed] ${configError}`);
    return;
  }
  configError = null;
  spreadsheetTitle = meta.title;
  sheetTimeZone = meta.timeZone;

  const present = SHEET_SPECS.filter((s) => meta.sheetNames.includes(s.sheet));
  const missing = SHEET_SPECS.filter((s) => !meta.sheetNames.includes(s.sheet));

  let read: Awaited<ReturnType<typeof readNewRows>>;
  try {
    read = await readNewRows(
      present.map((s) => s.sheet),
      state.lastRows,
      meta.rowCounts,
    );
  } catch (err) {
    // シートごとの失敗は readNewRows 内で各シートの error に閉じ込めている。
    // ここに来るのは認証など、全シートに共通する失敗だけ。
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[webhook-feed] シートの読み取りに失敗: ${msg}`);
    sheetStates = sheetStates.map((s) => ({ ...s, status: "error", error: msg, newRows: 0 }));
    return;
  }

  const newItems: WebhookFeedItem[] = [];
  const nextSheetStates: WebhookSheetState[] = [];

  for (const spec of SHEET_SPECS) {
    if (missing.includes(spec)) {
      nextSheetStates.push({
        sheet: spec.sheet,
        label: spec.label,
        source: spec.source,
        lastRow: state.lastRows[spec.sheet] ?? 1,
        newRows: 0,
        items: items.filter((i) => i.source === spec.source).length,
        status: "error",
        error: `スプレッドシートに「${spec.sheet}」シートがありません`,
      });
      continue;
    }
    const r = read.sheets.find((x) => x.sheet === spec.sheet);
    if (!r) continue;

    if (r.error) {
      // このシートだけ失敗。読み取り位置は進めず、次回同じ行から読み直す。
      console.warn(`[webhook-feed] ${spec.sheet} の読み取りに失敗: ${r.error}`);
      nextSheetStates.push({
        sheet: spec.sheet,
        label: spec.label,
        source: spec.source,
        lastRow: state.lastRows[spec.sheet] ?? 1,
        newRows: 0,
        items: 0, // 下でまとめて数える
        status: "error",
        error: r.error,
      });
      continue;
    }

    if (r.resynced) {
      // シートがクリアされた。そのソースの既存行を捨てて読み直したぶんで置き換える。
      items = items.filter((i) => i.source !== spec.source);
    }

    let mapped = 0;
    for (const row of r.rows) {
      const item = mapRow(spec, r.headers, row.rowIndex, row.values, { timeZone: sheetTimeZone });
      if (!item) continue;
      annotateSite(item);
      // 同じアラートを既に自動調査済みなら、その結果をこの行にも付ける
      // (フィードを作り直した後でも、Active / Cleared の両方の行に同じ結果が出る)。
      const done = state.autoInvestigated[item.alertKey];
      if (done?.auto) item.auto = done.auto;
      if (done?.siteContext) item.siteContext = done.siteContext;
      // 同じ行番号を読み直した場合(resync)に備えて上書きにする。
      const prev = itemById.get(item.id);
      if (prev) {
        // 既に自動調査・先読みが付いている行は、その結果を引き継ぐ。
        item.auto = prev.auto;
        item.siteContext = prev.siteContext;
        items[items.indexOf(prev)] = item;
      } else {
        items.push(item);
      }
      itemById.set(item.id, item);
      newItems.push(item);
      mapped += 1;
    }

    state.lastRows[spec.sheet] = r.lastRow;
    nextSheetStates.push({
      sheet: spec.sheet,
      label: spec.label,
      source: spec.source,
      lastRow: r.lastRow,
      newRows: mapped,
      items: 0, // 下でまとめて数える
      status: "ok",
      error: null,
    });
  }

  // 42: 表示用キャッシュを頭打ちにする **前に**、取り込んだ行を日別アーカイブへ追記する。
  // ここが保存の正本であり、以降の切り捨てはあくまで「見せる量」の話になる。
  let archived = { appended: 0, skipped: 0 };
  try {
    archived = await appendItems(newItems);
  } catch (err) {
    console.warn("[webhook-feed] アーカイブへの追記に失敗:", err);
  }

  sortItems();
  for (const s of nextSheetStates) {
    s.items = items.filter((i) => i.source === s.source).length;
  }
  sheetStates = nextSheetStates;
  generatedAt = new Date().toISOString();
  cachedAt = Date.now();

  // Task 4 / Task 5: 新規に取り込んだ行に対してだけ仕掛ける。
  const fired = trigger(
    newItems,
    {
      isDone: (key) => Boolean(state.autoInvestigated[key]),
      markDone: (key, info) => {
        state.autoInvestigated[key] = {
          at: state.autoInvestigated[key]?.at ?? new Date().toISOString(),
          runId: info.runId,
          reason: info.reason,
          // 部分更新を許す(先読み完了 → 調査完了 の 2 段で書かれる)。
          ...(state.autoInvestigated[key]?.auto ? { auto: state.autoInvestigated[key].auto } : {}),
          ...(state.autoInvestigated[key]?.siteContext
            ? { siteContext: state.autoInvestigated[key].siteContext }
            : {}),
          ...(info.auto ? { auto: info.auto } : {}),
          ...(info.siteContext ? { siteContext: info.siteContext } : {}),
        };
        void persistState();
      },
      // 調査結果は「アラート単位」なので、同じ alertKey の行すべてに反映する
      // (Active と Cleared のように 1 アラートが複数行になるソースがあるため)。
      onItemUpdated: (updated) => {
        for (const i of items) {
          if (i !== updated && i.alertKey === updated.alertKey) {
            i.auto = updated.auto;
            if (updated.siteContext && !i.siteContext) i.siteContext = updated.siteContext;
          }
        }
        persistFeedSoon();
      },
    },
    initialBackfill,
  );

  // 初回バックフィルが終わったので、以降は通常運用(state.json も作られる)。
  stateLoadedFromDisk = true;
  await persistState();
  await persistFeed();

  // 保持期間の整理は 1 時間に 1 回でよい(日単位の話なので毎巡やる意味が無い)。
  if (Date.now() - lastPrunedAt > 3_600_000) {
    lastPrunedAt = Date.now();
    await prune(archiveRetentionDays).catch((err) =>
      console.warn("[webhook-feed] アーカイブの整理に失敗:", err),
    );
  }
  if (archived.appended || !archiveSummary) await refreshArchiveSummary();

  const totalNew = newItems.length;
  console.log(
    `[webhook-feed] refresh 完了: 新規 ${totalNew} 行 / 表示 ${items.length} 件 ` +
      `/ 保存 ${archived.appended} 行追記(累計 ${archiveSummary?.items ?? "?"} 件 / ${archiveSummary?.days ?? "?"} 日分)` +
      ` (${sheetStates.map((s) => `${s.label}=${s.newRows}`).join(" ")}) HTTP ${read.requests} 本` +
      (fired.fired ? ` / 自動調査 ${fired.fired} 件を起動` : "") +
      (fired.suppressed ? ` / 初回バックフィルのため ${fired.suppressed} 件は抑止` : ""),
  );
}

/**
 * キャッシュを尊重した refresh。
 * - 進行中があれば相乗り(同時実行しない)
 * - force でなければポーリング間隔の 95% 以内は Sheets を叩かない
 * - force でも最短間隔 MIN_REFRESH_MS 以内は叩かない(連打対策)
 */
export async function refresh(opts: { force?: boolean } = {}): Promise<WebhookFeedEnvelope> {
  if (inFlight) {
    await inFlight.catch(() => undefined);
    return envelope();
  }
  const age = generatedAt ? Date.now() - cachedAt : Infinity;
  const minAge = opts.force ? MIN_REFRESH_MS : pollIntervalMs * 0.95;
  if (age < minAge) return envelope();

  inFlight = doRefresh();
  try {
    await inFlight;
  } catch (err) {
    console.error("[webhook-feed] refresh でエラー:", err);
  } finally {
    inFlight = null;
  }
  return envelope();
}

export function startPolling(): void {
  if (timer) return;
  const tick = () => {
    refresh().catch((err) => console.error("[webhook-feed] ポーリング失敗:", err));
  };
  tick();
  timer = setInterval(tick, pollIntervalMs);
  timer.unref?.();
  console.log(
    `[webhook-feed] ポーリング開始: ${pollIntervalMs / 1000}s 間隔 / 1 巡につき Sheets API メタ 1 本 + シートごとに 1 本` +
      `(自動事前調査 ${AUTO_ENABLED ? `有効・最大 ${AUTO_MAX_PER_CYCLE} 件/巡` : "無効"})`,
  );
}
