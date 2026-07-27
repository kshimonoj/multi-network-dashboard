// Global Overview — 全サイト横断 Event / Alert 一覧の共有型(13 Task 2)。
//
// サイト詳細(detail-types.ts)がサイト 1 件ぶんを運ぶのに対し、こちらは
// 「org 単位で一括取得できるものを集めて 1 本のタイムラインにする」ための型。
//
// 取得元ごとの成否を潰さないのが要点。Central のイベントだけがサイト単位ループなので、
// 一部のサイトで失敗しても他は出す(sources[] に取得元ごとの状態を載せる)。
//
// node 依存を持たない純粋な型のみ。view 側(view/feedTypes.ts)はこの形をミラーする。

export type FeedPlatform = "central" | "mist";
/** アラート(状態を持つ通知)か、イベント(発生ログ)か。 */
export type FeedKind = "alert" | "event";
/** 表示色・フィルタ用に 3 段階へ正規化した重要度。生の値は severityRaw に残す。 */
export type FeedSeverity = "critical" | "warning" | "info";

export interface FeedItem {
  /** 画面のキー用。プラットフォーム + 取得元 + 元 ID か連番で一意にする */
  id: string;
  kind: FeedKind;
  platform: FeedPlatform;
  /** 取得元の識別子(central-alerts / mist-alarms / central-events / mist-device-events / mist-client-events) */
  source: string;
  siteId: string | null;
  /** 解決できなかった場合は "(不明)" ではなく siteId をそのまま出す */
  siteName: string;
  /** ISO 文字列。並べ替えのキー。取れない場合は null(末尾へ) */
  timestamp: string | null;
  severity: FeedSeverity;
  /** API が返した生の重要度(Critical / Major / negative / …)。null なら未提供 */
  severityRaw: string | null;
  /** 分類。フィルタの選択肢になる(Central: category / Mist: group ほか) */
  category: string | null;
  /** 種別(Config Out of Sync / rogue_ap / CLIENT_DNS_OK …) */
  type: string | null;
  text: string;
  deviceLabel: string | null;
  /** Central アラートのみ(Active / Cleared)。イベントは null */
  state: string | null;
}

/** 取得元 1 本ぶんの結果。UI に「どこが取れて、どこが失敗したか」をそのまま出す。 */
export interface FeedSource {
  key: string;
  label: string;
  platform: FeedPlatform;
  status: "ok" | "error";
  error: string | null;
  /** 取り込んだ件数 */
  count: number;
  /** API が返した総件数(上限で切られた場合に count と食い違う)。不明なら null */
  total: number | null;
  /** この取得で出した HTTP リクエスト数 */
  requests: number;
  note: string;
}

export interface FeedEnvelope {
  fetchedAt: string;
  cached: boolean;
  ageMs: number;
  /** 集計窓(秒)。既定 24 時間 */
  windowSec: number;
  /** サーバ側キャッシュの有効時間(ミリ秒)。既定 60 秒。画面の注記に出す(14 番) */
  ttlMs: number;
  /** 全取得元の合計 HTTP リクエスト数 */
  requests: number;
  sources: FeedSource[];
  items: FeedItem[];
}
