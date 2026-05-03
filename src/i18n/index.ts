import { loadLanguage, saveLanguage } from "../config.js";
import { EN } from "./EN.js";
import type { LanguageCode, TranslationSchema } from "./types.js";
import { zhCN } from "./zh-CN.js";

const translations: Record<LanguageCode, TranslationSchema> = {
  EN,
  "zh-CN": zhCN,
};

let currentLang: LanguageCode = loadLanguage() || "EN";

type Listener = () => void;
const listeners: Listener[] = [];

export function onLanguageChange(cb: Listener): () => void {
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function notifyLanguageChange(): void {
  for (const cb of listeners) cb();
}

export function setLanguage(lang: LanguageCode): void {
  if (translations[lang]) {
    currentLang = lang;
    saveLanguage(lang);
  }
}

/** Set language for the current process only (no disk write). Used by tests. */
export function setLanguageRuntime(lang: LanguageCode): void {
  if (translations[lang]) {
    currentLang = lang;
  }
}

export function getLanguage(): LanguageCode {
  return currentLang;
}

export function getSupportedLanguages(): LanguageCode[] {
  return Object.keys(translations) as LanguageCode[];
}

/** Simple t() — nested keys (e.g. "common.error") + param replacement (e.g. "{code}"). */
export function t(path: string, params?: Record<string, string | number>): string {
  const parts = path.split(".");
  let val: any = translations[currentLang] || translations.EN;

  for (const part of parts) {
    val = val?.[part];
    if (val === undefined) break;
  }

  // Fallback to English if not found in current language
  if (val === undefined && currentLang !== "EN") {
    val = translations.EN;
    for (const part of parts) {
      val = val?.[part];
      if (val === undefined) break;
    }
  }

  if (typeof val !== "string") {
    return path;
  }

  if (params) {
    let result = val;
    for (const [k, v] of Object.entries(params)) {
      result = result.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
    return result;
  }

  return val;
}
