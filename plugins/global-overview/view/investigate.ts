// Event/Alert →「調査する」ボタン(15番)共通のクエリ文組み立て。
// EventFeed(全サイト横断タイムライン)と SiteDetailPage(サイト詳細のアラート/イベント欄)の
// どちらも、同じ体裁の日本語クエリ文にしてネットワーク調査タブへ渡す。

import type { InvestigationRequest } from "../../../src/shell";
import { PLATFORM_SHORT, type Platform } from "./types";
import { getLang, translate } from "../../../src/i18n/i18n";

export interface InvestigationSource {
  siteName: string;
  platform: Platform;
  kind: "alert" | "event";
  /** 重要度(正規化済みラベル or API の生値)。無ければ null */
  severity: string | null;
  category: string | null;
  text: string;
  /** 表示用に整形済みの発生時刻文字列 */
  time: string;
}

export function buildInvestigationQuery(src: InvestigationSource): InvestigationRequest {
  const lang = getLang();
  const kind = translate(lang, src.kind === "alert" ? "eventFeed.investigateQuery.kindAlert" : "eventFeed.investigateQuery.kindEvent");
  const tags = [src.severity, src.category].filter((v): v is string => Boolean(v && v.trim()));
  const tag = tags.length > 0 ? `[${tags.join(" / ")}] ` : "";
  const query = translate(lang, "eventFeed.investigateQuery.template", {
    site: src.siteName,
    platform: PLATFORM_SHORT[src.platform],
    kind,
    tag,
    text: src.text,
    time: src.time,
  });
  return { query, site: src.siteName };
}
