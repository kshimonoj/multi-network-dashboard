// タグ付き Client / Device View — 表示プリミティブ(58 §2-2)。
//
// **Central 用 / Mist 用のビューが共有するのは「見た目」だけ。データスキーマは共有しない。**
// ここの部品は label と value(ReactNode)しか知らないので、どちらのプラットフォームの
// 型が変わっても壊れない。

import type { ReactNode } from "react";
import { formatNumber, useT, type TFunc } from "../../../src/i18n";
import { toColonMac } from "./format";

export function SectionCard({
  title,
  note,
  children,
}: {
  title: string;
  note?: string | null;
  children: ReactNode;
}) {
  return (
    <section className="tt-section">
      <div className="tt-section-head">
        <span className="tt-section-title">{title}</span>
        {note && <span className="go-panel-note">{note}</span>}
      </div>
      <div className="tt-section-body">{children}</div>
    </section>
  );
}

/**
 * 1 行。**value が null / 空文字 / 空配列なら行ごと出さない**(58 §2-2)。
 * 「値が無い」と「そのプラットフォームでは取れない」は別物で、後者は <NotSupported> が担当する。
 */
export function FieldRow({
  label,
  value,
  mono = true,
  title,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  title?: string;
}) {
  if (value === null || value === undefined || value === "" || value === false) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  return (
    <div className="tt-field" title={title}>
      <span className="tt-field-label">{label}</span>
      <span className={`tt-field-value${mono ? " go-mono" : ""}`}>{value}</span>
    </div>
  );
}

/**
 * 「このプラットフォームでは取得できません」+ 理由。
 * 空欄で黙らせない(28/33 番で確立した方針の踏襲。58 §2-3)。
 */
export function NotSupported({ reason }: { reason: string }) {
  const t = useT();
  return (
    <div className="tt-unsupported">
      <span className="tt-unsupported-badge">{t("taggedTargets.notSupported.badge")}</span>
      <span className="tt-unsupported-reason">{reason}</span>
    </div>
  );
}

// ---- 信号品質バッジ ----
//
// **単位が違うので Central の SNR(dB)と Mist の RSSI(dBm)で閾値表を分ける**(58 §4 判断事項 #3)。
// SNR の閾値は 58 の提案(>=25 良 / 15–24 可 / <15 不良)をそのまま採用。実証値ではないので、
// 運用しながら調整する前提で 1 か所にまとめてある。

const SNR_GOOD = 25;
const SNR_FAIR = 15;
const RSSI_GOOD = -65;
const RSSI_FAIR = -75;

export type SignalQuality = "good" | "fair" | "poor";

export function snrQuality(v: number): SignalQuality {
  if (v >= SNR_GOOD) return "good";
  if (v >= SNR_FAIR) return "fair";
  return "poor";
}

export function rssiQuality(v: number): SignalQuality {
  if (v >= RSSI_GOOD) return "good";
  if (v >= RSSI_FAIR) return "fair";
  return "poor";
}

export function SignalBadge({ kind, value }: { kind: "snr" | "rssi"; value: number }) {
  const t = useT();
  const q = kind === "snr" ? snrQuality(value) : rssiQuality(value);
  const unit = kind === "snr" ? "dB" : "dBm";
  return (
    <span className={`tt-signal tt-signal-${q}`} title={t(`taggedTargets.signal.${q}`)}>
      <span className="tt-signal-value">
        {value} {unit}
      </span>
      <span className="tt-signal-label">{t(`taggedTargets.signal.${q}`)}</span>
    </span>
  );
}

export function ChipList({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <span className="tt-chips">
      {items.map((c) => (
        <span key={c} className="tt-chip">
          {c}
        </span>
      ))}
    </span>
  );
}

export function PlatformBadge({ platform }: { platform: "central" | "mist" }) {
  const t = useT();
  return (
    <span className={`tt-plat tt-plat-${platform}`}>{t(`taggedTargets.platform.${platform}`)}</span>
  );
}

/** MAC は保存が 12 桁・表示はコロン区切り(57 §3-2)。 */
export function MacText({ value }: { value: string }) {
  return <span className="go-mono">{toColonMac(value)}</span>;
}

/** バイト数の人間可読表示。1024 系(KiB/MiB/GiB)を使い、単位は言語非依存にする。 */
export function formatBytes(v: number | null | undefined, t: TFunc): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = v;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  void t;
  return `${i === 0 ? formatNumber(Math.round(n)) : n.toFixed(1)} ${units[i]}`;
}

/** bps の人間可読表示。ネットワーク慣習どおり 1000 系。 */
export function formatBps(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const units = ["bps", "kbps", "Mbps", "Gbps"];
  let n = v;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i += 1;
  }
  return `${i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}
