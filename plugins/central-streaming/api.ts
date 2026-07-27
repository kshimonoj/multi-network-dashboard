// Streaming(Central)(20)— API ルート。
//
// エンドポイント:
//   GET  /snapshot          … 接続状態 + 保持しているイベント一覧(サーバのメモリを読むだけ)
//   GET  /catalog           … エンドポイント / イベント種別のカタログ(画面の選択 UI 用)
//   GET  /settings          … トグル・購読・Retention の現在値
//   POST /settings          … 同上の変更(永続化して接続集合に即反映)
//   POST /purge             … Retention を今すぐ走らせる
//   POST /clear             … 保存済みイベントを全消しする
//   POST /disconnect        … 動作確認用。指定ストリームを強制切断して再接続を試させる
//   GET  /status            … 疎通確認用の要約
//
// View 側(view/api.ts)の BASE は /api/central-streaming に合わせる。

import { Router } from "express";
import { ENDPOINTS, isStreamKey } from "./catalog.js";
import { initDecoder } from "./decoder.js";
import {
  API_MAX_ITEMS,
  MAX_EVENTS_OPTIONS,
  RETENTION_OPTIONS_DAYS,
  clearEvents,
  getEvents,
  getSettings,
  loadPersisted,
  purge,
  purgeInfo,
  startRetentionJob,
  storedCount,
  updateSettings,
} from "./store.js";
import { applySettings, forceDisconnect, readiness, statuses } from "./ws-client.js";
import type { StreamEnvelope } from "./types.js";

export const router = Router();

/** 起動時の初期化。proto を読み → 永続データを読み戻し → 設定どおりに接続する。 */
export async function initCentralStreaming(): Promise<void> {
  await initDecoder();
  await loadPersisted();
  startRetentionJob();
  const ready = readiness();
  if (!ready.configured) {
    console.warn(`[central-streaming] 未設定のため接続しません: ${ready.configError}`);
    return;
  }
  await applySettings();
}

function envelope(limit = API_MAX_ITEMS): StreamEnvelope {
  const ready = readiness();
  const p = purgeInfo();
  return {
    configured: ready.configured,
    configError: ready.configError,
    settings: getSettings(),
    streams: statuses(),
    items: getEvents(limit),
    stored: storedCount(),
    lastPurgeAt: p.lastPurgeAt,
    lastPurged: p.lastPurged,
    retentionOptionsDays: RETENTION_OPTIONS_DAYS,
    maxEventsOptions: MAX_EVENTS_OPTIONS,
    generatedAt: new Date().toISOString(),
  };
}

router.get("/snapshot", (req, res) => {
  const n = Number(req.query.limit);
  res.json(envelope(Number.isFinite(n) && n > 0 ? n : API_MAX_ITEMS));
});

router.get("/catalog", (_req, res) => {
  res.json({ endpoints: ENDPOINTS });
});

router.get("/settings", (_req, res) => {
  res.json(getSettings());
});

router.post("/settings", async (req, res) => {
  try {
    const next = await updateSettings((req.body ?? {}) as Record<string, unknown>);
    // 接続集合を新しい設定に寄せる(await しない。接続確立を待たずに応答を返す)。
    void applySettings();
    res.json({ settings: next, streams: statuses() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/purge", async (_req, res) => {
  try {
    const removed = await purge();
    res.json({ removed, stored: storedCount(), ...purgeInfo() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/clear", async (_req, res) => {
  try {
    res.json({ removed: await clearEvents(), stored: storedCount() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/disconnect", (req, res) => {
  const key = (req.body ?? {}).stream;
  if (!isStreamKey(key)) {
    res.status(400).json({ error: "stream に有効なストリームキーを指定してください" });
    return;
  }
  const ok = forceDisconnect(key);
  res.json({ ok, note: ok ? "強制切断しました。再接続ロジックが働きます。" : "接続していません" });
});

router.get("/status", (_req, res) => {
  const ready = readiness();
  res.json({
    configured: ready.configured,
    configError: ready.configError,
    baseUrlSet: Boolean((process.env.CENTRAL_BASE_URL || "").trim()),
    settings: getSettings(),
    streams: statuses(),
    stored: storedCount(),
    ...purgeInfo(),
  });
});
