// Global Overview View — /api/global-overview/* への fetch ラッパ。
//
// GET は「サーバのキャッシュを読むだけ」で外部 API を叩かない(05 の設計)。
// 画面表示・ポーリングはすべて GET /snapshot を使い、外部 API を起こすのは
// 明示的な手動更新(POST /refresh)だけにする。

import type { SnapshotEnvelope, Platform } from "./types";
import type { SiteDetailEnvelope, ClientDetailEnvelope } from "./detailTypes";
import type { FeedEnvelope } from "./feedTypes";

const BASE = "/api/global-overview";

// 503(スナップショット未生成)/ 502(取得失敗)はエラー本文にも封筒の中身が入っている。
// 画面側で「まだ無い」ことを出したいので、throw せず封筒として返す。
async function envelope(res: Response): Promise<SnapshotEnvelope> {
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const env = parsed as SnapshotEnvelope;
  if (!res.ok && !("snapshot" in (env as object))) {
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return env;
}

/** サイトマップのタイル設定(85)。サーバの env 由来。 */
export interface MapTileConfig {
  urlLight: string;
  urlDark: string;
  attribution: string;
  subdomains: string;
  maxZoom: number;
}

let mapTileConfig: Promise<MapTileConfig> | null = null;

/** 画面の寿命中は変わらないので 1 回だけ取りに行く(失敗したら次回また取りに行く)。 */
export function fetchMapTileConfig(): Promise<MapTileConfig> {
  if (!mapTileConfig) {
    mapTileConfig = fetch(`${BASE}/map-config`).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as MapTileConfig;
    });
    mapTileConfig.catch(() => {
      mapTileConfig = null;
    });
  }
  return mapTileConfig;
}

/** キャッシュ済みスナップショットの取得(外部 API は叩かれない)。 */
export async function fetchSnapshot(): Promise<SnapshotEnvelope> {
  return envelope(await fetch(`${BASE}/snapshot`));
}

/**
 * 手動更新。サーバ側が最短間隔(既定 60 秒)を守るので、間隔内なら
 * 外部 API を叩かずキャッシュがそのまま返る(= 連打しても実害は無い)。
 * それでも UI としては押した感触が必要なので、呼び出し側でボタンを無効化する。
 */
export async function refreshSnapshot(): Promise<SnapshotEnvelope> {
  return envelope(await fetch(`${BASE}/refresh`, { method: "POST" }));
}

/**
 * サイト 1 件の詳細をオンデマンドで取得する(11 番)。
 * 定期ポーリングとは別枠。サーバ側が 30 秒キャッシュ + in-flight 共有でガードするので、
 * 同一サイトを続けて開いても外部 API は叩き直されない。
 */
export async function fetchSiteDetail(
  platform: Platform,
  siteId: string,
  siteName: string,
): Promise<SiteDetailEnvelope> {
  const q = new URLSearchParams({ platform, siteId, siteName });
  const res = await fetch(`${BASE}/site-detail?${q.toString()}`);
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  if (!res.ok) {
    const msg = (parsed as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return parsed as SiteDetailEnvelope;
}

/**
 * クライアント 1 件の詳細(イベント履歴)をオンデマンドで取得する(Task 3)。
 * 行を展開したときだけ発火。サーバ側が 30 秒キャッシュ + in-flight 共有でガードする。
 */
export async function fetchClientDetail(
  platform: Platform,
  siteId: string,
  mac: string,
): Promise<ClientDetailEnvelope> {
  const q = new URLSearchParams({ platform, siteId, mac });
  const res = await fetch(`${BASE}/client-detail?${q.toString()}`);
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  if (!res.ok) {
    const msg = (parsed as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return parsed as ClientDetailEnvelope;
}

/**
 * 全サイト横断 Event/Alert 一覧の取得(13 Task 2)。オンデマンド。
 * サーバ側が 60 秒キャッシュ + in-flight 共有でガードする。force=true は「更新」ボタン用。
 */
export async function fetchEventFeed(force = false): Promise<FeedEnvelope> {
  const res = await fetch(`${BASE}/events${force ? "?force=1" : ""}`);
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error((parsed as { error?: string })?.error ?? `HTTP ${res.status}`);
  return parsed as FeedEnvelope;
}

export interface PollSettings {
  pollIntervalMs: number;
  minRefreshMs: number;
  minMs: number;
  maxMs: number;
  optionsMs: number[];
}

/** 現在のポーリング間隔設定を取得する(Task 4)。 */
export async function fetchSettings(): Promise<PollSettings> {
  const res = await fetch(`${BASE}/settings`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PollSettings;
}

/** ポーリング間隔を変更する(Task 4)。サーバ側で永続化・即反映される。 */
export async function updatePollInterval(pollIntervalMs: number): Promise<PollSettings> {
  const res = await fetch(`${BASE}/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pollIntervalMs }),
  });
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error((parsed as { error?: string })?.error ?? `HTTP ${res.status}`);
  return parsed as PollSettings;
}

export interface OverviewStatus {
  configured: { central: boolean; mist: boolean };
  cache: {
    generatedAt: string | null;
    ageMs: number | null;
    stale: boolean;
    pollIntervalMs: number;
    minRefreshMs: number;
  };
  platforms: { central: { ok: boolean; error: string | null }; mist: { ok: boolean; error: string | null } } | null;
}

export async function fetchStatus(): Promise<OverviewStatus> {
  const res = await fetch(`${BASE}/status`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as OverviewStatus;
}
