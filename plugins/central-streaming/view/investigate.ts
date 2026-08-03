// Streaming(Central)→「調査する」(20 Task 4-4)。
// 15 番で実装済みの共有 state(pendingInvestigationQuery)にそのまま乗せるので、
// ここでやるのは「日本語のクエリ文を組み立てる」ことだけ。実行はしない。

import type { InvestigationRequest } from "../../../src/shell";
import { STREAM_SHORT, type StreamEvent } from "./types";
import { formatDateTime, getLang, translate } from "../../../src/i18n";

function fmt(iso: string | null): string {
  const lang = getLang();
  // 33 L-10: 日時は表示言語のロケールで整形する(解釈できない値は「時刻不明」)。
  return formatDateTime(iso, lang, translate(lang, "centralStreaming.investigateQuery.timeUnknown"));
}

export function buildStreamInvestigationQuery(ev: StreamEvent): InvestigationRequest {
  const lang = getLang();
  const when = fmt(ev.eventAt ?? ev.receivedAt);
  const tags = [STREAM_SHORT[ev.stream], ev.typeLabel, ev.category].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
  const where =
    ev.siteName ??
    (ev.siteId ? translate(lang, "centralStreaming.investigateQuery.siteIdFallback", { id: ev.siteId }) : null);
  const siteSuffix = where ? translate(lang, "centralStreaming.investigateQuery.siteSuffix", { site: where }) : "";
  const deviceSuffix = ev.deviceLabel
    ? translate(lang, "centralStreaming.investigateQuery.deviceSuffix", { device: ev.deviceLabel })
    : "";
  const actorSuffix = ev.actor
    ? translate(lang, "centralStreaming.investigateQuery.actorSuffix", { actor: ev.actor })
    : "";

  const query = translate(lang, "centralStreaming.investigateQuery.template", {
    tags: tags.join(" / "),
    summary: ev.summary,
    when,
    siteSuffix,
    deviceSuffix,
    actorSuffix,
  }).trimEnd();

  return { query, site: ev.siteName };
}
