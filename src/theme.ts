// テーマ(ダーク/ライト)の状態管理(03 Task 1)。
//
// 方針:
//  - 実際の配色切替は <html data-theme="dark|light"> の付け替えだけで行う(値は theme.css)。
//  - 選択は localStorage に保存し、次回アクセス時に復元する。
//  - 未保存のときは OS/ブラウザの prefers-color-scheme に従う。
//  - 初回描画のちらつきを避けるため、属性の初期反映は index.html のインラインスクリプトが
//    行う(同じキー・同じ判定順をここと共有する)。本モジュールはその後の切替を担当する。
//
// 本アプリは通常の Docker アプリ(Claude.ai の Artifacts ではない)なので localStorage を使ってよい。

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "mnd-theme";

function isTheme(v: unknown): v is Theme {
  return v === "dark" || v === "light";
}

// 保存済みの選択。壊れた値・localStorage 不許可(プライベートモード等)は null に倒す。
export function readStoredTheme(): Theme | null {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(v) ? v : null;
  } catch {
    return null;
  }
}

// OS/ブラウザの既定。matchMedia 非対応環境ではダーク扱い(このアプリの従来の見た目)。
export function systemTheme(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

// 「今あるべきテーマ」= 保存済み > OS 既定。
export function resolveInitialTheme(): Theme {
  return readStoredTheme() ?? systemTheme();
}

// <html> への反映。index.html のインラインスクリプトと同じことをする。
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

export function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* 保存できない環境ではセッション内のみの切替として振る舞う */
  }
}
