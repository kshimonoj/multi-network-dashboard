// Streaming(Central)View — サーバ型のミラー(webhook-feed/view/types.ts と同じ流儀)。
// サーバ側の実体は plugins/central-streaming/types.ts / catalog.ts。
// View から server の .ts を直接 import しないのは、既存プラグインの流儀に合わせるため。

export type StreamKey =
  | "audit-trail"
  | "ap-monitoring"
  | "geofence"
  | "location"
  | "location-analytics";

export type StreamConnState = "disabled" | "connecting" | "open" | "reconnecting" | "error";

export interface StreamEventTypeDef {
  id: string;
  label: string;
  message: string;
}

export interface StreamEndpointDef {
  key: StreamKey;
  label: string;
  path: string;
  protoFile: string;
  selectableSubtypes: boolean;
  volume: "low" | "medium" | "high";
  note: string;
  eventTypes: StreamEventTypeDef[];
}

export interface StreamEvent {
  id: string;
  receivedAt: string;
  eventAt: string | null;
  stream: StreamKey;
  type: string;
  typeLabel: string;
  category: string | null;
  summary: string;
  siteId: string | null;
  siteName: string | null;
  deviceLabel: string | null;
  actor: string | null;
  payload: Record<string, unknown>;
  decodeError: string | null;
}

export interface StreamStatus {
  key: StreamKey;
  label: string;
  enabled: boolean;
  state: StreamConnState;
  since: string | null;
  lastEventAt: string | null;
  received: number;
  attempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  url: string | null;
  eventTypes: string[];
  tokenExpiresAt: string | null;
}

export interface StreamSubscription {
  enabled: boolean;
  eventTypes: string[];
}

export interface StreamSettings {
  enabled: boolean;
  streams: Record<StreamKey, StreamSubscription>;
  retentionDays: number;
  maxEvents: number;
}

export interface StreamEnvelope {
  configured: boolean;
  configError: string | null;
  settings: StreamSettings;
  streams: StreamStatus[];
  items: StreamEvent[];
  stored: number;
  lastPurgeAt: string | null;
  lastPurged: number;
  retentionOptionsDays: number[];
  maxEventsOptions: number[];
  generatedAt: string;
}

/** 接続状態のラベル(タスク指定の「未接続 / 接続中 / 再接続中 / エラー」に対応)。 */
export const STATE_LABEL: Record<StreamConnState, string> = {
  disabled: "未接続",
  connecting: "接続中…",
  open: "接続済み",
  reconnecting: "再接続中",
  error: "エラー",
};

export const STREAM_SHORT: Record<StreamKey, string> = {
  "audit-trail": "Audit",
  "ap-monitoring": "AP",
  geofence: "Geofence",
  location: "Location",
  "location-analytics": "RSSI",
};

export const VOLUME_LABEL: Record<StreamEndpointDef["volume"], string> = {
  low: "流量: 小",
  medium: "流量: 中",
  high: "流量: 大",
};
