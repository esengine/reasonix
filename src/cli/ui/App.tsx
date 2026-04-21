import { type WriteStream, createWriteStream } from "node:fs";
import { Box, useApp } from "ink";
import React, { useCallback, useMemo, useReducer, useRef, useState } from "react";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../../index.js";
import type { LoopEvent } from "../../loop.js";
import type { SessionSummary } from "../../telemetry.js";
import { type DisplayEvent, EventLog } from "./EventLog.js";
import { PromptInput } from "./PromptInput.js";
import { StatsPanel } from "./StatsPanel.js";

export interface AppProps {
  model: string;
  system: string;
  transcript?: string;
}

type Action =
  | { type: "push"; event: DisplayEvent }
  | { type: "append_assistant"; id: string; delta: string }
  | { type: "append_reasoning"; id: string; delta: string }
  | {
      type: "finalize_assistant";
      id: string;
      stats?: DisplayEvent["stats"];
      repair?: string;
    };

function patchEvent(
  state: DisplayEvent[],
  id: string,
  patch: (ev: DisplayEvent) => DisplayEvent,
): DisplayEvent[] {
  const copy = state.slice();
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i]!.id === id) {
      copy[i] = patch(copy[i]!);
      return copy;
    }
  }
  return state;
}

function reducer(state: DisplayEvent[], action: Action): DisplayEvent[] {
  if (action.type === "push") return [...state, action.event];
  if (action.type === "append_assistant") {
    return patchEvent(state, action.id, (ev) => ({ ...ev, text: ev.text + action.delta }));
  }
  if (action.type === "append_reasoning") {
    return patchEvent(state, action.id, (ev) => ({
      ...ev,
      reasoning: (ev.reasoning ?? "") + action.delta,
    }));
  }
  if (action.type === "finalize_assistant") {
    return patchEvent(state, action.id, (ev) => ({
      ...ev,
      streaming: false,
      stats: action.stats ?? ev.stats,
      repair: action.repair ?? ev.repair,
    }));
  }
  return state;
}

export function App({ model, system, transcript }: AppProps) {
  const { exit } = useApp();
  const [events, dispatch] = useReducer(reducer, [] as DisplayEvent[]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<SessionSummary>({
    turns: 0,
    totalCostUsd: 0,
    claudeEquivalentUsd: 0,
    savingsVsClaudePct: 0,
    cacheHitRatio: 0,
  });

  const transcriptRef = useRef<WriteStream | null>(null);
  if (transcript && !transcriptRef.current) {
    transcriptRef.current = createWriteStream(transcript, { flags: "a" });
  }

  const loopRef = useRef<CacheFirstLoop | null>(null);
  const loop = useMemo(() => {
    if (loopRef.current) return loopRef.current;
    const client = new DeepSeekClient();
    const prefix = new ImmutablePrefix({ system });
    const l = new CacheFirstLoop({ client, prefix, model });
    loopRef.current = l;
    return l;
  }, [model, system]);

  const prefixHash = loop.prefix.fingerprint;

  const writeTranscript = useCallback((ev: LoopEvent) => {
    transcriptRef.current?.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        turn: ev.turn,
        role: ev.role,
        content: ev.content,
        tool: ev.toolName,
      })}\n`,
    );
  }, []);

  const handleSubmit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busy) return;
      setInput("");
      if (text === "/exit" || text === "/quit") {
        transcriptRef.current?.end();
        exit();
        return;
      }
      if (text === "/clear") {
        return;
      }
      dispatch({
        type: "push",
        event: { id: `u-${Date.now()}`, role: "user", text },
      });
      setBusy(true);
      const assistantId = `a-${Date.now()}`;
      dispatch({
        type: "push",
        event: { id: assistantId, role: "assistant", text: "", streaming: true },
      });
      try {
        for await (const ev of loop.step(text)) {
          writeTranscript(ev);
          if (ev.role === "assistant_delta") {
            if (ev.content) {
              dispatch({ type: "append_assistant", id: assistantId, delta: ev.content });
            }
            if (ev.reasoningDelta) {
              dispatch({ type: "append_reasoning", id: assistantId, delta: ev.reasoningDelta });
            }
          }
          if (ev.role === "assistant_final") {
            const repairNote = ev.repair ? describeRepair(ev.repair) : "";
            dispatch({
              type: "finalize_assistant",
              id: assistantId,
              stats: ev.stats,
              repair: repairNote || undefined,
            });
          }
          if (ev.role === "tool") {
            dispatch({
              type: "push",
              event: {
                id: `t-${Date.now()}-${Math.random()}`,
                role: "tool",
                text: ev.content,
                toolName: ev.toolName,
              },
            });
          }
          if (ev.role === "error") {
            dispatch({
              type: "push",
              event: { id: `e-${Date.now()}`, role: "error", text: ev.error ?? ev.content },
            });
          }
        }
      } finally {
        setSummary(loop.stats.summary());
        setBusy(false);
      }
    },
    [busy, exit, loop, writeTranscript],
  );

  return (
    <Box flexDirection="column">
      <StatsPanel summary={summary} model={model} prefixHash={prefixHash} />
      <Box flexDirection="column" marginY={1}>
        <EventLog events={events} />
      </Box>
      <PromptInput value={input} onChange={setInput} onSubmit={handleSubmit} disabled={busy} />
    </Box>
  );
}

function describeRepair(repair: {
  scavenged: number;
  truncationsFixed: number;
  stormsBroken: number;
}): string {
  const parts: string[] = [];
  if (repair.scavenged) parts.push(`scavenged ${repair.scavenged}`);
  if (repair.truncationsFixed) parts.push(`repaired ${repair.truncationsFixed} truncation`);
  if (repair.stormsBroken) parts.push(`broke ${repair.stormsBroken} storm`);
  return parts.length ? `[repair] ${parts.join(", ")}` : "";
}
