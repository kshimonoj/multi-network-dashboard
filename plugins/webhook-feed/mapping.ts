// Webhook ログ(17 Task 2-2)— 3 シート → 統合スキーマの変換。
//
// 「ソースごとのフィールド名の違い」をこのファイル 1 枚に閉じ込める。
// 呼び出し側(poller.ts)はシート名と行を渡すだけで、以降は WebhookFeedItem として扱える。
//
// 実測した列構成(2026-07-26 時点。ヘッダ名で解決し、重複ヘッダのある列だけ添字で固定する):
//
//  CentralLog(New Central / 20 列)
//    A Received At (JST) / B Alert Time (JST) / C Webhook Event ID / D Alert ID / E Alert Name /
//    F Category / G Device Type / H Severity / I State / J Operation / K Site ID / L Config Scope /
//    M Tenant ID / N Tenant Name / O Summary / P Notes / Q Impacted Device Serials /
//    R Impacted Client MACs / S Hostnames / T Additional Details (JSON)
//
//  ClassicCentralLog(Classic Central / 14 列)
//    A Received At (JST) / B Alert Time (JST) / C ★Alert Time (JST) ← ヘッダのラベルが誤っており、
//      実際には ES のドキュメント ID(行の一意キー)が入っている。ヘッダ名が B と重複するため
//      添字 2 で固定する / D NID(アラート種別の番号。行の一意 ID ではない) / E Alert Type /
//    F Setting ID / G Device ID / H State / I Severity / J Operation / K Description / L Text /
//    M Webhook ID / N Details (JSON)
//
//  MistLog(Mist / 11 列)
//    A Received At (JST) / B Event Time (JST) / C Topic / D Org ID / E Site ID / F Device MAC /
//    G Device/AP Name / H Type/Reason / I Severity / J Message / K Raw JSON

import type { WebhookFeedItem, WebhookSeverity, WebhookSource } from "./feed-types.js";
import { cellToIso, cellToString } from "./sheets-client.js";

export interface SheetSpec {
  sheet: string;
  source: WebhookSource;
  label: string;
}

/** 取り込む 3 シート。UI のバッジ順もこの順に合わせる。 */
export const SHEET_SPECS: SheetSpec[] = [
  { sheet: "CentralLog", source: "new-central", label: "New Central" },
  { sheet: "ClassicCentralLog", source: "classic-central", label: "Classic Central" },
  { sheet: "MistLog", source: "mist", label: "Mist" },
];

export const SOURCE_LABEL: Record<WebhookSource, string> = {
  "new-central": "New Central",
  "classic-central": "Classic Central",
  mist: "Mist",
};

/** ソース → Global Overview の詳細 API が使うプラットフォーム。 */
export const SOURCE_PLATFORM: Record<WebhookSource, "central" | "mist" | null> = {
  // New Central のサイト ID は Global Overview の Central スナップショットと同じ体系。
  "new-central": "central",
  // Classic Central はサイト ID を Webhook に載せてこないので先読み対象外(下の siteId が常に null)。
  "classic-central": null,
  mist: "mist",
};

/**
 * 重要度の正規化。Global Overview(events-feed.ts の normSeverity)と同じ 3 段階に、
 * 「列が空 = そもそも重要度を持たない行」を表す unknown を足す。
 *  New Central     … Critical / Major / Minor / Warning / Info
 *  Classic Central … Critical / Major / Minor / Warning
 *  Mist            … critical / warn / info(alarms 以外の topic は空)
 */
export function normSeverity(raw: string | null): WebhookSeverity {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s === "critical" || s === "crit" || s === "fatal") return "critical";
  if (s === "major" || s === "warning" || s === "warn" || s === "minor" || s === "negative") return "warning";
  return "info";
}

/**
 * Task 4 の対象(= 各ソースの最上位の重要度)か。
 * 3 ソースとも「Critical(critical)」を最上位とする。Major/warn は対象外。
 */
export function isTopSeverity(item: { severityRaw: string | null }): boolean {
  return (item.severityRaw ?? "").trim().toLowerCase() === "critical";
}

// ---- 列の解決 ----

interface ColumnSpec {
  key: string;
  header: string;
  /** ヘッダ名が一意に決まらないときに使う添字(0 始まり) */
  index: number;
}

/**
 * ヘッダ名で列位置を解決する。同じヘッダ名が複数ある場合(Classic の B/C)は添字にフォールバックする。
 * 列が増減しても壊れないようにヘッダ名優先にしつつ、シート側のラベル誤りは添字で救う。
 */
function resolveColumns(headers: string[], specs: ColumnSpec[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const spec of specs) {
    const hits: number[] = [];
    headers.forEach((h, i) => {
      if (h === spec.header) hits.push(i);
    });
    map[spec.key] = hits.length === 1 ? hits[0] : spec.index;
  }
  return map;
}

const CENTRAL_COLS: ColumnSpec[] = [
  { key: "receivedAt", header: "Received At (JST)", index: 0 },
  { key: "eventAt", header: "Alert Time (JST)", index: 1 },
  { key: "eventId", header: "Webhook Event ID", index: 2 },
  { key: "alertId", header: "Alert ID", index: 3 },
  { key: "alertName", header: "Alert Name", index: 4 },
  { key: "category", header: "Category", index: 5 },
  { key: "deviceType", header: "Device Type", index: 6 },
  { key: "severity", header: "Severity", index: 7 },
  { key: "state", header: "State", index: 8 },
  { key: "operation", header: "Operation", index: 9 },
  { key: "siteId", header: "Site ID", index: 10 },
  { key: "configScope", header: "Config Scope", index: 11 },
  { key: "tenantId", header: "Tenant ID", index: 12 },
  { key: "tenantName", header: "Tenant Name", index: 13 },
  { key: "summary", header: "Summary", index: 14 },
  { key: "notes", header: "Notes", index: 15 },
  { key: "serials", header: "Impacted Device Serials", index: 16 },
  { key: "clientMacs", header: "Impacted Client MACs", index: 17 },
  { key: "hostnames", header: "Hostnames", index: 18 },
  { key: "details", header: "Additional Details (JSON)", index: 19 },
];

const CLASSIC_COLS: ColumnSpec[] = [
  { key: "receivedAt", header: "Received At (JST)", index: 0 },
  // B/C はヘッダ名が同じ("Alert Time (JST)")なので、どちらも添字で固定する。
  { key: "eventAt", header: "\u0000", index: 1 },
  { key: "alertId", header: "\u0000", index: 2 },
  { key: "nid", header: "NID", index: 3 },
  { key: "alertType", header: "Alert Type", index: 4 },
  { key: "settingId", header: "Setting ID", index: 5 },
  { key: "deviceId", header: "Device ID", index: 6 },
  { key: "state", header: "State", index: 7 },
  { key: "severity", header: "Severity", index: 8 },
  { key: "operation", header: "Operation", index: 9 },
  { key: "description", header: "Description", index: 10 },
  { key: "text", header: "Text", index: 11 },
  { key: "webhookId", header: "Webhook ID", index: 12 },
  { key: "details", header: "Details (JSON)", index: 13 },
];

const MIST_COLS: ColumnSpec[] = [
  { key: "receivedAt", header: "Received At (JST)", index: 0 },
  { key: "eventAt", header: "Event Time (JST)", index: 1 },
  { key: "topic", header: "Topic", index: 2 },
  { key: "orgId", header: "Org ID", index: 3 },
  { key: "siteId", header: "Site ID", index: 4 },
  { key: "deviceMac", header: "Device MAC", index: 5 },
  { key: "deviceName", header: "Device/AP Name", index: 6 },
  { key: "type", header: "Type/Reason", index: 7 },
  { key: "severity", header: "Severity", index: 8 },
  { key: "message", header: "Message", index: 9 },
  { key: "rawJson", header: "Raw JSON", index: 10 },
];

const COLS_BY_SOURCE: Record<WebhookSource, ColumnSpec[]> = {
  "new-central": CENTRAL_COLS,
  "classic-central": CLASSIC_COLS,
  mist: MIST_COLS,
};

function parseJsonSafe(s: string): unknown {
  const t = s.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function firstNonEmpty(...vals: Array<string | null | undefined>): string | null {
  for (const v of vals) {
    const s = (v ?? "").trim();
    if (s) return s;
  }
  return null;
}

/**
 * ISO 文字列を「シートのタイムゾーンでの壁時計」(例: 2026-07-26 12:47:34)に直す。
 * 生データ欄をスプレッドシートの表示とそのまま突き合わせられるようにするため。
 */
function sheetLocal(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
  // sv-SE は "YYYY-MM-DD HH:mm:ss" を返す(ISO に近い並びのロケール)。
  return p;
}

function joinParts(...vals: Array<string | null | undefined>): string | null {
  const parts = vals.map((v) => (v ?? "").trim()).filter(Boolean);
  return parts.length ? [...new Set(parts)].join(" / ") : null;
}

export interface MapContext {
  /** スプレッドシートのタイムゾーン(日時シリアル値の解釈に使う) */
  timeZone: string;
}

/**
 * 1 行を統合スキーマへ変換する。
 * 変換できない(全列が空など)行は null を返して読み飛ばす。
 */
export function mapRow(
  spec: SheetSpec,
  headers: string[],
  rowIndex: number,
  values: unknown[],
  ctx: MapContext,
): WebhookFeedItem | null {
  const cols = resolveColumns(headers, COLS_BY_SOURCE[spec.source]);
  const at = (key: string): string => cellToString(values[cols[key]] ?? "").trim();
  const iso = (key: string): string | null => cellToIso(values[cols[key]], ctx.timeZone);

  // 生データ(行を開いたときに全項目を出す)。ヘッダが空の列は列記号で代用する。
  // 日時列はシートのシリアル値のまま(例: 46229.533)では読めないので、
  // スプレッドシート上の表示と同じ「シートのタイムゾーンでの壁時計」に直して出す。
  const dateCols = new Set([cols.receivedAt, cols.eventAt]);
  const raw: Record<string, string> = {};
  const width = Math.max(headers.length, values.length);
  for (let i = 0; i < width; i += 1) {
    const v = dateCols.has(i)
      ? sheetLocal(cellToIso(values[i], ctx.timeZone), ctx.timeZone) || cellToString(values[i] ?? "").trim()
      : cellToString(values[i] ?? "").trim();
    if (!v) continue;
    const key = (headers[i] || "").trim() || `列 ${String.fromCharCode(65 + i)}`;
    // Classic の B/C のようにヘッダが重複する場合は後勝ちで潰さない。
    raw[raw[key] === undefined ? key : `${key} (${String.fromCharCode(65 + i)})`] = v;
  }
  if (Object.keys(raw).length === 0) return null;

  const base = {
    id: `${spec.source}#${rowIndex}`,
    source: spec.source,
    sheet: spec.sheet,
    rowIndex,
    receivedAt: iso("receivedAt"),
    eventAt: iso("eventAt"),
    raw,
    auto: null,
    siteContext: null,
    siteName: null,
    platform: null,
  } as const;

  if (spec.source === "new-central") {
    const severityRaw = firstNonEmpty(at("severity"));
    const message =
      firstNonEmpty(at("summary"), at("notes"), at("alertName")) ?? "(本文なし)";
    const siteId = firstNonEmpty(at("siteId"));
    return {
      ...base,
      severity: normSeverity(severityRaw),
      severityRaw,
      category: firstNonEmpty(at("category")),
      type: firstNonEmpty(at("alertName")),
      state: firstNonEmpty(at("state")),
      siteId,
      siteName: null,
      platform: null,
      deviceLabel: joinParts(at("hostnames"), at("serials"), at("clientMacs"), at("deviceType")),
      message,
      // Active → Cleared で同じ Alert ID になるので、1 アラート = 1 回の自動調査になる。
      alertKey: `new-central:${firstNonEmpty(at("alertId"), at("eventId")) ?? `row-${rowIndex}`}`,
    };
  }

  if (spec.source === "classic-central") {
    const severityRaw = firstNonEmpty(at("severity"));
    const message = firstNonEmpty(at("description"), at("text"), at("alertType")) ?? "(本文なし)";
    // Classic Central の Webhook はサイト ID を載せてこない(Device ID = シリアルのみ)。
    // よって siteId は常に null。サイト情報の先読み(Task 5)の対象外になる。
    return {
      ...base,
      severity: normSeverity(severityRaw),
      severityRaw,
      category: firstNonEmpty(at("alertType")),
      type: firstNonEmpty(at("alertType")),
      state: firstNonEmpty(at("state")),
      siteId: null,
      siteName: null,
      platform: null,
      deviceLabel: joinParts(at("deviceId")),
      message,
      // 列 C は ES のドキュメント ID(行ごとに一意)。NID はアラート種別の番号なので使わない。
      alertKey: `classic-central:${
        firstNonEmpty(at("alertId"), at("settingId")) ?? `row-${rowIndex}`
      }`,
    };
  }

  // ---- Mist ----
  const rawJson = parseJsonSafe(at("rawJson")) as Record<string, unknown> | null;
  const jsonStr = (k: string): string | null => {
    const v = rawJson?.[k];
    return v === null || v === undefined || typeof v === "object" ? null : String(v).trim() || null;
  };
  // severity 列が空でも Raw JSON 側に入っていることがあるので拾う。
  const severityRaw = firstNonEmpty(at("severity"), jsonStr("severity"));
  const topic = firstNonEmpty(at("topic"));
  const type = firstNonEmpty(at("type"), jsonStr("type"), jsonStr("ev_type"));
  const message =
    firstNonEmpty(at("message"), jsonStr("reason"), jsonStr("text"), type, topic) ?? "(本文なし)";
  const siteId = firstNonEmpty(at("siteId"), jsonStr("site_id"));
  return {
    ...base,
    severity: normSeverity(severityRaw),
    severityRaw,
    category: topic,
    type,
    state: null,
    siteId,
    siteName: firstNonEmpty(jsonStr("site_name")),
    platform: null,
    deviceLabel: joinParts(at("deviceName"), at("deviceMac"), jsonStr("device_name"), jsonStr("mac")),
    message,
    // Mist は topic ごとに ID の有無が違う。無ければ「topic + 機器 + 種別 + 時刻」で同一性を作る。
    alertKey: `mist:${
      jsonStr("id") ??
      [topic ?? "", at("deviceMac") || jsonStr("mac") || "", type ?? "", jsonStr("timestamp") ?? at("eventAt")]
        .join("|")
    }`,
  };
}
