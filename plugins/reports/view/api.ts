// レポートタブ View(43)— /api/reports/* への fetch ラッパ。
//
// 使う口:
//   GET /api/reports/daily               … 生成済みレポートの一覧(軽量メタ。41)
//   GET /api/reports/daily/:date         … 1 日ぶんのレポート全体(41)
//   GET /api/reports/auto-investigations … 重大な問題の自動事前調査の履歴(44)
//
// レポート本体は 30〜60KB ある。カレンダーで日を行き来するたびに取り直すと無駄なので、
// 一度読んだ日はモジュールスコープの Map に残す(タブを閉じても保持される)。
// トレンドグラフ(直近 N 日ぶんの日次レポートを並べる)も同じキャッシュを共有する。
// 「更新」ボタンを押したときだけ clearReportCache() で捨てる。

import type {
  AutoInvestigationsResponse,
  DailyReport,
  DailyReportMeta,
  PeriodReport,
  PeriodReportMeta,
  PeriodType,
} from "./types";

const BASE = "/api/reports";

/** 日付キー → レポート本体。null は「その日は 404(未生成)」を意味する。 */
const cache = new Map<string, DailyReport | null>();
/** 同じ日を同時に複数回引かないための in-flight 共有(トレンドの並列取得で効く)。 */
const inflight = new Map<string, Promise<DailyReport | null>>();
/** 45: 週次 / 月次。"weekly:2026-W31" のような複合キーで 1 つの Map に入れる。 */
const periodCache = new Map<string, PeriodReport | null>();
const periodInflight = new Map<string, Promise<PeriodReport | null>>();

export function clearReportCache(): void {
  cache.clear();
  inflight.clear();
  periodCache.clear();
  periodInflight.clear();
}

async function json(res: Response): Promise<unknown> {
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

/** 生成済み日次レポートの一覧(新しい順)。カレンダーの「選べる日」はこれで決まる。 */
export async function fetchDailyList(limit = 400): Promise<DailyReportMeta[]> {
  const res = await fetch(`${BASE}/daily?limit=${limit}`);
  const parsed = await json(res);
  if (!res.ok) throw new Error((parsed as { error?: string })?.error ?? `HTTP ${res.status}`);
  return ((parsed as { reports?: DailyReportMeta[] }).reports ?? []).slice();
}

/** 1 日ぶんのレポート。未生成(404)は例外にせず null を返す。 */
export async function fetchDaily(date: string): Promise<DailyReport | null> {
  if (cache.has(date)) return cache.get(date) ?? null;
  const running = inflight.get(date);
  if (running) return running;

  const p = (async () => {
    const res = await fetch(`${BASE}/daily/${date}`);
    if (res.status === 404) {
      cache.set(date, null);
      return null;
    }
    const parsed = await json(res);
    if (!res.ok) throw new Error((parsed as { error?: string })?.error ?? `HTTP ${res.status}`);
    const report = parsed as DailyReport;
    cache.set(date, report);
    return report;
  })().finally(() => inflight.delete(date));

  inflight.set(date, p);
  return p;
}

// ---- 45: 週次 / 月次 ----
//
// 日次と同じ扱い(一覧は都度取り、本体はキャッシュする)。本体は日次より小さい(数十 KB 未満)が、
// カレンダーで週を行き来するたびに取り直す必要は無いので同じ方針にする。

/** 生成済みの週次 / 月次レポートの一覧(新しい順)。 */
export async function fetchPeriodList(periodType: PeriodType, limit = 200): Promise<PeriodReportMeta[]> {
  const res = await fetch(`${BASE}/${periodType}?limit=${limit}`);
  const parsed = await json(res);
  if (!res.ok) throw new Error((parsed as { error?: string })?.error ?? `HTTP ${res.status}`);
  return ((parsed as { reports?: PeriodReportMeta[] }).reports ?? []).slice();
}

/** 1 期間ぶんのレポート。未生成(404)は例外にせず null を返す。 */
export async function fetchPeriod(periodType: PeriodType, key: string): Promise<PeriodReport | null> {
  const cacheKey = `${periodType}:${key}`;
  if (periodCache.has(cacheKey)) return periodCache.get(cacheKey) ?? null;
  const running = periodInflight.get(cacheKey);
  if (running) return running;

  const p = (async () => {
    const res = await fetch(`${BASE}/${periodType}/${key}`);
    if (res.status === 404) {
      periodCache.set(cacheKey, null);
      return null;
    }
    const parsed = await json(res);
    if (!res.ok) throw new Error((parsed as { error?: string })?.error ?? `HTTP ${res.status}`);
    const report = parsed as PeriodReport;
    periodCache.set(cacheKey, report);
    return report;
  })().finally(() => periodInflight.delete(cacheKey));

  periodInflight.set(cacheKey, p);
  return p;
}

/**
 * 44: 重大な問題の自動事前調査(名寄せキー単位の既調査履歴)。
 *
 * レポート本体と違ってキャッシュしない。実行中 → 完了の状態変化を見るために
 * タブが開いている間だけ短い間隔で取り直す(応答は数 KB)。
 */
export async function fetchAutoInvestigations(): Promise<AutoInvestigationsResponse> {
  const res = await fetch(`${BASE}/auto-investigations`);
  const parsed = await json(res);
  if (!res.ok) throw new Error((parsed as { error?: string })?.error ?? `HTTP ${res.status}`);
  const body = parsed as Partial<AutoInvestigationsResponse>;
  return {
    enabled: body.enabled ?? false,
    maxPerReport: body.maxPerReport ?? 0,
    maxAgeDays: body.maxAgeDays ?? 0,
    total: body.total ?? 0,
    running: body.running ?? 0,
    done: body.done ?? 0,
    error: body.error ?? 0,
    entries: body.entries ?? {},
  };
}

/**
 * 複数日ぶんをまとめて取得する(トレンドグラフ用)。
 * 取れなかった日・未生成の日は落とし、日付の昇順で返す。
 */
export async function fetchDailyMany(dates: string[]): Promise<DailyReport[]> {
  const got = await Promise.all(
    dates.map((d) =>
      fetchDaily(d).catch(() => null),
    ),
  );
  return got.filter((r): r is DailyReport => r !== null).sort((a, b) => a.date.localeCompare(b.date));
}
