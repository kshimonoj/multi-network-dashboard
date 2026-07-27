// Network Investigation — サイト→プラットフォーム対応表の生成
//
// PRECONDITIONS:
//  - Central と Mist が同一サイトを重複管理しない前提のもと、単純な 1 対 1 の振り分け表として、
//    両プラットフォームのサイト一覧を platform ラベル付きでマージするだけで生成する
//    (名前の突き合わせ処理は不要)。事前生成 + 手動更新ボタン方式。
//  - 地図ピン用の緯度経度: Mist は get_mist_config(sites, resource_id) の詳細に latlng がある。
//    Central は central_get_sites の location.lat/lng にある(本タスクで取得可否を確認)。
//
// filesystem as database(CLAUDE.md):
//  - 対応表の真実は data/network-investigation/site-platform-map.json。
//  - これは Central/Mist という外部が持つ「今のサイト一覧」の導出データ(再生成可能)。
//    整合性管理(生成・上書き)は refresh を起こしたハンドラだけの責務。

import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { runClaudeWithMcp } from "./mcp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本アプリ独自の data/ ディレクトリ(api.ts の DATA_DIR と同じ場所を指す。移植時に書き換えた 2 箇所目)。
const DATA_DIR =
  process.env.NETINV_DATA_DIR || path.resolve(__dirname, "../../data/network-investigation");
const MAP_PATH = path.join(DATA_DIR, "site-platform-map.json");

export interface SitePlatformEntry {
  siteName: string;
  platform: "central" | "mist";
  siteId: string;
  lat: number | null;
  lng: number | null;
}

// claude に「ツールを呼んで結果を JSON 配列だけで返せ」と指示するときの共通末尾。
const JSON_ONLY_TAIL =
  "出力は JSON 配列のみ。前置き・後置き・コードフェンス(```)・説明文を一切付けない。" +
  "各要素は {\"siteName\": string, \"siteId\": string, \"lat\": number|null, \"lng\": number|null}。" +
  "緯度経度が取得できないサイトは lat/lng を null にする。";

const CENTRAL_PROMPT =
  "あなたは HPE Aruba Networking Central の MCP ツールを使える。\n" +
  "1. central_get_summary を呼び、全サイトの名前(キー)と site_id を得る。\n" +
  "2. 手順1で得た全サイト名を1回の central_get_sites 呼び出し(site_names に全部渡す)で取得し、" +
  "各サイトの location.lat / location.lng を得る。location が無いサイトは null。\n" +
  "siteName=サイト名、siteId=site_id、lat=location.lat、lng=location.lng。\n" +
  JSON_ONLY_TAIL;

const MIST_PROMPT =
  "あなたは Juniper Mist の MCP ツールを使える。\n" +
  "1. get_mist_self を呼び、org_id を得る。\n" +
  "2. get_mist_config(resource_type='sites', org_id=...) で全サイト(id, name)を列挙する。\n" +
  "3. 各サイトについて get_mist_config(resource_type='sites', org_id=..., resource_id=<そのサイトの id>) を呼び、" +
  "latlng(lat/lng)を得る。latlng が無いサイトは null。\n" +
  "siteName=name、siteId=id、lat=latlng.lat、lng=latlng.lng。\n" +
  JSON_ONLY_TAIL;

// claude の応答テキストから JSON 配列を頑健に取り出す。
// (指示に反してコードフェンスや前後の文が混じっても、最初の [ ... 最後の ] を拾う)
function parseSiteArray(text: string): Array<Record<string, unknown>> {
  const t = (text || "").trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`JSON 配列が見つかりません: ${t.slice(0, 120)}`);
  }
  const parsed = JSON.parse(t.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("配列ではありません");
  return parsed as Array<Record<string, unknown>>;
}

function toNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function normalize(
  rows: Array<Record<string, unknown>>,
  platform: "central" | "mist",
): SitePlatformEntry[] {
  const out: SitePlatformEntry[] = [];
  for (const r of rows) {
    const siteName = typeof r.siteName === "string" ? r.siteName : "";
    const siteId = r.siteId == null ? "" : String(r.siteId);
    if (!siteName || !siteId) continue;
    out.push({ siteName, platform, siteId, lat: toNum(r.lat), lng: toNum(r.lng) });
  }
  return out;
}

// 1 プラットフォーム分のサイト一覧を、そのプラットフォーム専用に narrowing した
// MCP config で取得する(= central 用呼び出しでは mist を、その逆も、一切起こさない)。
async function fetchPlatformSites(platform: "central" | "mist"): Promise<{
  entries: SitePlatformEntry[];
  ok: boolean;
  reason?: string;
  mcpServers: string[];
}> {
  const prompt = platform === "central" ? CENTRAL_PROMPT : MIST_PROMPT;
  const res = await runClaudeWithMcp({ prompt, platforms: [platform] });
  if (res.isError) {
    return { entries: [], ok: false, reason: res.reason, mcpServers: res.mcpServers };
  }
  try {
    const entries = normalize(parseSiteArray(res.text), platform);
    return { entries, ok: true, mcpServers: res.mcpServers };
  } catch (err) {
    return {
      entries: [],
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      mcpServers: res.mcpServers,
    };
  }
}

export interface GenerateResult {
  entries: SitePlatformEntry[];
  central: { ok: boolean; count: number; reason?: string; mcpServers: string[] };
  mist: { ok: boolean; count: number; reason?: string; mcpServers: string[] };
  generatedAt: string;
}

/**
 * サイト→プラットフォーム対応表を生成して site-platform-map.json に書き出す。
 * Central / Mist をそれぞれ専用 narrowing で取得し、platform ラベル付きでマージするだけ
 * (名前突き合わせはしない。PRECONDITIONS)。
 *
 * 片方のプラットフォーム取得が失敗しても、もう片方は結果に残す(全体を倒さない)。
 * 少なくとも片方が成功した場合のみファイルを上書きする。
 */
export async function generateSitePlatformMap(): Promise<GenerateResult> {
  const [central, mist] = await Promise.all([
    fetchPlatformSites("central"),
    fetchPlatformSites("mist"),
  ]);

  const entries = [...central.entries, ...mist.entries].sort((a, b) => {
    if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1;
    return a.siteName.localeCompare(b.siteName);
  });

  const generatedAt = new Date().toISOString();

  // 少なくとも片方が成功していれば書き出す(両方失敗なら既存ファイルを壊さない)。
  if (central.ok || mist.ok) {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(MAP_PATH, JSON.stringify(entries, null, 2) + "\n", "utf-8");
  }

  return {
    entries,
    central: { ok: central.ok, count: central.entries.length, reason: central.reason, mcpServers: central.mcpServers },
    mist: { ok: mist.ok, count: mist.entries.length, reason: mist.reason, mcpServers: mist.mcpServers },
    generatedAt,
  };
}

/** 現在の対応表を読む。ファイルが無ければ空配列(未生成)。 */
export async function readSiteMap(): Promise<SitePlatformEntry[]> {
  try {
    const raw = await readFile(MAP_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SitePlatformEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * サイト名 or siteId から platform を引く(runInsightAgent の narrowing 判断に使う)。
 * 見つからなければ null(= プラットフォーム不明 → 両方を候補にする)。
 * 突き合わせは、まず siteId 完全一致 → 次に siteName 完全一致(大小無視)の順。
 */
export async function resolvePlatformForSite(
  siteNameOrId: string,
): Promise<{ platform: "central" | "mist"; entry: SitePlatformEntry } | null> {
  const key = (siteNameOrId || "").trim();
  if (!key) return null;
  const map = await readSiteMap();
  const byId = map.find((e) => e.siteId === key);
  if (byId) return { platform: byId.platform, entry: byId };
  const lower = key.toLowerCase();
  const byName = map.find((e) => e.siteName.toLowerCase() === lower);
  if (byName) return { platform: byName.platform, entry: byName };
  return null;
}
