// Network Investigation View の型。サーバー(plugins/network-investigation/api.ts)が
// SSE / REST で返す形と一致させる。

// 出所分類(56)はサーバー・View 共通の単一ソース(../ai-source.ts)から型ごと借りる。
// 分類ロジックは純関数で Node 依存が無いので、View からもそのまま import できる。
export type { NativeAiFeature, ToolAiSource } from "../ai-source";
import type { ToolAiSource } from "../ai-source";

export type Platform = "central" | "mist";

// クエリ実行・定期実行でUIから選べるモデル。常に明示的な値(opus/sonnet)を選ばせ、
// 「CLI 既定に従う」のような曖昧な選択肢は置かない。既定の初期選択は DEFAULT_MODEL(sonnet)。
export interface ModelOption {
  value: string;
  label: string;
}
export const MODEL_OPTIONS: ModelOption[] = [
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "local", label: "Local (gemma4:12b)" },
];
// UI の初期選択値。実務のバランスを考慮した既定として Sonnet を選ぶ。
export const DEFAULT_MODEL = "sonnet";

export interface SiteEntry {
  siteName: string;
  platform: Platform;
  siteId: string;
  lat: number | null;
  lng: number | null;
}

export interface SiteStatusEntry {
  siteId: string;
  platform: Platform;
  health: number | null;
  devices: number | null;
  clients: number | null;
  alerts: number | null;
}
export interface SiteStatusFile {
  statuses: Record<string, SiteStatusEntry>;
  updatedAt: string | null;
}

export interface PlatformJudgment {
  platform: Platform;
  reason: string;
}

// クリック可能な追い質問(Task 1)。サーバーが回答本文から切り出す。
export interface SuggestedAction {
  label: string;
  query: string;
  site?: string | null;
}

// 失敗した呼び出しの詳細(08 Task 1)。status="error" のときだけ載る。
// SSE(McpCall)・履歴(HistoryToolCall)の両方で同じ形なので、共通の基底に切り出す。
export interface ToolCallFailure {
  error?: string; // MCP サーバーが返したエラー本文
  errorStatus?: number | null; // 本文から拾えた HTTP ステータス(拾えなければ null)
  input?: string; // 呼び出し引数の全文 JSON
}

export interface HistoryToolCall extends ToolCallFailure {
  server: string;
  platform: Platform | null;
  tool: string;
  status: "calling" | "done" | "error";
  detail?: string;
  count?: number | null;
  /**
   * 出所(56)。ベンダーのネイティブ AI 機能(Marvis Actions 等)が生成した所見を
   * 取得した呼び出しにだけ載る。生データ取得の呼び出し・56 以前の履歴には無い。
   */
  aiSource?: ToolAiSource;
}

// ---- MCP サーバーの接続健全性(09)----
// サーバー(mcp.ts の evaluateMcpHealth)が返す形と一致させる。
// 「ツール呼び出しが 0 件のまま完了した実行のうち、そのサーバーへ直接ハンドシェイクしても
// 到達できなかったもの」だけが unreachable になる(単に使われなかっただけなら ok)。
export type McpHealthLevel = "ok" | "warn" | "unreachable";

export interface McpServerHealth {
  server: string;
  platform: Platform | null;
  initStatus: "connected" | "pending" | "failed" | "unknown";
  toolCalls: number;
  reachable: boolean | null;
  tools: number | null;
  level: McpHealthLevel;
  reason?: string;
}

export interface McpHealth {
  level: McpHealthLevel;
  servers: McpServerHealth[];
  problems: McpServerHealth[];
}

/**
 * この実行の system prompt に注入された承認済みナレッジ 1 件(47)。
 * サーバ(plugins/knowledge/retrieve.ts)が関連度で選んだもの。
 * 本文は載せない(タイトルだけ)。中身はナレッジタブで読む。
 */
export interface KnowledgeRef {
  id: string;
  title: string;
  /** 関連度(0〜1)。 */
  score: number;
}

export interface HistoryRecord {
  id: string;
  // 「続けて調べる」で繋がった一連の実行をまとめるID(04)。旧履歴には無いので
  // 参照側は sessionKey()(view/session.ts)で id にフォールバックする。
  sessionId?: string;
  ts: string;
  query: string;
  site: string | null;
  resolvedPlatform: Platform | null;
  platformsUsed: Platform[];
  mcpServers: string[];
  // "auto" = Webhook ログの重大アラートに対する自動事前調査(17 Task 4)。
  source: "manual" | "scheduled" | "auto";
  answerExcerpt: string;
  isError: boolean;
  reason?: string;
  model?: string; // この実行に使ったモデル(古い履歴には無い)
  // この実行の所要時間(ミリ秒)(26)。それ以前の履歴には無いのでオプショナル。
  durationMs?: number;
  // 詳細ビュー(Task 4)用。古い履歴には無いのでオプショナル。
  answer?: string;
  calls?: HistoryToolCall[];
  judgments?: PlatformJudgment[];
  suggestedActions?: SuggestedAction[];
  // MCP 接続の警告(09)。ok の実行には載らない = 存在すれば必ず警告対象。
  mcpHealth?: McpHealth;
  // 注入された承認済みナレッジ(47)。注入が無かった実行には載らない。
  knowledgeRefs?: KnowledgeRef[];
}

// ---- 定期実行の設定(Task 5) ----
// scheduled-queries.json の1件。
export interface ScheduledQuery {
  id: string;
  query: string;
  site?: string | null;
  enabled: boolean;
  model?: string | null; // このクエリの使用モデル(未指定なら既定)
}
// schedule-config.json(実行時刻・頻度)。
export interface ScheduleConfig {
  hour: number;
  minute: number;
  frequency: "daily" | "weekly";
  dayOfWeek?: number; // 0=日曜 … 6=土曜(frequency=weekly のとき)
  enabled: boolean;
}

// ---- SSE イベント ----

export interface McpCall extends ToolCallFailure {
  id: string;
  server: string; // "central-mcp" | "mist-cloud"
  platform: Platform | null;
  tool: string;
  status: "calling" | "done" | "error";
  detail?: string;
  count?: number | null;
  /** 出所(56)。ネイティブ AI 由来の呼び出しにだけ載る。 */
  aiSource?: ToolAiSource;
}

export type NIEvent =
  | { type: "run_start"; runId: string; sessionId: string; query: string; site: string | null; ts: string }
  | {
      type: "routing_decision";
      runId: string;
      used: string[];
      skipped: string[];
      /** サーバの日本語文。reasonCode が未知のときだけフォールバックで表示する。 */
      reason: string;
      /** 機械可読なルーティング理由(33 Task 4)。networkInvestigation.routing.<code> を引く。 */
      reasonCode?: RoutingReasonCode;
      reasonParams?: Record<string, string>;
      resolvedPlatform: Platform | null;
    }
  // 承認済みナレッジを system prompt に注入した(47)。注入が無かった実行では流れない。
  | { type: "knowledge_injected"; runId: string; refs: KnowledgeRef[] }
  | ({ type: "mcp_call"; runId: string } & McpCall)
  | { type: "platform_judgment"; runId: string; platform: Platform; reason: string }
  | {
      type: "answer";
      runId: string;
      answer: string;
      suggestedActions: SuggestedAction[];
      isError: boolean;
      reason: string | null;
      resolvedPlatform: Platform | null;
      platformsUsed: Platform[];
      mcpServers: string[];
      mcpHealth: McpHealth | null;
      /** この実行の所要時間(ミリ秒)(26)。 */
      durationMs: number;
    }
  | { type: "history"; runId: string; sessionId: string };

/** ルーティング理由の機械可読コード(サーバ api.ts の RoutingReasonCode と一致させる)。 */
export type RoutingReasonCode = "bothNoSite" | "siteUnknown" | "narrowed";

// 画面に出す「ルーティング判定」1件分。
export interface RoutingView {
  used: string[];
  skipped: string[];
  reason: string;
  reasonCode?: RoutingReasonCode;
  reasonParams?: Record<string, string>;
  resolvedPlatform: Platform | null;
}
