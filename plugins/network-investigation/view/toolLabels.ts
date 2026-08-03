// MCP ツール名 → 人間向けのラベル変換(Task 2)。
// マッピングの真実は plugins/network-investigation/tool-labels.json(サーバー/View 共通の単一ソース)。
// 未登録のツールはツール名をそのまま返す(表示が壊れないためのフォールバック)。
//
// 33: 表示言語で日英を引き分ける。辞書(src/i18n/*.json)ではなく tool-labels.json 側に
// labels(ja)/ labelsEn(en)として持つ — MCP ツール名との対応表という 1 つの資産で
// あることを保ちたいので、言語ごとにファイルを割らない。
// 英語ラベルが未登録なら日本語ラベル → ツール名 の順にフォールバックする。

import { getLang } from "../../../src/i18n";
import toolLabelsJson from "../tool-labels.json";

const json = toolLabelsJson as { labels?: Record<string, string>; labelsEn?: Record<string, string> };
const LABELS: Record<string, string> = json.labels ?? {};
const LABELS_EN: Record<string, string> = json.labelsEn ?? {};

export function toolLabel(tool: string): string {
  if (getLang() === "en" && LABELS_EN[tool]) return LABELS_EN[tool];
  return LABELS[tool] ?? tool;
}

// ラベルが登録済みか(登録済みならラベル + 生ツール名を併記する等の出し分けに使える)。
export function hasToolLabel(tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(LABELS, tool);
}
