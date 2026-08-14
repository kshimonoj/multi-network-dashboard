// 進行中のトポロジ図(mermaid)描画の待ち合わせ(83 Task 2)。
//
// 印刷 / PDF 出力は、印刷ツリーの中で図を組み直さず「画面に描画済みの SVG」を複製する
// (printClone.ts。理由はそちらのコメント)。ところが mermaid.render() は非同期なので、
// 描き終わる前に window.print() まで進むと、複製元が見つからず図が注記に置き換わる。
//
// そこで Topology が描画を始めたら、その Promise をここに登録しておく。
// 共有ボタンの「印刷 / PDF」は、押した時点で進行中のものが全部片付くまで待ってから
// 印刷ツリーを生やす。回線が遅い環境ほど回答到着から描画完了までが後ろにずれるため、
// この待ち合わせが無いと LAN 越しのアクセスで顕在化しやすい。
//
// React にも DOM にも依存しないので、印刷側(ShareActions / SessionShare)と
// 描画側(Topology)のどちらからも import できる。

const pending = new Set<Promise<unknown>>();

/** 描画中の Promise を登録する。解決・棄却のどちらでも自動的に外れる。 */
export function trackTopologyRender<T>(p: Promise<T>): Promise<T> {
  pending.add(p);
  const forget = () => {
    pending.delete(p);
  };
  // 棄却でも必ず外す(ここで受けるので unhandled rejection にもならない)。
  p.then(forget, forget);
  return p;
}

/**
 * 進行中のトポロジ描画がすべて終わるまで待つ。
 *
 * 待っている間に新しい描画が始まることがある(テーマ切替・再描画)ので、
 * 集合が空になるまで繰り返す。ただし待ち続けて印刷ボタンが効かなくなるのは困るので、
 * timeoutMs で必ず打ち切る(打ち切った場合は従来どおり注記になるだけで、壊れはしない)。
 */
export async function waitForTopologyRenders(timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise((resolve) => setTimeout(resolve, remaining)),
    ]);
  }
}
