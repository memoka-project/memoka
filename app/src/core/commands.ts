import type { CommitFault } from "./persistence";
import type {
  SectionDepthShiftDirection,
  SectionProperties,
} from "./section-model";
import type { VimMode, WindowSelection } from "./window-state";
import type {
  ApplicationFocusOwner,
  SidebarSide,
  SidebarUpdateInput,
  SplitDirection,
  UtilityBufferKind,
  WindowFocusDirection,
} from "./application-state";

export type CoreCommandSource = "ui" | "editor" | "internal";

export interface CoreCommandPayloads {
  "note.create_root": {
    noteId: string;
    createdAt: string;
    windowId: string;
    fault?: CommitFault;
  };
  "note.create_child": {
    noteId: string;
    parentNoteId: string;
    createdAt: string;
    windowId: string;
    fault?: CommitFault;
  };
  "note.create_sibling_after": {
    noteId: string;
    siblingNoteId: string;
    createdAt: string;
    windowId: string;
    fault?: CommitFault;
  };
  "note.create": {
    noteId: string;
    title: string;
    createdAt: string;
    parentNoteId?: string | null;
    afterNoteId: string | null;
    windowId?: string;
    fault?: CommitFault;
  };
  "note.open": {
    noteId: string;
    windowId: string;
    fault?: CommitFault;
  };
  "note.open_help": {
    windowId: string;
    newNoteId: string;
    synchronizedAt: string;
    fault?: CommitFault;
  };
  "note.rename": {
    noteId: string;
    title: string;
    updatedAt: string;
    fault?: CommitFault;
  };
  "note.reorder": {
    noteId: string;
    direction: "up" | "down";
    fault?: CommitFault;
  };
  "note.move": {
    noteId: string;
    targetParentId: string | null;
    placement:
      { kind: "first" } | { kind: "last" } | { kind: "after"; noteId: string };
    fault?: CommitFault;
  };
  "section.update_properties": {
    noteId: string;
    sectionId: string;
    properties: Partial<SectionProperties>;
    updatedAt: string;
    fault?: CommitFault;
  };
  "section.shift_depth": {
    noteId: string;
    boundarySectionId: string;
    sectionIds: string[];
    direction: SectionDepthShiftDirection;
    updatedAt: string;
    fault?: CommitFault;
  };
  "note.move_to_trash": {
    noteId: string;
    deletedAt: string;
    fault?: CommitFault;
  };
  "note.restore_from_trash": {
    noteId: string;
    restoredAt: string;
    fault?: CommitFault;
  };
  "note.replace_text": {
    noteId: string;
    text: string;
    fault?: CommitFault;
  };
  "note.commit_editor_update": {
    noteId: string;
    update: Uint8Array;
    sectionCatalogChanged: boolean;
  };
  "note.repair_section_identity": {
    noteId: string;
    update: Uint8Array;
    repairedSectionIds: string[];
    repairedBlockIds: string[];
  };
  "note.migrate_schema": {
    noteId: string;
    update: Uint8Array;
    fromVersion: number;
    toVersion: number;
  };
  "note.compact_snapshot": {
    noteId: string;
    expectedRevision: number;
    fault?: CommitFault;
  };
  "window.update_view": {
    windowId: string;
    update: {
      mode?: VimMode;
      selection?: WindowSelection | null;
      scrollTop?: number;
    };
    noteId?: string;
    activeSectionId?: string | null;
    fault?: CommitFault;
  };
  "window.focus_section": {
    windowId: string;
    noteId: string;
    sectionId: string;
    selection?: { anchor: number; head: number } | null;
    fault?: CommitFault;
  };
  "window.split": {
    targetWindowId: string;
    newWindowId: string;
    splitId: string;
    direction: SplitDirection;
    fault?: CommitFault;
  };
  "window.focus": {
    windowId: string;
    fault?: CommitFault;
  };
  "window.focus_direction": {
    windowId: string;
    direction: WindowFocusDirection;
    fault?: CommitFault;
  };
  "window.close": {
    windowId: string;
    fault?: CommitFault;
  };
  "window.only": {
    windowId: string;
    fault?: CommitFault;
  };
  "tab.create": {
    tabId: string;
    windowId: string;
    fault?: CommitFault;
  };
  "tab.switch": {
    tabId: string;
    fault?: CommitFault;
  };
  "tab.cycle": {
    direction: "next" | "previous";
    fault?: CommitFault;
  };
  "tab.close": {
    tabId: string;
    fault?: CommitFault;
  };
  "buffer.close": {
    bufferId: string;
    fault?: CommitFault;
  };
  "sidebar.update": SidebarUpdateInput & {
    fault?: CommitFault;
  };
}

export interface CoreCommandResults {
  "note.create_root": { noteId: string };
  "note.create_child": { noteId: string };
  "note.create_sibling_after": { noteId: string };
  "note.create": { noteId: string };
  "note.open": { noteId: string; windowId: string };
  "note.open_help": {
    noteId: string;
    windowId: string;
    created: boolean;
    restored: boolean;
  };
  "note.rename": { noteId: string };
  "note.reorder": { noteId: string; changed: boolean };
  "note.move": { noteId: string; changed: boolean };
  "section.update_properties": { noteId: string; sectionId: string };
  "section.shift_depth": {
    noteId: string;
    changed: boolean;
    affectedSectionIds: string[];
  };
  "note.move_to_trash": {
    noteId: string;
    trashedNoteIds: string[];
    fallbackNoteId: string | null;
  };
  "note.restore_from_trash": { noteId: string; restoredNoteIds: string[] };
  "note.replace_text": { noteId: string };
  "note.commit_editor_update": { noteId: string; revision: number };
  "note.repair_section_identity": {
    noteId: string;
    revision: number;
    repairedSectionIds: string[];
    repairedBlockIds: string[];
  };
  "note.migrate_schema": {
    noteId: string;
    revision: number;
    fromVersion: number;
    toVersion: number;
  };
  "note.compact_snapshot": { noteId: string; revision: number };
  "window.update_view": { windowId: string };
  "window.focus_section": { windowId: string; sectionId: string };
  "window.split": {
    windowId: string;
    splitId: string;
  };
  "window.focus": {
    windowId: string;
    changed: boolean;
  };
  "window.focus_direction": {
    windowId: string;
    changed: boolean;
  };
  "window.close": {
    windowId: string;
    activeWindowId: string;
  };
  "window.only": {
    windowId: string;
    closedWindowIds: string[];
    changed: boolean;
  };
  "tab.create": {
    tabId: string;
    windowId: string;
  };
  "tab.switch": {
    tabId: string;
    windowId: string;
    changed: boolean;
  };
  "tab.cycle": {
    tabId: string;
    windowId: string;
    changed: boolean;
  };
  "tab.close": {
    tabId: string;
    activeTabId: string;
    activeWindowId: string;
  };
  "buffer.close": {
    bufferId: string;
    noteId: string | null;
    emptiedWindowIds: string[];
    releasedNoteDoc: boolean;
  };
  "sidebar.update": {
    side: SidebarSide;
    visible: boolean;
    utility: UtilityBufferKind;
    focusOwner: ApplicationFocusOwner;
    changed: boolean;
  };
}

export type CoreCommandName = keyof CoreCommandPayloads;

export interface CoreCommandEnvelope<Name extends CoreCommandName> {
  name: Name;
  payload: CoreCommandPayloads[Name];
  operationId: string;
  source: CoreCommandSource;
}

export interface CoreCommandLogEntry {
  operationId: string;
  name: CoreCommandName;
  source: CoreCommandSource;
  status: "started" | "committed" | "failed";
  error?: string;
}

type CoreCommandHandler<Name extends CoreCommandName> = (
  envelope: CoreCommandEnvelope<Name>,
) => Promise<CoreCommandResults[Name]>;

type UntypedHandler = (
  envelope: CoreCommandEnvelope<CoreCommandName>,
) => Promise<CoreCommandResults[CoreCommandName]>;

export class CoreCommandRegistry {
  readonly log: CoreCommandLogEntry[] = [];
  private handlers = new Map<CoreCommandName, UntypedHandler>();

  register<Name extends CoreCommandName>(
    name: Name,
    handler: CoreCommandHandler<Name>,
  ): void {
    if (this.handlers.has(name)) {
      throw new Error(`Core command is already registered: ${name}`);
    }
    this.handlers.set(name, handler as unknown as UntypedHandler);
  }

  async execute<Name extends CoreCommandName>(
    envelope: CoreCommandEnvelope<Name>,
  ): Promise<CoreCommandResults[Name]> {
    const handler = this.handlers.get(envelope.name);
    if (!handler) {
      throw new Error(`Core command is unavailable: ${envelope.name}`);
    }
    this.log.push({
      operationId: envelope.operationId,
      name: envelope.name,
      source: envelope.source,
      status: "started",
    });
    try {
      const result = await handler(
        envelope as CoreCommandEnvelope<CoreCommandName>,
      );
      this.log.push({
        operationId: envelope.operationId,
        name: envelope.name,
        source: envelope.source,
        status: "committed",
      });
      return result as CoreCommandResults[Name];
    } catch (error) {
      this.log.push({
        operationId: envelope.operationId,
        name: envelope.name,
        source: envelope.source,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
