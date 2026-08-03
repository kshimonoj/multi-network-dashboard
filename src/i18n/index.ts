// i18n のエントリ。利用側は常にここから import する。
export { LanguageProvider, useLanguage, useT, type TFunc } from "./LanguageContext";
export {
  DEFAULT_LANG,
  LANGS,
  LANG_STORAGE_KEY,
  applyLang,
  getLang,
  isLang,
  readStoredLang,
  resolveInitialLang,
  storeLang,
  translate,
  type Lang,
} from "./i18n";
export {
  formatDateTime,
  formatNumber,
  formatRelative,
  localeTag,
  relativeTimeKey,
  type RelativeOptions,
} from "./format";
