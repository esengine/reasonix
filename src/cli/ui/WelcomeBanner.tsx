/**
 * Welcome card on the empty session. The FIRST thing every user sees
 * after launching `reasonix code` — must communicate brand identity,
 * what to type next, and how to escape, all in the ~5 seconds before
 * the user starts typing.
 *
 * Layout (matches design/tui-redesign-ink.html welcome state):
 *
 *                    ◈ R E A S O N I X
 *
 *      DeepSeek-native coding agent · cache-first · flash-first
 *
 *        /skill         invoke a stored playbook by name
 *        @file          inline a file's contents in your message
 *        /checkpoint    snapshot the workspace before a risky turn
 *        /help          every slash command + keyboard shortcut
 *
 *              tip · ctrl+j newline · trailing \ continues
 *
 * Why the redesign: the previous version was a left-aligned hint list
 * with a tiny `◈ welcome` row — functional but invisible as brand. The
 * gradient wordmark is the one chance per launch to plant identity, so
 * we make it large + centered + colored across all 8 brand-gradient
 * stops. The tagline below answers "what is this?" in one line. Cards
 * answer "what do I type?" — the only three things a new user actually
 * needs to know in the first 5 seconds.
 *
 * Why no animation: an animated gradient pan was tried, but Ink's
 * eraseLines miscounts on resize when wide rows reflow, leaving
 * stale frames stacked. Static gradient renders identically and
 * costs zero ticker subscriptions.
 */

import { Box, Text, useStdout } from "ink";
import React from "react";
import { COLOR, GRADIENT } from "./theme.js";

export interface WelcomeBannerProps {
  /** True when running `reasonix code`. Surfaces code-mode hints. */
  inCodeMode?: boolean;
  /**
   * Live URL of the embedded dashboard, or null when it isn't running.
   * Surfacing this in the welcome card is how users discover the web UI
   * — the chrome pill version was unreliable across terminals, so the
   * card became the canonical pointer.
   */
  dashboardUrl?: string | null;
}

const WORDMARK = "REASONIX";
const TAGLINE_CHAT = "DeepSeek-native agent · cache-first · flash-first";
const TAGLINE_CODE = "DeepSeek-native coding agent · cache-first · flash-first";

interface QuickCard {
  cmd: string;
  desc: string;
}

const CARDS_CHAT: QuickCard[] = [
  { cmd: "/help", desc: "every slash command + keyboard shortcut" },
  { cmd: "/skill", desc: "invoke a stored playbook by name" },
  { cmd: "/dashboard", desc: "open the embedded web UI (chat · stats · settings)" },
  { cmd: "/preset pro", desc: "switch to v4-pro for hard reasoning tasks" },
  { cmd: "/exit", desc: "quit the TUI (Ctrl+C twice also works)" },
];

const CARDS_CODE: QuickCard[] = [
  { cmd: "@file", desc: "inline a file's contents in your message" },
  { cmd: "!cmd", desc: "run shell — output is captured for context" },
  { cmd: "/checkpoint", desc: "snapshot the workspace before a risky turn" },
  { cmd: "/dashboard", desc: "open the embedded web UI (chat · files · stats · settings)" },
  { cmd: "/help", desc: "every slash command + keyboard shortcut" },
];

export function WelcomeBanner({
  inCodeMode,
  dashboardUrl,
}: WelcomeBannerProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  // Wordmark width: each letter + space between letters. With letter-
  // spacing of 1 cell, "R E A S O N I X" is 8*2-1 = 15 cells, plus the
  // brand mark "◈ " = 2 cells, total 17 cells. We center on the term
  // width, capped to a sane minimum so very narrow terminals don't
  // produce negative pad.
  const wordmarkText = `◈ ${WORDMARK.split("").join(" ")}`;
  const wordmarkWidth = wordmarkText.length;
  const tagline = inCodeMode ? TAGLINE_CODE : TAGLINE_CHAT;
  const cards = inCodeMode ? CARDS_CODE : CARDS_CHAT;

  // Center column 1: pad-left to put wordmark at terminal center
  const wordmarkPad = Math.max(0, Math.floor((cols - wordmarkWidth) / 2));
  const taglinePad = Math.max(0, Math.floor((cols - tagline.length) / 2));
  // Cards left-margin: align to a comfortable indent rather than
  // center each row (keeps the cmd column aligned).
  const cardsIndent = Math.max(2, Math.floor((cols - 60) / 2));
  const tipText = "tip · ctrl+j newline · trailing \\ also continues";
  const tipPad = Math.max(0, Math.floor((cols - tipText.length) / 2));

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Wordmark — gradient across the 8 letters of REASONIX. The
          brand mark `◈` sits in the brand teal as the first stop, then
          each letter steps through the gradient. Bold throughout for
          weight; spacing keeps it from reading as a single dense word. */}
      <Box>
        <Text>{" ".repeat(wordmarkPad)}</Text>
        <Text bold color={GRADIENT[0]}>
          {"◈ "}
        </Text>
        {WORDMARK.split("").map((letter, i) => (
          // Wordmark is fixed-string ("REASONIX") — letters are unique
          // and the array never reorders, so per-letter key is stable.
          <React.Fragment key={letter}>
            <Text bold color={GRADIENT[i % GRADIENT.length]}>
              {letter}
            </Text>
            {i < WORDMARK.length - 1 ? <Text> </Text> : null}
          </React.Fragment>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text>{" ".repeat(taglinePad)}</Text>
        <Text color={COLOR.info}>{tagline}</Text>
      </Box>

      {/* Quick-start cards — cmd token in accent violet, desc dim.
          Aligned in two columns so the eye can scan command names
          without having to read each desc. */}
      <Box flexDirection="column" marginTop={2}>
        {cards.map((card) => (
          <Box key={card.cmd}>
            <Text>{" ".repeat(cardsIndent)}</Text>
            <Text bold color={COLOR.accent}>
              {card.cmd.padEnd(14)}
            </Text>
            <Text color={COLOR.info}>{card.desc}</Text>
          </Box>
        ))}
      </Box>

      {/* Live dashboard URL — printed once, centered, when the embedded
          server is up. This is the canonical pointer to the web UI; the
          chrome pill version was unreliable across terminals so we
          surface the URL here (one-shot at launch) and let the user
          re-fetch via `/dashboard` whenever the welcome card has
          scrolled away. */}
      {dashboardUrl ? (
        <Box marginTop={2}>
          <Text>{" ".repeat(Math.max(0, Math.floor((cols - (dashboardUrl.length + 9)) / 2)))}</Text>
          <Text color={COLOR.brand} bold>
            {"▸ web · "}
          </Text>
          <Text color={COLOR.accent}>{dashboardUrl}</Text>
        </Box>
      ) : null}

      <Box marginTop={dashboardUrl ? 1 : 2}>
        <Text>{" ".repeat(tipPad)}</Text>
        <Text dimColor>{tipText}</Text>
      </Box>
    </Box>
  );
}
