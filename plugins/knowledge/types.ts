// ナレッジ(46)— サーバ側の型。
//
// 「調査結果 → 知見候補 → 人の承認 → ナレッジベース」の 1 本道を表す型を置く。
// View 側(view/types.ts)にも同じ形をコピーしている(他プラグインと同じ流儀。
// サーバの型をそのまま import すると Vite のビルドに server 側の依存が混ざるため)。
//
// 46 では「蓄積」までを担当する。蓄積したナレッジを次の調査プロンプトへ注入する
// (= 調査への反映)のは 47 番なので、ここには入れない。

/** 候補の状態。承認・却下・統合のいずれでも **消さずに残す**(誤操作を見返せるように)。 */
export type KnowledgeStatus = "pending" | "approved" | "rejected" | "merged";

/**
 * 適用範囲。承認画面のタグと、47 番でプロンプトに注入する際の絞り込みに使う。
 *   general … 機種・サイトによらず当てはまる一般的なパターン
 *   site    … 特定サイトの構成・環境に紐づく
 *   device  … 特定の機器 1 台(またはその型番)固有
 */
export type KnowledgeScope = "general" | "site" | "device";

export type KnowledgePlatform = "central" | "mist" | "both" | null;

/** 候補の出どころ(元になった調査)。マージすると 1 エントリに複数溜まる。 */
export interface KnowledgeSource {
  /** 元調査の runId(= query-history.jsonl の id)。「調査結果を見る」の飛び先。 */
  runId: string;
  /** 元調査のセッション ID(runId と同じ場合もある)。 */
  sessionId: string;
  /** 元調査の実行経路。manual = 手動、auto = 自動事前調査、scheduled = 定期実行。 */
  origin: "manual" | "scheduled" | "auto";
  /** 元調査のクエリ文(実行時の記録なので翻訳しない)。 */
  query: string;
  /** 元調査の実行時刻(ISO8601)。 */
  at: string;
  /** 候補を生成した時刻(ISO8601)。 */
  extractedAt: string;
}

export interface KnowledgeEntry {
  id: string;
  status: KnowledgeStatus;

  // ---- カード 1 枚に出す 4 項目(承認の手間を最小化するための単位)----
  /** タイトル(一行) */
  title: string;
  /** 症状 = どんな状況で当てはまるか */
  symptom: string;
  /** 根本原因 */
  rootCause: string;
  /** 対処法 / 次のアクション */
  action: string;

  // ---- 適用範囲 ----
  scope: KnowledgeScope;
  tags: string[];
  platform: KnowledgePlatform;
  site: string | null;
  device: string | null;

  /** 生成時の言語。本文は「実行時の記録」なので後から翻訳しない(CLAUDE.md の方針)。 */
  lang: "ja" | "en";

  /** 出典。承認済みエントリにマージすると増える。 */
  sources: KnowledgeSource[];

  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  /** 「編集して承認」で本文に手が入ったか(そのまま承認なら false)。 */
  edited: boolean;

  // ---- 調査プロンプトへの注入実績(47)----
  // 「このナレッジが実際に次の調査で使われたか」を測る 2 つの値。
  // 注入した時点(= system prompt に載せた時点)で 1 加算する。モデルの回答本文が
  // その知見に言及したかどうかは自然言語で判定するしかなく、CLAUDE.md が禁じている
  // 「モデル出力を自然言語でパースする実装」になるため、参照 = 注入で定義する。
  /** 調査プロンプトに注入された回数。旧データには無いので読み込み時に 0 を補う。 */
  refCount: number;
  /** 最後に注入された時刻(ISO8601)。一度も注入されていなければ null。 */
  lastReferencedAt: string | null;

  /** 類似すると判定された既存エントリ(承認済み)。スコアの高い順。 */
  similar: SimilarRef[];
  /** この候補を取り込んだ相手(マージした場合)。 */
  mergedInto: string | null;
  /** この(承認済み)エントリが取り込んだ候補の id。 */
  mergedFrom: string[];
}

export interface SimilarRef {
  id: string;
  /** 0〜1。similarity.ts の score()。 */
  score: number;
  /** 相手のタイトル(画面が引き当てられなかった場合のフォールバック表示用)。 */
  title: string;
}

/** LLM が 1 回の抽出で返す候補(正規化前)。 */
export interface RawCandidate {
  title?: unknown;
  symptom?: unknown;
  rootCause?: unknown;
  action?: unknown;
  scope?: unknown;
  tags?: unknown;
  platform?: unknown;
  site?: unknown;
  device?: unknown;
}

/** 抽出 1 回の記録(GET /status に出す。実行状況を追えるようにする)。 */
export interface ExtractionLogEntry {
  runId: string;
  at: string;
  origin: "manual" | "scheduled" | "auto";
  status: "created" | "empty" | "skipped" | "error";
  /** 生成した候補の数 */
  created: number;
  /** 既に同じ内容の未承認候補があったため作らなかった数 */
  duplicatePending: number;
  /** 承認済みと類似していたためマージ提案として出した数 */
  similarApproved: number;
  /** skipped / error の理由(機械可読なコード)。画面は辞書で文にする。 */
  reasonCode: string | null;
  reasonDetail: string | null;
  durationMs: number;
  model: string | null;
}

export interface KnowledgeSettings {
  /** 抽出そのものの有効 / 無効。false なら調査が終わっても候補を作らない。 */
  enabled: boolean;
  /** 対象にする調査の実行経路。 */
  sources: {
    manual: boolean;
    auto: boolean;
    scheduled: boolean;
  };
  /** 抽出に使うモデル(claude CLI の --model)。null なら NETINV_MODEL。 */
  model: string | null;
  /** 回答本文がこの文字数に満たない調査は、そもそも抽出にかけない。 */
  minAnswerChars: number;
  /** 1 回の調査から作る候補の上限。 */
  maxPerRun: number;
  /** 類似判定のしきい値(0〜1)。これ以上なら「類似候補あり」。 */
  similarityThreshold: number;
  /** 承認済みナレッジを次の調査プロンプトへ注入する設定(47)。 */
  inject: KnowledgeInjectSettings;
}

export interface KnowledgeInjectSettings {
  /** 注入そのものの有効 / 無効。false なら従来どおり注入なしで調査する。 */
  enabled: boolean;
  /** 1 回の調査に注入するナレッジの上限件数。 */
  maxEntries: number;
  /** 関連度のしきい値(0〜1)。これ以上のものだけを注入する。 */
  threshold: number;
}

/** 1 回の調査に注入したナレッジの記録(SSE・調査履歴に載せる)。 */
export interface KnowledgeRef {
  id: string;
  title: string;
  /** 関連度(0〜1)。retrieve.ts の relevance()。 */
  score: number;
}
