// MCP ツール呼び出しの「出所」分類(56)。
//
// ネットワーク調査の回答は、次の 2 つが混ざったものになる:
//   (a) Central / Mist のネイティブ AI 機能が生成した所見(例: Mist の Marvis Actions)
//   (b) Insight Agent(Claude / Local LLM)が、取得した生の値をもとに書いた分析
// 画面では両者が同じ「回答本文」に見えるため、どのツール呼び出しが (a) だったのかを
// 記録・表示できるようにする。ここはその分類だけを担当する純関数モジュール。
//
// サーバ(insight-agent.ts / ollama-agent.ts / api.ts)と View(ToolCallRow など)の
// 両方から import する単一ソースにする(tool-labels.json と同じ扱い)。
// Node 依存を持ち込まないこと(View 側は Vite でバンドルされる)。
//
// ---- 分類の根拠(56 Task 1)----
//
// ネイティブ AI 由来(native AI)に分類するのは、
// **ベンダーの AI が「所見・推奨・診断結果」として生成した文章/判定を返すツール呼び出し** だけ:
//
//   get_mist_insights(insight_type="marvis_actions")
//     … MCP のツール説明で "AI-powered network suggestions from Marvis"。
//       Marvis Minis が検出した接続障害(DHCP/ARP/DNS 等)や優先度付きの推奨対処が返る。
//   get_mist_insights(insight_type="troubleshoot")
//     … 同 "Marvis AI troubleshooting for sites, devices, and clients"(Marvis ライセンス必須)。
//       サイト・端末の根本原因診断そのもの。
//
// 逆に、次は **ネイティブ AI 由来には分類しない**(= 生データ取得として扱う):
//
//   get_mist_insights(insight_type="sle" / "insight_metrics")
//     … SLE / インサイト指標は Mist クラウドが集計した統計値(数値)であって、
//       Marvis が書いた所見ではない。「Marvis AI 由来」と表示すると出所を過大に主張することになる。
//   central_* のすべて
//     … central-mcp が公開しているツールは REST のスナップショット/トレンド取得のみ。
//       central_get_summary の health も「Good=100 / Fair=50 / Poor=0 の加重平均」という
//       固定式の集計値で、AI が生成した所見ではない。
//       (Central 側に AIOps / AI Insights 相当を返す MCP ツールは存在しない → Mist のみの対応)
//
// 分類はツール名だけでは決まらない(get_mist_insights は 4 つの insight_type を 1 ツールに
// 束ねている)ため、呼び出し引数まで見て判定する。

/** ネイティブ AI 機能の機械可読コード。表示名は i18n の networkInvestigation.aiSource.feature.<code> を引く。 */
export type NativeAiFeature = "marvisActions" | "marvisTroubleshoot";

/**
 * ツール呼び出し 1 件の出所(ネイティブ AI 由来のときだけ付く)。
 * 「生データ取得」は「このフィールドが無い」で表す — 既存の呼び出し記録
 * (query-history.jsonl の calls[])を膨らませないため、また旧履歴と同じ見た目に保つため。
 */
export interface ToolAiSource {
  /** 提供元プラットフォーム。今のところ Mist(Marvis)のみ。 */
  vendor: "mist";
  feature: NativeAiFeature;
}

const MIST_INSIGHTS_TOOL = "get_mist_insights";

// insight_type → ネイティブ AI 機能。ここに無い insight_type(sle / insight_metrics)は
// 生データ取得として扱う(上のコメント参照)。
const INSIGHT_TYPE_TO_FEATURE: Record<string, NativeAiFeature> = {
  marvis_actions: "marvisActions",
  troubleshoot: "marvisTroubleshoot",
};

function readInsightType(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>).insight_type;
  return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
}

/**
 * ツール名 + 呼び出し引数から出所を判定する。
 * ネイティブ AI 由来でなければ null(= 生データ取得)。
 *
 * @param tool  mcp__ 接頭辞を除いたツール名(parseMcpToolName の tool)
 * @param input tool_use の引数オブジェクト
 */
export function classifyToolAiSource(tool: string, input: unknown): ToolAiSource | null {
  if (tool !== MIST_INSIGHTS_TOOL) return null;
  const insightType = readInsightType(input);
  if (!insightType) return null;
  const feature = INSIGHT_TYPE_TO_FEATURE[insightType];
  return feature ? { vendor: "mist", feature } : null;
}

/** 呼び出し一覧のうち、ネイティブ AI 由来の件数。0 なら従来どおりの表示にする。 */
export function countNativeAiCalls(calls: ReadonlyArray<{ aiSource?: ToolAiSource | null }>): number {
  let n = 0;
  for (const c of calls) if (c.aiSource) n++;
  return n;
}
