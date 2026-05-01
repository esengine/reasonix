import { useCallback, useEffect, useState } from "preact/hooks";
import { type ApiError, api } from "./api.js";

export interface PollResult<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function usePoll<T = unknown>(path: string, intervalMs = 2000): PollResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await api<T>(path);
      setData(next);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      await refresh();
      if (cancelled) return;
      timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, intervalMs]);

  return { data, error, loading, refresh };
}
