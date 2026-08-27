import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface DataAreaStatus {
  readonly selected: boolean;
  readonly path: string | null;
  readonly mirrorNeedsRepair: boolean;
}

export interface DataAreaPort {
  status(): Promise<DataAreaStatus>;
  chooseDirectory(): Promise<string | null>;
  activate(path: string): Promise<DataAreaStatus>;
}

export class MemoryDataAreaPort implements DataAreaPort {
  private current: DataAreaStatus;

  constructor(
    selected = true,
    private nextSelection: string | null = "memory://workspace",
  ) {
    this.current = {
      selected,
      path: selected ? "memory://workspace" : null,
      mirrorNeedsRepair: false,
    };
  }

  async status(): Promise<DataAreaStatus> {
    return { ...this.current };
  }

  async chooseDirectory(): Promise<string | null> {
    return this.nextSelection;
  }

  async activate(path: string): Promise<DataAreaStatus> {
    if (!path) throw new Error("Workspace data area path is empty");
    this.current = {
      selected: true,
      path,
      mirrorNeedsRepair: false,
    };
    return { ...this.current };
  }

  setNextSelection(path: string | null): void {
    this.nextSelection = path;
  }
}

class TauriDataAreaPort implements DataAreaPort {
  status(): Promise<DataAreaStatus> {
    return invoke("data_area_status");
  }

  async chooseDirectory(): Promise<string | null> {
    const selected = await open({
      title: "Memoka Workspaceデータ領域を選択",
      directory: true,
      multiple: false,
    });
    return typeof selected === "string" ? selected : null;
  }

  activate(path: string): Promise<DataAreaStatus> {
    return invoke("data_area_activate", { path });
  }
}

export function createDefaultDataAreaPort(): DataAreaPort {
  const tauri =
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);
  return tauri ? new TauriDataAreaPort() : new MemoryDataAreaPort();
}
