import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { createUuidV7 } from "./ids";
import {
  noteDisplayTitle,
  type NoteBlock,
  type NoteMetadata,
  type TableRowBlock,
} from "./documents";
import { formatDisplayDateTime } from "./display-datetime";

/** A private, transient NoteDoc identity. It is never a Workspace Note ID. */
export const ALL_NOTES_DOCUMENT_ID = "00000000-0000-7000-8000-000000000001";
export const ALL_NOTES_TITLE = "すべてのノート";

export interface AllNotesRow {
  readonly noteId: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface AllNotesCaret {
  readonly noteId: string | null;
  readonly column: "title" | "updatedAt";
  readonly offset: number;
}

export function allNotesRows(notes: readonly NoteMetadata[]): AllNotesRow[] {
  return notes
    .filter((note) => !note.deletedAt)
    .map((note) => ({
      noteId: note.noteId,
      title: noteDisplayTitle(note.title),
      updatedAt: note.updatedAt,
    }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt);
      const rightTime = Date.parse(right.updatedAt);
      const byTime =
        (Number.isFinite(rightTime) ? rightTime : -Infinity) -
        (Number.isFinite(leftTime) ? leftTime : -Infinity);
      return byTime || left.noteId.localeCompare(right.noteId);
    });
}

export class AllNotesTableProjection {
  private readonly rowIds = new Map<string, string>();
  private readonly noteIds = new Map<string, string>();
  private readonly blockIds = new Map<string, string>();

  rowNoteId(rowId: string): string | null {
    return this.noteIds.get(rowId) ?? null;
  }

  blocks(rows: readonly AllNotesRow[]): readonly NoteBlock[] {
    const header: TableRowBlock = {
      type: "tableRow",
      blockId: this.id("header-row"),
      children: [
        this.cell("header-title", "tableHeader", "ノート名"),
        this.cell("header-updated", "tableHeader", "最終更新日時"),
      ],
    };
    const body = rows.map((row): TableRowBlock => {
      let rowId = this.rowIds.get(row.noteId);
      if (!rowId) {
        rowId = createUuidV7();
        this.rowIds.set(row.noteId, rowId);
        this.noteIds.set(rowId, row.noteId);
      }
      return {
        type: "tableRow",
        blockId: rowId,
        children: [
          {
            type: "tableCell",
            blockId: this.id(`${row.noteId}:title-cell`),
            children: [
              {
                type: "paragraph",
                blockId: this.id(`${row.noteId}:title-text`),
                content: [
                  {
                    type: "internalSectionLink",
                    text: row.title,
                    targetSectionId: row.noteId,
                  },
                ],
              },
            ],
          },
          this.cell(
            `${row.noteId}:updated`,
            "tableCell",
            formatDisplayDateTime(row.updatedAt, "minute"),
          ),
        ],
      };
    });
    return [
      { type: "table", blockId: this.id("table"), children: [header, ...body] },
    ];
  }

  private id(key: string): string {
    let id = this.blockIds.get(key);
    if (!id) {
      id = createUuidV7();
      this.blockIds.set(key, id);
    }
    return id;
  }

  private cell(
    key: string,
    type: "tableCell" | "tableHeader",
    text: string,
  ): TableRowBlock["children"][number] {
    return {
      type,
      blockId: this.id(`${key}:cell`),
      children: [
        {
          type: "paragraph",
          blockId: this.id(`${key}:text`),
          content: [{ type: "text", text }],
        },
      ],
    };
  }
}

export function allNotesCaretAt(
  doc: ProseMirrorNode,
  position: number,
  projection: AllNotesTableProjection,
): AllNotesCaret {
  const $position = doc.resolve(
    Math.max(0, Math.min(position, doc.content.size)),
  );
  let rowId: string | null = null;
  let column: AllNotesCaret["column"] = "title";
  let offset = 0;
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    const node = $position.node(depth);
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
      column = $position.index(depth - 1) === 1 ? "updatedAt" : "title";
      offset = Math.max(0, position - $position.start(depth) - 1);
    }
    if (node.type.name === "tableRow") {
      rowId = String(node.attrs.blockId ?? "");
      break;
    }
  }
  return { noteId: rowId ? projection.rowNoteId(rowId) : null, column, offset };
}

export function allNotesCaretPosition(
  doc: ProseMirrorNode,
  caret: AllNotesCaret,
  projection: AllNotesTableProjection,
): number {
  let header = 1;
  let matched: number | null = null;
  doc.descendants((node, position) => {
    if (node.type.name !== "tableRow") return true;
    const noteId = projection.rowNoteId(String(node.attrs.blockId ?? ""));
    const column = caret.column === "updatedAt" ? 1 : 0;
    const cell = node.maybeChild(column);
    if (!cell) return false;
    const paragraph = cell.firstChild;
    const textStart =
      position + 3 + (column === 1 ? node.child(0).nodeSize : 0);
    if (noteId === null) header = textStart;
    if (noteId === caret.noteId && matched === null) {
      matched =
        textStart + Math.min(caret.offset, paragraph?.content.size ?? 0);
    }
    return false;
  });
  return matched ?? header;
}
