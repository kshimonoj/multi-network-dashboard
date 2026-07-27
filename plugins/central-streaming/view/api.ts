// Streaming(Central)View — /api/central-streaming/* への fetch ラッパ。
//
// WebSocket を張っているのは **サーバ側**。ブラウザはサーバのメモリに溜まったものを
// 一定間隔で読むだけで、Central を直接叩くことはない。

import type { StreamEndpointDef, StreamEnvelope, StreamSettings, StreamStatus } from "./types";

const BASE = "/api/central-streaming";

async function json<T>(res: Response): Promise<T> {
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error((parsed as { error?: string })?.error ?? `HTTP ${res.status}`);
  return parsed as T;
}

export async function fetchStreamSnapshot(limit?: number): Promise<StreamEnvelope> {
  const q = limit ? `?limit=${limit}` : "";
  return json<StreamEnvelope>(await fetch(`${BASE}/snapshot${q}`));
}

export async function fetchStreamCatalog(): Promise<{ endpoints: StreamEndpointDef[] }> {
  return json<{ endpoints: StreamEndpointDef[] }>(await fetch(`${BASE}/catalog`));
}

export async function updateStreamSettings(
  patch: Partial<StreamSettings>,
): Promise<{ settings: StreamSettings; streams: StreamStatus[] }> {
  return json(
    await fetch(`${BASE}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

export async function purgeStreamEvents(): Promise<{ removed: number; stored: number }> {
  return json(await fetch(`${BASE}/purge`, { method: "POST" }));
}

export async function clearStreamEvents(): Promise<{ removed: number; stored: number }> {
  return json(await fetch(`${BASE}/clear`, { method: "POST" }));
}

/** 動作確認用(Task 5-4)。強制切断して再接続ロジックを試す。 */
export async function forceStreamDisconnect(stream: string): Promise<{ ok: boolean; note: string }> {
  return json(
    await fetch(`${BASE}/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream }),
    }),
  );
}
