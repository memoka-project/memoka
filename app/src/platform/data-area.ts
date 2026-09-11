import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface DataAreaStatus {
  readonly selected: boolean;
  readonly path: string | null;
}

export interface DataAreaPort {
  status(): Promise<DataAreaStatus>;
  chooseDirectory(): Promise<string | null>;
  prepareNew(path: string): Promise<string>;
  activate(path: string): Promise<DataAreaStatus>;
}

export class MemoryDataAreaPort implements DataAreaPort {
  private current: DataAreaStatus;
  private readonly existing = new Set<string>();

  constructor(
    selected = true,
    private nextSelection: string | null = "memory://workspace",
  ) {
    this.current = {
      selected,
      path: selected ? "memory://workspace" : null,
    };
    if (this.current.path) this.existing.add(this.current.path);
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
    };
    this.existing.add(path);
    return { ...this.current };
  }

  async prepareNew(path: string): Promise<string> {
    if (!path || this.existing.has(path))
      throw new Error("新しいWorkspaceには空のディレクトリを選択してください");
    this.existing.add(path);
    return path;
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

  prepareNew(path: string): Promise<string> {
    return invoke("data_area_prepare_new", { path });
  }
}

export function createDefaultDataAreaPort(): DataAreaPort {
  const tauri =
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);
  return tauri ? new TauriDataAreaPort() : new MemoryDataAreaPort();
}
