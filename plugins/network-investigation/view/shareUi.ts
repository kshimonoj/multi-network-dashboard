// 共有ボタン(単発 = ShareActions / セッション全体 = SessionShareActions)が共通で使う小物。
// テキスト生成は shareText.ts、印刷ツリーへの SVG 複製は printClone.ts に分かれている。
// ここはブラウザ API を触る 2 つだけ(短命メッセージ・クリップボード)。

import { useCallback, useEffect, useRef, useState } from "react";

// 「コピーしました」等の短命メッセージ。2.6 秒で自動的に消える。
export function useTransientMessage(): [string | null, (msg: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
  }, []);
  const show = useCallback((m: string) => {
    setMsg(m);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setMsg(null), 2600);
  }, []);
  return [msg, show];
}

// クリップボード。https/localhost 以外では navigator.clipboard が無いので textarea へ退避する。
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 下のフォールバックへ */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// 印刷ツリーを描画したフレームの直後に window.print() を呼ぶ。
// requestAnimationFrame はタブが可視でないと発火しないため、タイマー側の保険も置き、
// 先に来たほうだけが print() を呼ぶ。afterprint で printing を落とす。
export function usePrintOnMount(printing: boolean, done: () => void): void {
  useEffect(() => {
    if (!printing) return;
    window.addEventListener("afterprint", done);
    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      window.print();
    };
    const raf = window.requestAnimationFrame(() => window.requestAnimationFrame(fire));
    const timer = window.setTimeout(fire, 150);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", done);
    };
  }, [printing, done]);
}
