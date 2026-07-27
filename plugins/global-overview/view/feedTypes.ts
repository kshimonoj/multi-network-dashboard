// Global Overview View — 全サイト横断 Event/Alert 一覧の型ミラー(13 Task 2)。
// サーバ側 plugins/global-overview/feed-types.ts と同じ形。変えたら両方直す。

export type FeedPlatform = "central" | "mist";
export type FeedKind = "alert" | "event";
export type FeedSeverity = "critical" | "warning" | "info";

export interface FeedItem {
  id: string;
  kind: FeedKind;
  platform: FeedPlatform;
  source: string;
  siteId: string | null;
  siteName: string;
  timestamp: string | null;
  severity: FeedSeverity;
  severityRaw: string | null;
  category: string | null;
  type: string | null;
  text: string;
  deviceLabel: string | null;
  state: string | null;
}

export interface FeedSource {
  key: string;
  label: string;
  platform: FeedPlatform;
  status: "ok" | "error";
  error: string | null;
  count: number;
  total: number | null;
  requests: number;
  note: string;
}

export interface FeedEnvelope {
  fetchedAt: string;
  cached: boolean;
  ageMs: number;
  windowSec: number;
  /** サーバ側キャッシュの有効時間(ミリ秒)。既定 60 秒 */
  ttlMs: number;
  requests: number;
  sources: FeedSource[];
  items: FeedItem[];
}
