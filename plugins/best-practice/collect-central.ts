/**
 * Central 側の設定収集。
 *
 * 設計上の 3 つの制約(49 §1-5)がそのままこのファイルの形を決めている。
 *
 * (a) **`show running-config` には機微情報が含まれる**
 *     virtual-controller-key / hash-mgmt-user / wpa-passphrase / RADIUS 共有シークレット。
 *     → 生テキストは **1 度も戻り値に載せず**、この関数の中でパースして捨てる。
 *       失敗理由も生テキストではなくコードで持ち、詳細は先頭 N 文字に切る。
 *
 * (b) **未対応コマンドを 1 つでも混ぜると全カタログ(27KB 超)が返り、バッチ全体が失敗する**
 *     → コマンドは**世代ごとの固定ホワイトリスト**だけを使い、動的に組み立てない。
 *       それでもカタログエラーが返った場合は 1 コマンドずつ実行し直して、
 *       壊れたコマンドだけを `catalog_error` にして残りを救う。
 *
 * (c) **実行コストが高い**(1 コマンド 8〜10 秒)
 *     → サイトごとに代表 AP を 1 台(世代が混在するサイトでは世代ごとに 1 台)だけ叩く。
 *
 * MCP は claude CLI を経由せず、@modelcontextprotocol/sdk で直接呼ぶ
 * (network-investigation/ollama-mcp-client.ts の connectMcpTools を再利用)。
 * 決定的な収集に LLM を挟む必要が無く、挟むと出力が要約されて機微情報の扱いも曖昧になるため。
 */

import { connectMcpTools, type McpToolSession } from "../network-investigation/ollama-mcp-client.js";
import { parseIdsSection, parseRfProfiles, parseSsidProfiles } from "./running-config.js";
import {
  parseArmConfig,
  parseIdsDetectionConfig,
  parseIdsProtectionConfig,
  parseRadioConfig,
} from "./show-parse.js";
import type {
  ApMeta,
  ApRadioMeta,
  Band,
  CentralSiteSnapshot,
  CollectionStep,
  CommandStatus,
  Generation,
} from "./types.js";

// ── ホワイトリスト(動的に組み立てない)──────────────────────
//
// すべて実機で疎通を確認済み(2026-08-02):
//   AOS10: AP-505H / 10.8.1、AP-325 / 10.4.1
//   AOS8 : AP-225 クラスタ / 8.6.0
// `show arm config` は AOS10 では `% Parse error.` になるため AOS10 側に入れない
// (カタログには存在するのでバッチは失敗しないが、無駄な 1 コマンドになる)。
//
// 49 §5 の追加調査 #1(AOS8 で show radio config / show ids-* が動くか)は
// この確認で解消した。**AOS8 でも 3 つとも実行できる。**
export const CENTRAL_SHOW_WHITELIST: Record<Exclude<Generation, "unknown">, string[]> = {
  aos10: [
    "show running-config",
    "show radio config",
    "show ids-detection config",
    "show ids-protection config",
  ],
  aos8: [
    "show running-config",
    "show radio config",
    "show ids-detection config",
    "show ids-protection config",
    "show arm config",
  ],
};

/** 1 回のコールで投げられるコマンド数の上限(central_run_show_commands の仕様) */
const MAX_COMMANDS_PER_CALL = 5;

/** 失敗理由に残す最大文字数。カタログ全文(27KB)を保存しないため */
const DETAIL_MAX = 300;

const TOOL = {
  show: "mcp__central-mcp__central_run_show_commands",
  aps: "mcp__central-mcp__central_get_aps",
  apDetails: "mcp__central-mcp__central_get_ap_details",
  summary: "mcp__central-mcp__central_get_summary",
} as const;

/** ファーム文字列から世代を判定する。"10.8.1.0_95966" → aos10 / "8.6.0.23_88342" → aos8 */
export function generationOf(firmware: string): Generation {
  const m = /^(\d+)\./.exec((firmware ?? "").trim());
  if (!m) return "unknown";
  const major = Number.parseInt(m[1], 10);
  if (major >= 10) return "aos10";
  if (major === 8) return "aos8";
  return "unknown";
}

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

/**
 * central-mcp のツールは本文をそのまま返すことも `{ "result": … }` で包むこともある。
 * どちらでも中身を取り出せるようにする。
 */
function unwrapResult(parsed: any): any {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "result" in parsed) {
    return parsed.result;
  }
  return parsed;
}

/**
 * central_run_show_commands の応答を { command → output } に開く。
 *
 * 応答は 3 通りある:
 *  1. 正常   … {"status":"COMPLETED","output":{"results":[{"command","output"}]}}
 *  2. カタログエラー … 先頭が "Error validating show commands: Unsupported commands: [...]"
 *                     という**プレーンテキスト**(JSON ではない)。isError も立たない。
 *                     バッチ内の正常なコマンドの出力も返らない。
 *  3. 個別の parse error … results[].output が "% Parse error." のみ
 */
function openShowResponse(text: string):
  | { kind: "ok"; outputs: Map<string, string> }
  | { kind: "catalog_error"; detail: string }
  | { kind: "error"; detail: string } {
  if (/^\s*Error validating show commands/i.test(text)) {
    return { kind: "catalog_error", detail: truncate(text) };
  }
  const env = parseJson(text);
  if (!env) return { kind: "error", detail: truncate(text) };
  if (env.error) return { kind: "error", detail: truncate(String(env.error)) };

  const results = env?.output?.results;
  if (!Array.isArray(results)) return { kind: "error", detail: truncate(text) };

  const outputs = new Map<string, string>();
  for (const r of results) {
    if (r && typeof r.command === "string") outputs.set(r.command, String(r.output ?? ""));
  }
  return { kind: "ok", outputs };
}

/** その 1 コマンドの出力が「この世代には無いコマンド」を示しているか */
function isParseError(output: string): boolean {
  return /%\s*Parse error/i.test(output);
}

interface ShowOutcome {
  outputs: Map<string, string>;
  steps: CollectionStep[];
}

/**
 * ホワイトリストのコマンド群を実行する。
 * カタログエラーで全滅した場合だけ 1 コマンドずつ実行し直す(コスト増を最小限にする)。
 *
 * export しているのは、フォールバック経路(カタログエラー → 1 本ずつ再実行)を
 * 実機に対して確かめられるようにするため。通常はこのファイルの中からだけ呼ぶ。
 */
export async function runShowCommands(
  session: McpToolSession,
  serial: string,
  commands: string[],
): Promise<ShowOutcome> {
  const outputs = new Map<string, string>();
  const steps: CollectionStep[] = [];

  const call = async (batch: string[]): Promise<ReturnType<typeof openShowResponse> & { ms: number }> => {
    const t0 = Date.now();
    const res = await session.callTool(TOOL.show, {
      serial_number: serial,
      commands: batch,
      max_attempts: 8,
      poll_interval: 8,
    });
    const opened = res.isError
      ? ({ kind: "error", detail: truncate(res.text) } as const)
      : openShowResponse(res.text);
    return { ...opened, ms: Date.now() - t0 };
  };

  const record = (command: string, status: CommandStatus, ms: number, detail?: string) => {
    steps.push({ key: command, status, durationMs: ms, ...(detail ? { detail } : {}) });
  };

  const take = (opened: { kind: "ok"; outputs: Map<string, string> }, batch: string[], ms: number) => {
    const per = Math.round(ms / Math.max(1, batch.length));
    for (const cmd of batch) {
      const out = opened.outputs.get(cmd);
      if (out === undefined) {
        record(cmd, "error", per, "応答にこのコマンドの結果が含まれていません");
        continue;
      }
      if (isParseError(out)) {
        // この世代には無いコマンド。他のコマンドは生きている
        record(cmd, "unsupported", per);
        continue;
      }
      outputs.set(cmd, out);
      record(cmd, "ok", per);
    }
  };

  for (let i = 0; i < commands.length; i += MAX_COMMANDS_PER_CALL) {
    const batch = commands.slice(i, i + MAX_COMMANDS_PER_CALL);
    const opened = await call(batch);

    if (opened.kind === "ok") {
      take(opened, batch, opened.ms);
      continue;
    }

    // バッチが丸ごと失敗した。1 コマンドずつ実行し直して、生きているものを救う。
    console.warn(
      `[best-practice] ${serial}: バッチ実行が ${opened.kind} で失敗したため 1 コマンドずつ再実行します`,
    );
    for (const cmd of batch) {
      const single = await call([cmd]);
      if (single.kind === "ok") {
        take(single, [cmd], single.ms);
      } else {
        record(cmd, single.kind === "catalog_error" ? "catalog_error" : "error", single.ms, single.detail);
      }
    }
  }

  return { outputs, steps };
}

// ── AP メタ情報 ─────────────────────────────────────────────

function toApMeta(raw: any): ApMeta {
  const firmware = String(raw?.firmware_version ?? "");
  return {
    serial: String(raw?.serial_number ?? ""),
    name: String(raw?.device_name ?? ""),
    model: String(raw?.model ?? ""),
    firmware,
    status: String(raw?.status ?? ""),
    generation: generationOf(firmware),
  };
}

function bandOf(v: string): Band | null {
  const s = v.toLowerCase();
  if (s.startsWith("2.4")) return "2.4";
  if (s.startsWith("5")) return "5";
  if (s.startsWith("6")) return "6";
  return null;
}

function numFrom(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = /(-?\d+(?:\.\d+)?)/.exec(String(v ?? ""));
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

function toRadioMeta(serial: string, apName: string, raw: any): ApRadioMeta | null {
  const band = bandOf(String(raw?.band ?? ""));
  if (!band) return null;
  return {
    serial,
    apName,
    band,
    bandwidthMhz: numFrom(raw?.bandwidth),
    channel: raw?.channel === undefined ? null : String(raw.channel),
    powerDbm: numFrom(raw?.power),
    status: raw?.status === undefined ? null : String(raw.status),
  };
}

/** 代表 AP を選ぶ: 世代ごとに ONLINE な 1 台(49 §4-2) */
export function pickRepresentatives(aps: ApMeta[]): ApMeta[] {
  const online = aps.filter((a) => a.status.toUpperCase() === "ONLINE");
  const pool = online.length ? online : aps;
  const byGeneration = new Map<Generation, ApMeta>();
  for (const ap of pool) {
    if (!byGeneration.has(ap.generation)) byGeneration.set(ap.generation, ap);
  }
  return [...byGeneration.values()];
}

// ── サイト一覧 ──────────────────────────────────────────────

export interface CentralSiteRef {
  siteId: string;
  siteName: string;
  apCount: number;
}

export async function listCentralSites(session: McpToolSession): Promise<CentralSiteRef[]> {
  const res = await session.callTool(TOOL.aps, { status: "ONLINE" });
  const unwrapped = unwrapResult(parseJson(res.text));
  const list: any[] = Array.isArray(unwrapped) ? unwrapped : [];

  const bySite = new Map<string, CentralSiteRef>();
  for (const ap of list) {
    const siteId = String(ap?.site_id ?? "");
    if (!siteId) continue;
    const ref = bySite.get(siteId) ?? {
      siteId,
      siteName: String(ap?.site_name ?? siteId),
      apCount: 0,
    };
    ref.apCount += 1;
    bySite.set(siteId, ref);
  }
  return [...bySite.values()].sort((a, b) => a.siteName.localeCompare(b.siteName));
}

// ── 収集本体 ────────────────────────────────────────────────

/**
 * 1 サイト分の設定を収集して正規化構造体にする。
 *
 * **この関数を出た時点で生の running-config はメモリから消えている**
 * (ローカル変数のみで、返り値にも steps.detail にも載せない)。
 */
export async function collectCentralSite(
  session: McpToolSession,
  site: CentralSiteRef,
): Promise<CentralSiteSnapshot> {
  const steps: CollectionStep[] = [];

  // ---- サイトの AP 一覧 ----
  const t0 = Date.now();
  const apsRes = await session.callTool(TOOL.aps, { site_id: site.siteId });
  const apsUnwrapped = unwrapResult(parseJson(apsRes.text));
  const aps: ApMeta[] = Array.isArray(apsUnwrapped)
    ? apsUnwrapped.map(toApMeta).filter((a: ApMeta) => a.serial)
    : [];
  steps.push({
    key: "central_get_aps",
    status: aps.length ? "ok" : "error",
    durationMs: Date.now() - t0,
    ...(aps.length ? {} : { detail: truncate(apsRes.text) }),
  });

  // ---- 全 AP の radios[](RF-03 / RF-16 の材料。show コマンド不要)----
  const radios: ApRadioMeta[] = [];
  for (const ap of aps) {
    if (ap.status.toUpperCase() !== "ONLINE") continue;
    const t = Date.now();
    const res = await session.callTool(TOOL.apDetails, { serial_number: ap.serial });
    const parsed = unwrapResult(parseJson(res.text));
    const list = parsed?.radios;
    if (Array.isArray(list)) {
      for (const r of list) {
        const meta = toRadioMeta(ap.serial, ap.name || ap.serial, r);
        if (meta) radios.push(meta);
      }
      steps.push({ key: `central_get_ap_details:${ap.serial}`, status: "ok", durationMs: Date.now() - t });
    } else {
      steps.push({
        key: `central_get_ap_details:${ap.serial}`,
        status: "error",
        durationMs: Date.now() - t,
        detail: truncate(res.text),
      });
    }
  }

  // ---- 代表 AP に対する show コマンド ----
  const representatives: CentralSiteSnapshot["representatives"] = [];
  for (const ap of pickRepresentatives(aps)) {
    const whitelist =
      ap.generation === "aos8"
        ? CENTRAL_SHOW_WHITELIST.aos8
        : ap.generation === "aos10"
          ? CENTRAL_SHOW_WHITELIST.aos10
          : // 世代が読めない機器には、両世代で動くことが分かっている 4 本だけを投げる
            CENTRAL_SHOW_WHITELIST.aos10;

    const { outputs, steps: showSteps } = await runShowCommands(session, ap.serial, whitelist);

    // ---- ここでパースし、生テキストは以降どこにも渡さない ----
    const runningConfig = outputs.get("show running-config") ?? "";
    const ssids = parseSsidProfiles(runningConfig);
    const rfProfiles = parseRfProfiles(runningConfig);
    const ids = parseIdsSection(runningConfig);

    representatives.push({
      ap,
      ssids,
      rfProfiles,
      ids,
      radioProfiles: parseRadioConfig(outputs.get("show radio config") ?? ""),
      idsDetection: parseIdsDetectionConfig(outputs.get("show ids-detection config") ?? ""),
      idsProtection: parseIdsProtectionConfig(outputs.get("show ids-protection config") ?? ""),
      arm: parseArmConfig(outputs.get("show arm config") ?? ""),
      steps: showSteps,
    });

    // outputs はこのループのスコープで捨てられる。明示的に消して意図を残す。
    outputs.clear();
  }

  return {
    platform: "central",
    siteId: site.siteId,
    siteName: site.siteName,
    representatives,
    aps,
    radios,
    steps,
  };
}

export async function openCentralSession(): Promise<McpToolSession> {
  return await connectMcpTools(["central"]);
}
