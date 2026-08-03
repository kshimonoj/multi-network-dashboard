// Webhook ログ →「調査する」ボタン(17 Task 3-3)のクエリ文組み立て。
//
// Global Overview 側の view/investigate.ts と同じ体裁の日本語文にして、15 番で実装済みの
// 共有 state(pendingInvestigationQuery)経由でネットワーク調査タブへ渡す。実行はしない。
//
// ソースごとにフィールドの有無が違う(Classic Central はサイトを持たない / Mist は topic が分類)
// ので、その差はここで吸収して「どこで・何が・いつ」が読める 1 文にまとめる。

import type { InvestigationRequest } from "../../../src/shell";
import { SOURCE_LABEL, type WebhookFeedItem } from "./types";
import { formatDateTime, getLang, translate } from "../../../src/i18n";

function fmtTime(iso: string | null): string {
  const lang = getLang();
  // 33 L-10: 日時は表示言語のロケールで整形する(解釈できない値は「時刻不明」)。
  return formatDateTime(iso, lang, translate(lang, "webhookFeed.investigateQuery.timeUnknown"));
}

export function buildWebhookInvestigationQuery(item: WebhookFeedItem): InvestigationRequest {
  const lang = getLang();
  const src = SOURCE_LABEL[item.source];
  // サイトが解決できていればサイト名で、できなければソース名だけで「どこで」を作る。
  // Classic Central は Webhook にサイト ID が載らないので、対象デバイスが「どこで」の代わりになる。
  const where = item.siteName ? `${item.siteName}(${src})` : src;

  const tags = [item.severityRaw, item.category, item.type]
    .map((v) => (v ?? "").trim())
    .filter(Boolean);
  const tag = tags.length ? `[${[...new Set(tags)].join(" / ")}] ` : "";

  const device = item.deviceLabel
    ? translate(lang, "webhookFeed.investigateQuery.deviceSuffix", { device: item.deviceLabel })
    : "";
  const when = fmtTime(item.eventAt ?? item.receivedAt);

  const query = translate(lang, "webhookFeed.investigateQuery.template", {
    where,
    tag,
    message: item.message,
    when,
    device,
  }).trimEnd();

  return { query, site: item.siteName };
}

/**
 * 自動事前調査(Task 4)が済んでいる行から「さらに詳しく聞く」ときのクエリ。
 * 既に出ている要約を踏まえたうえで、深掘りを促す文面にする。
 */
export function buildFollowUpQuery(item: WebhookFeedItem): InvestigationRequest {
  const base = buildWebhookInvestigationQuery(item);
  if (!item.auto || item.auto.status !== "done" || !item.auto.summary) return base;
  const lang = getLang();
  return {
    query:
      base.query +
      translate(lang, "webhookFeed.investigateQuery.followUpSuffix", { summary: item.auto.summary }),
    site: base.site,
  };
}
