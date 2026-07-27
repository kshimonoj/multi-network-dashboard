// Streaming(Central)(20 Task 2)— WSS 接続のライフサイクル管理。
//
// 1 エンドポイント = 1 接続で、選択されたぶんだけ張る(最大 5 本)。
// 接続先: wss://<CENTRAL_BASE_URL のホスト>/<catalog.ts の path>[?event-types=a,b,c]
// 認証:   HTTP アップグレード要求の Authorization: Bearer <access-token> ヘッダー。
//
// ---- 押さえている 4 つのライフサイクル ----
//  1. **トグル**(Task 2-6): settings の enabled / streams[].enabled を見て
//     applySettings() が「あるべき接続集合」に寄せる。設定は store.ts が永続化する。
//  2. **トークン更新**(Task 2-4): トークンは寿命 2 時間。期限切れで Central 側から切られる前に、
//     renewAt(期限 5 分前)にこちらから正常クローズ(1000)→ 新トークンで張り直す。
//     全ストリームで同じトークンを共有するので、更新は token.ts が 1 本にまとめる。
//  3. **予期しない切断**(Task 2-5): 指数バックオフ(1s → 2s → 4s … 最大 60s、±20% のジッタ)で再接続。
//     Central は切断後 **15 分間** イベントをキューするので、その範囲に収まる限り取りこぼさない。
//     再送されたぶんは CloudEvent id の重複排除(store.addEvent)で二重表示にならない。
//  4. **致命的な失敗**: 400(event-types が不正)/ 403(権限・サブスクリプション)は
//     再試行しても直らないので state="error" で止める。401 はトークンを捨てて再試行する。

import WebSocket from "ws";
import { ENDPOINTS, STREAM_KEYS, endpointOf, type StreamKey } from "./catalog.js";
import { decodeFrame, decoderError, toStreamEvent } from "./decoder.js";
import { getCached } from "../global-overview/poller.js";
import { addEvent, getSettings } from "./store.js";
import { CentralConfigError, configError, currentToken, getToken, invalidateToken, wssBase } from "./token.js";
import type { StreamConnState, StreamEvent, StreamStatus } from "./types.js";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** 400 / 403 のあとに人手なしで再試行する間隔(設定を直せば通るので、たまに試す)。 */
const FATAL_RETRY_MS = 15 * 60_000;

interface Conn {
  key: StreamKey;
  ws: WebSocket | null;
  state: StreamConnState;
  since: string | null;
  lastEventAt: string | null;
  received: number;
  attempts: number;
  lastError: string | null;
  url: string | null;
  /** この接続が張られたときの event-types。設定変更の検出に使う */
  appliedTypes: string[];
  retryTimer: NodeJS.Timeout | null;
  renewTimer: NodeJS.Timeout | null;
  nextRetryAt: number | null;
  /** 意図的に閉じたか(再接続を抑止するためのフラグ) */
  closing: boolean;
  /** トークン更新のための計画的な閉じ方か(閉じたあとすぐ張り直す) */
  renewing: boolean;
  generation: number;
}

const conns = new Map<StreamKey, Conn>();

function conn(key: StreamKey): Conn {
  let c = conns.get(key);
  if (!c) {
    c = {
      key,
      ws: null,
      state: "disabled",
      since: null,
      lastEventAt: null,
      received: 0,
      attempts: 0,
      lastError: null,
      url: null,
      appliedTypes: [],
      retryTimer: null,
      renewTimer: null,
      nextRetryAt: null,
      closing: false,
      renewing: false,
      generation: 0,
    };
    conns.set(key, c);
  }
  return c;
}

function setState(c: Conn, state: StreamConnState, error?: string | null): void {
  if (c.state !== state) {
    c.state = state;
    c.since = new Date().toISOString();
  }
  if (error !== undefined) c.lastError = error;
}

function buildUrl(key: StreamKey, eventTypes: string[]): string {
  const def = endpointOf(key)!;
  const url = new URL(`${wssBase()}/${def.path}`);
  // 空 = event-types を付けない(そのエンドポイントの全イベントを受ける)。
  if (eventTypes.length > 0) url.searchParams.set("event-types", eventTypes.join(","));
  return url.toString();
}

// ---- サイト名の解決 ----
// Location イベントは site_id しか持たない。Global Overview のスナップショット
// (既にポーリング済み)で名前に解決する。追加の HTTP は出さない。
function resolveSiteName(siteId: string | null): string | null {
  if (!siteId) return null;
  const sites = getCached().snapshot?.sites ?? [];
  for (const s of sites) {
    if (s.siteId && String(s.siteId) === siteId) return s.siteName;
  }
  return null;
}

function clearTimers(c: Conn): void {
  if (c.retryTimer) {
    clearTimeout(c.retryTimer);
    c.retryTimer = null;
  }
  if (c.renewTimer) {
    clearTimeout(c.renewTimer);
    c.renewTimer = null;
  }
  c.nextRetryAt = null;
}

/**
 * 接続を閉じる。
 *   reason="disable"                … 以後つなぎ直さない。世代を進めて既存ハンドラを無効化する。
 *   reason="renew" / "reconfigure"  … 閉じたあと即座に張り直す。
 *
 * 張り直す側で世代を進めてはいけない(進めると close ハンドラが自分を「古い世代」と
 * 判定して早期 return し、再接続が二度と走らなくなる)。c.ws も close イベントが
 * 来るまで残しておく必要がある — ハンドラが `c.ws !== ws` で自分の担当か判定するため。
 */
function closeConn(c: Conn, reason: "disable" | "renew" | "reconfigure"): void {
  clearTimers(c);
  c.closing = true;
  c.renewing = reason !== "disable";
  const ws = c.ws;
  if (reason === "disable") {
    // 既存のイベントハンドラをすべて無効化してから捨てる。
    c.generation += 1;
    c.ws = null;
    setState(c, "disabled");
    c.attempts = 0;
    c.url = null;
  }
  if (!ws) {
    // 接続がまだ無い状態で張り直しを指示された(接続試行中など)。そのまま開き直す。
    if (reason !== "disable") {
      c.closing = false;
      c.renewing = false;
      void openConn(c.key);
    }
    return;
  }
  try {
    // ドキュメントの推奨どおり正常クローズは 1000。
    ws.close(1000, reason);
    // close イベントが来ない場合に備えて保険(terminate も close を発火させる)。
    setTimeout(() => {
      try {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      } catch {
        /* すでに閉じている */
      }
    }, 3_000).unref?.();
  } catch {
    try {
      ws.terminate();
    } catch {
      /* noop */
    }
  }
}

function scheduleRetry(c: Conn, delayMs: number, why: string): void {
  clearTimers(c);
  const jitter = 0.8 + Math.random() * 0.4;
  const wait = Math.round(delayMs * jitter);
  c.nextRetryAt = Date.now() + wait;
  setState(c, c.state === "error" ? "error" : "reconnecting");
  console.log(`[central-streaming] ${c.key}: ${why} → ${Math.round(wait / 1000)} 秒後に再接続します`);
  c.retryTimer = setTimeout(() => {
    c.retryTimer = null;
    c.nextRetryAt = null;
    void openConn(c.key);
  }, wait);
  c.retryTimer.unref?.();
}

function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

async function openConn(key: StreamKey): Promise<void> {
  const c = conn(key);
  const s = getSettings();
  if (!s.enabled || !s.streams[key].enabled) {
    setState(c, "disabled");
    return;
  }
  if (c.ws) return; // すでに張っている

  const types = [...s.streams[key].eventTypes];
  c.appliedTypes = types;
  c.closing = false;
  c.renewing = false;
  c.attempts += 1;
  const generation = ++c.generation;
  // トークン取得を await する前に state を進めておく。
  // ここを省くと、画面が「有効なのに未接続」と読める状態を数百 ms 表示してしまう。
  setState(c, c.attempts > 1 ? "reconnecting" : "connecting");

  let token: Awaited<ReturnType<typeof getToken>>;
  let url: string;
  try {
    token = await getToken();
    url = buildUrl(key, types);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof CentralConfigError) {
      setState(c, "error", msg);
      return; // 設定が入るまで再試行しても無意味
    }
    setState(c, "reconnecting", msg);
    scheduleRetry(c, backoffMs(c.attempts), `トークン取得に失敗(${msg})`);
    return;
  }

  // openConn を await している間に無効化された場合は張らない。
  if (generation !== c.generation) return;

  c.url = url;

  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token.value}` },
    handshakeTimeout: 20_000,
  });
  c.ws = ws;

  ws.on("open", () => {
    if (generation !== c.generation) {
      try {
        ws.terminate();
      } catch {
        /* noop */
      }
      return;
    }
    c.attempts = 0;
    setState(c, "open", null);
    console.log(
      `[central-streaming] ${key}: 接続しました(${types.length ? `${types.length} 種別` : "全イベント"})`,
    );
    scheduleTokenRenew(c);
  });

  ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
    if (generation !== c.generation) return;
    handleMessage(c, data, isBinary);
  });

  // HTTP アップグレードが拒否された場合(400 / 401 / 403 など)はここに来る。
  ws.on("unexpected-response", (_req, res) => {
    let body = "";
    res.on("data", (chunk: Buffer) => {
      if (body.length < 2000) body += chunk.toString("utf-8");
    });
    res.on("end", () => {
      if (generation !== c.generation) return;
      c.ws = null;
      const status = res.statusCode ?? 0;
      const detail = body.replace(/\s+/g, " ").trim().slice(0, 300);
      const msg = `HTTP ${status}${detail ? ` ${detail}` : ""}`;
      if (status === 401) {
        // トークンが失効している。取り直して普通のバックオフで再試行する。
        invalidateToken();
        setState(c, "reconnecting", msg);
        scheduleRetry(c, backoffMs(c.attempts), "401(トークン失効)");
        return;
      }
      if (status === 400 || status === 403 || status === 404) {
        // event-types が不正 / 権限が無い / エンドポイントが無い。設定を直さない限り直らない。
        setState(c, "error", msg);
        scheduleRetry(c, FATAL_RETRY_MS, `${status}(設定または権限の問題)`);
        return;
      }
      setState(c, "reconnecting", msg);
      scheduleRetry(c, backoffMs(c.attempts), msg);
    });
  });

  ws.on("error", (err) => {
    if (generation !== c.generation) return;
    // unexpected-response のあとにも error が来ることがあるので、その場合は上書きしない。
    if (c.ws !== ws) return;
    c.lastError = err instanceof Error ? err.message : String(err);
  });

  ws.on("close", (code, reasonBuf) => {
    if (generation !== c.generation) return;
    if (c.ws !== ws) return;
    c.ws = null;
    clearTimers(c);
    const reason = reasonBuf?.toString("utf-8").slice(0, 200) ?? "";
    if (c.closing && !c.renewing) {
      setState(c, "disabled");
      return;
    }
    const why = `切断されました(code=${code}${reason ? ` ${reason}` : ""})`;
    if (c.renewing) {
      // 計画的な張り直し。バックオフを挟まず即座に繋ぐ。
      c.renewing = false;
      c.attempts = 0;
      setState(c, "reconnecting", null);
      void openConn(key);
      return;
    }
    setState(c, "reconnecting", why);
    scheduleRetry(c, backoffMs(c.attempts + 1), why);
  });
}

/**
 * トークンの renewAt に合わせて、こちらから張り直す(Task 2-4)。
 * Central 側は期限切れで一方的に切ってくるため、切られる前に更新したほうが
 * キューイング(15 分)にも余裕を持って収まる。
 */
function scheduleTokenRenew(c: Conn): void {
  if (c.renewTimer) clearTimeout(c.renewTimer);
  const tok = currentToken();
  if (!tok) return;
  const wait = Math.max(30_000, tok.renewAt - Date.now());
  c.renewTimer = setTimeout(() => {
    c.renewTimer = null;
    if (c.state !== "open") return;
    console.log(`[central-streaming] ${c.key}: トークン更新のため張り直します`);
    invalidateToken();
    closeConn(c, "renew");
  }, wait);
  c.renewTimer.unref?.();
}

function handleMessage(c: Conn, data: WebSocket.RawData, isBinary: boolean): void {
  const now = new Date().toISOString();
  c.lastEventAt = now;
  c.received += 1;

  let buf: Buffer;
  if (Buffer.isBuffer(data)) buf = data;
  else if (Array.isArray(data)) buf = Buffer.concat(data);
  else buf = Buffer.from(data as ArrayBuffer);

  if (!isBinary) {
    // 実測ではすべてバイナリ。テキストで来たら生のまま残しておく。
    const text = buf.toString("utf-8");
    addEvent({
      id: `${c.key}-text-${now}-${c.received}`,
      receivedAt: now,
      eventAt: null,
      stream: c.key,
      type: "(text frame)",
      typeLabel: "テキストフレーム",
      category: null,
      summary: text.slice(0, 300),
      siteId: null,
      siteName: null,
      deviceLabel: null,
      actor: null,
      payload: { text },
      decodeError: "protobuf ではないテキストフレームを受信しました",
    });
    return;
  }

  try {
    const frame = decodeFrame(buf, c.key);
    const base = toStreamEvent(c.key, frame, now);
    const ev: StreamEvent = { ...base, siteName: resolveSiteName(base.siteId) };
    addEvent(ev);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    c.lastError = `デコード失敗: ${msg}`;
    addEvent({
      id: `${c.key}-undecodable-${now}-${c.received}`,
      receivedAt: now,
      eventAt: null,
      stream: c.key,
      type: "(decode error)",
      typeLabel: "デコード失敗",
      category: null,
      summary: `CloudEvent 封筒をデコードできませんでした(${buf.length} バイト)`,
      siteId: null,
      siteName: null,
      deviceLabel: null,
      actor: null,
      payload: { hex: buf.subarray(0, 64).toString("hex") },
      decodeError: msg,
    });
  }
}

// ---- 外から呼ぶ口 ----

/**
 * 現在の設定に合わせて接続集合を寄せる。
 * ・無効になったストリーム → 閉じる
 * ・有効なのに繋がっていない → 張る
 * ・event-types が変わった   → 張り直す(URL に埋まっているため)
 */
export async function applySettings(): Promise<void> {
  const s = getSettings();
  for (const key of STREAM_KEYS) {
    const c = conn(key);
    const want = s.enabled && s.streams[key].enabled;
    if (!want) {
      if (c.ws || c.state !== "disabled") closeConn(c, "disable");
      continue;
    }
    const types = s.streams[key].eventTypes;
    const changed =
      c.appliedTypes.length !== types.length || c.appliedTypes.some((t, i) => t !== types[i]);
    if (c.ws && changed) {
      console.log(`[central-streaming] ${key}: 購読するイベント種別が変わったので張り直します`);
      closeConn(c, "reconfigure");
      // close イベント経由で renewing の分岐に入り、すぐ張り直される。
      continue;
    }
    if (!c.ws && !c.retryTimer) {
      c.attempts = 0;
      void openConn(key);
    }
  }
}

/** すべての接続を閉じる(プロセス終了時)。 */
export function stopAll(): void {
  for (const c of conns.values()) closeConn(c, "disable");
}

/**
 * デバッグ・動作確認用(Task 5-4)。指定ストリームの接続を強制的に切断して、
 * 再接続ロジックが働くことを確かめる。abnormal=true なら異常切断(1006 相当)。
 */
export function forceDisconnect(key: StreamKey): boolean {
  const c = conns.get(key);
  if (!c?.ws) return false;
  // terminate() は close フレームを送らずソケットを落とすので、
  // Central 側から見ると異常切断になり、こちらは close(1006) を受け取る。
  try {
    c.ws.terminate();
  } catch {
    return false;
  }
  return true;
}

export function statuses(): StreamStatus[] {
  const s = getSettings();
  const tok = currentToken();
  return ENDPOINTS.map((def) => {
    const c = conn(def.key);
    const enabled = s.enabled && s.streams[def.key].enabled;
    return {
      key: def.key,
      label: def.label,
      enabled,
      state: enabled ? c.state : "disabled",
      since: c.since,
      lastEventAt: c.lastEventAt,
      received: c.received,
      attempts: c.attempts,
      nextRetryAt: c.nextRetryAt ? new Date(c.nextRetryAt).toISOString() : null,
      lastError: c.lastError,
      url: c.url,
      eventTypes: [...s.streams[def.key].eventTypes],
      tokenExpiresAt: tok ? new Date(tok.expiresAt).toISOString() : null,
    };
  });
}

/** 起動時のチェック(資格情報 / proto の読み込み)。 */
export function readiness(): { configured: boolean; configError: string | null } {
  const cfg = configError();
  const dec = decoderError();
  return {
    configured: cfg === null && dec === null,
    configError: cfg ?? (dec ? `proto の読み込みに失敗しました: ${dec}` : null),
  };
}
