// Streaming(Central)(20)— サーバ / View 共有のデータ型。
// View 側のミラーは view/types.ts(webhook-feed と同じ流儀)。

import type { StreamKey } from "./catalog.js";

export type { StreamKey };

/**
 * 接続状態。画面の「未接続 / 接続中 / 再接続中 / エラー」に対応する。
 *   disabled     … このストリームを購読していない(トグル OFF)
 *   connecting   … 初回の WSS ハンドシェイク中
 *   open         … 接続確立済み
 *   reconnecting … 切断されてバックオフ待ち(次の試行まで待機中)
 *   error        … 再試行しても復帰できない致命的な状態(400 / 403 など)
 */
export type StreamConnState = "disabled" | "connecting" | "open" | "reconnecting" | "error";

export interface StreamEvent {
  /** CloudEvent の id。重複排除のキーにもする */
  id: string;
  /** 受信時刻(このアプリの時計) */
  receivedAt: string;
  /** CloudEvent の time(発生時刻)。無ければ null */
  eventAt: string | null;
  stream: StreamKey;
  /** CloudEvent の type(完全な識別子) */
  type: string;
  /** カタログ由来の短いラベル。未知の type なら type の末尾 */
  typeLabel: string;
  /** 画面のカテゴリ列。Audit Trail は category/sub_category、他はストリーム名 */
  category: string | null;
  /** 1 行要約(デコード済み本体から組み立てる) */
  summary: string;
  siteId: string | null;
  /** Global Overview のスナップショットで解決できたサイト名 */
  siteName: string | null;
  /** 関連するデバイス(シリアル / MAC / AP 名など) */
  deviceLabel: string | null;
  /** 監査証跡の実行者(source)。他のストリームでは null */
  actor: string | null;
  /** 2 段目のデコード結果(JSON 化済み) */
  payload: Record<string, unknown>;
  /** デコードできなかった場合の理由。null なら成功 */
  decodeError: string | null;
}

export interface StreamStatus {
  key: StreamKey;
  label: string;
  /** 購読対象として選ばれているか */
  enabled: boolean;
  state: StreamConnState;
  /** 現在の state になった時刻 */
  since: string | null;
  /** 最後にイベントを受信した時刻 */
  lastEventAt: string | null;
  /** このプロセスが起動してから受信した件数 */
  received: number;
  /** 連続失敗回数(接続が開くと 0 に戻る) */
  attempts: number;
  /** 次の再接続の予定時刻(reconnecting のときだけ) */
  nextRetryAt: string | null;
  /** 直近のエラー。復帰後も履歴として残す */
  lastError: string | null;
  /** 実際に接続している(していた)URL。トークンは含まない */
  url: string | null;
  /** 選択中の event-types。空 = そのエンドポイントの全イベント */
  eventTypes: string[];
  /** 現在のアクセストークンの有効期限(切れる前に張り直す) */
  tokenExpiresAt: string | null;
}

export interface StreamSubscription {
  enabled: boolean;
  /** 空配列 = event-types を付けない(= そのエンドポイントの全イベント) */
  eventTypes: string[];
}

export interface StreamSettings {
  /** 全体トグル。false ならすべての接続を切る */
  enabled: boolean;
  streams: Record<StreamKey, StreamSubscription>;
  /** 保持期間(日)。この日数より古いイベントは定期ジョブで捨てる */
  retentionDays: number;
  /** 保持件数の上限。日数より先にこちらに当たることもある */
  maxEvents: number;
}

export interface StreamEnvelope {
  configured: boolean;
  configError: string | null;
  settings: StreamSettings;
  streams: StreamStatus[];
  /** 保持しているイベント(新しい順) */
  items: StreamEvent[];
  /** 保持件数の内訳 */
  stored: number;
  /** 最後に Retention ジョブが走った時刻 */
  lastPurgeAt: string | null;
  /** 直近の Retention ジョブで捨てた件数 */
  lastPurged: number;
  retentionOptionsDays: number[];
  maxEventsOptions: number[];
  /** 応答生成時刻 */
  generatedAt: string;
}
