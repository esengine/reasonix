import htm from "htm";
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";

const html = htm.bind(h);

export const appBus = new EventTarget();
export const toastBus = new EventTarget();

export type ToastKind = "info" | "success" | "warn" | "error";

export function showToast(text: string, kind: ToastKind = "info", ttl = 3000): void {
  toastBus.dispatchEvent(new CustomEvent("toast", { detail: { text, kind, ttl } }));
}

export interface ErrorReport {
  error: unknown;
  source: string;
  info?: string;
  ts: number;
}

export function reportAppError(error: unknown, source: string, info?: string): void {
  console.error(`[reasonix dashboard] ${source}:`, error, info);
  appBus.dispatchEvent(
    new CustomEvent("error", { detail: { error, source, info, ts: Date.now() } }),
  );
}

window.addEventListener("error", (ev) => {
  if (!ev.error) return;
  reportAppError(ev.error, "window", ev.message);
});

window.addEventListener("unhandledrejection", (ev) => {
  reportAppError(ev.reason, "promise");
});

interface Toast {
  id: string;
  text: string;
  kind: ToastKind;
  ttl: number;
}

export function ToastStack() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    const onToast = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as Omit<Toast, "id">;
      const id = `${Date.now()}-${Math.random()}`;
      const t: Toast = { id, ...detail };
      setToasts((prev) => [...prev, t]);
      setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), t.ttl);
    };
    toastBus.addEventListener("toast", onToast);
    return () => toastBus.removeEventListener("toast", onToast);
  }, []);
  if (toasts.length === 0) return null;
  return html`
    <div class="toast-stack">
      ${toasts.map((t) => html`<div key=${t.id} class="toast ${t.kind}">${t.text}</div>`)}
    </div>
  `;
}
