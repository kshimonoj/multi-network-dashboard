// 表示言語の React Context(29 Task 1)。
//
// ダークモード(theme.ts + main.tsx の useState)と同じ軽さを狙うが、テーマと違って
// 「値を読みたい箇所」がツリーの深い所に散らばる(タブ名・各プラグインの View)ので、
// prop で配るのは非現実的。Context 1 枚だけ用意して、useT() で引けるようにする。
//
// 使い方:
//   const t = useT();
//   <span>{t("tabs.webhookFeed.label")}</span>
//   <span>{t("theme.toggleAria", { next: t("theme.dark") })}</span>

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  applyLang,
  DEFAULT_LANG,
  resolveInitialLang,
  setCurrentLang,
  storeLang,
  translate,
  type Lang,
} from "./i18n";

export type TFunc = (key: string, params?: Record<string, string | number>) => string;

interface LanguageValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: TFunc;
}

// Provider を挿し忘れても落ちないよう、既定は日本語の素引き。
const LanguageContext = createContext<LanguageValue>({
  lang: DEFAULT_LANG,
  setLang: () => {},
  t: (key, params) => translate(DEFAULT_LANG, key, params),
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const initial = resolveInitialLang();
    // React 外から読む窓口(getLang)を、最初のレンダー前に合わせておく。
    setCurrentLang(initial);
    return initial;
  });

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    setCurrentLang(next);
    storeLang(next);
    applyLang(next);
  }, []);

  const value = useMemo<LanguageValue>(
    () => ({ lang, setLang, t: (key, params) => translate(lang, key, params) }),
    [lang, setLang],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageValue {
  return useContext(LanguageContext);
}

export function useT(): TFunc {
  return useContext(LanguageContext).t;
}
