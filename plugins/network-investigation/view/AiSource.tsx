import { useT, type TFunc } from "../../../src/i18n";
import type { ToolAiSource } from "./types";

// 出所(56)の表示部品。
//
// ネットワーク調査の回答には、
//   (a) Central / Mist のネイティブ AI 機能が生成した所見(現状は Mist の Marvis)
//   (b) Insight Agent(Claude / Local LLM)自身の分析
// が混ざる。(a) を取得したツール呼び出しにだけバッジを付け、回答の直前に注記を出す。
//
// 表現は 53 番の「AI 所見」バッジ + 注記(plugins/best-practice の bp-badge-llm /
// bp-note-llm)に合わせる: 小さな pill バッジ + 左罫線の淡い注記。
// 生データ取得だけの実行では何も描画しない(従来どおりの表示のまま)。

/** 機能の表示名(製品名なので日英ともほぼ同じ。辞書で引く)。 */
export function aiSourceFeatureName(t: TFunc, source: ToolAiSource): string {
  return t(`networkInvestigation.aiSource.feature.${source.feature}`);
}

/** ツール呼び出し 1 行に付けるバッジ。 */
export function AiSourceBadge({ source }: { source: ToolAiSource }) {
  const t = useT();
  const feature = aiSourceFeatureName(t, source);
  return (
    <span
      className="ni-ai-badge"
      title={t("networkInvestigation.aiSource.badgeTitle", { feature })}
    >
      {t("networkInvestigation.aiSource.badge", { feature })}
    </span>
  );
}

/**
 * 回答の直前に出す注記。ネイティブ AI 由来の呼び出しが 1 件も無ければ何も描画しない。
 * 「バッジの行 = ベンダーの AI が書いた所見」「回答本文 = Insight Agent の分析」の
 * 2 点を 1 か所で伝える。
 */
export function AiSourceNote({ calls }: { calls: ReadonlyArray<{ aiSource?: ToolAiSource }> }) {
  const t = useT();
  const features: string[] = [];
  for (const c of calls) {
    if (!c.aiSource) continue;
    const name = aiSourceFeatureName(t, c.aiSource);
    if (!features.includes(name)) features.push(name);
  }
  if (features.length === 0) return null;
  return (
    <div className="ni-ai-note">
      {t("networkInvestigation.aiSource.note", { features: features.join(" / ") })}
    </div>
  );
}
