import { Slice, type Schema } from "@tiptap/pm/model";
import type { VimRegister } from "./editor-commands";

type VimRegisterListener = () => void;

function cloneRegister(
  register: VimRegister,
  targetSchema?: Schema,
): VimRegister {
  const cloneSlice = (slice: Slice): Slice =>
    targetSchema ? Slice.fromJSON(targetSchema, slice.toJSON()) : slice;

  switch (register.kind) {
    case "text":
      return {
        ...register,
        slice: register.slice ? cloneSlice(register.slice) : undefined,
      };
    case "block-lines":
      return {
        ...register,
        blockAttrs: { ...register.blockAttrs },
        slice: register.slice ? cloneSlice(register.slice) : undefined,
      };
    case "structure":
      return {
        ...register,
        nodeNames: [...register.nodeNames],
        slice: cloneSlice(register.slice),
      };
    case "section":
      return {
        ...register,
        sectionIds: [...register.sectionIds],
        slice: cloneSlice(register.slice),
      };
    case "table-cells":
      return {
        ...register,
        alignments: [...register.alignments],
        slice: cloneSlice(register.slice),
      };
  }
}

/**
 * Ephemeral Workspace-session ownership for the unnamed Vim register.
 * Structural slices are rebuilt against the destination editor schema so a
 * value yanked in one Window/NoteDoc can be put safely in another.
 */
export class VimRegisterStore {
  private current: VimRegister | null = null;
  private readonly listeners = new Set<VimRegisterListener>();

  read(targetSchema?: Schema): VimRegister | null {
    return this.current ? cloneRegister(this.current, targetSchema) : null;
  }

  set(register: VimRegister): void {
    this.current = cloneRegister(register);
    for (const listener of this.listeners) listener();
  }

  clear(): void {
    if (!this.current) return;
    this.current = null;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: VimRegisterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
