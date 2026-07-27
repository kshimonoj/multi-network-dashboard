import { LogoBadge } from "./LogoBadge";
import { ToolCallRow } from "./ToolCallRow";
import type { McpCall, PlatformJudgment, RoutingView } from "./types";

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

function statusLabel(c: McpCall): string {
  if (c.status === "calling") return "問い合わせ中…";
  if (c.status === "error") return "失敗";
  return c.count != null ? `完了・${c.count}件` : "完了";
}

export function SseLog({
  routing,
  calls,
  judgments,
  running,
  query,
  site,
}: {
  routing: RoutingView | null;
  calls: McpCall[];
  judgments: PlatformJudgment[];
  running: boolean;
  query: string | null;
  site: string | null;
}) {
  const hasContent = routing || calls.length > 0 || judgments.length > 0 || running;
  return (
    <div className="ni-sse-panel">
      <div className="ni-sse-head">
        <span className="ni-mono">{query ? `クエリ: 「${query}」` : "MCP 呼び出しログ"}</span>
        <span className="ni-mono ni-dim">{site ? `site=${site}` : "site=未指定"}</span>
      </div>

      <div className="ni-sse-log">
        {!hasContent && <div className="ni-sse-empty">クエリを実行すると、MCP 呼び出しがここにリアルタイムで流れます。</div>}

        {routing && (
          <div className="ni-routing">
            {routing.used.map((s) => (
              <span className="ni-routing-item" key={`u-${s}`}>
                <LogoBadge target={s} size={22} title={s} />
                <span className="ni-mono">{s} 使用</span>
              </span>
            ))}
            {routing.skipped.map((s) => (
              <span className="ni-routing-item skipped" key={`s-${s}`}>
                <LogoBadge target={s} size={22} skipped title={`${s}(スキップ)`} />
                <span className="ni-mono ni-dim">{s}</span>
              </span>
            ))}
            <span className="ni-skip-tag">{routing.reason}</span>
          </div>
        )}

        {/* モデル判断による省略(Task 1)。サイト管理スキップとは別の見た目(吹き出しアイコン)。 */}
        {judgments.map((j) => (
          <div className="ni-judgment" key={`j-${j.platform}`}>
            <span className="ni-judgment-icon" aria-hidden>
              💬
            </span>
            <LogoBadge target={j.platform} size={20} skipped title={`${platformName(j.platform)}(モデル判断で省略)`} />
            <span className="ni-mono ni-judgment-text">
              <span className="ni-judgment-tag">モデル判断</span>
              {platformName(j.platform)} は不要と判断: {j.reason}
            </span>
          </div>
        ))}

        {/* 失敗した行はクリックで詳細(ステータス・エラー本文・引数)を展開できる(08 Task 1)。 */}
        {calls.map((c) => (
          <ToolCallRow key={c.id} call={c} badgeSize={22} statusText={statusLabel(c)} showDot />
        ))}

        {running && (
          <div className="ni-call-row ni-thinking">
            <span className="ni-mono ni-dim">エージェントが回答を組み立てています…</span>
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
          <LogoBadge target="central" size={14} skipped /> スキップ(グレースケール)
        </span>
      </div>
    </div>
  );
}
