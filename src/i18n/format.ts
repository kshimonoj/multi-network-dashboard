// 日時 / 数値 / 相対時刻の言語別整形(33 Task 3: L-10 / L-11)。
//
// 30〜32 では各タブが同じ整形関数(fmt / rel)をコピーして持っていた。
//  - 日時は toLocaleString("ja-JP", { hour12: false }) が**ハードコード**されていて、
//    英語表示でも日本形式のままだった(L-10)。
//  - 相対時刻(「n 秒前」)は 4 タブに同じ分岐が重複していた(L-11)。
// どちらもここに集約し、各タブはこのモジュールを呼ぶだけにする。
//
// 方針:
//  - **日本語表示時の見た目は変えない。** ja は従来どおり toLocaleString("ja-JP", {hour12:false})
//    (= "2026/7/28 14:30:00")を返す。
//  - en も 24 時間表記に揃える(= "7/28/2026, 14:30:00")。AM/PM を出すと桁が伸び、
//    イベント表の時刻列(.wf-time / .cs-time 等の固定幅)が崩れるため。
//  - 相対時刻の辞書(time.relative.*)は 31 番で作ったものをそのまま共有する。
//    英語の単数/複数(1 minute ago / 2 minutes ago)は辞書側のキーで持ち、ここで選ぶ。

import { getLang, type Lang } from "./i18n";
import type { TFunc } from "./LanguageContext";

const LOCALE_TAG: Record<Lang, string> = { ja: "ja-JP", en: "en-US" };

/** Intl / toLocaleString に渡すロケールタグ。 */
export function localeTag(lang: Lang = getLang()): string {
  return LOCALE_TAG[lang] ?? LOCALE_TAG.ja;
}

/**
 * ISO 文字列 → 「日付 時刻」表示。
 * 解釈できない値・null は fallback(既定 "—")を返す(従来の各タブの挙動と同じ)。
 */
export function formatDateTime(
  iso: string | null | undefined,
  lang: Lang = getLang(),
  fallback = "—",
): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleString(localeTag(lang), { hour12: false });
}

/** 桁区切り付きの数値(件数・上限値など)。 */
export function formatNumber(n: number, lang: Lang = getLang()): string {
  return n.toLocaleString(localeTag(lang));
}

export interface RelativeOptions {
  /**
   * 最大単位。既定は "day"。
   * Event / Alert・Webhook ログの「最終取得からの経過」は 30〜32 の時点で時間止まり
   * (24 時間を超えても「n 時間前」)だったので、その 2 箇所だけ "hour" を渡して
   * 日本語表示の見た目を変えないようにする。
   */
  maxUnit?: "hour" | "day";
}

/**
 * 経過ミリ秒 → 相対時刻の辞書キーと数値。
 * 表示は呼び出し側が t(key, { n }) で行う(単数/複数は辞書のキーで分ける)。
 */
export function relativeTimeKey(elapsedMs: number, opts: RelativeOptions = {}): { key: string; n: number } {
  // Math.round は 30〜32 の各タブの rel() と同じ丸め。floor に変えると境界の 1 秒だけ
  // 表示が変わるので、既存タブへの影響を出さないためここは round のまま揃える。
  const s = Math.max(0, Math.round(elapsedMs / 1000));
  if (s < 60) return { key: `time.relative.secondsAgo${s === 1 ? "One" : "Other"}`, n: s };
  const m = Math.floor(s / 60);
  if (m < 60) return { key: `time.relative.minutesAgo${m === 1 ? "One" : "Other"}`, n: m };
  const h = Math.floor(m / 60);
  if (h < 24 || opts.maxUnit === "hour") return { key: `time.relative.hoursAgo${h === 1 ? "One" : "Other"}`, n: h };
  const d = Math.floor(h / 24);
  return { key: `time.relative.daysAgo${d === 1 ? "One" : "Other"}`, n: d };
}

/**
 * 「n 秒前」/「n minutes ago」。t は useT() で得たものを渡す。
 * 30〜32 の各タブが持っていた rel() の共通実装。
 */
export function formatRelative(t: TFunc, elapsedMs: number, opts: RelativeOptions = {}): string {
  const { key, n } = relativeTimeKey(elapsedMs, opts);
  return t(key, { n });
}
