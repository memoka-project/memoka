import { noteDisplayTitle, type NoteDocument } from "./documents";
import { deriveSectionCatalog, findSectionWithDepth } from "./section-model";

export interface NoteOutlineEntry {
  readonly sectionId: string;
  readonly parentSectionId: string | null;
  /** Zero-based depth relative to the visible Outline scope. */
  readonly depth: number;
  /** Zero-based absolute depth from the Note Root. */
  readonly noteDepth: number;
  readonly title: string;
}

/** Outline mirrors the Section subtree currently mounted by one Window. */
export function deriveNoteOutline(
  note: NoteDocument,
  scopeSectionId: string = note.noteId,
): NoteOutlineEntry[] {
  const scope = findSectionWithDepth(note.rootSection, scopeSectionId);
  if (!scope) return [];
  return deriveSectionCatalog(note.noteId, scope.element).map((section) => ({
    sectionId: section.sectionId,
    parentSectionId: section.parentSectionId,
    depth: section.depth,
    noteDepth: scope.depth + section.depth,
    title:
      section.sectionId === note.noteId
        ? noteDisplayTitle(section.title)
        : section.displayTitle,
  }));
}
