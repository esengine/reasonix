import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import React from "react";

export interface PromptInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function PromptInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
}: PromptInputProps) {
  return (
    <Box borderStyle="round" borderColor={disabled ? "gray" : "cyan"} paddingX={1}>
      <Text bold color={disabled ? "gray" : "cyan"}>
        you ›{" "}
      </Text>
      {disabled ? (
        <Text dimColor>{placeholder ?? "…waiting for response…"}</Text>
      ) : (
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={placeholder ?? 'type a message, or "/exit"'}
        />
      )}
    </Box>
  );
}
