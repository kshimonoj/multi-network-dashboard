// Webhook ログ(17 番)— 3 ソース統合フィードの共有型。
//
// 取得元は Google スプレッドシート「webhook-log」の 3 シート:
//   CentralLog        … New Central の Alert Webhook(Google Apps Script が追記)
//   ClassicCentralLog … Classic Central(Aruba Central)の Alert Webhook
//   MistLog           … Juniper Mist の Webhook(alarms / device-events / audits / client-* …)
//
// シートごとに列名も語彙も違うので、ここで定義した「統合スキーマ」へ mapping.ts が 1 箇所で変換する。
// node 依存を持たない純粋な型のみ。view 側(view/types.ts)はこの形をミラーする。

/** 統合フィードのソース識別子。UI のバッジ・フィルタのキーでもある。 */
export type WebhookSource = "new-central" | "classic-central" | "mist";

/**
 * 表示色・フィルタ用に正規化した重要度。
 * Global Overview の Event/Alert 画面(events-feed.ts の normSeverity)と同じ 3 段階に、
 * 「そもそも重要度を持たない行」(Mist の client-info / device-events 等)を区別する
 * unknown を足したもの。生の値は severityRaw に残す。
 */
export type WebhookSeverity = "critical" | "warning" | "info" | "unknown";

/** Global Overview の詳細 API(/site-detail)が受け取るプラットフォーム。 */
export type DetailPlatform = "central" | "mist";

/**
 * Task 4: 重大アラートに対する自動事前調査の結果。
 * Insight Agent(plugins/network-investigation)をユーザー操作なしで 1 回だけ走らせ、
 * その回答をこの行に紐付ける。runId / sessionId はネットワーク調査タブの履歴と対応する。
 */
export interface AutoInvestigation {
  status: "running" | "done" | "error";
  /** query-history.jsonl のレコード id(= SSE の runId)。実行前は null */
  runId: string | null;
  /** 「続けて調べる」で辿れるセッション id。実行前は null */
  sessionId: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** 実際に Insight Agent へ渡したクエリ文 */
  query: string;
  /** 回答の要約(先頭 N 文字)。一覧の折りたたみを開いた所に出す */
  summary: string;
  /** 回答全文 */
  answer: string;
  error: string | null;
}

/**
 * Task 5: 関連情報の自動先読み。
 * Global Overview の GET /site-detail(11 番)をバックグラウンドで叩き、
 * 「そのサイトが今どういう状態か」を行のそばに出すための抜粋。
 */
export interface SitePrefetch {
  /** ok = 取れた / error = 取得に失敗 / unavailable = サイトを特定できず先読み対象外 */
  status: "ok" | "error" | "unavailable";
  platform: DetailPlatform | null;
  siteId: string | null;
  siteName: string | null;
  fetchedAt: string | null;
  /** Central は 0-100。Mist は bulk で健全性を返さないため null になることがある */
  healthScore: number | null;
  /** Central: Poor/Fair/Good の %、Mist: SLE 各指標 */
  healthMetrics: Array<{ label: string; value: number | null; unit?: string }>;
  devicesUp: number | null;
  devicesTotal: number | null;
  clients: number | null;
  /** 未解決アラート件数(Central=Active / Mist=直近 24h) */
  openAlerts: number | null;
  /** 先頭数件のアラート要約(状況把握用) */
  topAlerts: Array<{ severity: string | null; summary: string; createdAt: string | null }>;
  /** アラートの母集団ラベル(「Active」「過去 24h」など) */
  alertsNote: string | null;
  error: string | null;
}

/** 統合フィードの 1 行。3 シートのどの行もこの形に落とす。 */
export interface WebhookFeedItem {
  /** 画面のキー。`${source}#${rowIndex}` で一意(シートの行番号は追記専用なので安定) */
  id: string;
  source: WebhookSource;
  /** 取得元シート名 */
  sheet: string;
  /** スプレッドシート上の行番号(1 始まり。ヘッダが 1 行目) */
  rowIndex: number;

  /** シートに記録された受信時刻(ISO)。並べ替えの第一キー */
  receivedAt: string | null;
  /** 事象そのものの発生時刻(ISO)。無ければ null */
  eventAt: string | null;

  severity: WebhookSeverity;
  /** シート上の生の重要度(Critical / Major / warn / …)。列が空なら null */
  severityRaw: string | null;

  /** 分類。フィルタの選択肢になる(New Central: Category / Classic: Alert Type / Mist: Topic) */
  category: string | null;
  /** 種別(Alert Name / Alert Type / Type-Reason) */
  type: string | null;
  /** アラートの状態(Active / Cleared / Open …)。持たないソースは null */
  state: string | null;

  /** シート上のサイト識別子。Classic Central は持たない(null) */
  siteId: string | null;
  /** Global Overview のスナップショットで解決できたサイト名。解決できなければ null */
  siteName: string | null;
  /** 先読み・調査の宛先として使えるプラットフォーム(サイトを解決できたときのみ) */
  platform: DetailPlatform | null;

  /** デバイス識別子(シリアル / MAC / ホスト名)をまとめた表示用ラベル */
  deviceLabel: string | null;

  /** 一覧に出す本文 */
  message: string;

  /**
   * 自動事前調査の重複防止キー(Task 4-3)。
   * 「同じアラート」を指す識別子から作る:
   *   New Central     … Alert ID(Active → Cleared で同じ値。1 度だけ調べればよい)
   *   Classic Central … 行の一意 ID(列 C。ヘッダのラベルは誤っているが値は ES のドキュメント ID)
   *   Mist            … Raw JSON の id、無ければ topic + MAC + type + timestamp
   */
  alertKey: string;

  /** シートの列名 → 値。行を開いたときに全項目を出す(生データ) */
  raw: Record<string, string>;

  /** Task 4 の結果。対象外なら null */
  auto: AutoInvestigation | null;
  /** Task 5 の結果。対象外なら null */
  siteContext: SitePrefetch | null;
}

/** シート 1 枚ぶんの取得状態(差分取得の進捗を UI にそのまま出す)。 */
export interface WebhookSheetState {
  sheet: string;
  label: string;
  source: WebhookSource;
  /** 前回までに読んだ最終行番号(1 = ヘッダのみ = 未読) */
  lastRow: number;
  /** 直近の取得で読み込んだ新規行数 */
  newRows: number;
  /** 取り込み済みの累計行数(メモリ上のフィードに載っている件数) */
  items: number;
  status: "ok" | "error";
  error: string | null;
}

export interface WebhookFeedEnvelope {
  /** キャッシュを最後に作り直した時刻 */
  generatedAt: string | null;
  ageMs: number | null;
  /** ポーリング間隔より十分古い = 次の巡回待ち */
  stale: boolean;
  pollIntervalMs: number;
  minRefreshMs: number;
  /** サービスアカウント + スプレッドシート ID が揃っているか */
  configured: boolean;
  /** configured=false のときの理由(環境変数が無い等) */
  configError: string | null;
  spreadsheetTitle: string | null;
  sheets: WebhookSheetState[];
  items: WebhookFeedItem[];
  /** Task 4/5 の稼働条件(UI の注記に出す) */
  auto: {
    enabled: boolean;
    maxPerCycle: number;
    maxAgeMs: number;
    /** これまでに自動調査を発火した(または初回バックフィルで抑止した)アラート数 */
    investigatedCount: number;
  };
  /**
   * 42: 「表示」と「保存」の分離。
   * items は viewMaxItems で頭打ちになるが、保存(日別 jsonl)は日数でしか制限されない。
   */
  storage: WebhookStorageInfo;
}

export interface WebhookStorageInfo {
  /** 一覧に載せる上限件数(= items の最大長)。保存の上限ではない */
  viewMaxItems: number;
  /** いま一覧に載っている件数 */
  viewItems: number;
  /** 日別アーカイブの保持日数(0 = 無期限) */
  retentionDays: number;
  /** 保存済みの日数 */
  days: number;
  /** 保存済みの総件数 */
  items: number;
  /** 保存済みの総バイト数 */
  bytes: number;
  oldestDay: string | null;
  newestDay: string | null;
}

export interface WebhookPollSettings {
  pollIntervalMs: number;
  minRefreshMs: number;
  minMs: number;
  maxMs: number;
  optionsMs: number[];
  /** 42: 日別アーカイブの保持日数(0 = 無期限)。表示上限とは別枠 */
  archiveRetentionDays: number;
  archiveRetentionOptionsDays: number[];
  /** 表示上限(参考値。変更は env のみ) */
  viewMaxItems: number;
}
