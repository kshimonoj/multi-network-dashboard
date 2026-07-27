import { LogoBadge } from "./LogoBadge";
import { toolLabel } from "./toolLabels";
import type { ToolCallFailure } from "./types";

// MCP ツール呼び出し 1 行の共有部品(08 Task 1)。
//
// 実行中のログ(SseLog)と履歴のターン(Turn)で同じ見た目・同じ展開挙動にするため、
// 行の描画をここへ集約する。ステータス文言だけは文脈で違う(実行中は「問い合わせ中…」、
// 履歴では「未完了」)ので、呼び出し側から statusText として渡す。
//
// 失敗した行(status="error")だけを <details> にして、クリックで
//   - HTTP ステータス(拾えたとき)
//   - MCP サーバーが返したエラー本文
//   - 呼び出し引数の全文 JSON
// を展開表示する。ヘッダ行の要約(detail)は 2 項目までなので、
// 「params の中身が足りずに失敗した」ようなケースは全文を見ないと判断できない。

export interface ToolCallRowData extends ToolCallFailure {
  server: string;
  tool: string;
  status: "calling" | "done" | "error";
  detail?: string;
}

function hasFailureDetail(c: ToolCallRowData): boolean {
  return c.status === "error" && Boolean(c.error || c.input);
}

export function ToolCallRow({
  call,
  badgeSize,
  statusText,
  showDot = false,
}: {
  call: ToolCallRowData;
  badgeSize: number;
  statusText: string;
  showDot?: boolean;
}) {
  const label = toolLabel(call.tool);
  const showRaw = label !== call.tool; // ラベルがある時だけ生ツール名を併記

  const body = (
    <>
      <LogoBadge target={call.server} size={badgeSize} title={call.server} />
      <span className="ni-mono ni-tool">
        {label}
        {showRaw ? <span className="ni-dim ni-tool-raw"> {call.tool}</span> : null}
        {call.detail ? <span className="ni-dim">({call.detail})</span> : null}
      </span>
      <span className={`ni-status ${call.status}`}>
        {showDot && <span className="ni-dot" />}
        {statusText}
      </span>
    </>
  );

  // 失敗詳細が無い行(成功・実行中、および詳細を持たない古い履歴)は従来どおりの素の行。
  if (!hasFailureDetail(call)) return <div className="ni-call-row">{body}</div>;

  return (
    <details className="ni-call-fail">
      <summary className="ni-call-row" title="クリックで失敗の詳細を表示">
        {body}
      </summary>
      <div className="ni-call-fail-body">
        <div className="ni-call-fail-head">
          {call.errorStatus != null ? (
            <span className="ni-err-code">HTTP {call.errorStatus}</span>
          ) : (
            <span className="ni-err-code none">ステータスコードなし</span>
          )}
          <span className="ni-dim sm">MCP サーバー({call.server})が返したエラー</span>
        </div>
        {call.error && <pre className="ni-err-text">{call.error}</pre>}
        {call.input && (
          <>
            <div className="ni-err-label ni-dim">呼び出し引数</div>
            <pre className="ni-err-text">{call.input}</pre>
          </>
        )}
      </div>
    </details>
  );
}
