// Global Overview — API ルート(Central / Mist の直接 REST。MCP は経由しない)
//
// エンドポイント(すべて GET はキャッシュ読み。外部 API を叩くのは POST /refresh とポーラーだけ):
//   GET  /snapshot        … 集計済みスナップショット全体(totals / platforms / sites)
//   GET  /summary         … スナップショットのうち totals + platforms だけ(軽量)
//   GET  /sites           … サイト別内訳。?platform=central|mist で絞り込み
//   GET  /status          … 資格情報の設定状況・レート制御の実績・キャッシュ鮮度(疎通確認用)
//   POST /refresh         … 最短間隔(既定 60 秒)を守ったうえで即時再取得
//
// View 側(06 で実装)の BASE は /api/global-overview に合わせる。

import { Router } from "express";
import { CentralClient } from "./central-client.js";
import { MistClient } from "./mist-client.js";
import {
  getCached,
  refresh,
  loadPersisted,
  loadSettings,
  startPolling,
  getPollIntervalMs,
  getSettings,
  setPollInterval,
  MIN_REFRESH_MS,
} from "./poller.js";
import {
  getSiteDetail,
  getClientDetail,
  SiteDetailError,
  type DetailPlatform,
} from "./site-detail.js";
import { getEventFeed } from "./events-feed.js";

export const router = Router();

/** 起動時の初期化。永続キャッシュ + 設定を読み戻してからポーリングを始める。 */
export async function initGlobalOverview(): Promise<void> {
  await loadPersisted();
  await loadSettings();
  startPolling();
}

router.get("/snapshot", (_req, res) => {
  const env = getCached();
  if (!env.snapshot) {
    res.status(503).json({ error: "スナップショット未生成です。初回ポーリングの完了を待ってください。", ...env });
    return;
  }
  res.json(env);
});

router.get("/summary", (_req, res) => {
  const env = getCached();
  if (!env.snapshot) {
    res.status(503).json({ error: "スナップショット未生成です。", ...env });
    return;
  }
  const { generatedAt, totals, devices, platforms, siteMapOnly } = env.snapshot;
  res.json({
    generatedAt,
    totals,
    devices,
    platforms,
    siteMapOnly,
    ageMs: env.ageMs,
    stale: env.stale,
    pollIntervalMs: env.pollIntervalMs,
  });
});

router.get("/sites", (req, res) => {
  const env = getCached();
  if (!env.snapshot) {
    res.status(503).json({ error: "スナップショット未生成です。", ...env });
    return;
  }
  const platform = String(req.query.platform ?? "").toLowerCase();
  const sites =
    platform === "central" || platform === "mist"
      ? env.snapshot.sites.filter((s) => s.platform === platform)
      : env.snapshot.sites;
  res.json({ generatedAt: env.snapshot.generatedAt, ageMs: env.ageMs, stale: env.stale, sites });
});

router.get("/status", (_req, res) => {
  const env = getCached();
  res.json({
    configured: { central: CentralClient.isConfigured(), mist: MistClient.isConfigured() },
    cache: {
      generatedAt: env.snapshot?.generatedAt ?? null,
      ageMs: env.ageMs,
      stale: env.stale,
      pollIntervalMs: getPollIntervalMs(),
      minRefreshMs: MIN_REFRESH_MS,
    },
    platforms: env.snapshot
      ? {
          central: { ok: env.snapshot.platforms.central.ok, error: env.snapshot.platforms.central.error },
          mist: { ok: env.snapshot.platforms.mist.ok, error: env.snapshot.platforms.mist.error },
        }
      : null,
    // レート制御の実績。requests はプロセス起動以降の累計送出数(リトライ込み)。
    rateLimit: env.rateLimit,
  });
});

// サイト 1 件の詳細(11 番)。オンデマンド取得。定期ポーリングには含めない。
// GET /site-detail?platform=central|mist&siteId=...&siteName=...
//   siteName は Central の health(siteName filter)と alerts の絞り込みに要る。
//   30 秒キャッシュ + in-flight 共有つき(site-detail.ts)。
router.get("/site-detail", async (req, res) => {
  const platform = String(req.query.platform ?? "").toLowerCase() as DetailPlatform;
  const siteId = String(req.query.siteId ?? "").trim();
  const siteName = String(req.query.siteName ?? "").trim();
  try {
    const detail = await getSiteDetail(platform, siteId, siteName);
    res.json(detail);
  } catch (err) {
    if (err instanceof SiteDetailError) {
      res.status(err.httpStatus).json({ error: err.message });
      return;
    }
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// クライアント 1 件のイベント履歴(Task 3)。オンデマンド。定期ポーリングには含めない。
// GET /client-detail?platform=central|mist&siteId=...&mac=...
router.get("/client-detail", async (req, res) => {
  const platform = String(req.query.platform ?? "").toLowerCase() as DetailPlatform;
  const siteId = String(req.query.siteId ?? "").trim();
  const mac = String(req.query.mac ?? "").trim();
  try {
    const detail = await getClientDetail(platform, siteId, mac);
    res.json(detail);
  } catch (err) {
    if (err instanceof SiteDetailError) {
      res.status(err.httpStatus).json({ error: err.message });
      return;
    }
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 全サイト横断 Event / Alert 一覧(13 Task 2)。オンデマンド。定期ポーリングには含めない。
//   GET /events        … 60 秒キャッシュを返す(期限切れなら取得)
//   GET /events?force=1 … キャッシュを無視して取り直す(画面の「更新」ボタン)
// HTTP 本数の内訳はレスポンスの sources[].requests に載る。
router.get("/events", async (req, res) => {
  const force = String(req.query.force ?? "") === "1";
  try {
    res.json(await getEventFeed({ force }));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ポーリング間隔設定(Task 4)。
//   GET  /settings … 現在値 + 選択肢 + 下限/上限
//   POST /settings { pollIntervalMs } … 変更(下限 60s / 上限 60min にクランプ)して永続化・即反映
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
    const settings = await setPollInterval(ms);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/refresh", async (_req, res) => {
  try {
    const env = await refresh({ force: true });
    if (!env.snapshot) {
      res.status(502).json({ error: "取得に失敗しました。", ...env });
      return;
    }
    res.json(env);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
