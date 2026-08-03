/**
 * ベストプラクティス診断 — 設定・永続化。
 *
 * 置き場(data/ 配下。他プラグインと同じ慣習):
 *   data/best-practice/settings.json     … LLM 所見の有効/無効・モデル・保存件数・無効ルール
 *   data/best-practice/runs/<id>.json    … 1 回の診断結果(Finding[] 一式)
 *   data/best-practice/index.json        … 実行の一覧(一覧表示用のメタだけ)
 *
 * 診断結果は 1 回あたり数百 Finding になるので、レポートの日次 JSON と同じく
 * 実行ごとに 1 ファイルへ分ける。一覧は index.json だけを読めば描ける。
 *
 * 書き込みは既存プラグインと同じ「一時ファイル → rename」(書き込み途中を読ませない)。
 *
 * **保存してはいけないもの**(49 §1-5(a)): running-config の生テキスト、鍵・パスフレーズ・
 * ハッシュ・RADIUS シークレット。DiagnosisRun に載るのは正規化済みの observed と
 * 先頭 300 文字に切った失敗理由だけで、生テキストはそもそもここまで届かない。
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import type { BestPracticeSettings, DiagnosisRun, DiagnosisRunMeta } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR =
  process.env.BEST_PRACTICE_DATA_DIR || path.resolve(__dirname, "../../data/best-practice");
const RUNS_DIR = path.join(DATA_DIR, "runs");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const INDEX_PATH = path.join(DATA_DIR, "index.json");

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/;
const RUN_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? Math.floor(v) : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

const DEFAULT_SETTINGS: BestPracticeSettings = {
  // LLM 所見は既定で有効。実行は手動トリガーのときだけなので、勝手にコストが増えることはない
  llmEnabled: String(process.env.BEST_PRACTICE_LLM_ENABLED ?? "1") !== "0",
  llmModel: null,
  maxRuns: clampInt(process.env.BEST_PRACTICE_MAX_RUNS, 5, 500, 50),
  disabledRuleIds: [],
};

let settings: BestPracticeSettings = { ...DEFAULT_SETTINGS };
let index: DiagnosisRunMeta[] = [];

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

export async function ensureDirs(): Promise<void> {
  await mkdir(RUNS_DIR, { recursive: true });
}

// ---- 設定 ----

export function normalizeSettings(
  raw: unknown,
  base: BestPracticeSettings = DEFAULT_SETTINGS,
): BestPracticeSettings {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const model =
    typeof p.llmModel === "string" && p.llmModel.trim() && MODEL_RE.test(p.llmModel.trim())
      ? p.llmModel.trim()
      : p.llmModel === null || p.llmModel === ""
        ? null
        : base.llmModel;

  const disabled = Array.isArray(p.disabledRuleIds)
    ? [
        ...new Set(
          p.disabledRuleIds
            .map((v) => String(v ?? "").trim().toUpperCase())
            .filter((v) => /^(SEC|RF)-\d{2}$/.test(v)),
        ),
      ]
    : base.disabledRuleIds;

  return {
    llmEnabled: typeof p.llmEnabled === "boolean" ? p.llmEnabled : base.llmEnabled,
    llmModel: model,
    maxRuns: p.maxRuns === undefined ? base.maxRuns : clampInt(p.maxRuns, 5, 500, base.maxRuns),
    disabledRuleIds: disabled,
  };
}

export function getSettings(): BestPracticeSettings {
  return settings;
}

export async function loadSettings(): Promise<BestPracticeSettings> {
  try {
    settings = normalizeSettings(JSON.parse(await readFile(SETTINGS_PATH, "utf-8")));
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  return settings;
}

export async function saveSettings(patch: unknown): Promise<BestPracticeSettings> {
  settings = normalizeSettings(patch, settings);
  await atomicWrite(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  return settings;
}

// ---- 実行結果 ----

function runPath(id: string): string {
  return path.join(RUNS_DIR, `${id}.json`);
}

function toMeta(run: DiagnosisRun): DiagnosisRunMeta {
  return {
    id: run.id,
    startedAt: run.startedAt,
    platform: run.platform,
    siteId: run.siteId,
    siteName: run.siteName,
    summary: run.summary,
    error: run.error,
  };
}

export async function loadIndex(): Promise<DiagnosisRunMeta[]> {
  try {
    const parsed = JSON.parse(await readFile(INDEX_PATH, "utf-8"));
    index = Array.isArray(parsed?.runs) ? parsed.runs : [];
  } catch {
    // index.json が無い / 壊れている場合は runs/ から作り直す
    index = await rebuildIndex();
  }
  return index;
}

async function rebuildIndex(): Promise<DiagnosisRunMeta[]> {
  const metas: DiagnosisRunMeta[] = [];
  try {
    for (const f of await readdir(RUNS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const run = JSON.parse(await readFile(path.join(RUNS_DIR, f), "utf-8")) as DiagnosisRun;
        if (run?.id) metas.push(toMeta(run));
      } catch {
        /* 壊れたファイルは飛ばす */
      }
    }
  } catch {
    /* runs/ がまだ無い */
  }
  metas.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return metas;
}

export function listRuns(limit = 50): DiagnosisRunMeta[] {
  return index.slice(0, Math.max(1, limit));
}

export function isValidRunId(id: unknown): id is string {
  return typeof id === "string" && RUN_ID_RE.test(id);
}

export async function readRun(id: string): Promise<DiagnosisRun | null> {
  if (!isValidRunId(id)) return null;
  try {
    return JSON.parse(await readFile(runPath(id), "utf-8")) as DiagnosisRun;
  } catch {
    return null;
  }
}

export async function writeRun(run: DiagnosisRun): Promise<void> {
  await ensureDirs();
  await atomicWrite(runPath(run.id), JSON.stringify(run, null, 2));

  index = [toMeta(run), ...index.filter((m) => m.id !== run.id)];
  index.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  // 上限を超えた古い実行を消す
  const overflow = index.slice(settings.maxRuns);
  index = index.slice(0, settings.maxRuns);
  for (const m of overflow) {
    await unlink(runPath(m.id)).catch(() => undefined);
  }

  await atomicWrite(INDEX_PATH, JSON.stringify({ version: 1, runs: index }, null, 2));
}

export async function deleteRun(id: string): Promise<boolean> {
  if (!isValidRunId(id)) return false;
  const existed = index.some((m) => m.id === id);
  index = index.filter((m) => m.id !== id);
  await unlink(runPath(id)).catch(() => undefined);
  await atomicWrite(INDEX_PATH, JSON.stringify({ version: 1, runs: index }, null, 2));
  return existed;
}
