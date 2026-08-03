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
  getArchiveSummary,
  getCachedFeed,
  getSettings,
  initArchiveStore,
  loadPersisted,
  loadSettings,
  refresh,
  setArchiveRetentionDays,
  setPollInterval,
  startPolling,
} from "./poller.js";
import { dayStats, getMeta, readDay } from "./archive.js";
import { getServiceAccountEmail, resolveKeyFile } from "./sheets-client.js";
import { AUTO_ENABLED, AUTO_MAX_AGE_MS, AUTO_MAX_PER_CYCLE } from "./enrich.js";
import { isDateKey } from "../reports/time.js";

export const router = Router();

/**
 * 起動時の初期化。永続キャッシュ + 設定を読み戻し、日別アーカイブを初期化(必要なら移行)
 * してからポーリングを始める。
 */
export async function initWebhookFeed(): Promise<void> {
  await loadPersisted();
  await loadSettings();
  await initArchiveStore();
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
  const raw = (req.body ?? {}) as { pollIntervalMs?: unknown; archiveRetentionDays?: unknown };
  const hasInterval = raw.pollIntervalMs !== undefined;
  const hasRetention = raw.archiveRetentionDays !== undefined;
  if (!hasInterval && !hasRetention) {
    res.status(400).json({ error: "pollIntervalMs または archiveRetentionDays を指定してください" });
    return;
  }
  const ms = Number(raw.pollIntervalMs);
  if (hasInterval && !Number.isFinite(ms)) {
    res.status(400).json({ error: "pollIntervalMs に数値を指定してください(ミリ秒)" });
    return;
  }
  const days = Number(raw.archiveRetentionDays);
  if (hasRetention && !Number.isFinite(days)) {
    res.status(400).json({ error: "archiveRetentionDays に数値を指定してください(日。0 = 無期限)" });
    return;
  }
  try {
    let out = getSettings();
    if (hasInterval) out = await setPollInterval(ms);
    if (hasRetention) out = await setArchiveRetentionDays(days);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * 42: 日別アーカイブ(保存の正本)の状況。
 *   GET /archive            … 日ごとの件数・サイズ一覧
 *   GET /archive?date=YYYY-MM-DD … その日の保存件数(件数のみ。生データは返さない)
 */
router.get("/archive", async (req, res) => {
  try {
    const date = typeof req.query.date === "string" ? req.query.date : null;
    if (date) {
      if (!isDateKey(date)) {
        res.status(400).json({ error: "date は YYYY-MM-DD 形式で指定してください" });
        return;
      }
      const day = await readDay(date);
      res.json({ dateKey: date, exists: day.exists, items: day.items.length, corrupt: day.corrupt });
      return;
    }
    res.json({
      summary: getArchiveSummary(),
      meta: getMeta(),
      days: await dayStats(),
      view: { maxItems: getSettings().viewMaxItems, items: getCachedFeed().items.length },
    });
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
    // 42: 一覧に見えている件数(cache.items)とは別に、保存の実態を出す。
    storage: env.storage,
    sheets: env.sheets,
    auto: {
      enabled: AUTO_ENABLED,
      maxPerCycle: AUTO_MAX_PER_CYCLE,
      maxAgeMs: AUTO_MAX_AGE_MS,
      investigatedCount: env.auto.investigatedCount,
    },
  });
});
