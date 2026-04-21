import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { render } from "ink";
import React from "react";
import { diffTranscripts, renderMarkdown, renderSummaryTable } from "../../diff.js";
import { readTranscript } from "../../transcript.js";
import { DiffApp } from "../ui/DiffApp.js";

export interface DiffOptions {
  a: string;
  b: string;
  mdPath?: string;
  labelA?: string;
  labelB?: string;
  /** Force stdout summary table (no Ink TUI). Auto when stdout isn't a TTY. */
  print?: boolean;
  /** Force the TUI even when stdout isn't a TTY (rare). */
  tui?: boolean;
}

/**
 * Compare two transcripts. Three output paths, picked in order:
 *   - If --md is passed: write the markdown report. Also prints the stdout
 *     summary so the user sees what was exported.
 *   - If --print, no TTY, or --md (see above): stdout summary table.
 *   - Otherwise: interactive Ink TUI with split-pane + n/N divergence jump.
 */
export async function diffCommand(opts: DiffOptions): Promise<void> {
  const aParsed = readTranscript(opts.a);
  const bParsed = readTranscript(opts.b);

  const report = diffTranscripts(
    { label: opts.labelA ?? basename(opts.a), parsed: aParsed },
    { label: opts.labelB ?? basename(opts.b), parsed: bParsed },
  );

  const wantMarkdown = !!opts.mdPath;
  const wantPrint = opts.print || !process.stdout.isTTY;
  const wantTui = opts.tui || (!wantPrint && !wantMarkdown);

  if (wantMarkdown) {
    // Markdown export implies the user wants an artifact, not a TUI.
    // Still echo the stdout summary to confirm the action.
    console.log(renderSummaryTable(report));
    const md = renderMarkdown(report);
    writeFileSync(opts.mdPath!, md, "utf8");
    console.log(`\nmarkdown report written to ${opts.mdPath}`);
    return;
  }

  if (wantTui) {
    const { waitUntilExit } = render(React.createElement(DiffApp, { report }), {
      exitOnCtrlC: true,
    });
    await waitUntilExit();
    return;
  }

  // stdout fallback (piped, --print, or non-TTY)
  console.log(renderSummaryTable(report));
}
