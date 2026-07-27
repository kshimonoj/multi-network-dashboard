// Global Overview — Juniper Mist 直接 REST クライアント(MCP を経由しない)
//
// 認証(instructions/05_findings.md に調査結果):
//   API トークン 1 本。`Authorization: Token <api-token>` ヘッダで api.ac2.mist.com を直接叩ける。
//   ~/.claude.json の mist-cloud(mcp-remote → mcp.ai.juniper.net)は同じトークンを
//   `Authorization: Bearer <token>` として MCP ゲートウェイに渡しているが、
//   Mist 本体の REST API は Bearer を受け付けない(401)。Token スキームに読み替えて使う。
//   有効期限は無く(明示的に失効させるまで有効)、リフレッシュ手続きも無い。
//
// 使うエンドポイント(すべて org スコープの bulk。1 回の refresh で 3 リクエスト):
//   1. GET /api/v1/orgs/{org}/stats/sites   … サイトごとの num_ap/num_switch/num_gateway/num_router と
//                                             それぞれの *_connected、num_clients、latlng、name まで一括で返る
//   2. GET /api/v1/orgs/{org}/stats/devices … デバイス個体の一覧(type / status / name / site_id)
//   3. GET /api/v1/orgs/{org}/alarms/search … 直近 24h のアラーム(site_id 別集計と総数に使う)
//
// レート制限:
//   Mist はレスポンスに X-RateLimit-* を返さない(実測で確認済み)。ドキュメント上の上限は
//   トークンあたり 5000 req/hour とされる。ヘッダで確認できない以上は保守的に扱い、
//   送出は 2 req/sec に自主規制する(3 req / 3 分 ≒ 60 req/hour で上限の 1.2% 程度)。

import { RateLimiter, type LimiterStats } from "./rate-limit.js";
import type {
  DetailAlert,
  DetailClient,
  DetailDevice,
  DetailEvent,
  DetailHealth,
  DetailSection,
  PlatformSiteDetail,
} from "./detail-types.js";

const DEFAULT_BASE_URL = "https://api.ac2.mist.com";
/** アラームの集計窓(既定 24 時間)。NetView の「アクティブアラート」に相当させる。 */
const ALARM_WINDOW_SEC = Number(process.env.MIST_ALARM_WINDOW_SEC ?? 86_400);

export interface MistSiteStats {
  siteId: string;
  siteName: string;
  lat: number | null;
  lng: number | null;
  numAp: number;
  numApConnected: number;
  numSwitch: number;
  numSwitchConnected: number;
  /** Mist は Gateway(SRX 等)と Router(SSR)を別カウントする。NetView 表示に合わせて合算した値。 */
  numGateway: number;
  numGatewayConnected: number;
  numClients: number;
}

export interface MistDevice {
  id: string;
  name: string | null;
  type: string;
  model: string | null;
  status: string | null;
  siteId: string | null;
}

/** org 一括で取ったアラーム 1 件(13 Task 2)。site_id はサイト名解決に使う。 */
export interface OrgAlarm {
  id: string | null;
  siteId: string | null;
  severity: string | null;
  group: string | null;
  type: string | null;
  summary: string;
  timestamp: string | null;
  deviceLabel: string | null;
}

/** org 一括で取ったイベント 1 件(デバイス / クライアント共通の形)。 */
export interface OrgEvent {
  siteId: string | null;
  timestamp: string | null;
  type: string | null;
  text: string;
  deviceLabel: string | null;
}

export interface MistRaw {
  orgId: string;
  sites: MistSiteStats[];
  devices: MistDevice[];
  /** 直近 ALARM_WINDOW_SEC のアラーム総数 */
  alarmTotal: number;
  /** site_id → アラーム件数 */
  alarmsBySite: Record<string, number>;
  requests: number;
}

function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toNullableNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export class MistClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private orgId: string;
  private readonly limiter: RateLimiter;
  private reqCounter = 0;

  constructor() {
    this.baseUrl = (process.env.MIST_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
    this.token = (process.env.MIST_API_TOKEN ?? "").trim();
    if (!this.token) throw new Error("MIST_API_TOKEN が未設定です(.env に設定してください)");
    this.orgId = (process.env.MIST_ORG_ID ?? "").trim();
    this.limiter = new RateLimiter({
      label: "mist",
      ratePerSec: Number(process.env.MIST_RATE_PER_SEC ?? 2),
      burst: Number(process.env.MIST_RATE_BURST ?? 2),
      maxRetries: 3,
    });
  }

  static isConfigured(): boolean {
    return Boolean((process.env.MIST_API_TOKEN ?? "").trim());
  }

  getLimiterStats(): LimiterStats {
    return this.limiter.getStats();
  }

  private async get(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    this.reqCounter += 1;
    const res = await this.limiter.fetch(url.toString(), {
      headers: { Authorization: `Token ${this.token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Mist ${path} が HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return res.json();
  }

  /**
   * org_id を解決する。MIST_ORG_ID があればそれを使い、無ければ /api/v1/self の
   * privileges から scope="org" の先頭を採用してプロセス内にキャッシュする。
   */
  private async resolveOrgId(): Promise<string> {
    if (this.orgId) return this.orgId;
    const self = await this.get("api/v1/self");
    const priv = (self?.privileges ?? []).find((p: any) => p?.scope === "org" && p?.org_id);
    if (!priv) throw new Error("Mist: /api/v1/self に org スコープの privilege がありません");
    this.orgId = String(priv.org_id);
    console.log(`[global-overview/mist] org_id を self から解決しました(MIST_ORG_ID に固定すると 1 リクエスト減ります)`);
    return this.orgId;
  }

  /**
   * ダッシュボード 1 画面ぶんのデータを bulk で取得する。
   * 出す HTTP リクエストは 3 本(MIST_ORG_ID 未設定なら self 解決の 1 本が初回だけ増える)。
   */
  async getRaw(): Promise<MistRaw> {
    const before = this.reqCounter;
    const orgId = await this.resolveOrgId();

    const end = Math.floor(Date.now() / 1000);
    const start = end - ALARM_WINDOW_SEC;

    const siteStats = await this.get(`api/v1/orgs/${orgId}/stats/sites`, { limit: 1000 });
    const deviceStats = await this.get(`api/v1/orgs/${orgId}/stats/devices`, { type: "all", limit: 1000 });
    const alarms = await this.get(`api/v1/orgs/${orgId}/alarms/search`, { start, end, limit: 1000 });

    const sites: MistSiteStats[] = (Array.isArray(siteStats) ? siteStats : []).map((s: any) => ({
      siteId: String(s?.id ?? ""),
      siteName: String(s?.name ?? ""),
      lat: toNullableNum(s?.latlng?.lat),
      lng: toNullableNum(s?.latlng?.lng),
      numAp: toNum(s?.num_ap),
      numApConnected: toNum(s?.num_ap_connected),
      numSwitch: toNum(s?.num_switch),
      numSwitchConnected: toNum(s?.num_switch_connected),
      // Mist の Gateway(SRX 等)と Router(SSR)を NetView の「Gateway」枠に合算する。
      numGateway: toNum(s?.num_gateway) + toNum(s?.num_router),
      numGatewayConnected: toNum(s?.num_gateway_connected) + toNum(s?.num_router_connected),
      numClients: toNum(s?.num_clients),
    }));

    const deviceItems: any[] = Array.isArray(deviceStats)
      ? deviceStats
      : Array.isArray(deviceStats?.results)
        ? deviceStats.results
        : [];
    const devices: MistDevice[] = deviceItems.map((d: any) => ({
      id: String(d?.id ?? d?.mac ?? ""),
      name: d?.name ?? d?.hostname ?? null,
      type: String(d?.type ?? "unknown"),
      model: d?.model ?? null,
      status: d?.status ?? null,
      siteId: d?.site_id != null ? String(d.site_id) : null,
    }));

    const alarmResults: any[] = Array.isArray(alarms?.results) ? alarms.results : [];
    const alarmsBySite: Record<string, number> = {};
    for (const a of alarmResults) {
      const sid = a?.site_id ? String(a.site_id) : "";
      if (!sid) continue;
      alarmsBySite[sid] = (alarmsBySite[sid] ?? 0) + 1;
    }

    return {
      orgId,
      sites: sites.filter((s) => s.siteId),
      devices,
      alarmTotal: toNum(alarms?.total ?? alarmResults.length),
      alarmsBySite,
      requests: this.reqCounter - before,
    };
  }

  /**
   * サイト 1 件ぶんの詳細(11 番。オンデマンド)。ポーラーからは呼ばれない。
   * 出す HTTP は 5 本(sites-sle / clients / devices / alarms / device-events)。
   * SLE は org 一括(insights/sites-sle)で返るのを site_id で引く(05/06 の「null」を解消)。
   * 各セクションは独立に取得し、片方が失敗してももう片方は返す。
   */
  async getSiteDetail(siteId: string): Promise<PlatformSiteDetail> {
    const before = this.reqCounter;
    const orgId = await this.resolveOrgId();
    const end = Math.floor(Date.now() / 1000);
    const start = end - ALARM_WINDOW_SEC;

    const [health, clients, devices, alerts, events] = await Promise.all([
      this.fetchMistHealth(orgId, siteId, start, end),
      this.fetchMistClients(siteId),
      this.fetchMistDevices(siteId),
      this.fetchMistAlarms(siteId, start, end),
      this.fetchMistEvents(siteId, start, end),
    ]);

    return { health, clients, devices, alerts, events, requests: this.reqCounter - before };
  }

  private async fetchMistHealth(
    orgId: string,
    siteId: string,
    start: number,
    end: number,
  ): Promise<DetailHealth> {
    // SLE 各指標(0-1)。総合は取得できた指標の平均 ×100。
    const METRICS: Array<{ key: string; label: string }> = [
      { key: "coverage", label: "Coverage" },
      { key: "capacity", label: "Capacity" },
      { key: "throughput", label: "Throughput" },
      { key: "roaming", label: "Roaming" },
      { key: "time-to-connect", label: "Time to Connect" },
      { key: "successful-connect", label: "Successful Connect" },
      { key: "ap-health", label: "AP Health" },
    ];
    try {
      const res = await this.get(`api/v1/orgs/${orgId}/insights/sites-sle`, { start, end });
      const row = (res?.results ?? []).find((r: any) => String(r?.site_id ?? "") === siteId);
      if (!row) {
        return { score: null, source: "mist-sle", metrics: [], status: "ok", error: null };
      }
      const metrics = METRICS.map((m) => {
        const v = toNullableNum(row[m.key]);
        return { label: m.label, value: v === null ? null : Math.round(v * 100), unit: "%" };
      });
      const vals = metrics.map((m) => m.value).filter((v): v is number => v !== null);
      const score = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
      return { score, source: "mist-sle", metrics, status: "ok", error: null };
    } catch (err) {
      return { score: null, source: "mist-sle", metrics: [], status: "error", error: msgOf(err) };
    }
  }

  private async fetchMistClients(siteId: string): Promise<DetailSection<DetailClient>> {
    try {
      const res = await this.get(`api/v1/sites/${siteId}/stats/clients`, { limit: 100 });
      const arr: any[] = Array.isArray(res) ? res : Array.isArray(res?.results) ? res.results : [];
      const items: DetailClient[] = arr.map((c: any) => ({
        mac: String(c?.mac ?? ""),
        name: c?.hostname || c?.name || null,
        os: c?.os || null,
        // Mist の band は "24" / "5" / "6"(GHz)。2.4 は "24" で来るので読み替える。
        band: c?.band ? `${c.band === "24" ? "2.4" : c.band} GHz` : null,
        channel: toNullableNum(c?.channel),
        snr: toNullableNum(c?.snr),
        rssi: toNullableNum(c?.rssi),
        ssid: c?.ssid ?? null,
        status: "connected",
        ip: c?.ip ?? null,
        connectedTo: c?.ap_mac ?? null,
        vendor: c?.manufacture || null,
      }));
      return { status: "ok", error: null, items };
    } catch (err) {
      return { status: "error", error: msgOf(err), items: [] };
    }
  }

  private async fetchMistDevices(siteId: string): Promise<DetailSection<DetailDevice>> {
    try {
      const res = await this.get(`api/v1/sites/${siteId}/stats/devices`, { type: "all", limit: 100 });
      const arr: any[] = Array.isArray(res) ? res : Array.isArray(res?.results) ? res.results : [];
      const items: DetailDevice[] = arr.map((d: any) => {
        const type = String(d?.type ?? "").toLowerCase();
        const kind: DetailDevice["kind"] =
          type === "ap" ? "ap" : type === "switch" ? "switch" : type === "gateway" ? "gateway" : "other";
        return {
          id: String(d?.id ?? d?.mac ?? ""),
          name: d?.name ?? null,
          kind,
          model: d?.model ?? null,
          status: d?.status ?? null,
          up: String(d?.status ?? "").toLowerCase() === "connected",
          firmware: d?.version ?? null,
          // Mist の uptime は秒。ms に揃える。
          uptimeMs: d?.uptime != null ? toNum(d.uptime) * 1000 : null,
          ip: d?.ip ?? null,
          mac: d?.mac ?? null,
          numClients: toNullableNum(d?.num_clients),
        };
      });
      return { status: "ok", error: null, items };
    } catch (err) {
      return { status: "error", error: msgOf(err), items: [] };
    }
  }

  private async fetchMistAlarms(
    siteId: string,
    start: number,
    end: number,
  ): Promise<DetailSection<DetailAlert>> {
    try {
      const res = await this.get(`api/v1/sites/${siteId}/alarms/search`, { start, end, limit: 100 });
      const arr: any[] = Array.isArray(res?.results) ? res.results : [];
      const items: DetailAlert[] = arr.map((a: any) => ({
        id: a?.id != null ? String(a.id) : null,
        severity: a?.severity ?? null,
        category: a?.group ?? null,
        summary: String(a?.type ?? "(alarm)") + (a?.count ? ` ×${a.count}` : ""),
        type: a?.type ?? null,
        createdAt: a?.timestamp ? new Date(toNum(a.timestamp) * 1000).toISOString() : null,
        deviceLabel: Array.isArray(a?.hostnames) ? a.hostnames.join(", ") : (a?.hostnames ?? null),
      }));
      return { status: "ok", error: null, items, note: `直近 ${Math.round(ALARM_WINDOW_SEC / 3600)}h` };
    } catch (err) {
      return { status: "error", error: msgOf(err), items: [] };
    }
  }

  private async fetchMistEvents(
    siteId: string,
    start: number,
    end: number,
  ): Promise<DetailSection<DetailEvent>> {
    try {
      const res = await this.get(`api/v1/sites/${siteId}/devices/events/search`, {
        start,
        end,
        limit: 50,
      });
      const arr: any[] = Array.isArray(res?.results) ? res.results : [];
      const items: DetailEvent[] = arr.map((e: any) => ({
        timestamp: e?.timestamp ? new Date(toNum(e.timestamp) * 1000).toISOString() : null,
        type: e?.type ?? null,
        text: String(e?.text ?? e?.type ?? ""),
        deviceLabel: e?.device_type
          ? `${e.device_type}${e?.ap ? " " + e.ap : e?.mac ? " " + e.mac : ""}`
          : (e?.mac ?? null),
        // Mist のデバイスイベントは severity/category を持たない。
        severity: null,
        category: null,
      }));
      return { status: "ok", error: null, items, note: `直近 ${Math.round(ALARM_WINDOW_SEC / 3600)}h・デバイスイベント` };
    } catch (err) {
      return { status: "error", error: msgOf(err), items: [] };
    }
  }

  /** プロセス起動以降に出した HTTP リクエストの累計(feed の requests 計上に使う)。 */
  getRequestCount(): number {
    return this.reqCounter;
  }

  /**
   * 全サイト横断 Event/Alert 一覧(13 Task 2)用。Mist は 3 種とも org スコープの窓口があり、
   * 22 サイトぶんが 3 リクエストで返る(site 単位のループは不要)。
   *   - orgs/{org}/alarms/search         … アラーム(site_id 付き)
   *   - orgs/{org}/devices/events/search … デバイスイベント(site_id 付き)
   *   - orgs/{org}/clients/events/search … クライアントイベント(site_id 付き)
   * いずれも結果に site_id が入るので、呼び出し側でサイト名に解決できる。
   */
  async fetchOrgAlarms(start: number, end: number, limit: number): Promise<{ items: OrgAlarm[]; total: number | null }> {
    const orgId = await this.resolveOrgId();
    const res = await this.get(`api/v1/orgs/${orgId}/alarms/search`, { start, end, limit });
    const arr: any[] = Array.isArray(res?.results) ? res.results : [];
    return {
      items: arr.map((a: any) => ({
        id: a?.id != null ? String(a.id) : null,
        siteId: a?.site_id != null ? String(a.site_id) : null,
        severity: a?.severity ?? null,
        group: a?.group ?? null,
        type: a?.type ?? null,
        summary: String(a?.type ?? "(alarm)") + (a?.count ? ` ×${a.count}` : ""),
        timestamp: a?.timestamp ? new Date(toNum(a.timestamp) * 1000).toISOString() : null,
        deviceLabel: Array.isArray(a?.hostnames) ? a.hostnames.join(", ") : (a?.hostnames ?? null),
      })),
      total: toNullableNum(res?.total),
    };
  }

  async fetchOrgDeviceEvents(start: number, end: number, limit: number): Promise<{ items: OrgEvent[]; total: number | null }> {
    const orgId = await this.resolveOrgId();
    const res = await this.get(`api/v1/orgs/${orgId}/devices/events/search`, { start, end, limit });
    const arr: any[] = Array.isArray(res?.results) ? res.results : [];
    return {
      items: arr.map((e: any) => ({
        siteId: e?.site_id != null ? String(e.site_id) : null,
        timestamp: e?.timestamp ? new Date(toNum(e.timestamp) * 1000).toISOString() : null,
        type: e?.type ?? null,
        text: String(e?.text ?? e?.type ?? ""),
        deviceLabel: e?.device_type
          ? `${e.device_type}${e?.ap ? " " + e.ap : e?.mac ? " " + e.mac : ""}`
          : (e?.mac ?? null),
      })),
      total: toNullableNum(res?.total),
    };
  }

  async fetchOrgClientEvents(start: number, end: number, limit: number): Promise<{ items: OrgEvent[]; total: number | null }> {
    const orgId = await this.resolveOrgId();
    const res = await this.get(`api/v1/orgs/${orgId}/clients/events/search`, { start, end, limit });
    const arr: any[] = Array.isArray(res?.results) ? res.results : [];
    return {
      items: arr.map((e: any) => {
        const meta: string[] = [];
        if (e?.ssid) meta.push(String(e.ssid));
        if (e?.band) meta.push(`${e.band === "24" ? "2.4" : e.band}GHz`);
        if (e?.channel != null) meta.push(`ch${e.channel}`);
        if (e?.rssi != null) meta.push(`${e.rssi}dBm`);
        const base = e?.text ? String(e.text) : e?.type ? String(e.type) : "";
        return {
          siteId: e?.site_id != null ? String(e.site_id) : null,
          timestamp: e?.timestamp ? new Date(toNum(e.timestamp) * 1000).toISOString() : null,
          type: e?.type ?? null,
          text: base + (meta.length ? ` (${meta.join(" · ")})` : ""),
          deviceLabel: e?.mac ? `client ${e.mac}` : (e?.ap ? `AP ${e.ap}` : null),
        };
      }),
      total: toNullableNum(res?.total),
    };
  }

  /**
   * クライアント 1 件のイベント履歴(Task 3。オンデマンド)。追加 HTTP は 1 本。
   * clients/events/search を mac で絞る。ローミング/接続品質イベント(type/rssi/channel/ssid/ap/text)。
   */
  async fetchMistClientEvents(siteId: string, mac: string): Promise<DetailSection<DetailEvent>> {
    const end = Math.floor(Date.now() / 1000);
    const start = end - ALARM_WINDOW_SEC;
    try {
      const res = await this.get(`api/v1/sites/${siteId}/clients/events/search`, {
        mac,
        start,
        end,
        limit: 30,
      });
      const arr: any[] = Array.isArray(res?.results) ? res.results : [];
      const items: DetailEvent[] = arr.map((e: any) => {
        const meta: string[] = [];
        if (e?.ssid) meta.push(String(e.ssid));
        if (e?.band) meta.push(`${e.band === "24" ? "2.4" : e.band}GHz`);
        if (e?.channel != null) meta.push(`ch${e.channel}`);
        if (e?.rssi != null) meta.push(`${e.rssi}dBm`);
        const base = e?.text ? String(e.text) : e?.type ? String(e.type) : "";
        return {
          timestamp: e?.timestamp ? new Date(toNum(e.timestamp) * 1000).toISOString() : null,
          type: e?.type ?? null,
          text: base + (meta.length ? ` (${meta.join(" · ")})` : ""),
          deviceLabel: e?.ap ? `AP ${e.ap}` : (e?.bssid ?? null),
          severity: null,
          category: null,
        };
      });
      return { status: "ok", error: null, items, note: `直近 ${Math.round(ALARM_WINDOW_SEC / 3600)}h` };
    } catch (err) {
      return { status: "error", error: msgOf(err), items: [] };
    }
  }
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
