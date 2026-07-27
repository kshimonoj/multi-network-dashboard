// Webhook ログ(17 Task 4 / Task 5)— 重大アラートの自動事前調査と、関連情報の先読み。
//
// Task 4(自動事前調査)と Task 5(関連情報の先読み)は「発火条件が同じ」ので、
// タスクの指示どおり 1 つのトリガー処理にまとめてある(trigger())。
//
// ---- 発火条件(コスト・レート制限の両方を絞る) ----
//  1. 重要度が最上位(3 ソースとも severity が "Critical")の行だけを対象にする。
//     Major / warn は対象外。Task 5 のレート配慮(Central 4 req/sec)もこれで満たす。
//  2. 同じアラート(alertKey)に対しては一生に 1 度だけ。実行済みキーは state.json に永続化し、
//     コンテナを作り直しても再実行しない(Task 4-3)。
//  3. 受信からの経過時間が WEBHOOK_FEED_AUTO_MAX_AGE_MS(既定 60 分)を超えた行は発火しない。
//     ポーリングが止まっていた間に溜まった古いアラートで、まとめて課金されるのを防ぐ。
//  4. 1 巡あたり WEBHOOK_FEED_AUTO_MAX_PER_CYCLE 件(既定 3)まで。溢れた行は
//     「未実行」のまま残り、次巡以降で条件 3 を満たしていれば拾われる。
//  5. 初回バックフィル(state.json がまだ無い = シートの全履歴を初めて読む回)では
//     一切発火しない。過去数百行ぶんの Insight Agent が一気に走るのを防ぐため、
//     その時点の重大アラートは「発火済み」として記録だけしておく。
//  6. Insight Agent は同時に 1 本だけ走らせる(直列キュー)。
//
// Insight Agent の実行結果は query-history.jsonl に source="auto" で残るので、
// ネットワーク調査タブのタイムラインにも「自動調査」タグ付きで現れる(Task 4-5)。

import { getCached } from "../global-overview/poller.js";
import { getSiteDetail, SiteDetailError } from "../global-overview/site-detail.js";
import { runAutoInvestigation } from "../network-investigation/api.js";
import { SOURCE_LABEL, SOURCE_PLATFORM, isTopSeverity } from "./mapping.js";
import type {
  AutoInvestigation,
  DetailPlatform,
  SitePrefetch,
  WebhookFeedItem,
} from "./feed-types.js";

export const AUTO_ENABLED = String(process.env.WEBHOOK_FEED_AUTO_ENABLED ?? "1") !== "0";
export const AUTO_MAX_PER_CYCLE = Math.max(
  0,
  Number(process.env.WEBHOOK_FEED_AUTO_MAX_PER_CYCLE ?? 3),
);
export const AUTO_MAX_AGE_MS = Math.max(
  60_000,
  Number(process.env.WEBHOOK_FEED_AUTO_MAX_AGE_MS ?? 3_600_000),
);

/** 自動調査の回答要約(行を開いたときに出す)の最大文字数。 */
const SUMMARY_MAX = 600;

// ---- サイトの解決 ----

/**
 * 17 桁の New Central サイト ID は、Apps Script がシートへ数値として書き込む時点で
 * IEEE754 の精度を超えて丸まる(実測: ...432 が ...430 になる)。
 * 完全一致で引けなかったときだけ、相対誤差 1e-12 以内を同一とみなして救済する。
 * 桁数の違うサイト ID 同士がこの閾値で衝突することはない。
 */
function siteIdMatches(a: string, b: string): boolean {
  if (a === b) return true;
  if (!/^\d{15,}$/.test(a) || !/^\d{15,}$/.test(b)) return false;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb) || na === 0) return false;
  return Math.abs(na - nb) / Math.abs(na) < 1e-12;
}

export interface ResolvedSite {
  platform: DetailPlatform;
  siteId: string;
  siteName: string;
}

/**
 * 行のサイト ID を Global Overview のスナップショットと突き合わせ、
 * プラットフォーム・正式なサイト名・(丸め前の)サイト ID を得る。
 * スナップショット未生成・Classic Central(サイト ID を持たない)では null。
 */
export function resolveSite(item: WebhookFeedItem): ResolvedSite | null {
  const platform = SOURCE_PLATFORM[item.source];
  if (!platform || !item.siteId) return null;
  const sites = getCached().snapshot?.sites ?? [];
  for (const s of sites) {
    if (s.platform !== platform || !s.siteId) continue;
    if (siteIdMatches(item.siteId, s.siteId)) {
      return { platform, siteId: s.siteId, siteName: s.siteName };
    }
  }
  return null;
}

/** 取り込んだ行にサイト名・プラットフォームを埋める(先読みも自動調査もしない軽い処理)。 */
export function annotateSite(item: WebhookFeedItem): void {
  const hit = resolveSite(item);
  if (hit) {
    item.platform = hit.platform;
    item.siteName = hit.siteName;
    return;
  }
  // 解決できない場合でも Mist の Raw JSON に site_name があればそれを使う(表示用)。
  item.platform = null;
}

// ---- Task 5: 関連情報の先読み ----

async function prefetchSiteContext(site: ResolvedSite): Promise<SitePrefetch> {
  try {
    const d = await getSiteDetail(site.platform, site.siteId, site.siteName);
    const devices = d.devices.items ?? [];
    const alerts = d.alerts.items ?? [];
    return {
      status: "ok",
      platform: site.platform,
      siteId: site.siteId,
      siteName: site.siteName,
      fetchedAt: d.fetchedAt,
      healthScore: d.health.score,
      healthMetrics: (d.health.metrics ?? []).slice(0, 8),
      devicesUp: devices.length ? devices.filter((x) => x.up).length : null,
      devicesTotal: devices.length || null,
      clients: d.clients.status === "ok" ? d.clients.items.length : null,
      openAlerts: d.alerts.status === "ok" ? alerts.length : null,
      topAlerts: alerts.slice(0, 5).map((a) => ({
        severity: a.severity,
        summary: a.summary,
        createdAt: a.createdAt,
      })),
      alertsNote: d.alerts.note ?? null,
      error: null,
    };
  } catch (err) {
    const msg =
      err instanceof SiteDetailError ? err.message : err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      platform: site.platform,
      siteId: site.siteId,
      siteName: site.siteName,
      fetchedAt: null,
      healthScore: null,
      healthMetrics: [],
      devicesUp: null,
      devicesTotal: null,
      clients: null,
      openAlerts: null,
      topAlerts: [],
      alertsNote: null,
      error: msg,
    };
  }
}

// ---- Task 4: 自動事前調査 ----

/** Insight Agent に渡す日本語クエリ。view/investigate.ts の手動版と同じ体裁に揃える。 */
export function buildAutoQuery(item: WebhookFeedItem): string {
  const where = item.siteName
    ? `${item.siteName}(${SOURCE_LABEL[item.source]})`
    : `${SOURCE_LABEL[item.source]}`;
  const tags = [item.severityRaw, item.category, item.type]
    .map((v) => (v ?? "").trim())
    .filter(Boolean);
  const uniqueTags = [...new Set(tags)];
  const tag = uniqueTags.length ? `[${uniqueTags.join(" / ")}] ` : "";
  const device = item.deviceLabel ? `対象デバイス: ${item.deviceLabel}。` : "";
  const when = item.eventAt ?? item.receivedAt;
  const whenLabel = when ? new Date(when).toLocaleString("ja-JP", { hour12: false }) : "時刻不明";
  return (
    `${where}で重大アラートが発生しました。原因の見立てと影響範囲、確認すべき点を調査してください: ` +
    `${tag}${item.message}(${whenLabel})。${device}`
  );
}

// Insight Agent は 1 本ずつ直列に流す(同時に何本も claude CLI を起こさない)。
let queue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch((err) => {
    console.error("[webhook-feed] 自動調査キューでエラー:", err);
  });
}

// ---- トリガー(Task 4 と Task 5 の共通入口) ----

export interface TriggerDeps {
  /** 実行済み(または初回バックフィルで抑止済み)の alertKey か */
  isDone: (alertKey: string) => boolean;
  /**
   * alertKey を実行済みとして記録し、state.json に永続化する。
   * auto を渡すと調査結果そのものも state.json に残るので、フィード(feed.json)を
   * 作り直しても結果が失われず、同じアラートの別の行(Active / Cleared)にも再表示される。
   */
  markDone: (
    alertKey: string,
    info: {
      runId: string | null;
      reason: string;
      auto?: AutoInvestigation;
      siteContext?: SitePrefetch;
    },
  ) => void;
  /** 行の内容が変わったことをポーラーへ知らせる(同一アラートの他の行へ反映 + 再永続化) */
  onItemUpdated: (item: WebhookFeedItem) => void;
}

export interface TriggerResult {
  /** 自動調査を発火した件数 */
  fired: number;
  /** 発火条件は満たすが 1 巡の上限で見送った件数 */
  deferred: number;
  /** 初回バックフィルのため抑止した件数 */
  suppressed: number;
}

/**
 * 新規に取り込んだ行に対して、自動事前調査(Task 4)と関連情報の先読み(Task 5)を仕掛ける。
 * 実際の実行はバックグラウンド(直列キュー)なので、この関数はすぐ返る。
 *
 * @param initialBackfill 初回バックフィル(state.json が無い状態での全件読み込み)なら true
 */
export function trigger(
  newItems: WebhookFeedItem[],
  deps: TriggerDeps,
  initialBackfill: boolean,
): TriggerResult {
  const result: TriggerResult = { fired: 0, deferred: 0, suppressed: 0 };
  if (!AUTO_ENABLED) return result;

  const now = Date.now();
  // 新しい行から順に見る(古い行が上限枠を食い潰さないように)。
  const candidates = [...newItems]
    .filter((i) => isTopSeverity(i))
    .sort((a, b) => (a.receivedAt ?? "") < (b.receivedAt ?? "") ? 1 : -1);

  for (const item of candidates) {
    if (deps.isDone(item.alertKey)) continue;

    if (initialBackfill) {
      // 過去ログを初めて読み込んだ回。発火はせず「発火済み」として記録だけしておく。
      deps.markDone(item.alertKey, { runId: null, reason: "initial-backfill" });
      result.suppressed += 1;
      continue;
    }

    const stamp = item.receivedAt ?? item.eventAt;
    const ageMs = stamp ? now - new Date(stamp).getTime() : Infinity;
    if (!Number.isFinite(ageMs) || ageMs > AUTO_MAX_AGE_MS) {
      deps.markDone(item.alertKey, { runId: null, reason: "too-old" });
      continue;
    }

    if (result.fired >= AUTO_MAX_PER_CYCLE) {
      result.deferred += 1;
      continue;
    }

    // ここで先に「実行済み」を立てる。実行中に次のポーリングが走っても二重に起こさないため。
    deps.markDone(item.alertKey, { runId: null, reason: "auto" });
    result.fired += 1;
    scheduleOne(item, deps);
  }

  if (result.deferred > 0) {
    console.log(
      `[webhook-feed] 自動調査: 1 巡の上限(${AUTO_MAX_PER_CYCLE} 件)に達したため ${result.deferred} 件は次巡に見送りました`,
    );
  }
  return result;
}

function scheduleOne(item: WebhookFeedItem, deps: TriggerDeps): void {
  const startedAt = new Date().toISOString();
  const query = buildAutoQuery(item);
  const auto: AutoInvestigation = {
    status: "running",
    runId: null,
    sessionId: null,
    startedAt,
    finishedAt: null,
    query,
    summary: "",
    answer: "",
    error: null,
  };
  item.auto = auto;

  // Task 5: サイトが特定できるなら関連情報も先読みする(同じトリガー)。
  const site = resolveSite(item);
  if (site) {
    item.platform = site.platform;
    item.siteName = site.siteName;
  } else {
    item.siteContext = {
      status: "unavailable",
      platform: null,
      siteId: item.siteId,
      siteName: item.siteName,
      fetchedAt: null,
      healthScore: null,
      healthMetrics: [],
      devicesUp: null,
      devicesTotal: null,
      clients: null,
      openAlerts: null,
      topAlerts: [],
      alertsNote: null,
      error:
        item.source === "classic-central"
          ? "Classic Central の Webhook はサイト ID を含まないため、サイト情報の先読み対象外です"
          : "サイト ID を Global Overview のスナップショットで解決できませんでした",
    };
  }
  deps.onItemUpdated(item);

  enqueue(async () => {
    // 先読み(1 サイトあたり数本の HTTP。site-detail 側に 30 秒キャッシュ + in-flight 共有がある)。
    if (site) {
      item.siteContext = await prefetchSiteContext(site);
      deps.markDone(item.alertKey, {
        runId: auto.runId,
        reason: "auto",
        siteContext: item.siteContext,
      });
      deps.onItemUpdated(item);
    }

    console.log(
      `[webhook-feed] 自動事前調査を開始: ${SOURCE_LABEL[item.source]} / ${
        item.siteName ?? item.siteId ?? "サイト不明"
      } / ${item.message.slice(0, 60)}`,
    );
    try {
      const { record } = await runAutoInvestigation(query, item.siteName ?? null);
      auto.runId = record.id;
      auto.sessionId = record.sessionId ?? record.id;
      auto.finishedAt = new Date().toISOString();
      if (record.isError) {
        auto.status = "error";
        auto.error = record.reason ?? "Insight Agent の実行に失敗しました";
      } else {
        auto.status = "done";
        auto.answer = record.answer ?? "";
        auto.summary = (record.answer ?? "").trim().slice(0, SUMMARY_MAX);
      }
      // 結果ごと state.json に残す(feed.json を作り直しても消えない)。
      deps.markDone(item.alertKey, {
        runId: record.id,
        reason: "auto",
        auto,
        ...(item.siteContext ? { siteContext: item.siteContext } : {}),
      });
    } catch (err) {
      auto.status = "error";
      auto.finishedAt = new Date().toISOString();
      auto.error = err instanceof Error ? err.message : String(err);
      deps.markDone(item.alertKey, { runId: auto.runId, reason: "auto", auto });
    }
    deps.onItemUpdated(item);
    console.log(
      `[webhook-feed] 自動事前調査が完了: status=${auto.status} runId=${auto.runId ?? "-"}`,
    );
  });
}
