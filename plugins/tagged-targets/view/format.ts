// タグ付き Client / Device View — 表示整形のうち、i18n の format.ts に無いもの。
//
// 日時・数値・相対時刻は src/i18n/format.ts に集約されている(33 番)。
// ここに置くのは**ロケール非依存**の整形と、このタブ固有の分岐だけ。

import type { TFunc } from "../../../src/i18n";

/** 12 桁 MAC → コロン区切り(表示用)。サーバ側 mac.ts の toColonMac と同じ規則。 */
export function toColonMac(key: string): string {
  return (key.match(/.{2}/g) ?? []).join(":");
}

/** 秒 → 「3d 4h 12m」。単位記号はロケール非依存に保つ(時刻列の幅を一定にするため)。 */
export function formatUptime(sec: number | null | undefined): string | null {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return null;
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatUptimeMs(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : formatUptime(Math.floor(ms / 1000));
}

/**
 * Central の `lastSeenAt` は接続中のクライアントで**文字列 `"0"`** が返る(58 §1-8-1)。
 * 日時としてレンダリングしてはいけないので、ここで status と統合して扱う
 * (58 §4 判断事項 #5 の確定: 「接続中」と出す)。
 *
 * @returns { mode: "connected" } … 接続中(最終確認時刻は出さない)
 *          { mode: "at", iso }   … 日時として出してよい
 *          { mode: "none" }      … 情報なし(行ごと省く)
 */
export function centralLastSeen(raw: string | null): { mode: "connected" | "at" | "none"; iso?: string } {
  if (!raw || raw === "0") return { mode: raw === "0" ? "connected" : "none" };
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? { mode: "none" } : { mode: "at", iso: raw };
}

/**
 * `tunnelType` は実データで文字列 `"None"` が返る(58 §1-8-8)。
 * null と `"None"` の両方を「トンネル未使用」として扱い、行を出さない。
 */
export function meaningful(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  if (!t || t === "None" || t === "-" || t === "--") return null;
  return t;
}

/**
 * `mloOperMode` は Wi-Fi 6 AP 配下でも `MLO Disabled` が入る(58 §1-8-9)。
 * 常時表示すると情報量ゼロの行が増えるので、無効のときは出さない
 * (58 §4 判断事項 #4 の確定)。
 */
export function mloValue(v: string | null): string | null {
  const t = meaningful(v);
  if (!t) return null;
  return /disabled/i.test(t) ? null : t;
}

/**
 * ポートのリンク速度(Mbps)→ 表示文字列。1000 Mbps 以上は Gbps に畳む。
 * Central / Mist の両方のポート表で共用する(単位の正規化は取得側で済ませてある)。
 */
export function formatLinkSpeed(mbps: number | null | undefined): string | null {
  if (mbps === null || mbps === undefined || !Number.isFinite(mbps) || mbps <= 0) return null;
  if (mbps >= 1000) {
    const g = mbps / 1000;
    return `${Number.isInteger(g) ? g : g.toFixed(1)} Gbps`;
  }
  return `${mbps} Mbps`;
}

/** Central / Mist の status 文字列 → 状態バッジのクラス種別。 */
export function statusKind(v: string | null | undefined): "up" | "down" | "unknown" {
  const t = String(v ?? "").toLowerCase();
  if (!t) return "unknown";
  if (["online", "connected", "up", "ok"].includes(t)) return "up";
  if (["offline", "disconnected", "down", "failed"].includes(t)) return "down";
  return "unknown";
}

/** 「接続中」/「最後に見たのは N」の一言。t は useT() のもの。 */
export function presenceText(t: TFunc, connected: boolean): string {
  return connected ? t("taggedTargets.presence.connected") : t("taggedTargets.presence.notFound");
}
