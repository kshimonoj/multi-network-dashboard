/**
 * タグ付き Client / Device(59)— サーバ側の型。
 *
 * 設計の要点(58 §2-1 で確定):
 *   **Central 用と Mist 用で共通の抽象型を作らない。**`platform` による判別可能ユニオンにし、
 *   片方にしか無い項目をもう一方で `null` 埋めしない。「取得できない」は型ではなく
 *   コンポーネント側の固定注記(<NotSupported>)で表現する。
 *
 *   共通なのは「タグ側が持つ情報」(TargetAssignment)だけ。
 */

export type Platform = "central" | "mist";
export type TargetKind = "client" | "device";

// ---- タグ(ローカル DB。Central / Mist の設定には一切触れない)----

export const TAG_COLORS = [
  "slate",
  "blue",
  "green",
  "amber",
  "red",
  "purple",
  "cyan",
  "pink",
] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export interface TagDef {
  id: string;
  /** ユーザーが入力した実行時データ。翻訳しない(CLAUDE.md の規約) */
  name: string;
  color: TagColor;
  description: string | null;
  createdAt: string;
}

/** 対象を最後に見かけた場所。**非正準**(キーではない。次に探す先のヒント) */
export interface LastSeenHint {
  platform: Platform | null;
  siteId: string | null;
  siteName: string | null;
  at: string | null;
}

export interface TargetAssignment {
  kind: TargetKind;
  /** 正準キー = 区切り無し小文字 12 桁 MAC(57 §3-2) */
  key: string;
  /** device のみ。Central のデバイス系 API はシリアル引きなので併記して持つ */
  serial: string | null;
  tagIds: string[];
  /** ユーザーの覚え書き。翻訳しない */
  label: string | null;
  note: string | null;
  lastSeen: LastSeenHint | null;
  /** 登録時点でランダム MAC と判定されたか(警告表示の根拠を残す) */
  randomMac: boolean;
  addedAt: string;
}

export interface TagStoreFile {
  version: 1;
  updatedAt: string;
  tags: TagDef[];
  assignments: TargetAssignment[];
}

export interface TaggedTargetsSettings {
  /** 一覧の突合結果をこの時間だけ使い回す(明示更新はこれを無視する) */
  listTtlMs: number;
  /** 詳細のキャッシュ TTL */
  detailTtlMs: number;
  /** Mist の現況取得で叩くサイト数の上限(タグ対象が散っている場合の保険) */
  maxMistSites: number;
}

// ---- 一覧(突合結果)----

/** Central のクライアント一覧行。`network-monitoring/v1/clients` の生フィールド由来 */
export interface CentralClientSummary {
  platform: "central";
  mac: string;
  clientName: string | null;
  hostName: string | null;
  ipv4: string | null;
  connectionType: string | null;
  status: string | null;
  siteId: string | null;
  siteName: string | null;
  connectedTo: string | null;
  wlanName: string | null;
  wirelessBand: string | null;
  wirelessChannel: string | null;
  snr: number | null;
  clientVendor: string | null;
  clientManufacturer: string | null;
  clientOperatingSystem: string | null;
  clientCategory: string | null;
  connectedAt: string | null;
  /** 実データで文字列 `"0"` が来る(58 §1-8-1)。日時としてレンダリングしない */
  lastSeenAtRaw: string | null;
}

/** Mist のクライアント一覧行 */
export interface MistClientSummary {
  platform: "mist";
  mac: string;
  hostname: string | null;
  ip: string | null;
  connectionType: "wireless" | "wired";
  /** stats/clients に居れば true(= 今つながっている) */
  connected: boolean;
  siteId: string | null;
  siteName: string | null;
  ssid: string | null;
  band: string | null;
  channel: number | null;
  proto: string | null;
  rssi: number | null;
  snr: number | null;
  txBps: number | null;
  rxBps: number | null;
  uptimeSec: number | null;
  manufacture: string | null;
  os: string | null;
  family: string | null;
  randomMac: boolean | null;
  isGuest: boolean | null;
  username: string | null;
  pskName: string | null;
  /** 収容スイッチ(有線のみ) */
  deviceMac: string | null;
  portId: string | null;
  /** 検索側の観測時刻(秒 epoch → ISO) */
  lastSeen: string | null;
}

export type ClientSummary = CentralClientSummary | MistClientSummary;

export interface CentralDeviceSummary {
  platform: "central";
  serialNumber: string;
  macAddress: string | null;
  deviceName: string | null;
  deviceType: string;
  model: string | null;
  status: string | null;
  firmwareVersion: string | null;
  siteId: string | null;
  siteName: string | null;
  ipv4: string | null;
  uptimeMs: number | null;
}

export interface MistDeviceSummary {
  platform: "mist";
  id: string;
  mac: string;
  serial: string | null;
  name: string | null;
  type: string;
  model: string | null;
  status: string | null;
  version: string | null;
  siteId: string | null;
  siteName: string | null;
  ip: string | null;
  uptimeSec: number | null;
}

export type DeviceSummary = CentralDeviceSummary | MistDeviceSummary;

/** 1 対象ぶんの一覧行。matches が空 = どこにも見つからなかった(灰色で残す。57 §3-5) */
export interface TaggedRow<S> {
  assignment: TargetAssignment;
  matches: S[];
}

export interface ListEnvelope<S> {
  fetchedAt: string;
  cached: boolean;
  ageMs: number;
  rows: Array<TaggedRow<S>>;
  /** プラットフォームごとの取得結果(片方が落ちても他方は出す) */
  sources: Array<{ platform: Platform; ok: boolean; error: string | null; requests: number }>;
  /** maxMistSites 等で取得を打ち切った場合の記録(黙って切らない) */
  truncated: string[];
}

// ---- 詳細 ----

export interface Section<T> {
  status: "ok" | "error" | "unsupported";
  error: string | null;
  items: T[];
  note?: string;
}

export interface EventRow {
  timestamp: string | null;
  type: string | null;
  text: string;
  deviceLabel: string | null;
}

export interface AppUsageRow {
  app: string;
  rxBytes: number | null;
  txBytes: number | null;
  totalBytes: number | null;
}

/** Central のクライアント詳細。`clients/{mac}` の 41 フィールドのうち UI で使うぶん */
export interface CentralClientDetail {
  platform: "central";
  mac: string;
  clientName: string | null;
  hostName: string | null;
  userName: string | null;
  ipv4: string | null;
  ipv6: string | null;
  siteId: string | null;
  siteName: string | null;
  connectionType: string | null;
  status: string | null;
  role: string | null;
  vlanId: string | null;
  vlanName: string | null;
  tunnelType: string | null;
  tunnelId: string | null;
  authenticationType: string | null;
  keyManagement: string | null;
  wirelessSecurity: string | null;
  wlanName: string | null;
  wirelessBand: string | null;
  wirelessChannel: string | null;
  phyType: string | null;
  mloOperMode: string | null;
  snr: number | null;
  bssid: string | null;
  radioMacAddress: string | null;
  connectedTo: string | null;
  connectedDeviceType: string | null;
  connectedDeviceSerial: string | null;
  port: string | null;
  connectedAt: string | null;
  lastSeenAtRaw: string | null;
  clientVendor: string | null;
  clientManufacturer: string | null;
  clientCategory: string | null;
  clientFunction: string | null;
  clientOperatingSystem: string | null;
  /** カンマ区切り文字列(58 §1-8-6)。分解済みで返す */
  capabilities: string[];
  /** Central 自身の ML 分類タグ。**本アプリのタグとは別物**(58 §1-8-3) */
  centralTags: string[];
  events: Section<EventRow>;
}

/** Mist のクライアント詳細 */
export interface MistClientDetail {
  platform: "mist";
  mac: string;
  connectionType: "wireless" | "wired";
  connected: boolean;
  siteId: string | null;
  siteName: string | null;
  hostname: string | null;
  ip: string | null;
  manufacture: string | null;
  model: string | null;
  os: string | null;
  osVersion: string | null;
  family: string | null;
  randomMac: boolean | null;
  isGuest: boolean | null;
  username: string | null;
  pskName: string | null;
  // 無線のみ
  apMac: string | null;
  apName: string | null;
  bssid: string | null;
  ssid: string | null;
  wlanId: string | null;
  vlanId: string | null;
  band: string | null;
  channel: number | null;
  proto: string | null;
  keyMgmt: string | null;
  rssi: number | null;
  snr: number | null;
  txBps: number | null;
  rxBps: number | null;
  txBytes: number | null;
  rxBytes: number | null;
  txRetries: number | null;
  rxRetries: number | null;
  uptimeSec: number | null;
  idleTimeSec: number | null;
  lastSeen: string | null;
  // 有線のみ
  deviceMac: string | null;
  portId: string | null;
  vlanName: string | null;
  authMethod: string | null;
  authState: string | null;
  /** 無線のみ。有線は status:"unsupported"(57 §1-8) */
  apps: Section<AppUsageRow>;
  events: Section<EventRow>;
}

export type ClientDetail = CentralClientDetail | MistClientDetail;

// ---- デバイス詳細 ----

export interface CentralRadioRow {
  radioNumber: number | null;
  band: string | null;
  channel: string | null;
  bandwidth: string | null;
  power: string | null;
  status: string | null;
  clientCount: number | null;
  channelUtilization: number | null;
  channelQuality: number | null;
  noiseFloor: number | null;
  nonWifiInterference: number | null;
  rxUtilization: number | null;
  txUtilization: number | null;
  retries: number | null;
  drops: number | null;
}

export interface CentralPortRow {
  name: string | null;
  status: string | null;
  /**
   * **Mbps に正規化した数値**。Central は AP ポートが `"1000"`(Mbps 文字列)、
   * スイッチ interfaces が `1000000000`(bps 数値)と単位が食い違うので、
   * 取得側で Mbps に揃えてから渡す(59 実測)。
   */
  speedMbps: number | null;
  duplex: string | null;
  connector: string | null;
  vlanMode: string | null;
  nativeVlan: string | null;
  accessVlan: string | null;
  isUplink: boolean | null;
  /** スイッチ interfaces 由来の追加情報(AP ポートには無い) */
  poeStatus?: string | null;
  neighbour?: string | null;
}

export interface CentralWlanRow {
  wlanName: string | null;
  security: string | null;
  securityLevel: string | null;
  band: string | null;
  vlan: string | null;
  status: string | null;
}

export interface CentralDeviceDetail {
  platform: "central";
  kind: "ap" | "switch" | "gateway" | "other";
  serialNumber: string;
  deviceName: string | null;
  macAddress: string | null;
  model: string | null;
  status: string | null;
  firmwareVersion: string | null;
  siteId: string | null;
  siteName: string | null;
  ipv4: string | null;
  publicIpv4: string | null;
  uptimeMs: number | null;
  cpuUtilization: number | null;
  memoryUtilization: number | null;
  clientCount: number | null;
  lastRebootReason: string | null;
  // AP 固有
  negotiatedPower: string | null;
  mode: string | null;
  meshRole: string | null;
  bandSelection: string | null;
  countryCode: string | null;
  currentUplinkInUse: string | null;
  // スイッチ固有(hardware-categories)
  hardwareHealth: Array<{ label: string; value: string }>;
  poeAvailable: number | null;
  poeConsumption: number | null;
  systemTemperature: number | null;
  radios: Section<CentralRadioRow>;
  ports: Section<CentralPortRow>;
  wlans: Section<CentralWlanRow>;
}

export interface MistRadioRow {
  band: "2.4" | "5" | "6";
  channel: number | null;
  bandwidth: number | null;
  power: number | null;
  numClients: number | null;
  numWlans: number | null;
  noiseFloor: number | null;
  utilAll: number | null;
  utilNonWifi: number | null;
  utilRxInBss: number | null;
  utilRxOtherBss: number | null;
  utilTx: number | null;
  txBytes: number | null;
  rxBytes: number | null;
}

export interface MistPortRow {
  name: string;
  up: boolean | null;
  speed: number | null;
  fullDuplex: boolean | null;
  rxBytes: number | null;
  txBytes: number | null;
  rxErrors: number | null;
  poeOn: boolean | null;
  portUsage: string | null;
}

export interface MistDeviceDetail {
  platform: "mist";
  kind: "ap" | "switch" | "gateway" | "other";
  id: string;
  mac: string;
  serial: string | null;
  name: string | null;
  model: string | null;
  hwRev: string | null;
  status: string | null;
  version: string | null;
  siteId: string | null;
  siteName: string | null;
  ip: string | null;
  extIp: string | null;
  uptimeSec: number | null;
  lastSeen: string | null;
  cpuUtil: number | null;
  memUsedPct: number | null;
  memTotalKb: number | null;
  memUsedKb: number | null;
  numClients: number | null;
  numWlans: number | null;
  /** UNIX 秒。証明書期限は Central に無い Mist 固有の項目(57 §2-3) */
  certExpiry: string | null;
  // AP 固有
  ambientTemp: number | null;
  cpuTemp: number | null;
  humidity: number | null;
  powerSrc: string | null;
  powerDraw: number | null;
  powerAllocated: number | null;
  powerConstrained: boolean | null;
  lldpSystemName: string | null;
  lldpPortId: string | null;
  lldpChassisId: string | null;
  lldpSystemDesc: string | null;
  // スイッチ / ゲートウェイ固有
  lastTroubleCode: string | null;
  lastTroubleAt: string | null;
  macTableCount: number | null;
  macTableMax: number | null;
  radios: Section<MistRadioRow>;
  ports: Section<MistPortRow>;
}

export type DeviceDetail = CentralDeviceDetail | MistDeviceDetail;

export interface DetailEnvelope<D> {
  fetchedAt: string;
  cached: boolean;
  ageMs: number;
  key: string;
  /** 見つかったぶんだけ返す。両方から返った場合は 2 枚縦に並べる(58 §2-6。マージしない) */
  details: D[];
  sources: Array<{ platform: Platform; ok: boolean; error: string | null }>;
}

// ---- 対象検索(タグ付与の入口)----

export interface SearchHit {
  kind: TargetKind;
  platform: Platform;
  key: string;
  serial: string | null;
  label: string | null;
  sub: string | null;
  siteId: string | null;
  siteName: string | null;
  /** ランダム MAC 警告の根拠。null = 判定材料が無い */
  randomMac: boolean | null;
  randomMacSource: "mist" | "central" | "mac-bit" | null;
}
