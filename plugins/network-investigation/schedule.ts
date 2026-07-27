// Network Investigation — 定期実行の設定
//
// CLAUDE.md「filesystem as database」: 設定の真実は2つのプレーン JSON。
//   - scheduled-queries.json … 何を調べるか(id / query / site? / model? / enabled)の配列。CRUD 対象。
//   - schedule-config.json    … いつ実行するか(hour / minute / frequency / dayOfWeek? / enabled)。
//
// ---- 移植時の変更点(Corstack 版との差分) ----
// 1) 実行トリガを **launchd → node-cron** に差し替えた。
//    コンテナ内には launchd も launchctl も存在しないため、plist 生成 + launchctl unload/load は
//    そのままでは機能しない。代わりに同一プロセス内で node-cron のジョブを保持し、
//    schedule-config.json が更新されるたびに張り替える(= 自己完結)。
//    実行対象(runScheduledInvestigation → runInsightAgent)は移植元から一切変更していない。
// 2) 設定 JSON の置き場を、プラグインディレクトリ配下から **data/ 配下** へ移した。
//    Docker イメージを作り直しても UI で編集した設定が消えないようにするため。
//    初回起動時にリポジトリ同梱のシード(このディレクトリの *.json)から複製する。

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import cron, { type ScheduledTask } from "node-cron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 設定の実体(書き込み先)。api.ts / site-map.ts の DATA_DIR と同じ場所。
const DATA_DIR =
  process.env.NETINV_DATA_DIR || path.resolve(__dirname, "../../data/network-investigation");
const QUERIES_PATH = path.join(DATA_DIR, "scheduled-queries.json");
const CONFIG_PATH = path.join(DATA_DIR, "schedule-config.json");

// 初回起動時の複製元(リポジトリ同梱・読み取り専用扱い)。
const SEED_QUERIES_PATH = path.join(__dirname, "scheduled-queries.json");
const SEED_CONFIG_PATH = path.join(__dirname, "schedule-config.json");

// cron のタイムゾーン。launchd の StartCalendarInterval は「マシンのローカル時刻」で発火していた。
// コンテナの既定 TZ は UTC なので、同じ時刻に発火させるには明示が要る(docker-compose で TZ を渡す)。
const CRON_TZ = process.env.TZ || "Asia/Tokyo";

export interface ScheduledQuery {
  id: string;
  query: string;
  site?: string | null;
  enabled: boolean;
  model?: string | null; // 使用モデル(未指定なら既定モデル)
}

export interface ScheduleConfig {
  hour: number; // 0-23
  minute: number; // 0-59
  frequency: "daily" | "weekly";
  dayOfWeek?: number; // 0=日曜 … 6=土曜(frequency=weekly のとき使う)
  enabled: boolean; // false のとき cron ジョブを止め、定期実行を行わない
}

const DEFAULT_CONFIG: ScheduleConfig = { hour: 7, minute: 0, frequency: "daily", enabled: true };

// ---- 初回シード ----

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// data/ 側に設定ファイルが無ければ、同梱シードから複製する。
// シードも無ければ何もしない(read 側が既定値へフォールバックする)。
export async function seedScheduleFiles(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  for (const [target, seed] of [
    [QUERIES_PATH, SEED_QUERIES_PATH],
    [CONFIG_PATH, SEED_CONFIG_PATH],
  ] as const) {
    if (await exists(target)) continue;
    try {
      await writeFile(target, await readFile(seed, "utf-8"), "utf-8");
      console.log(`[network-investigation] 初期設定を複製しました: ${target}`);
    } catch {
      /* シードが無い場合は既定値で動く */
    }
  }
}

// ---- scheduled-queries.json ----

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? Math.floor(v) : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function normalizeQuery(raw: unknown): ScheduledQuery | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const query = typeof o.query === "string" ? o.query.trim() : "";
  if (!query) return null;
  return {
    id: typeof o.id === "string" && o.id ? o.id : randomUUID(),
    query,
    site: typeof o.site === "string" && o.site.trim() ? o.site.trim() : null,
    enabled: o.enabled !== false,
    model: typeof o.model === "string" && o.model.trim() ? o.model.trim() : null,
  };
}

export async function readScheduledQueries(): Promise<ScheduledQuery[]> {
  try {
    const raw = await readFile(QUERIES_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.queries) ? parsed.queries : [];
    return arr.map(normalizeQuery).filter((q: ScheduledQuery | null): q is ScheduledQuery => q != null);
  } catch {
    return [];
  }
}

export async function writeScheduledQueries(queries: ScheduledQuery[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(QUERIES_PATH, JSON.stringify(queries, null, 2) + "\n", "utf-8");
}

// ---- schedule-config.json ----

export async function readScheduleConfig(): Promise<ScheduleConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const p = JSON.parse(raw);
    const frequency = p.frequency === "weekly" ? "weekly" : "daily";
    const cfg: ScheduleConfig = {
      hour: clampInt(p.hour, 0, 23, DEFAULT_CONFIG.hour),
      minute: clampInt(p.minute, 0, 59, DEFAULT_CONFIG.minute),
      frequency,
      enabled: p.enabled !== false,
    };
    if (frequency === "weekly") cfg.dayOfWeek = clampInt(p.dayOfWeek, 0, 6, 1);
    return cfg;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function normalizeScheduleConfig(raw: unknown): ScheduleConfig {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const frequency = p.frequency === "weekly" ? "weekly" : "daily";
  const cfg: ScheduleConfig = {
    hour: clampInt(p.hour, 0, 23, DEFAULT_CONFIG.hour),
    minute: clampInt(p.minute, 0, 59, DEFAULT_CONFIG.minute),
    frequency,
    enabled: p.enabled !== false,
  };
  if (frequency === "weekly") cfg.dayOfWeek = clampInt(p.dayOfWeek, 0, 6, 1);
  return cfg;
}

export async function writeScheduleConfig(cfg: ScheduleConfig): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

// ---- node-cron による定期実行(launchd plist の置き換え) ----

/**
 * ScheduleConfig を cron 式(5 フィールド: 分 時 日 月 曜日)へ変換する。
 *
 * launchd の StartCalendarInterval との対応:
 *   daily  { Hour: H, Minute: M }              → "M H * * *"
 *   weekly { Hour: H, Minute: M, Weekday: D }  → "M H * * D"
 * launchd の Weekday も node-cron の曜日も 0=日曜 … 6=土曜なので、値はそのまま使える。
 */
export function buildCronExpression(cfg: ScheduleConfig): string {
  const dow = cfg.frequency === "weekly" ? String(cfg.dayOfWeek ?? 1) : "*";
  return `${cfg.minute} ${cfg.hour} * * ${dow}`;
}

// 現在張られている cron ジョブ(1本だけ持つ)。
let currentTask: ScheduledTask | null = null;
let currentExpression: string | null = null;

// 定期実行の実体。api.ts が起動時に runScheduledInvestigation を注入する
// (schedule.ts → api.ts の循環 import を避けるための注入。実行対象の関数自体は移植元のまま)。
type Runner = () => Promise<unknown>;
let runner: Runner | null = null;

export function setScheduledRunner(fn: Runner): void {
  runner = fn;
}

export interface ScheduleSyncResult {
  ok: boolean;
  /** 実際に張った cron 式(無効時は null) */
  expression: string | null;
  /** cron ジョブが動いているか */
  loaded: boolean;
  detail: string;
}

/**
 * schedule-config.json の内容で cron ジョブを張り直す。
 * launchd 版の regenerateLaunchd() と同じ位置づけ(plist 再生成 → unload → load の置き換え)。
 * enabled=false のときはジョブを破棄するだけで、定期実行を止める。
 */
export function applySchedule(cfg: ScheduleConfig): ScheduleSyncResult {
  // 既存ジョブを必ず破棄してから張り直す(launchd の unload 相当)。
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
    currentExpression = null;
  }

  if (!cfg.enabled) {
    return { ok: true, expression: null, loaded: false, detail: "定期実行は無効(cron ジョブを停止しました)" };
  }

  const expression = buildCronExpression(cfg);
  if (!cron.validate(expression)) {
    return { ok: false, expression, loaded: false, detail: `cron 式が不正です: ${expression}` };
  }

  try {
    currentTask = cron.schedule(
      expression,
      () => {
        if (!runner) {
          console.warn("[network-investigation] 定期実行ランナーが未設定のためスキップしました");
          return;
        }
        console.log(
          `[network-investigation] 定期実行を開始します ${new Date().toISOString()} (${expression} ${CRON_TZ})`,
        );
        void runner()
          .then((r) => console.log(`[network-investigation] 定期実行が完了しました ${JSON.stringify(r)}`))
          .catch((err) => console.error("[network-investigation] 定期実行に失敗しました:", err));
      },
      { timezone: CRON_TZ },
    );
    currentExpression = expression;
    const freqNote =
      cfg.frequency === "weekly"
        ? `毎週 曜日=${cfg.dayOfWeek ?? 1}(0=日) ${String(cfg.hour).padStart(2, "0")}:${String(cfg.minute).padStart(2, "0")}`
        : `毎日 ${String(cfg.hour).padStart(2, "0")}:${String(cfg.minute).padStart(2, "0")}`;
    return {
      ok: true,
      expression,
      loaded: true,
      detail: `${freqNote}(cron "${expression}" / TZ=${CRON_TZ})で定期実行を設定しました`,
    };
  } catch (err) {
    return {
      ok: false,
      expression,
      loaded: false,
      detail: `cron ジョブの登録に失敗: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 現在張られている cron 式(無効なら null)。デバッグ・起動ログ用。 */
export function currentCronExpression(): string | null {
  return currentExpression;
}

/**
 * 起動時の初期化。シード複製 → 設定読み込み → cron ジョブ登録 までを行う。
 * server/index.ts から 1 回だけ呼ぶ。
 */
export async function initSchedule(run: Runner): Promise<ScheduleSyncResult> {
  setScheduledRunner(run);
  await seedScheduleFiles();
  const cfg = await readScheduleConfig();
  return applySchedule(cfg);
}
