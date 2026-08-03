// 日次レポート(41 Task 1)— Global Overview の当日サンプリング。
//
// ---- なぜサンプリングが要るか ----
// Global Overview は「最新スナップショット 1 枚」しか持たない(poller.ts が上書きする)。
// 日次レポートは「その日の平均 / ピーク」を出したいので、当日の値を時系列で残しておく必要がある。
// 過去に遡ることはできない(41 の前提)。このプラグインを入れた時点から蓄積が始まる。
//
// ---- 追加の API 負荷 ----
// Central の健全性スコア・接続端末数・デバイス台数・アラート件数は、既存のポーリングが
// 5 分ごとに作っているスナップショットから **そのまま読むだけ**(HTTP 追加ゼロ)。
// Mist の SLE 総合スコアだけは org 一括の insights/sites-sle を叩く必要があるため、
// 粗い間隔(既定 30 分 = 1 日 48 本)で取得し、次の取得までは直近値をサンプルに載せる。
//
// ---- 保存 ----
// data/reports/samples/YYYY-MM-DD.jsonl に 1 行 1 サンプルで追記する(追記専用・クラッシュ耐性)。
// キーは短縮形にしてある(22 サイト × 288 サンプル/日を毎日書くため)。
// サンプルはレポートを作り直すための素材なので、保持は settings.sampleRetentionDays(既定 14 日)。

import { getCached, getClients } from "../global-overview/poller.js";
import { appendSample, getSettings } from "./store.js";
import { dateKeyOf } from "./time.js";

/** サンプル 1 行(ファイルに書く形。キーは短縮形)。 */
export interface OverviewSampleSite {
  /** siteName */
  n: string;
  /** platform */
  p: "central" | "mist";
  /** siteId */
  i: string | null;
  /** Central healthScore(0-100)。無ければ null */
  h: number | null;
  /** Mist SLE 総合(0-100)。無ければ null */
  s: number | null;
  /** Mist SLE 指標別(label→値)。SLE を取得できた回だけ載る */
  sm?: Record<string, number | null>;
  /** clients */
  c: number;
  /** alerts */
  a: number;
  /** criticalAlerts */
  ca: number;
  /** deviceTotal / deviceUp / deviceDown */
  dt: number;
  du: number;
  dd: number;
}

export interface OverviewSample {
  /** サンプルを書いた時刻(ISO) */
  t: string;
  /** 元スナップショットの生成時刻(ISO)。同じ値は 2 度書かない */
  g: string;
  totals: {
    sites: number;
    devices: number;
    devicesUp: number;
    devicesDown: number;
    clients: number;
    alerts: number;
  };
  sites: OverviewSampleSite[];
  /** この行に Mist SLE が載っているか(載っていない行は SLE の母数に数えない) */
  sle: boolean;
}

let timer: NodeJS.Timeout | null = null;
let lastGeneratedAt: string | null = null;
let lastSampleAt: string | null = null;
let sampleCount = 0;
let lastError: string | null = null;

// Mist SLE の直近取得結果(siteId → スコア)。sleFetchedAt から sleIntervalMs 経つと取り直す。
let sleBySiteId: Record<string, { score: number | null; metrics: Array<{ label: string; value: number | null }> }> = {};
let sleFetchedAt = 0;
let sleError: string | null = null;
let sleInFlight: Promise<void> | null = null;

async function refreshSleIfDue(): Promise<boolean> {
  const { sleIntervalMs } = getSettings();
  if (Date.now() - sleFetchedAt < sleIntervalMs) return Object.keys(sleBySiteId).length > 0;
  if (sleInFlight) {
    await sleInFlight.catch(() => undefined);
    return Object.keys(sleBySiteId).length > 0;
  }
  const { mist } = getClients();
  if (!mist) {
    sleError = "Mist の認証情報が未設定です";
    return false;
  }
  sleInFlight = (async () => {
    try {
      sleBySiteId = await mist.fetchOrgSiteSle();
      sleFetchedAt = Date.now();
      sleError = null;
    } catch (err) {
      sleError = err instanceof Error ? err.message : String(err);
      // 失敗しても次の間隔まで待つ(連続で叩き直さない)。
      sleFetchedAt = Date.now();
      console.warn(`[reports] Mist SLE の取得に失敗: ${sleError}`);
    }
  })();
  try {
    await sleInFlight;
  } finally {
    sleInFlight = null;
  }
  return Object.keys(sleBySiteId).length > 0;
}

/**
 * 現在のスナップショットを 1 行サンプルとして記録する。
 * スナップショットが前回と同じ(= まだ次のポーリングが走っていない)なら何もしない。
 */
export async function sampleOnce(force = false): Promise<OverviewSample | null> {
  const env = getCached();
  const snap = env.snapshot;
  if (!snap) return null;
  if (!force && snap.generatedAt === lastGeneratedAt) return null;

  const hasSle = await refreshSleIfDue();

  const now = new Date();
  const sample: OverviewSample = {
    t: now.toISOString(),
    g: snap.generatedAt,
    totals: { ...snap.totals },
    sites: snap.sites.map((s) => {
      const sle = s.platform === "mist" && s.siteId ? sleBySiteId[s.siteId] : undefined;
      const row: OverviewSampleSite = {
        n: s.siteName,
        p: s.platform,
        i: s.siteId,
        h: s.healthScore,
        s: sle?.score ?? null,
        c: s.clients,
        a: s.alerts,
        ca: s.criticalAlerts,
        dt: s.deviceTotal,
        du: s.deviceUp,
        dd: s.deviceDown,
      };
      if (sle?.metrics?.length) {
        row.sm = Object.fromEntries(sle.metrics.map((m) => [m.label, m.value]));
      }
      return row;
    }),
    sle: hasSle,
  };

  try {
    await appendSample(dateKeyOf(now), sample);
    lastGeneratedAt = snap.generatedAt;
    lastSampleAt = sample.t;
    sampleCount += 1;
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[reports] サンプルの追記に失敗: ${lastError}`);
    return null;
  }
  return sample;
}

/**
 * サンプリングを開始する。多重起動は無視する。
 * 間隔は Global Overview のポーリング(既定 5 分)に合わせてあるが、
 * 「スナップショットの generatedAt が変わったときだけ書く」ので、
 * 多少ずれても同じ値を二重に記録することはない。
 */
export function startSampling(): void {
  if (timer) return;
  const { sampleIntervalMs } = getSettings();
  const tick = () => {
    sampleOnce().catch((err) => console.error("[reports] サンプリング失敗:", err));
  };
  tick();
  // 取りこぼしを減らすため、設定間隔の半分で回して「新しいスナップショットだけ」を拾う。
  timer = setInterval(tick, Math.max(30_000, Math.round(sampleIntervalMs / 2)));
  timer.unref?.();
  console.log(
    `[reports] Global Overview のサンプリング開始: ${Math.round(sampleIntervalMs / 2 / 1000)}s ごとに確認` +
      `(スナップショット更新時のみ記録 / Mist SLE は ${getSettings().sleIntervalMs / 60_000} 分ごと)`,
  );
}

/** サンプリング間隔の設定変更を反映する(タイマーを張り直す)。 */
export function restartSampling(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  startSampling();
}

export function samplerStatus(): {
  running: boolean;
  lastSampleAt: string | null;
  sampleCount: number;
  lastError: string | null;
  sle: { fetchedAt: string | null; sites: number; error: string | null };
} {
  return {
    running: timer !== null,
    lastSampleAt,
    sampleCount,
    lastError,
    sle: {
      fetchedAt: sleFetchedAt ? new Date(sleFetchedAt).toISOString() : null,
      sites: Object.keys(sleBySiteId).length,
      error: sleError,
    },
  };
}
