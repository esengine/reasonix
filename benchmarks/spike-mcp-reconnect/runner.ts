/** Empirically confirms RFC #110: tool-list drift mid-session breaks DeepSeek's prefix cache. */

import { DeepSeekClient, loadDotenv } from "../../src/index.js";
import type { ChatMessage, ToolSpec } from "../../src/types.js";

loadDotenv();

const MODEL = "deepseek-chat";

// DeepSeek's prefix cache only kicks in past ~1024 tokens of repeated
// prefix, so the system prompt has to be substantial. Padded with
// realistic-shape filler so the test exercises the same code path a
// real Reasonix session would.
const SYSTEM = [
  "You are a precise senior software engineer assisting with TypeScript codebases.",
  "Style: terse, concrete, no filler. Don't restate the question. Don't apologise.",
  "When you reference a file, use the file:line shape so the user can click through.",
  "When you list options, use a bulleted list, not prose.",
  "When you reason, do so internally — final reply is the answer, not the deliberation.",
  "If the user asks a yes/no question, lead with the answer, then one sentence of why.",
  "If the user asks for code, output a minimal patch — not the whole file.",
  "When a tool result is a long stack trace, surface the root frame and one stack item up.",
  "Refuse to fabricate API surface; if you don't know a function exists, ask first.",
  "Prefer existing libraries over hand-rolled implementations; flag the dependency cost.",
  "When suggesting a refactor, point at the existing call sites that motivate it.",
  "Don't add error handling that catches errors you have no recovery for.",
  "Don't add comments that restate the code; only document the WHY.",
  "Keep diffs reviewable: 1 change per commit, related changes per PR.",
  "Treat user messages as authoritative on intent; ask only when truly ambiguous.",
  "Response length is a function of complexity — short answers when short suffices.",
  "Default to UTF-8, LF line endings, two-space indent unless the surrounding code differs.",
  "When a request is impossible as stated, propose the nearest tractable alternative.",
  "Cite specific paths and line numbers; never paraphrase a file you can read.",
  "Optimise for the user's next action, not your own throughness.",
].join(" ");

const baseTool: ToolSpec = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read the contents of a file at the given absolute or workspace-relative path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read." },
      },
      required: ["path"],
    },
  },
};

const writeTool: ToolSpec = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write text content to a file at the given path. Creates parents if missing.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
};

const searchTool: ToolSpec = {
  type: "function",
  function: {
    name: "search_files",
    description: "Find files whose path matches a glob pattern under the workspace root.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
};

const TOOLSET_A: ToolSpec[] = [baseTool, writeTool, searchTool];

// Same shape as TOOLSET_A but adds one extra tool — emulates an MCP
// server reconnect that exposed an additional capability.
const newTool: ToolSpec = {
  type: "function",
  function: {
    name: "delete_file",
    description: "Remove a file at the given path. Refuses on directories.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};
const TOOLSET_A_PLUS: ToolSpec[] = [...TOOLSET_A, newTool];

// Same set as A, only the description on read_file edited.
const TOOLSET_A_EDITED: ToolSpec[] = [
  {
    ...baseTool,
    function: {
      ...baseTool.function,
      description: "Read the contents of a file at the given path. Returns text or binary base64.",
    },
  },
  writeTool,
  searchTool,
];

interface Turn {
  label: string;
  tools: ToolSpec[];
  user: string;
}

const TURNS: Turn[] = [
  { label: "1 · cold start (toolset A)        ", tools: TOOLSET_A, user: "What does Reasonix optimise for, in one sentence?" },
  { label: "2 · same prefix (toolset A)        ", tools: TOOLSET_A, user: "And why DeepSeek-only?" },
  { label: "3 · drift: ADDED tool (toolset A+) ", tools: TOOLSET_A_PLUS, user: "What's a flaky test, in one sentence?" },
  { label: "4 · same prefix again (toolset A+) ", tools: TOOLSET_A_PLUS, user: "And how do you stabilise one?" },
  { label: "5 · drift: EDITED desc (toolset A')", tools: TOOLSET_A_EDITED, user: "What's an idempotent operation, in one sentence?" },
];

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("DEEPSEEK_API_KEY not set in env. Add it to .env and re-run.");
    process.exit(1);
  }
  const client = new DeepSeekClient();

  const systemMsg: ChatMessage = { role: "system", content: SYSTEM };

  console.log(`RFC #110 cache spike — DeepSeek prompt-cache behaviour under tool-list drift`);
  console.log(`model: ${MODEL}`);
  console.log(`system prompt: ${SYSTEM.length} chars`);
  console.log();
  const head =
    "turn".padEnd(40) +
    "prompt".padStart(8) +
    "hit".padStart(8) +
    "miss".padStart(8) +
    "hit%".padStart(8) +
    "ms".padStart(8);
  console.log(head);
  console.log("-".repeat(head.length));

  for (const turn of TURNS) {
    const messages: ChatMessage[] = [systemMsg, { role: "user", content: turn.user }];
    const t0 = Date.now();
    const resp = await client.chat({
      model: MODEL,
      messages,
      tools: turn.tools,
      maxTokens: 64,
    });
    const ms = Date.now() - t0;
    const u = resp.usage;
    const hitRatio = u.promptTokens > 0 ? (u.promptCacheHitTokens / u.promptTokens) * 100 : 0;
    console.log(
      turn.label.padEnd(40) +
        String(u.promptTokens).padStart(8) +
        String(u.promptCacheHitTokens).padStart(8) +
        String(u.promptCacheMissTokens).padStart(8) +
        `${hitRatio.toFixed(1)}%`.padStart(8) +
        String(ms).padStart(8),
    );
  }
  console.log();
  console.log("Expectations:");
  console.log("  Turn 1 — cold, hit ≈ 0");
  console.log("  Turn 2 — same prefix as 1, hit ≈ system-prompt-token-count");
  console.log("  Turn 3 — DRIFTED (added tool), hit drops to ~0 again");
  console.log("  Turn 4 — same prefix as 3, hit climbs back");
  console.log("  Turn 5 — DRIFTED (edited description), hit drops to ~0 again");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
