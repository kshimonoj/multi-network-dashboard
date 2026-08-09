// Coach View(65)— サーバ側 plugins/coach/types.ts のコピー。
//
// サーバの型をそのまま import すると Vite のビルドに server 側の依存が混ざるため、
// 他プラグインと同じ流儀で View 側に同じ形を置く。

export type MaterialKind = "knowledge" | "history" | "live" | "rule";
export type HintLevel = 0 | 1 | 2 | 3;
export type LearnerLevel = "L1" | "L2" | "L3";
export type TurnIntent = "ask" | "hintMore" | "escalate";
export type QuizFormat = "cause" | "next" | "rule";
export type QuizVerdict = "correct" | "partial" | "wrong";

export interface MaterialMeta {
  tags: string[];
  lang?: "ja" | "en";
  runId?: string | null;
  references?: Array<{ title: string; url: string }>;
  severity?: string;
  source?: string;
  platform?: string | null;
  requiresLegalReview?: boolean;
  /** 素材の元記録の時刻(ISO)と経過日数(68 番)。ルール層は持たない。 */
  at?: string | null;
  ageDays?: number | null;
  /** ライブ素材: 実際に呼んだ MCP ツール(`server/tool`)と問い合わせ先サーバー。 */
  tools?: string[];
  servers?: string[];
}

/**
 * ライブ層の動作(68 番)。**機械可読なコードのまま受け取り、画面の辞書で文にする**
 * (CLAUDE.md「サーバ生成の文言を画面に出すとき」)。
 */
export interface TurnLive {
  used: boolean;
  reasonCode: string;
  reasonParams?: Record<string, string | number>;
  fromCache?: boolean;
  platforms?: string[];
  tools?: string[];
  durationMs?: number;
  isError?: boolean;
  reason?: string | null;
}

export interface MaterialRef {
  kind: MaterialKind;
  id: string;
  title: string;
  score: number;
  meta: MaterialMeta;
}

export interface ChatResponse {
  sessionId: string;
  answer: string;
  isError: boolean;
  reason: string | null;
  hintLevel: HintLevel;
  maxHintLevel: number;
  turnsOnTopic: number;
  turnRule: number;
  forcedDisclosure: boolean;
  escalated: boolean;
  weakTopic: boolean;
  incidentMode: boolean;
  level: LearnerLevel | null;
  topicKeys: string[];
  materials: MaterialRef[];
  citedIds: string[];
  primaryLayer: MaterialKind | null;
  generalOnly: boolean;
  /** ライブ層の動作(68 番)。旧クライアント / 旧サーバ互換のため任意扱い。 */
  live?: TurnLive;
  /**
   * 発話の分類(67 番)。相槌・ボタンだけのターンは "continuation" / "empty" になり、
   * 論点は切り替わらない。**機械可読なコードのまま受け取る**(文にするなら画面の辞書で)。
   * 現状は画面に出していないので任意扱い。
   */
  utterance?: "empty" | "continuation" | "substantive";
  /** このターンで論点が切り替わったか(67 番。検証・監視用)。 */
  newTopic?: boolean;
  model: string;
  durationMs: number;
}

export interface QuizState {
  quizId: string;
  format: QuizFormat;
  material: MaterialRef;
  question: string;
  rounds: number;
  verdict: QuizVerdict | null;
  revealed: boolean;
  askedAt: string;
  difficulty: number;
}

export interface QuizResponse {
  sessionId: string;
  quiz: QuizState;
  isError: boolean;
  reason: string | null;
  model: string;
  durationMs: number;
}

export interface QuizAnswerResponse {
  sessionId: string;
  /** 解答が無い開示専用ターン(74 番)は採点していないので null。 */
  verdict: QuizVerdict | null;
  feedback: string;
  revealed: boolean;
  rounds: number;
  maxRounds: number;
  materials: MaterialRef[];
  citedIds: string[];
  isError: boolean;
  reason: string | null;
  model: string;
  durationMs: number;
}

// ---- 壁打ち履歴の閲覧(70 番)----
//
// 一覧は要約、詳細は全文。サーバ側 plugins/coach/types.ts の
// CoachSessionSummary / CoachSession / CoachTurn と同じ形を置く。

export interface CoachSessionSummary {
  sessionId: string;
  mode: "chat" | "quiz";
  incidentMode: boolean;
  startedAt: string;
  updatedAt: string;
  turnCount: number;
  topicKeys: string[];
  /** 一覧の見出し。**実行時の記録なので翻訳しない。** */
  firstQuestion: string;
  maxHintLevel: HintLevel;
  escalated: boolean;
  forcedDisclosure: boolean;
  usedLive: boolean;
  hasError: boolean;
  level: LearnerLevel | null;
  quizVerdict: QuizVerdict | null;
  totalDurationMs: number;
}

/** 記録された 1 往復。本文(question / answer)は実行時の記録なので翻訳しない。 */
export interface CoachTurnRecord {
  question: string;
  answer: string;
  intent: TurnIntent;
  hintLevel: HintLevel;
  level: LearnerLevel | null;
  topicKeys: string[];
  materials: MaterialRef[];
  citedIds: string[];
  forcedDisclosure: boolean;
  live?: TurnLive;
  at: string;
  durationMs: number;
  model: string;
  isError: boolean;
  reason: string | null;
}

export interface CoachSessionDetail {
  sessionId: string;
  mode: "chat" | "quiz";
  incidentMode: boolean;
  startedAt: string;
  updatedAt: string;
  hintLevel: HintLevel;
  topicKeys: string[];
  level: LearnerLevel | null;
  escalated: boolean;
  liveCount?: number;
  turns: CoachTurnRecord[];
  quiz: QuizState | null;
}

export interface WeaknessView {
  topicKey: string;
  attempts: number;
  correct: number;
  partial: number;
  wrong: number;
  avgHintLevel: number | null;
  escalations: number;
  score: number | null;
  isWeak: boolean;
  lastAt: string | null;
}

export interface CoachSettings {
  model: string | null;
  threshold: number;
  historyThreshold: number;
  maxMaterials: number;
  turnRule: number;
  weakTurnRule: number;
  quizRounds: number;
  minAttempts: number;
  weaknessThreshold: number;
  weakBias: number;
  // ---- ライブ層(68 番)----
  liveEnabled: boolean;
  liveStaticFloor: number;
  liveStaleDays: number;
  liveTimeoutMs: number;
  liveCacheTtlMs: number;
  liveMinIntervalMs: number;
  liveMaxPerSession: number;
}

export interface WeaknessResponse {
  settings: CoachSettings;
  topics: WeaknessView[];
  weakTopics: string[];
}

export interface CoachStatus {
  settings: CoachSettings;
  pool: { knowledge: number; history: number; rules: number };
  weakness: { total: number; weak: number };
  usage: number;
}

// ---- 画面に並べるチャットの吹き出し ----
//
// **言語で切り替わる文字列を state に文として持たない**(CLAUDE.md)。
// 「押した時点の言語で組み立てた文字列」を state に入れると言語切替に追従しないので、
// 素材(サーバ応答・コード)を持ち、描画時に t() で文にする。

export interface Bubble {
  id: string;
  who: "coach" | "learner";
  /** 本文。Coach の回答・学習者の発話は「実行時の記録」なので翻訳しない。 */
  text: string;
  /** コーチ側の吹き出しだけが持つ付随情報。 */
  meta?: {
    hintLevel: HintLevel;
    maxHintLevel: number;
    forcedDisclosure: boolean;
    escalated: boolean;
    generalOnly: boolean;
    primaryLayer: MaterialKind | null;
    /** ライブ層の動作(68 番)。ライブを引かなかったターンでは undefined / used:false。 */
    live?: TurnLive;
    materials: MaterialRef[];
    citedIds: string[];
    isError: boolean;
    /** 失敗理由(実行時の記録なので翻訳しない)。 */
    reason: string | null;
    durationMs: number;
  };
}
