// タグ付き Client / Device View — /api/tagged-targets/* への fetch ラッパ。

import type {
  ClientDetail,
  ClientListResponse,
  DetailEnvelope,
  DeviceDetail,
  DeviceListResponse,
  SearchResponse,
  StatusResponse,
  TagDef,
  TagMutationResponse,
  TagStoreFile,
  TargetKind,
  TargetMutationResponse,
} from "./types";

const BASE = "/api/tagged-targets";

/** サーバは機械可読な `code` を返す(文章は画面側の辞書で作る)。code を Error に載せて運ぶ。 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ApiError(`HTTP ${res.status}: ${body.slice(0, 300)}`, null);
  }
  if (!res.ok) {
    const p = parsed as { error?: string; code?: string };
    throw new ApiError(p?.error ?? `HTTP ${res.status}`, p?.code ?? null);
  }
  return parsed as T;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function fetchStatus(): Promise<StatusResponse> {
  return json<StatusResponse>(await fetch(`${BASE}/status`));
}

export async function fetchTagStore(): Promise<TagStoreFile> {
  return json<TagStoreFile>(await fetch(`${BASE}/tags`));
}

export async function createTag(input: {
  name: string;
  color: string;
  description?: string | null;
}): Promise<TagMutationResponse> {
  return json<TagMutationResponse>(await fetch(`${BASE}/tags`, jsonInit("POST", input)));
}

export async function updateTag(
  id: string,
  patch: { name?: string; color?: string; description?: string | null },
): Promise<TagMutationResponse> {
  return json<TagMutationResponse>(
    await fetch(`${BASE}/tags/${encodeURIComponent(id)}`, jsonInit("PUT", patch)),
  );
}

export async function fetchTagUsage(id: string): Promise<{ count: number }> {
  return json<{ count: number }>(await fetch(`${BASE}/tags/${encodeURIComponent(id)}/usage`));
}

export async function deleteTag(id: string): Promise<{ removedFrom: number; store: TagStoreFile }> {
  return json<{ removedFrom: number; store: TagStoreFile }>(
    await fetch(`${BASE}/tags/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
}

export async function upsertTarget(input: {
  kind: TargetKind;
  key: string;
  serial?: string | null;
  tagIds?: string[];
  label?: string | null;
  note?: string | null;
  lastSeen?: unknown;
  randomMac?: boolean;
}): Promise<TargetMutationResponse> {
  return json<TargetMutationResponse>(await fetch(`${BASE}/targets`, jsonInit("PUT", input)));
}

export async function deleteTarget(kind: TargetKind, key: string): Promise<{ store: TagStoreFile }> {
  return json<{ store: TagStoreFile }>(
    await fetch(`${BASE}/targets?kind=${kind}&key=${encodeURIComponent(key)}`, { method: "DELETE" }),
  );
}

export async function fetchClientList(force = false): Promise<ClientListResponse> {
  return json<ClientListResponse>(await fetch(`${BASE}/clients${force ? "?force=1" : ""}`));
}

export async function fetchDeviceList(force = false): Promise<DeviceListResponse> {
  return json<DeviceListResponse>(await fetch(`${BASE}/devices${force ? "?force=1" : ""}`));
}

export async function fetchClientDetail(
  key: string,
  force = false,
): Promise<DetailEnvelope<ClientDetail>> {
  return json<DetailEnvelope<ClientDetail>>(
    await fetch(`${BASE}/clients/${encodeURIComponent(key)}${force ? "?force=1" : ""}`),
  );
}

export async function fetchDeviceDetail(
  key: string,
  force = false,
): Promise<DetailEnvelope<DeviceDetail>> {
  return json<DetailEnvelope<DeviceDetail>>(
    await fetch(`${BASE}/devices/${encodeURIComponent(key)}${force ? "?force=1" : ""}`),
  );
}

export async function searchTargets(kind: TargetKind, q: string): Promise<SearchResponse> {
  return json<SearchResponse>(
    await fetch(`${BASE}/search?kind=${kind}&q=${encodeURIComponent(q)}`),
  );
}

export type { TagDef };
