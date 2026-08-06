/**
 * タグ付き対象(59)— タグと実データの突合。
 *
 * 方針(57 §3-4 を 59 の実測で更新):
 *   57 は「Central にクライアントの org 横断一覧が無いので対象ごとに個別引き」としていたが、
 *   実測で `GET network-monitoring/v1/clients` は **site-id 無しで org 全体を返す**ことが分かった。
 *   そこで一覧はプラットフォームごとに**タグ件数によらない固定本数**で済む:
 *
 *     Client 一覧 … Central 1 本 + Mist 2 本(無線検索 / 有線検索)
 *                   + Mist の現況重ね(タグ対象が居るサイトぶんだけ。上限あり)
 *     Device 一覧 … Central 1 本 + Mist 1 本
 *
 *   詳細は開いた 1 件だけ叩く。
 *
 * 片方のプラットフォームが落ちても、もう片方の結果は返す(sources に理由を載せる)。
 * 「見つからない対象」は行を消さず、matches が空のまま残す(57 §3-5)。
 */

import {
  fetchAllCentralClients,
  fetchAllCentralDevices,
  fetchCentralClientDetail,
  fetchCentralDeviceDetail,
  isCentralConfigured,
} from "./central-fetch.js";
import {
  fetchMistClientDetail,
  fetchMistClientIndex,
  fetchMistDeviceDetail,
  fetchMistDeviceIndex,
  isMistConfigured,
  overlayMistLiveClients,
} from "./mist-fetch.js";
import { getSettings, getStore, touchLastSeen } from "./store.js";
import type {
  ClientDetail,
  ClientSummary,
  DetailEnvelope,
  DeviceDetail,
  DeviceSummary,
  LastSeenHint,
  ListEnvelope,
  Platform,
  TaggedRow,
} from "./types.js";

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Cache<T> {
  at: number;
  data: T;
}

let clientListCache: Cache<ListEnvelope<ClientSummary>> | null = null;
let deviceListCache: Cache<ListEnvelope<DeviceSummary>> | null = null;
let clientListInFlight: Promise<ListEnvelope<ClientSummary>> | null = null;
let deviceListInFlight: Promise<ListEnvelope<DeviceSummary>> | null = null;

/** 一覧・詳細のキャッシュを丸ごと捨てる(タグを足した直後に古い一覧を見せない)。 */
export function invalidateCaches(): void {
  clientListCache = null;
  deviceListCache = null;
  detailCache.clear();
}

function withCacheMeta<T extends { fetchedAt: string; cached: boolean; ageMs: number }>(
  entry: Cache<T>,
): T {
  return { ...entry.data, cached: true, ageMs: Date.now() - entry.at };
}

// ---- Client 一覧 ----

export async function getClientList(force = false): Promise<ListEnvelope<ClientSummary>> {
  const ttl = getSettings().listTtlMs;
  if (!force && clientListCache && Date.now() - clientListCache.at < ttl) {
    return withCacheMeta(clientListCache);
  }
  if (clientListInFlight) return clientListInFlight;

  clientListInFlight = (async () => {
    const assignments = getStore().assignments.filter((a) => a.kind === "client");
    const wanted = new Set(assignments.map((a) => a.key));
    const sources: ListEnvelope<ClientSummary>["sources"] = [];
    const truncated: string[] = [];
    const found: ClientSummary[] = [];

    // Central: org 全体を 1 本
    if (isCentralConfigured()) {
      try {
        const all = await fetchAllCentralClients();
        found.push(...all.filter((c) => wanted.has(c.mac)));
        sources.push({ platform: "central", ok: true, error: null, requests: 1 });
      } catch (err) {
        sources.push({ platform: "central", ok: false, error: msgOf(err), requests: 1 });
      }
    } else {
      sources.push({ platform: "central", ok: false, error: "not-configured", requests: 0 });
    }

    // Mist: org 横断検索 2 本 + 現況の重ね(対象が居るサイトぶん)
    if (isMistConfigured()) {
      try {
        const index = await fetchMistClientIndex();
        const hits = index.filter((c) => wanted.has(c.mac));
        const siteIds = [
          ...new Set(
            hits.filter((h) => h.connectionType === "wireless" && h.siteId).map((h) => h.siteId as string),
          ),
        ];
        const { truncatedSites } = await overlayMistLiveClients(hits, siteIds, getSettings().maxMistSites);
        if (truncatedSites > 0) truncated.push(`mist-sites:${truncatedSites}`);
        found.push(...hits);
        sources.push({ platform: "mist", ok: true, error: null, requests: 2 + Math.min(siteIds.length, getSettings().maxMistSites) });
      } catch (err) {
        sources.push({ platform: "mist", ok: false, error: msgOf(err), requests: 2 });
      }
    } else {
      sources.push({ platform: "mist", ok: false, error: "not-configured", requests: 0 });
    }

    const rows: Array<TaggedRow<ClientSummary>> = assignments.map((assignment) => ({
      assignment,
      matches: found.filter((f) => f.mac === assignment.key),
    }));

    await writeBackLastSeen(rows);

    return {
      fetchedAt: new Date().toISOString(),
      cached: false,
      ageMs: 0,
      rows,
      sources,
      truncated,
    } satisfies ListEnvelope<ClientSummary>;
  })();

  try {
    const data = await clientListInFlight;
    clientListCache = { at: Date.now(), data };
    return data;
  } finally {
    clientListInFlight = null;
  }
}

// ---- Device 一覧 ----

export async function getDeviceList(force = false): Promise<ListEnvelope<DeviceSummary>> {
  const ttl = getSettings().listTtlMs;
  if (!force && deviceListCache && Date.now() - deviceListCache.at < ttl) {
    return withCacheMeta(deviceListCache);
  }
  if (deviceListInFlight) return deviceListInFlight;

  deviceListInFlight = (async () => {
    const assignments = getStore().assignments.filter((a) => a.kind === "device");
    const wantedMacs = new Set(assignments.map((a) => a.key));
    const wantedSerials = new Set(
      assignments.map((a) => a.serial).filter((x): x is string => Boolean(x)),
    );
    const sources: ListEnvelope<DeviceSummary>["sources"] = [];
    const found: DeviceSummary[] = [];

    if (isCentralConfigured()) {
      try {
        const all = await fetchAllCentralDevices();
        // MAC でもシリアルでも当てる(片方しか登録されていない対象を拾うため)
        found.push(
          ...all.filter(
            (d) =>
              (d.macAddress && wantedMacs.has(d.macAddress)) || wantedSerials.has(d.serialNumber),
          ),
        );
        sources.push({ platform: "central", ok: true, error: null, requests: 1 });
      } catch (err) {
        sources.push({ platform: "central", ok: false, error: msgOf(err), requests: 1 });
      }
    } else {
      sources.push({ platform: "central", ok: false, error: "not-configured", requests: 0 });
    }

    if (isMistConfigured()) {
      try {
        const all = await fetchMistDeviceIndex();
        found.push(
          ...all.filter((d) => wantedMacs.has(d.mac) || (d.serial && wantedSerials.has(d.serial))),
        );
        sources.push({ platform: "mist", ok: true, error: null, requests: 1 });
      } catch (err) {
        sources.push({ platform: "mist", ok: false, error: msgOf(err), requests: 1 });
      }
    } else {
      sources.push({ platform: "mist", ok: false, error: "not-configured", requests: 0 });
    }

    const rows: Array<TaggedRow<DeviceSummary>> = assignments.map((assignment) => ({
      assignment,
      matches: found.filter((f) =>
        f.platform === "central"
          ? f.macAddress === assignment.key || f.serialNumber === assignment.serial
          : f.mac === assignment.key || (f.serial !== null && f.serial === assignment.serial),
      ),
    }));

    await writeBackLastSeen(rows);

    return {
      fetchedAt: new Date().toISOString(),
      cached: false,
      ageMs: 0,
      rows,
      sources,
      truncated: [],
    } satisfies ListEnvelope<DeviceSummary>;
  })();

  try {
    const data = await deviceListInFlight;
    deviceListCache = { at: Date.now(), data };
    return data;
  } finally {
    deviceListInFlight = null;
  }
}

/**
 * 突合で分かったサイトを lastSeen に書き戻す。
 * device は Central 側で解決できたシリアルも埋め戻す(57 §3-2)。
 */
async function writeBackLastSeen(rows: Array<TaggedRow<ClientSummary | DeviceSummary>>): Promise<void> {
  const updates: Array<{
    kind: "client" | "device";
    key: string;
    lastSeen: LastSeenHint;
    serial?: string | null;
  }> = [];
  const at = new Date().toISOString();
  for (const row of rows) {
    const m = row.matches[0];
    if (!m) continue;
    const platform: Platform = m.platform;
    const siteId = "siteId" in m ? m.siteId : null;
    const siteName = "siteName" in m ? m.siteName : null;
    updates.push({
      kind: row.assignment.kind,
      key: row.assignment.key,
      lastSeen: { platform, siteId, siteName, at },
      serial: m.platform === "central" && "serialNumber" in m ? m.serialNumber : m.platform === "mist" && "serial" in m ? m.serial : null,
    });
  }
  if (updates.length) await touchLastSeen(updates).catch(() => undefined);
}

// ---- 詳細 ----

const detailCache = new Map<string, Cache<DetailEnvelope<any>>>();
const detailInFlight = new Map<string, Promise<DetailEnvelope<any>>>();

async function cachedDetail<D>(
  cacheKey: string,
  force: boolean,
  build: () => Promise<DetailEnvelope<D>>,
): Promise<DetailEnvelope<D>> {
  const ttl = getSettings().detailTtlMs;
  const hit = detailCache.get(cacheKey);
  if (!force && hit && Date.now() - hit.at < ttl) {
    return { ...hit.data, cached: true, ageMs: Date.now() - hit.at } as DetailEnvelope<D>;
  }
  const running = detailInFlight.get(cacheKey);
  if (running) return running as Promise<DetailEnvelope<D>>;

  const p = build();
  detailInFlight.set(cacheKey, p);
  try {
    const data = await p;
    detailCache.set(cacheKey, { at: Date.now(), data });
    return data;
  } finally {
    detailInFlight.delete(cacheKey);
  }
}

/**
 * クライアント 1 件の詳細。Central / Mist の両方に問い合わせ、見つかったぶんだけ返す。
 * 万一両方から返っても**マージしない**(単位も名前の体系も違う。58 §2-6)。
 */
export async function getClientDetail(key: string, force = false): Promise<DetailEnvelope<ClientDetail>> {
  return cachedDetail<ClientDetail>(`client:${key}`, force, async () => {
    const details: ClientDetail[] = [];
    const sources: DetailEnvelope<ClientDetail>["sources"] = [];

    if (isCentralConfigured()) {
      try {
        const d = await fetchCentralClientDetail(key);
        if (d) details.push(d);
        sources.push({ platform: "central", ok: true, error: null });
      } catch (err) {
        sources.push({ platform: "central", ok: false, error: msgOf(err) });
      }
    }

    if (isMistConfigured()) {
      try {
        // Mist は site が要る。一覧の突合結果(= 直近の観測)から site と有線/無線を決める。
        const list = await getClientList();
        const row = list.rows.find((r) => r.assignment.key === key);
        const mistMatch = row?.matches.find((m) => m.platform === "mist");
        const siteId =
          (mistMatch && mistMatch.platform === "mist" ? mistMatch.siteId : null) ??
          (row?.assignment.lastSeen?.platform === "mist" ? row.assignment.lastSeen.siteId : null);
        const connType =
          mistMatch && mistMatch.platform === "mist" ? mistMatch.connectionType : "wireless";
        if (siteId) {
          // 接続先 AP の名前解決は mist-fetch 側(org 全体のデバイス名キャッシュ)が行う。
          // タグ付きデバイスに限らず名前が出るようにするため。
          const d = await fetchMistClientDetail(key, siteId, connType);
          if (d) details.push(d);
        }
        sources.push({ platform: "mist", ok: true, error: null });
      } catch (err) {
        sources.push({ platform: "mist", ok: false, error: msgOf(err) });
      }
    }

    return { fetchedAt: new Date().toISOString(), cached: false, ageMs: 0, key, details, sources };
  });
}

export async function getDeviceDetail(key: string, force = false): Promise<DetailEnvelope<DeviceDetail>> {
  return cachedDetail<DeviceDetail>(`device:${key}`, force, async () => {
    const details: DeviceDetail[] = [];
    const sources: DetailEnvelope<DeviceDetail>["sources"] = [];
    const list = await getDeviceList();
    const row = list.rows.find((r) => r.assignment.key === key);

    for (const match of row?.matches ?? []) {
      try {
        if (match.platform === "central") {
          const d = await fetchCentralDeviceDetail(match);
          if (d) details.push(d);
          sources.push({ platform: "central", ok: true, error: null });
        } else {
          const d = await fetchMistDeviceDetail(match);
          if (d) details.push(d);
          sources.push({ platform: "mist", ok: true, error: null });
        }
      } catch (err) {
        sources.push({ platform: match.platform, ok: false, error: msgOf(err) });
      }
    }

    return { fetchedAt: new Date().toISOString(), cached: false, ageMs: 0, key, details, sources };
  });
}
