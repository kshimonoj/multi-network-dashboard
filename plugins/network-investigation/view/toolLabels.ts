// MCP ツール名 → 人間向けの日本語ラベル変換(Task 2)。
// マッピングの真実は plugins/network-investigation/tool-labels.json(サーバー/View 共通の単一ソース)。
// 未登録のツールはツール名をそのまま返す(表示が壊れないためのフォールバック)。

import toolLabelsJson from "../tool-labels.json";

const LABELS: Record<string, string> = (toolLabelsJson as { labels?: Record<string, string> }).labels ?? {};

export function toolLabel(tool: string): string {
  return LABELS[tool] ?? tool;
}

// ラベルが登録済みか(登録済みならラベル + 生ツール名を併記する等の出し分けに使える)。
export function hasToolLabel(tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(LABELS, tool);
}
