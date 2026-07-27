// 印刷ツリーへ「画面に既に描画済みのグラフ / トポロジ図の SVG」を複製して差し込む(03b)。
//
// 印刷用に再レンダリングしない理由:
//   - recharts(Chart.tsx)は ResponsiveContainer で親要素の実測サイズに合わせて描く。
//     印刷ツリーは画面に出ていない(#ni-print-root は display:none)ため、そこで組み直すと
//     幅 0 で描画され図が壊れる。
//   - mermaid(Topology.tsx)は非同期に SVG を生成するので、window.print() までに
//     描き終わる保証がない。
// そこで画面上に既にある <svg> をそのまま cloneNode(true) する。画面での実測サイズが
// そのまま乗るため、印刷ツリーの幅に依存しない。
//
// 画面側と印刷側の突き合わせは data 属性 (data-ni-rich / data-ni-index) で行う。
// Markdown.tsx が同じ回答テキストから同じ (種類, 通し番号) を両側へ振るため、
// mermaid の描画失敗などで画面側の要素が欠けても番号がずれない(欠けたものは注記になる)。

// ShareActions が置かれた位置から「その回答パネル」を探す。
// 共有ボタンは回答本文の兄要素(見出し行)に置かれるため closest(".ni-answer") では拾えない:
//   Turn(コンソール / スレッド共通): .ni-turn > .ni-turn-head(ここに共有ボタン) + .ni-answer > .ni-answer-body
// そこで「.ni-answer-body を含む最も近い祖先」を回答パネルとみなす。
// 1 ターン分の複製はこれで足りる(セッション全体は下の fillPrintSessionRichSlots)。
export function findAnswerPanel(from: HTMLElement | null): HTMLElement | null {
  let el: HTMLElement | null = from;
  while (el && el !== document.body) {
    if (el.querySelector(".ni-answer-body")) return el;
    el = el.parentElement;
  }
  return null;
}

// 複製した SVG の id を一意化するための連番(印刷のたびに増える)。
let cloneSeq = 0;

// `#id` の形で参照されうる文字だけを拾う(色指定 #333 等は id 集合に無いので素通りする)。
const ID_REF_RE = /#([A-Za-z0-9_.:\-]+)/g;

// 複製した SVG が持つ id を振り直す。
// mermaid は SVG 内の <style> を "#<図の id> .node { … }" のように id で限定し、矢印の
// marker も url(#…) で参照する。recharts も clip-path を url(#…) で参照する。
// 画面側と同じ id のまま複製すると文書内で id が重複し、参照先がどちらに解決されるか
// 保証できない(しかも印刷時、画面側の #root は display:none)。複製側だけ改名して切り離す。
function uniquifySvgIds(root: SVGElement): void {
  const elements: Element[] = [root, ...Array.from(root.querySelectorAll("*"))];
  const ids = new Set<string>();
  for (const el of elements) {
    const id = el.getAttribute("id");
    if (id) ids.add(id);
  }
  if (ids.size === 0) return;

  const suffix = `pr${cloneSeq++}`;
  const rename = (id: string) => `${id}-${suffix}`;
  // `#` に続く id 相当の並びを一括で見て、id 集合にあるものだけ差し替える。
  // 前方一致の取り違え(#foo が #foobar の中で当たる)を避けるため 1 パスで処理する。
  const rewrite = (text: string) =>
    text.replace(ID_REF_RE, (m, id: string) => (ids.has(id) ? `#${rename(id)}` : m));

  for (const el of elements) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name === "id") {
        el.setAttribute("id", rename(attr.value));
        continue;
      }
      if (attr.value.includes("#")) el.setAttribute(attr.name, rewrite(attr.value));
    }
    if (el.tagName.toLowerCase() === "style" && el.textContent) {
      el.textContent = rewrite(el.textContent);
    }
  }
}

const MISSING_NOTE: Record<string, string> = {
  chart: "(グラフは省略。ダッシュボードで表示できます)",
  topology: "(トポロジ図は省略。ダッシュボードで表示できます)",
};

// 複製元の SVG を取り出す。
// recharts は凡例の色見本も <svg class="recharts-surface"> で描くため、単純な
// querySelector("svg") や ".recharts-surface" では 14x14 の凡例アイコンを拾ってしまう
// (凡例は DOM 上でグラフ本体より前に来る)。本体は .recharts-wrapper の直下の <svg>。
function findSourceSvg(container: Element, kind: string): SVGSVGElement | null {
  if (kind === "chart") {
    return container.querySelector<SVGSVGElement>(".recharts-wrapper > svg");
  }
  return container.querySelector<SVGSVGElement>("svg");
}

// 印刷ツリー内の差し込み口(.ni-print-rich-slot)を、画面側の SVG の複製で埋める。
// 画面側に対応する SVG が無い(スペック不正・mermaid 描画失敗など)場合は注記を入れる。
export function fillPrintRichSlots(printRoot: HTMLElement, source: HTMLElement | null): void {
  const slots = printRoot.querySelectorAll<HTMLElement>(".ni-print-rich-slot");
  slots.forEach((slot) => {
    const kind = slot.getAttribute("data-ni-rich") ?? "";
    const index = slot.getAttribute("data-ni-index");
    slot.replaceChildren(); // 再実行(再描画)されても二重に積まない

    const container =
      source && index != null
        ? source.querySelector(`[data-ni-rich="${kind}"][data-ni-index="${index}"]`)
        : null;
    const src = container ? findSourceSvg(container, kind) : null;

    if (!src) {
      const note = document.createElement("div");
      note.className = "ni-print-rich-note";
      note.textContent = MISSING_NOTE[kind] ?? MISSING_NOTE.chart;
      slot.appendChild(note);
      return;
    }

    const clone = src.cloneNode(true) as SVGSVGElement;
    uniquifySvgIds(clone);
    if (kind === "chart") {
      // recharts の <svg> は inline style で width/height を 100% に固定し、実寸は
      // width/height 属性(と viewBox)に持つ。印刷スロットは高さが auto なので
      // height:100% が解決できない。inline 指定を外し、属性由来の実寸で置く
      // (紙幅を超える場合は印刷 CSS の max-width:100% で縮む)。
      clone.style.removeProperty("width");
      clone.style.removeProperty("height");
    }
    slot.appendChild(clone);

    // 円グラフの凡例は SVG ではなく HTML(.recharts-legend-wrapper)なので別途複製する。
    // 系列名がここにしか無いため、これが無いと紙面で色の意味が分からなくなる。
    // グラフ本体に対する絶対配置は印刷 CSS 側で解除する(styles.css)。
    if (kind === "chart" && container) {
      const legend = container.querySelector(".recharts-legend-wrapper");
      if (legend) slot.appendChild(legend.cloneNode(true));
    }
  });
}

// セッション全体の印刷(04 Task 4)。
// data-ni-index はターン(= 1 回の回答)の中での通し番号なので、複数ターンを 1 枚に連結すると
// 番号が衝突する。そこで印刷ツリー・画面側の双方が持つ data-ni-turn(runId)で区切り、
// 対応するターン同士の中だけで fillPrintRichSlots を回す。
// 画面に出ていないターン(スレッドを開いていない等)は、対応が取れず注記になる。
export function fillPrintSessionRichSlots(printRoot: HTMLElement, screenRoot: HTMLElement | null): void {
  const sections = printRoot.querySelectorAll<HTMLElement>("[data-ni-turn]");
  sections.forEach((section) => {
    const id = section.getAttribute("data-ni-turn") ?? "";
    // runId は UUID なので通常エスケープ不要だが、属性セレクタに載せるため引用符だけ潰す。
    const safeId = id.replace(/["\\]/g, "");
    const source = screenRoot && safeId ? screenRoot.querySelector<HTMLElement>(`[data-ni-turn="${safeId}"]`) : null;
    fillPrintRichSlots(section, source);
  });
}
