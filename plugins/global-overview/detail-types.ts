// Global Overview — サイト詳細(オンデマンド取得)の共有型。
//
// ポーラーが持つ「集計スナップショット」とは別物。行クリック/ピンクリックで
// 開く詳細パネルが表示する、そのサイト 1 件ぶんの生に近い情報を運ぶ。
//
// node 依存を持たない純粋な型のみ。view 側(view/detailTypes.ts)はこの形をミラーする。
//
// セクションは 3 状態を区別する(05/08 の方針):
//   ok          … 取得できた(items が空でも成功。0 件と失敗を混同しない)
//   error       … 取得に失敗した(error にメッセージ。ネットワーク/認証/クエリ誤り)
//   unavailable … そのプラットフォームにその情報が存在しない(例: Central の Event)

export type SectionStatus = "ok" | "error" | "unavailable";

export interface DetailClient {
  mac: string;
  name: string | null;
  os: string | null;
  /** "2.4 GHz" / "5 GHz" / "6 GHz" など */
  band: string | null;
  channel: number | null;
  /** dB。Mist は snr、Central も snr */
  snr: number | null;
  /** dBm。Mist の rssi(Central は返さないため null) */
  rssi: number | null;
  ssid: string | null;
  status: string | null;
  ip: string | null;
  /** 接続先(AP 名 / AP MAC) */
  connectedTo: string | null;
  vendor: string | null;
}

export interface DetailDevice {
  id: string;
  name: string | null;
  kind: "ap" | "switch" | "gateway" | "other";
  model: string | null;
  /** 生の状態文字列(ONLINE / connected / …) */
  status: string | null;
  /** 稼働中か(status の正規化)。表示のドット色に使う */
  up: boolean;
  firmware: string | null;
  uptimeMs: number | null;
  ip: string | null;
  mac: string | null;
  /** Mist のみ(その AP/SW 配下のクライアント数)。Central は null */
  numClients: number | null;
}

export interface DetailAlert {
  id: string | null;
  severity: string | null;
  /** 分類(Central: category / Mist: group) */
  category: string | null;
  summary: string;
  /** 種別(Central: type / Mist: type=rogue_ap 等) */
  type: string | null;
  /** ISO 文字列 */
  createdAt: string | null;
  /** 対象デバイス(Central: deviceType / Mist: hostnames.join) */
  deviceLabel: string | null;
}

export interface DetailEvent {
  timestamp: string | null;
  type: string | null;
  text: string;
  deviceLabel: string | null;
  /** Central: negative/neutral/positive。Mist は null(severity を持たない) */
  severity: string | null;
  /** Central: category(Clients / Wifi Key Management …)。Mist は null */
  category: string | null;
}

/**
 * クライアント 1 件の詳細(Task 3。オンデマンド)。行クリックで展開して表示する。
 * 追加 API はプラットフォームあたり 1 本(そのクライアントのイベント履歴)。
 */
export interface ClientDetail {
  events: DetailSection<DetailEvent>;
  /** この取得で実際に出した HTTP リクエスト数 */
  requests: number;
}

/** /client-detail レスポンス(メタ + 詳細)。 */
export interface ClientDetailEnvelope extends ClientDetail {
  platform: "central" | "mist";
  siteId: string;
  mac: string;
  fetchedAt: string;
  cached: boolean;
  ageMs: number;
}

export interface DetailHealth {
  /** 0-100。取れなければ null(欠損 = 「—」表示) */
  score: number | null;
  /** 内訳の由来 */
  source: "central-groups" | "mist-sle" | null;
  /** 内訳(Central: Poor/Fair/Good の %、Mist: SLE 各指標 0-100) */
  metrics: Array<{ label: string; value: number | null; unit?: string }>;
  status: SectionStatus;
  error: string | null;
}

export interface DetailSection<T> {
  status: SectionStatus;
  error: string | null;
  items: T[];
  /** アラートの母集団ラベル(Central=Active / Mist=過去24h)など */
  note?: string;
}

/** サイト 1 件ぶんの詳細(プラットフォーム側で組み立てた形)。 */
export interface PlatformSiteDetail {
  health: DetailHealth;
  clients: DetailSection<DetailClient>;
  devices: DetailSection<DetailDevice>;
  alerts: DetailSection<DetailAlert>;
  events: DetailSection<DetailEvent>;
  /** この取得で実際に出した HTTP リクエスト数 */
  requests: number;
}

/** API レスポンス(メタ情報 + 詳細)。 */
export interface SiteDetailEnvelope extends PlatformSiteDetail {
  platform: "central" | "mist";
  siteId: string;
  siteName: string;
  fetchedAt: string;
  /** 30 秒キャッシュから返したか */
  cached: boolean;
  ageMs: number;
}
