// Webhook ログ View — サーバ型(../feed-types.ts)のミラー。
//
// Global Overview の view/feedTypes.ts と同じ方針で、View 側は node 依存を持たない
// このファイルだけを見る。サーバ型を変えたらこちらも合わせる。

export type WebhookSource = "new-central" | "classic-central" | "mist";
export type WebhookSeverity = "critical" | "warning" | "info" | "unknown";
export type DetailPlatform = "central" | "mist";

export interface AutoInvestigation {
  status: "running" | "done" | "error";
  runId: string | null;
  sessionId: string | null;
  startedAt: string;
  finishedAt: string | null;
  query: string;
  summary: string;
  answer: string;
  error: string | null;
}

export interface SitePrefetch {
  status: "ok" | "error" | "unavailable";
  platform: DetailPlatform | null;
  siteId: string | null;
  siteName: string | null;
  fetchedAt: string | null;
  healthScore: number | null;
  healthMetrics: Array<{ label: string; value: number | null; unit?: string }>;
  devicesUp: number | null;
  devicesTotal: number | null;
  clients: number | null;
  openAlerts: number | null;
  topAlerts: Array<{ severity: string | null; summary: string; createdAt: string | null }>;
  alertsNote: string | null;
  error: string | null;
}

export interface WebhookFeedItem {
  id: string;
  source: WebhookSource;
  sheet: string;
  rowIndex: number;
  receivedAt: string | null;
  eventAt: string | null;
  severity: WebhookSeverity;
  severityRaw: string | null;
  category: string | null;
  type: string | null;
  state: string | null;
  siteId: string | null;
  siteName: string | null;
  platform: DetailPlatform | null;
  deviceLabel: string | null;
  message: string;
  alertKey: string;
  raw: Record<string, string>;
  auto: AutoInvestigation | null;
  siteContext: SitePrefetch | null;
}

export interface WebhookSheetState {
  sheet: string;
  label: string;
  source: WebhookSource;
  lastRow: number;
  newRows: number;
  items: number;
  status: "ok" | "error";
  error: string | null;
}

export interface WebhookFeedEnvelope {
  generatedAt: string | null;
  ageMs: number | null;
  stale: boolean;
  pollIntervalMs: number;
  minRefreshMs: number;
  configured: boolean;
  configError: string | null;
  spreadsheetTitle: string | null;
  sheets: WebhookSheetState[];
  items: WebhookFeedItem[];
  auto: { enabled: boolean; maxPerCycle: number; maxAgeMs: number; investigatedCount: number };
}

export interface WebhookPollSettings {
  pollIntervalMs: number;
  minRefreshMs: number;
  minMs: number;
  maxMs: number;
  optionsMs: number[];
}

/** ソースのバッジ表示名。 */
export const SOURCE_LABEL: Record<WebhookSource, string> = {
  "new-central": "New Central",
  "classic-central": "Classic Central",
  mist: "Mist",
};

/** ソースの短縮表示(バッジ内)。 */
export const SOURCE_SHORT: Record<WebhookSource, string> = {
  "new-central": "New Central",
  "classic-central": "Classic",
  mist: "Mist",
};

export const SEVERITY_LABEL: Record<WebhookSeverity, string> = {
  critical: "重大",
  warning: "警告",
  info: "情報",
  unknown: "—",
};

export const SOURCE_ORDER: WebhookSource[] = ["new-central", "classic-central", "mist"];
