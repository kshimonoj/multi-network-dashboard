// Global Overview View — サイト詳細(オンデマンド)の型ミラー。
// サーバ側 plugins/global-overview/detail-types.ts と同じ形。変えたら両方直す。

import type { Platform } from "./types";

export type SectionStatus = "ok" | "error" | "unavailable";

export interface DetailClient {
  mac: string;
  name: string | null;
  os: string | null;
  band: string | null;
  channel: number | null;
  snr: number | null;
  rssi: number | null;
  ssid: string | null;
  status: string | null;
  ip: string | null;
  connectedTo: string | null;
  vendor: string | null;
}

export interface DetailDevice {
  id: string;
  name: string | null;
  kind: "ap" | "switch" | "gateway" | "other";
  model: string | null;
  status: string | null;
  up: boolean;
  firmware: string | null;
  uptimeMs: number | null;
  ip: string | null;
  mac: string | null;
  numClients: number | null;
}

export interface DetailAlert {
  id: string | null;
  severity: string | null;
  category: string | null;
  summary: string;
  type: string | null;
  createdAt: string | null;
  deviceLabel: string | null;
}

export interface DetailEvent {
  timestamp: string | null;
  type: string | null;
  text: string;
  deviceLabel: string | null;
  /** Central: negative/neutral/positive。Mist は null */
  severity: string | null;
  /** Central: category。Mist は null(client events は proto) */
  category: string | null;
}

export interface DetailHealth {
  score: number | null;
  source: "central-groups" | "mist-sle" | null;
  metrics: Array<{ label: string; value: number | null; unit?: string }>;
  status: SectionStatus;
  error: string | null;
}

export interface DetailSection<T> {
  status: SectionStatus;
  error: string | null;
  items: T[];
  note?: string;
}

export interface SiteDetailEnvelope {
  platform: Platform;
  siteId: string;
  siteName: string;
  fetchedAt: string;
  cached: boolean;
  ageMs: number;
  requests: number;
  health: DetailHealth;
  clients: DetailSection<DetailClient>;
  devices: DetailSection<DetailDevice>;
  alerts: DetailSection<DetailAlert>;
  events: DetailSection<DetailEvent>;
}

/** クライアント 1 件の詳細(Task 3。オンデマンド)。 */
export interface ClientDetailEnvelope {
  platform: Platform;
  siteId: string;
  mac: string;
  fetchedAt: string;
  cached: boolean;
  ageMs: number;
  requests: number;
  events: DetailSection<DetailEvent>;
}
