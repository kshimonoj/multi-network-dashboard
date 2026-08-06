/**
 * タグ付き対象(59)— 永続化。
 *
 * 置き場(data/ 配下。他プラグインと同じ慣習):
 *   data/tagged-targets/tags.json      … タグ定義 + 付与状態(1 ファイル)
 *   data/tagged-targets/settings.json  … TTL 等
 *
 * 1 ファイルにまとめる根拠(57 §3-1): 想定件数が数十〜数百で、常に全件を横断して
 * 絞り込む使い方しかしないため、日付や種別で割る利が無い。
 *
 * 書き込みは既存プラグインと同じ「一時ファイル → rename」+ 同一ファイルへの直列化。
 *
 * **Central / Mist の設定には一切書き込まない。**このファイルが扱うのは
 * このダッシュボード固有のローカルなタグだけ。
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { looksLocallyAdministered, normalizeMac, normalizeSerial } from "./mac.js";
import {
  TAG_COLORS,
  type LastSeenHint,
  type TagColor,
  type TagDef,
  type TaggedTargetsSettings,
  type TagStoreFile,
  type TargetAssignment,
  type TargetKind,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR =
  process.env.TAGGED_TARGETS_DATA_DIR || path.resolve(__dirname, "../../data/tagged-targets");
const TAGS_PATH = path.join(DATA_DIR, "tags.json");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

const NAME_MAX = 60;
const NOTE_MAX = 2000;
const LABEL_MAX = 120;
const MAX_TAGS = 200;
const MAX_ASSIGNMENTS = 2000;

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? Math.floor(v) : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

const DEFAULT_SETTINGS: TaggedTargetsSettings = {
  listTtlMs: clampInt(process.env.TAGGED_TARGETS_LIST_TTL_MS, 5_000, 600_000, 60_000),
  detailTtlMs: clampInt(process.env.TAGGED_TARGETS_DETAIL_TTL_MS, 5_000, 600_000, 60_000),
  maxMistSites: clampInt(process.env.TAGGED_TARGETS_MAX_MIST_SITES, 1, 50, 8),
};

const EMPTY: TagStoreFile = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  tags: [],
  assignments: [],
};

let store: TagStoreFile = { ...EMPTY, tags: [], assignments: [] };
let settings: TaggedTargetsSettings = { ...DEFAULT_SETTINGS };

// ---- 原子的書き込み(best-practice/store.ts と同じ) ----

const writeChains = new Map<string, Promise<unknown>>();

async function atomicWrite(file: string, data: string): Promise<void> {
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

// ---- 正規化 ----

function normalizeColor(v: unknown): TagColor {
  const s = String(v ?? "").trim();
  return (TAG_COLORS as readonly string[]).includes(s) ? (s as TagColor) : "slate";
}

function normalizeLastSeen(v: unknown): LastSeenHint | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  const platform = p.platform === "central" || p.platform === "mist" ? p.platform : null;
  const siteId = str(p.siteId, 128);
  const siteName = str(p.siteName, 200);
  const at = str(p.at, 40);
  if (!platform && !siteId && !siteName && !at) return null;
  return { platform, siteId, siteName, at };
}

function normalizeTag(raw: unknown): TagDef | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const id = str(p.id, 64);
  const name = str(p.name, NAME_MAX);
  if (!id || !name) return null;
  return {
    id,
    name,
    color: normalizeColor(p.color),
    description: str(p.description, NOTE_MAX),
    createdAt: str(p.createdAt, 40) ?? new Date().toISOString(),
  };
}

function normalizeAssignment(raw: unknown, tagIds: Set<string>): TargetAssignment | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const key = normalizeMac(p.key);
  if (!key) return null;
  const kind: TargetKind = p.kind === "device" ? "device" : "client";
  const ids = Array.isArray(p.tagIds)
    ? [...new Set(p.tagIds.map((v) => String(v ?? "")).filter((v) => tagIds.has(v)))]
    : [];
  return {
    kind,
    key,
    serial: kind === "device" ? normalizeSerial(p.serial) : null,
    tagIds: ids,
    label: str(p.label, LABEL_MAX),
    note: str(p.note, NOTE_MAX),
    lastSeen: normalizeLastSeen(p.lastSeen),
    randomMac: typeof p.randomMac === "boolean" ? p.randomMac : looksLocallyAdministered(key),
    addedAt: str(p.addedAt, 40) ?? new Date().toISOString(),
  };
}

function normalizeStore(raw: unknown): TagStoreFile {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tags = (Array.isArray(p.tags) ? p.tags : [])
    .map(normalizeTag)
    .filter((t): t is TagDef => t !== null)
    .slice(0, MAX_TAGS);
  const tagIds = new Set(tags.map((t) => t.id));
  const seen = new Set<string>();
  const assignments: TargetAssignment[] = [];
  for (const raw2 of Array.isArray(p.assignments) ? p.assignments : []) {
    const a = normalizeAssignment(raw2, tagIds);
    if (!a) continue;
    const dedupeKey = `${a.kind}:${a.key}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    assignments.push(a);
    if (assignments.length >= MAX_ASSIGNMENTS) break;
  }
  return {
    version: 1,
    updatedAt: str(p.updatedAt, 40) ?? new Date().toISOString(),
    tags,
    assignments,
  };
}

export function normalizeSettings(
  raw: unknown,
  base: TaggedTargetsSettings = DEFAULT_SETTINGS,
): TaggedTargetsSettings {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    listTtlMs:
      p.listTtlMs === undefined ? base.listTtlMs : clampInt(p.listTtlMs, 5_000, 600_000, base.listTtlMs),
    detailTtlMs:
      p.detailTtlMs === undefined
        ? base.detailTtlMs
        : clampInt(p.detailTtlMs, 5_000, 600_000, base.detailTtlMs),
    maxMistSites:
      p.maxMistSites === undefined
        ? base.maxMistSites
        : clampInt(p.maxMistSites, 1, 50, base.maxMistSites),
  };
}

// ---- 読み書き ----

export async function loadStore(): Promise<TagStoreFile> {
  try {
    store = normalizeStore(JSON.parse(await readFile(TAGS_PATH, "utf-8")));
  } catch {
    store = { version: 1, updatedAt: new Date().toISOString(), tags: [], assignments: [] };
  }
  try {
    settings = normalizeSettings(JSON.parse(await readFile(SETTINGS_PATH, "utf-8")));
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  return store;
}

export function getStore(): TagStoreFile {
  return store;
}

export function getSettings(): TaggedTargetsSettings {
  return settings;
}

export async function saveSettings(patch: unknown): Promise<TaggedTargetsSettings> {
  settings = normalizeSettings(patch, settings);
  await atomicWrite(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  return settings;
}

async function persist(): Promise<TagStoreFile> {
  store = { ...store, updatedAt: new Date().toISOString() };
  await atomicWrite(TAGS_PATH, JSON.stringify(store, null, 2));
  return store;
}

// ---- タグ定義 ----

export async function createTag(input: {
  name?: unknown;
  color?: unknown;
  description?: unknown;
}): Promise<TagDef> {
  const name = str(input.name, NAME_MAX);
  if (!name) throw new StoreError("tagNameRequired", 400);
  if (store.tags.length >= MAX_TAGS) throw new StoreError("tagLimitReached", 400);
  const tag: TagDef = {
    id: randomUUID(),
    name,
    color: normalizeColor(input.color),
    description: str(input.description, NOTE_MAX),
    createdAt: new Date().toISOString(),
  };
  store.tags = [...store.tags, tag];
  await persist();
  return tag;
}

export async function updateTag(
  id: string,
  patch: { name?: unknown; color?: unknown; description?: unknown },
): Promise<TagDef> {
  const idx = store.tags.findIndex((t) => t.id === id);
  if (idx < 0) throw new StoreError("tagNotFound", 404);
  const cur = store.tags[idx];
  const name = patch.name === undefined ? cur.name : str(patch.name, NAME_MAX);
  if (!name) throw new StoreError("tagNameRequired", 400);
  const next: TagDef = {
    ...cur,
    name,
    color: patch.color === undefined ? cur.color : normalizeColor(patch.color),
    description: patch.description === undefined ? cur.description : str(patch.description, NOTE_MAX),
  };
  store.tags = store.tags.map((t, i) => (i === idx ? next : t));
  await persist();
  return next;
}

/** タグ定義を消し、全 assignment の tagIds からも掃除する(参照の孤児を残さない。57 §3-1)。 */
export async function deleteTag(id: string): Promise<{ removedFrom: number }> {
  if (!store.tags.some((t) => t.id === id)) throw new StoreError("tagNotFound", 404);
  let removedFrom = 0;
  store.tags = store.tags.filter((t) => t.id !== id);
  store.assignments = store.assignments.map((a) => {
    if (!a.tagIds.includes(id)) return a;
    removedFrom += 1;
    return { ...a, tagIds: a.tagIds.filter((x) => x !== id) };
  });
  await persist();
  return { removedFrom };
}

/** タグ削除前の確認ダイアログ用。「N 件の対象から外れます」を出すのに使う。 */
export function countAssignmentsWithTag(id: string): number {
  return store.assignments.filter((a) => a.tagIds.includes(id)).length;
}

// ---- 対象(assignment)----

function findIndex(kind: TargetKind, key: string): number {
  return store.assignments.findIndex((a) => a.kind === kind && a.key === key);
}

export async function upsertAssignment(input: {
  kind?: unknown;
  key?: unknown;
  serial?: unknown;
  tagIds?: unknown;
  label?: unknown;
  note?: unknown;
  lastSeen?: unknown;
  randomMac?: unknown;
}): Promise<TargetAssignment> {
  const key = normalizeMac(input.key);
  if (!key) throw new StoreError("macInvalid", 400);
  const kind: TargetKind = input.kind === "device" ? "device" : "client";

  const knownTagIds = new Set(store.tags.map((t) => t.id));
  const tagIds = Array.isArray(input.tagIds)
    ? [...new Set(input.tagIds.map((v) => String(v ?? "")).filter((v) => knownTagIds.has(v)))]
    : undefined;

  const idx = findIndex(kind, key);
  const now = new Date().toISOString();
  const base: TargetAssignment =
    idx >= 0
      ? store.assignments[idx]
      : {
          kind,
          key,
          serial: null,
          tagIds: [],
          label: null,
          note: null,
          lastSeen: null,
          randomMac: looksLocallyAdministered(key),
          addedAt: now,
        };

  if (idx < 0 && store.assignments.length >= MAX_ASSIGNMENTS) {
    throw new StoreError("assignmentLimitReached", 400);
  }

  const next: TargetAssignment = {
    ...base,
    kind,
    key,
    serial: kind === "device" ? (input.serial === undefined ? base.serial : normalizeSerial(input.serial)) : null,
    tagIds: tagIds ?? base.tagIds,
    label: input.label === undefined ? base.label : str(input.label, LABEL_MAX),
    note: input.note === undefined ? base.note : str(input.note, NOTE_MAX),
    lastSeen: input.lastSeen === undefined ? base.lastSeen : normalizeLastSeen(input.lastSeen),
    randomMac: typeof input.randomMac === "boolean" ? input.randomMac : base.randomMac,
  };

  store.assignments = idx >= 0
    ? store.assignments.map((a, i) => (i === idx ? next : a))
    : [...store.assignments, next];
  await persist();
  return next;
}

export async function deleteAssignment(kind: TargetKind, key: string): Promise<boolean> {
  const norm = normalizeMac(key);
  if (!norm) return false;
  const before = store.assignments.length;
  store.assignments = store.assignments.filter((a) => !(a.kind === kind && a.key === norm));
  if (store.assignments.length === before) return false;
  await persist();
  return true;
}

/**
 * 突合で分かった「最後に見た場所」を書き戻す。
 * lastSeen は非正準なので、変化が無ければ書き込まない(毎回の一覧取得で I/O を出さない)。
 * device の serial も Central 側で解決できたときだけ埋め戻す(57 §3-2)。
 */
export async function touchLastSeen(
  updates: Array<{ kind: TargetKind; key: string; lastSeen: LastSeenHint; serial?: string | null }>,
): Promise<void> {
  let changed = false;
  store.assignments = store.assignments.map((a) => {
    const u = updates.find((x) => x.kind === a.kind && x.key === a.key);
    if (!u) return a;
    const serial = a.kind === "device" && !a.serial && u.serial ? normalizeSerial(u.serial) : a.serial;
    const same =
      a.lastSeen?.platform === u.lastSeen.platform &&
      a.lastSeen?.siteId === u.lastSeen.siteId &&
      a.lastSeen?.siteName === u.lastSeen.siteName &&
      serial === a.serial;
    if (same) return a;
    changed = true;
    return { ...a, serial, lastSeen: u.lastSeen };
  });
  if (changed) await persist();
}

export class StoreError extends Error {
  constructor(
    /** 画面側の辞書キーになる機械可読コード(サーバで文章を組み立てない。CLAUDE.md の規約) */
    readonly code: string,
    readonly httpStatus: number,
  ) {
    super(code);
  }
}

export async function ensureDirs(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}
