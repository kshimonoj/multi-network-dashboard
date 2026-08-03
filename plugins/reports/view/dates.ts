// レポートタブ(43)— カレンダー用の日付ユーティリティ。
//
// 扱う値は一貫して "YYYY-MM-DD"(日)と "YYYY-MM"(月)の文字列。
// 計算は必ず UTC 上の算術で行う(Date.UTC / toISOString)。ローカルタイムの Date で
// 日付を足し引きすると DST や TZ 境界で 1 日ずれるため。
//
// レポートの日付キーはサーバのローカル TZ(docker-compose の TZ=Asia/Tokyo)で切られている
// (plugins/reports/time.ts)。画面側は「サーバが返した日付キーをそのまま扱う」だけで、
// 再解釈しない。today() だけはブラウザのローカル暦を使う(「今日」の枠を出すための目印)。
//
// 表示用の整形(「2026年7月」等)はロケール依存なので src/i18n/format.ts の localeTag() を通す。

import { localeTag } from "../../../src/i18n";
import type { Lang } from "../../../src/i18n";

// 45: 週は **月曜始まり(ISO 8601)** に統一した。週次レポートの対象期間が月曜〜日曜なので、
// カレンダーの「行」がそのまま 1 つの週次レポートに対応するようにするため
// (43 番の時点では日曜始まりだった)。サーバ側の定義は plugins/reports/time.ts。
export const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** "YYYY-MM-DD" → UTC ミリ秒(0:00)。 */
function dayMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function keyOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return keyOf(dayMs(date) + n * 86_400_000);
}

/** その日の曜日(0=日曜)。 */
export function weekdayOf(date: string): number {
  return new Date(dayMs(date)).getUTCDay();
}

/** 週の開始日(月曜始まり)。カレンダーのグリッドと週次選択で同じ定義を使う。 */
export function startOfWeek(date: string): string {
  // getUTCDay() は 0=日曜。月曜始まりにするため 0=月 … 6=日 に読み替える。
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

export function endOfWeek(date: string): string {
  return addDays(startOfWeek(date), 6);
}

/** 年内通算日(1 始まり)。ISO 週番号の計算に使う。 */
function dayOfYear(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
}

/**
 * その日が属する ISO 週のキー("YYYY-Www")。週次レポートの保存キーと同じ。
 * サーバ側(plugins/reports/time.ts の weekKeyOf)と同じ計算をしている。片方だけ変えないこと。
 */
export function weekKeyOf(date: string): string {
  const thursday = addDays(startOfWeek(date), 3);
  const week = Math.ceil(dayOfYear(thursday) / 7);
  return `${thursday.slice(0, 4)}-W${String(week).padStart(2, "0")}`;
}

/** "YYYY-Www" → その週の月曜日。 */
export function weekStartOfKey(weekKey: string): string {
  const year = Number(weekKey.slice(0, 4));
  const week = Number(weekKey.slice(6));
  // 1 月 4 日は必ず ISO 週 1 に入る。
  return addDays(startOfWeek(`${year}-01-04`), (week - 1) * 7);
}

/** "YYYY-MM-DD" → "YYYY-MM" */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** "YYYY-MM" に n か月足す。 */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return t.toISOString().slice(0, 7);
}

/** "YYYY-MM" の 1 日。 */
export function firstOfMonth(ym: string): string {
  return `${ym}-01`;
}

/** "YYYY-MM" の末日。 */
export function lastOfMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return keyOf(Date.UTC(y, m, 0));
}

/** ブラウザのローカル暦での今日。 */
export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface CalendarCell {
  date: string;
  /** 表示中の月に属する日か(前後の月からのはみ出しは薄く出す) */
  inMonth: boolean;
}

/**
 * 月表示のカレンダーグリッド(日曜始まり)。常に週単位の配列を返す。
 * 前後の月の日でグリッドを埋めるので、行数は 4〜6 で変動する。
 */
export function monthGrid(ym: string): CalendarCell[][] {
  const first = firstOfMonth(ym);
  const last = lastOfMonth(ym);
  const gridStart = startOfWeek(first);
  const gridEnd = endOfWeek(last);
  const weeks: CalendarCell[][] = [];
  let cur = gridStart;
  while (cur <= gridEnd) {
    const week: CalendarCell[] = [];
    for (let i = 0; i < 7; i += 1) {
      week.push({ date: cur, inMonth: monthOf(cur) === ym });
      cur = addDays(cur, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** 「2026年7月」/ "July 2026"。 */
export function formatMonthLabel(ym: string, lang: Lang): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(localeTag(lang), {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** 「7月30日」/ "Jul 30"(カレンダー外での短い日付表記)。 */
export function formatDayLabel(date: string, lang: Lang): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(localeTag(lang), {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** グラフの X 軸ラベル用(「7/30」/ "7/30")。桁を詰めたいので数値だけにする。 */
export function formatAxisDay(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}`;
}

/** 月の月名だけ(「7月」/ "Jul")。月次ピッカーの 12 マスに使う。 */
export function formatMonthShort(ym: string, lang: Lang): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(localeTag(lang), {
    month: "short",
    timeZone: "UTC",
  });
}
