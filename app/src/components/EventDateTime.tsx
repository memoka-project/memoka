import { useSyncExternalStore } from "react";
import { formatEventDateTime } from "../core/display-datetime";

// One clock for mounted timestamps, never an App/Editor-wide ticking state.
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}
const snapshot = (): number => now;

export function EventDateTime({ value }: { value: string }) {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const valid = Number.isFinite(Date.parse(value));
  return (
    <time dateTime={valid ? value : undefined}>
      {formatEventDateTime(value, current)}
    </time>
  );
}
