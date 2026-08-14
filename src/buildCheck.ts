// 開きっぱなしのタブが古いビルドのまま動いていないかを見張る(82)。
//
// なぜ要るか:
//   `docker compose up -d --build` はサーバ側(prompt・API・整形ロジック)を即座に新しくするが、
//   すでに開いているタブが読み込み済みの JS はそのまま残る。SPA なので画面を操作しても
//   再読み込みは起きない。結果、
//     「サーバ側の修正だけ反映され、画面側の修正は反映されていない」
//   という切り分けの難しい状態になる。実際 81 の修正(Markdown テーブル・PDF ファイル名)は
//   ビルドにもコンテナにも正しく入っていたのに、画面が古い JS を持っていたために
//   効いていないように見えていた(instructions/82_findings.md)。
//
// 判定のしかた:
//   Vite のエントリ JS は内容ハッシュ付きのファイル名(assets/index-<hash>.js)になる。
//   「今このタブが読み込んでいる src」と「サーバが今配っている src」を突き合わせ、
//   食い違ったら古いと判断する。ビルド時刻や version 文字列を埋め込む方式と違い、
//   ビルド引数も環境変数も要らず、取り違えようがない。
//
// 判定しない場合(常に false を返す):
//   - dev(Vite middleware)。サーバが entry: null を返す
//   - 自分の <script src> が取れない(将来インライン化した場合など)
//   - /api/build が取れない(サーバ再起動中・ネットワーク断)。一時的な失敗で
//     警告を出すと再読み込みを促すノイズになるだけなので黙って見送る

import { useEffect, useState } from "react";

/** 突き合わせの間隔。再読み込みを促すだけなので短くする必要はない。 */
const POLL_MS = 5 * 60 * 1000;

/** このタブが実際に読み込んでいるエントリ JS の絶対 URL。取れなければ null。 */
function ownEntryUrl(): string | null {
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"));
  const entry = scripts.find((s) => /\/assets\/index-[^/]+\.js(\?|$)/.test(s.getAttribute("src") ?? ""));
  return entry ? entry.src : null;
}

/**
 * サーバが配っているビルドと食い違っていたら true。
 * 一度 true になったら(再読み込みするまで)false へは戻さない。
 */
export function useStaleBuild(): boolean {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const own = ownEntryUrl();
    if (!own) return;

    let alive = true;
    const check = async () => {
      try {
        const res = await fetch("/api/build", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { entry?: string | null };
        if (!alive || !data.entry) return;
        // サーバは dist/index.html に書かれたまま("/assets/index-xxx.js")を返すので、
        // 相対 / 絶対の違いを吸収してから比べる。
        if (new URL(data.entry, window.location.origin).href !== own) setStale(true);
      } catch {
        /* 取得できない間は判定しない(サーバ再起動中など) */
      }
    };

    void check();
    const timer = window.setInterval(() => void check(), POLL_MS);
    // タブへ戻ってきた瞬間も見る(放置していたタブがそのまま古い、が一番起きやすい)。
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return stale;
}
