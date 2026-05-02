import {
  getSupportedLanguages,
  notifyLanguageChange,
  setLanguage,
  t,
} from "../../../../i18n/index.js";
import type { LanguageCode } from "../../../../i18n/types.js";
import type { SlashHandler } from "../dispatch.js";

export const handlers: Record<string, SlashHandler> = {
  language: (args, _loop, _ctx) => {
    const lang = args[0];
    if (!lang) {
      return { openArgPickerFor: "language" };
    }

    const supported = getSupportedLanguages();
    if (!supported.includes(lang as LanguageCode)) {
      return {
        info: t("slash.language.unsupported", {
          code: lang,
          supported: supported.join(", "),
        }),
      };
    }

    setLanguage(lang as LanguageCode);
    notifyLanguageChange();

    return { info: t("slash.language.success") };
  },
  lang: (args, loop, ctx) => handlers.language!(args, loop, ctx),
};
