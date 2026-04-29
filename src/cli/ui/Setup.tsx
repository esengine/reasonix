import { Box, Text, useApp } from "ink";
import TextInput from "ink-text-input";
import React, { useState } from "react";
import { defaultConfigPath, isPlausibleKey, redactKey, saveApiKey } from "../../config.js";
import { COLOR, GLYPH, GRADIENT } from "./theme.js";

export interface SetupProps {
  onReady: (apiKey: string) => void;
}

export function Setup({ onReady }: SetupProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { exit } = useApp();

  const handleSubmit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "/exit" || trimmed === "/quit") {
      exit();
      return;
    }
    if (!isPlausibleKey(trimmed)) {
      setError("Doesn't look like a DeepSeek key. They start with 'sk-' and are 30+ chars.");
      setValue("");
      return;
    }
    try {
      saveApiKey(trimmed);
    } catch (err) {
      setError(`Could not save key: ${(err as Error).message}`);
      return;
    }
    onReady(trimmed);
  };

  return (
    <Box flexDirection="column" paddingX={1} marginY={1}>
      <Box>
        <Text bold color={GRADIENT[0]}>
          {GLYPH.brand}
        </Text>
        <Text>{"  "}</Text>
        <Text bold>Welcome to </Text>
        <Text bold color={GRADIENT[2]}>
          REASONIX
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={COLOR.info}>Paste your DeepSeek API key to get started.</Text>
      </Box>
      <Box>
        <Text dimColor>{"  free credit on signup · "}</Text>
        <Text color={COLOR.primary}>https://platform.deepseek.com/api_keys</Text>
      </Box>
      <Box>
        <Text dimColor>{"  saved to "}</Text>
        <Text dimColor>{defaultConfigPath()}</Text>
      </Box>
      <Box marginTop={1}>
        <Text bold color={COLOR.brand}>
          {GLYPH.bar}
        </Text>
        <Text bold color={COLOR.primary}>
          {" › "}
        </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          mask="•"
          placeholder="sk-..."
        />
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color={COLOR.err} bold>
            {GLYPH.err}
          </Text>
          <Text color={COLOR.err}>{`  ${error}`}</Text>
        </Box>
      ) : value ? (
        <Box marginTop={1}>
          <Text dimColor>{`  preview · ${redactKey(value)}`}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>{"  /exit to abort"}</Text>
      </Box>
    </Box>
  );
}
