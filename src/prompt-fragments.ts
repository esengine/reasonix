import { t } from "./i18n/index.js";

/** Shared prompt fragments — single source so house-style rules can't drift across agent/subagent/skill prompts. */

/** Embedded literally — no interpolation, so prefix-cache hash stays stable across sessions. */
export const TUI_FORMATTING_RULES = () => t("prompts.formattingRules");

export const ESCALATION_CONTRACT = () => t("prompts.escalationContract");

export const NEGATIVE_CLAIM_RULE = () => t("prompts.negativeClaimRule");
