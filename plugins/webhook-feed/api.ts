// Webhook ログ(17 Task 2-1)— API ルート。
//
// エンドポイント(GET はキャッシュ読み。Google Sheets を叩くのは POST /refresh とポーラーだけ):
//   GET  /snapshot   … キャッシュ済みの統合フィード一覧(3 ソース統合済み)
//   POST /refresh    … 最短間隔(既定 30 秒)を守ったうえで即時再取得
//   GET  /settings   … Webhook ログ専用のポーリング間隔設定(Global Overview とは別物)
//   POST /settings   … 同上の変更(永続化・即反映)
//   GET  /status     … 資格情報の設定状況・シートごとの読み取り位置(疎通確認用)
//
// View 側(view/api.ts)の BASE は /api/webhook-feed に合わせる。

import { Router } from "express";
import {
  getCachedFeed,
  getSettings,
  loadPersisted,
  loadSettings,
  refresh,
  setPollInterval,
  startPolling,
} from "./poller.js";
import { getServiceAccountEmail, resolveKeyFile } from "./sheets-client.js";
import { AUTO_ENABLED, AUTO_MAX_AGE_MS, AUTO_MAX_PER_CYCLE } from "./enrich.js";

export const router = Router();

/** 起動時の初期化。永続キャッシュ + 設定を読み戻してからポーリングを始める。 */
export async function initWebhookFeed(): Promise<void> {
  await loadPersisted();
  await loadSettings();
  startPolling();
}

router.get("/snapshot", (_req, res) => {
  res.json(getCachedFeed());
});

router.post("/refresh", async (_req, res) => {
  try {
    res.json(await refresh({ force: true }));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/settings", (_req, res) => {
  res.json(getSettings());
});

router.post("/settings", async (req, res) => {
  const raw = (req.body ?? {}) as { pollIntervalMs?: unknown };
  const ms = Number(raw.pollIntervalMs);
  if (!Number.isFinite(ms)) {
    res.status(400).json({ error: "pollIntervalMs に数値を指定してください(ミリ秒)" });
    return;
  }
  try {
    res.json(await setPollInterval(ms));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/status", async (_req, res) => {
  const env = getCachedFeed();
  let keyFile: string | null = null;
  let keyError: string | null = null;
  try {
    keyFile = await resolveKeyFile();
  } catch (err) {
    keyError = err instanceof Error ? err.message : String(err);
  }
  res.json({
    configured: env.configured,
    configError: env.configError,
    spreadsheetIdSet: Boolean((process.env.WEBHOOK_LOG_SPREADSHEET_ID || "").trim()),
    spreadsheetTitle: env.spreadsheetTitle,
    // 鍵の中身は出さない。パス(ファイル名)とサービスアカウントのメールアドレスだけ。
    serviceAccount: { keyFile, email: getServiceAccountEmail(), error: keyError },
    cache: {
      generatedAt: env.generatedAt,
      ageMs: env.ageMs,
      stale: env.stale,
      pollIntervalMs: env.pollIntervalMs,
      minRefreshMs: env.minRefreshMs,
      items: env.items.length,
    },
    sheets: env.sheets,
    auto: {
      enabled: AUTO_ENABLED,
      maxPerCycle: AUTO_MAX_PER_CYCLE,
      maxAgeMs: AUTO_MAX_AGE_MS,
      investigatedCount: env.auto.investigatedCount,
    },
  });
});
