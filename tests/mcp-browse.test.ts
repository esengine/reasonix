import { describe, expect, it, vi } from "vitest";
import type { Scrollback } from "../src/cli/ui/hooks/useScrollback.js";
import {
  findServerForPrompt,
  findServerForResource,
  formatPromptList,
  formatPromptMessages,
  formatResourceContents,
  formatResourceList,
  handleMcpBrowseSlash,
} from "../src/cli/ui/mcp-browse.js";
import type { McpServerSummary } from "../src/cli/ui/slash.js";
import type { McpClient } from "../src/mcp/client.js";

interface PushedRow {
  role: "info" | "warning";
  text: string;
}

function makeFakeLog() {
  const rows: PushedRow[] = [];
  const log = {
    pushUser: () => "u",
    pushWarning: (title: string, message: string) => {
      rows.push({ role: "warning", text: message ? `${title}: ${message}` : title });
      return "w";
    },
    pushError: () => "e",
    pushInfo: (text: string) => {
      rows.push({ role: "info", text });
      return "i";
    },
    pushStepProgress: () => "s",
    pushPlanAnnounce: () => "p",
    startReasoning: () => "r",
    appendReasoning: () => undefined,
    endReasoning: () => undefined,
    startStreaming: () => "s",
    appendStreaming: () => undefined,
    endStreaming: () => undefined,
    startTool: () => "t",
    appendToolOutput: () => undefined,
    endTool: () => undefined,
    retryTool: () => undefined,
    thinking: () => "th",
    abortTurn: () => undefined,
    endTurn: () => undefined,
    reset: () => undefined,
  } satisfies Scrollback;
  return { rows, log };
}

function server(
  partial: Partial<McpServerSummary> & { label: string; client?: unknown },
): McpServerSummary {
  // Tests pass a stubbed `client` for convenience; wrap it in the host shape
  // the bridge expects.
  const { client, ...rest } = partial;
  return {
    spec: partial.spec ?? `fake://${partial.label}`,
    toolCount: partial.toolCount ?? 0,
    host: rest.host ?? { client: client as never },
    report: partial.report ?? {
      protocolVersion: "2024-11-05",
      serverInfo: { name: partial.label, version: "1.0" },
      capabilities: {},
      tools: { supported: true, items: [] },
      resources: { supported: true, items: [] },
      prompts: { supported: true, items: [] },
    },
    ...rest,
  };
}

describe("formatResourceList", () => {
  it("returns a polite message when no server exposes any resources", () => {
    expect(formatResourceList([])).toMatch(/No resources/);
  });

  it("groups URIs by server label, shows name + mime when present", () => {
    const out = formatResourceList([
      server({
        label: "fs",
        report: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "fs", version: "1" },
          capabilities: {},
          tools: { supported: true, items: [] },
          prompts: { supported: false, reason: "" },
          resources: {
            supported: true,
            items: [{ uri: "file:///a.md", name: "a.md", mimeType: "text/markdown" }],
          },
        },
      }),
    ]);
    expect(out).toContain("[fs] 1 resource(s):");
    expect(out).toContain("file:///a.md");
    expect(out).toContain("a.md");
    expect(out).toContain("text/markdown");
  });
});

describe("formatPromptList", () => {
  it("returns a polite message when no server exposes any prompts", () => {
    expect(formatPromptList([])).toMatch(/No prompts/);
  });

  it("shows argument requirement markers (*/?)", () => {
    const out = formatPromptList([
      server({
        label: "p",
        report: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "p", version: "1" },
          capabilities: {},
          tools: { supported: true, items: [] },
          resources: { supported: false, reason: "" },
          prompts: {
            supported: true,
            items: [
              {
                name: "summarize",
                description: "one-line summary",
                arguments: [
                  { name: "topic", required: true },
                  { name: "length", required: false },
                ],
              },
            ],
          },
        },
      }),
    ]);
    expect(out).toContain("summarize");
    expect(out).toContain("topic*");
    expect(out).toContain("length?");
    expect(out).toContain("one-line summary");
  });
});

describe("findServerForResource", () => {
  it("returns the server that claims the URI", () => {
    const a = server({
      label: "a",
      report: {
        protocolVersion: "",
        serverInfo: { name: "a", version: "" },
        capabilities: {},
        tools: { supported: true, items: [] },
        prompts: { supported: false, reason: "" },
        resources: { supported: true, items: [{ uri: "x://1", name: "x1" }] },
      },
    });
    const b = server({
      label: "b",
      report: {
        protocolVersion: "",
        serverInfo: { name: "b", version: "" },
        capabilities: {},
        tools: { supported: true, items: [] },
        prompts: { supported: false, reason: "" },
        resources: { supported: true, items: [{ uri: "y://2", name: "y2" }] },
      },
    });
    expect(findServerForResource([a, b], "y://2")).toBe(b);
    expect(findServerForResource([a, b], "nope://")).toBeNull();
  });

  it("skips servers that don't support resources", () => {
    const a = server({
      label: "a",
      report: {
        protocolVersion: "",
        serverInfo: { name: "a", version: "" },
        capabilities: {},
        tools: { supported: true, items: [] },
        prompts: { supported: false, reason: "" },
        resources: { supported: false, reason: "-32601" },
      },
    });
    expect(findServerForResource([a], "x://any")).toBeNull();
  });
});

describe("findServerForPrompt", () => {
  it("returns the server that claims the prompt name", () => {
    const a = server({
      label: "a",
      report: {
        protocolVersion: "",
        serverInfo: { name: "a", version: "" },
        capabilities: {},
        tools: { supported: true, items: [] },
        resources: { supported: false, reason: "" },
        prompts: { supported: true, items: [{ name: "summarize" }] },
      },
    });
    expect(findServerForPrompt([a], "summarize")).toBe(a);
    expect(findServerForPrompt([a], "missing")).toBeNull();
  });
});

describe("formatResourceContents", () => {
  it("renders a text block verbatim", () => {
    const out = formatResourceContents("x://1", {
      contents: [{ uri: "x://1", mimeType: "text/plain", text: "hello world" }],
    });
    expect(out).toContain("hello world");
    expect(out).toContain("text/plain");
  });

  it("truncates extremely large text blocks with a notice", () => {
    const big = "A".repeat(12_000);
    const out = formatResourceContents("x://1", {
      contents: [{ uri: "x://1", text: big }],
    });
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(big.length);
  });

  it("summarizes binary blobs rather than rendering them", () => {
    const out = formatResourceContents("x://1", {
      contents: [{ uri: "x://1", mimeType: "image/png", blob: "AAAA" }],
    });
    expect(out).toContain("binary");
    expect(out).toContain("bytes");
  });
});

describe("formatPromptMessages", () => {
  it("renders role + text content for each message", () => {
    const out = formatPromptMessages("summarize", {
      description: "one-line summary",
      messages: [
        { role: "user", content: { type: "text", text: "Summarize X." } as any },
        { role: "assistant", content: { type: "text", text: "X is …" } as any },
      ],
    });
    expect(out).toContain("summarize");
    expect(out).toContain("one-line summary");
    expect(out).toContain("user");
    expect(out).toContain("assistant");
    expect(out).toContain("Summarize X.");
    expect(out).toContain("X is …");
  });
});

describe("handleMcpBrowseSlash", () => {
  it("list mode: no arg writes a single info row with the list text", async () => {
    const { rows, log } = makeFakeLog();
    await handleMcpBrowseSlash("resource", "", [], log);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("info");
    expect(rows[0]?.text).toMatch(/No resources/);
  });

  it("read mode: unknown URI emits a warning row", async () => {
    const { rows, log } = makeFakeLog();
    await handleMcpBrowseSlash("resource", "mystery://1", [], log);
    expect(rows[0]?.role).toBe("warning");
    expect(rows[0]?.text).toContain("no server exposes resource");
  });

  it("read mode: calls client.readResource and emits the formatted contents", async () => {
    const { rows, log } = makeFakeLog();
    const readResource = vi.fn(async () => ({
      contents: [{ uri: "x://1", text: "hello" }],
    }));
    const fake: McpServerSummary = server({
      label: "a",
      report: {
        protocolVersion: "",
        serverInfo: { name: "a", version: "" },
        capabilities: {},
        tools: { supported: true, items: [] },
        prompts: { supported: false, reason: "" },
        resources: { supported: true, items: [{ uri: "x://1", name: "x1" }] },
      },
      client: { readResource } as unknown as McpClient,
    });
    await handleMcpBrowseSlash("resource", "x://1", [fake], log);
    expect(readResource).toHaveBeenCalledWith("x://1");
    expect(rows[0]?.role).toBe("info");
    expect(rows[0]?.text).toContain("hello");
  });

  it("read mode: surfaces readResource rejection as a warning row", async () => {
    const { rows, log } = makeFakeLog();
    const fake: McpServerSummary = server({
      label: "a",
      report: {
        protocolVersion: "",
        serverInfo: { name: "a", version: "" },
        capabilities: {},
        tools: { supported: true, items: [] },
        prompts: { supported: false, reason: "" },
        resources: { supported: true, items: [{ uri: "x://1", name: "x1" }] },
      },
      client: {
        readResource: vi.fn(async () => {
          throw new Error("server returned -32002 not-found");
        }),
      } as unknown as McpClient,
    });
    await handleMcpBrowseSlash("resource", "x://1", [fake], log);
    expect(rows[0]?.role).toBe("warning");
    expect(rows[0]?.text).toContain("-32002");
  });

  it("prompt mode: calls client.getPrompt and emits messages", async () => {
    const { rows, log } = makeFakeLog();
    const getPrompt = vi.fn(async () => ({
      description: "hi",
      messages: [{ role: "user", content: { type: "text", text: "Hello." } as any }],
    }));
    const fake: McpServerSummary = server({
      label: "a",
      report: {
        protocolVersion: "",
        serverInfo: { name: "a", version: "" },
        capabilities: {},
        tools: { supported: true, items: [] },
        resources: { supported: false, reason: "" },
        prompts: { supported: true, items: [{ name: "greet" }] },
      },
      client: { getPrompt } as unknown as McpClient,
    });
    await handleMcpBrowseSlash("prompt", "greet", [fake], log);
    expect(getPrompt).toHaveBeenCalledWith("greet");
    expect(rows[0]?.role).toBe("info");
    expect(rows[0]?.text).toContain("Hello.");
  });
});
