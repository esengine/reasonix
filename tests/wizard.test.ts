/** Wizard data-transform — buildSpec → parseMcpSpec round-trip; bugs here = silent config-save failures. */

import { describe, expect, it } from "vitest";
import { buildSpec } from "../src/cli/ui/Wizard.js";
import { parseMcpSpec } from "../src/mcp/spec.js";

describe("Wizard.buildSpec → parseMcpSpec round-trip", () => {
  it("builds a filesystem spec the parser accepts", () => {
    const spec = buildSpec("filesystem", { filesystem: "/tmp/safe" });
    expect(spec).toBe("filesystem=npx -y @modelcontextprotocol/server-filesystem /tmp/safe");
    const parsed = parseMcpSpec(spec);
    if (parsed.transport !== "stdio") throw new Error("expected stdio");
    expect(parsed.name).toBe("filesystem");
    expect(parsed.command).toBe("npx");
    expect(parsed.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/tmp/safe"]);
  });

  it("omits the trailing userArg when the catalog entry needs none", () => {
    const spec = buildSpec("memory", {});
    expect(spec).toBe("memory=npx -y @modelcontextprotocol/server-memory");
    const parsed = parseMcpSpec(spec);
    expect(parsed.name).toBe("memory");
  });

  it("quotes directory paths that contain spaces", () => {
    const spec = buildSpec("filesystem", { filesystem: "/Users/me/My Documents" });
    // Inside quotes, the parser should re-join the path as a single arg.
    const parsed = parseMcpSpec(spec);
    if (parsed.transport !== "stdio") throw new Error("expected stdio");
    expect(parsed.args.at(-1)).toBe("/Users/me/My Documents");
  });

  it("returns the name bare when the catalog entry is unknown", () => {
    // Defensive: if someone manually edits config.json and the wizard
    // sees an unfamiliar name on re-run, we degrade gracefully rather
    // than throwing.
    expect(buildSpec("not-in-catalog", {})).toBe("not-in-catalog");
  });
});
