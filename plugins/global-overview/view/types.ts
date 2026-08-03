// Global Overview View — サーバ側の型のミラー。
//
// サーバ実装(plugins/global-overview/aggregate.ts / poller.ts)は Node 側のモジュールを
// import しており、そのまま view から参照すると node:fs 等がバンドルに巻き込まれる。
// そこで「API のレスポンス形」だけをここに写す。サーバ側の型を変えたらここも合わせる。

import type { TFunc } from "../../../src/i18n/LanguageContext";

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
  /** Central のみ 0-100。Mist は bulk API が返さないため null(画面では「—」)。 */
  healthScore: number | null;
  clients: number;
  /** Central: Active アラート件数 / Mist: 直近 24h のアラーム件数(定義が異なる) */
  alerts: number;
  criticalAlerts: number;
  devices: DeviceBreakdown;
  deviceTotal: number;
  deviceUp: number;
  deviceDown: number;
  inSiteMap: boolean;
}

export interface PlatformSummary {
  ok: boolean;
  error: string | null;
  fetchedAt: string | null;
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
  siteMapOnly: Array<{ siteName: string; platform: Platform; siteId: string }>;
}

export interface RateLimitStats {
  requests: number;
  retries: number;
  waitedMs: number;
  lastAt: string | null;
}

export interface SnapshotEnvelope {
  snapshot: Snapshot | null;
  ageMs: number | null;
  stale: boolean;
  pollIntervalMs: number;
  minRefreshMs: number;
  rateLimit: { central: RateLimitStats | null; mist: RateLimitStats | null };
  /** 503 / 502 のときサーバが載せてくるメッセージ */
  error?: string;
}

// ---- 画面表示用の定数(プラットフォームの呼称と、アラートの定義ラベル)----
//
// Central の「Active」と Mist の「直近 24h」は母集団が違う。合算値をそのまま
// 「アクティブアラート」と呼ぶと誤読されるため、パネル・テーブル・凡例のすべてで
// この 2 つのラベルを必ず併記する。

export const PLATFORM_LABEL: Record<Platform, string> = {
  central: "HPE Aruba Central",
  mist: "Juniper Mist",
};

export const PLATFORM_SHORT: Record<Platform, string> = {
  central: "Central",
  mist: "Mist",
};

/** アラート件数の定義(短いラベル。数値の直後に添える) */
export function alertLabel(t: TFunc, p: Platform): string {
  return t(`globalOverview.alertLabel.${p}`);
}

/** アラート件数の定義(説明文。tooltip や凡例で使う) */
export function alertDesc(t: TFunc, p: Platform): string {
  return t(`globalOverview.alertDesc.${p}`);
}

export const DEVICE_KIND_LABEL: Record<DeviceKind, string> = {
  ap: "AP",
  switch: "Switch",
  gateway: "Gateway",
};

export const DEVICE_KINDS: DeviceKind[] = ["ap", "switch", "gateway"];
