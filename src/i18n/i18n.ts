// 表示言語(日本語 / 英語)の状態管理と辞書引き(29 Task 1)。
//
// 方針は theme.ts と揃える:
//  - 追加ライブラリ(i18next 等)は入れない。JSON 辞書 + 軽量 Context だけで足りる。
//  - 選択は localStorage に保存し、次回アクセス時に復元する。
//  - 初回描画のちらつき(<html lang> の付け替え)を避けるため、属性の初期反映は
//    index.html のインラインスクリプトが行う(同じキー・同じ判定順をここと共有する)。
//  - 既定は日本語。ブラウザの navigator.language は見ない(29 Task 1-3 の指定)。
//
// 辞書引きは "tabs.webhookFeed.label" のようなドット区切りキー。
// 未定義キーは ja へフォールバックし、それも無ければキー文字列をそのまま返す
// (画面が空欄になるより、どのキーが足りないか分かる方が運用しやすい)。

import ja from "./ja.json";
import en from "./en.json";

export type Lang = "ja" | "en";

export const LANGS: Lang[] = ["ja", "en"];
export const DEFAULT_LANG: Lang = "ja";
export const LANG_STORAGE_KEY = "mnd-lang";

type Dict = Record<string, unknown>;

const DICTS: Record<Lang, Dict> = { ja: ja as Dict, en: en as Dict };

export function isLang(v: unknown): v is Lang {
  return v === "ja" || v === "en";
}

// 保存済みの選択。壊れた値・localStorage 不許可(プライベートモード等)は null に倒す。
export function readStoredLang(): Lang | null {
  try {
    const v = window.localStorage.getItem(LANG_STORAGE_KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

// 「今あるべき言語」= 保存済み > 既定(日本語)。
export function resolveInitialLang(): Lang {
  return readStoredLang() ?? DEFAULT_LANG;
}

export function storeLang(lang: Lang): void {
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* 保存できない環境ではセッション内のみの切替として振る舞う */
  }
}

// <html lang> への反映。index.html のインラインスクリプトと同じことをする。
// スクリーンリーダの読み上げ言語・ブラウザの翻訳提案がこの属性を見る。
export function applyLang(lang: Lang): void {
  document.documentElement.setAttribute("lang", lang);
}

function lookup(dict: Dict, key: string): string | null {
  let cur: unknown = dict;
  for (const seg of key.split(".")) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Dict)[seg];
  }
  return typeof cur === "string" ? cur : null;
}

// "{next}モードに切り替える" のようなプレースホルダを埋める。
// 値が渡されなかったプレースホルダは、そのままの形で残す(欠落に気付けるように)。
function interpolate(tpl: string, params?: Record<string, string | number>): string {
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

export function translate(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const hit = lookup(DICTS[lang], key) ?? (lang === DEFAULT_LANG ? null : lookup(DICTS[DEFAULT_LANG], key));
  return interpolate(hit ?? key, params);
}

// ---- React の外から現在の言語を読むための最小の窓口 ----
//
// 用途は 2 つだけ:
//   (a) plugins/network-investigation/view/api.ts が POST /query に lang を載せる(29 Task 4)
//   (b) shell.tsx の topbarModelLabel() のような、Context を張れない純関数
// 値の更新は LanguageProvider が一元的に行う(ここを直接書き換えるコードを増やさない)。
let currentLang: Lang = DEFAULT_LANG;

export function getLang(): Lang {
  return currentLang;
}

/** LanguageProvider 専用。アプリコードからは呼ばない。 */
export function setCurrentLang(lang: Lang): void {
  currentLang = lang;
}
