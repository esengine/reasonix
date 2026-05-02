// Exp 2 — see ./results.md.

import { readFileSync } from "node:fs";
import { Eventizer, type EventizeContext } from "../../src/core/eventize.js";
import { replay } from "../../src/core/reducers.js";
import type { LoopEvent } from "../../src/loop.js";

for (const line of readFileSync(new URL("../../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("DEEPSEEK_API_KEY missing from .env — cannot run real-API spike.");
  process.exit(2);
}
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
const model = "deepseek-chat";

const SYSTEM = `You are a coding assistant. Answer concisely in plain text. Do not call tools.`;

interface ApiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

interface CallResult {
  prompt: number;
  completion: number;
  hit: number;
  miss: number;
  ratio: number;
  reply: string;
}

async function call(messages: ApiMessage[]): Promise<CallResult> {
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_tokens: 200, temperature: 0.2 }),
  });
  if (!r.ok) {
    throw new Error(`API ${r.status}: ${await r.text()}`);
  }
  const j = (await r.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_cache_hit_tokens?: number;
      prompt_cache_miss_tokens?: number;
    };
  };
  const u = j.usage ?? {};
  const hit = u.prompt_cache_hit_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? 0;
  const total = hit + miss;
  return {
    prompt: u.prompt_tokens ?? 0,
    completion: u.completion_tokens ?? 0,
    hit,
    miss,
    ratio: total > 0 ? hit / total : 0,
    reply: j.choices?.[0]?.message?.content ?? "",
  };
}

const userTurns = [
  "List three common patterns for caching in TypeScript. One sentence each.",
  "Pick the best one for a write-heavy workload. Two sentences.",
  "Sketch the chosen pattern in 8 lines of code.",
  "Now name one failure mode and one quick test for it.",
];

const counterfactualUser = "Forget the earlier topic — explain what currying is in 3 sentences.";

async function main(): Promise<void> {
  const ctx: EventizeContext = { model, reasoningEffort: "max", prefixHash: "exp2" };
  const eventizer = new Eventizer();
  const events = [];
  events.push(eventizer.emitSessionOpened(0, "exp2-parent", 0));

  console.log("# Exp 2 — real-API cache hit on rebuilt fork prefix\n");
  console.log("## Parent session\n");

  const messages: ApiMessage[] = [{ role: "system", content: SYSTEM }];
  const parentResults: CallResult[] = [];

  for (let i = 0; i < userTurns.length; i++) {
    const turn = i + 1;
    const text = userTurns[i] as string;
    messages.push({ role: "user", content: text });
    events.push(eventizer.emitUserMessage(turn, text));

    const r = await call(messages);
    parentResults.push(r);
    messages.push({ role: "assistant", content: r.reply });

    const lev: LoopEvent = { turn, role: "assistant_final", content: r.reply } as LoopEvent;
    for (const out of eventizer.consume(lev, ctx)) events.push(out);

    console.log(
      `turn ${turn}: prompt=${r.prompt} hit=${r.hit} miss=${r.miss} ratio=${(r.ratio * 100).toFixed(1)}%`,
    );
  }

  console.log("\n## Fork at end of turn 3 (rebuild via reducer + counterfactual user msg)\n");

  let cutIdx = events.length;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i] as { type: string; turn?: number };
    if (ev.type === "user.message" && ev.turn === 4) {
      cutIdx = i;
      break;
    }
  }

  const projected = replay(events.slice(0, cutIdx)).conversation.messages;
  const forkMessages: ApiMessage[] = [
    { role: "system", content: SYSTEM },
    ...(projected as ApiMessage[]),
    { role: "user", content: counterfactualUser },
  ];

  console.log(`projected messages: ${projected.length} (parent had ${userTurns.length * 2} pre-turn-4)`);
  console.log(`fork request size:  ${forkMessages.length} messages`);

  const fork = await call(forkMessages);
  console.log(
    `fork:   prompt=${fork.prompt} hit=${fork.hit} miss=${fork.miss} ratio=${(fork.ratio * 100).toFixed(1)}%`,
  );

  const parent4 = parentResults[3];
  if (!parent4) {
    console.error("parent turn 4 missing — bailing");
    process.exit(1);
  }

  console.log("\n## Verdict\n");
  console.log(`parent turn 4: hit=${parent4.hit} miss=${parent4.miss} ratio=${(parent4.ratio * 100).toFixed(1)}%`);
  console.log(`fork:          hit=${fork.hit} miss=${fork.miss} ratio=${(fork.ratio * 100).toFixed(1)}%`);

  // Both requests share the prefix [sys, U1, A1, U2, A2, U3, A3]. They differ
  // only in the trailing user message (parent: U4; fork: U4'). DeepSeek's
  // prefix cache hits the longest matching prefix. So if the reducer rebuilt
  // the prefix byte-for-byte, fork.hit must equal parent4.hit.
  const hitParity = fork.hit === parent4.hit;
  const missDelta = fork.miss - parent4.miss;
  const tailDelta = counterfactualUser.length - (userTurns[3]?.length ?? 0);

  console.log(`\nhit parity (fork.hit === parent.hit):  ${hitParity ? "PASS" : `FAIL (delta=${fork.hit - parent4.hit})`}`);
  console.log(`miss delta:                            ${missDelta} tokens (tail-msg char delta=${tailDelta})`);
  console.log(
    hitParity
      ? "\nRESULT: PASS — reducer projection is byte-identical to the parent's original prefix; fork hits cache exactly where parent did."
      : "\nRESULT: FAIL — fork.hit diverges from parent.hit, meaning the rebuilt prefix is not byte-identical.",
  );
  process.exit(hitParity ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
