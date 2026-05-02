/** LLM-backed user sim — emits next utterance or `##STOP##`; non-determinism handled by repeat-per-task in the runner. */

import type { ChatMessage, DeepSeekClient } from "../../src/index.js";
import type { Turn, UserPersona } from "./types.js";

const SYS = `You are roleplaying a user contacting a retail support agent.
Rules:
- Stay in character; never break the fourth wall.
- Never reveal you are an AI or mention any system.
- Pursue the goal. Do not volunteer facts the agent hasn't asked for.
- Keep replies to one or two sentences.
- When the goal is clearly met OR clearly refused by the agent, output ONLY the literal token: ##STOP##
- Do not output ##STOP## on your first message — give the agent a chance.`;

export interface UserSimOptions {
  model?: string;
  temperature?: number;
}

export class UserSimulator {
  constructor(
    private client: DeepSeekClient,
    private persona: UserPersona,
    private opts: UserSimOptions = {},
  ) {}

  /** Next user line, or null if the sim decided the conversation is over. */
  async next(transcript: Turn[]): Promise<string | null> {
    const knowns = JSON.stringify(this.persona.knowns, null, 2);
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `${SYS}\n\nCharacter: ${this.persona.style}\nGoal: ${this.persona.goal}\nFacts you may share when asked (don't volunteer):\n${knowns}`,
      },
    ];

    if (transcript.length === 0) {
      messages.push({
        role: "user",
        content:
          "Write your opening message to the support agent. One or two sentences. Do not dump all the facts.",
      });
    } else {
      messages.push({
        role: "user",
        content: `Here is the conversation so far (you are the USER).\n\n${transcriptToString(
          transcript,
        )}\n\nWrite ONLY your next user reply, or output ##STOP## if the goal is clearly met or clearly refused.`,
      });
    }

    const resp = await this.client.chat({
      model: this.opts.model ?? "deepseek-chat",
      messages,
      temperature: this.opts.temperature ?? 0.1,
      maxTokens: 200,
    });
    const text = resp.content.trim();
    if (!text) return null;
    if (text === "##STOP##" || text.endsWith("##STOP##") || text.includes("##STOP##")) return null;
    return text;
  }
}

function transcriptToString(turns: Turn[]): string {
  const lines: string[] = [];
  for (const t of turns) {
    if (t.role === "user") lines.push(`USER: ${t.content}`);
    else if (t.role === "agent") lines.push(`AGENT: ${t.content}`);
    else if (t.role === "tool")
      lines.push(`(tool ${t.toolName} returned: ${truncate(t.content, 200)})`);
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
