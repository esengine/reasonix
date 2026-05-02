import { describe, expect, it } from "vitest";
import { parseMcpSpec } from "../src/mcp/spec.js";

describe("parseMcpSpec: stdio", () => {
  it("parses a namespaced spec", () => {
    const spec = parseMcpSpec("fs=npx -y @scope/fs /tmp/dir");
    expect(spec.transport).toBe("stdio");
    if (spec.transport !== "stdio") throw new Error("unreachable");
    expect(spec.name).toBe("fs");
    expect(spec.command).toBe("npx");
    expect(spec.args).toEqual(["-y", "@scope/fs", "/tmp/dir"]);
  });

  it("parses an anonymous spec (no name=)", () => {
    const spec = parseMcpSpec("npx -y @scope/fs /tmp/dir");
    expect(spec.transport).toBe("stdio");
    if (spec.transport !== "stdio") throw new Error("unreachable");
    expect(spec.name).toBeNull();
    expect(spec.command).toBe("npx");
    expect(spec.args).toEqual(["-y", "@scope/fs", "/tmp/dir"]);
  });

  it("does NOT treat Windows drive letters as a namespace", () => {
    // `C:\...` matches the colon but NOT the identifier regex [a-zA-Z_]\w* =
    // So it stays anonymous with the whole path as command.
    const spec = parseMcpSpec("C:\\path\\to\\server.exe arg1");
    expect(spec.transport).toBe("stdio");
    if (spec.transport !== "stdio") throw new Error("unreachable");
    expect(spec.name).toBeNull();
    expect(spec.command).toBe("C:\\path\\to\\server.exe");
    expect(spec.args).toEqual(["arg1"]);
  });

  it("handles quoted args in the body", () => {
    const spec = parseMcpSpec('myserver=cmd "path with spaces" --flag');
    if (spec.transport !== "stdio") throw new Error("unreachable");
    expect(spec.name).toBe("myserver");
    expect(spec.command).toBe("cmd");
    expect(spec.args).toEqual(["path with spaces", "--flag"]);
  });

  it("trims leading/trailing whitespace", () => {
    const spec = parseMcpSpec("  fs=npx pkg  ");
    if (spec.transport !== "stdio") throw new Error("unreachable");
    expect(spec.name).toBe("fs");
    expect(spec.command).toBe("npx");
    expect(spec.args).toEqual(["pkg"]);
  });

  it("throws on empty input", () => {
    expect(() => parseMcpSpec("")).toThrow(/empty MCP spec/);
    expect(() => parseMcpSpec("   ")).toThrow(/empty MCP spec/);
  });

  it("throws when name is given but no command follows", () => {
    expect(() => parseMcpSpec("fs=")).toThrow(/has name but no command/);
    expect(() => parseMcpSpec("fs=   ")).toThrow(/has name but no command/);
  });

  it("allows underscores and digits in the name (but not leading digit)", () => {
    const ok = parseMcpSpec("my_fs2=cmd");
    expect(ok.name).toBe("my_fs2");
    // Leading digit → not a valid identifier → whole thing is command
    // (since `2fs` doesn't match identifier regex).
    const s = parseMcpSpec("2fs=cmd");
    if (s.transport !== "stdio") throw new Error("unreachable");
    expect(s.name).toBeNull();
    expect(s.command).toBe("2fs=cmd");
  });

  it("allows hyphens in the name (kebab-case is the MCP ecosystem norm)", () => {
    const spec = parseMcpSpec("sage-wiki=npx -y @scope/sage-wiki");
    if (spec.transport !== "stdio") throw new Error("unreachable");
    expect(spec.name).toBe("sage-wiki");
    expect(spec.command).toBe("npx");
    expect(spec.args).toEqual(["-y", "@scope/sage-wiki"]);
    // Leading hyphen → not a valid identifier → whole thing is command
    const lead = parseMcpSpec("-fs=cmd");
    if (lead.transport !== "stdio") throw new Error("unreachable");
    expect(lead.name).toBeNull();
    expect(lead.command).toBe("-fs=cmd");
  });
});

describe("parseMcpSpec: sse", () => {
  it("parses an anonymous https URL", () => {
    const spec = parseMcpSpec("https://example.com/sse");
    expect(spec.transport).toBe("sse");
    if (spec.transport !== "sse") throw new Error("unreachable");
    expect(spec.name).toBeNull();
    expect(spec.url).toBe("https://example.com/sse");
  });

  it("parses a namespaced http URL (localhost dev)", () => {
    const spec = parseMcpSpec("local=http://127.0.0.1:9000/sse");
    if (spec.transport !== "sse") throw new Error("unreachable");
    expect(spec.name).toBe("local");
    expect(spec.url).toBe("http://127.0.0.1:9000/sse");
  });

  it("is case-insensitive on the scheme", () => {
    const spec = parseMcpSpec("HTTPS://example.com/sse");
    expect(spec.transport).toBe("sse");
  });

  it("does not match ws:// as SSE (falls through to stdio)", () => {
    const spec = parseMcpSpec("ws://example.com/mcp");
    expect(spec.transport).toBe("stdio");
  });
});

describe("parseMcpSpec: streamable-http", () => {
  it("parses an anonymous streamable+https URL and strips the prefix", () => {
    const spec = parseMcpSpec("streamable+https://example.com/mcp");
    expect(spec.transport).toBe("streamable-http");
    if (spec.transport !== "streamable-http") throw new Error("unreachable");
    expect(spec.name).toBeNull();
    expect(spec.url).toBe("https://example.com/mcp");
  });

  it("parses a namespaced streamable+http URL (localhost dev)", () => {
    const spec = parseMcpSpec("local=streamable+http://127.0.0.1:9000/mcp");
    if (spec.transport !== "streamable-http") throw new Error("unreachable");
    expect(spec.name).toBe("local");
    expect(spec.url).toBe("http://127.0.0.1:9000/mcp");
  });

  it("is case-insensitive on the streamable+ prefix", () => {
    const spec = parseMcpSpec("STREAMABLE+HTTPS://example.com/mcp");
    expect(spec.transport).toBe("streamable-http");
  });

  it("plain https without `streamable+` still routes to SSE for back-compat", () => {
    const spec = parseMcpSpec("https://example.com/mcp");
    expect(spec.transport).toBe("sse");
  });
});
