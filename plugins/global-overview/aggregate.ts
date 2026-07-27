// Global Overview — Central / Mist の生データを 1 つのスナップショットに畳む
//
// 出力の形は NetView の画面(サイト数・デバイス数・接続クライアント数・アクティブアラート数、
// ベンダー別の AP/Switch/Gateway 台数と稼働状況、サイト別内訳)に対応させている。
//
// サイト → プラットフォームの帰属は、既存の対応表
// (data/network-investigation/site-platform-map.json / plugins/network-investigation/site-map.ts)
// を流用する。対応表は「Central と Mist が同一サイトを重複管理しない」前提の 1 対 1 表なので、
// ここでもその前提のまま、API 実データ側を主、対応表を補助(位置情報の補完と突き合わせ)として扱う。

import { readSiteMap, type SitePlatformEntry } from "../network-investigation/site-map.js";
import type { CentralRaw } from "./central-client.js";
import type { MistRaw } from "./mist-client.js";

export type Platform = "central" | "mist";
export type DeviceKind = "ap" | "switch" | "gateway";

export interface DeviceCounts {
  total: number;
  up: number;
  down: number;
}

export interface DeviceBreakdown {
  ap: DeviceCounts;
  switch: DeviceCounts;
  gateway: DeviceCounts;
}

export interface SiteRow {
  siteName: string;
  platform: Platform;
  siteId: string | null;
  lat: number | null;
  lng: number | null;
  /** Central のみ 0-100。Mist は健全性スコアを bulk で返さないため null。 */
  healthScore: number | null;
  clients: number;
  /** Central: Active アラート件数 / Mist: 集計窓内のアラーム件数 */
  alerts: number;
  /** うち Critical。Mist は severity を集計していないため 0。 */
  criticalAlerts: number;
  devices: DeviceBreakdown;
  deviceTotal: number;
  deviceUp: number;
  deviceDown: number;
  /** 対応表(site-platform-map.json)に載っているか。false = 対応表の再生成が必要かもしれない。 */
  inSiteMap: boolean;
}

export interface PlatformSummary {
  ok: boolean;
  error: string | null;
  fetchedAt: string | null;
  /** この refresh で出した HTTP リクエスト数 */
  requests: number;
  sites: number;
  clients: number;
  alerts: number;
  devices: DeviceBreakdown;
  deviceTotal: number;
  deviceUp: number;
  deviceDown: number;
}

export interface Snapshot {
  generatedAt: string;
  totals: {
    sites: number;
    devices: number;
    devicesUp: number;
    devicesDown: number;
    clients: number;
    alerts: number;
  };
  devices: DeviceBreakdown;
  platforms: Record<Platform, PlatformSummary>;
  sites: SiteRow[];
  /** 対応表にあるのに今回の API 応答に現れなかったサイト(対応表が古い可能性) */
  siteMapOnly: Array<{ siteName: string; platform: Platform; siteId: string }>;
}

const zero = (): DeviceCounts => ({ total: 0, up: 0, down: 0 });
const emptyBreakdown = (): DeviceBreakdown => ({ ap: zero(), switch: zero(), gateway: zero() });

function addCounts(dst: DeviceCounts, src: DeviceCounts): void {
  dst.total += src.total;
  dst.up += src.up;
  dst.down += src.down;
}

function addBreakdown(dst: DeviceBreakdown, src: DeviceBreakdown): void {
  addCounts(dst.ap, src.ap);
  addCounts(dst.switch, src.switch);
  addCounts(dst.gateway, src.gateway);
}

function totalOf(b: DeviceBreakdown): { total: number; up: number; down: number } {
  return {
    total: b.ap.total + b.switch.total + b.gateway.total,
    up: b.ap.up + b.switch.up + b.gateway.up,
    down: b.ap.down + b.switch.down + b.gateway.down,
  };
}

/** Central の deviceType 文字列を AP/Switch/Gateway の 3 分類に落とす。分類外は null。 */
function centralKind(deviceType: string): DeviceKind | null {
  switch (deviceType.toUpperCase()) {
    case "ACCESS_POINT":
    case "AP":
      return "ap";
    case "SWITCH":
      return "switch";
    case "GATEWAY":
      return "gateway";
    default:
      return null;
  }
}

export function emptyPlatformSummary(error: string | null): PlatformSummary {
  return {
    ok: error === null,
    error,
    fetchedAt: null,
    requests: 0,
    sites: 0,
    clients: 0,
    alerts: 0,
    devices: emptyBreakdown(),
    deviceTotal: 0,
    deviceUp: 0,
    deviceDown: 0,
  };
}

/** Central 生データ → サイト行 + プラットフォーム集計。 */
function foldCentral(raw: CentralRaw, map: SitePlatformEntry[]): { rows: SiteRow[]; summary: PlatformSummary } {
  const byName = new Map<string, SiteRow>();
  const mapByName = new Map(
    map.filter((e) => e.platform === "central").map((e) => [e.siteName.toLowerCase(), e]),
  );

  for (const s of raw.sites) {
    const m = mapByName.get(s.siteName.toLowerCase());
    byName.set(s.siteName, {
      siteName: s.siteName,
      platform: "central",
      siteId: s.siteId ?? m?.siteId ?? null,
      // 位置は API 実データを優先し、欠けていれば対応表で補完する。
      lat: s.lat ?? m?.lat ?? null,
      lng: s.lng ?? m?.lng ?? null,
      healthScore: s.healthScore,
      clients: s.clientCount,
      // sites-health の alerts は Active の実態と合わないため使わない(central-client.ts の注記)。
      alerts: raw.alertsBySite[s.siteName] ?? 0,
      criticalAlerts: raw.criticalAlertsBySite[s.siteName] ?? 0,
      devices: emptyBreakdown(),
      deviceTotal: 0,
      deviceUp: 0,
      deviceDown: 0,
      inSiteMap: Boolean(m),
    });
  }

  // デバイス一覧をサイトごとに振り分ける。サイト未割り当てのデバイスは
  // 合計には入れたいので、"(未割り当て)" の行を作る。
  const UNASSIGNED = "(サイト未割り当て)";
  for (const d of raw.devices) {
    const kind = centralKind(d.deviceType);
    if (!kind) continue;
    const name = d.siteName || UNASSIGNED;
    let row = byName.get(name);
    if (!row) {
      row = {
        siteName: name,
        platform: "central",
        siteId: d.siteId,
        lat: null,
        lng: null,
        healthScore: null,
        clients: 0,
        alerts: raw.alertsBySite[name] ?? 0,
        criticalAlerts: raw.criticalAlertsBySite[name] ?? 0,
        devices: emptyBreakdown(),
        deviceTotal: 0,
        deviceUp: 0,
        deviceDown: 0,
        inSiteMap: false,
      };
      byName.set(name, row);
    }
    const up = (d.status ?? "").toUpperCase() === "ONLINE";
    row.devices[kind].total += 1;
    if (up) row.devices[kind].up += 1;
    else row.devices[kind].down += 1;
  }

  const rows = [...byName.values()];
  const devices = emptyBreakdown();
  for (const r of rows) {
    const t = totalOf(r.devices);
    r.deviceTotal = t.total;
    r.deviceUp = t.up;
    r.deviceDown = t.down;
    addBreakdown(devices, r.devices);
  }
  const t = totalOf(devices);

  return {
    rows,
    summary: {
      ok: true,
      error: null,
      fetchedAt: new Date().toISOString(),
      requests: raw.requests,
      sites: raw.sites.length,
      clients: rows.reduce((a, r) => a + r.clients, 0),
      // アラートは alerts エンドポイントの total(Active 絞り込み済み)を正とする。
      alerts: raw.activeAlertTotal,
      devices,
      deviceTotal: t.total,
      deviceUp: t.up,
      deviceDown: t.down,
    },
  };
}

/** Mist 生データ → サイト行 + プラットフォーム集計。 */
function foldMist(raw: MistRaw, map: SitePlatformEntry[]): { rows: SiteRow[]; summary: PlatformSummary } {
  const mapById = new Map(map.filter((e) => e.platform === "mist").map((e) => [e.siteId, e]));

  const rows: SiteRow[] = raw.sites.map((s) => {
    const m = mapById.get(s.siteId);
    const devices: DeviceBreakdown = {
      ap: { total: s.numAp, up: s.numApConnected, down: Math.max(0, s.numAp - s.numApConnected) },
      switch: {
        total: s.numSwitch,
        up: s.numSwitchConnected,
        down: Math.max(0, s.numSwitch - s.numSwitchConnected),
      },
      gateway: {
        total: s.numGateway,
        up: s.numGatewayConnected,
        down: Math.max(0, s.numGateway - s.numGatewayConnected),
      },
    };
    const t = totalOf(devices);
    return {
      siteName: s.siteName || m?.siteName || s.siteId,
      platform: "mist" as const,
      siteId: s.siteId,
      lat: s.lat ?? m?.lat ?? null,
      lng: s.lng ?? m?.lng ?? null,
      // Mist は org スコープの bulk でサイト健全性スコアを返さない(SLE は別 API・別コスト)。
      healthScore: null,
      clients: s.numClients,
      alerts: raw.alarmsBySite[s.siteId] ?? 0,
      criticalAlerts: 0,
      devices,
      deviceTotal: t.total,
      deviceUp: t.up,
      deviceDown: t.down,
      inSiteMap: Boolean(m),
    };
  });

  const devices = emptyBreakdown();
  for (const r of rows) addBreakdown(devices, r.devices);
  const t = totalOf(devices);

  return {
    rows,
    summary: {
      ok: true,
      error: null,
      fetchedAt: new Date().toISOString(),
      requests: raw.requests,
      sites: rows.length,
      clients: rows.reduce((a, r) => a + r.clients, 0),
      alerts: raw.alarmTotal,
      devices,
      deviceTotal: t.total,
      deviceUp: t.up,
      deviceDown: t.down,
    },
  };
}

/**
 * 両プラットフォームの生データ(取得できた側のみ)をスナップショットに畳む。
 * 片方が失敗しても、もう片方は結果に残す(全体を倒さない — site-map.ts と同じ方針)。
 */
export async function buildSnapshot(input: {
  central: { raw: CentralRaw } | { error: string };
  mist: { raw: MistRaw } | { error: string };
}): Promise<Snapshot> {
  const map = await readSiteMap();

  const central =
    "raw" in input.central
      ? foldCentral(input.central.raw, map)
      : { rows: [] as SiteRow[], summary: emptyPlatformSummary(input.central.error) };
  const mist =
    "raw" in input.mist
      ? foldMist(input.mist.raw, map)
      : { rows: [] as SiteRow[], summary: emptyPlatformSummary(input.mist.error) };

  const sites = [...central.rows, ...mist.rows].sort((a, b) => {
    if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1;
    return a.siteName.localeCompare(b.siteName, "ja");
  });

  const devices = emptyBreakdown();
  addBreakdown(devices, central.summary.devices);
  addBreakdown(devices, mist.summary.devices);
  const t = totalOf(devices);

  // 対応表にあるのに今回の応答に出てこなかったサイト(= 対応表が古い / サイトが消えた)。
  // 取得に失敗したプラットフォームは判定不能なので対象外にする。
  const seen = new Set(sites.map((s) => `${s.platform}:${s.siteId ?? s.siteName}`));
  const seenNames = new Set(sites.map((s) => `${s.platform}:${s.siteName.toLowerCase()}`));
  const siteMapOnly = map
    .filter((e) => (e.platform === "central" ? central.summary.ok : mist.summary.ok))
    .filter((e) => !seen.has(`${e.platform}:${e.siteId}`) && !seenNames.has(`${e.platform}:${e.siteName.toLowerCase()}`))
    .map((e) => ({ siteName: e.siteName, platform: e.platform, siteId: e.siteId }));

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      sites: central.summary.sites + mist.summary.sites,
      devices: t.total,
      devicesUp: t.up,
      devicesDown: t.down,
      clients: central.summary.clients + mist.summary.clients,
      alerts: central.summary.alerts + mist.summary.alerts,
    },
    devices,
    platforms: { central: central.summary, mist: mist.summary },
    sites,
    siteMapOnly,
  };
}
