import { useEffect, useState } from "react";
import mermaid from "mermaid";

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

// richIndex: 同じ回答内での topology ブロックの通し番号(Markdown.tsx が振る)。
// 印刷時に「N 番目のトポロジ図の SVG」を突き合わせて複製するための目印(printClone.ts)。
export function Topology({ code, richIndex }: { code: string; richIndex?: number }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const docTheme = useDocTheme();

  useEffect(() => {
    let cancelled = false;
    applyInit(docTheme);
    const id = `ni-topo-${seq++}`;
    mermaid
      .render(id, (code || "").trim())
      .then(({ svg }) => {
        if (!cancelled) {
          setSvg(svg);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, docTheme]);

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
