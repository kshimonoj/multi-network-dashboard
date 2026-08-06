// タグ付き Client / Device View — 型。
//
// 他プラグイン(best-practice 等)の view/types.ts は「サーバ側の型が node:fs 等を
// import しているのでバンドルに巻き込まれる」という理由でミラーを持っているが、
// plugins/tagged-targets/types.ts は **import を 1 つも持たない純粋な型定義**
// (実体は TAG_COLORS 配列のみ)なので、そのまま再エクスポートして写しの二重管理を避ける。
//
// この前提を壊さないこと: types.ts に node 依存の import を足さない。

export * from "../types";

// ---- API レスポンスの包み(サーバの router が返す形)----

import type { ClientSummary, DeviceSummary, ListEnvelope, TagDef, TagStoreFile, TargetAssignment } from "../types";

export interface StatusResponse {
  configured: { central: boolean; mist: boolean };
  counts: { tags: number; clients: number; devices: number };
  settings: { listTtlMs: number; detailTtlMs: number; maxMistSites: number };
  updatedAt: string;
}

export interface TagMutationResponse {
  tag: TagDef;
  store: TagStoreFile;
}

export interface TargetMutationResponse {
  assignment: TargetAssignment;
  store: TagStoreFile;
}

export interface SearchResponse {
  hits: import("../types").SearchHit[];
  errors: Array<{ platform: string; error: string }>;
  manual: import("../types").SearchHit | null;
}

export type ClientListResponse = ListEnvelope<ClientSummary>;
export type DeviceListResponse = ListEnvelope<DeviceSummary>;
