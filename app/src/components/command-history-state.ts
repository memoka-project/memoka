import { createContext, useContext, useSyncExternalStore } from "react";
import { recordCommandHistory } from "../core/command-history";
import {
  MemoryCommandHistoryPort,
  type CommandHistoryPort,
} from "../platform/command-history";

export class CommandHistoryStore {
  private entries: readonly string[] = [];
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly port: CommandHistoryPort) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): readonly string[] => this.entries;
  load = (): Promise<void> => {
    if (!this.loading) {
      this.loading = this.port.load().then(
        (entries) => this.setEntries(entries),
        (cause) => reportCommandHistoryError(cause),
      );
    }
    return this.loading;
  };
  record = (value: string): Promise<void> => {
    if (!value.trim()) return Promise.resolve();
    this.writes = this.writes.then(async () => {
      await this.load();
      this.setEntries(recordCommandHistory(this.entries, value));
      try {
        this.setEntries(await this.port.record(value));
      } catch (cause) {
        reportCommandHistoryError(cause);
      }
    });
    return this.writes;
  };

  private setEntries(entries: readonly string[]): void {
    this.entries = entries;
    for (const listener of this.listeners) listener();
  }
}

function reportCommandHistoryError(cause: unknown): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("memoka-editor-error", {
      detail: {
        message: `Command履歴を保存できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
    }),
  );
}

export const CommandHistoryContext = createContext<CommandHistoryStore | null>(
  null,
);
const emptyStore = new CommandHistoryStore(new MemoryCommandHistoryPort());

export function useCommandHistory(): {
  readonly entries: readonly string[];
  readonly record: (value: string) => Promise<void>;
} {
  const store = useContext(CommandHistoryContext) ?? emptyStore;
  const entries = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return {
    entries,
    record: store === emptyStore ? async () => {} : store.record,
  };
}
