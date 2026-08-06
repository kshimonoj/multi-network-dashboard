/**
 * タグ付き Client / Device(59)— API ルート。
 *
 * エンドポイント:
 *   GET    /status                     … 資格情報の設定状況・タグ件数・設定
 *   GET    /tags                       … タグ定義 + 付与状態(生の store)
 *   POST   /tags                       … タグ定義の追加
 *   PUT    /tags/:id                   … タグ定義の変更(改名・色・説明)
 *   DELETE /tags/:id                   … タグ定義の削除(付与済みからも掃除)
 *   GET    /tags/:id/usage             … 削除確認用の「N 件の対象に付いています」
 *   PUT    /targets                    … 対象の登録 / 更新(タグ付与・覚え書き・ノート)
 *   DELETE /targets?kind=&key=         … 対象の登録解除
 *   GET    /clients?force=1            … タグ付き Client 一覧(突合済み)
 *   GET    /devices?force=1            … タグ付き Device 一覧(突合済み)
 *   GET    /clients/:key?force=1       … Client 詳細(Central / Mist 別)
 *   GET    /devices/:key?force=1       … Device 詳細(Central / Mist 別)
 *   GET    /search?kind=&q=            … 対象検索(タグ付与の入口)
 *   GET/PUT /settings                  … TTL 等
 *
 * サーバ側で文章を組み立てない(CLAUDE.md「サーバ生成の文言を画面に出すとき」)。
 * エラーは機械可読な `code` を返し、画面側の辞書で文にする。
 */

import { Router } from "express";
import { normalizeMac } from "./mac.js";
import { getClientDetail, getClientList, getDeviceDetail, getDeviceList, invalidateCaches } from "./resolve.js";
import { manualHit, searchTargets } from "./search.js";
import {
  countAssignmentsWithTag,
  createTag,
  deleteAssignment,
  deleteTag,
  ensureDirs,
  getSettings,
  getStore,
  loadStore,
  saveSettings,
  StoreError,
  updateTag,
  upsertAssignment,
} from "./store.js";
import { isCentralConfigured } from "./central-fetch.js";
import { isMistConfigured } from "./mist-fetch.js";
import type { TargetKind } from "./types.js";

export const router = Router();

export async function initTaggedTargets(): Promise<void> {
  await ensureDirs();
  const store = await loadStore();
  console.log(
    `[tagged-targets] タグ ${store.tags.length} 件 / 対象 ${store.assignments.length} 件を読み込みました` +
      `(Client ${store.assignments.filter((a) => a.kind === "client").length} / ` +
      `Device ${store.assignments.filter((a) => a.kind === "device").length})`,
  );
}

function fail(res: any, err: unknown): void {
  if (err instanceof StoreError) {
    res.status(err.httpStatus).json({ error: err.code, code: err.code });
    return;
  }
  res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
}

function toKind(v: unknown): TargetKind {
  return v === "device" ? "device" : "client";
}

router.get("/status", (_req, res) => {
  const store = getStore();
  res.json({
    configured: { central: isCentralConfigured(), mist: isMistConfigured() },
    counts: {
      tags: store.tags.length,
      clients: store.assignments.filter((a) => a.kind === "client").length,
      devices: store.assignments.filter((a) => a.kind === "device").length,
    },
    settings: getSettings(),
    updatedAt: store.updatedAt,
  });
});

// ---- タグ定義 ----

router.get("/tags", (_req, res) => {
  res.json(getStore());
});

router.post("/tags", async (req, res) => {
  try {
    const tag = await createTag((req.body ?? {}) as any);
    res.json({ tag, store: getStore() });
  } catch (err) {
    fail(res, err);
  }
});

router.put("/tags/:id", async (req, res) => {
  try {
    const tag = await updateTag(String(req.params.id), (req.body ?? {}) as any);
    res.json({ tag, store: getStore() });
  } catch (err) {
    fail(res, err);
  }
});

router.get("/tags/:id/usage", (req, res) => {
  res.json({ count: countAssignmentsWithTag(String(req.params.id)) });
});

router.delete("/tags/:id", async (req, res) => {
  try {
    const r = await deleteTag(String(req.params.id));
    invalidateCaches();
    res.json({ ...r, store: getStore() });
  } catch (err) {
    fail(res, err);
  }
});

// ---- 対象 ----

router.put("/targets", async (req, res) => {
  try {
    const assignment = await upsertAssignment((req.body ?? {}) as any);
    invalidateCaches();
    res.json({ assignment, store: getStore() });
  } catch (err) {
    fail(res, err);
  }
});

router.delete("/targets", async (req, res) => {
  const kind = toKind(req.query.kind);
  const key = String(req.query.key ?? "");
  const removed = await deleteAssignment(kind, key);
  if (!removed) {
    res.status(404).json({ error: "targetNotFound", code: "targetNotFound" });
    return;
  }
  invalidateCaches();
  res.json({ ok: true, store: getStore() });
});

// ---- 一覧 ----

router.get("/clients", async (req, res) => {
  try {
    res.json(await getClientList(String(req.query.force ?? "") === "1"));
  } catch (err) {
    fail(res, err);
  }
});

router.get("/devices", async (req, res) => {
  try {
    res.json(await getDeviceList(String(req.query.force ?? "") === "1"));
  } catch (err) {
    fail(res, err);
  }
});

// ---- 詳細 ----

router.get("/clients/:key", async (req, res) => {
  const key = normalizeMac(req.params.key);
  if (!key) {
    res.status(400).json({ error: "macInvalid", code: "macInvalid" });
    return;
  }
  try {
    res.json(await getClientDetail(key, String(req.query.force ?? "") === "1"));
  } catch (err) {
    fail(res, err);
  }
});

router.get("/devices/:key", async (req, res) => {
  const key = normalizeMac(req.params.key);
  if (!key) {
    res.status(400).json({ error: "macInvalid", code: "macInvalid" });
    return;
  }
  try {
    res.json(await getDeviceDetail(key, String(req.query.force ?? "") === "1"));
  } catch (err) {
    fail(res, err);
  }
});

// ---- 検索(タグ付与の入口)----

router.get("/search", async (req, res) => {
  const kind = toKind(req.query.kind);
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.json({ hits: [], errors: [], manual: null });
    return;
  }
  try {
    const { hits, errors } = await searchTargets(kind, q);
    // 検索に出てこない対象を MAC 直打ちで登録できるようにする(57 §3-5 の
    // 「見つからない対象も一覧に残す」の入口側)
    res.json({ hits, errors, manual: manualHit(kind, q, null) });
  } catch (err) {
    fail(res, err);
  }
});

// ---- 設定 ----

router.get("/settings", (_req, res) => {
  res.json(getSettings());
});

router.put("/settings", async (req, res) => {
  try {
    const s = await saveSettings(req.body ?? {});
    invalidateCaches();
    res.json(s);
  } catch (err) {
    fail(res, err);
  }
});
