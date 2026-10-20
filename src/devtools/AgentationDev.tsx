// Agentation(画面上の要素に注釈を付けて Claude Code に渡す開発用ツールバー。85)。
//
// **開発時(npm run dev = Vite middleware)にだけ読み込む。** 本番は Docker で dist/ を配信しているので、
// ツールバーが本番バンドルに入ってはならない。そのため main.tsx 側で
// `import.meta.env.DEV ? lazy(() => import("./devtools/AgentationDev")) : null` と書き、
// vite build では条件が false に畳まれて動的 import ごと消える(このファイルも agentation も
// dist に出力されない)。main.tsx から静的 import しないこと。静的 import にすると
// agentation のチャンクが本番に残る。
//
// 注釈の受け口は agentation-mcp の HTTP サーバー(既定 4747)。Claude Code は同じプロセスの
// MCP(stdio)ツール agentation_get_all_pending 等で注釈を読む。プロジェクト直下の
// .mcp.json に登録してある(ポート 4747 は 8010 / 8011 / 8092 と衝突しない。85_findings)。

import { Agentation } from "agentation";

const AGENTATION_ENDPOINT = "http://localhost:4747";

export default function AgentationDev() {
  return <Agentation endpoint={AGENTATION_ENDPOINT} />;
}
