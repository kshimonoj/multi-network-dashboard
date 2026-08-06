// Global Overview — HPE Aruba Networking Central 直接 REST クライアント(MCP を経由しない)
//
// 認証(instructions/05_findings.md に調査結果):
//   OAuth2 client_credentials。client_id / client_secret を HTTP Basic で
//   https://sso.common.cloud.hpe.com/as/token.oauth2 に POST し、Bearer アクセストークンを得る。
//   実測で expires_in = 7199 秒(約 2 時間)。リフレッシュトークンは無く、
//   失効したら同じ client_credentials で取り直す。
//   ※ central-mcp-server(pycentral)が内部でやっているのと同じフロー。
//
// 使うエンドポイント(すべて bulk。1 回の refresh で 3 リクエストしか出さない):
//   1. GET network-monitoring/v1/sites-health   … サイト一覧 + 位置 + health + devices/clients の件数
//   2. GET network-monitoring/v1/devices        … 全デバイス(deviceType / status / siteName)。ベンダー別台数の元
//   3. GET network-notifications/v1/alerts      … status eq 'Active' のアラート。総数 + siteName 別内訳
//
// アラート件数の出どころについて(実測で判明):
//   sites-health の alerts.totalCount は Active アラートの内訳と一致しない。
//   例: Active アラートが立っているサイトでも sites-health 側は 0 を返すことがあった。
//   → サイト別・全体ともに network-notifications/v1/alerts(Active 絞り込み)を正とし、
//     sites-health の alerts は使わない。
//
// 既知の落とし穴(central-mcp-http/PATCHES.md と同じ):
//   sites-health 系 3 エンドポイントは `next` クエリパラメータを受け付けず、
//   付けると 400 HPE_GL_NETWORKING_ERROR_INVALID_QUERY_PARAMETER になる。
//   → ここでは `next` を一切付けない(limit=100 の 1 ページで足りる規模)。

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

const DEFAULT_TOKEN_URL = "https://sso.common.cloud.hpe.com/as/token.oauth2";
// アクセストークンは expires_in より少し早めに捨てる(時計ずれ・往復時間の余裕)。
const TOKEN_EXPIRY_SKEW_MS = 120_000;
/** Event の集計窓(既定 24 時間)。Mist の ALARM_WINDOW と揃える。 */
const EVENT_WINDOW_SEC = Number(process.env.CENTRAL_EVENT_WINDOW_SEC ?? 86_400);

export interface CentralDevice {
  serialNumber: string;
  deviceName: string | null;
  deviceType: "ACCESS_POINT" | "SWITCH" | "GATEWAY" | string;
  status: string | null;
  model: string | null;
  siteName: string | null;
  siteId: string | null;
}

export interface CentralSiteHealth {
  siteId: string | null;
  siteName: string;
  lat: number | null;
  lng: number | null;
  /** 0-100。sites-health の health.groups(Poor/Fair/Good の百分率)から算出。 */
  healthScore: number | null;
  deviceCount: number;
  clientCount: number;
}

export interface CentralRaw {
  sites: CentralSiteHealth[];
  devices: CentralDevice[];
  /** Active アラートの総数(alerts エンドポイントの total) */
  activeAlertTotal: number;
  /** siteName → Active アラート件数 */
  alertsBySite: Record<string, number>;
  /** siteName → Critical な Active アラート件数 */
  criticalAlertsBySite: Record<string, number>;
  /** この refresh で実際に出した HTTP リクエスト数(トークン取得を含む) */
  requests: number;
}

function envOrThrow(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) throw new Error(`${name} が未設定です(.env に設定してください)`);
  return v;
}

function toNum(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * sites-health の health.groups は [{name:"Poor",value:0},{name:"Fair",value:0},{name:"Good",value:100}]
 * のような「割合(%)」。Good を 100 点、Fair を 50 点、Poor を 0 点として加重平均する。
 * (central-mcp-server の compute_health_score と同じ考え方)
 */
function computeHealthScore(groups: Array<{ name?: string; value?: unknown }> | undefined): number | null {
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const g: Record<string, number> = {};
  for (const item of groups) {
    const n = toNum(item?.value);
    if (item?.name && n !== null) g[item.name] = n;
  }
  const total = (g.Poor ?? 0) + (g.Fair ?? 0) + (g.Good ?? 0);
  if (total <= 0) return null;
  return Math.round(((g.Good ?? 0) * 100 + (g.Fair ?? 0) * 50) / total);
}

export class CentralClient {
  private readonly baseUrl: string;
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly limiter: RateLimiter;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;
  /** getRaw() 1 回で出した HTTP リクエスト数を数えるためのカウンタ */
  private reqCounter = 0;

  constructor() {
    this.baseUrl = envOrThrow("CENTRAL_BASE_URL").replace(/\/+$/, "");
    this.tokenUrl = (process.env.CENTRAL_TOKEN_URL ?? DEFAULT_TOKEN_URL).trim();
    this.clientId = envOrThrow("CENTRAL_CLIENT_ID");
    this.clientSecret = envOrThrow("CENTRAL_CLIENT_SECRET");
    this.limiter = new RateLimiter({
      label: "central",
      // アカウント全体で 10 req/sec(実測ヘッダ)。central-mcp-http と共有するため 4 req/sec に自主規制。
      ratePerSec: Number(process.env.CENTRAL_RATE_PER_SEC ?? 4),
      burst: Number(process.env.CENTRAL_RATE_BURST ?? 4),
      maxRetries: 3,
    });
  }

  static isConfigured(): boolean {
    return Boolean(
      (process.env.CENTRAL_BASE_URL ?? "").trim() &&
        (process.env.CENTRAL_CLIENT_ID ?? "").trim() &&
        (process.env.CENTRAL_CLIENT_SECRET ?? "").trim(),
    );
  }

  getLimiterStats(): LimiterStats {
    return this.limiter.getStats();
  }

  /** アクセストークンを返す(有効なものがあれば使い回す。同時取得は 1 本にまとめる)。 */
  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    if (this.tokenInFlight) return this.tokenInFlight;

    this.tokenInFlight = (async () => {
      const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
      this.reqCounter += 1;
      const res = await this.limiter.fetch(this.tokenUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
      });
      if (!res.ok) {
        throw new Error(`Central トークン取得に失敗: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
      const body = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!body.access_token) throw new Error("Central トークン応答に access_token がありません");
      const ttlMs = (body.expires_in ?? 3600) * 1000;
      this.token = { value: body.access_token, expiresAt: Date.now() + Math.max(60_000, ttlMs - TOKEN_EXPIRY_SKEW_MS) };
      return this.token.value;
    })().finally(() => {
      this.tokenInFlight = null;
    });

    return this.tokenInFlight;
  }

  /** GET 1 本。401 のときだけトークンを捨てて 1 回だけ取り直す。 */
  private async get(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.getToken();
      this.reqCounter += 1;
      const res = await this.limiter.fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (res.status === 401 && attempt === 0) {
        this.token = null; // 期限切れ扱いで取り直す
        continue;
      }
      if (!res.ok) {
        throw new Error(`Central ${path} が HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      return res.json();
    }
    throw new Error(`Central ${path}: 認証に失敗しました(401 が続く)`);
  }

  /**
   * 任意の monitoring エンドポイントを 1 本叩く(59: タグ付き Client/Device タブ用)。
   *
   * このクラスはトークンのキャッシュとレート制御(rate-limit.ts)を持っているので、
   * 別プラグインが Central を直接叩くときも必ずここを通す(57 §2-4)。
   * **読み取り(GET)専用**。設定変更の口はこのクラスに持たせない。
   *
   * @throws 404 等の非 2xx はメッセージに HTTP ステータスを含む Error になる。
   *         「見つからない」を分岐したい呼び出し元は isNotFound() を使う。
   */
  async apiGet(path: string, params: Record<string, string | number> = {}): Promise<any> {
    return this.get(path, params);
  }

  /**
   * ダッシュボード 1 画面ぶんのデータを bulk で取得する。
   * 出す HTTP リクエストは 3 本(+ トークンが切れていればトークン取得 1 本)。
   */
  async getRaw(): Promise<CentralRaw> {
    const before = this.reqCounter;

    // sites-health は `next` を受け付けない(400 になる)。limit のみ。
    const sitesRes = await this.get("network-monitoring/v1/sites-health", { limit: 100 });
    const devicesRes = await this.get("network-monitoring/v1/devices", { limit: 1000, next: 1 });
    // limit=100 は alerts エンドポイントの上限。これを超える件数になった場合は
    // total(全体数)は正しく、サイト別内訳だけが先頭 100 件ぶんになる。
    const alertsRes = await this.get("network-notifications/v1/alerts", {
      limit: 100,
      filter: "status eq 'Active'",
    });

    const sites: CentralSiteHealth[] = (sitesRes?.items ?? []).map((s: any) => ({
      siteId: s?.id != null ? String(s.id) : null,
      siteName: String(s?.siteName ?? ""),
      lat: toNum(s?.location?.latitude),
      lng: toNum(s?.location?.longitude),
      healthScore: computeHealthScore(s?.health?.groups),
      deviceCount: toNum(s?.devices?.count) ?? 0,
      clientCount: toNum(s?.clients?.count) ?? 0,
    }));

    const devices: CentralDevice[] = (devicesRes?.items ?? []).map((d: any) => ({
      serialNumber: String(d?.serialNumber ?? d?.id ?? ""),
      deviceName: d?.deviceName ?? null,
      deviceType: String(d?.deviceType ?? "UNKNOWN"),
      status: d?.status ?? null,
      model: d?.model ?? null,
      siteName: d?.siteName ?? null,
      siteId: d?.siteId != null ? String(d.siteId) : null,
    }));

    // アラートは siteName でのみサイトに紐づく(siteId フィールドは応答に無い)。
    const alertsBySite: Record<string, number> = {};
    const criticalAlertsBySite: Record<string, number> = {};
    for (const a of alertsRes?.items ?? []) {
      const name = a?.siteName ? String(a.siteName) : "";
      if (!name) continue;
      alertsBySite[name] = (alertsBySite[name] ?? 0) + 1;
      if (String(a?.severity ?? "").toLowerCase() === "critical") {
        criticalAlertsBySite[name] = (criticalAlertsBySite[name] ?? 0) + 1;
      }
    }

    return {
      sites: sites.filter((s) => s.siteName),
      devices,
      activeAlertTotal: toNum(alertsRes?.total) ?? 0,
      alertsBySite,
      criticalAlertsBySite,
      requests: this.reqCounter - before,
    };
  }

  /**
   * サイト 1 件ぶんの詳細(11 番。オンデマンド)。ポーラーからは呼ばれない。
   * 出す HTTP は 5 本(health / clients / devices / alerts / events)。各セクションは独立に取得し、
   * 片方が失敗してももう片方は返す(status="error" で理由を載せる)。
   * Event は network-troubleshooting/v1/events(context-type=SITE)から取得する(12 番で判明)。
   */
  async getSiteDetail(siteId: string, siteName: string): Promise<PlatformSiteDetail> {
    const before = this.reqCounter;
    // OData 風 filter の文字列リテラルは単一引用符を 2 個重ねてエスケープする。
    const nameLit = `'${siteName.replace(/'/g, "''")}'`;

    const [health, clients, devices, alerts, events] = await Promise.all([
      this.fetchCentralHealth(nameLit),
      this.fetchCentralClients(siteId),
      this.fetchCentralDevices(siteId),
      this.fetchCentralAlerts(siteName),
      this.fetchCentralEvents(siteId),
    ]);

    return { health, clients, devices, alerts, events, requests: this.reqCounter - before };
  }

  /** プロセス起動以降に出した HTTP リクエストの累計(feed の requests 計上に使う)。 */
  getRequestCount(): number {
    return this.reqCounter;
  }

  /**
   * 全サイト横断 Event/Alert 一覧(13 Task 2)用。org 単位で 1 本の HTTP。
   * alerts はもともと org スコープ(siteName/siteId で filter できない)なので、
   * 22 サイトぶんが 1 リクエストで返る。status 指定なしで Active + Cleared 両方を取る。
   */
  async fetchAllAlerts(limit = 100): Promise<{ items: Array<DetailAlert & { siteName: string; state: string | null }>; total: number | null }> {
    const res = await this.get("network-notifications/v1/alerts", { limit });
    const items = (res?.items ?? []).map((a: any) => ({
      id: a?.id != null ? String(a.id) : null,
      severity: a?.severity ?? null,
      category: a?.category ?? null,
      summary: String(a?.summary ?? a?.name ?? a?.type ?? "(no summary)"),
      type: cleanStr(a?.name) || a?.type || null,
      createdAt: a?.createdAt ?? null,
      deviceLabel: a?.deviceType ?? null,
      siteName: String(a?.siteName ?? ""),
      state: a?.status ?? null,
    }));
    return { items, total: toNum(res?.total) };
  }

  /**
   * 全サイト横断 Event/Alert 一覧(13 Task 2)用のサイト 1 件ぶんイベント。
   * Central の events は site-id が必須で org 一括の窓口が無いため、呼び出し側でサイト数ぶん回す。
   */
  async fetchSiteEvents(siteId: string, limit: number): Promise<DetailSection<DetailEvent>> {
    return this.fetchCentralEvents(siteId, { limit });
  }

  /**
   * クライアント 1 件のイベント履歴(Task 3。オンデマンド)。追加 HTTP は 1 本。
   * context-type=WIRELESS_CLIENT + context-identifier=<mac> で当該クライアントに絞る。
   */
  async fetchCentralClientEvents(siteId: string, mac: string): Promise<DetailSection<DetailEvent>> {
    const before = this.reqCounter;
    const sec = await this.fetchCentralEvents(siteId, { contextType: "WIRELESS_CLIENT", contextId: mac, limit: 30 });
    // 呼び出し元(client-detail)が HTTP 本数を数えられるよう requests は section には載せない。
    void before;
    return sec;
  }

  /**
   * network-troubleshooting/v1/events を叩いて DetailEvent[] を作る。
   * 既定はサイト全体(context-type=SITE)。クライアント/デバイス単位に絞るときは opts を渡す。
   */
  private async fetchCentralEvents(
    siteId: string,
    opts: { contextType?: string; contextId?: string; limit?: number } = {},
  ): Promise<DetailSection<DetailEvent>> {
    const end = Date.now();
    const start = end - EVENT_WINDOW_SEC * 1000;
    const contextType = opts.contextType ?? "SITE";
    const contextId = opts.contextId ?? siteId;
    try {
      // 必須は context-type / context-identifier / site-id / start-at / end-at / limit の 6 個(1 つ欠けても 400)。
      const res = await this.get("network-troubleshooting/v1/events", {
        "context-type": contextType,
        "context-identifier": contextId,
        "site-id": siteId,
        "start-at": new Date(start).toISOString(),
        "end-at": new Date(end).toISOString(),
        limit: opts.limit ?? 50,
        sort: "timeAt desc",
      });
      const arr: any[] = Array.isArray(res?.events) ? res.events : [];
      const items: DetailEvent[] = arr.map((e: any) => ({
        timestamp: e?.timeAt ?? null,
        type: e?.eventName ?? e?.category ?? null,
        text: cleanStr(e?.description) || cleanStr(e?.reason) || cleanStr(e?.eventName) || "(event)",
        deviceLabel:
          cleanStr(e?.sourceName) ||
          e?.serialNumber ||
          e?.deviceMacAddress ||
          e?.clientMacAddress ||
          null,
        severity: e?.severity ?? null,
        category: e?.category ?? null,
      }));
      const hours = Math.round(EVENT_WINDOW_SEC / 3600);
      const total = toNum(res?.total);
      const note =
        total !== null && total > items.length
          ? `直近 ${hours}h・全 ${total} 件中 ${items.length} 件`
          : `直近 ${hours}h`;
      return { status: "ok", error: null, items, note };
    } catch (err) {
      return { status: "error", error: msgOf(err), items: [] };
    }
  }

  private async fetchCentralHealth(nameLit: string): Promise<DetailHealth> {
    try {
      const res = await this.get("network-monitoring/v1/sites-health", {
        limit: 5,
        filter: `siteName eq ${nameLit}`,
      });
      const item = (res?.items ?? [])[0];
      const groups: Array<{ name?: string; value?: unknown }> = item?.health?.groups ?? [];
      const score = computeHealthScore(groups);
      const metrics = groups
        .filter((g) => g?.name)
        .map((g) => ({ label: String(g.name), value: toNum(g.value), unit: "%" }));
      return { score, source: "central-groups", metrics, status: "ok", error: null };
    } catch (err) {
      return { score: null, source: null, metrics: [], status: "error", error: msgOf(err) };
    }
  }

  private async fetchCentralClients(siteId: string): Promise<DetailSection<DetailClient>> {
    try {
      const res = await this.get("network-monitoring/v1/clients", { limit: 100, "site-id": siteId });
      const items: DetailClient[] = (res?.items ?? []).map((c: any) => ({
        mac: String(c?.macAddress ?? c?.id ?? ""),
        name: c?.clientName ?? c?.hostName ?? null,
        os: c?.clientOperatingSystem ?? null,
        band: c?.wirelessBand ?? null,
        channel: toNum(c?.wirelessChannel),
        snr: toNum(c?.snr),
        rssi: null,
        ssid: c?.wlanName ?? null,
        status: c?.status ?? null,
        ip: c?.ipv4 ?? c?.ipv6 ?? null,
        connectedTo: c?.connectedTo ?? c?.connectedDeviceSerial ?? null,
        vendor: c?.clientVendor ?? c?.clientManufacturer ?? null,
      }));
      return { status: "ok", error: null, items };
    } catch (err) {
      return { status: "error", error: msgOf(err), items: [] };
    }
  }

  private async fetchCentralDevices(siteId: string): Promise<DetailSection<DetailDevice>> {
    try {
      const res = await this.get("network-monitoring/v1/devices", {
        limit: 100,
        next: 1,
        filter: `siteId eq '${siteId}'`,
      });
      const items: DetailDevice[] = (res?.items ?? []).map((d: any) => {
        const type = String(d?.deviceType ?? "").toUpperCase();
        const kind: DetailDevice["kind"] =
          type === "ACCESS_POINT" || type === "AP"
            ? "ap"
            : type === "SWITCH"
              ? "switch"
              : type === "GATEWAY"
                ? "gateway"
                : "other";
        return {
          id: String(d?.serialNumber ?? d?.id ?? ""),
          name: d?.deviceName ?? null,
          kind,
          model: d?.model ?? null,
          status: d?.status ?? null,
          up: String(d?.status ?? "").toUpperCase() === "ONLINE",
          firmware: d?.firmwareVersion ?? null,
          uptimeMs: toNum(d?.uptimeInMillis),
          ip: d?.ipv4 ?? d?.ipv6 ?? null,
          mac: d?.macAddress ?? null,
          numClients: null,
        };
      });
      return { status: "ok", error: null, items };
    } catch (err) {
      return { status: "error", error: msgOf(err), items: [] };
    }
  }

  private async fetchCentralAlerts(siteName: string): Promise<DetailSection<DetailAlert>> {
    try {
      // alerts は siteName / siteId での filter が不可。Active を取ってクライアント側で絞る。
      const res = await this.get("network-notifications/v1/alerts", {
        limit: 100,
        filter: "status eq 'Active'",
      });
      const items: DetailAlert[] = (res?.items ?? [])
        .filter((a: any) => String(a?.siteName ?? "") === siteName)
        .map((a: any) => ({
          id: a?.id != null ? String(a.id) : null,
          severity: a?.severity ?? null,
          category: a?.category ?? null,
          summary: String(a?.summary ?? a?.name ?? a?.type ?? "(no summary)"),
          type: a?.type ?? null,
          createdAt: a?.createdAt ?? null,
          deviceLabel: a?.deviceType ?? null,
        }));
      return { status: "ok", error: null, items, note: "status = Active(未解消)" };
    } catch (err) {
      return { status: "error", error: msgOf(err), items: [] };
    }
  }
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Central のイベント文字列を整える。sourceName 等に NUL バイトのパディングが
 * 載ることがある(例 "iPad…")ので除去してトリムする。
 */
function cleanStr(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f]+/g, "").trim();
}
