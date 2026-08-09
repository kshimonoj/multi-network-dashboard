// Coach(65)— サーバ側の型。
//
// Coach は「答えを教える」機能ではなく「気づかせる」機能なので、
// 状態機械(hintLevel)をサーバが持つのが設計の中心になる(64_findings.md §2-3)。
// モデルに「いつ答えを出すか」を判断させると、プロンプトの言い回しやモデル更新で
// 無言に挙動が変わり、しかも出し渋りは画面から見えない。
//
// View 側(view/types.ts)にも同じ形をコピーする(他プラグインと同じ流儀。
// サーバの型をそのまま import すると Vite のビルドに server 側の依存が混ざるため)。

export type CoachLang = "ja" | "en";

/**
 * 素材の種類。4 層(ナレッジ / 調査履歴 / ライブ / ベストプラクティス)に対応する。
 *
 * `live` は 68 番で追加した層。MCP 経由で Central / Mist に**今**問い合わせて得た事実で、
 * 静的な蓄積(ナレッジ・調査履歴)だけでは前提が固まらないときにだけ引く(live.ts)。
 */
export type MaterialKind = "knowledge" | "history" | "live" | "rule";

/**
 * 素材がどの層から来たか。**画面に必ず出す**(64 §1-5)。
 * 自社の事実(knowledge / history / live)と一般論(rule)を混ぜて話すのが、
 * この機能で最もやってはいけないこと。junior は区別できないまま覚えてしまう。
 */
export type MaterialLayer = MaterialKind;

/** 1 件の教材。プロンプトに載せる本文と、画面に出す根拠リンクの両方の元になる。 */
export interface CoachMaterial {
  kind: MaterialKind;
  /** knowledge=エントリ id / history=runId / rule=RULE-ID */
  id: string;
  /** 見出し(画面のリンク文言)。素材の原文のまま(翻訳しない)。 */
  title: string;
  /** 関連度(0〜1)。並べ替えと、しきい値判定に使う。 */
  score: number;
  /** 「その会社ならでは」の加点(64 §1-5(d))。並べ替えの第 2 キー。 */
  boost: number;
  /** 何で当たったか(ログ・デバッグ用。画面には出さない)。 */
  hits: string[];
  /** プロンプトに載せる本文(層ごとに組み立てる)。 */
  body: string;
  /**
   * 答えにあたる部分(ナレッジの rootCause / action、履歴の 2 手目以降)。
   * hintLevel が 3 未満のあいだはプロンプトに載せない。
   */
  answerBody: string;
  /** 画面のリンク先を決めるための付随情報。 */
  meta: MaterialMeta;
}

export interface MaterialMeta {
  /** ナレッジ: scope / タグ、履歴: source、ルール: severity など。画面のバッジ用。 */
  tags: string[];
  /** 素材の原文の言語(ナレッジのみ確定値を持つ)。地の文は UI 言語、素材は原文。 */
  lang?: CoachLang;
  /** 履歴素材: 元調査の runId(= id と同じ)。ナレッジ素材: 元調査の runId(あれば)。 */
  runId?: string | null;
  /** ルール素材: 公開ドキュメントの URL。 */
  references?: Array<{ title: string; url: string }>;
  /** ルール素材: severity。 */
  severity?: string;
  /** 履歴素材: 実行経路(manual / auto)。話題キーではないので tags には入れない。 */
  source?: string;
  /** 履歴素材: 確定したプラットフォーム。 */
  platform?: string | null;
  /** ルール素材: 法務・セキュリティ部門の承認が要る封じ込め系(SEC-10 / SEC-11)。 */
  requiresLegalReview?: boolean;
  /**
   * 素材の元になった記録の時刻(ISO)。ナレッジは approvedAt、履歴は at、ライブは取得時刻。
   * **鮮度の判定(古い素材ならライブで裏を取る)に使う**(68 番)。ルール層は持たない。
   */
  at?: string | null;
  /** at からの経過日数(サーバが計算して渡す。画面が再計算しないで済むように)。 */
  ageDays?: number | null;
  /** ライブ素材: 実際に呼んだ MCP ツール名(`server/tool` 形式)。根拠の表示に使う。 */
  tools?: string[];
  /** ライブ素材: 問い合わせた MCP サーバー名。 */
  servers?: string[];
}

// ---- 壁打ち ----

/** ヒントの段階。サーバが決定的に進める(モデルには決めさせない)。 */
export type HintLevel = 0 | 1 | 2 | 3;

/** モデルが宣言する学習者の理解段階(内部判定にだけ使う。本文からは除去する)。 */
export type LearnerLevel = "L1" | "L2" | "L3";

/** 1 ターンの進め方の指定。View のボタンがそのまま対応する。 */
export type TurnIntent =
  | "ask" // 通常の発話
  | "hintMore" // 💡 ヒントをもう 1 つ → hintLevel += 1
  | "escalate"; // 🔓 もう答えを教えて → hintLevel = 3

export interface CoachTurn {
  /** 学習者の発話(空でも可。ボタンだけ押した場合)。 */
  question: string;
  /** Coach の回答(マーカー除去済み)。 */
  answer: string;
  intent: TurnIntent;
  hintLevel: HintLevel;
  /** モデルの見立て(次ターンの入力に反映する)。 */
  level: LearnerLevel | null;
  /** この回で使った話題キー。 */
  topicKeys: string[];
  /** この回に渡した素材(根拠リンクの上限)。 */
  materials: MaterialRef[];
  /** モデルが `[SRC:...]` で実際に挙げた素材の id(渡した集合に含まれるものだけ)。 */
  citedIds: string[];
  /** 3 ターン規則で強制的に開示に到達したか(出し渋りの可視化に使う)。 */
  forcedDisclosure: boolean;
  /** ライブ層の動作(68 番)。判断の理由は**機械可読なコードのまま**残す。 */
  live?: TurnLive;
  at: string;
  durationMs: number;
  model: string;
  isError: boolean;
  /** 失敗理由(実行時の記録なので翻訳しない)。 */
  reason: string | null;
}

/**
 * 1 ターンぶんのライブ層の動作(68 番)。
 *
 * **サーバは文章を組み立てない**(CLAUDE.md)。なぜライブを引いた / 引かなかったのかは
 * `reasonCode` + `reasonParams` で返し、画面側の辞書が文にする。
 */
export interface TurnLive {
  /** ライブの事実を実際に教材へ載せたか。 */
  used: boolean;
  /** 判断の理由(live.ts の LiveReasonCode)。 */
  reasonCode: string;
  reasonParams?: Record<string, string | number>;
  /** キャッシュから返したか(= MCP 問い合わせは起きていない)。 */
  fromCache?: boolean;
  /** 問い合わせたプラットフォーム。 */
  platforms?: string[];
  /** 実際に呼んだ MCP ツール(`server/tool`)。 */
  tools?: string[];
  durationMs?: number;
  isError?: boolean;
  /** 失敗理由(実行時の記録なので翻訳しない)。 */
  reason?: string | null;
}

/** 画面へ返す素材の参照(本文は hintLevel に応じて出し分ける)。 */
export interface MaterialRef {
  kind: MaterialKind;
  id: string;
  title: string;
  score: number;
  meta: MaterialMeta;
}

export interface CoachSession {
  sessionId: string;
  mode: "chat" | "quiz";
  /** 障害対応中モード。true なら最初から hintLevel=3(64 §2-3(d))。 */
  incidentMode: boolean;
  startedAt: string;
  updatedAt: string;
  /** 現在の hintLevel。 */
  hintLevel: HintLevel;
  /** 今の論点で何往復したか。話題が変わったら 1 に戻る。 */
  turnsOnTopic: number;
  /** 今の論点の話題キー。 */
  topicKeys: string[];
  /** モデルの最後の見立て。 */
  level: LearnerLevel | null;
  /** 「もう答えを教えて」が押されたか。 */
  escalated: boolean;
  /**
   * このセッションで実際に走らせたライブ問い合わせの回数(68 番)。
   * キャッシュヒットは数えない。Central のレート制限に対する最後の歯止め。
   * 旧セッション(65〜67 番の記録)には無いので読み出し側は 0 に倒す。
   */
  liveCount?: number;
  turns: CoachTurn[];
  /** クイズモードで進行中の出題(mode="quiz" のときだけ)。 */
  quiz: QuizState | null;
}

/**
 * 一覧用の要約(70 番)。
 *
 * 履歴一覧に `CoachSession` をそのまま返すと、1 セッションぶんの `materials`
 * (根拠リンクの全件)まで載って一覧の応答が肥大する。**一覧は要約、詳細は全文**に分ける
 * (Webhook ログ・調査履歴と同じ流儀)。
 *
 * ここに置く値は**すべて機械可読なコード / 数値 / 実行時の記録**にしてある。
 * サーバで文章を組み立てない(CLAUDE.md「サーバ生成の文言を画面に出すとき」)。
 */
export interface CoachSessionSummary {
  sessionId: string;
  mode: "chat" | "quiz";
  incidentMode: boolean;
  startedAt: string;
  updatedAt: string;
  /** 往復数(記録された壁打ちのターン数)。 */
  turnCount: number;
  /** このセッションで出た話題キー(出現順・重複なし)。 */
  topicKeys: string[];
  /**
   * 一覧の見出しに使う最初の発話。**実行時の記録なので翻訳しない**(CLAUDE.md)。
   * ボタンだけで始まったセッションでは空になる。
   */
  firstQuestion: string;
  /** 到達した最大のヒント段階。 */
  maxHintLevel: HintLevel;
  /** 「もう答えを教えて」が押されたか。 */
  escalated: boolean;
  /** 3 ターン規則で強制開示に到達したターンがあるか。 */
  forcedDisclosure: boolean;
  /** ライブ確認を実際に使ったターンがあるか(68 番)。 */
  usedLive: boolean;
  /** 失敗したターンがあるか。 */
  hasError: boolean;
  /** モデルの最後の見立て。 */
  level: LearnerLevel | null;
  /** クイズの結果(mode="quiz" のときだけ)。 */
  quizVerdict: QuizVerdict | null;
  /** 生成にかかった時間の合計(ms)。ライブ問い合わせの時間も足す。 */
  totalDurationMs: number;
}

// ---- クイズ ----

/**
 * 出題形式。**素材の性質で決まる**(モデルには選ばせない。64 §3-1(c))。
 *   cause  … 症状 → 原因を当てる(ナレッジ。rootCause を隠す)
 *   next   … 症状 → 次の一手を当てる(調査履歴。calls[] の 2 手目以降を隠す)
 *   rule   … 設定 → どのルールに触れるか(ベストプラクティス)
 */
export type QuizFormat = "cause" | "next" | "rule";

export type QuizVerdict = "correct" | "partial" | "wrong";

export interface QuizState {
  quizId: string;
  format: QuizFormat;
  /** 出題の元になった素材 1 件。 */
  material: MaterialRef;
  /** 出題文(実行時の記録なので翻訳しない)。 */
  question: string;
  /** 何往復したか(2 往復で必ず解説に到達する。64 §3-2(b))。 */
  rounds: number;
  /** 直近の判定。 */
  verdict: QuizVerdict | null;
  /** 解説まで到達したか。 */
  revealed: boolean;
  askedAt: string;
  /** 出題時に難易度として提示した値(1〜3)。 */
  difficulty: number;
}

export interface QuizAnswerResult {
  /** 解答が無い開示専用ターン(74 番)は採点していないので null。 */
  verdict: QuizVerdict | null;
  feedback: string;
  revealed: boolean;
  rounds: number;
  materials: MaterialRef[];
  citedIds: string[];
}

// ---- 弱点(学習者 ID は持たない。デモ用途のため全体で 1 プロファイル)----

export interface TopicStat {
  topicKey: string;
  /** クイズの回答回数。 */
  attempts: number;
  correct: number;
  partial: number;
  wrong: number;
  /** 壁打ちでこの話題を扱ったセッション数。 */
  sessions: number;
  /** 壁打ちでの hintLevel の合計と回数(平均を出すため)。 */
  hintSum: number;
  hintCount: number;
  /** 「もう答えを教えて」が押された回数。 */
  escalations: number;
  /** 3 ターン規則で強制開示に至った回数(出し渋りの可視化)。 */
  forcedDisclosures: number;
  lastAt: string | null;
}

export interface WeaknessFile {
  version: number;
  topics: Record<string, TopicStat>;
  updatedAt: string;
}

/** 画面に出す「最近つまずいたところ」。 */
export interface WeaknessView {
  topicKey: string;
  attempts: number;
  correct: number;
  partial: number;
  wrong: number;
  avgHintLevel: number | null;
  escalations: number;
  /** 0〜1。attempts が minAttempts 未満なら null(= まだ弱点と呼ばない)。 */
  score: number | null;
  /** score が weaknessThreshold 以上で、attempts が足りているか。 */
  isWeak: boolean;
  lastAt: string | null;
}

// ---- 素材の利用実績(refCount とは別立て。64 §3-3)----

export interface MaterialUsage {
  kind: MaterialKind;
  id: string;
  quizCount: number;
  lastQuizAt: string | null;
  lastVerdict: QuizVerdict | null;
  /** 間隔反復で戻す予定日時(wrong だった素材は寝かせずに戻す)。 */
  reviewAfter: string | null;
}

export interface UsageFile {
  version: number;
  materials: MaterialUsage[];
  updatedAt: string;
}

// ---- 設定(すべて運用で調整できるようにする。64 §6-6)----

export interface CoachSettings {
  /** claude CLI の --model。null なら COACH_MODEL → NETINV_MODEL → sonnet。 */
  model: string | null;
  /** ナレッジの関連度しきい値。既定は実測値(store.ts の DEFAULT_THRESHOLD)。 */
  threshold: number;
  /**
   * 調査履歴の関連度しきい値。ナレッジとは**別の値**にしてある。
   * 履歴は「話題キーの一致」を必須の門にしているので、こちらの数値は順位付けの床でしかない
   * (根拠は store.ts の DEFAULT_HISTORY_THRESHOLD のコメント)。
   */
  historyThreshold: number;
  /** 1 ターンに渡す素材の上限(合計)。 */
  maxMaterials: number;
  /** 3 ターン規則。この往復数に達したら必ず hintLevel=3 にする。 */
  turnRule: number;
  /** 弱点タグでの短縮版 3 ターン規則。 */
  weakTurnRule: number;
  /** クイズの上限往復数(これを超えたら必ず解説)。 */
  quizRounds: number;
  /** 弱点として扱うのに必要な最小回答数。 */
  minAttempts: number;
  /** 弱点スコアのしきい値(0〜1)。 */
  weaknessThreshold: number;
  /** クイズで弱点タグの素材を優先する確率(0〜1)。1/3 が既定。 */
  weakBias: number;

  // ---- ライブ層(68 番。MCP 経由の Central / Mist 問い合わせ)----
  //
  // 「静的な蓄積を優先し、それだけでは根拠が薄い / 古い / 対象外のときにライブで補強する」
  // という段階的フォールバックの数値。すべて運用で調整できるようにしてある(64 §6-6)。

  /** ライブ層を使うか。false なら Coach は 65〜67 番とまったく同じ挙動に戻る。 */
  liveEnabled: boolean;
  /**
   * 静的素材の「厚み」の床。ナレッジ / 履歴の最高 score がこれ未満なら
   * 「根拠が薄い」と見なしてライブへ回す。
   */
  liveStaticFloor: number;
  /** 静的素材がこの日数より古ければ「鮮度が足りない」と見なしてライブへ回す。 */
  liveStaleDays: number;
  /** ライブ問い合わせ 1 回のタイムアウト(ms)。対話なので調査タブ(240 秒)より短くする。 */
  liveTimeoutMs: number;
  /** 同じ話題のライブ結果を使い回す時間(ms)。Central のレート制限対策の主軸。 */
  liveCacheTtlMs: number;
  /** ライブ問い合わせどうしの最小間隔(ms)。アカウント全体で共有のレート制限に配慮する。 */
  liveMinIntervalMs: number;
  /** 1 セッションあたりのライブ問い合わせ上限(キャッシュヒットは数えない)。 */
  liveMaxPerSession: number;
}
