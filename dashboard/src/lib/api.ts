export const TOKEN: string =
  document.querySelector('meta[name="reasonix-token"]')?.getAttribute("content") ?? "";

export const MODE: "standalone" | "attached" =
  (document.querySelector('meta[name="reasonix-mode"]')?.getAttribute("content") as
    | "standalone"
    | "attached"
    | null) ?? "standalone";

export interface ApiOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ApiError extends Error {
  status: number;
  body: unknown;
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const url = `/api${path}${path.includes("?") ? "&" : "?"}token=${TOKEN}`;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  headers["X-Reasonix-Token"] = TOKEN;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text };
  }
  if (!res.ok) {
    const errMsg =
      (parsed as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    const err = new Error(errMsg) as ApiError;
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed as T;
}
