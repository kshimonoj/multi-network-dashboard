// Streaming(Central)(20 Task 1-3)— CloudEvents + protobuf の二段デコード。
//
// 1 段目: WebSocket のバイナリフレームを cloudevents.v1.CloudEvent としてデコードする。
// 2 段目: 封筒の `type`(例 com.hpe.greenlake...audit-trail.configuration)を catalog.ts で引き、
//         対応するイベント固有メッセージで本体をデコードする。
//
// 実測(20 番)で分かったこと:
//   ・本体は oneof data のうち **proto_data(google.protobuf.Any)** に入っていた。
//     ただし binary_data で来る可能性もドキュメント上は残るので、両方を受ける。
//   ・Any の type_url は .proto の package と一致しない
//     (例 type.googleapis.com/location.v1alpha1.StreamLocationMessage に対し、
//      公開されている .proto の package は network_services.location.v1alpha1)。
//     → type_url からメッセージを解決することはできない。必ず CloudEvent の type から引く。
//   ・attributes.subject に tenant id が入る。
//   ・Location エンドポイントは attributes に deprecation 系の情報を載せてくる
//     (deprecationsunset / deprecationmigration)。デコード結果に残して画面から見えるようにする。

import { fileURLToPath } from "node:url";
import path from "node:path";
import protobuf from "protobufjs";
import { fallbackMessageFor, lookupEventType, type StreamKey } from "./catalog.js";
import type { StreamEvent } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = path.join(__dirname, "proto");

const PROTO_FILES = [
  "cloudevents.proto",
  "audit_trail.proto",
  "ap_monitoring.proto",
  "geofence.proto",
  "location.proto",
  "location_v1.proto",
  "location_analytics.proto",
];

let root: protobuf.Root | null = null;
let cloudEventType: protobuf.Type | null = null;
let loadError: string | null = null;

/**
 * .proto を読み込む。google/protobuf/*.proto(any / timestamp / struct)は
 * protobufjs が内蔵の common 定義で解決するので、ファイルを置く必要はない
 * (resolvePath で null を返すと common に回る)。
 */
export async function initDecoder(): Promise<void> {
  if (root || loadError) return;
  try {
    const r = new protobuf.Root();
    r.resolvePath = (_origin, target) => {
      if (target.startsWith("google/protobuf/")) return null;
      return path.join(PROTO_DIR, path.basename(target));
    };
    await r.load(
      PROTO_FILES.map((f) => path.join(PROTO_DIR, f)),
      // keepCase: proto のフィールド名(snake_case)のまま JSON 化する。
      // ドキュメントの .proto と画面表示を突き合わせやすくするため。
      { keepCase: true },
    );
    root = r;
    cloudEventType = r.lookupType("cloudevents.v1.CloudEvent");
    console.log(`[central-streaming] proto を読み込みました(${PROTO_FILES.length} ファイル)`);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    console.error("[central-streaming] proto の読み込みに失敗:", loadError);
  }
}

export function decoderError(): string | null {
  return loadError;
}

const TO_OBJECT: protobuf.IConversionOptions = {
  defaults: false,
  longs: String,
  enums: String,
  bytes: String,
  arrays: false,
  objects: false,
  oneofs: true,
};

function tsToIso(t: unknown): string | null {
  if (!t || typeof t !== "object") return null;
  const o = t as { seconds?: unknown; nanos?: unknown };
  const sec = Number(o.seconds);
  if (!Number.isFinite(sec)) return null;
  const ms = sec * 1000 + Math.floor(Number(o.nanos ?? 0) / 1e6);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** CloudEvent の attributes(型付き oneof)を素の値に潰す。 */
function flattenAttributes(attrs: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!attrs || typeof attrs !== "object") return out;
  for (const [k, v] of Object.entries(attrs as Record<string, Record<string, unknown>>)) {
    if (!v || typeof v !== "object") continue;
    for (const key of ["ce_string", "ce_uri", "ce_uri_ref", "ce_boolean", "ce_integer", "ce_bytes"]) {
      if (v[key] !== undefined) {
        out[k] = String(v[key]);
        break;
      }
    }
    if (out[k] === undefined && v.ce_timestamp) out[k] = tsToIso(v.ce_timestamp) ?? "";
  }
  return out;
}

export interface DecodedFrame {
  id: string;
  type: string;
  source: string | null;
  eventAt: string | null;
  attributes: Record<string, string>;
  payload: Record<string, unknown>;
  /** payload が読めなかった理由 */
  decodeError: string | null;
  /** Any の type_url(参考情報。メッセージ解決には使わない) */
  typeUrl: string | null;
}

/**
 * バイナリフレーム 1 個をデコードする。
 * CloudEvent 封筒すら読めない場合は例外を投げる(ws-client 側でカウントする)。
 */
export function decodeFrame(buf: Buffer, stream: StreamKey): DecodedFrame {
  if (!cloudEventType) throw new Error(loadError ?? "proto が未初期化です");
  const ce = cloudEventType.toObject(cloudEventType.decode(buf), TO_OBJECT) as Record<string, any>;

  const type = String(ce.type ?? "");
  const attributes = flattenAttributes(ce.attributes);
  const typeUrl: string | null = ce.proto_data?.type_url ? String(ce.proto_data.type_url) : null;

  // 本体のバイト列。proto_data(Any)が本線、binary_data はドキュメント上の代替。
  let bytes: Buffer | null = null;
  if (ce.proto_data?.value) bytes = toBuffer(ce.proto_data.value);
  else if (ce.binary_data) bytes = toBuffer(ce.binary_data);

  let payload: Record<string, unknown> = {};
  let decodeError: string | null = null;

  if (typeof ce.text_data === "string" && ce.text_data) {
    // JSON で来る可能性に備える(現状の実測では無い)。
    try {
      payload = JSON.parse(ce.text_data) as Record<string, unknown>;
    } catch {
      payload = { text: ce.text_data };
    }
  } else if (bytes) {
    const hit = lookupEventType(type);
    const messageName = hit?.type.message ?? fallbackMessageFor(stream);
    if (!messageName) {
      decodeError = `未知のイベント種別のため本体をデコードできません: ${type}`;
    } else {
      try {
        const T = root!.lookupType(messageName);
        payload = T.toObject(T.decode(bytes), TO_OBJECT) as Record<string, unknown>;
        if (!hit) {
          // カタログに無い type を既定メッセージで読んだ場合は、その旨を残す。
          decodeError = `カタログ未登録の type(${type})を ${messageName} として解釈しました`;
        }
      } catch (err) {
        decodeError = `本体のデコードに失敗(${messageName}): ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } else {
    decodeError = "CloudEvent に本体(data)が入っていません";
  }

  return {
    id: String(ce.id ?? ""),
    type,
    source: ce.source ? String(ce.source) : null,
    eventAt: tsToIso(ce.time),
    attributes,
    payload,
    decodeError,
    typeUrl,
  };
}

function toBuffer(v: unknown): Buffer | null {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  // TO_OBJECT で bytes: String にしているため base64 文字列で来る。
  if (typeof v === "string") return Buffer.from(v, "base64");
  return null;
}

// ---- 要約の組み立て ----

function pick(obj: Record<string, any> | undefined, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return null;
}

/** oneof で包まれた本体(Geofence / Location)から、実体と種別名を取り出す。 */
function unwrapOneof(payload: Record<string, any>, keys: string[]): { name: string; body: Record<string, any> } | null {
  for (const k of keys) {
    if (payload[k] && typeof payload[k] === "object") return { name: k, body: payload[k] };
  }
  return null;
}

export interface Summarized {
  summary: string;
  category: string | null;
  siteId: string | null;
  deviceLabel: string | null;
  actor: string | null;
}

/**
 * デコード済み本体から、一覧の 1 行に出す情報を取り出す。
 * ストリームごとにフィールド名がまったく違うので、ここで吸収する。
 */
export function summarize(stream: StreamKey, frame: DecodedFrame): Summarized {
  const p = frame.payload as Record<string, any>;
  const typeTail = frame.type.split(".").pop() ?? frame.type;

  switch (stream) {
    case "audit-trail": {
      const action = pick(p, "action") ?? "(action 不明)";
      const desc = pick(p, "description");
      const target = pick(p, "destination_name", "destination");
      const cat = [pick(p, "category"), pick(p, "sub_category")].filter(Boolean).join(" / ") || null;
      const changed = Array.isArray(p.log_details?.changed_fields) ? p.log_details.changed_fields.length : 0;
      const parts = [desc || action];
      if (target) parts.push(`対象: ${target}`);
      if (changed > 0) parts.push(`変更 ${changed} 項目`);
      return {
        summary: parts.join(" · "),
        category: cat,
        siteId: firstScopeId(p.scope_info),
        deviceLabel: target,
        actor: pick(p, "source") ?? pick(p, "service_name"),
      };
    }

    case "ap-monitoring": {
      const name = pick(p, "device_name", "ap_name");
      const serial = pick(p, "serial_number");
      const mac = pick(p, "mac_address");
      const device = name ? `${name}${serial ? ` (${serial})` : ""}` : (serial ?? mac);
      const bits: string[] = [];
      // 状態イベントは status / operation、統計イベントは代表的な数値を 1〜2 個出す。
      if (p.operation) bits.push(String(p.operation).replace("EVENT_OPERATION_", ""));
      if (p.status !== undefined) bits.push(typeof p.status === "boolean" ? (p.status ? "UP" : "DOWN") : String(p.status));
      if (p.down_reason) bits.push(`理由 ${String(p.down_reason).replace("DEVICE_DOWN_REASON_", "")}`);
      if (p.band) bits.push(String(p.band).replace("RADIO_BAND_", ""));
      if (p.channel) bits.push(`ch ${p.channel}`);
      if (p.essid) bits.push(`SSID ${p.essid}`);
      if (p.port_name) bits.push(`port ${p.port_name}`);
      if (p.cpu_utilization !== undefined) bits.push(`CPU ${Number(p.cpu_utilization).toFixed(1)}%`);
      if (p.memory_utilization !== undefined) bits.push(`MEM ${Number(p.memory_utilization).toFixed(1)}%`);
      if (p.noise_floor !== undefined) bits.push(`NF ${p.noise_floor}`);
      if (p.channel_quality !== undefined) bits.push(`品質 ${p.channel_quality}`);
      if (p.loss_percentage !== undefined) bits.push(`loss ${p.loss_percentage}%`);
      return {
        summary: [device, bits.join(" · ")].filter(Boolean).join(" — ") || typeTail,
        category: typeTail,
        siteId: null,
        deviceLabel: device,
        actor: null,
      };
    }

    case "geofence": {
      const hit = unwrapOneof(p, ["wifi_client_geofence", "asset_tag_geofence"]);
      const b = hit?.body ?? {};
      const who = pick(b, "sta_eth_mac", "device_id", "hashed_sta_eth_mac") ?? "(不明)";
      const ev = String(b.event_type ?? "").replace("EVENT_TYPE_", "") || "?";
      const zone = pick(b, "zone_id");
      const dwell = b.dwell_time_in_seconds;
      return {
        summary:
          `${who} が ゾーン ${zone ?? "?"} を ${ev === "ENTER" ? "入場" : ev === "EXIT" ? "退場" : ev}` +
          (dwell !== undefined ? `(滞在 ${dwell} 秒)` : ""),
        category: hit?.name === "asset_tag_geofence" ? "アセットタグ" : "Wi-Fi クライアント",
        siteId: null,
        deviceLabel: who,
        actor: null,
      };
    }

    case "location": {
      const hit = unwrapOneof(p, ["wifi_client_location", "asset_tag_location"]);
      const b = hit?.body ?? {};
      const who = pick(b, "sta_eth_mac", "device_mac", "device_id", "name") ?? "(不明)";
      const xy =
        b.x !== undefined && b.y !== undefined ? `x=${Number(b.x).toFixed(2)} y=${Number(b.y).toFixed(2)}` : null;
      const err = b.error_level !== undefined ? `誤差 ${Number(b.error_level).toFixed(0)}` : null;
      const aps = Array.isArray(b.reporting_ap_serial) ? b.reporting_ap_serial.join(", ") : null;
      return {
        summary: [who, xy, err, aps ? `観測 AP ${aps}` : null, b.connected === false ? "未接続" : null]
          .filter(Boolean)
          .join(" · "),
        category: hit?.name === "asset_tag_location" ? "アセットタグ" : "Wi-Fi クライアント",
        siteId: pick(b, "site_id"),
        deviceLabel: aps ?? who,
        actor: null,
      };
    }

    case "location-analytics": {
      const kind = p.proximity_rssi ? "近接" : "生";
      const b = (p.proximity_rssi ?? p.raw_rssi ?? {}) as Record<string, any>;
      const client = pick(b, "client_mac") ?? "(不明)";
      const ap = pick(b, "ap_name", "ap_serial", "ap_mac");
      const rssi = b.rssi_val !== undefined ? `RSSI ${b.rssi_val}` : null;
      const nf = b.noise_floor !== undefined ? `NF ${b.noise_floor}` : null;
      return {
        summary: [`${client} @ ${ap ?? "?"}`, rssi, nf, b.associated ? "接続中" : "未接続"]
          .filter(Boolean)
          .join(" · "),
        category: `${kind} RSSI`,
        siteId: null,
        deviceLabel: ap,
        actor: null,
      };
    }
  }
}

function firstScopeId(scope: unknown): string | null {
  if (!scope || typeof scope !== "object") return null;
  const ids = (scope as { scope_ids?: unknown }).scope_ids;
  if (Array.isArray(ids) && ids.length > 0) return String(ids[0]);
  return null;
}

/** decodeFrame + summarize をまとめて StreamEvent に落とす(サイト名の解決は呼び出し側)。 */
export function toStreamEvent(
  stream: StreamKey,
  frame: DecodedFrame,
  receivedAt: string,
): Omit<StreamEvent, "siteName"> {
  const s = summarize(stream, frame);
  const hit = lookupEventType(frame.type);
  return {
    id: frame.id || `${stream}-${receivedAt}-${Math.random().toString(36).slice(2, 10)}`,
    receivedAt,
    eventAt: frame.eventAt,
    stream,
    type: frame.type,
    typeLabel: hit?.type.label ?? (frame.type.split(".").pop() ?? frame.type),
    category: s.category,
    summary: s.summary || "(要約できる項目がありません)",
    siteId: s.siteId,
    deviceLabel: s.deviceLabel,
    actor: s.actor,
    // 封筒の属性も残す。tenant id(subject)や Location の deprecation 通知が入っている。
    payload: { ...frame.payload, _cloudevent: { source: frame.source, typeUrl: frame.typeUrl, attributes: frame.attributes } },
    decodeError: frame.decodeError,
  };
}
