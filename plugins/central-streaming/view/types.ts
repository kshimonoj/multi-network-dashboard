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
  /** 日本語固定のラベル(後方互換用)。表示には使わず `key` を i18n 辞書に引く(32 番) */
  label: string;
  /** i18n 辞書引き用の安定キー */
  key: string;
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

// 接続状態(state)・流量(volume)のラベルは 32 番で i18n 辞書
// (centralStreaming.state.* / centralStreaming.volume.*)に移した。
// 表示は CentralStreaming.tsx の stateLabel(t, state) / volumeLabel(t, volume) を使う。

/** ストリームの短縮タグ(タイムラインのバッジ用)。技術的な省略表記のため言語を切り替えない。 */
export const STREAM_SHORT: Record<StreamKey, string> = {
  "audit-trail": "Audit",
  "ap-monitoring": "AP",
  geofence: "Geofence",
  location: "Location",
  "location-analytics": "RSSI",
};
