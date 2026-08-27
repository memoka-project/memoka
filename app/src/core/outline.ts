import { noteDisplayTitle, type NoteDocument } from "./documents";
import { deriveSectionCatalog, findSectionById } from "./section-model";

export interface NoteOutlineEntry {
  readonly sectionId: string;
  readonly parentSectionId: string | null;
  /** Zero-based Section depth. ARIA tree levels are derived as depth + 1. */
  readonly depth: number;
  readonly title: string;
}

/** Outline mirrors the Section subtree currently mounted by one Window. */
export function deriveNoteOutline(
  note: NoteDocument,
  scopeSectionId: string = note.noteId,
): NoteOutlineEntry[] {
  const scope = findSectionById(note.rootSection, scopeSectionId);
  if (!scope) return [];
  return deriveSectionCatalog(note.noteId, scope).map((section) => ({
    sectionId: section.sectionId,
    parentSectionId: section.parentSectionId,
    depth: section.depth,
    title:
      section.sectionId === note.noteId
        ? noteDisplayTitle(section.title)
        : section.displayTitle,
  }));
}
