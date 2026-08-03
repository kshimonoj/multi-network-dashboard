// ベストプラクティス診断 View — サーバ側の型のミラー。
//
// サーバ実装(plugins/best-practice/*.ts)は Node 側のモジュールを import しており、
// そのまま view から参照すると node:fs 等がバンドルに巻き込まれる。
// そこで「API のレスポンス形」だけをここに写す。サーバ側の型を変えたらここも合わせる。

export type CheckCategory = "security" | "rf";
export type CheckPlatform = "central" | "mist" | "both";
export type CheckTarget = "org" | "site" | "group" | "ssid" | "ap" | "radio";
export type CheckSeverity = "must" | "strong" | "recommended" | "advisory";
export type CheckMethod = "mechanical" | "llm";

export interface RuleReference {
  title: string;
  url: string;
}

export interface BestPracticeRule {
  id: string;
  category: CheckCategory;
  platform: CheckPlatform;
  target: CheckTarget;
  severity: CheckSeverity;
  method: CheckMethod;
  titleKey: string;
  descriptionKey: string;
  references: RuleReference[];
  requiresLegalReview?: boolean;
  enabledByDefault: boolean;
}

export type FindingStatus = "pass" | "warn" | "fail" | "not_applicable" | "unknown" | "info";

export type ObservedValue = string | number | boolean | null;

export interface Finding {
  ruleId: string;
  status: FindingStatus;
  platform: "central" | "mist";
  targetType: CheckTarget;
  targetId: string;
  targetLabel: string;
  siteId?: string;
  observed: Record<string, ObservedValue>;
  messageCode: string;
  messageParams: Record<string, string | number>;
  collectedAt: string;
  requiresLegalReview?: boolean;
  /** LLM 所見の本文。機械判定ルールでは undefined(実行時の記録なので翻訳しない) */
  note?: string;
}

export interface DiagnosisSummary {
  pass: number;
  warn: number;
  fail: number;
  not_applicable: number;
  unknown: number;
  info: number;
  legalReview: number;
}

export interface CollectionStep {
  key: string;
  status: "ok" | "unsupported" | "catalog_error" | "error" | "skipped";
  detail?: string;
  durationMs: number;
}

export interface DiagnosisRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  platform: "central" | "mist";
  siteId: string;
  siteName: string;
  trigger: "manual";
  llmEnabled: boolean;
  llmModel: string | null;
  findings: Finding[];
  summary: DiagnosisSummary;
  steps: CollectionStep[];
  sampledDeviceIds: string[];
  error: string | null;
}

export interface DiagnosisRunMeta {
  id: string;
  startedAt: string;
  platform: "central" | "mist";
  siteId: string;
  siteName: string;
  summary: DiagnosisSummary;
  error: string | null;
}

export interface BestPracticeSettings {
  llmEnabled: boolean;
  llmModel: string | null;
  maxRuns: number;
  disabledRuleIds: string[];
}

export interface SiteEntry {
  platform: "central" | "mist";
  siteId: string;
  siteName: string;
  apCount: number;
}

export interface RunningEntry {
  runId: string;
  platform: "central" | "mist";
  siteId: string;
  startedAt: string;
}

export interface StatusResponse {
  ok: boolean;
  settings: BestPracticeSettings;
  rules: { total: number; mechanical: number; llm: number; security: number; rf: number };
  inFlight: RunningEntry[];
  runs: DiagnosisRunMeta[];
}

export interface RulesResponse {
  ok: boolean;
  rules: BestPracticeRule[];
}

export interface SitesResponse {
  ok: boolean;
  sites: SiteEntry[];
  cached: boolean;
}

export interface RunStartResponse {
  ok: boolean;
  runId: string;
  platform: "central" | "mist";
  siteId: string;
  llm: boolean;
}

export interface RunDoneResponse {
  ok: true;
  run: DiagnosisRun;
}

export interface RunPendingResponse {
  ok: true;
  status: "running";
  running: RunningEntry;
}

export interface RunsListResponse {
  ok: boolean;
  runs: DiagnosisRunMeta[];
}

/** LLM 所見(合否を出さない 4 ルール) */
export const LLM_RULE_IDS = ["SEC-12", "SEC-13", "RF-15", "RF-16"];

/** カテゴリの表示順(セキュリティ → RF) */
export const CATEGORY_ORDER: CheckCategory[] = ["security", "rf"];

/** 重要度の表示順(深刻 → 軽微) */
export const SEVERITY_ORDER: CheckSeverity[] = ["must", "strong", "recommended", "advisory"];

/** 判定値の表示順(要対応 → 対象外) */
export const STATUS_ORDER: FindingStatus[] = ["fail", "warn", "info", "unknown", "pass", "not_applicable"];
