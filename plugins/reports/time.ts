// 日次レポート(41)— 「日」の境界を扱うためのタイムゾーンヘルパー。
//
// このアプリの「1 日」は **コンテナのローカル時刻**(docker-compose の TZ=Asia/Tokyo)で切る。
// 既存の定期実行(network-investigation/schedule.ts)も node-cron の timezone に同じ値を
// 使っているので、「9:00 に前日分」の 9:00 と「前日 0:00〜24:00」の 0:00 が同じ暦になる。
//
// Date は UTC の瞬間しか持たないため、ローカル日付 → UTC 瞬間の変換は
// Intl.DateTimeFormat でそのゾーンの壁時計を読み、その差分でオフセットを求める方式にする
// (JST は DST を持たないが、他ゾーンに変えても壊れないようにこの形にしてある)。

export const REPORT_TZ = process.env.TZ || "Asia/Tokyo";

const PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: REPORT_TZ,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function wallClockUtcMs(at: Date): number {
  const p: Record<string, string> = {};
  for (const part of PARTS_FMT.formatToParts(at)) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  // hour は hour12:false でも "24" になることがある(深夜 0 時)。Date.UTC は繰り上げてくれる。
  return Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
}

/** at の時点における REPORT_TZ の UTC オフセット(ミリ秒。JST なら +9h)。 */
function tzOffsetMs(at: Date): number {
  return wallClockUtcMs(at) - at.getTime();
}

/** その瞬間が REPORT_TZ で何月何日かを "YYYY-MM-DD" で返す。 */
export function dateKeyOf(at: Date | string | number = new Date()): string {
  const d = at instanceof Date ? at : new Date(at);
  const ms = wallClockUtcMs(d);
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 10);
}

/** "YYYY-MM-DD" の形式チェック(API の入力検証にも使う)。 */
export function isDateKey(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

/**
 * ローカル日付の 0:00 に相当する UTC 瞬間(ミリ秒)。
 * 一度オフセットを当ててから、その結果の時点のオフセットで取り直す(DST 境界対策)。
 */
export function localMidnightMs(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0);
  const first = naive - tzOffsetMs(new Date(naive));
  return naive - tzOffsetMs(new Date(first));
}

export interface DayWindow {
  dateKey: string;
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
}

/** ローカル日付 1 日ぶんの区間 [0:00, 翌 0:00)。 */
export function dayWindow(dateKey: string): DayWindow {
  const startMs = localMidnightMs(dateKey);
  const endMs = localMidnightMs(addDays(dateKey, 1));
  return {
    dateKey,
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };
}

/** "YYYY-MM-DD" に n 日足す(負の値で戻る)。 */
export function addDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 今日(REPORT_TZ)の日付キー。 */
export function todayKey(): string {
  return dateKeyOf(new Date());
}

/** 昨日(REPORT_TZ)の日付キー。定期実行が対象にする日。 */
export function yesterdayKey(): string {
  return addDays(todayKey(), -1);
}

// ---- 週 / 月(45)----
//
// 週は **月曜始まり(ISO 8601)**。週次レポートの保存キーは ISO 週番号の "YYYY-Www" で、
// 週番号が属する年(ISO week-year)は「その週の木曜日が属する年」で決まる
// (2026-12-28(月)〜2027-01-03(日) は 2026-W53 ではなく 2027-W01 になる)。
// 画面側(view/dates.ts)も同じ定義を使う。片方だけ変えないこと。

/** "YYYY-Www" の形式チェック。 */
export function isWeekKey(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(v);
}

/** "YYYY-MM" の形式チェック。 */
export function isMonthKey(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/** その日を含む週の月曜日("YYYY-MM-DD")。 */
export function weekStartOf(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  // getUTCDay() は 0=日曜。月曜始まりにするため 0=月 … 6=日 に読み替える。
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(dateKey, -dow);
}

/** 年内通算日(1 始まり)。 */
function dayOfYear(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
}

/** その日が属する ISO 週のキー("YYYY-Www")。 */
export function weekKeyOf(dateKey: string): string {
  // ISO 週 1 は「その年の最初の木曜日を含む週」。週の木曜日を見れば週番号も年も決まる。
  const thursday = addDays(weekStartOf(dateKey), 3);
  const week = Math.ceil(dayOfYear(thursday) / 7);
  return `${thursday.slice(0, 4)}-W${String(week).padStart(2, "0")}`;
}

/** "YYYY-Www" → その週の月曜日。 */
export function weekStartOfKey(weekKey: string): string {
  const year = Number(weekKey.slice(0, 4));
  const week = Number(weekKey.slice(6));
  // 1 月 4 日は必ず ISO 週 1 に入る(ISO 8601 の定義)。そこを起点に (週-1) 週ぶん進める。
  return addDays(weekStartOf(`${year}-01-04`), (week - 1) * 7);
}

/** "YYYY-MM" のその月の 1 日。 */
export function monthStartOfKey(monthKey: string): string {
  return `${monthKey}-01`;
}

/** "YYYY-MM" のその月の末日。 */
export function monthEndOfKey(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** "YYYY-MM" に n か月足す。 */
export function addMonthKeys(monthKey: string, n: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

/** "YYYY-Www" に n 週足す。 */
export function addWeekKeys(weekKey: string, n: number): string {
  return weekKeyOf(addDays(weekStartOfKey(weekKey), n * 7));
}

export interface PeriodWindow {
  /** "YYYY-Www" または "YYYY-MM" */
  key: string;
  startDate: string;
  endDate: string;
  /** 期間に含まれる暦日(昇順) */
  days: string[];
}

/** 週 / 月のキー → 暦日の並び。 */
export function periodWindow(periodType: "weekly" | "monthly", key: string): PeriodWindow {
  const startDate = periodType === "weekly" ? weekStartOfKey(key) : monthStartOfKey(key);
  const endDate = periodType === "weekly" ? addDays(startDate, 6) : monthEndOfKey(key);
  const days: string[] = [];
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) days.push(d);
  return { key, startDate, endDate, days };
}

/** 今日が属する週 / 月のキー。 */
export function currentPeriodKey(periodType: "weekly" | "monthly"): string {
  const today = todayKey();
  return periodType === "weekly" ? weekKeyOf(today) : today.slice(0, 7);
}

/**
 * 「直前の完了した週 / 月」のキー。定期実行が対象にする期間。
 * 発火する曜日 / 日を設定で変えても「今の週 / 月の 1 つ前」になるよう、
 * 今日が属する期間から 1 つ戻す形で求める(前日を見る形にしない)。
 */
export function previousPeriodKey(periodType: "weekly" | "monthly"): string {
  const today = todayKey();
  return periodType === "weekly"
    ? weekKeyOf(addDays(weekStartOf(today), -1))
    : addMonthKeys(today.slice(0, 7), -1);
}

/** ISO 文字列(または null)が区間内かどうか。パースできない値は区間外扱い。 */
export function inWindow(iso: string | null | undefined, w: DayWindow): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return t >= w.startMs && t < w.endMs;
}
