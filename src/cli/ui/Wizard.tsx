/**
 * First-run / re-configure wizard.
 *
 * Walks a new user through: API key → preset pick → MCP server pick →
 * per-server args → save. Saved output lives in `~/.reasonix/config.json`
 * so the next `reasonix chat` starts with everything already wired.
 *
 * The wizard is the antidote to "too many CLI flags" — a new user should
 * never have to read `--help` to get MCP + a sensible model combo
 * working. Everything a user could set via `--mcp`, `--harvest`,
 * `--branch`, etc. can be picked here in a few arrow-key presses.
 */

import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
// biome-ignore lint/style/useImportType: JSX (jsx: "react") needs React as a value at runtime
import React, { useState } from "react";
import {
  type PresetName,
  type ReasonixConfig,
  defaultConfigPath,
  isPlausibleKey,
  readConfig,
  redactKey,
  writeConfig,
} from "../../config.js";
import { type CatalogEntry, MCP_CATALOG } from "../../mcp/catalog.js";
import { MultiSelect, type SelectItem, SingleSelect } from "./Select.js";
import { PRESET_DESCRIPTIONS } from "./presets.js";

export interface WizardProps {
  /** Called once the config has been saved. */
  onComplete: (cfg: ReasonixConfig) => void;
  /** Called if the user presses Esc to abort. */
  onCancel?: () => void;
  /** Skip the API-key step if a key already exists (env or config). */
  existingApiKey?: string;
  /** Pre-fill selections when re-running (reconfigure flow). */
  initial?: {
    preset?: PresetName;
    mcp?: string[];
  };
}

type Step = "apiKey" | "preset" | "mcp" | "mcpArgs" | "review" | "saved";

interface WizardData {
  apiKey: string;
  preset: PresetName;
  selectedCatalog: string[]; // entries from MCP_CATALOG by `name`
  /** Captured user inputs per catalog entry that has `userArgs` (e.g. fs dir). */
  catalogArgs: Record<string, string>;
}

const CATALOG_BY_NAME = new Map(MCP_CATALOG.map((e) => [e.name, e]));

export function Wizard({ onComplete, onCancel, existingApiKey, initial }: WizardProps) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>(existingApiKey ? "preset" : "apiKey");
  const [data, setData] = useState<WizardData>({
    apiKey: existingApiKey ?? "",
    preset: initial?.preset ?? "auto",
    selectedCatalog: deriveInitialCatalog(initial?.mcp ?? []),
    catalogArgs: {},
  });
  const [error, setError] = useState<string | null>(null);

  // Global Esc → cancel. Disabled once we've started saving to avoid
  // ejecting out of a half-written state.
  useInput((_input, key) => {
    if (key.escape && step !== "saved" && onCancel) onCancel();
  });

  if (step === "apiKey") {
    return (
      <ApiKeyStep
        onSubmit={(key) => {
          setData((d) => ({ ...d, apiKey: key }));
          setError(null);
          setStep("preset");
        }}
        error={error}
        onError={setError}
      />
    );
  }

  if (step === "preset") {
    return (
      <StepFrame title="Pick a preset" step={1} total={3}>
        <SingleSelect<PresetName>
          items={presetItems()}
          initialValue={data.preset}
          onSubmit={(preset) => {
            setData((d) => ({ ...d, preset }));
            setStep("mcp");
          }}
        />
        <Box marginTop={1}>
          <Text dimColor>[↑↓] navigate · [Enter] confirm · [Esc] cancel</Text>
        </Box>
      </StepFrame>
    );
  }

  if (step === "mcp") {
    return (
      <StepFrame title="Which MCP servers should Reasonix wire up for you?" step={2} total={3}>
        <MultiSelect
          items={mcpItems()}
          initialSelected={data.selectedCatalog}
          onSubmit={(selected) => {
            setData((d) => ({ ...d, selectedCatalog: selected }));
            // Only advance to the args step if any selected entry needs args.
            const needsArgs = selected.some((name) => CATALOG_BY_NAME.get(name)?.userArgs);
            setStep(needsArgs ? "mcpArgs" : "review");
          }}
          footer="[↑↓] navigate  ·  [Space] toggle  ·  [Enter] confirm  ·  [Esc] cancel  ·  empty = skip"
        />
      </StepFrame>
    );
  }

  if (step === "mcpArgs") {
    const pending = data.selectedCatalog.filter((name) => {
      const entry = CATALOG_BY_NAME.get(name);
      return entry?.userArgs && !data.catalogArgs[name];
    });
    if (pending.length === 0) {
      setStep("review");
      return null;
    }
    const currentName = pending[0]!;
    const entry = CATALOG_BY_NAME.get(currentName)!;
    return (
      <McpArgsStep
        entry={entry}
        error={error}
        onSubmit={(value) => {
          setData((d) => ({
            ...d,
            catalogArgs: { ...d.catalogArgs, [currentName]: value },
          }));
          setError(null);
        }}
        onError={setError}
      />
    );
  }

  if (step === "review") {
    const specs = data.selectedCatalog.map((name) => buildSpec(name, data.catalogArgs));
    return (
      <StepFrame title="Ready to save" step={3} total={3}>
        <Box flexDirection="column">
          <SummaryLine label="API key" value={redactKey(data.apiKey)} />
          <SummaryLine label="Preset" value={data.preset} />
          <SummaryLine
            label="MCP"
            value={specs.length === 0 ? "(none)" : `${specs.length} server(s)`}
          />
          {specs.map((spec, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: review-only render, order fixed
            <Box key={i} paddingLeft={14}>
              <Text dimColor>· {spec}</Text>
            </Box>
          ))}
          <Box marginTop={1}>
            <Text>Saves to {defaultConfigPath()}</Text>
          </Box>
          {error ? (
            <Box marginTop={1}>
              <Text color="red">{error}</Text>
            </Box>
          ) : null}
          <Box marginTop={1}>
            <Text dimColor>[Enter] save · [Esc] cancel</Text>
          </Box>
        </Box>
        <ReviewConfirm
          onConfirm={() => {
            try {
              const specsNow = data.selectedCatalog.map((name) =>
                buildSpec(name, data.catalogArgs),
              );
              const prev = readConfig();
              const next: ReasonixConfig = {
                ...prev,
                apiKey: data.apiKey,
                preset: data.preset,
                mcp: specsNow,
                setupCompleted: true,
              };
              writeConfig(next);
              setStep("saved");
              onComplete(next);
            } catch (e) {
              setError(`Could not save config: ${(e as Error).message}`);
            }
          }}
        />
      </StepFrame>
    );
  }

  // saved
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text bold color="green">
        ▸ Saved.
      </Text>
      <Box marginTop={1}>
        <Text>Run `reasonix` any time to start chatting — your settings are remembered.</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[Enter] to exit</Text>
      </Box>
      <ExitOnEnter onExit={exit} />
    </Box>
  );
}

// ---------- step components ----------

function ApiKeyStep({
  onSubmit,
  error,
  onError,
}: {
  onSubmit: (key: string) => void;
  error: string | null;
  onError: (e: string | null) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Welcome to Reasonix.
      </Text>
      <Box marginTop={1}>
        <Text>Paste your DeepSeek API key to get started.</Text>
      </Box>
      <Text dimColor>Get one at: https://platform.deepseek.com/api_keys</Text>
      <Text dimColor>Saved locally to {defaultConfigPath()}</Text>
      <Box marginTop={1}>
        <Text bold color="cyan">
          {"key › "}
        </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={(raw) => {
            const trimmed = raw.trim();
            if (!isPlausibleKey(trimmed)) {
              onError("Doesn't look like a DeepSeek key. They start with 'sk-' and are 30+ chars.");
              setValue("");
              return;
            }
            onSubmit(trimmed);
          }}
          mask="•"
          placeholder="sk-..."
        />
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : value ? (
        <Box marginTop={1}>
          <Text dimColor>preview: {redactKey(value)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function McpArgsStep({
  entry,
  error,
  onSubmit,
  onError,
}: {
  entry: CatalogEntry;
  error: string | null;
  onSubmit: (value: string) => void;
  onError: (e: string | null) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <StepFrame title={`Configure ${entry.name}`} step={2} total={3}>
      <Box flexDirection="column">
        <Text>{entry.summary}</Text>
        {entry.note ? (
          <Box marginTop={1}>
            <Text dimColor>{entry.note}</Text>
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text>Required parameter: </Text>
          <Text bold>{entry.userArgs}</Text>
        </Box>
        <Box marginTop={1}>
          <Text bold color="cyan">
            {entry.userArgs}
            {" › "}
          </Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={(raw) => {
              const trimmed = raw.trim();
              if (!trimmed) {
                onError(`${entry.name} needs a value — got an empty string.`);
                return;
              }
              onSubmit(trimmed);
              setValue("");
            }}
            placeholder={placeholderFor(entry)}
          />
        </Box>
        {error ? (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        ) : null}
      </Box>
    </StepFrame>
  );
}

function ReviewConfirm({ onConfirm }: { onConfirm: () => void }) {
  useInput((_i, key) => {
    if (key.return) onConfirm();
  });
  return null;
}

function ExitOnEnter({ onExit }: { onExit: () => void }) {
  useInput((_i, key) => {
    if (key.return) onExit();
  });
  return null;
}

// ---------- small bits ----------

function StepFrame({
  title,
  step,
  total,
  children,
}: {
  title: string;
  step: number;
  total: number;
  children: React.ReactNode;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text dimColor>
          Step {step}/{total} ·{" "}
        </Text>
        <Text bold color="cyan">
          {title}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Text>{label.padEnd(12)}</Text>
      <Text bold>{value}</Text>
    </Box>
  );
}

// ---------- data helpers ----------

function presetItems(): SelectItem<PresetName>[] {
  return (["auto", "flash", "pro"] as const).map((name) => ({
    value: name as PresetName,
    label: `${name} — ${PRESET_DESCRIPTIONS[name].headline}`,
    hint: PRESET_DESCRIPTIONS[name].cost,
  }));
}

function mcpItems(): SelectItem<string>[] {
  return MCP_CATALOG.map((entry) => {
    const hintParts: string[] = [entry.summary];
    if (entry.userArgs) hintParts.push(`(you'll provide ${entry.userArgs})`);
    if (entry.note) hintParts.push(entry.note);
    return {
      value: entry.name,
      label: entry.name,
      hint: hintParts.join(" · "),
    };
  });
}

function placeholderFor(entry: CatalogEntry): string {
  if (entry.name === "filesystem") return "e.g. /tmp/reasonix-sandbox";
  if (entry.name === "sqlite") return "e.g. ./notes.sqlite";
  return entry.userArgs ?? "";
}

function deriveInitialCatalog(existingSpecs: string[]): string[] {
  // Best-effort recovery: if the user previously picked catalog entries,
  // the spec strings look like `name=npx -y <pkg> ...`. Match by package
  // so reconfigure pre-checks the same boxes.
  const packageToName = new Map(MCP_CATALOG.map((e) => [e.package, e.name]));
  const out: string[] = [];
  for (const spec of existingSpecs) {
    for (const [pkg, name] of packageToName) {
      if (spec.includes(pkg)) {
        out.push(name);
        break;
      }
    }
  }
  return out;
}

/**
 * Build the `--mcp` spec string for a catalog entry. Same format
 * `mcpCommandFor` produces for `reasonix mcp list`, minus the leading
 * `--mcp "..."` wrapper — we store the inner spec directly.
 */
export function buildSpec(name: string, argsByName: Record<string, string>): string {
  const entry = CATALOG_BY_NAME.get(name);
  if (!entry) return name; // shouldn't happen; fall back gracefully
  const userArg = entry.userArgs ? argsByName[name] : undefined;
  const tail = userArg ? ` ${quoteIfNeeded(userArg)}` : "";
  return `${entry.name}=npx -y ${entry.package}${tail}`;
}

function quoteIfNeeded(s: string): string {
  return /\s|"/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}
