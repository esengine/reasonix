import { type WriteStream, createWriteStream } from "node:fs";
import { Box, Static, Text, useApp } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../../index.js";
import type { LoopEvent } from "../../loop.js";
import type { SessionSummary } from "../../telemetry.js";
import { type DisplayEvent, EventRow } from "./EventLog.js";
import { PromptInput } from "./PromptInput.js";
import { StatsPanel } from "./StatsPanel.js";
import { handleSlash, parseSlash } from "./slash.js";

export interface AppProps {
  model: string;
  system: string;
  transcript?: string;
  harvest?: boolean;
  branch?: number;
  session?: string;
}

/**
 * Throttle interval in ms. We flush streaming deltas at most this often to
 * avoid re-rendering the whole UI on every single token from DeepSeek.
 * 60ms ≈ 16Hz, fast enough to feel live, slow enough to not thrash Ink.
 */
const FLUSH_INTERVAL_MS = 60;

interface StreamingState {
  id: string;
  text: string;
  reasoning: string;
}

export function App({ model, system, transcript, harvest, branch, session }: AppProps) {
  const { exit } = useApp();
  const [historical, setHistorical] = useState<DisplayEvent[]>([]);
  const [streaming, setStreaming] = useState<DisplayEvent | null>(null);
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
  useEffect(() => {
    return () => {
      transcriptRef.current?.end();
    };
  }, []);

  const loopRef = useRef<CacheFirstLoop | null>(null);
  const loop = useMemo(() => {
    if (loopRef.current) return loopRef.current;
    const client = new DeepSeekClient();
    const prefix = new ImmutablePrefix({ system });
    const l = new CacheFirstLoop({ client, prefix, model, harvest, branch, session });
    loopRef.current = l;
    return l;
  }, [model, system, harvest, branch, session]);

  // On first mount, surface a resume banner if the session had prior messages.
  const resumeBannerShown = useRef(false);
  useEffect(() => {
    if (!resumeBannerShown.current && session && loop.resumedMessageCount > 0) {
      resumeBannerShown.current = true;
      setHistorical((prev) => [
        ...prev,
        {
          id: `sys-resume-${Date.now()}`,
          role: "info",
          text: `▸ resumed session "${session}" with ${loop.resumedMessageCount} prior messages · type /history or ask naturally`,
        },
      ]);
    }
  }, [session, loop]);

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
      const slash = parseSlash(text);
      if (slash) {
        const result = handleSlash(slash.cmd, slash.args, loop);
        if (result.exit) {
          transcriptRef.current?.end();
          exit();
          return;
        }
        if (result.clear) {
          setHistorical([]);
          return;
        }
        if (result.info) {
          setHistorical((prev) => [
            ...prev,
            {
              id: `sys-${Date.now()}`,
              role: "info",
              text: result.info!,
            },
          ]);
        }
        return;
      }

      // User message is immutable — push to Static immediately.
      setHistorical((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text }]);

      const assistantId = `a-${Date.now()}`;
      // Refs are the source of truth for accumulated streaming text; the React
      // state copy below is only for rendering and gets updated on flush.
      const streamRef: StreamingState = { id: assistantId, text: "", reasoning: "" };
      const contentBuf = { current: "" };
      const reasoningBuf = { current: "" };

      setStreaming({ id: assistantId, role: "assistant", text: "", streaming: true });
      setBusy(true);

      const flush = () => {
        if (!contentBuf.current && !reasoningBuf.current) return;
        streamRef.text += contentBuf.current;
        streamRef.reasoning += reasoningBuf.current;
        contentBuf.current = "";
        reasoningBuf.current = "";
        setStreaming({
          id: assistantId,
          role: "assistant",
          text: streamRef.text,
          reasoning: streamRef.reasoning || undefined,
          streaming: true,
        });
      };
      const timer = setInterval(flush, FLUSH_INTERVAL_MS);

      try {
        for await (const ev of loop.step(text)) {
          writeTranscript(ev);
          if (ev.role === "assistant_delta") {
            if (ev.content) contentBuf.current += ev.content;
            if (ev.reasoningDelta) reasoningBuf.current += ev.reasoningDelta;
          } else if (ev.role === "branch_start") {
            setStreaming({
              id: assistantId,
              role: "assistant",
              text: "",
              streaming: true,
              branchProgress: ev.branchProgress,
            });
          } else if (ev.role === "branch_progress") {
            // Live-update the streaming slot with per-sample completion info.
            setStreaming({
              id: assistantId,
              role: "assistant",
              text: "",
              streaming: true,
              branchProgress: ev.branchProgress,
            });
          } else if (ev.role === "branch_done") {
            // Intermediate: branching finished but assistant_final not yet emitted.
            // Keep streaming state alive; actual render happens on assistant_final.
          } else if (ev.role === "assistant_final") {
            flush();
            const repairNote = ev.repair ? describeRepair(ev.repair) : "";
            setStreaming(null);
            setHistorical((prev) => [
              ...prev,
              {
                id: assistantId,
                role: "assistant",
                text: ev.content || streamRef.text,
                reasoning: streamRef.reasoning || undefined,
                planState: ev.planState,
                branch: ev.branch,
                stats: ev.stats,
                repair: repairNote || undefined,
                streaming: false,
              },
            ]);
          } else if (ev.role === "tool") {
            flush();
            setHistorical((prev) => [
              ...prev,
              {
                id: `t-${Date.now()}-${Math.random()}`,
                role: "tool",
                text: ev.content,
                toolName: ev.toolName,
              },
            ]);
          } else if (ev.role === "error") {
            setHistorical((prev) => [
              ...prev,
              { id: `e-${Date.now()}`, role: "error", text: ev.error ?? ev.content },
            ]);
          }
        }
        flush();
      } finally {
        clearInterval(timer);
        setStreaming(null);
        setSummary(loop.stats.summary());
        setBusy(false);
      }
    },
    [busy, exit, loop, writeTranscript],
  );

  return (
    <Box flexDirection="column">
      <StatsPanel
        summary={summary}
        model={loop.model}
        prefixHash={prefixHash}
        harvestOn={loop.harvestEnabled}
        branchBudget={loop.branchOptions.budget}
      />
      <Static items={historical}>{(item) => <EventRow key={item.id} event={item} />}</Static>
      {streaming ? (
        <Box marginY={1}>
          <EventRow event={streaming} />
        </Box>
      ) : null}
      <PromptInput value={input} onChange={setInput} onSubmit={handleSubmit} disabled={busy} />
      <CommandStrip />
    </Box>
  );
}

function CommandStrip() {
  return (
    <Box paddingX={2}>
      <Text dimColor>
        /help · /preset {"<fast|smart|max>"} · /model · /harvest · /branch · /clear · /exit
      </Text>
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
