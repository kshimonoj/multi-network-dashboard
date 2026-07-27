// Global Overview — サイト詳細のオンデマンド取得(11 番)。
//
// ポーラー(poller.ts / 3 分間隔)には一切組み込まない。詳細パネルを開いた時だけ発火する。
// レート制限を圧迫しないよう、以下のガードを持つ:
//   1. 30 秒の短時間キャッシュ(同一サイトを連続で開いても API を叩き直さない)
//   2. in-flight 共有(同じサイトへの同時要求を 1 本にまとめる)
// クライアント実体(トークンキャッシュ・レートリミッタ)はポーラーと共有する(getClients)。

import { getClients } from "./poller.js";
import type { ClientDetailEnvelope, SiteDetailEnvelope } from "./detail-types.js";

export type DetailPlatform = "central" | "mist";

/** 同一サイト詳細をこの時間内に再要求したらキャッシュを返す(API を叩かない)。 */
const DETAIL_TTL_MS = Math.max(5_000, Number(process.env.GLOBAL_OVERVIEW_DETAIL_TTL_MS ?? 30_000));

interface CacheEntry {
  at: number;
  data: SiteDetailEnvelope;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<SiteDetailEnvelope>>();

function cacheKey(platform: DetailPlatform, siteId: string): string {
  return `${platform}:${siteId}`;
}

export class SiteDetailError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

/**
 * サイト 1 件の詳細を取得する。30 秒キャッシュ + in-flight 共有つき。
 * @param siteName Central の health(siteName filter)・alerts(クライアント側フィルタ)に必要。
 */
export async function getSiteDetail(
  platform: DetailPlatform,
  siteId: string,
  siteName: string,
): Promise<SiteDetailEnvelope> {
  if (platform !== "central" && platform !== "mist") {
    throw new SiteDetailError(`未知のプラットフォーム: ${platform}`, 400);
  }
  if (!siteId) throw new SiteDetailError("siteId が指定されていません", 400);

  const key = cacheKey(platform, siteId);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DETAIL_TTL_MS) {
    return { ...hit.data, cached: true, ageMs: Date.now() - hit.at };
  }

  const running = inFlight.get(key);
  if (running) return running;

  const promise = (async (): Promise<SiteDetailEnvelope> => {
    const { central, mist } = getClients();
    const fetchedAt = new Date().toISOString();

    if (platform === "central") {
      if (!central) throw new SiteDetailError("Central の認証情報が未設定です", 503);
      const d = await central.getSiteDetail(siteId, siteName);
      return { platform, siteId, siteName, fetchedAt, cached: false, ageMs: 0, ...d };
    } else {
      if (!mist) throw new SiteDetailError("Mist の認証情報が未設定です", 503);
      const d = await mist.getSiteDetail(siteId);
      return { platform, siteId, siteName, fetchedAt, cached: false, ageMs: 0, ...d };
    }
  })();

  inFlight.set(key, promise);
  try {
    const data = await promise;
    cache.set(key, { at: Date.now(), data });
    return data;
  } finally {
    inFlight.delete(key);
  }
}

// --- クライアント 1 件の詳細(Task 3。オンデマンド)。サイト詳細と同じキャッシュ方針 ---

interface ClientCacheEntry {
  at: number;
  data: ClientDetailEnvelope;
}
const clientCache = new Map<string, ClientCacheEntry>();
const clientInFlight = new Map<string, Promise<ClientDetailEnvelope>>();

/**
 * クライアント 1 件のイベント履歴を取得する。30 秒キャッシュ + in-flight 共有つき。
 * 追加 HTTP は 1 本(Central: WIRELESS_CLIENT events / Mist: clients/events/search)。
 */
export async function getClientDetail(
  platform: DetailPlatform,
  siteId: string,
  mac: string,
): Promise<ClientDetailEnvelope> {
  if (platform !== "central" && platform !== "mist") {
    throw new SiteDetailError(`未知のプラットフォーム: ${platform}`, 400);
  }
  if (!siteId) throw new SiteDetailError("siteId が指定されていません", 400);
  if (!mac) throw new SiteDetailError("mac が指定されていません", 400);

  const key = `${platform}:${siteId}:${mac}`;

  const hit = clientCache.get(key);
  if (hit && Date.now() - hit.at < DETAIL_TTL_MS) {
    return { ...hit.data, cached: true, ageMs: Date.now() - hit.at };
  }

  const running = clientInFlight.get(key);
  if (running) return running;

  const promise = (async (): Promise<ClientDetailEnvelope> => {
    const { central, mist } = getClients();
    const fetchedAt = new Date().toISOString();
    if (platform === "central") {
      if (!central) throw new SiteDetailError("Central の認証情報が未設定です", 503);
      const events = await central.fetchCentralClientEvents(siteId, mac);
      return { platform, siteId, mac, fetchedAt, cached: false, ageMs: 0, events, requests: 1 };
    } else {
      if (!mist) throw new SiteDetailError("Mist の認証情報が未設定です", 503);
      const events = await mist.fetchMistClientEvents(siteId, mac);
      return { platform, siteId, mac, fetchedAt, cached: false, ageMs: 0, events, requests: 1 };
    }
  })();

  clientInFlight.set(key, promise);
  try {
    const data = await promise;
    clientCache.set(key, { at: Date.now(), data });
    return data;
  } finally {
    clientInFlight.delete(key);
  }
}
