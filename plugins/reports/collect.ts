// 日次レポート(41 Task 1)— 当日分のデータ収集。
//
// 方針: **新たに外部 API を叩き直さない**。既存の 4 機能が既に持っている
// ポーリング結果・保存済みデータから「その日ぶん」を切り出して集約する。
//
//   Global Overview … reports/sampler.ts が溜めた当日サンプル(samples/*.jsonl)を平均する。
//                     当日サンプルが 1 件も無い場合だけ、実行時点のスナップショットで代用する。
//   Webhook ログ    … data/webhook-feed/feed.json 相当のメモリ上フィード(getCachedFeed)を期間で絞る。
//   Streaming       … central-streaming のメモリ上イベント(getEventsInRange)を期間で絞る。
//   ネットワーク調査 … data/network-investigation/query-history.jsonl を期間で絞る。
//
// 「取れなかった」ことも機械可読に残す(available:false + reason)。42/43 が
// 「0 件」と「未計測」を区別できるようにするため。

import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { getCached } from "../global-overview/poller.js";
import { getCachedFeed } from "../webhook-feed/poller.js";
import {
  getMeta as getArchiveMeta,
  isSaneTime,
  readDay as readArchiveDay,
  type ArchiveMeta,
} from "../webhook-feed/archive.js";
import type { WebhookFeedItem } from "../webhook-feed/feed-types.js";
import { getEventsInRange, retentionDays as streamRetentionDays, getSettings as getStreamSettings } from "../central-streaming/store.js";
import type { QueryHistoryRecord } from "../network-investigation/api.js";
import { readSamples } from "./store.js";
import type { OverviewSample } from "./sampler.js";
import { dateKeyOf, dayWindow, inWindow, type DayWindow } from "./time.js";
import type {
  DailyAuditEvent,
  DailyInvestigation,
  DailyInvestigations,
  DailyOverview,
  DailyRawSummary,
  DailySiteStat,
  DailyStreaming,
  DailyWebhook,
  DailyWebhookAlert,
  MinMaxAvg,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NETINV_DATA_DIR =
  process.env.NETINV_DATA_DIR || path.resolve(__dirname, "../../data/network-investigation");
const HISTORY_PATH = path.join(NETINV_DATA_DIR, "query-history.jsonl");

/** プロンプトに載せる件数の上限(レポート本体にも同じ上限で保存する)。 */
const CAP = {
  criticalAlerts: 120,
  warningAlerts: 60,
  auditEvents: 120,
  investigations: 80,
};

// ---- 統計ヘルパー ----

class Acc {
  private sum = 0;
  private n = 0;
  private lo: number | null = null;
  private hi: number | null = null;

  add(v: number | null | undefined): void {
    if (v === null || v === undefined || !Number.isFinite(v)) return;
    this.sum += v;
    this.n += 1;
    this.lo = this.lo === null ? v : Math.min(this.lo, v);
    this.hi = this.hi === null ? v : Math.max(this.hi, v);
  }

  get result(): MinMaxAvg {
    return {
      avg: this.n ? Math.round((this.sum / this.n) * 10) / 10 : null,
      min: this.lo,
      max: this.hi,
      samples: this.n,
    };
  }
}

function bump(rec: Record<string, number>, key: string | null | undefined): void {
  const k = (key ?? "").trim() || "(未分類)";
  rec[k] = (rec[k] ?? 0) + 1;
}

// ---- Global Overview ----

const TRAFFIC_REASON =
  "トラフィック量(バイト / bps)を返すエンドポイントが、このアプリが使っている取得経路" +
  "(Central: network-monitoring/v1 の sites-health・devices・alerts / Mist: orgs stats/sites・stats/devices・alarms)" +
  "に含まれていないため未計測。Mist SLE の Throughput は品質スコア(%)であって転送量ではない。";

function foldSamples(samples: OverviewSample[]): DailyOverview {
  const totals = {
    devicesUp: new Acc(),
    devicesDown: new Acc(),
    clients: new Acc(),
    alerts: new Acc(),
  };
  let sitesMax = 0;
  let devicesMax = 0;

  interface SiteAcc {
    siteName: string;
    platform: "central" | "mist";
    siteId: string | null;
    health: Acc;
    sle: Acc;
    sleMetrics: Map<string, Acc>;
    clients: Acc;
    deviceTotal: number;
    upMin: number | null;
    downMax: number | null;
    alertsMax: number | null;
    criticalMax: number | null;
    samples: number;
  }
  const bySite = new Map<string, SiteAcc>();

  for (const s of samples) {
    totals.devicesUp.add(s.totals.devicesUp);
    totals.devicesDown.add(s.totals.devicesDown);
    totals.clients.add(s.totals.clients);
    totals.alerts.add(s.totals.alerts);
    sitesMax = Math.max(sitesMax, s.totals.sites);
    devicesMax = Math.max(devicesMax, s.totals.devices);

    for (const row of s.sites) {
      const key = `${row.p}:${row.i ?? row.n}`;
      let acc = bySite.get(key);
      if (!acc) {
        acc = {
          siteName: row.n,
          platform: row.p,
          siteId: row.i,
          health: new Acc(),
          sle: new Acc(),
          sleMetrics: new Map(),
          clients: new Acc(),
          deviceTotal: 0,
          upMin: null,
          downMax: null,
          alertsMax: null,
          criticalMax: null,
          samples: 0,
        };
        bySite.set(key, acc);
      }
      acc.samples += 1;
      acc.siteName = row.n || acc.siteName;
      acc.health.add(row.h);
      acc.sle.add(row.s);
      if (row.sm) {
        for (const [label, v] of Object.entries(row.sm)) {
          let m = acc.sleMetrics.get(label);
          if (!m) {
            m = new Acc();
            acc.sleMetrics.set(label, m);
          }
          m.add(v);
        }
      }
      acc.clients.add(row.c);
      acc.deviceTotal = Math.max(acc.deviceTotal, row.dt);
      acc.upMin = acc.upMin === null ? row.du : Math.min(acc.upMin, row.du);
      acc.downMax = acc.downMax === null ? row.dd : Math.max(acc.downMax, row.dd);
      acc.alertsMax = acc.alertsMax === null ? row.a : Math.max(acc.alertsMax, row.a);
      acc.criticalMax = acc.criticalMax === null ? row.ca : Math.max(acc.criticalMax, row.ca);
    }
  }

  const sites: DailySiteStat[] = [...bySite.values()]
    .map((a) => ({
      siteName: a.siteName,
      platform: a.platform,
      siteId: a.siteId,
      centralHealth: a.platform === "central" ? a.health.result : null,
      mistSle: a.platform === "mist" ? a.sle.result : null,
      mistSleMetrics:
        a.platform === "mist"
          ? [...a.sleMetrics.entries()].map(([label, acc]) => ({ label, avg: acc.result.avg }))
          : [],
      clients: a.clients.result,
      devices: { total: a.deviceTotal, upMin: a.upMin, downMax: a.downMax },
      alerts: { max: a.alertsMax, criticalMax: a.criticalMax },
      samples: a.samples,
    }))
    .sort((x, y) => (x.platform === y.platform ? x.siteName.localeCompare(y.siteName, "ja") : x.platform < y.platform ? -1 : 1));

  const notes: string[] = [];
  if (!samples.some((s) => s.sle)) {
    notes.push("Mist SLE をこの日は 1 度も取得できていない(未設定 / 取得失敗)ため、SLE 平均は空です。");
  }

  return {
    source: "samples",
    sampleCount: samples.length,
    firstSampleAt: samples.length ? samples[0].t : null,
    lastSampleAt: samples.length ? samples[samples.length - 1].t : null,
    totals: {
      sites: sitesMax,
      devices: devicesMax,
      devicesUp: totals.devicesUp.result,
      devicesDown: totals.devicesDown.result,
      clients: totals.clients.result,
      alerts: totals.alerts.result,
    },
    sites,
    traffic: { available: false, reason: TRAFFIC_REASON },
    notes,
  };
}

/** 当日サンプルが無い日(蓄積開始前・後追い生成)に、実行時点のスナップショットで代用する。 */
function foldCurrentSnapshot(): DailyOverview {
  const snap = getCached().snapshot;
  if (!snap) {
    return {
      source: "none",
      sampleCount: 0,
      firstSampleAt: null,
      lastSampleAt: null,
      totals: {
        sites: 0,
        devices: 0,
        devicesUp: { avg: null, min: null, max: null, samples: 0 },
        devicesDown: { avg: null, min: null, max: null, samples: 0 },
        clients: { avg: null, min: null, max: null, samples: 0 },
        alerts: { avg: null, min: null, max: null, samples: 0 },
      },
      sites: [],
      traffic: { available: false, reason: TRAFFIC_REASON },
      notes: ["Global Overview のスナップショットが未生成のため、この日のサイト状態は記録できていません。"],
    };
  }
  // 1 点しかないので avg=min=max。値が無ければ母数 0 の空統計にする(NaN を作らない)。
  const one = (v: number | null | undefined): MinMaxAvg =>
    v === null || v === undefined || !Number.isFinite(v)
      ? { avg: null, min: null, max: null, samples: 0 }
      : { avg: v, min: v, max: v, samples: 1 };
  return {
    source: "current-snapshot",
    sampleCount: 0,
    firstSampleAt: null,
    lastSampleAt: snap.generatedAt,
    totals: {
      sites: snap.totals.sites,
      devices: snap.totals.devices,
      devicesUp: one(snap.totals.devicesUp),
      devicesDown: one(snap.totals.devicesDown),
      clients: one(snap.totals.clients),
      alerts: one(snap.totals.alerts),
    },
    sites: snap.sites.map((s) => ({
      siteName: s.siteName,
      platform: s.platform,
      siteId: s.siteId,
      centralHealth: s.platform === "central" ? one(s.healthScore) : null,
      mistSle: null,
      mistSleMetrics: [],
      clients: one(s.clients),
      devices: { total: s.deviceTotal, upMin: s.deviceUp, downMax: s.deviceDown },
      alerts: { max: s.alerts, criticalMax: s.criticalAlerts },
      samples: 1,
    })),
    traffic: { available: false, reason: TRAFFIC_REASON },
    notes: [
      "この日の時系列サンプルが無いため、レポート生成時点のスナップショット 1 点で代用しています(当日平均ではありません)。",
    ],
  };
}

async function collectOverview(w: DayWindow): Promise<DailyOverview> {
  const all = await readSamples<OverviewSample>(w.dateKey);
  // ファイル名は記録時刻のローカル日付なので基本は同日だが、日跨ぎの書き込み競合に備えて絞る。
  const samples = all
    .filter((s) => s && typeof s.t === "string" && inWindow(s.t, w) && Array.isArray(s.sites))
    .sort((a, b) => (a.t < b.t ? -1 : 1));
  if (samples.length === 0) return foldCurrentSnapshot();
  return foldSamples(samples);
}

// ---- Webhook ログ ----
//
// 42: 集計は **日別アーカイブ**(data/webhook-feed/daily/YYYY-MM-DD.jsonl)から読む。
// 41 番までは poller のメモリ上フィードを期間で絞っていたが、そちらは表示用の
// ローリングバッファ(既定 3000 件)なので、1 日 3000 件を超える日や複数日ぶんが
// 溜まった状態では「その日、実際に何件あったか」を出せなかった。
// アーカイブは日ごとにファイルが分かれていて上限を持たないので、件数が正確になる。

/** アーカイブの日付振り分けと同じ規則で、その行の「まともな時刻」を取り出す。 */
function pickSaneMs(i: WebhookFeedItem): number | null {
  for (const iso of [i.eventAt, i.receivedAt]) {
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (isSaneTime(ms)) return ms;
  }
  return null;
}

/** その日が日別アーカイブの対象期間に入っているか(保存開始日以降か)。 */
function isArchivedDay(dateKey: string, meta: ArchiveMeta): boolean {
  return dateKey >= dateKeyOf(meta.startedAt);
}

/** アーカイブが使えないときだけ通る旧経路(表示キャッシュを期間で絞る)。 */
function collectWebhookFromMemory(w: DayWindow, base: DailyWebhook): DailyWebhook {
  const feed = getCachedFeed();
  const items = feed.items.filter((i) => inWindow(i.eventAt ?? i.receivedAt, w));
  if (items.length === 0) {
    let oldest: string | null = null;
    for (const i of feed.items) {
      const t = i.eventAt ?? i.receivedAt;
      if (t && (oldest === null || t < oldest)) oldest = t;
    }
    if (oldest && Date.parse(oldest) >= w.endMs) {
      return {
        ...base,
        available: false,
        source: "memory",
        reason:
          `この日の Webhook ログは表示キャッシュの保持件数上限から溢れています` +
          `(手元にある最古の行は ${oldest})。0 件は「事象が無かった」ことを意味しません。`,
      };
    }
  }
  return foldWebhookItems(items, { ...base, source: "memory", partial: true, reason: null });
}

async function collectWebhook(w: DayWindow): Promise<DailyWebhook> {
  const feed = getCachedFeed();
  const empty: DailyWebhook = {
    available: false,
    reason: feed.configError ?? "Webhook ログのフィードがまだ生成されていません",
    source: "archive",
    partial: false,
    total: 0,
    bySeverity: {},
    bySource: {},
    byCategory: {},
    byType: {},
    critical: [],
    warning: [],
    truncated: { critical: 0, warning: 0 },
  };

  const meta = getArchiveMeta();
  if (!meta) {
    // アーカイブがまだ初期化されていない(初回起動直後など)。旧経路にフォールバックする。
    if (!feed.configured) return empty;
    return collectWebhookFromMemory(w, empty);
  }

  const day = await readArchiveDay(w.dateKey);
  const partial = meta.partialDays.includes(w.dateKey);

  if (!day.exists) {
    // ファイルが無い = その日は「保存していない」か「1 件も来なかった」。
    // 保存開始日より前なら前者と断言できる(旧方式の上限で失われた期間)。
    if (!isArchivedDay(w.dateKey, meta)) {
      return {
        ...empty,
        available: false,
        reason:
          `この日は日別アーカイブの対象期間外です(保存開始 ${meta.startedAt})。` +
          `42 番より前は表示用の保持上限(既定 3000 件)を超えた分が失われており、復元できません。`,
      };
    }
    // 保存期間内でファイルが無い日は「1 件も受信しなかった」として 0 件で確定させる。
    return { ...empty, available: true, reason: null, total: 0 };
  }

  // 日付の振り分けはアーカイブ側と同じ TZ で行っているので基本は全件が区間内。
  // TZ 設定を変えた場合に備えて念のため絞るが、時刻を持たない行・上流で桁が壊れている行
  // (Mist の NAC 系に実在)は **ファイルの日を信じる**。振り分けに使った時刻はそちらだから。
  const items = day.items.filter((i) => {
    const ms = pickSaneMs(i);
    return ms === null ? true : ms >= w.startMs && ms < w.endMs;
  });

  return foldWebhookItems(items, {
    ...empty,
    available: true,
    reason: partial
      ? `この日は日別アーカイブへの移行日のため、0:00 からではなく途中からの記録です(件数は実際より少ない可能性があります)。`
      : day.corrupt > 0
        ? `アーカイブに読めない行が ${day.corrupt} 行ありました(集計から除外)。`
        : null,
    partial,
  });
}

function foldWebhookItems(items: WebhookFeedItem[], base: DailyWebhook): DailyWebhook {
  const bySeverity: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const critical: DailyWebhookAlert[] = [];
  const warning: DailyWebhookAlert[] = [];

  const toAlert = (i: (typeof items)[number]): DailyWebhookAlert => ({
    at: i.eventAt ?? i.receivedAt,
    source: i.source,
    severity: i.severity,
    severityRaw: i.severityRaw,
    siteName: i.siteName,
    deviceLabel: i.deviceLabel,
    category: i.category,
    type: i.type,
    message: i.message,
    alertKey: i.alertKey,
  });

  for (const i of items) {
    bump(bySeverity, i.severity);
    bump(bySource, i.source);
    bump(byCategory, i.category);
    bump(byType, i.type);
    if (i.severity === "critical") critical.push(toAlert(i));
    else if (i.severity === "warning") warning.push(toAlert(i));
  }

  const sortDesc = (a: DailyWebhookAlert, b: DailyWebhookAlert) => ((a.at ?? "") < (b.at ?? "") ? 1 : -1);
  critical.sort(sortDesc);
  warning.sort(sortDesc);

  return {
    ...base,
    available: true,
    total: items.length,
    bySeverity,
    bySource,
    byCategory,
    byType,
    critical: critical.slice(0, CAP.criticalAlerts),
    warning: warning.slice(0, CAP.warningAlerts),
    truncated: {
      critical: Math.max(0, critical.length - CAP.criticalAlerts),
      warning: Math.max(0, warning.length - CAP.warningAlerts),
    },
  };
}

// ---- Streaming(Central)の Audit Trail ----

function collectStreaming(w: DayWindow): DailyStreaming {
  const settings = getStreamSettings();
  const events = getEventsInRange(w.startMs, w.endMs);

  const byStream: Record<string, number> = {};
  const audit: DailyAuditEvent[] = [];
  for (const e of events) {
    bump(byStream, e.stream);
    if (e.stream !== "audit-trail") continue;
    audit.push({
      at: e.eventAt ?? e.receivedAt,
      stream: e.stream,
      typeLabel: e.typeLabel,
      category: e.category,
      actor: e.actor,
      siteName: e.siteName,
      deviceLabel: e.deviceLabel,
      summary: e.summary,
    });
  }
  audit.sort((a, b) => ((a.at ?? "") < (b.at ?? "") ? 1 : -1));

  const enabled = settings.enabled && settings.streams["audit-trail"]?.enabled === true;
  return {
    available: events.length > 0 || enabled,
    reason:
      events.length > 0
        ? null
        : enabled
          ? `この日の保存済みイベントがありません(Streaming の保持は ${streamRetentionDays()} 日)`
          : "Streaming(Central)が停止中、または Audit Trail を購読していません",
    total: events.length,
    byStream,
    auditTrail: {
      total: audit.length,
      items: audit.slice(0, CAP.auditEvents),
      truncated: Math.max(0, audit.length - CAP.auditEvents),
    },
  };
}

// ---- ネットワーク調査の実行履歴 ----

/** 「同じ問題が繰り返し調べられていないか」の手がかり用に、クエリ文を粗く正規化する。 */
function normalizeQuery(q: string): string {
  return q
    .replace(/\s+/g, "")
    .replace(/[0-9]{2,}/g, "#")
    .toLowerCase()
    .slice(0, 80);
}

async function collectInvestigations(w: DayWindow): Promise<DailyInvestigations> {
  let raw: string;
  try {
    raw = await readFile(HISTORY_PATH, "utf-8");
  } catch {
    return { total: 0, bySource: {}, errors: 0, items: [], truncated: 0, repeated: [] };
  }

  const items: DailyInvestigation[] = [];
  const bySource: Record<string, number> = {};
  let errors = 0;

  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let rec: QueryHistoryRecord;
    try {
      rec = JSON.parse(s) as QueryHistoryRecord;
    } catch {
      continue;
    }
    if (!rec || typeof rec.id !== "string" || !inWindow(rec.ts, w)) continue;
    bump(bySource, rec.source);
    if (rec.isError) errors += 1;
    items.push({
      at: rec.ts,
      runId: rec.id,
      query: rec.query,
      site: rec.site ?? null,
      source: rec.source,
      model: rec.model ?? null,
      isError: Boolean(rec.isError),
    });
  }

  items.sort((a, b) => (a.at < b.at ? 1 : -1));

  // 同じ(正規化クエリ, サイト)の組が 2 回以上出たものだけを残す。
  const groups = new Map<string, { query: string; site: string | null; count: number; firstAt: string; lastAt: string }>();
  for (const it of items) {
    const key = `${normalizeQuery(it.query)}|${it.site ?? ""}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { query: it.query, site: it.site, count: 1, firstAt: it.at, lastAt: it.at });
    } else {
      g.count += 1;
      if (it.at < g.firstAt) g.firstAt = it.at;
      if (it.at > g.lastAt) g.lastAt = it.at;
    }
  }

  return {
    total: items.length,
    bySource,
    errors,
    items: items.slice(0, CAP.investigations),
    truncated: Math.max(0, items.length - CAP.investigations),
    repeated: [...groups.values()].filter((g) => g.count >= 2).sort((a, b) => b.count - a.count),
  };
}

// ---- 入口 ----

/** 対象日の生データ集約を作る(外部 API は叩かない)。 */
export async function collectDay(dateKey: string): Promise<{ window: DayWindow; data: DailyRawSummary }> {
  const w = dayWindow(dateKey);
  const [overview, investigations, webhook] = await Promise.all([
    collectOverview(w),
    collectInvestigations(w),
    collectWebhook(w),
  ]);
  return {
    window: w,
    data: {
      overview,
      webhook,
      streaming: collectStreaming(w),
      investigations,
    },
  };
}

/**
 * 後追い生成(Task 3-3)の判定に使う。
 * 4 ソースすべてが空なら「その日はまだアプリが動いていなかった」とみなし、レポートを作らない
 * (初回起動直後に、データの無い過去 7 日ぶんの LLM 呼び出しが走るのを防ぐ)。
 */
export function hasAnyData(data: DailyRawSummary): boolean {
  return (
    data.overview.sampleCount > 0 ||
    data.webhook.total > 0 ||
    data.streaming.total > 0 ||
    data.investigations.total > 0
  );
}
