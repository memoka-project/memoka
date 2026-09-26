import { invoke } from "@tauri-apps/api/core";
import {
  EMPTY_PICKER_RECENTS,
  readPickerRecents,
  recordPickerRecent,
  type PickerRecentKind,
  type PickerRecents,
} from "../core/picker-recents";

export interface PickerRecentsPort {
  load(): Promise<PickerRecents>;
  record(kind: PickerRecentKind, id: string): Promise<PickerRecents>;
}

export class MemoryPickerRecentsPort implements PickerRecentsPort {
  private state: PickerRecents = EMPTY_PICKER_RECENTS;

  async load(): Promise<PickerRecents> {
    return this.state;
  }

  async record(kind: PickerRecentKind, id: string): Promise<PickerRecents> {
    this.state = recordPickerRecent(this.state, kind, id);
    return this.state;
  }
}

export function createDefaultPickerRecentsPort(): PickerRecentsPort {
  if (
    typeof window === "undefined" ||
    !("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>))
  ) {
    return new MemoryPickerRecentsPort();
  }
  return {
    load: async () => readPickerRecents(await invoke("picker_recents_load")),
    record: async (kind, id) =>
      readPickerRecents(await invoke("picker_recents_record", { kind, id })),
  };
}
