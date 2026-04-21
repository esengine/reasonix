import { render } from "ink";
import React from "react";
import { loadDotenv } from "../env.js";
import { App } from "../ui/App.js";

export interface ChatOptions {
  model: string;
  system: string;
  transcript?: string;
}

export async function chatCommand(opts: ChatOptions): Promise<void> {
  loadDotenv();
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("DEEPSEEK_API_KEY is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  const { waitUntilExit } = render(
    <App model={opts.model} system={opts.system} transcript={opts.transcript} />,
    { exitOnCtrlC: true },
  );
  await waitUntilExit();
}
