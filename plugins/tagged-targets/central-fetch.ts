/**
 * タグ付き対象(59)— Central 側の取得(直接 REST。MCP は経由しない)。
 *
 * MCP ではなく直接 REST にした理由(59 の指示で確定 / 58 §4 判断事項 #2):
 *   タグ付きビューは「今気にしている特定の対象」を見る画面なので、
 *   cache-proxy の 300 秒 TTL より即時性を優先する。トークン・レート制御は
 *   Global Overview の CentralClient(rate-limit.ts 経由)をそのまま共有する。
 *
 * 59 の実測で確認したエンドポイント(すべて読み取り):
 *   GET network-monitoring/v1/clients                    … **site-id 無しで org 全体が返る**
 *   GET network-monitoring/v1/clients/{mac}              … 単体。**コロン区切り MAC 必須**(無いと 400)
 *   GET network-monitoring/v1/devices                    … org 全体
 *   GET network-monitoring/v1/aps/{serial}               … + /radios, /ports
 *   GET network-monitoring/v1/switches/{serial}          … + /interfaces, /hardware-categories
 *   GET network-monitoring/v1/gateways/{serial}          … + /ports, /uplinks
 *
 * 実データの罠(58 §1-8)はここで吸収する:
 *   - `lastSeenAt` が接続中は文字列 `"0"` → 生のまま lastSeenAtRaw に載せ、日時に変換しない
 *   - `userName` / `authenticationType` / `clientTags` は空文字で来る → 空文字は null に倒す
 *   - `tunnelType` は文字列 `"None"` → そのまま返し、表示側で落とす
 *   - `wirelessChannel` は `48E (80 MHz)` の帯域幅込み文字列 → パースしない
 */

import { getClients } from "../global-overview/poller.js";
import { normalizeMac, toColonMac } from "./mac.js";
import type {
  CentralClientDetail,
  CentralClientSummary,
  CentralDeviceDetail,
  CentralDeviceSummary,
  CentralPortRow,
  CentralRadioRow,
  CentralWlanRow,
  Section,
} from "./types.js";

/** 空文字を null に倒す(58 §1-8-2: 「未設定」判定は == null では足りない)。 */
function s(v: unknown): string | null {
  if (typeof v !== "string") return v == null ? null : String(v);
  const t = v.trim();
  return t ? t : null;
}

function n(v: unknown): number | null {
  const x = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : null;
}

/**
 * Central の switchTrends は温度・PoE を `29.120000839233` のような長い浮動小数で返す。
 * 表示に有効なのは小数 1 桁までなので、ここで丸めてから画面へ渡す。
 */
function n1(v: unknown): number | null {
  const x = n(v);
  return x === null ? null : Math.round(x * 10) / 10;
}

/**
 * ポート速度を **Mbps に正規化**する。Central は同じ「速度」でも単位が違う(59 実測):
 *   - AP ポート(`aps/{serial}/ports`)      … `"1000"` = Mbps の文字列
 *   - スイッチ interfaces                    … `1000000000` = bps の数値
 * 1e6 を超える値は bps とみなして換算する(1 Tbps 相当の Mbps 値は現実に存在しないので安全)。
 */
function speedMbps(v: unknown): number | null {
  const x = n(v);
  if (x === null || x <= 0) return null;
  return x > 1e6 ? Math.round(x / 1e6) : Math.round(x);
}

function b(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** カンマ区切り文字列 → チップ用の配列(58 §1-8-6)。null / 空文字は空配列。 */
function csv(v: unknown): string[] {
  const t = s(v);
  if (!t) return [];
  return t
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function isNotFound(err: unknown): boolean {
  return err instanceof Error && /HTTP 404/.test(err.message);
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function client() {
  const { central } = getClients();
  return central;
}

export function isCentralConfigured(): boolean {
  return client() !== null;
}

// ---- 一覧 ----

export function toCentralClientSummary(c: any): CentralClientSummary | null {
  const mac = normalizeMac(c?.macAddress);
  if (!mac) return null;
  return {
    platform: "central",
    mac,
    clientName: s(c?.clientName),
    hostName: s(c?.hostName),
    ipv4: s(c?.ipv4) ?? s(c?.ipv6),
    connectionType: s(c?.clientConnectionType),
    status: s(c?.status),
    siteId: s(c?.siteId),
    siteName: s(c?.siteName),
    connectedTo: s(c?.connectedTo),
    wlanName: s(c?.wlanName),
    wirelessBand: s(c?.wirelessBand),
    wirelessChannel: s(c?.wirelessChannel),
    snr: n(c?.snr),
    clientVendor: s(c?.clientVendor),
    clientManufacturer: s(c?.clientManufacturer),
    clientOperatingSystem: s(c?.clientOperatingSystem),
    clientCategory: s(c?.clientCategory),
    connectedAt: s(c?.connectedAt),
    // "0" をそのまま渡す。日時にしてはいけない(58 §1-8-1)
    lastSeenAtRaw: typeof c?.lastSeenAt === "string" ? c.lastSeenAt : null,
  };
}

/**
 * org 全体のクライアント一覧を 1 本の HTTP で取る。
 * 57 §3-4 は「Central にクライアントの org 横断一覧が無い」としていたが、
 * 59 の実測で **site-id を省くと org 全体が返る**ことを確認したため、
 * タグ件数によらず 1 リクエストで突合できる。
 */
export async function fetchAllCentralClients(limit = 1000): Promise<CentralClientSummary[]> {
  const c = client();
  if (!c) throw new Error("central-not-configured");
  const res = await c.apiGet("network-monitoring/v1/clients", { limit });
  return (res?.items ?? [])
    .map(toCentralClientSummary)
    .filter((x: CentralClientSummary | null): x is CentralClientSummary => x !== null);
}

export function toCentralDeviceSummary(d: any): CentralDeviceSummary | null {
  const serial = s(d?.serialNumber) ?? s(d?.id);
  if (!serial) return null;
  return {
    platform: "central",
    serialNumber: serial,
    macAddress: normalizeMac(d?.macAddress),
    deviceName: s(d?.deviceName),
    deviceType: s(d?.deviceType) ?? "UNKNOWN",
    model: s(d?.model),
    status: s(d?.status),
    firmwareVersion: s(d?.firmwareVersion),
    siteId: s(d?.siteId),
    siteName: s(d?.siteName),
    ipv4: s(d?.ipv4) ?? s(d?.ipv6),
    uptimeMs: n(d?.uptimeInMillis),
  };
}

export async function fetchAllCentralDevices(limit = 1000): Promise<CentralDeviceSummary[]> {
  const c = client();
  if (!c) throw new Error("central-not-configured");
  const res = await c.apiGet("network-monitoring/v1/devices", { limit, next: 1 });
  return (res?.items ?? [])
    .map(toCentralDeviceSummary)
    .filter((x: CentralDeviceSummary | null): x is CentralDeviceSummary => x !== null);
}

// ---- クライアント詳細 ----

/**
 * MAC 単体引き。**コロン区切りでないと HTTP 400**(59 実測)。
 * 見つからないときは 404 → null を返す。
 */
export async function fetchCentralClientDetail(key: string): Promise<CentralClientDetail | null> {
  const c = client();
  if (!c) throw new Error("central-not-configured");
  let raw: any;
  try {
    raw = await c.apiGet(`network-monitoring/v1/clients/${encodeURIComponent(toColonMac(key))}`);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const mac = normalizeMac(raw?.macAddress) ?? key;
  const siteId = s(raw?.siteId);

  // イベントは Global Overview の既存メソッドを再利用する(57 §2-4 の「重複しない/再利用する」)。
  let events: Section<{ timestamp: string | null; type: string | null; text: string; deviceLabel: string | null }> = {
    status: "unsupported",
    error: null,
    items: [],
  };
  if (siteId) {
    const sec = await c.fetchCentralClientEvents(siteId, toColonMac(key));
    events = {
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

  return {
    platform: "central",
    mac,
    clientName: s(raw?.clientName),
    hostName: s(raw?.hostName),
    userName: s(raw?.userName),
    ipv4: s(raw?.ipv4),
    ipv6: s(raw?.ipv6),
    siteId,
    siteName: s(raw?.siteName),
    connectionType: s(raw?.clientConnectionType),
    status: s(raw?.status),
    role: s(raw?.role),
    vlanId: s(raw?.vlanId),
    vlanName: s(raw?.vlanName),
    tunnelType: s(raw?.tunnelType),
    tunnelId: s(raw?.tunnelId),
    authenticationType: s(raw?.authenticationType),
    keyManagement: s(raw?.keyManagement),
    wirelessSecurity: s(raw?.wirelessSecurity),
    wlanName: s(raw?.wlanName),
    wirelessBand: s(raw?.wirelessBand),
    wirelessChannel: s(raw?.wirelessChannel),
    phyType: s(raw?.phyType),
    mloOperMode: s(raw?.mloOperMode),
    snr: n(raw?.snr),
    bssid: s(raw?.bssid),
    radioMacAddress: s(raw?.radioMacAddress),
    connectedTo: s(raw?.connectedTo),
    connectedDeviceType: s(raw?.connectedDeviceType),
    connectedDeviceSerial: s(raw?.connectedDeviceSerial),
    port: s(raw?.port),
    connectedAt: s(raw?.connectedAt),
    lastSeenAtRaw: typeof raw?.lastSeenAt === "string" ? raw.lastSeenAt : null,
    clientVendor: s(raw?.clientVendor),
    clientManufacturer: s(raw?.clientManufacturer),
    clientCategory: s(raw?.clientCategory),
    clientFunction: s(raw?.clientFunction),
    clientOperatingSystem: s(raw?.clientOperatingSystem),
    capabilities: csv(raw?.clientCapabilities),
    centralTags: csv(raw?.clientTags),
    events,
  };
}

// ---- デバイス詳細 ----

function kindOf(deviceType: string | null): CentralDeviceDetail["kind"] {
  const t = String(deviceType ?? "").toUpperCase();
  if (t === "ACCESS_POINT" || t === "AP") return "ap";
  if (t === "SWITCH") return "switch";
  if (t === "GATEWAY") return "gateway";
  return "other";
}

async function section<T>(fn: () => Promise<T[]>): Promise<Section<T>> {
  try {
    return { status: "ok", error: null, items: await fn() };
  } catch (err) {
    return { status: "error", error: msgOf(err), items: [] };
  }
}

const UNSUPPORTED: Section<never> = { status: "unsupported", error: null, items: [] };

/**
 * デバイス 1 台の詳細。deviceType で叩き分ける(AP / スイッチ / ゲートウェイで
 * エンドポイントも返る項目も違うので、共通型に潰さない)。
 * base の一覧行(fetchAllCentralDevices の結果)を渡してもらい、site 名などを引き継ぐ。
 */
export async function fetchCentralDeviceDetail(
  base: CentralDeviceSummary,
): Promise<CentralDeviceDetail | null> {
  const c = client();
  if (!c) throw new Error("central-not-configured");
  const kind = kindOf(base.deviceType);
  const serial = base.serialNumber;

  const common = {
    platform: "central" as const,
    kind,
    serialNumber: serial,
    deviceName: base.deviceName,
    macAddress: base.macAddress,
    model: base.model,
    status: base.status,
    firmwareVersion: base.firmwareVersion,
    siteId: base.siteId,
    siteName: base.siteName,
    ipv4: base.ipv4,
    uptimeMs: base.uptimeMs,
  };

  if (kind === "ap") {
    let raw: any;
    try {
      raw = await c.apiGet(`network-monitoring/v1/aps/${encodeURIComponent(serial)}`);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    // cpu / memory / clientCount は apStats[] に入っている(59 実測)。
    const stat = Array.isArray(raw?.apStats) ? raw.apStats[0] : null;
    const [radios, ports] = await Promise.all([
      section<CentralRadioRow>(async () => {
        const r = await c.apiGet(`network-monitoring/v1/aps/${encodeURIComponent(serial)}/radios`);
        return (r?.items ?? []).map(
          (x: any): CentralRadioRow => ({
            radioNumber: n(x?.radioNumber),
            band: s(x?.band),
            channel: s(x?.channel),
            bandwidth: s(x?.bandwidth),
            power: s(x?.power),
            status: s(x?.status),
            clientCount: n(x?.clientCount),
            channelUtilization: n(x?.channelUtilization),
            channelQuality: n(x?.channelQuality),
            noiseFloor: n(x?.noiseFloor),
            nonWifiInterference: n(x?.nonWifiInterference),
            rxUtilization: n(x?.rxUtilization),
            txUtilization: n(x?.txUtilization),
            retries: n(x?.retries),
            drops: n(x?.drops),
          }),
        );
      }),
      section<CentralPortRow>(async () => {
        const r = await c.apiGet(`network-monitoring/v1/aps/${encodeURIComponent(serial)}/ports`);
        return (r?.items ?? []).map(
          (x: any): CentralPortRow => ({
            name: s(x?.name),
            status: s(x?.status),
            speedMbps: speedMbps(x?.speed),
            duplex: s(x?.duplex),
            connector: s(x?.connector),
            vlanMode: s(x?.vlanMode),
            nativeVlan: s(x?.nativeVlan),
            accessVlan: s(x?.accessVlan),
            isUplink: b(x?.isUplink),
          }),
        );
      }),
    ]);

    const wlans: Section<CentralWlanRow> = {
      status: "ok",
      error: null,
      items: (Array.isArray(raw?.wlans) ? raw.wlans : []).map(
        (w: any): CentralWlanRow => ({
          wlanName: s(w?.wlanName),
          security: s(w?.security),
          securityLevel: s(w?.securityLevel),
          band: s(w?.band),
          vlan: s(w?.vlan),
          status: s(w?.status),
        }),
      ),
    };

    return {
      ...common,
      deviceName: s(raw?.deviceName) ?? common.deviceName,
      model: s(raw?.model) ?? common.model,
      status: s(raw?.status) ?? common.status,
      firmwareVersion: s(raw?.firmwareVersion) ?? common.firmwareVersion,
      ipv4: s(raw?.ipv4) ?? common.ipv4,
      publicIpv4: s(raw?.publicIpv4),
      uptimeMs: n(raw?.uptimeInMillis) ?? common.uptimeMs,
      cpuUtilization: n(stat?.cpuUtilization),
      memoryUtilization: n(stat?.memoryUtilization),
      clientCount: n(stat?.clientCount),
      lastRebootReason: s(raw?.lastRebootReason),
      negotiatedPower: s(raw?.negotiatedPower),
      mode: s(raw?.mode),
      // 実測で "-"(未設定)が入る。ハイフンだけの値は情報量ゼロなので落とす。
      meshRole: s(raw?.meshRole) === "-" ? null : s(raw?.meshRole),
      bandSelection: s(raw?.bandSelection),
      countryCode: s(raw?.countryCode),
      currentUplinkInUse: s(raw?.currentUplinkInUse),
      hardwareHealth: [],
      poeAvailable: null,
      poeConsumption: null,
      systemTemperature: null,
      radios,
      ports,
      wlans,
    };
  }

  if (kind === "switch") {
    let raw: any;
    try {
      raw = await c.apiGet(`network-monitoring/v1/switches/${encodeURIComponent(serial)}`);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    // switchTrends は「直近スナップショット 1 件」として使う(時系列グラフは初回リリース対象外)。
    const trend = Array.isArray(raw?.switchTrends) ? raw.switchTrends[0] : null;

    const [ports, hw] = await Promise.all([
      section<CentralPortRow>(async () => {
        const r = await c.apiGet(`network-monitoring/v1/switches/${encodeURIComponent(serial)}/interfaces`, {
          limit: 100,
        });
        return (r?.items ?? []).map(
          (x: any): CentralPortRow => ({
            name: s(x?.name) ?? s(x?.port),
            status: s(x?.status) ?? s(x?.operStatus),
            speedMbps: speedMbps(x?.speed),
            duplex: s(x?.duplex),
            connector: s(x?.connector),
            vlanMode: s(x?.vlanMode),
            nativeVlan: s(x?.nativeVlan),
            accessVlan: s(x?.accessVlan),
            isUplink: b(x?.uplink),
            poeStatus: s(x?.poeStatus),
            neighbour: s(x?.neighbour),
          }),
        );
      }),
      section<{ label: string; value: string }>(async () => {
        const r = await c.apiGet(
          `network-monitoring/v1/switches/${encodeURIComponent(serial)}/hardware-categories`,
        );
        const item = (r?.items ?? [])[0];
        if (!item) return [];
        const out: Array<{ label: string; value: string }> = [];
        for (const key of ["cpu", "memory", "temperature", "fans", "powerSupplies"]) {
          const v = item[key];
          const health = s(v?.health);
          if (!health) continue;
          const counts =
            n(v?.totalCount) !== null ? ` (${n(v?.upCount) ?? 0}/${n(v?.totalCount)})` : "";
          out.push({ label: key, value: `${health}${counts}` });
        }
        return out;
      }),
    ]);

    return {
      ...common,
      deviceName: s(raw?.deviceName) ?? common.deviceName,
      macAddress: normalizeMac(raw?.macAddress) ?? common.macAddress,
      model: s(raw?.model) ?? common.model,
      status: s(raw?.status) ?? common.status,
      firmwareVersion: s(raw?.firmwareVersion) ?? common.firmwareVersion,
      siteName: s(raw?.siteName) ?? common.siteName,
      ipv4: s(raw?.ipv4) ?? common.ipv4,
      publicIpv4: s(raw?.publicIp),
      uptimeMs: n(raw?.uptimeInMillis) ?? common.uptimeMs,
      cpuUtilization: n1(trend?.cpuUtilization),
      memoryUtilization: n1(trend?.memoryUtilization),
      clientCount: null,
      lastRebootReason: s(raw?.lastRestartReason),
      negotiatedPower: null,
      mode: s(raw?.switchType),
      meshRole: null,
      bandSelection: null,
      countryCode: null,
      currentUplinkInUse: null,
      hardwareHealth: hw.items,
      poeAvailable: n1(trend?.poeAvailable),
      poeConsumption: n1(trend?.poeConsumption),
      systemTemperature: n1(trend?.systemTemperature),
      radios: UNSUPPORTED,
      ports,
      wlans: UNSUPPORTED,
    };
  }

  if (kind === "gateway") {
    let raw: any;
    try {
      raw = await c.apiGet(`network-monitoring/v1/gateways/${encodeURIComponent(serial)}`);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    const ports = await section<CentralPortRow>(async () => {
      const r = await c.apiGet(`network-monitoring/v1/gateways/${encodeURIComponent(serial)}/ports`, {
        limit: 50,
      });
      return (r?.items ?? []).map(
        (x: any): CentralPortRow => ({
          name: s(x?.name),
          status: s(x?.operState) ?? s(x?.adminState),
          speedMbps: speedMbps(x?.speed),
          duplex: s(x?.duplex),
          connector: s(x?.connectorType),
          vlanMode: s(x?.portType),
          nativeVlan: s(x?.vlan),
          accessVlan: null,
          isUplink: null,
        }),
      );
    });

    return {
      ...common,
      deviceName: s(raw?.deviceName) ?? common.deviceName,
      macAddress: normalizeMac(raw?.macAddress) ?? common.macAddress,
      model: s(raw?.model) ?? common.model,
      status: s(raw?.status) ?? common.status,
      firmwareVersion: s(raw?.firmwareVersion) ?? common.firmwareVersion,
      siteName: s(raw?.siteName) ?? common.siteName,
      ipv4: s(raw?.ipAddress) ?? common.ipv4,
      publicIpv4: null,
      uptimeMs: n(raw?.uptimeInMillis) ?? common.uptimeMs,
      cpuUtilization: n1(raw?.cpuUtilization),
      memoryUtilization: n1(raw?.memoryUtilization),
      clientCount: null,
      lastRebootReason: s(raw?.rebootReason),
      negotiatedPower: null,
      mode: s(raw?.mode),
      meshRole: null,
      bandSelection: null,
      countryCode: null,
      currentUplinkInUse: null,
      hardwareHealth: [],
      poeAvailable: null,
      poeConsumption: null,
      systemTemperature: null,
      radios: UNSUPPORTED,
      ports,
      wlans: UNSUPPORTED,
    };
  }

  // 種別が判別できないデバイスは一覧行の情報だけで返す(叩くエンドポイントが決まらない)。
  return {
    ...common,
    publicIpv4: null,
    cpuUtilization: null,
    memoryUtilization: null,
    clientCount: null,
    lastRebootReason: null,
    negotiatedPower: null,
    mode: null,
    meshRole: null,
    bandSelection: null,
    countryCode: null,
    currentUplinkInUse: null,
    hardwareHealth: [],
    poeAvailable: null,
    poeConsumption: null,
    systemTemperature: null,
    radios: UNSUPPORTED,
    ports: UNSUPPORTED,
    wlans: UNSUPPORTED,
  };
}
