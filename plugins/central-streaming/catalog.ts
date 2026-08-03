// Streaming(Central)(20 Task 1 / Task 2-7)— エンドポイントとイベント種別のカタログ。
//
// このファイルはサーバ側(ws-client / decoder)と View 側の両方から参照される
// 「1 つの正」。エンドポイントのパス・event-types の識別子・2 段目の protobuf
// メッセージ名の 3 つが必ず揃うようにしている。
//
// 注意しておきたい非対称:
//   ・AP Monitoring だけベースパスが network-monitoring/v1alpha1(他は network-services/v1alpha1)。
//     event-types の名前空間も com.hpe.greenlake.network-monitoring.* になる。
//   ・Geofence / Location / Location Analytics は「event-types が 2 つあるが、
//     封筒の中身は共通の 1 メッセージ(oneof か、raw/proximity の入り分け)」。
//   ・Audit Trail は 20 サブタイプすべてが同じ AuditTrail メッセージ。
//
// 実測(20 番の疎通確認)で分かった落とし穴:
//   CloudEvent の proto_data.type_url は **ドキュメントの .proto の package と一致しない**
//   (例: type.googleapis.com/location.v1alpha1.StreamLocationMessage に対し、
//    .proto の package は network_services.location.v1alpha1)。
//   したがって type_url で 2 段目のメッセージを選ぶことはできず、
//   CloudEvent の `type` フィールドからこのカタログ経由で引く必要がある。

export type StreamKey =
  | "audit-trail"
  | "ap-monitoring"
  | "geofence"
  | "location"
  | "location-analytics";

export interface StreamEventTypeDef {
  /** event-types クエリパラメータに渡す完全な識別子 */
  id: string;
  /**
   * 画面に出す短いラベル(日本語固定・後方互換用)。
   * View 側は 32 番以降これを直接出さず、`key` を src/i18n の
   * `centralStreaming.*EventType.*` に引いて表示言語に合わせる。
   */
  label: string;
  /** i18n 辞書引き用の安定キー(エンドポイント内で一意。id から機械的に導出できないため明示する) */
  key: string;
  /** 2 段目のデコードに使う protobuf メッセージの完全修飾名 */
  message: string;
}

export interface StreamEndpointDef {
  key: StreamKey;
  /** 日本語固定のラベル(後方互換用)。View 側は `key` を `centralStreaming.endpoint.*.label` に引く(32 番) */
  label: string;
  /** wss://<central-base-url>/<path> の <path> */
  path: string;
  /** 参照している .proto ファイル名(画面の説明用) */
  protoFile: string;
  /** サブタイプを個別に選べるか(false のときは全部購読する) */
  selectableSubtypes: boolean;
  /** 想定される流量。既定で有効にするかの判断材料として画面にも出す */
  volume: "low" | "medium" | "high";
  /** 日本語固定の説明文(後方互換用)。View 側は `key` を `centralStreaming.endpoint.*.note` に引く(32 番) */
  note: string;
  eventTypes: StreamEventTypeDef[];
}

const AT = "com.hpe.greenlake.network-services.v1alpha1.audit-trail";
const AP = "com.hpe.greenlake.network-monitoring.v1alpha1.aps";
const NS = "com.hpe.greenlake.network-services.v1alpha1";
// Location だけ 21 番のタスクで v1 の新エンドポイント(network-services/v1/location-events)に
// 前倒し移行した。event-types の名前空間も v1alpha1 → v1 に変わる(実測で確認済み)。
const NS_LOCATION_V1 = "com.hpe.greenlake.network-services.v1";

const AUDIT_MSG = "network_services.audit_trail.v1alpha1.AuditTrail";

/** Audit Trail の 20 サブカテゴリ(ドキュメント記載順)。すべて AuditTrail メッセージ。 */
const AUDIT_SUBTYPES: Array<[string, string]> = [
  ["device-monitoring", "デバイス監視"],
  ["configuration", "コンフィグ"],
  ["certificate-management", "証明書管理"],
  ["alert-management", "アラート管理"],
  ["system-management", "システム管理"],
  ["central-nac", "Central NAC"],
  ["overlay-tunnel-orchestrator", "オーバーレイトンネル"],
  ["reporting", "レポート"],
  ["firmware-management", "ファームウェア管理"],
  ["security", "セキュリティ"],
  ["gcis", "GCIS"],
  ["troubleshooting", "トラブルシューティング"],
  ["subscription", "サブスクリプション"],
  ["floorplan-manager", "フロアプラン"],
  ["configuration-validation", "コンフィグ検証"],
  ["extension", "拡張"],
  ["service-config-bridge", "サービス設定ブリッジ"],
  ["configuration-distribution", "コンフィグ配信"],
  ["configuration-import", "コンフィグ取り込み"],
  ["configuration-health", "コンフィグ健全性"],
];

export const ENDPOINTS: StreamEndpointDef[] = [
  {
    key: "audit-trail",
    label: "Audit Trail(監査証跡)",
    path: "network-services/v1alpha1/audit-trail-events",
    protoFile: "audit_trail.proto",
    selectableSubtypes: true,
    volume: "low",
    note: "Central 上の設定変更・操作の記録。20 サブカテゴリから選べる。流量は低く、設定変更をすると即座に流れてくる。",
    eventTypes: AUDIT_SUBTYPES.map(([sub, label]) => ({
      id: `${AT}.${sub}`,
      label,
      key: sub,
      message: AUDIT_MSG,
    })),
  },
  {
    key: "ap-monitoring",
    label: "AP Monitoring(AP 監視)",
    // ここだけ network-monitoring 配下。
    path: "network-monitoring/v1alpha1/ap-events",
    protoFile: "ap_monitoring.proto",
    selectableSubtypes: true,
    volume: "high",
    note: "AP の状態(state.*)と統計(stats.*)。stats.* は AP 台数 × 周期で流れるため流量が大きい。まずは state.* だけを選ぶのが無難。",
    eventTypes: [
      { id: `${AP}.state.device`, label: "状態: デバイス", key: "state-device", message: "network_monitoring.ap.v1alpha1.APInfo" },
      { id: `${AP}.state.radio`, label: "状態: 無線", key: "state-radio", message: "network_monitoring.ap.v1alpha1.RadioInfo" },
      { id: `${AP}.state.port`, label: "状態: ポート", key: "state-port", message: "network_monitoring.ap.v1alpha1.PortInfo" },
      {
        id: `${AP}.state.virtual_access_point`,
        label: "状態: VAP",
        key: "state-vap",
        message: "network_monitoring.ap.v1alpha1.VapInfo",
      },
      { id: `${AP}.state.wlan`, label: "状態: WLAN", key: "state-wlan", message: "network_monitoring.ap.v1alpha1.WlanInfo" },
      { id: `${AP}.state.tunnel`, label: "状態: トンネル", key: "state-tunnel", message: "network_monitoring.ap.v1alpha1.TunnelInfo" },
      { id: `${AP}.stats.device`, label: "統計: デバイス", key: "stats-device", message: "network_monitoring.ap.v1alpha1.APSystemStat" },
      { id: `${AP}.stats.radio`, label: "統計: 無線", key: "stats-radio", message: "network_monitoring.ap.v1alpha1.RadioStat" },
      {
        id: `${AP}.stats.virtual_access_point`,
        label: "統計: VAP",
        key: "stats-vap",
        message: "network_monitoring.ap.v1alpha1.VapStat",
      },
      { id: `${AP}.stats.port`, label: "統計: ポート", key: "stats-port", message: "network_monitoring.ap.v1alpha1.PortStat" },
      { id: `${AP}.stats.modem`, label: "統計: モデム", key: "stats-modem", message: "network_monitoring.ap.v1alpha1.ModemStat" },
      { id: `${AP}.stats.tunnel`, label: "統計: トンネル", key: "stats-tunnel", message: "network_monitoring.ap.v1alpha1.TunnelStat" },
      { id: `${AP}.stats.ip_probe`, label: "統計: IP プローブ", key: "stats-ip-probe", message: "network_monitoring.ap.v1alpha1.IPProbeStat" },
      { id: `${AP}.stats.user_role`, label: "統計: ユーザーロール", key: "stats-user-role", message: "network_monitoring.ap.v1alpha1.RoleStat" },
      { id: `${AP}.stats.ssid`, label: "統計: SSID", key: "stats-ssid", message: "network_monitoring.ap.v1alpha1.SsidStat" },
      { id: `${AP}.stats.vlan`, label: "統計: VLAN", key: "stats-vlan", message: "network_monitoring.ap.v1alpha1.VlanStat" },
    ],
  },
  {
    key: "geofence",
    label: "Geofence(ジオフェンス)",
    path: "network-services/v1alpha1/geofence",
    protoFile: "geofence.proto",
    selectableSubtypes: true,
    volume: "low",
    note: "ゾーンの入退出。フロアプランでゾーンを定義していないと流れてこない。",
    eventTypes: [
      {
        id: `${NS}.wifi-client-geofence-crossed`,
        label: "Wi-Fi クライアント",
        key: "wifi-client",
        message: "network_services.geofence.v1alpha1.StreamGeofenceMessage",
      },
      {
        id: `${NS}.asset-tag-geofence-crossed`,
        label: "アセットタグ",
        key: "asset-tag",
        message: "network_services.geofence.v1alpha1.StreamGeofenceMessage",
      },
    ],
  },
  {
    key: "location",
    label: "Location(位置情報)",
    // 21 番: v1alpha1/location は 2026-09-30 廃止予告(CloudEvent attributes で通知)のため
    // v1/location-events に前倒し移行済み。
    path: "network-services/v1/location-events",
    protoFile: "location_v1.proto",
    selectableSubtypes: true,
    volume: "high",
    note: "測位結果。クライアント数に比例して秒あたり数件〜が流れ続ける。長時間の有効化は Retention 設定に注意。",
    eventTypes: [
      {
        id: `${NS_LOCATION_V1}.wifi-client-locations.created`,
        label: "Wi-Fi クライアント位置",
        key: "wifi-client",
        message: "network_services.location.v1.StreamLocationMessage",
      },
      {
        id: `${NS_LOCATION_V1}.asset-tags.last-known-location.created`,
        label: "アセットタグ最終位置",
        key: "asset-tag",
        message: "network_services.location.v1.StreamLocationMessage",
      },
    ],
  },
  {
    key: "location-analytics",
    label: "Location Analytics(RSSI)",
    path: "network-services/v1alpha1/rssi-events",
    protoFile: "location_analytics.proto",
    selectableSubtypes: true,
    volume: "high",
    note: "AP が観測した生 RSSI / 近接 RSSI。Location よりさらに流量が大きい。",
    eventTypes: [
      {
        id: `${NS}.rssi.raw-rssi`,
        label: "Raw RSSI",
        key: "raw",
        message: "network_services.location_analytics.v1alpha1.RssiEvent",
      },
      {
        id: `${NS}.rssi.proximity-rssi`,
        label: "Proximity RSSI",
        key: "proximity",
        message: "network_services.location_analytics.v1alpha1.RssiEvent",
      },
    ],
  },
];

export const STREAM_KEYS: StreamKey[] = ENDPOINTS.map((e) => e.key);

const BY_KEY = new Map(ENDPOINTS.map((e) => [e.key, e]));
const TYPE_INDEX = new Map<string, { endpoint: StreamEndpointDef; type: StreamEventTypeDef }>();
for (const e of ENDPOINTS) {
  for (const t of e.eventTypes) TYPE_INDEX.set(t.id, { endpoint: e, type: t });
}

export function endpointOf(key: StreamKey): StreamEndpointDef | undefined {
  return BY_KEY.get(key);
}

export function isStreamKey(v: unknown): v is StreamKey {
  return typeof v === "string" && BY_KEY.has(v as StreamKey);
}

/** CloudEvent の type から、2 段目のデコードに使うメッセージ名とラベルを引く。 */
export function lookupEventType(type: string): { endpoint: StreamEndpointDef; type: StreamEventTypeDef } | null {
  return TYPE_INDEX.get(type) ?? null;
}

/** 未知の type でも、キーごとの既定メッセージで最低限デコードを試みるための保険。 */
export function fallbackMessageFor(key: StreamKey): string | null {
  const e = BY_KEY.get(key);
  return e?.eventTypes[0]?.message ?? null;
}
