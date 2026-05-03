import { createT } from "../lib/i18n.js";
import { en } from "./en.js";
import { zhCN } from "./zh-CN.js";

export { getLang, setLang, useLang, onLangChange } from "../lib/i18n.js";
export type { DashboardLang } from "../lib/i18n.js";

export const t = createT({ en, "zh-CN": zhCN });
