import { useEffect, useMemo, useState } from "react";
import mermaid from "mermaid";
import { normalizeTopologyCode } from "./topologyCode";
import { trackTopologyRender } from "./topologyRenders";

// 回答本文の ```topology ブロックを mermaid.js で描画する(Task 3)。
// 中身は mermaid のグラフ定義(例: graph TD / A[サイト] --- B[デバイス])。
// securityLevel:"strict"(既定)で描画するため、mermaid がラベル等をサニタイズする。
// パース失敗時は生テキストのコードブロックにフォールバックする(壊さない)。

// mermaid のテーマはアプリのダーク/ライト(html[data-theme])に追従させる(03 Task 1)。
// 固定 "dark" のままだとライトテーマの白いパネルに暗い図が乗って読みづらい。
function applyInit(theme: string) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme === "light" ? "default" : "dark",
    fontFamily: "var(--mono, monospace)",
  });
}

// html[data-theme] の変化を購読する(テーマ切替時に図を描き直すため)。
function useDocTheme(): string {
  const [theme, setTheme] = useState(
    () => document.documentElement.getAttribute("data-theme") ?? "dark",
  );
  useEffect(() => {
    const read = () => setTheme(document.documentElement.getAttribute("data-theme") ?? "dark");
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    read();
    return () => obs.disconnect();
  }, []);
  return theme;
}

// render 用のユニーク id(mermaid は id を DOM に使うため衝突を避ける)。
let seq = 0;

// mermaid.render(id, src) を 1 回呼び、mermaid が置き去りにした一時要素を必ず片付ける(83 Task 2)。
//
// mermaid 11.16 の render() は、描画先の要素を渡さないと <body> 直下に一時 div(#d<id>)を
// 生やしてそこで組み立てる。成功時は最後に removeTempElements() で消すが、
// **パースに失敗したときは「Syntax error in text」の図をその一時 div に描いたまま throw する**
// (removeTempElements() の呼び出しが throw の後ろにある)。
// 結果、失敗した描画の数だけエラー図が body 直下に残り続ける。
// 画面では #root の外なので誰も気付かないが、印刷時は @media print が隠すのが #root だけなので
// そのまま紙面に出る = PDF にだけ「Syntax error in text」が現れる。
//
// 正規化コードで失敗 → 元コードで再試行、の 2 回とも失敗すればエラー図も 2 つ残る
// (= 同じ図に対してエラーボックスが 2 個出る)。
function renderOnce(src: string): Promise<{ svg: string }> {
  const id = `ni-topo-${seq++}`;
  return mermaid.render(id, src).finally(() => {
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(`i${id}`)?.remove(); // sandbox 設定時の iframe(現在は strict だが念のため)
  });
}

// richIndex: 同じ回答内での topology ブロックの通し番号(Markdown.tsx が振る)。
// 印刷時に「N 番目のトポロジ図の SVG」を突き合わせて複製するための目印(printClone.ts)。
//
// site(81 Task 2): 調査対象のサイト名。サイト名をノードとして描いてしまっている図を
// normalizeTopologyCode が直し、サイト名を図のタイトルへ移す。
export function Topology({
  code,
  richIndex,
  site,
}: {
  code: string;
  richIndex?: number;
  site?: string | null;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const docTheme = useDocTheme();
  const normalized = useMemo(() => normalizeTopologyCode(code, site), [code, site]);

  useEffect(() => {
    let cancelled = false;
    applyInit(docTheme);
    const raw = (code || "").trim();
    const first = (normalized || "").trim() || raw;
    // 印刷ボタンがこの描画の完了を待てるよう、一連の処理を 1 本の Promise として登録する
    // (最後の catch まで含めるので、この Promise は棄却されない)。
    trackTopologyRender(
      renderOnce(first)
        // 正規化した結果が描けなかったときは元のコードで描き直す(直そうとして壊さない)。
        .catch(() => (first === raw ? Promise.reject() : renderOnce(raw)))
        .then(({ svg }) => {
          if (!cancelled) {
            setSvg(svg);
            setFailed(false);
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [code, normalized, docTheme]);

  // 描画できなければ生テキストにフォールバック(過去履歴の壊れた図でもクラッシュさせない)。
  if (failed) {
    return (
      <pre className="ni-md-pre">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      className="ni-topology"
      data-ni-rich="topology"
      data-ni-index={richIndex}
      // mermaid.render はサニタイズ済みの SVG 文字列を返す(securityLevel:"strict")。
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}
