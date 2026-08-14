import { useT, type TFunc } from "../../../src/i18n";
import { countNativeAiCalls } from "../ai-source";
import { AiSourceNote } from "./AiSource";
import { LogoBadge } from "./LogoBadge";
import { Markdown } from "./Markdown";
import { McpHealthNotice, mcpHealthTagLabel } from "./McpHealthNotice";
import { ShareActions } from "./ShareActions";
import { SuggestedActions } from "./SuggestedActions";
import { ToolCallRow } from "./ToolCallRow";
import { formatDuration, sourceLabel, type SessionTurn } from "./session";
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

function callStatusLabel(t: TFunc, c: HistoryToolCall): string {
  if (c.status === "error") return t("networkInvestigation.status.error");
  if (c.status === "calling") return t("networkInvestigation.status.unfinished");
  return c.count != null
    ? t("networkInvestigation.status.doneCount", { n: c.count })
    : t("networkInvestigation.status.done");
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
  const t = useT();
  const single = total <= 1;
  const answer = turn.answer;
  // MCP 接続の警告(09)。回答は返っているので isError とは独立に扱う。
  const healthLevel = turn.mcpHealth && turn.mcpHealth.level !== "ok" ? turn.mcpHealth.level : null;
  const healthTag = healthLevel ? mcpHealthTagLabel(t, healthLevel) : null;
  // 出所(56)。ネイティブ AI 由来の呼び出し件数。0 なら見出しも注記も従来どおり出さない。
  const nativeAiCalls = countNativeAiCalls(turn.calls);

  return (
    <article
      className={`ni-turn${turn.isError ? " error" : healthLevel ? ` mcp-${healthLevel}` : ""}`}
      data-ni-turn={turn.id}
    >
      <div className="ni-turn-head">
        <span className="ni-turn-no ni-mono">
          {single
            ? t("networkInvestigation.turn.single")
            : t("networkInvestigation.turn.no", { i: index + 1, n: total })}
        </span>
        <span className="ni-mono ni-dim">{fmtTime(turn.ts)}</span>
        <span className={`ni-tag ${turn.source}`}>{sourceLabel(t, turn.source)}</span>
        {turn.mcpServers.map((s) => (
          <LogoBadge key={s} target={s} size={16} title={s} />
        ))}
        {turn.site && <span className="ni-mono ni-dim">site={turn.site}</span>}
        <span className="ni-mono ni-dim">
          {t("networkInvestigation.turn.modelLine", {
            model: turn.model || t("networkInvestigation.turn.modelLegacy"),
            duration: formatDuration(t, turn.durationMs),
          })}
        </span>
        {turn.isError && <span className="ni-tag error">{t("networkInvestigation.turn.failTag")}</span>}
        {healthTag && (
          <span
            className={`ni-tag mcp-${healthLevel}`}
            title={t("networkInvestigation.turn.healthTitle")}
          >
            {healthTag}
          </span>
        )}
        <span className="ni-turn-actions">
          {onLoadQuery && (
            <button
              className="ni-btn sm"
              onClick={() => onLoadQuery(turn)}
              title={t("networkInvestigation.turn.loadQueryTitle")}
            >
              {t("networkInvestigation.turn.loadQueryBtn")}
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

      {/* この実行の system prompt に注入された承認済みナレッジ(47)。 */}
      {turn.knowledgeRefs.length > 0 && (
        <div className="ni-knowledge">
          <span className="ni-knowledge-icon" aria-hidden>
            📚
          </span>
          <span className="ni-mono ni-knowledge-text">
            <span className="ni-knowledge-tag">{t("networkInvestigation.sse.knowledgeTag")}</span>
            {t("networkInvestigation.sse.knowledgeText", {
              n: turn.knowledgeRefs.length,
              titles: turn.knowledgeRefs.map((k) => k.title).join(" / "),
            })}
          </span>
        </div>
      )}

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
                {t("networkInvestigation.sse.judgmentText", {
                  platform: platformName(j.platform),
                  reason: j.reason,
                })}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 呼び出したツール一覧。ターンが複数あるスレッドでは畳んでおく(連続して読めるように)。 */}
      <details className="ni-turn-calls" open={single}>
        <summary className="ni-mono ni-dim">
          {t("networkInvestigation.turn.callsSummary", { n: turn.calls.length })}
          {turn.platformsUsed.length > 0 &&
            t("networkInvestigation.turn.callsPlatforms", {
              platforms: turn.platformsUsed.map(platformName).join(" / "),
            })}
          {/* 畳んだ状態でも「ネイティブ AI 由来の取得が含まれるか」が分かるようにする(56)。 */}
          {nativeAiCalls > 0 && t("networkInvestigation.aiSource.callsSummary", { n: nativeAiCalls })}
        </summary>
        {turn.calls.length === 0 ? (
          <div className="ni-dim sm">{t("networkInvestigation.turn.callsEmpty")}</div>
        ) : (
          <div className="ni-detail-calls">
            {/* 失敗した行はクリックで詳細(ステータス・エラー本文・引数)を展開できる(08 Task 1)。 */}
            {turn.calls.map((c, i) => (
              <ToolCallRow key={`${c.tool}-${i}`} call={c} badgeSize={20} statusText={callStatusLabel(t, c)} />
            ))}
          </div>
        )}
      </details>

      {/* MCP サーバーに接続できていなかった警告(09)。回答の直前に出す。 */}
      <McpHealthNotice health={turn.mcpHealth} />

      {/* 出所の注記(56)。ネイティブ AI 由来の取得があった実行にだけ出す。
          「バッジの付いた行 = ベンダーの AI が生成した所見」「回答本文 = Insight Agent の分析」。 */}
      <AiSourceNote calls={turn.calls} />

      {turn.isError ? (
        <div className="ni-answer error">
          <div className="ni-answer-body">{turn.reason || t("networkInvestigation.turn.errorDefault")}</div>
        </div>
      ) : answer ? (
        <div className="ni-answer">
          <div className="ni-answer-body">
            <Markdown text={answer} site={turn.site} />
          </div>
          <SuggestedActions actions={turn.suggestedActions} onRun={onRunAction} />
        </div>
      ) : (
        <div className="ni-dim sm">{t("networkInvestigation.turn.noAnswer")}</div>
      )}
    </article>
  );
}
