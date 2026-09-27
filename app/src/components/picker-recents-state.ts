import { createContext, useContext, useSyncExternalStore } from "react";
import {
  EMPTY_PICKER_RECENTS,
  recordPickerRecent,
  type PickerRecentKind,
  type PickerRecents,
} from "../core/picker-recents";
import {
  MemoryPickerRecentsPort,
  type PickerRecentsPort,
} from "../platform/picker-recents";

export class PickerRecentsStore {
  private state: PickerRecents = EMPTY_PICKER_RECENTS;
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly port: PickerRecentsPort) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PickerRecents => this.state;

  load = (): Promise<void> => {
    if (!this.loading) {
      this.loading = this.port.load().then(
        (state) => this.setState(state),
        (cause) => reportPickerRecentsError(cause),
      );
    }
    return this.loading;
  };

  record = (kind: PickerRecentKind, id: string): void => {
    this.writes = this.writes
      .then(() => this.load())
      .then(async () => {
        this.setState(recordPickerRecent(this.state, kind, id));
        try {
          this.setState(await this.port.record(kind, id));
        } catch (cause) {
          reportPickerRecentsError(cause);
        }
      });
  };

  private setState(state: PickerRecents): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

function reportPickerRecentsError(cause: unknown): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("memoka-editor-error", {
      detail: {
        message: `候補の利用履歴を保存できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
    }),
  );
}

export const PickerRecentsContext = createContext<PickerRecentsStore | null>(
  null,
);
const emptyStore = new PickerRecentsStore(new MemoryPickerRecentsPort());

export function usePickerRecents(): {
  readonly state: PickerRecents;
  readonly record: (kind: PickerRecentKind, id: string) => void;
} {
  const store = useContext(PickerRecentsContext) ?? emptyStore;
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return {
    state,
    record:
      store === emptyStore ? () => {} : (kind, id) => store.record(kind, id),
  };
}
