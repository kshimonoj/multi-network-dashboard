import type { ReactNode } from "react";
import { safeHref } from "./safeHref";
import { Chart, parseChartSpec, type ChartSpec } from "./Chart";
import { Topology } from "./Topology";

// 軽量な Markdown レンダラ(Task 3)。回答本文に含まれる Markdown 記法を正しく描画する。
//
// XSS 対策: react-markdown 等の重い依存を足さず、対応記法を React 要素へ直接組み立てる。
// テキストは React が自動エスケープするため生 HTML は一切注入されず(dangerouslySetInnerHTML 不使用)、
// 許可した要素(見出し/箇条書き/番号付き/太字/斜体/インラインコード/コードブロック/リンク/段落)以外は
// 出力されない。リンクは safeHref で http(s)/mailto のみ許可(既存 Newsletter と同じ方針)。
//
// 対応記法(エージェント回答で実際に出てくるもの):
//   # 見出し / ## 見出し …
//   - 箇条書き / * 箇条書き
//   1. 番号付き
//   **太字** / *斜体* / `コード`
//   [ラベル](url)
//   ```コードブロック```
//   | 表 | 記法 |(GFM テーブル。81 Task 3 で追加)
//   段落・空行区切り

// ---- インライン(太字/斜体/コード/リンク)を React ノード配列へ ----

// トークンを1種類ずつ貪欲に切り出す。ネストは太字/斜体の中のテキストのみ想定(十分実用)。
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = text;
  let i = 0;
  // インライン要素を順に探すための正規表現(コード > リンク > 太字 > 斜体 の優先度)。
  // アンダースコアの強調は語中の _ を巻き込まないよう境界を要求する。ネットワーク系の回答には
  // infra_dhcp_failure / last_seen のような識別子が頻出し、素朴に _..._ を強調扱いすると
  // 「infradhcpfailure」のように文字が消えてしまう(共有テキスト側 shareText.ts と同じ方針)。
  const RE = /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)|((?<![A-Za-z0-9_])__[^_]+__(?![A-Za-z0-9_]))|((?<![A-Za-z0-9_])_[^_\s][^_]*_(?![A-Za-z0-9_]))/;
  while (rest) {
    const m = rest.match(RE);
    if (!m || m.index === undefined) {
      nodes.push(rest);
      break;
    }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (tok.startsWith("`")) {
      nodes.push(<code key={key} className="ni-md-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("[")) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      if (lm) {
        const href = safeHref(lm[2]);
        nodes.push(
          href ? (
            <a key={key} href={href} target="_blank" rel="noopener noreferrer">
              {lm[1]}
            </a>
          ) : (
            lm[1]
          ),
        );
      } else {
        nodes.push(tok);
      }
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      nodes.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    rest = rest.slice(m.index + tok.length);
  }
  return nodes;
}

// ---- ブロック(見出し/リスト/コードブロック/段落)----

type CellAlign = "left" | "center" | "right" | null;

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; text: string; lang: string }
  | { kind: "table"; header: string[]; align: CellAlign[]; rows: string[][] }
  | { kind: "hr" }
  | { kind: "p"; text: string };

// 水平線(82)。回答の章の区切りに `---` が普通に出てくるが、ブロックとして解釈していなかったため
// 「---」という文字がそのまま本文に残っていた。テーブルの区切り行はパイプを必須にしてあるので
// (isTableSeparator)、そちらと取り違えることはない。
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

// ---- GFM テーブル(81 Task 3)----
//
// エージェントの回答には `| 列 | 列 |` 形式の表が普通に出てくるが、以前はブロックとして
// 解釈していなかったため、パイプ記号のままの段落として画面にも紙面にも出ていた。
//
// 区切り行(`|---|---:|`)の判定。ヘッダ行の直後にこれが来たときだけ表とみなすので、
// 水平線の `---` を誤って表と解釈することはない(パイプを 1 個以上必須にしている)。
const TABLE_SEP_RE = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/;

function isTableSeparator(line: string): boolean {
  return line.includes("|") && TABLE_SEP_RE.test(line);
}

// 1 行をセルへ分割する。行頭・行末のパイプは区切りではなく枠なので落とす。
// セル内のパイプは GFM と同じく `\|` でエスケープできる。
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      buf += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

function parseAlign(cell: string): CellAlign {
  const s = cell.trim();
  const left = s.startsWith(":");
  const right = s.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

// 行のセル数はヘッダに合わせる(足りなければ空セル、多ければ切り捨て)。
// LLM の出力は列数がずれることがあり、揃えないと表が崩れて見える。
function fitRow(cells: string[], width: number): string[] {
  const out = cells.slice(0, width);
  while (out.length < width) out.push("");
  return out;
}

function parseBlocks(src: string): Block[] {
  const lines = (src || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: "p", text: para.join(" ") });
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // コードフェンス ```(info string = 言語。chart / topology は特別描画する)
    const fence = line.match(/^\s*```\s*([\w-]*)/);
    if (fence) {
      flushPara();
      const lang = (fence[1] || "").toLowerCase();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; // 閉じフェンスをスキップ
      blocks.push({ kind: "code", text: buf.join("\n"), lang });
      continue;
    }

    // 見出し #
    const h = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (h) {
      flushPara();
      blocks.push({ kind: "heading", level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }

    // GFM テーブル(ヘッダ行 + 区切り行 + 本体行)
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara();
      const header = splitTableRow(line);
      const align = fitRow(splitTableRow(lines[i + 1]), header.length).map(parseAlign);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(fitRow(splitTableRow(lines[i]), header.length));
        i++;
      }
      blocks.push({ kind: "table", header, align, rows });
      continue;
    }

    // 水平線 ---(テーブルの区切り行より後に判定する。あちらはパイプを含むので排他)
    if (HR_RE.test(line)) {
      flushPara();
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    // 箇条書き - / *
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    // 番号付き 1.
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    // 空行 → 段落区切り
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara();
  return blocks;
}

// 印刷ツリー側の差し込み口(03b)。ここでは chart / topology を再レンダリングせず、空の
// スロットだけを置く。印刷直前に ShareActions が画面側の描画済み SVG を複製して埋める
// (再レンダリングしない理由は printClone.ts 冒頭を参照)。
function PrintRichSlot({
  kind,
  index,
  title,
}: {
  kind: "chart" | "topology";
  index: number;
  title?: string;
}) {
  return (
    <div className="ni-print-rich">
      {title && <div className="ni-print-rich-title">{title}</div>}
      <div className="ni-print-rich-slot" data-ni-rich={kind} data-ni-index={index} />
    </div>
  );
}

// print: 印刷用ツリー(#ni-print-root)として描画するかどうか。
// true のとき chart / topology は PrintRichSlot になり、画面側の SVG の複製先になる。
// site: 調査対象のサイト名(81 Task 2)。トポロジ図の正規化に使う。
export function Markdown({
  text,
  print = false,
  site,
}: {
  text: string;
  print?: boolean;
  site?: string | null;
}) {
  const blocks = parseBlocks(text);

  // chart / topology に種類ごとの通し番号を振る。同じ回答テキストから画面側(Chart /
  // Topology の根要素の data 属性)と印刷側(スロット)へ同じ番号が振られるため、
  // 印刷時に「N 番目のグラフ」を取り違えずに複製できる(printClone.ts)。
  // 不正なスペックの chart は画面でも生コードブロックになるので番号を振らない。
  const chartSpecs = new Map<number, ChartSpec>();
  const richIndexes = new Map<number, number>();
  let chartCount = 0;
  let topologyCount = 0;
  blocks.forEach((b, i) => {
    if (b.kind !== "code") return;
    if (b.lang === "chart") {
      const spec = parseChartSpec(b.text);
      if (!spec) return;
      chartSpecs.set(i, spec);
      richIndexes.set(i, chartCount++);
    } else if (b.lang === "topology") {
      richIndexes.set(i, topologyCount++);
    }
  });

  return (
    <div className="ni-md">
      {blocks.map((b, bi) => {
        const key = `b-${bi}`;
        switch (b.kind) {
          case "heading": {
            const Tag = (`h${Math.min(b.level + 2, 6)}` as unknown) as keyof JSX.IntrinsicElements;
            return <Tag key={key}>{renderInline(b.text, key)}</Tag>;
          }
          case "ul":
            return (
              <ul key={key}>
                {b.items.map((it, ii) => (
                  <li key={ii}>{renderInline(it, `${key}-${ii}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key}>
                {b.items.map((it, ii) => (
                  <li key={ii}>{renderInline(it, `${key}-${ii}`)}</li>
                ))}
              </ol>
            );
          case "hr":
            return <hr key={key} className="ni-md-hr" />;
          case "table":
            return (
              // 列が多い表でも本文の幅を押し広げないよう、枠の中で横スクロールさせる。
              <div key={key} className="ni-md-table-wrap">
                <table className="ni-md-table">
                  <thead>
                    <tr>
                      {b.header.map((h, ci) => (
                        <th key={ci} style={b.align[ci] ? { textAlign: b.align[ci]! } : undefined}>
                          {renderInline(h, `${key}-h-${ci}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>
                        {r.map((c, ci) => (
                          <td key={ci} style={b.align[ci] ? { textAlign: b.align[ci]! } : undefined}>
                            {renderInline(c, `${key}-${ri}-${ci}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "code": {
            const rich = richIndexes.get(bi) ?? 0;
            // グラフ(Task 2)。スペックが不正なら生テキストにフォールバック。
            const spec = chartSpecs.get(bi);
            if (spec) {
              return print ? (
                <PrintRichSlot key={key} kind="chart" index={rich} title={spec.title} />
              ) : (
                <Chart key={key} spec={spec} richIndex={rich} />
              );
            }
            // トポロジ図(Task 3)。描画失敗時は Topology 内で生テキストにフォールバック。
            if (b.lang === "topology") {
              return print ? (
                <PrintRichSlot key={key} kind="topology" index={rich} />
              ) : (
                <Topology key={key} code={b.text} richIndex={rich} site={site} />
              );
            }
            return (
              <pre key={key} className="ni-md-pre">
                <code>{b.text}</code>
              </pre>
            );
          }
          default:
            return <p key={key}>{renderInline(b.text, key)}</p>;
        }
      })}
    </div>
  );
}
