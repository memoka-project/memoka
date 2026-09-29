import { Slice, type Schema } from "@tiptap/pm/model";
import type { VimRegister } from "./editor-commands";

type VimRegisterListener = () => void;

export type VimRegisterName =
  | '"'
  | "+"
  | "*"
  | "_"
  | `${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | LowercaseLetter;
type LowercaseLetter =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";

export function isVimRegisterName(value: string): value is VimRegisterName {
  return /^["0-9a-z+*_]$/u.test(value);
}

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
 * Ephemeral Workspace-session ownership for Vim registers.
 * Structural slices are rebuilt against the destination editor schema so a
 * value yanked in one Window/NoteDoc can be put safely in another.
 */
export class VimRegisterStore {
  private current: VimRegister | null = null;
  private readonly numbered: (VimRegister | null)[] = Array(10).fill(null);
  private readonly named = new Map<string, VimRegister>();
  private readonly listeners = new Set<VimRegisterListener>();

  read(targetSchema?: Schema, name: VimRegisterName = '"'): VimRegister | null {
    const value =
      name === '"'
        ? this.current
        : /^[0-9]$/u.test(name)
          ? this.numbered[Number(name)]
          : this.named.get(name);
    return value ? cloneRegister(value, targetSchema) : null;
  }

  record(
    register: VimRegister,
    operation: "yank" | "delete",
    target: VimRegisterName | null = null,
  ): void {
    if (target === "_") return;
    const value = cloneRegister(register);
    this.current = value;
    if (operation === "yank") {
      this.numbered[0] = value;
    } else {
      for (let index = 9; index > 1; index -= 1)
        this.numbered[index] = this.numbered[index - 1];
      this.numbered[1] = value;
    }
    if (target && /^[0-9]$/u.test(target))
      this.numbered[Number(target)] = value;
    else if (target && /^[a-z]$/u.test(target)) this.named.set(target, value);
    this.notify();
  }

  set(register: VimRegister): void {
    this.current = cloneRegister(register);
    this.notify();
  }

  clear(): void {
    if (!this.current) return;
    this.current = null;
    this.notify();
  }

  clearNamed(name: VimRegisterName): void {
    if (name === '"') return this.clear();
    if (/^[0-9]$/u.test(name)) this.numbered[Number(name)] = null;
    else this.named.delete(name);
    this.notify();
  }

  subscribe(listener: VimRegisterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
