// messageCode + messageParams → 表示文への変換(networkInvestigation の
// routingReasonText() / scheduleDetailText() と同じ方式)。
//
// サーバは文章を作らず、Finding.messageCode に完全な辞書キー
// (`bestPractice.findings.<ruleId>.<case>`)を積んで返す。ここでは
// t(messageCode, messageParams) をそのまま呼ぶだけでよい。
//
// 例外: LLM 所見(note が入っている Finding)は「実行時の記録」なので翻訳しない
// (CLAUDE.md「サーバ生成の文言を画面に出すとき」の項)。note をそのまま表示する。

import type { TFunc } from "../../../src/i18n";
import type { BestPracticeRule, Finding } from "./types";

export function findingText(t: TFunc, f: Finding): string {
  if (f.note) return f.note;
  return t(f.messageCode, f.messageParams);
}

export function ruleTitle(t: TFunc, rule: BestPracticeRule): string {
  return t(rule.titleKey);
}

export function ruleDesc(t: TFunc, rule: BestPracticeRule): string {
  return t(rule.descriptionKey);
}
