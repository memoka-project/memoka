import { invoke } from "@tauri-apps/api/core";
import {
  readCommandHistory,
  recordCommandHistory,
} from "../core/command-history";

export interface CommandHistoryPort {
  load(): Promise<readonly string[]>;
  record(value: string): Promise<readonly string[]>;
}

export class MemoryCommandHistoryPort implements CommandHistoryPort {
  private entries: readonly string[] = [];

  async load(): Promise<readonly string[]> {
    return this.entries;
  }

  async record(value: string): Promise<readonly string[]> {
    this.entries = recordCommandHistory(this.entries, value);
    return this.entries;
  }
}

export function createDefaultCommandHistoryPort(): CommandHistoryPort {
  if (
    typeof window === "undefined" ||
    !("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>))
  ) {
    return new MemoryCommandHistoryPort();
  }
  return {
    load: async () => readCommandHistory(await invoke("command_history_load")),
    record: async (value) =>
      readCommandHistory(await invoke("command_history_record", { value })),
  };
}
