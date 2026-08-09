// ナレッジタブ View(46)— サーバ応答の型。
//
// plugins/knowledge/types.ts の写し(他プラグインと同じ流儀)。
// サーバ側の型を直接 import すると、Vite のビルドに server 側の依存が混ざるため分けている。

export type KnowledgeStatus = "pending" | "approved" | "rejected" | "merged";
export type KnowledgeScope = "general" | "site" | "device";
export type KnowledgePlatform = "central" | "mist" | "both" | null;

export interface KnowledgeSource {
  runId: string;
  sessionId: string;
  origin: "manual" | "scheduled" | "auto";
  query: string;
  at: string;
  extractedAt: string;
}

export interface SimilarRef {
  id: string;
  score: number;
  title: string;
}

export interface KnowledgeEntry {
  id: string;
  status: KnowledgeStatus;
  title: string;
  symptom: string;
  rootCause: string;
  action: string;
  scope: KnowledgeScope;
  tags: string[];
  platform: KnowledgePlatform;
  site: string | null;
  device: string | null;
  lang: "ja" | "en";
  sources: KnowledgeSource[];
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  edited: boolean;
  /** 調査プロンプトへ注入された回数(47)。46 以前のデータはサーバ側で 0 が補われる。 */
  refCount: number;
  /** 最後に注入された時刻(ISO8601)。一度も注入されていなければ null。 */
  lastReferencedAt: string | null;
  similar: SimilarRef[];
  mergedInto: string | null;
  mergedFrom: string[];
}

export interface KnowledgeCounts {
  pending: number;
  approved: number;
  rejected: number;
  merged: number;
  total: number;
}

export interface ExtractionLogEntry {
  runId: string;
  at: string;
  origin: "manual" | "scheduled" | "auto";
  status: "created" | "empty" | "skipped" | "error";
  created: number;
  duplicatePending: number;
  /** 承認済みと同じ知見だったため作らなかった数(71)。 */
  duplicateApproved: number;
  similarApproved: number;
  reasonCode: string | null;
  reasonDetail: string | null;
  durationMs: number;
  model: string | null;
}

export interface KnowledgeSettings {
  enabled: boolean;
  sources: { manual: boolean; auto: boolean; scheduled: boolean };
  model: string | null;
  minAnswerChars: number;
  maxPerRun: number;
  similarityThreshold: number;
  /** 承認済みナレッジを次の調査プロンプトへ注入する設定(47)。 */
  inject: { enabled: boolean; maxEntries: number; threshold: number };
  /** 承認済みナレッジとの重複判定(71)。 */
  dedupe: { llm: boolean; shortlistMax: number; suppressDuplicates: boolean };
}

/** 71: 未承認候補のうち、承認済みと同じ知見だと判定されたもの。 */
export interface DuplicateProposal {
  id: string;
  title: string;
  targetId: string;
  targetTitle: string;
  score: number;
  /** llm = LLM が判定 / lexical = 一致度のみ(LLM が使えなかった場合)。 */
  by: string;
}

export interface DedupeScanResponse {
  scanned: number;
  duplicates: DuplicateProposal[];
  applied: number;
  llmCalls: number;
  error: string | null;
  counts: KnowledgeCounts;
}

export interface KnowledgeStatusResponse {
  settings: KnowledgeSettings;
  counts: KnowledgeCounts;
  log: ExtractionLogEntry[];
}

export interface TagCount {
  tag: string;
  count: number;
}

/** 「編集して承認」/ 編集で送る本文パッチ(送った項目だけが上書きされる)。 */
export interface EntryPatch {
  title?: string;
  symptom?: string;
  rootCause?: string;
  action?: string;
  scope?: KnowledgeScope;
  tags?: string[];
  platform?: KnowledgePlatform;
  site?: string | null;
  device?: string | null;
}
