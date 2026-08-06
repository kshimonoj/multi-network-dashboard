/**
 * タグ付き対象(59)— Mist 側の取得(直接 REST。MCP は経由しない)。
 *
 * トークン・レート制御は Global Overview の MistClient を共有する(57 §2-4)。
 *
 * 59 の実測で確認したエンドポイント(すべて読み取り):
 *   GET api/v1/orgs/{org}/clients/search        … org 横断の無線クライアント検索。site_id / random_mac / hostname / username / psk_name
 *   GET api/v1/orgs/{org}/wired_clients/search  … org 横断の有線クライアント検索
 *   GET api/v1/sites/{sid}/stats/clients        … サイトの無線クライアント現況(RSSI/SNR/bps/uptime/key_mgmt)
 *   GET api/v1/sites/{sid}/stats/clients/{mac}  … 単体(未接続なら 404)
 *   GET api/v1/sites/{sid}/insights/client/{mac}/top-app-by-bytes  … アプリ別バイト数
 *   GET api/v1/orgs/{org}/stats/devices         … org 全デバイス
 *   GET api/v1/sites/{sid}/stats/devices/{id}   … デバイス単体
 *
 * 実測で判明した重要な差(57 の記載を実装に落とすうえで効く):
 *   - `stats/clients` には **hostname / username / random_mac が無い**。
 *     それらは `clients/search` 側にしかないので、詳細では 2 本叩いて合成する。
 *   - `stats/clients` には **`key_mgmt`(WPA3-SAE-PSK/CCMP 等)がある**。
 *     57 §2-5 は「Mist の鍵管理は WLAN 設定を別途引く必要がある」としていたが、
 *     クライアント現況から直接取れる。追加の呼び出しは不要。
 *   - AP は `cpu_util` / `mem_total_kb`、**スイッチ・ゲートウェイは `cpu_stat` / `memory_stat`**、
 *     ポートは AP が `port_stat`、スイッチ / ゲートウェイが `if_stat` と、キーが別。
 */

import { getClients } from "../global-overview/poller.js";
import { normalizeMac } from "./mac.js";
import type {
  AppUsageRow,
  EventRow,
  MistClientDetail,
  MistClientSummary,
  MistDeviceDetail,
  MistDeviceSummary,
  MistPortRow,
  MistRadioRow,
  Section,
} from "./types.js";

function s(v: unknown): string | null {
  if (typeof v !== "string") return v == null ? null : String(v);
  const t = v.trim();
  return t ? t : null;
}
function n(v: unknown): number | null {
  const x = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
/** Mist の秒 epoch(小数を含むことがある)→ ISO。0 / 未設定は null。 */
function epochToIso(v: unknown): string | null {
  const x = n(v);
  if (x === null || x <= 0) return null;
  return new Date(Math.round(x * 1000)).toISOString();
}

/**
 * `last_trouble.timestamp` は **機種によって秒とミリ秒が混在する**(59 実測: EX スイッチは
 * ミリ秒、AP45 は秒)。単位の宣言がフィールドに無いので桁で見分ける。
 * 1e11 秒 ≒ 西暦 5138 年なので、これを超える値はミリ秒とみなして差し支えない。
 */
function looseEpochToIso(v: unknown): string | null {
  const x = n(v);
  if (x === null || x <= 0) return null;
  const ms = x > 1e11 ? x : x * 1000;
  return new Date(Math.round(ms)).toISOString();
}

/**
 * env_stat のセンサ値。センサを積んでいない機種では **0 が返る**(59 実測: AP45 の
 * ambient_temp / humidity が 0)。0 °C の室温・湿度 0% は現実的でないので
 * 「センサ無し」として落とし、行ごと出さない。CPU 温度は 0 が返らないのでそのまま扱う。
 */
function sensor(v: unknown): number | null {
  const x = n(v);
  return x === null || x === 0 ? null : x;
}
/** Mist の band は "24" / "5" / "6"。表示用に 2.4 へ読み替える(global-overview と同じ扱い)。 */
function band(v: unknown): string | null {
  const t = s(v);
  if (!t) return null;
  return t === "24" ? "2.4" : t;
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isNotFound(err: unknown): boolean {
  return err instanceof Error && /HTTP 404/.test(err.message);
}

function client() {
  const { mist } = getClients();
  return mist;
}

export function isMistConfigured(): boolean {
  return client() !== null;
}

const arr = (v: any): any[] => (Array.isArray(v) ? v : Array.isArray(v?.results) ? v.results : []);

// ---- サイト名解決(org の stats/sites を短時間キャッシュ)----

let siteNameCache: { at: number; map: Map<string, string> } | null = null;
const SITE_NAME_TTL_MS = 300_000;

export async function mistSiteNames(): Promise<Map<string, string>> {
  if (siteNameCache && Date.now() - siteNameCache.at < SITE_NAME_TTL_MS) return siteNameCache.map;
  const c = client();
  if (!c) return new Map();
  const orgId = await c.getOrgId();
  const res = await c.apiGet(`api/v1/orgs/${orgId}/stats/sites`, { limit: 1000 });
  const map = new Map<string, string>();
  for (const s2 of arr(res)) {
    const id = s(s2?.id);
    if (id) map.set(id, s(s2?.name) ?? id);
  }
  siteNameCache = { at: Date.now(), map };
  return map;
}

// ---- デバイス名解決(MAC → 名前。クライアント詳細の「接続先 AP」に使う)----
//
// タグ付きデバイスの索引ではなく **org 全体**を引く。接続先 AP にタグが付いているとは
// 限らないのに、付いているときだけ名前が出るのは分かりにくいため。
// 5 分キャッシュなので、詳細を開くたびに HTTP が増えることはない。

let deviceNameCache: { at: number; map: Map<string, string> } | null = null;

export async function mistDeviceNames(): Promise<Map<string, string>> {
  if (deviceNameCache && Date.now() - deviceNameCache.at < SITE_NAME_TTL_MS) return deviceNameCache.map;
  const c = client();
  if (!c) return new Map();
  const orgId = await c.getOrgId();
  const res = await c.apiGet(`api/v1/orgs/${orgId}/stats/devices`, { type: "all", limit: 1000 });
  const map = new Map<string, string>();
  for (const d of arr(res)) {
    const mac = normalizeMac(d?.mac);
    const name = s(d?.name) ?? s(d?.hostname);
    if (mac && name) map.set(mac, name);
  }
  deviceNameCache = { at: Date.now(), map };
  return map;
}

/**
 * Mist の PoE 値は**ミリワット**で返る(59 実測: power_draw=25500 / power_allocated=25000 の AP が
 * 実機では 25.5W / 25.0W)。ワットに直してから返す。小数 1 桁で丸める。
 */
function mwToW(v: unknown): number | null {
  const x = n(v);
  return x === null ? null : Math.round(x / 100) / 10;
}

// ---- 一覧 ----

/**
 * org 横断のクライアント検索(無線 + 有線)を各 1 本ずつ。
 * `duration` の窓に入っていない対象は返らないので、「見つからなかった」= 直近その窓で
 * 観測されていない、という意味になる(タグは消さず灰色で残す。57 §3-5)。
 */
export async function fetchMistClientIndex(durationDays = 1): Promise<MistClientSummary[]> {
  const c = client();
  if (!c) throw new Error("mist-not-configured");
  const orgId = await c.getOrgId();
  const duration = `${Math.max(1, Math.min(7, durationDays))}d`;
  const names = await mistSiteNames();

  const [wireless, wired] = await Promise.all([
    c.apiGet(`api/v1/orgs/${orgId}/clients/search`, { duration, limit: 1000 }),
    c.apiGet(`api/v1/orgs/${orgId}/wired_clients/search`, { duration, limit: 1000 }),
  ]);

  const out: MistClientSummary[] = [];
  for (const r of arr(wireless)) {
    const mac = normalizeMac(r?.mac);
    if (!mac) continue;
    const siteId = s(r?.site_id);
    out.push({
      platform: "mist",
      mac,
      hostname: s(r?.hostname),
      ip: s(r?.last_ip) ?? s(r?.ip),
      connectionType: "wireless",
      connected: false, // stats/clients で上書きする
      siteId,
      siteName: siteId ? (names.get(siteId) ?? null) : null,
      ssid: s(r?.last_ssid) ?? s(r?.ssid),
      band: band(r?.band),
      channel: null,
      proto: s(r?.protocol),
      rssi: null,
      snr: null,
      txBps: null,
      rxBps: null,
      uptimeSec: null,
      manufacture: s(r?.mfg),
      os: s(r?.last_os) ?? s(r?.os),
      family: s(r?.last_family),
      randomMac: bool(r?.random_mac),
      isGuest: null,
      username: s(r?.username),
      pskName: s(r?.psk_name),
      deviceMac: null,
      portId: null,
      lastSeen: epochToIso(r?.timestamp),
    });
  }
  for (const r of arr(wired)) {
    const mac = normalizeMac(r?.mac) ?? normalizeMac(r?.client_mac);
    if (!mac) continue;
    const siteId = s(r?.site_id);
    out.push({
      platform: "mist",
      mac,
      hostname: s(r?.last_hostname) ?? s(r?.hostname),
      ip: s(r?.ip),
      connectionType: "wired",
      connected: false,
      siteId,
      siteName: siteId ? (names.get(siteId) ?? null) : null,
      ssid: null,
      band: null,
      channel: null,
      proto: null,
      rssi: null,
      snr: null,
      txBps: null,
      rxBps: null,
      uptimeSec: null,
      manufacture: s(r?.manufacture),
      os: null,
      family: null,
      randomMac: bool(r?.random_mac),
      isGuest: null,
      username: s(r?.username),
      pskName: null,
      deviceMac: normalizeMac(r?.last_device_mac) ?? normalizeMac(r?.device_mac),
      portId: s(r?.last_port_id) ?? s(r?.port_id),
      lastSeen: epochToIso(r?.timestamp),
    });
  }
  return out;
}

/**
 * サイトの無線クライアント現況を取って、検索由来の行に RSSI / SNR / スループットを重ねる。
 * 叩くのは「タグ付き対象が居るサイト」だけ。上限を超えたぶんは truncated に記録して黙って切らない。
 */
export async function overlayMistLiveClients(
  rows: MistClientSummary[],
  siteIds: string[],
  maxSites: number,
): Promise<{ truncatedSites: number }> {
  const c = client();
  if (!c) return { truncatedSites: 0 };
  const targets = siteIds.slice(0, maxSites);
  const truncatedSites = Math.max(0, siteIds.length - targets.length);

  await Promise.all(
    targets.map(async (sid) => {
      let res: any;
      try {
        res = await c.apiGet(`api/v1/sites/${sid}/stats/clients`, { limit: 200 });
      } catch {
        return; // 1 サイトが落ちても他サイトの現況は出す
      }
      for (const live of arr(res)) {
        const mac = normalizeMac(live?.mac);
        if (!mac) continue;
        for (const row of rows) {
          if (row.mac !== mac || row.connectionType !== "wireless") continue;
          row.connected = true;
          row.rssi = n(live?.rssi);
          row.snr = n(live?.snr);
          row.txBps = n(live?.tx_bps);
          row.rxBps = n(live?.rx_bps);
          row.channel = n(live?.channel);
          row.band = band(live?.band) ?? row.band;
          row.proto = s(live?.proto) ?? row.proto;
          row.uptimeSec = n(live?.uptime);
          row.ip = s(live?.ip) ?? row.ip;
          row.ssid = s(live?.ssid) ?? row.ssid;
          row.isGuest = bool(live?.is_guest);
          row.siteId = s(live?.site_id) ?? row.siteId;
        }
      }
    }),
  );
  return { truncatedSites };
}

export async function fetchMistDeviceIndex(): Promise<MistDeviceSummary[]> {
  const c = client();
  if (!c) throw new Error("mist-not-configured");
  const orgId = await c.getOrgId();
  const names = await mistSiteNames();
  const res = await c.apiGet(`api/v1/orgs/${orgId}/stats/devices`, { type: "all", limit: 1000 });
  const out: MistDeviceSummary[] = [];
  for (const d of arr(res)) {
    const mac = normalizeMac(d?.mac);
    const id = s(d?.id) ?? mac;
    if (!id || !mac) continue;
    const siteId = s(d?.site_id);
    out.push({
      platform: "mist",
      id,
      mac,
      serial: s(d?.serial),
      name: s(d?.name) ?? s(d?.hostname),
      type: s(d?.type) ?? "unknown",
      model: s(d?.model),
      status: s(d?.status),
      version: s(d?.version),
      siteId,
      siteName: siteId ? (names.get(siteId) ?? null) : null,
      ip: s(d?.ip),
      uptimeSec: n(d?.uptime),
    });
  }
  return out;
}

// ---- クライアント詳細 ----

async function fetchMistClientEventsSection(siteId: string, mac: string): Promise<Section<EventRow>> {
  const c = client();
  if (!c) return { status: "error", error: "mist-not-configured", items: [] };
  // Global Overview 側の既存実装を再利用する(57 §2-4)。
  const sec = await c.fetchMistClientEvents(siteId, mac);
  return {
    status: sec.status === "ok" ? "ok" : "error",
    error: sec.error,
    items: sec.items.map((e) => ({
      timestamp: e.timestamp,
      type: e.type,
      text: e.text,
      deviceLabel: e.deviceLabel,
    })),
    note: sec.note,
  };
}

/** アプリ別トラフィック。**無線クライアント限定**(有線は 57 §1-8 で取得不可が確定)。 */
async function fetchMistClientApps(siteId: string, mac: string): Promise<Section<AppUsageRow>> {
  const c = client();
  if (!c) return { status: "error", error: "mist-not-configured", items: [] };
  const end = Math.floor(Date.now() / 1000);
  const start = end - 86_400;
  try {
    const res = await c.apiGet(`api/v1/sites/${siteId}/insights/client/${mac}/top-app-by-bytes`, {
      start,
      end,
      limit: 20,
    });
    const items: AppUsageRow[] = arr(res).map((a: any) => ({
      // "Unknown" は分類できなかった暗号化トラフィック。表示側で別扱いにする(57 §1-5)
      app: s(a?.app) ?? "Unknown",
      rxBytes: n(a?.rx_bytes),
      txBytes: n(a?.tx_bytes),
      totalBytes: n(a?.total_bytes),
    }));
    return { status: "ok", error: null, items, note: "24h" };
  } catch (err) {
    return { status: "error", error: msgOf(err), items: [] };
  }
}

/**
 * クライアント 1 件の詳細。
 * siteId が分からないと Mist は引けないので、呼び出し元(resolve.ts)が
 * 一覧の突合結果 / lastSeen から site を渡す。
 */
export async function fetchMistClientDetail(
  key: string,
  siteId: string,
  connectionType: "wireless" | "wired",
): Promise<MistClientDetail | null> {
  const c = client();
  if (!c) throw new Error("mist-not-configured");
  const names = await mistSiteNames();
  const siteName = names.get(siteId) ?? null;

  // 検索側(hostname / random_mac / username / psk_name。stats には無い)
  let search: any = null;
  try {
    const path = connectionType === "wired" ? "wired_clients/search" : "clients/search";
    const res = await c.apiGet(`api/v1/sites/${siteId}/${path}`, { mac: key, duration: "1d", limit: 1 });
    search = arr(res)[0] ?? null;
  } catch {
    /* 検索が引けなくても現況だけで詳細は出す */
  }

  if (connectionType === "wired") {
    if (!search) return null;
    return {
      platform: "mist",
      mac: key,
      connectionType: "wired",
      connected: true,
      siteId,
      siteName,
      hostname: s(search?.last_hostname) ?? s(search?.hostname),
      ip: s(search?.ip),
      manufacture: s(search?.manufacture),
      model: null,
      os: null,
      osVersion: null,
      family: null,
      randomMac: bool(search?.random_mac),
      isGuest: null,
      username: s(search?.username),
      pskName: null,
      apMac: null,
      apName: null,
      bssid: null,
      ssid: null,
      wlanId: null,
      vlanId: s(search?.last_vlan) ?? s(search?.vlan),
      band: null,
      channel: null,
      proto: null,
      keyMgmt: null,
      rssi: null,
      snr: null,
      txBps: null,
      rxBps: null,
      txBytes: null,
      rxBytes: null,
      txRetries: null,
      rxRetries: null,
      uptimeSec: null,
      idleTimeSec: null,
      lastSeen: epochToIso(search?.timestamp),
      deviceMac: normalizeMac(search?.last_device_mac) ?? normalizeMac(search?.device_mac),
      portId: s(search?.last_port_id) ?? s(search?.port_id),
      vlanName: s(search?.last_vlan_name),
      authMethod: s(search?.auth_method),
      authState: s(search?.auth_state),
      // 57 §1-8: Mist は有線クライアントのバイト数・アプリを返さない
      apps: { status: "unsupported", error: null, items: [] },
      events: { status: "unsupported", error: null, items: [] },
    };
  }

  let live: any = null;
  try {
    live = await c.apiGet(`api/v1/sites/${siteId}/stats/clients/${key}`);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    // 404 = 今は接続していない。検索側の情報だけで返す。
  }
  if (!live && !search) return null;

  const apMac = normalizeMac(live?.ap_mac) ?? normalizeMac(search?.last_ap) ?? normalizeMac(search?.ap);
  const [apps, events, deviceNames] = await Promise.all([
    fetchMistClientApps(siteId, key),
    fetchMistClientEventsSection(siteId, key),
    mistDeviceNames().catch(() => new Map<string, string>()),
  ]);

  return {
    platform: "mist",
    mac: key,
    connectionType: "wireless",
    connected: Boolean(live),
    siteId,
    siteName,
    hostname: s(search?.hostname),
    ip: s(live?.ip) ?? s(search?.last_ip) ?? s(search?.ip),
    manufacture: s(live?.manufacture) ?? s(search?.mfg),
    model: s(live?.model) ?? s(search?.last_model),
    os: s(live?.os) ?? s(search?.last_os),
    osVersion: s(search?.last_os_version) ?? s(search?.os_version),
    family: s(live?.family) ?? s(search?.last_family),
    randomMac: bool(search?.random_mac),
    isGuest: bool(live?.is_guest),
    username: s(search?.username),
    pskName: s(search?.psk_name),
    apMac,
    apName: apMac ? (deviceNames.get(apMac) ?? null) : null,
    bssid: s(live?.bssid),
    ssid: s(live?.ssid) ?? s(search?.last_ssid),
    wlanId: s(live?.wlan_id) ?? s(search?.last_wlan_id),
    vlanId: s(live?.vlan_id) ?? s(search?.last_vlan),
    band: band(live?.band) ?? band(search?.band),
    channel: n(live?.channel),
    proto: s(live?.proto) ?? s(search?.protocol),
    keyMgmt: s(live?.key_mgmt),
    rssi: n(live?.rssi),
    snr: n(live?.snr),
    txBps: n(live?.tx_bps),
    rxBps: n(live?.rx_bps),
    txBytes: n(live?.tx_bytes),
    rxBytes: n(live?.rx_bytes),
    txRetries: n(live?.tx_retries),
    rxRetries: n(live?.rx_retries),
    uptimeSec: n(live?.uptime),
    idleTimeSec: n(live?.idle_time),
    lastSeen: epochToIso(live?.last_seen) ?? epochToIso(search?.timestamp),
    deviceMac: null,
    portId: null,
    vlanName: null,
    authMethod: null,
    authState: null,
    apps,
    events,
  };
}

// ---- デバイス詳細 ----

function mistKind(type: string | null): MistDeviceDetail["kind"] {
  const t = String(type ?? "").toLowerCase();
  if (t === "ap") return "ap";
  if (t === "switch") return "switch";
  if (t === "gateway" || t === "router") return "gateway";
  return "other";
}

export async function fetchMistDeviceDetail(base: MistDeviceSummary): Promise<MistDeviceDetail | null> {
  const c = client();
  if (!c) throw new Error("mist-not-configured");
  if (!base.siteId) return null;
  let raw: any;
  try {
    raw = await c.apiGet(`api/v1/sites/${base.siteId}/stats/devices/${base.id}`);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const kind = mistKind(base.type);

  // 無線は AP のみ。radio_stat の band_24 / band_5 / band_6 を行に展開する。
  const radios: Section<MistRadioRow> =
    kind === "ap"
      ? {
          status: "ok",
          error: null,
          items: (["24", "5", "6"] as const)
            .map((suffix) => {
              const r = raw?.radio_stat?.[`band_${suffix}`];
              if (!r || typeof r !== "object") return null;
              return {
                band: (suffix === "24" ? "2.4" : suffix) as MistRadioRow["band"],
                channel: n(r?.channel),
                bandwidth: n(r?.bandwidth),
                power: n(r?.power),
                numClients: n(r?.num_clients),
                numWlans: n(r?.num_wlans),
                noiseFloor: n(r?.noise_floor),
                utilAll: n(r?.util_all),
                utilNonWifi: n(r?.util_non_wifi),
                utilRxInBss: n(r?.util_rx_in_bss),
                utilRxOtherBss: n(r?.util_rx_other_bss),
                utilTx: n(r?.util_tx),
                txBytes: n(r?.tx_bytes),
                rxBytes: n(r?.rx_bytes),
              } satisfies MistRadioRow;
            })
            .filter((x): x is MistRadioRow => x !== null)
            // チャネル 0 = その帯域は無効。行を出しても情報量が無いので落とす。
            .filter((x) => x.channel !== null && x.channel > 0),
        }
      : { status: "unsupported", error: null, items: [] };

  // ポートのキーが AP(port_stat)とスイッチ/ゲートウェイ(if_stat)で違う。
  const portSource = kind === "ap" ? raw?.port_stat : raw?.if_stat;
  const ports: Section<MistPortRow> = {
    status: "ok",
    error: null,
    items: Object.entries(portSource ?? {}).map(([name, p]: [string, any]) => ({
      name: s(p?.port_id) ?? name,
      up: bool(p?.up),
      speed: n(p?.speed),
      fullDuplex: bool(p?.full_duplex),
      rxBytes: n(p?.rx_bytes),
      txBytes: n(p?.tx_bytes),
      rxErrors: n(p?.rx_errors),
      poeOn: bool(p?.poe_on),
      portUsage: s(p?.port_usage) ?? s(p?.network_name),
    })),
  };

  // AP は cpu_util / mem_*_kb、スイッチ・ゲートウェイは cpu_stat / memory_stat(59 実測)。
  const cpuUtil = kind === "ap" ? n(raw?.cpu_util) : n(raw?.cpu_stat?.system) !== null && n(raw?.cpu_stat?.idle) !== null ? 100 - (n(raw?.cpu_stat?.idle) ?? 0) : null;
  const memTotalKb = n(raw?.mem_total_kb);
  const memUsedKb = n(raw?.mem_used_kb);
  const memUsedPct =
    kind === "ap"
      ? memTotalKb && memUsedKb !== null && memTotalKb > 0
        ? Math.round((memUsedKb / memTotalKb) * 100)
        : null
      : n(raw?.memory_stat?.usage);

  return {
    platform: "mist",
    kind,
    id: base.id,
    mac: normalizeMac(raw?.mac) ?? base.mac,
    serial: s(raw?.serial) ?? base.serial,
    name: s(raw?.name) ?? s(raw?.hostname) ?? base.name,
    model: s(raw?.model) ?? base.model,
    hwRev: s(raw?.hw_rev),
    status: s(raw?.status) ?? base.status,
    version: s(raw?.version) ?? base.version,
    siteId: base.siteId,
    siteName: base.siteName,
    ip: s(raw?.ip) ?? base.ip,
    extIp: s(raw?.ext_ip),
    uptimeSec: n(raw?.uptime) ?? base.uptimeSec,
    lastSeen: epochToIso(raw?.last_seen),
    cpuUtil,
    memUsedPct,
    memTotalKb,
    memUsedKb,
    numClients: n(raw?.num_clients),
    numWlans: n(raw?.num_wlans),
    certExpiry: epochToIso(raw?.cert_expiry),
    ambientTemp: sensor(raw?.env_stat?.ambient_temp),
    cpuTemp: sensor(raw?.env_stat?.cpu_temp),
    humidity: sensor(raw?.env_stat?.humidity),
    powerSrc: s(raw?.power_src),
    powerDraw: mwToW(raw?.lldp_stat?.power_draw),
    powerAllocated: mwToW(raw?.lldp_stat?.power_allocated),
    powerConstrained: bool(raw?.power_constrained),
    lldpSystemName: s(raw?.lldp_stat?.system_name),
    lldpPortId: s(raw?.lldp_stat?.port_id),
    lldpChassisId: s(raw?.lldp_stat?.chassis_id),
    lldpSystemDesc: s(raw?.lldp_stat?.system_desc),
    lastTroubleCode: s(raw?.last_trouble?.code),
    lastTroubleAt: looseEpochToIso(raw?.last_trouble?.timestamp),
    macTableCount: n(raw?.mac_table_stats?.mac_table_count),
    macTableMax: n(raw?.mac_table_stats?.max_mac_entries_supported),
    radios,
    ports,
  };
}
