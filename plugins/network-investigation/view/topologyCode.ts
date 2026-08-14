// ```topology ブロック(mermaid)の正規化(81 Task 2)。
//
// 背景: 以前の system prompt の例が `A[サイト名] --- B[デバイス名]` だったため、
// エージェントが**サイト名を機器と同列のノードとして描き、接続線で結ぶ**図を出していた。
// サイトは機器ではないので、ノードではなく図のタイトルとして扱うのが正しい。
//
// prompt 側は insight-agent.ts で直したが、
//   - 既に query-history.jsonl に残っている過去の回答
//   - prompt に従わなかった実行
// でも図が壊れて見えないよう、描画の直前にここで機械的に直す。
//
// やること(サイト名が分かっているときだけ):
//   1. ラベルがサイト名と一致するノードを見つける
//   2. そのノードに繋がるエッジを外す(残った相手側はノード宣言として残す = 機器は消えない)
//   3. そのノードの宣言・スタイル指定を削る
//   4. figure のタイトル(mermaid の frontmatter `title:`)にサイト名を出す
//
// DOM も React も触らない純関数なので、単体で検証できる。

/** ノード宣言 `ID[ラベル]` / `ID(ラベル)` / `ID{ラベル}` / `ID>ラベル]` を拾う。 */
const NODE_DEF_RE = /([A-Za-z0-9_][\w-]*)\s*(\[+|\(+|\{+|>)\s*"?(.*?)"?\s*(\]+|\)+|\}+)/g;

/**
 * mermaid のエッジ記号。よく出る形だけを対象にする。
 * `-->` `---` `-.->` `-.-` `==>` `===` `--x` `--o` `<-->` `~~~` と、
 * 直後のラベル `|text|`、`-- text -->` 形式の中置ラベルを含む。
 */
const CONNECTOR_RE =
  /\s*(?:<-{2,}>|-{2,}[xo>]?|<-{2,}|-\.-+[>xo]?|={2,}[>xo]?|~{3,})(?:\|[^|]*\|)?\s*/g;

/** 比較用にラベル / サイト名を正規化する(全角半角・大文字小文字・空白の揺れを吸収)。 */
function normalizeLabel(s: string): string {
  return (s || "")
    .normalize("NFKC")
    .replace(/<br\s*\/?>/gi, " ")
    // ラベルに付きがちな接頭辞(「サイト: HOME LAB」)は落としてから比べる。
    .replace(/^\s*(site|サイト)\s*[:：]\s*/i, "")
    .replace(/[\s　]+/g, " ")
    .trim()
    .toLowerCase();
}

/** 行の先頭にあるノード id(エッジの端点)を取り出す。 */
function leadingNodeId(segment: string): string | null {
  const m = segment.trim().match(/^([A-Za-z0-9_][\w-]*)/);
  return m ? m[1] : null;
}

/** frontmatter(`---` ... `---`)を切り離す。 */
function splitFrontmatter(src: string): { fm: string | null; body: string } {
  const m = src.match(/^\s*---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: null, body: src };
  return { fm: m[1], body: src.slice(m[0].length) };
}

/** YAML の 1 行スカラーとして安全に埋める(サイト名に `:` や `"` が入りうる)。 */
function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * サイト名をノードとして描いてしまっている図を直し、サイト名をタイトルに移す。
 * site が空、または該当ノードが無ければ、タイトルを足す以外は元のコードのまま返す。
 */
export function normalizeTopologyCode(code: string, site?: string | null): string {
  const src = (code || "").replace(/\r\n/g, "\n");
  const siteName = (site || "").trim();
  if (!siteName) return src;

  const { fm, body } = splitFrontmatter(src);
  const target = normalizeLabel(siteName);

  // 1. ラベルがサイト名と一致するノード id を集める。
  const siteIds = new Set<string>();
  NODE_DEF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NODE_DEF_RE.exec(body))) {
    if (normalizeLabel(m[3]) === target) siteIds.add(m[1]);
  }

  let out = body;
  if (siteIds.size > 0) {
    const kept: string[] = [];
    const seen = new Set<string>();
    for (const line of body.split("\n")) {
      for (const rewritten of rewriteLine(line, siteIds)) {
        // 端点を外した結果、同じノード宣言だけの行が並ぶことがあるので畳む。
        const key = rewritten.trim();
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        kept.push(rewritten);
      }
    }
    out = kept.join("\n");
  }

  // 2. タイトル。既に frontmatter に title があれば触らない。
  if (fm != null) {
    const withTitle = /^\s*title\s*:/m.test(fm) ? fm : `${fm}\ntitle: ${yamlQuote(siteName)}`;
    return `---\n${withTitle}\n---\n${out}`;
  }
  return `---\ntitle: ${yamlQuote(siteName)}\n---\n${out}`;
}

/**
 * 1 行からサイトノードを取り除き、残す行を返す(行ごと消す場合は空配列)。
 *
 * 連鎖(`A --- SITE --- B`)でサイトが中間にあるときは、A と B を勝手に繋がない。
 * 元の図が示しているのは「A もサイトに属する」「B もサイトに属する」であって
 * 「A と B が繋がっている」ではないため、連鎖を切って各機器のノード宣言として残す。
 */
function rewriteLine(line: string, siteIds: Set<string>): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [line];

  // style / class / click 等、サイトノードを指す指定は消す。
  if (/^(style|class|classDef|click|linkStyle)\b/.test(trimmed)) {
    const refs = trimmed.match(/[A-Za-z0-9_][\w-]*/g) || [];
    return refs.some((r) => siteIds.has(r)) ? [] : [line];
  }

  // エッジ記号で分割し、ノード参照とコネクタを交互に取り出す。
  const parts: string[] = [];
  const conns: string[] = [];
  let last = 0;
  CONNECTOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONNECTOR_RE.exec(line))) {
    parts.push(line.slice(last, m.index));
    conns.push(m[0]);
    last = m.index + m[0].length;
  }
  parts.push(line.slice(last));

  if (conns.length === 0) {
    // 単独のノード宣言行。サイトノードなら行ごと消す。
    const id = leadingNodeId(line);
    return id && siteIds.has(id) ? [] : [line];
  }

  // サイトノードのところで連鎖を切り、残った区間だけを行として組み直す。
  const indent = line.match(/^\s*/)?.[0] ?? "";
  const out: string[] = [];
  let run: string[] = [];
  let runConns: string[] = [];

  const flush = () => {
    if (run.length === 0) return;
    let s = run[0];
    for (let i = 1; i < run.length; i++) s += runConns[i - 1] + run[i];
    out.push(indent + s.trim());
    run = [];
    runConns = [];
  };

  parts.forEach((p, i) => {
    const id = leadingNodeId(p);
    if (!p.trim() || (id && siteIds.has(id))) {
      flush();
      return;
    }
    if (run.length > 0) runConns.push(conns[i - 1]);
    run.push(p.trim());
  });
  flush();
  return out;
}
