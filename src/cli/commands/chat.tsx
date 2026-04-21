import { render } from "ink";
import React, { useState } from "react";
import { loadApiKey } from "../../config.js";
import { loadDotenv } from "../../env.js";
import { App } from "../ui/App.js";
import { Setup } from "../ui/Setup.js";

export interface ChatOptions {
  model: string;
  system: string;
  transcript?: string;
  harvest?: boolean;
  branch?: number;
  session?: string;
}

interface RootProps extends ChatOptions {
  initialKey: string | undefined;
}

function Root({ initialKey, ...appProps }: RootProps) {
  const [key, setKey] = useState<string | undefined>(initialKey);
  if (!key) {
    return (
      <Setup
        onReady={(k) => {
          process.env.DEEPSEEK_API_KEY = k;
          setKey(k);
        }}
      />
    );
  }
  // Ensure the loop's DeepSeekClient picks up the key when it lazy-instantiates.
  process.env.DEEPSEEK_API_KEY = key;
  return (
    <App
      model={appProps.model}
      system={appProps.system}
      transcript={appProps.transcript}
      harvest={appProps.harvest}
      branch={appProps.branch}
      session={appProps.session}
    />
  );
}

export async function chatCommand(opts: ChatOptions): Promise<void> {
  loadDotenv();
  const initialKey = loadApiKey();
  const { waitUntilExit } = render(<Root initialKey={initialKey} {...opts} />, {
    exitOnCtrlC: true,
  });
  await waitUntilExit();
}
