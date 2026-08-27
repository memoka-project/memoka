import { TextSelection } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { parseMarkdownNote } from "../editor/markdown-paste";

export const MARKDOWN_NOTE_IMPORT_META = "memoka.markdown-note-import";

export type MarkdownNoteImportResult =
  | {
      readonly changed: true;
      readonly title: string;
      readonly sectionCount: number;
      readonly blockCount: number;
      readonly sourceBlockCount: number;
    }
  | {
      readonly changed: false;
      readonly reason:
        | "not-root-section"
        | "not-root-title"
        | "note-not-empty"
        | "invalid-markdown-note";
    };

/**
 * Replace one semantically empty NoteDoc with a complete Markdown document.
 * The strict target gate is what distinguishes whole-note import from normal
 * Markdown block paste, where heading markers intentionally stay literal.
 */
export function runMarkdownNoteImport(
  view: EditorView,
  markdown: string,
  expectedRootSectionId: string | null,
  options: { readonly beforeDispatch?: () => void } = {},
): MarkdownNoteImportResult {
  const { doc, selection } = view.state;
  const header = doc.firstChild;
  const body = doc.maybeChild(1);
  const children = doc.maybeChild(2);
  if (
    !expectedRootSectionId ||
    doc.type.name !== "section" ||
    doc.childCount !== 3 ||
    header?.type.name !== "sectionHeader" ||
    header.attrs.sectionId !== expectedRootSectionId ||
    body?.type.name !== "sectionBody" ||
    children?.type.name !== "sectionChildren"
  ) {
    return { changed: false, reason: "not-root-section" };
  }
  if (
    !selection.empty ||
    selection.$from.depth !== 1 ||
    selection.$from.parent !== header
  ) {
    return { changed: false, reason: "not-root-title" };
  }
  if (
    header.content.size !== 0 ||
    !isSemanticallyEmptyBody(body) ||
    children.childCount !== 0
  ) {
    return { changed: false, reason: "note-not-empty" };
  }

  const parsed = parseMarkdownNote(
    markdown,
    view.state.schema,
    expectedRootSectionId,
  );
  if (!parsed) return { changed: false, reason: "invalid-markdown-note" };

  let transaction = view.state.tr.replaceWith(
    0,
    view.state.doc.content.size,
    parsed.root.content,
  );
  transaction = transaction
    .setSelection(
      TextSelection.create(transaction.doc, parsed.title.length + 1),
    )
    .setMeta(MARKDOWN_NOTE_IMPORT_META, true)
    .scrollIntoView();
  options.beforeDispatch?.();
  view.dispatch(transaction);
  return {
    changed: true,
    title: parsed.title,
    sectionCount: parsed.sectionCount,
    blockCount: parsed.blockCount,
    sourceBlockCount: parsed.sourceBlockCount,
  };
}

function isSemanticallyEmptyBody(body: ProseMirrorNode): boolean {
  const chunk = body.firstChild;
  return (
    body.childCount === 0 ||
    (body.childCount === 1 &&
      chunk?.type.name === "bodyChunk" &&
      chunk.childCount === 1 &&
      chunk.firstChild?.type.name === "paragraph" &&
      chunk.firstChild.content.size === 0)
  );
}
