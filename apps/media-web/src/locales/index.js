// Derived from MarSeventh/Sanyue-ImgHub@1621525:src/locales/index.js (MIT), modified.
// Changes: English is the fallback; the storage key is namespaced; the upstream remote default language is gone.
import { createI18n } from "vue-i18n";
import en from "./en.json";
import zhCN from "./zh-CN.json";

const LOCALE_KEY = "pixvault.media.locale";
const FALLBACK_LOCALE = "en";
const SUPPORTED_LOCALES = new Set(["en", "zh-CN"]);

function normalizeLocale(locale) {
  return SUPPORTED_LOCALES.has(locale) ? locale : null;
}

function getStoredLocale() {
  try {
    return normalizeLocale(localStorage.getItem(LOCALE_KEY));
  } catch {
    return null;
  }
}

function browserLocale() {
  const lang = globalThis.navigator?.language ?? "";
  return lang.toLowerCase().startsWith("zh") ? "zh-CN" : null;
}

const i18n = createI18n({
  legacy: true,
  locale: getStoredLocale() || browserLocale() || FALLBACK_LOCALE,
  fallbackLocale: FALLBACK_LOCALE,
  messages: { en, "zh-CN": zhCN },
});

function applyLocale(locale) {
  i18n.global.locale = locale;
  document.documentElement.lang = locale;
}

export function initializeLocale() {
  const locale = getStoredLocale() || browserLocale() || FALLBACK_LOCALE;
  applyLocale(locale);
  return locale;
}

export function setLocale(locale) {
  const next = normalizeLocale(locale) || FALLBACK_LOCALE;
  applyLocale(next);
  try {
    localStorage.setItem(LOCALE_KEY, next);
  } catch {
    /* not persisted */
  }
}

export default i18n;
