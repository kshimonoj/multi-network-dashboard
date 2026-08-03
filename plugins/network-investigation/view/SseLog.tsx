import { useT, type TFunc } from "../../../src/i18n";
import { LogoBadge } from "./LogoBadge";
import { ToolCallRow } from "./ToolCallRow";
import type { KnowledgeRef, McpCall, PlatformJudgment, RoutingView } from "./types";

// SSE で受け取った「ルーティング判定 + MCP 呼び出し」をモックアップ
// (instructions/reference/network-investigation-sse-mockup.html)のレイアウトで描画する。
// - 呼び出し中(calling): アンバー + パルスドット + 「問い合わせ中...」
// - 完了(done): アクセント色 + 「完了(・N件)」
// - 失敗(error): 赤 + 「失敗」
// スキップした MCP サーバーはグレースケールのロゴバッジ + skip-tag で示す。
//
// 2種類の「省略」を別の見た目で示す(Task 1):
//   - routing_decision の skipped … サイト管理によるスキップ(グレースケールバッジ)
//   - platform_judgment          … モデル判断によるスキップ(吹き出しアイコン付きの別バッジ)

const platformName = (p: string) => (p === "central" ? "Central" : p === "mist" ? "Mist" : p);

/**
 * ルーティング理由の表示文(33 Task 4)。
 * サーバは言語非依存の reasonCode + reasonParams を流す。コードが無い/未知の応答は
 * サーバの日本語文をそのまま出す(空欄より運用しやすい)。
 */
function routingReasonText(t: TFunc, r: RoutingView): string {
  if (!r.reasonCode) return r.reason;
  return t(`networkInvestigation.routing.${r.reasonCode}`, r.reasonParams ?? {});
}

function statusLabel(t: TFunc, c: McpCall): string {
  if (c.status === "calling") return t("networkInvestigation.status.calling");
  if (c.status === "error") return t("networkInvestigation.status.error");
  return c.count != null
    ? t("networkInvestigation.status.doneCount", { n: c.count })
    : t("networkInvestigation.status.done");
}

export function SseLog({
  routing,
  knowledgeRefs,
  calls,
  judgments,
  running,
  query,
  site,
}: {
  routing: RoutingView | null;
  /** system prompt に注入された承認済みナレッジ(47)。無ければ空配列。 */
  knowledgeRefs: KnowledgeRef[];
  calls: McpCall[];
  judgments: PlatformJudgment[];
  running: boolean;
  query: string | null;
  site: string | null;
}) {
  const t = useT();
  const hasContent = routing || knowledgeRefs.length > 0 || calls.length > 0 || judgments.length > 0 || running;
  return (
    <div className="ni-sse-panel">
      <div className="ni-sse-head">
        <span className="ni-mono">
          {query
            ? t("networkInvestigation.sse.headQuery", { query })
            : t("networkInvestigation.sse.headDefault")}
        </span>
        <span className="ni-mono ni-dim">
          {site ? `site=${site}` : t("networkInvestigation.sse.siteUnspecified")}
        </span>
      </div>

      <div className="ni-sse-log">
        {!hasContent && <div className="ni-sse-empty">{t("networkInvestigation.sse.empty")}</div>}

        {routing && (
          <div className="ni-routing">
            {routing.used.map((s) => (
              <span className="ni-routing-item" key={`u-${s}`}>
                <LogoBadge target={s} size={22} title={s} />
                <span className="ni-mono">{t("networkInvestigation.sse.used", { server: s })}</span>
              </span>
            ))}
            {routing.skipped.map((s) => (
              <span className="ni-routing-item skipped" key={`s-${s}`}>
                <LogoBadge target={s} size={22} skipped title={t("networkInvestigation.sse.skippedTitle", { server: s })} />
                <span className="ni-mono ni-dim">{s}</span>
              </span>
            ))}
            <span className="ni-skip-tag">{routingReasonText(t, routing)}</span>
          </div>
        )}

        {/* 承認済みナレッジの注入(47)。何を踏まえて調べ始めたのかをここで見せる。 */}
        {knowledgeRefs.length > 0 && (
          <div className="ni-knowledge">
            <span className="ni-knowledge-icon" aria-hidden>
              📚
            </span>
            <span className="ni-mono ni-knowledge-text">
              <span className="ni-knowledge-tag">{t("networkInvestigation.sse.knowledgeTag")}</span>
              {t("networkInvestigation.sse.knowledgeText", {
                n: knowledgeRefs.length,
                titles: knowledgeRefs.map((k) => k.title).join(" / "),
              })}
            </span>
          </div>
        )}

        {/* モデル判断による省略(Task 1)。サイト管理スキップとは別の見た目(吹き出しアイコン)。 */}
        {judgments.map((j) => (
          <div className="ni-judgment" key={`j-${j.platform}`}>
            <span className="ni-judgment-icon" aria-hidden>
              💬
            </span>
            <LogoBadge
              target={j.platform}
              size={20}
              skipped
              title={t("networkInvestigation.sse.judgmentTitle", { platform: platformName(j.platform) })}
            />
            <span className="ni-mono ni-judgment-text">
              <span className="ni-judgment-tag">{t("networkInvestigation.sse.judgmentTag")}</span>
              {t("networkInvestigation.sse.judgmentText", {
                platform: platformName(j.platform),
                reason: j.reason,
              })}
            </span>
          </div>
        ))}

        {/* 失敗した行はクリックで詳細(ステータス・エラー本文・引数)を展開できる(08 Task 1)。 */}
        {calls.map((c) => (
          <ToolCallRow key={c.id} call={c} badgeSize={22} statusText={statusLabel(t, c)} showDot />
        ))}

        {running && (
          <div className="ni-call-row ni-thinking">
            <span className="ni-mono ni-dim">{t("networkInvestigation.sse.thinking")}</span>
          </div>
        )}
      </div>

      <div className="ni-legend">
        <span>
          <LogoBadge target="central" size={14} /> Central
        </span>
        <span>
          <LogoBadge target="mist" size={14} /> Mist
        </span>
        <span>
          <LogoBadge target="central" size={14} skipped /> {t("networkInvestigation.sse.legendSkipped")}
        </span>
      </div>
    </div>
  );
}
