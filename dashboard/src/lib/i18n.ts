import { useEffect, useState } from "preact/hooks";

type Listener = () => void;

export type DashboardLang = "en" | "zh-CN";

const STORAGE_KEY = "rx.lang";
const listeners: Listener[] = [];
let currentLang: DashboardLang = loadFromStorage();

function loadFromStorage(): DashboardLang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "zh-CN") return "zh-CN";
  } catch {
    /* private mode */
  }
  return "en";
}

export function getLang(): DashboardLang {
  return currentLang;
}

export function setLang(lang: DashboardLang): void {
  if (lang !== "en" && lang !== "zh-CN") return;
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
  for (const cb of listeners) cb();
}

export function onLangChange(cb: Listener): () => void {
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function useLang(): DashboardLang {
  const [lang, setLangState] = useState<DashboardLang>(currentLang);
  useEffect(() => onLangChange(() => setLangState(currentLang)), []);
  return lang;
}

type Nested = { [k: string]: string | Nested };

function get(translations: Nested, path: string): string | undefined {
  let val: string | Nested | undefined = translations;
  for (const part of path.split(".")) {
    if (val === undefined || typeof val === "string") return undefined;
    val = val[part];
  }
  return typeof val === "string" ? val : undefined;
}

export function createT(translations: Record<DashboardLang, Nested>) {
  return function t(path: string, params?: Record<string, string | number>): string {
    let val = get(translations[currentLang], path);
    if (val === undefined) val = get(translations.en, path);
    if (val === undefined) return path;
    if (!params) return val;
    let result = val;
    for (const [k, v] of Object.entries(params)) {
      result = result.replaceAll(`{${k}}`, String(v));
    }
    return result;
  };
}
