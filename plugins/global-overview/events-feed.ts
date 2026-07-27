// Global Overview — 全サイト横断 Event / Alert 一覧のオンデマンド取得(13 Task 2)。
//
// 調査結果(instructions/13_findings.md に実測値。要点だけ再掲):
//   Central … alerts は org スコープで 1 本(そもそも siteName/siteId で filter できない)。
//             events は network-troubleshooting/v1/events が site-id 必須で、
//             context-type に ORGANIZATION は無い(400 "Invalid value ... context.contextType")。
//             → Central のイベントだけはサイト数ぶんのループになる(このテナントで 13 本)。
//   Mist   … alarms / devices-events / clients-events すべて orgs/{org}/... の窓口があり、
//             結果に site_id が入る。22 サイトぶんが 3 本で返る。
//
// 方針:
//   ・定期ポーリング(poller.ts)には組み込まない。この画面を開いた時だけ発火する。
//     Central 側だけで毎回 13 本増えるうえ、イベントは見ていないときに取っても価値が無い。
//   ・60 秒キャッシュ + in-flight 共有でガードする(サイト詳細の 30 秒より長め。
//     org 一括ぶんの取得コストが大きいため)。
//   ・サイト名の解決はポーラーのキャッシュ済みスナップショットを使う(追加 API を出さない)。
//   ・取得元ごとに成否を持たせる(FeedSource)。Central のイベントが全滅しても
//     Mist のイベントとアラートは出す。

import { getCached, getClients } from "./poller.js";
import type { FeedEnvelope, FeedItem, FeedSeverity, FeedSource } from "./feed-types.js";

/** 集計窓。Mist の ALARM_WINDOW / Central の EVENT_WINDOW と揃える(既定 24h)。 */
const WINDOW_SEC = Number(process.env.GLOBAL_OVERVIEW_FEED_WINDOW_SEC ?? 86_400);
/** 同一内容を再要求したらキャッシュを返す時間。 */
const FEED_TTL_MS = Math.max(10_000, Number(process.env.GLOBAL_OVERVIEW_FEED_TTL_MS ?? 60_000));

/** 取得元ごとの上限件数。Mist の client events は 24h で数千件出るので絞る。 */
const LIMIT_CENTRAL_ALERTS = 100; // alerts エンドポイントの上限
const LIMIT_CENTRAL_SITE_EVENTS = 30;
const LIMIT_MIST_ALARMS = 200;
const LIMIT_MIST_DEVICE_EVENTS = 200;
const LIMIT_MIST_CLIENT_EVENTS = 200;

let cache: { at: number; data: FeedEnvelope } | null = null;
let inFlight: Promise<FeedEnvelope> | null = null;

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 生の重要度を 3 段階へ正規化する。
 * Central アラート: Critical / Major / Minor / Info、Central イベント: negative / neutral / positive、
 * Mist アラーム: critical / warn / info。Mist のイベントは重要度を持たない(→ info)。
 */
function normSeverity(raw: string | null): FeedSeverity {
  const s = (raw ?? "").toLowerCase();
  if (s === "critical" || s === "crit") return "critical";
  if (s === "major" || s === "warning" || s === "warn" || s === "minor" || s === "negative") return "warning";
  return "info";
}

/** スナップショットから siteId → siteName の対応表と、Central のサイト一覧を作る。 */
function siteIndex(): {
  nameById: Map<string, string>;
  centralSites: Array<{ siteId: string; siteName: string }>;
  snapshotAt: string | null;
} {
  const snap = getCached().snapshot;
  const nameById = new Map<string, string>();
  const centralSites: Array<{ siteId: string; siteName: string }> = [];
  for (const s of snap?.sites ?? []) {
    if (s.siteId) nameById.set(`${s.platform}:${s.siteId}`, s.siteName);
    if (s.platform === "central" && s.siteId) centralSites.push({ siteId: s.siteId, siteName: s.siteName });
  }
  return { nameById, centralSites, snapshotAt: snap?.generatedAt ?? null };
}

function resolveName(
  nameById: Map<string, string>,
  platform: "central" | "mist",
  siteId: string | null,
): string {
  if (!siteId) return "(サイト未割り当て)";
  return nameById.get(`${platform}:${siteId}`) ?? siteId;
}

/**
 * 全サイト横断の Event / Alert を取得する。60 秒キャッシュ + in-flight 共有つき。
 * HTTP 本数の内訳は戻り値の sources[].requests に載る(画面のフッタに出す)。
 */
export async function getEventFeed(opts: { force?: boolean } = {}): Promise<FeedEnvelope> {
  if (!opts.force && cache && Date.now() - cache.at < FEED_TTL_MS) {
    return { ...cache.data, cached: true, ageMs: Date.now() - cache.at };
  }
  if (inFlight) return inFlight;

  inFlight = buildFeed().finally(() => {
    inFlight = null;
  });
  const data = await inFlight;
  cache = { at: Date.now(), data };
  return data;
}

async function buildFeed(): Promise<FeedEnvelope> {
  const { central, mist } = getClients();
  const { nameById, centralSites } = siteIndex();
  const endSec = Math.floor(Date.now() / 1000);
  const startSec = endSec - WINDOW_SEC;
  const hours = Math.round(WINDOW_SEC / 3600);

  const items: FeedItem[] = [];
  const sources: FeedSource[] = [];

  // Central と Mist は別のレートリミッタなので同時に走らせる(待ち時間が足し算にならない)。
  // どちらの中でも取得元ごとに try/catch するので、この Promise.all は reject しない。
  await Promise.all([centralPart(), mistPart()]);
  // 取得元の並びは完了順に依存させない(表示順を固定する)。
  const order = ["central-alerts", "central-events", "mist-alarms", "mist-device-events", "mist-client-events"];
  sources.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  // --- Central: アラート(org 一括・1 本)+ イベント(サイト単位ループ) ---
  async function centralPart(): Promise<void> {
  if (central) {
    const before = central.getRequestCount();
    try {
      const { items: alerts, total } = await central.fetchAllAlerts(LIMIT_CENTRAL_ALERTS);
      for (const [i, a] of alerts.entries()) {
        items.push({
          id: `central-alert:${a.id ?? i}`,
          kind: "alert",
          platform: "central",
          source: "central-alerts",
          siteId: null,
          siteName: a.siteName || "(サイト未割り当て)",
          timestamp: a.createdAt,
          severity: normSeverity(a.severity),
          severityRaw: a.severity,
          category: a.category,
          type: a.type,
          text: a.summary,
          deviceLabel: a.deviceLabel,
          state: a.state,
        });
      }
      sources.push({
        key: "central-alerts",
        label: "Central アラート",
        platform: "central",
        status: "ok",
        error: null,
        count: alerts.length,
        total,
        requests: central.getRequestCount() - before,
        note: "org 一括・全 status(Active / Cleared)",
      });
    } catch (err) {
      sources.push({
        key: "central-alerts",
        label: "Central アラート",
        platform: "central",
        status: "error",
        error: msgOf(err),
        count: 0,
        total: null,
        requests: central.getRequestCount() - before,
        note: "org 一括",
      });
    }
  }

  // --- Central: イベント(サイト単位ループ。org 一括の窓口が無い) ---
  if (central && centralSites.length > 0) {
    const before = central.getRequestCount();
    let ok = 0;
    let failed = 0;
    let lastError: string | null = null;
    // まとめて投げてよい。RateLimiter(既定 4 req/sec のトークンバケット)が送出を直列化して
    // 間隔を空けるので、Central の枠(10 req/sec・アカウント共有)を踏み越えない。
    // 直列に await すると 1 本ごとに往復待ちが乗って 13 サイトで 10 秒超かかる。
    // fetchSiteEvents は失敗を status="error" で返し throw しないので、部分失敗も潰れない。
    const secs = await Promise.all(
      centralSites.map((s) => central.fetchSiteEvents(s.siteId, LIMIT_CENTRAL_SITE_EVENTS)),
    );
    for (const [si, s] of centralSites.entries()) {
      const sec = secs[si];
      if (sec.status === "error") {
        failed += 1;
        lastError = sec.error;
        continue;
      }
      ok += 1;
      for (const [i, e] of sec.items.entries()) {
        items.push({
          id: `central-event:${s.siteId}:${e.timestamp ?? ""}:${i}`,
          kind: "event",
          platform: "central",
          source: "central-events",
          siteId: s.siteId,
          siteName: s.siteName,
          timestamp: e.timestamp,
          severity: normSeverity(e.severity),
          severityRaw: e.severity,
          category: e.category,
          type: e.type,
          text: e.text,
          deviceLabel: e.deviceLabel,
          state: null,
        });
      }
    }
    sources.push({
      key: "central-events",
      label: "Central イベント",
      platform: "central",
      status: failed > 0 && ok === 0 ? "error" : "ok",
      error: failed > 0 ? `${failed} サイトで取得失敗(最後の理由: ${lastError})` : null,
      count: items.filter((it) => it.source === "central-events").length,
      total: null,
      requests: central.getRequestCount() - before,
      note: `サイト単位ループ ${ok}/${centralSites.length} サイト・各 ${LIMIT_CENTRAL_SITE_EVENTS} 件まで・直近 ${hours}h`,
    });
  }
  }

  // --- Mist: アラーム / デバイスイベント / クライアントイベント(いずれも org 一括) ---
  async function mistPart(): Promise<void> {
  if (mist) {
    const mistJobs: Array<{
      key: string;
      label: string;
      note: string;
      run: () => Promise<{ added: number; total: number | null }>;
    }> = [
      {
        key: "mist-alarms",
        label: "Mist アラーム",
        note: `org 一括・直近 ${hours}h`,
        run: async () => {
          const { items: alarms, total } = await mist.fetchOrgAlarms(startSec, endSec, LIMIT_MIST_ALARMS);
          for (const [i, a] of alarms.entries()) {
            items.push({
              id: `mist-alarm:${a.id ?? i}`,
              kind: "alert",
              platform: "mist",
              source: "mist-alarms",
              siteId: a.siteId,
              siteName: resolveName(nameById, "mist", a.siteId),
              timestamp: a.timestamp,
              severity: normSeverity(a.severity),
              severityRaw: a.severity,
              category: a.group,
              type: a.type,
              text: a.summary,
              deviceLabel: a.deviceLabel,
              state: null,
            });
          }
          return { added: alarms.length, total };
        },
      },
      {
        key: "mist-device-events",
        label: "Mist デバイスイベント",
        note: `org 一括・${LIMIT_MIST_DEVICE_EVENTS} 件まで・直近 ${hours}h`,
        run: async () => {
          const { items: evs, total } = await mist.fetchOrgDeviceEvents(startSec, endSec, LIMIT_MIST_DEVICE_EVENTS);
          for (const [i, e] of evs.entries()) {
            items.push({
              id: `mist-devev:${e.siteId ?? ""}:${e.timestamp ?? ""}:${i}`,
              kind: "event",
              platform: "mist",
              source: "mist-device-events",
              siteId: e.siteId,
              siteName: resolveName(nameById, "mist", e.siteId),
              timestamp: e.timestamp,
              // Mist のイベントは重要度を持たない。無いことを severityRaw=null で示す。
              severity: "info",
              severityRaw: null,
              category: "Device",
              type: e.type,
              text: e.text,
              deviceLabel: e.deviceLabel,
              state: null,
            });
          }
          return { added: evs.length, total };
        },
      },
      {
        key: "mist-client-events",
        label: "Mist クライアントイベント",
        note: `org 一括・${LIMIT_MIST_CLIENT_EVENTS} 件まで・直近 ${hours}h`,
        run: async () => {
          const { items: evs, total } = await mist.fetchOrgClientEvents(startSec, endSec, LIMIT_MIST_CLIENT_EVENTS);
          for (const [i, e] of evs.entries()) {
            items.push({
              id: `mist-cliev:${e.siteId ?? ""}:${e.timestamp ?? ""}:${i}`,
              kind: "event",
              platform: "mist",
              source: "mist-client-events",
              siteId: e.siteId,
              siteName: resolveName(nameById, "mist", e.siteId),
              timestamp: e.timestamp,
              severity: "info",
              severityRaw: null,
              category: "Client",
              type: e.type,
              text: e.text,
              deviceLabel: e.deviceLabel,
              state: null,
            });
          }
          return { added: evs.length, total };
        },
      },
    ];

    for (const job of mistJobs) {
      const before = mist.getRequestCount();
      try {
        const { added, total } = await job.run();
        sources.push({
          key: job.key,
          label: job.label,
          platform: "mist",
          status: "ok",
          error: null,
          count: added,
          total,
          requests: mist.getRequestCount() - before,
          note: job.note,
        });
      } catch (err) {
        sources.push({
          key: job.key,
          label: job.label,
          platform: "mist",
          status: "error",
          error: msgOf(err),
          count: 0,
          total: null,
          requests: mist.getRequestCount() - before,
          note: job.note,
        });
      }
    }
    // Mist の 3 本は直列のまま。同時に投げると getRequestCount() の差分が混ざって
    // 取得元ごとの HTTP 本数を正しく出せなくなる(2 req/sec 制限で待ち時間も大差ない)。
  }
  }

  // 新しい順。timestamp が無いものは末尾へ。
  items.sort((a, b) => {
    const at = a.timestamp ? Date.parse(a.timestamp) : Number.NEGATIVE_INFINITY;
    const bt = b.timestamp ? Date.parse(b.timestamp) : Number.NEGATIVE_INFINITY;
    return bt - at;
  });

  return {
    fetchedAt: new Date().toISOString(),
    cached: false,
    ageMs: 0,
    windowSec: WINDOW_SEC,
    ttlMs: FEED_TTL_MS,
    requests: sources.reduce((n, s) => n + s.requests, 0),
    sources,
    items,
  };
}
