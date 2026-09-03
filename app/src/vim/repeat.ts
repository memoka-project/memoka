import {
  runEditorReplaceCharacter,
  runEditorVimCommand,
  runEditorVimOperator,
  type EditorVimResult,
  type VimEditorView,
  type VimRegister,
} from "./editor-commands";
import type { VimCommand, VimMode, VimOperator } from "./input";
import type { TableActionRepeat } from "../core/table-actions";
import {
  DEFAULT_APPLICATION_KEY_CONFIG,
  type ApplicationKeyConfig,
} from "../core/application-key-config";

export interface VimRepeatDescriptor {
  command: VimCommand;
  operator: VimOperator | null;
  count: number;
  countExplicit: boolean;
  argument?: string;
  tableRectangle?: { width: number; height: number };
  tableAction?: TableActionRepeat;
}

export interface VimRepeatCandidate extends VimRepeatDescriptor {
  mode: VimMode;
}

const immediateRepeatCommands = new Set<VimCommand>([
  "line.delete",
  "line.delete-to-end",
  "line.join",
  "line.join-raw",
  "character.delete",
  "replace.character",
  "put.after",
  "put.before",
]);

function cloneDescriptor(descriptor: VimRepeatDescriptor): VimRepeatDescriptor {
  return {
    command: descriptor.command,
    operator: descriptor.operator,
    count: descriptor.count,
    countExplicit: descriptor.countExplicit,
    argument: descriptor.argument,
    tableRectangle: descriptor.tableRectangle
      ? { ...descriptor.tableRectangle }
      : undefined,
    tableAction: descriptor.tableAction
      ? { ...descriptor.tableAction }
      : undefined,
  };
}

/**
 * Produces a semantic replay payload only for edits that finish in Normal
 * mode. Insert-session changes are deliberately excluded until their inserted
 * Slice can be captured as one descriptor at Esc.
 */
export function createVimRepeatDescriptor(
  candidate: VimRepeatCandidate,
): VimRepeatDescriptor | null {
  if (
    candidate.mode === "visual-block" &&
    candidate.tableRectangle &&
    candidate.operator === null &&
    ["selection.delete", "selection.change", "selection.paste"].includes(
      candidate.command,
    )
  ) {
    return cloneDescriptor(candidate);
  }
  if (candidate.mode !== "normal") return null;
  if (candidate.operator === "delete") {
    return cloneDescriptor(candidate);
  }
  if (candidate.operator !== null) return null;
  if (!immediateRepeatCommands.has(candidate.command)) return null;
  if (candidate.command === "replace.character" && !candidate.argument) {
    return null;
  }
  return cloneDescriptor(candidate);
}

export class VimRepeatStore {
  private current: VimRepeatDescriptor | null = null;

  record(descriptor: VimRepeatDescriptor): void {
    this.current = cloneDescriptor(descriptor);
  }

  read(): VimRepeatDescriptor | null {
    return this.current ? cloneDescriptor(this.current) : null;
  }

  clear(): void {
    this.current = null;
  }
}

export function replayVimRepeat(
  view: VimEditorView,
  descriptor: VimRepeatDescriptor,
  register: VimRegister | null,
  count: number,
  countExplicit: boolean,
  keyConfig: ApplicationKeyConfig = DEFAULT_APPLICATION_KEY_CONFIG,
): EditorVimResult {
  const effectiveCount = countExplicit ? count : descriptor.count;
  if (descriptor.operator) {
    return runEditorVimOperator(
      view,
      descriptor.operator,
      descriptor.command,
      effectiveCount,
    );
  }
  if (descriptor.command === "replace.character" && descriptor.argument) {
    return runEditorReplaceCharacter(view, descriptor.argument, effectiveCount);
  }
  return runEditorVimCommand(
    view,
    descriptor.command,
    "normal",
    register,
    effectiveCount,
    countExplicit || descriptor.countExplicit,
    keyConfig,
  );
}
