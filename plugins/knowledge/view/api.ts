// ナレッジタブ View(46)— /api/knowledge/* への fetch ラッパ。
//
// エントリは 1 件が数 KB・全体でも数十〜数百件なので、レポートのような
// モジュールスコープのキャッシュは持たない(操作のたびに取り直す方が状態がずれない)。

import type {
  EntryPatch,
  KnowledgeCounts,
  KnowledgeEntry,
  KnowledgeStatusResponse,
  TagCount,
} from "./types";

const BASE = "/api/knowledge";

async function json(res: Response): Promise<unknown> {
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function request(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, init);
  const parsed = await json(res);
  if (!res.ok) throw new Error((parsed as { error?: string })?.error ?? `HTTP ${res.status}`);
  return parsed;
}

function post(path: string, body?: unknown): Promise<any> {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

export async function fetchStatus(): Promise<KnowledgeStatusResponse> {
  return (await request("/status")) as KnowledgeStatusResponse;
}

/** 未承認件数だけが欲しいとき(タブのバッジ)。応答は数 KB。 */
export async function fetchPendingCount(): Promise<number> {
  const s = await fetchStatus();
  return s.counts.pending;
}

export interface EntriesQuery {
  status?: string;
  q?: string;
  tag?: string;
  scope?: string;
}

export async function fetchEntries(
  query: EntriesQuery = {},
): Promise<{ entries: KnowledgeEntry[]; counts: KnowledgeCounts }> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v) p.set(k, v);
  }
  const qs = p.toString();
  return (await request(`/entries${qs ? `?${qs}` : ""}`)) as {
    entries: KnowledgeEntry[];
    counts: KnowledgeCounts;
  };
}

export async function fetchTags(): Promise<TagCount[]> {
  return ((await request("/tags")) as { tags?: TagCount[] }).tags ?? [];
}

/** 承認。patch を渡すと「編集して承認」になる。 */
export async function approveEntry(id: string, patch?: EntryPatch): Promise<KnowledgeEntry> {
  return ((await post(`/entries/${id}/approve`, patch ?? {})) as { entry: KnowledgeEntry }).entry;
}

export async function approveMany(ids: string[]): Promise<{ approved: string[]; skipped: string[] }> {
  return (await post("/approve", { ids })) as { approved: string[]; skipped: string[] };
}

export async function rejectEntry(id: string): Promise<KnowledgeEntry> {
  return ((await post(`/entries/${id}/reject`)) as { entry: KnowledgeEntry }).entry;
}

export async function mergeEntry(
  id: string,
  targetId: string,
  patch?: EntryPatch,
): Promise<{ entry: KnowledgeEntry; target: KnowledgeEntry }> {
  return (await post(`/entries/${id}/merge`, { targetId, patch: patch ?? {} })) as {
    entry: KnowledgeEntry;
    target: KnowledgeEntry;
  };
}

/** 承認済みエントリの編集(承認後の手直し)。 */
export async function updateEntry(id: string, patch: EntryPatch): Promise<KnowledgeEntry> {
  const parsed = (await request(`/entries/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })) as { entry: KnowledgeEntry };
  return parsed.entry;
}

// 設定変更(PUT /settings)と過去の調査からの抽出(POST /extract)はサーバ側に口があるが、
// 画面からは触らない(46 の指示には無い運用操作なので、UI を増やさず API に留めてある)。
