import { LogoBadge } from "./LogoBadge";
import { Markdown } from "./Markdown";
import { McpHealthNotice, mcpHealthTagLabel } from "./McpHealthNotice";
import { ShareActions } from "./ShareActions";
import { SuggestedActions } from "./SuggestedActions";
import { ToolCallRow } from "./ToolCallRow";
import { SOURCE_LABEL, type SessionTurn } from "./session";
import type { HistoryToolCall } from "./types";

// セッションの 1 ターン(1回のクエリと回答)を描画する共有部品(04 Task 3)。
//
// スレッド表示(HistoryThread)と実行コンソール(NetworkInvestigation)の両方がこれを使う。
// 同じ見た目にしておくことで、実行中の run が完了して履歴に載っても表示が入れ替わらない。
//
// 根要素に data-ni-turn={turn.id} を置く。セッション全体の印刷(SessionShare)が、
// 印刷ツリー側の同じ属性と突き合わせて、描画済みのグラフ / トポロジ図 SVG を複製するため。

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const platformName = (p: string) => (p === "central" ? "Central" : p === "mist" ? "Mist" : p);

function callStatusLabel(c: HistoryToolCall): string {
  if (c.status === "error") return "失敗";
  if (c.status === "calling") return "未完了";
  return c.count != null ? `完了・${c.count}件` : "完了";
}

export function Turn({
  turn,
  index,
  total,
  onRunAction,
  onLoadQuery,
}: {
  turn: SessionTurn;
  index: number; // 0 始まり
  total: number;
  onRunAction: (query: string, site: string | null) => void;
  onLoadQuery?: (turn: SessionTurn) => void;
}) {
  const single = total <= 1;
  const answer = turn.answer;
  // MCP 接続の警告(09)。回答は返っているので isError とは独立に扱う。
  const healthLevel = turn.mcpHealth && turn.mcpHealth.level !== "ok" ? turn.mcpHealth.level : null;
  const healthTag = healthLevel ? mcpHealthTagLabel(healthLevel) : null;

  return (
    <article
      className={`ni-turn${turn.isError ? " error" : healthLevel ? ` mcp-${healthLevel}` : ""}`}
      data-ni-turn={turn.id}
    >
      <div className="ni-turn-head">
        <span className="ni-turn-no ni-mono">{single ? "調査" : `ターン ${index + 1}/${total}`}</span>
        <span className="ni-mono ni-dim">{fmtTime(turn.ts)}</span>
        <span className={`ni-tag ${turn.source}`}>{SOURCE_LABEL[turn.source] ?? "手動"}</span>
        {turn.mcpServers.map((s) => (
          <LogoBadge key={s} target={s} size={16} title={s} />
        ))}
        {turn.site && <span className="ni-mono ni-dim">site={turn.site}</span>}
        <span className="ni-mono ni-dim">model={turn.model || "(旧・未指定)"}</span>
        {turn.isError && <span className="ni-tag error">失敗</span>}
        {healthTag && (
          <span
            className={`ni-tag mcp-${healthLevel}`}
            title="narrowing で含めた MCP サーバーのうち、1 度も使われず、直接確認でも到達できなかったものがあります"
          >
            {healthTag}
          </span>
        )}
        <span className="ni-turn-actions">
          {onLoadQuery && (
            <button className="ni-btn sm" onClick={() => onLoadQuery(turn)} title="このクエリを入力欄に読み込む">
              入力欄へ
            </button>
          )}
          {/* 単発の共有(03 Task 2)。セッション全体の共有はスレッド見出し側にある。 */}
          {!turn.isError && answer && (
            <ShareActions
              compact
              report={{
                query: turn.query,
                site: turn.site,
                ts: turn.ts,
                model: turn.model,
                tools: turn.calls.map((c) => c.tool),
                platforms: turn.platformsUsed,
                answer,
              }}
            />
          )}
        </span>
      </div>

      <div className="ni-turn-query">{turn.query}</div>

      {/* モデル判断による省略(あれば) */}
      {turn.judgments.length > 0 && (
        <div className="ni-turn-judgments">
          {turn.judgments.map((j) => (
            <div className="ni-judgment" key={j.platform}>
              <span className="ni-judgment-icon" aria-hidden>
                💬
              </span>
              <LogoBadge target={j.platform} size={18} skipped title={platformName(j.platform)} />
              <span className="ni-mono ni-judgment-text">
                {platformName(j.platform)} は不要と判断: {j.reason}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 呼び出したツール一覧。ターンが複数あるスレッドでは畳んでおく(連続して読めるように)。 */}
      <details className="ni-turn-calls" open={single}>
        <summary className="ni-mono ni-dim">
          呼び出したツール({turn.calls.length})
          {turn.platformsUsed.length > 0 && ` ・ ${turn.platformsUsed.map(platformName).join(" / ")}`}
        </summary>
        {turn.calls.length === 0 ? (
          <div className="ni-dim sm">この実行のツール呼び出しは記録されていません。</div>
        ) : (
          <div className="ni-detail-calls">
            {/* 失敗した行はクリックで詳細(ステータス・エラー本文・引数)を展開できる(08 Task 1)。 */}
            {turn.calls.map((c, i) => (
              <ToolCallRow key={`${c.tool}-${i}`} call={c} badgeSize={20} statusText={callStatusLabel(c)} />
            ))}
          </div>
        )}
      </details>

      {/* MCP サーバーに接続できていなかった警告(09)。回答の直前に出す。 */}
      <McpHealthNotice health={turn.mcpHealth} />

      {turn.isError ? (
        <div className="ni-answer error">
          <div className="ni-answer-body">{turn.reason || "実行に失敗しました"}</div>
        </div>
      ) : answer ? (
        <div className="ni-answer">
          <div className="ni-answer-body">
            <Markdown text={answer} />
          </div>
          <SuggestedActions actions={turn.suggestedActions} onRun={onRunAction} />
        </div>
      ) : (
        <div className="ni-dim sm">回答が記録されていません。</div>
      )}
    </article>
  );
}
