// Slash-command barrel. Public surface is stable across the slash/
// split — App.tsx, tests, and sibling components continue to import
// { handleSlash, parseSlash, suggestSlashCommands, SLASH_COMMANDS, ... }
// from "./slash.js". Everything below is re-exported from the per-topic
// modules under ./slash/.
export {
  SLASH_COMMANDS,
  detectSlashArgContext,
  parseSlash,
  suggestSlashCommands,
} from "./slash/commands.js";
export { handleSlash } from "./slash/dispatch.js";
export type { SlashHandler } from "./slash/dispatch.js";
export type {
  McpServerSummary,
  SlashArgContext,
  SlashCommandSpec,
  SlashContext,
  SlashResult,
} from "./slash/types.js";
