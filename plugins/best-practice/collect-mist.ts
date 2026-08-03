/**
 * Mist 側の設定収集。
 *
 * Central と違い show コマンドのパースもファーム世代の分岐も要らない
 * (`get_mist_config` が構造化 JSON を返す。49 §2-5)。
 * 代わりに「どの設定がそのサイトに効いているか」の解決が要る:
 *
 *   サイト → rftemplate_id                     … サイトオブジェクトが直接持っている
 *   サイト → 有効な WLAN                       … wlantemplates[].applies / exceptions を解決し、
 *                                                 さらにサイトスコープの WLAN を足す
 *
 * 機微情報: Mist MCP は psk / keys を伏字にして返すが、こちらでも
 * **値は一切取り込まない**(`hasPsk` の真偽値だけ)。Central と同じ規約。
 */

import { connectMcpTools, type McpToolSession } from "../network-investigation/ollama-mcp-client.js";
import type {
  Band,
  CollectionStep,
  MistApMeta,
  MistBandConfig,
  MistRfTemplate,
  MistSiteSnapshot,
  MistWlanConfig,
} from "./types.js";

const TOOL = {
  config: "mcp__mist-cloud__get_mist_config",
  stats: "mcp__mist-cloud__get_mist_stats",
  self: "mcp__mist-cloud__get_mist_self",
} as const;

const DETAIL_MAX = 300;

function truncate(s: string, max = DETAIL_MAX): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function parseJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchConfig(
  session: McpToolSession,
  args: Record<string, unknown>,
  key: string,
  steps: CollectionStep[],
): Promise<any | null> {
  const t0 = Date.now();
  const res = await session.callTool(TOOL.config, args);
  const parsed = res.isError ? null : parseJson(res.text);
  steps.push({
    key,
    status: parsed ? "ok" : "error",
    durationMs: Date.now() - t0,
    ...(parsed ? {} : { detail: truncate(res.text) }),
  });
  return parsed;
}

/** ["24","5","6"] → Band[] */
function toBands(v: unknown): Band[] {
  if (!Array.isArray(v)) return [];
  const out: Band[] = [];
  for (const b of v) {
    const s = String(b);
    if (s === "24" || s === "2.4") out.push("2.4");
    else if (s === "5") out.push("5");
    else if (s === "6") out.push("6");
  }
  return out;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ── org 解決 ────────────────────────────────────────────────

/** get_mist_self から org_id を取り出す。環境変数の指定があればそちらを優先する */
export async function resolveMistOrgId(session: McpToolSession): Promise<string | null> {
  const fromEnv = (process.env.MIST_ORG_ID ?? "").trim();
  if (fromEnv) return fromEnv;

  const res = await session.callTool(TOOL.self, {});
  const parsed = parseJson(res.text);
  const priv = Array.isArray(parsed?.privileges) ? parsed.privileges : [];
  const org = priv.find((p: any) => p?.scope === "org" && p?.org_id);
  return org ? String(org.org_id) : null;
}

// ── サイト一覧 ──────────────────────────────────────────────

export interface MistSiteRef {
  siteId: string;
  siteName: string;
  rfTemplateId: string | null;
  apCount: number;
}

export async function listMistSites(session: McpToolSession, orgId: string): Promise<MistSiteRef[]> {
  const steps: CollectionStep[] = [];
  const sites = await fetchConfig(
    session,
    { org_id: orgId, resource_type: "sites", limit: 200 },
    "mist:sites",
    steps,
  );
  const items: any[] = Array.isArray(sites?.items) ? sites.items : [];

  // AP の台数はサイト選択の目安として出す(0 台のサイトを診断しても意味が薄い)
  const devRes = await session.callTool(TOOL.stats, {
    stats_type: "org_devices",
    org_id: orgId,
    filters: { type: "ap" },
    limit: 50,
  });
  const devs: any[] = parseJson(devRes.text)?.data ?? [];
  const counts = new Map<string, number>();
  for (const d of devs) {
    const id = String(d?.site_id ?? "");
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return items
    .map((s) => ({
      siteId: String(s?.id ?? ""),
      siteName: String(s?.name ?? s?.id ?? ""),
      rfTemplateId: s?.rftemplate_id ? String(s.rftemplate_id) : null,
      apCount: counts.get(String(s?.id ?? "")) ?? 0,
    }))
    .filter((s) => s.siteId)
    .sort((a, b) => a.siteName.localeCompare(b.siteName));
}

// ── WLAN の適用範囲の解決 ───────────────────────────────────

/**
 * wlantemplate がこのサイトに当たっているか。
 *   applies.org_id      … org 全体に適用
 *   applies.site_ids    … 明示されたサイト
 *   applies.sitegroup_ids … サイトグループ経由
 *   exceptions.*        … 上記から除外
 */
function templateAppliesToSite(tpl: any, siteId: string, siteGroupIds: string[]): boolean {
  const applies = tpl?.applies ?? {};
  const exceptions = tpl?.exceptions ?? {};

  const exSites: string[] = Array.isArray(exceptions.site_ids) ? exceptions.site_ids.map(String) : [];
  const exGroups: string[] = Array.isArray(exceptions.sitegroup_ids)
    ? exceptions.sitegroup_ids.map(String)
    : [];
  if (exSites.includes(siteId)) return false;
  if (exGroups.some((g) => siteGroupIds.includes(g))) return false;

  if (applies.org_id) return true;
  const sites: string[] = Array.isArray(applies.site_ids) ? applies.site_ids.map(String) : [];
  if (sites.includes(siteId)) return true;
  const groups: string[] = Array.isArray(applies.sitegroup_ids)
    ? applies.sitegroup_ids.map(String)
    : [];
  return groups.some((g) => siteGroupIds.includes(g));
}

function toWlan(raw: any, scope: "org" | "site"): MistWlanConfig {
  const auth = raw?.auth ?? {};
  return {
    id: String(raw?.id ?? ""),
    ssid: String(raw?.ssid ?? ""),
    enabled: raw?.enabled !== false,
    authType: auth?.type === undefined ? null : String(auth.type),
    // pairwise 行が無い = Mist 既定に委ねられている。既定値を勝手に埋めない
    pairwise: Array.isArray(auth?.pairwise) ? auth.pairwise.map(String) : null,
    bands: toBands(raw?.bands),
    scope,
    templateId: raw?.template_id ? String(raw.template_id) : null,
    // 鍵そのものは取り込まない(psk / keys は参照しない)
    hasPsk: typeof auth?.psk === "string" && auth.psk.length > 0,
  };
}

function toRfTemplate(raw: any): MistRfTemplate {
  const bands: MistBandConfig[] = [];
  const map: Array<[string, Band]> = [
    ["band_24", "2.4"],
    ["band_5", "5"],
    ["band_6", "6"],
  ];
  for (const [key, band] of map) {
    const b = raw?.[key];
    if (!b || typeof b !== "object") continue;
    bands.push({
      band,
      bandwidthMhz: num(b.bandwidth),
      // channels: null = 自動(RRM 任せ)。Mist は静的割当を明示的に区別できる(49 §3-5)
      channels: Array.isArray(b.channels) ? b.channels.map((c: unknown) => String(c)) : null,
      power: num(b.power),
      powerMin: num(b.power_min),
      powerMax: num(b.power_max),
      disabled: b.disabled === true,
    });
  }
  return {
    id: String(raw?.id ?? ""),
    name: String(raw?.name ?? raw?.id ?? ""),
    countryCode: raw?.country_code ? String(raw.country_code) : null,
    bands,
    band24Usage: raw?.band_24_usage ? String(raw.band_24_usage) : null,
    hasModelSpecific:
      raw?.model_specific && typeof raw.model_specific === "object"
        ? Object.keys(raw.model_specific).length > 0
        : false,
  };
}

// ── 収集本体 ────────────────────────────────────────────────

export async function collectMistSite(
  session: McpToolSession,
  orgId: string,
  site: MistSiteRef,
): Promise<MistSiteSnapshot> {
  const steps: CollectionStep[] = [];

  // ---- サイト詳細(sitegroup_ids / rftemplate_id)----
  const siteDetail = await fetchConfig(
    session,
    { org_id: orgId, resource_type: "sites", resource_id: site.siteId },
    "mist:site",
    steps,
  );
  const detail = siteDetail?.data ?? {};
  const siteGroupIds: string[] = Array.isArray(detail?.sitegroup_ids)
    ? detail.sitegroup_ids.map(String)
    : [];
  const rfTemplateId = detail?.rftemplate_id ? String(detail.rftemplate_id) : site.rfTemplateId;

  // ---- RF テンプレート ----
  let rfTemplate: MistRfTemplate | null = null;
  if (rfTemplateId) {
    const tpl = await fetchConfig(
      session,
      { org_id: orgId, resource_type: "rftemplates", resource_id: rfTemplateId },
      "mist:rftemplate",
      steps,
    );
    if (tpl?.data) rfTemplate = toRfTemplate(tpl.data);
  } else {
    steps.push({ key: "mist:rftemplate", status: "skipped", durationMs: 0, detail: "noRfTemplate" });
  }

  // ---- WLAN(org スコープ + サイトスコープ)----
  const wlans: MistWlanConfig[] = [];

  const templates = await fetchConfig(
    session,
    { org_id: orgId, resource_type: "wlantemplates", limit: 200 },
    "mist:wlantemplates",
    steps,
  );
  const tplItems: any[] = Array.isArray(templates?.items) ? templates.items : [];

  // applies / exceptions は一覧では返らないので、テンプレートごとに詳細を引く
  const appliedTemplateIds = new Set<string>();
  for (const t of tplItems) {
    const id = String(t?.id ?? "");
    if (!id) continue;
    const full = await fetchConfig(
      session,
      { org_id: orgId, resource_type: "wlantemplates", resource_id: id },
      `mist:wlantemplate:${id}`,
      steps,
    );
    if (full?.data && templateAppliesToSite(full.data, site.siteId, siteGroupIds)) {
      appliedTemplateIds.add(id);
    }
  }

  const orgWlans = await fetchConfig(
    session,
    { org_id: orgId, resource_type: "wlans", limit: 25 },
    "mist:wlans",
    steps,
  );
  for (const w of Array.isArray(orgWlans?.items) ? orgWlans.items : []) {
    const tplId = w?.template_id ? String(w.template_id) : null;
    if (tplId && !appliedTemplateIds.has(tplId)) continue;
    wlans.push(toWlan(w, "org"));
  }

  const siteWlans = await fetchConfig(
    session,
    { org_id: orgId, resource_type: "wlans", site_id: site.siteId, limit: 25 },
    "mist:wlans:site",
    steps,
  );
  for (const w of Array.isArray(siteWlans?.items) ? siteWlans.items : []) {
    const id = String(w?.id ?? "");
    if (wlans.some((x) => x.id === id)) continue;
    wlans.push(toWlan(w, "site"));
  }

  // ---- AP 一覧(RF-14 / LLM 所見の材料)----
  const t0 = Date.now();
  const devRes = await session.callTool(TOOL.stats, {
    stats_type: "org_devices",
    org_id: orgId,
    filters: { type: "ap", site_id: site.siteId },
    limit: 50,
  });
  const devParsed = parseJson(devRes.text);
  const aps: MistApMeta[] = (Array.isArray(devParsed?.data) ? devParsed.data : [])
    .filter((d: any) => String(d?.site_id ?? "") === site.siteId)
    .map((d: any) => ({
      id: String(d?.id ?? ""),
      name: String(d?.name ?? ""),
      model: String(d?.model ?? ""),
      version: String(d?.version ?? ""),
      status: String(d?.status ?? ""),
    }));
  steps.push({
    key: "mist:org_devices",
    status: devParsed ? "ok" : "error",
    durationMs: Date.now() - t0,
    ...(devParsed ? {} : { detail: truncate(devRes.text) }),
  });

  return {
    platform: "mist",
    siteId: site.siteId,
    siteName: site.siteName,
    rfTemplate,
    wlans,
    aps,
    steps,
  };
}

export async function openMistSession(): Promise<McpToolSession> {
  return await connectMcpTools(["mist"]);
}
