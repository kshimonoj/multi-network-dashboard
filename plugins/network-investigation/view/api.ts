// サーバーAPI(/api/network-investigation/*)への fetch ラッパ。
// View はキャッシュ・楽観的更新を持たない(CLAUDE.md: filesystem as database)。
// 進捗・結果・履歴更新は SSE(/events)で通知を受け、今表示中のデータだけ refetch する。

import type {
  HistoryRecord,
  NIEvent,
  ScheduleConfig,
  ScheduledQuery,
  SiteEntry,
  SiteStatusFile,
} from "./types";

const BASE = "/api/network-investigation";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchSiteMap(): Promise<SiteEntry[]> {
  const data = await json<{ entries: SiteEntry[] }>(await fetch(`${BASE}/site-map`));
  return data.entries ?? [];
}

export async function fetchHistory(): Promise<HistoryRecord[]> {
  const data = await json<{ history: HistoryRecord[] }>(await fetch(`${BASE}/history`));
  return data.history ?? [];
}

// 1セッション(「続けて調べる」で繋がった一連)を古い順に取得する(04 Task 2)。
// sessionId には sessionKey()(新: sessionId / 旧履歴: レコードの id)を渡す。
export async function fetchSession(sessionId: string): Promise<HistoryRecord[]> {
  const data = await json<{ sessionId: string; records: HistoryRecord[] }>(
    await fetch(`${BASE}/history/session/${encodeURIComponent(sessionId)}`),
  );
  return data.records ?? [];
}

export async function fetchSiteStatus(): Promise<SiteStatusFile> {
  return json<SiteStatusFile>(await fetch(`${BASE}/site-status`));
}

// ---- 定期実行の設定(Task 5) ----

export async function fetchScheduledQueries(): Promise<ScheduledQuery[]> {
  const data = await json<{ queries: ScheduledQuery[] }>(await fetch(`${BASE}/scheduled-queries`));
  return data.queries ?? [];
}

export async function addScheduledQuery(input: {
  query: string;
  site?: string | null;
  enabled?: boolean;
  model?: string | null;
}): Promise<ScheduledQuery[]> {
  const data = await json<{ queries: ScheduledQuery[] }>(
    await fetch(`${BASE}/scheduled-queries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return data.queries ?? [];
}

export async function updateScheduledQuery(
  id: string,
  patch: Partial<Pick<ScheduledQuery, "query" | "site" | "enabled" | "model">>,
): Promise<ScheduledQuery[]> {
  const data = await json<{ queries: ScheduledQuery[] }>(
    await fetch(`${BASE}/scheduled-queries/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
  return data.queries ?? [];
}

export async function deleteScheduledQuery(id: string): Promise<ScheduledQuery[]> {
  const data = await json<{ queries: ScheduledQuery[] }>(
    await fetch(`${BASE}/scheduled-queries/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
  return data.queries ?? [];
}

export async function fetchScheduleConfig(): Promise<ScheduleConfig> {
  return json<ScheduleConfig>(await fetch(`${BASE}/schedule-config`));
}

// サーバーが PUT /schedule-config で返すスケジューラ反映結果。
// 移植元(Corstack)では launchd plist の生成結果だったため、レスポンスのキー名は `launchd` のまま。
// 本アプリの実体は node-cron のジョブ登録結果(plistPath → expression)。
export interface LaunchdSyncResult {
  ok: boolean;
  expression: string | null; // 実際に張った cron 式(無効時 null)
  loaded: boolean;
  detail: string;
}

export async function updateScheduleConfig(
  cfg: ScheduleConfig,
): Promise<{ config: ScheduleConfig; launchd: LaunchdSyncResult }> {
  return json<{ config: ScheduleConfig; launchd: LaunchdSyncResult }>(
    await fetch(`${BASE}/schedule-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    }),
  );
}

// クエリ実行を開始。即 { runId, sessionId } が返り、進捗・結果は SSE(mcp_call / answer)で流れてくる。
// sessionId を渡すと「続けて調べる」= 同じセッションのターンとして履歴に残る(04 Task 2)。
// 省略するとサーバーが新しいセッションを採番する。
export async function runQuery(
  query: string,
  site: string | null,
  model?: string,
  sessionId?: string,
): Promise<{ runId: string; sessionId: string }> {
  return json<{ runId: string; sessionId: string }>(
    await fetch(`${BASE}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, site, model: model || undefined, sessionId: sessionId || undefined }),
    }),
  );
}

// サイト状態キャッシュの再取得(地図ピンの health 表示を更新)。時間がかかる(claude 起動)。
export async function refreshSiteStatus(): Promise<SiteStatusFile> {
  return json<SiteStatusFile>(await fetch(`${BASE}/site-status/refresh`, { method: "POST" }));
}

// 対応表の再生成。
export async function refreshSiteMap(): Promise<unknown> {
  return json(await fetch(`${BASE}/site-map/refresh`, { method: "POST" }));
}

// SSE 購読。keep-alive コメントは JSON.parse に失敗して無視される。
export function subscribeEvents(onEvent: (e: NIEvent) => void): () => void {
  const es = new EventSource(`${BASE}/events`);
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data) as NIEvent);
    } catch {
      /* keep-alive コメント等は無視 */
    }
  };
  return () => es.close();
}
