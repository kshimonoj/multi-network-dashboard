import type { SuggestedAction } from "./types";

// 回答の下に出す「クリック可能な追い質問」チップ(Task 1)。
// クリックすると、そのクエリ・サイトが入力欄に反映され、即時実行される。
// 提案が無いときは何も描画しない(過剰生成が無いケースで余計なUIを出さない)。
export function SuggestedActions({
  actions,
  onRun,
}: {
  actions: SuggestedAction[] | undefined;
  onRun: (query: string, site: string | null) => void;
}) {
  if (!actions || actions.length === 0) return null;
  return (
    <div className="ni-suggested">
      <div className="ni-suggested-label">続けて調べる</div>
      <div className="ni-suggested-chips">
        {actions.map((a, i) => (
          <button
            key={i}
            className="ni-chip"
            title={a.query + (a.site ? ` (site=${a.site})` : "")}
            onClick={() => onRun(a.query, a.site ?? null)}
          >
            {a.label}
            {a.site ? <span className="ni-chip-site">{a.site}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
