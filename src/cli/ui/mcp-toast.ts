/** One-line warn toast emitted when an MCP server's p95 crosses the slow threshold (design §32). */

export interface McpSlowToast {
  name: string;
  p95Ms: number;
  sampleSize: number;
}

export function formatMcpSlowToast(t: McpSlowToast): string {
  const seconds = (t.p95Ms / 1000).toFixed(1);
  return `⚠ MCP \`${t.name}\` slow · ${seconds}s p95 over the last ${t.sampleSize} calls`;
}
