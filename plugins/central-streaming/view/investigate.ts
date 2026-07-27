// Streaming(Central)→「調査する」(20 Task 4-4)。
// 15 番で実装済みの共有 state(pendingInvestigationQuery)にそのまま乗せるので、
// ここでやるのは「日本語のクエリ文を組み立てる」ことだけ。実行はしない。

import type { InvestigationRequest } from "../../../src/shell";
import { STREAM_SHORT, type StreamEvent } from "./types";

function fmt(iso: string | null): string {
  if (!iso) return "時刻不明";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "時刻不明" : d.toLocaleString("ja-JP", { hour12: false });
}

export function buildStreamInvestigationQuery(ev: StreamEvent): InvestigationRequest {
  const when = fmt(ev.eventAt ?? ev.receivedAt);
  const tags = [STREAM_SHORT[ev.stream], ev.typeLabel, ev.category].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
  const where = ev.siteName ?? (ev.siteId ? `サイト ID ${ev.siteId}` : null);
  const device = ev.deviceLabel ? `関連デバイス: ${ev.deviceLabel}。` : "";
  const actor = ev.actor ? `実行者: ${ev.actor}。` : "";

  const query =
    `New Central の Streaming API で受信した以下のイベントについて、` +
    `背景・影響範囲・対応の要否を調査して: ` +
    `[${tags.join(" / ")}] ${ev.summary}(${when})。` +
    (where ? `対象サイト: ${where}。` : "") +
    device +
    actor;

  return { query, site: ev.siteName };
}
