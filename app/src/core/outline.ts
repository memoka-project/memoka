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

/** Applies one Window's fold projection without changing the Note outline. */
export function visibleNoteOutlineEntries(
  entries: readonly NoteOutlineEntry[],
  collapsedSectionIds: ReadonlySet<string>,
): NoteOutlineEntry[] {
  if (collapsedSectionIds.size === 0) return [...entries];
  const visible: NoteOutlineEntry[] = [];
  let hiddenBelowDepth: number | null = null;
  for (const entry of entries) {
    if (hiddenBelowDepth !== null) {
      if (entry.depth > hiddenBelowDepth) continue;
      hiddenBelowDepth = null;
    }
    visible.push(entry);
    if (collapsedSectionIds.has(entry.sectionId)) {
      hiddenBelowDepth = entry.depth;
    }
  }
  return visible;
}

export function nearestVisibleOutlineSectionId(
  entries: readonly NoteOutlineEntry[],
  visibleEntries: readonly NoteOutlineEntry[],
  requestedSectionId: string | null | undefined,
): string {
  const first = visibleEntries[0]?.sectionId ?? "";
  if (!requestedSectionId) return first;
  const visibleIds = new Set(visibleEntries.map(({ sectionId }) => sectionId));
  const parents = new Map(
    entries.map(({ sectionId, parentSectionId }) => [
      sectionId,
      parentSectionId,
    ]),
  );
  let candidate: string | null = requestedSectionId;
  while (candidate) {
    if (visibleIds.has(candidate)) return candidate;
    candidate = parents.get(candidate) ?? null;
  }
  return first;
}
