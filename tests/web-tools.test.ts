import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import {
  formatSearchResults,
  htmlToText,
  parseMojeekResults,
  registerWebTools,
  webFetch,
  webSearch,
} from "../src/tools/web.js";

describe("htmlToText", () => {
  it("strips script/style/nav/footer and preserves paragraph breaks", () => {
    const html = `
      <html><head><title>x</title><style>body{color:red}</style></head>
      <body>
        <nav><a>skip</a></nav>
        <p>Hello <strong>world</strong>.</p>
        <p>Second paragraph.</p>
        <script>evil()</script>
        <footer>fine print</footer>
      </body></html>
    `;
    const out = htmlToText(html);
    expect(out).toContain("Hello world.");
    expect(out).toContain("Second paragraph.");
    expect(out).not.toContain("evil");
    expect(out).not.toContain("skip");
    expect(out).not.toContain("fine print");
    expect(out).not.toContain("color:red");
    expect(out).toMatch(/Hello world\.\n\nSecond paragraph\./);
  });

  it("decodes the common entities", () => {
    expect(htmlToText("<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>")).toContain('a & b <c> "d"');
  });

  it("collapses whitespace runs but keeps paragraph breaks", () => {
    const out = htmlToText("<p>one    two</p><p>three</p>");
    expect(out).toBe("one two\n\nthree");
  });
});

describe("parseMojeekResults", () => {
  // Fixture mirrors the shape Mojeek actually returns as of April 2026.
  const sampleHtml = `
    <ul class="results">
      <li>
        <a title="https://example.com/a" href="https://example.com/a" class="ob">
          <p class="i"><span class="url">https://example.com</span></p>
        </a>
        <h2>
          <a class="title" title="https://example.com/a" href="https://example.com/a">
            Flutter 3.19 release notes
          </a>
        </h2>
        <p class="s">
          Flutter 3.19 introduces <strong>new Navigator</strong>&nbsp;APIs &amp; more.
        </p>
      </li>
      <li>
        <a href="https://medium.com/flutter/x" class="ob">
          <p class="i"><span class="url">medium.com</span></p>
        </a>
        <h2>
          <a class="title" href="https://medium.com/flutter/x">What's new in 3.19</a>
        </h2>
        <p class="s">An overview post.</p>
      </li>
    </ul>
  `;

  it("extracts title/url/snippet from the expected markup", () => {
    const items = parseMojeekResults(sampleHtml);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: "Flutter 3.19 release notes",
      url: "https://example.com/a",
      snippet: "Flutter 3.19 introduces new Navigator APIs & more.",
    });
    expect(items[1]).toEqual({
      title: "What's new in 3.19",
      url: "https://medium.com/flutter/x",
      snippet: "An overview post.",
    });
  });

  it("returns empty on markup that doesn't match the expected shape", () => {
    expect(parseMojeekResults("<html><body>nothing here</body></html>")).toEqual([]);
  });

  it("tolerates attribute-order swaps (href before class)", () => {
    const html = `
      <a href="https://example.com/z" class="title">Title Z</a>
      <p class="s">Snippet Z.</p>
    `;
    const items = parseMojeekResults(html);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      title: "Title Z",
      url: "https://example.com/z",
      snippet: "Snippet Z.",
    });
  });

  it("handles a title with no snippet sibling (empty snippet)", () => {
    const html = `<a class="title" href="https://example.com/s">Solo</a>`;
    const items = parseMojeekResults(html);
    expect(items).toHaveLength(1);
    expect(items[0]?.snippet).toBe("");
  });
});

describe("webSearch", () => {
  const twoResultsHtml = `
    <a class="title" href="https://example.com/a">A</a>
    <p class="s">snippet A</p>
    <a class="title" href="https://example.com/b">B</a>
    <p class="s">snippet B</p>`;

  it("GETs Mojeek with a browser UA and query string", async () => {
    const captured: { url: string; method: string; ua: string } = { url: "", method: "", ua: "" };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      captured.ua = headers["User-Agent"] ?? "";
      return new Response(twoResultsHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as unknown as typeof fetch;
    try {
      const out = await webSearch("flutter 3.19", { topK: 2 });
      expect(captured.url).toContain("mojeek.com/search");
      expect(captured.url).toContain("q=flutter%203.19");
      expect(captured.method).toBe("GET");
      expect(captured.ua).toMatch(/Mozilla\/5.0/);
      expect(out).toHaveLength(2);
      expect(out[0]?.title).toBe("A");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("clamps topK to [1, 10]", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response(twoResultsHtml, { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      const outMax = await webSearch("x", { topK: 99 });
      expect(outMax.length).toBeLessThanOrEqual(10);
      const outMin = await webSearch("x", { topK: 0 });
      expect(outMin.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws on non-2xx", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("blocked", { status: 429 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q")).rejects.toThrow(/web_search 429/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns [] on a legitimately empty 'No results' page", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><body>Your search did not match any documents.</body></html>", {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    try {
      const out = await webSearch("zzyzx nothing here");
      expect(out).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces a clear error on an anti-bot interstitial", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html>Please solve the captcha to continue.</html>", { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q")).rejects.toThrow(/anti-bot|rate-limited|blocked/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces a diagnostic error when the response looks like neither empty-nor-results", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><body>totally unexpected shape</body></html>", { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q")).rejects.toThrow(/doesn't look like a real empty page/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("formatSearchResults", () => {
  it("renders a query header + numbered list", () => {
    const out = formatSearchResults("hello", [
      { title: "One", url: "https://one", snippet: "first" },
      { title: "Two", url: "https://two", snippet: "second" },
    ]);
    expect(out).toMatch(/query: hello/);
    expect(out).toMatch(/results \(2\)/);
    expect(out).toMatch(/1\. One\n\s+https:\/\/one\n\s+first/);
    expect(out).toMatch(/2\. Two/);
  });
});

describe("registerWebTools", () => {
  it("registers web_search and web_fetch", () => {
    const registry = new ToolRegistry();
    registerWebTools(registry);
    expect(registry.size).toBe(2);
  });

  it("web_fetch refuses non-http(s) urls", async () => {
    const registry = new ToolRegistry();
    registerWebTools(registry);
    const out = await registry.dispatch("web_fetch", JSON.stringify({ url: "file:///etc/passwd" }));
    expect(out).toMatch(/must start with http/);
  });
});

describe("webFetch", () => {
  it("extracts title + body text from an html response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          "<html><head><title>Demo</title></head><body><p>Hello world.</p></body></html>",
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
        ),
    ) as unknown as typeof fetch;
    try {
      const page = await webFetch("https://example.com/demo");
      expect(page.title).toBe("Demo");
      expect(page.text).toContain("Hello world.");
      expect(page.text).not.toContain("<title>");
      expect(page.truncated).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("truncates long pages and flags the result", async () => {
    const originalFetch = globalThis.fetch;
    const big = `<html><body><p>${"a".repeat(50_000)}</p></body></html>`;
    globalThis.fetch = vi.fn(
      async () => new Response(big, { status: 200, headers: { "Content-Type": "text/html" } }),
    ) as unknown as typeof fetch;
    try {
      const page = await webFetch("https://example.com/big", { maxChars: 1000 });
      expect(page.truncated).toBe(true);
      expect(page.text).toMatch(/\[… truncated \d+ chars …\]$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces non-2xx as a thrown error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 404 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webFetch("https://example.com/missing")).rejects.toThrow(/web_fetch 404/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
