import {
  deriveSectionCatalog,
  type SectionCatalogEntry,
} from "./section-model";
import {
  noteDisplayTitle,
  type NoteDocument,
  type NoteMetadata,
} from "./documents";
import { deriveTrashNoteTreeEntries, noteAncestorPath } from "./note-tree";

export interface InternalLinkCandidate {
  readonly noteId: string;
  readonly sectionId: string;
  readonly title: string;
  readonly parentPath: string;
  readonly shortId: string;
  readonly updatedAt?: string;
}

interface NormalizedCandidateText {
  title: string;
  parentPath: string;
}

const normalizedCandidateCache = new WeakMap<
  InternalLinkCandidate,
  NormalizedCandidateText
>();

/**
 * Projects the persistent Section trees into the synchronous editor picker.
 * Callers own NoteDoc loading; this function never creates another content
 * representation and only derives labels from the CRDT documents.
 */
export function deriveInternalLinkCandidates(
  notes: readonly NoteMetadata[],
  documents: ReadonlyMap<string, NoteDocument>,
): InternalLinkCandidate[] {
  const candidates: InternalLinkCandidate[] = [];
  for (const metadata of notes) {
    if (metadata.deletedAt) continue;
    const note = documents.get(metadata.noteId);
    if (!note) continue;
    const catalog = deriveSectionCatalog(note.noteId, note.rootSection);
    const notePath = noteAncestorPath(notes, metadata.noteId);
    for (const section of catalog) {
      candidates.push(
        sectionCandidate(section, metadata, notePath, metadata.updatedAt),
      );
    }
  }
  return candidates;
}

/** Deleted NoteDocs are restored as whole notes, so Trash contains roots only. */
export function deriveTrashSearchCandidates(
  notes: readonly NoteMetadata[],
): InternalLinkCandidate[] {
  return deriveTrashNoteTreeEntries(notes).map(({ note }) => ({
    noteId: note.noteId,
    sectionId: note.noteId,
    title: noteDisplayTitle(note.title),
    parentPath: noteAncestorPath(notes, note.noteId),
    shortId: note.noteId.slice(-8),
    updatedAt: note.updatedAt,
  }));
}

export function filterInternalLinkCandidates(
  candidates: readonly InternalLinkCandidate[],
  query: string,
  limit = 8,
): InternalLinkCandidate[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Internal Link candidate limit must be positive");
  }
  const terms = normalizeSearchText(query.trim()).split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return candidates.slice(0, limit);
  return candidates
    .map((candidate, order) => ({
      candidate,
      order,
      score: matchScore(candidate, terms),
    }))
    .filter(
      (entry): entry is typeof entry & { score: number } =>
        entry.score !== null,
    )
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

function sectionCandidate(
  section: SectionCatalogEntry,
  note: NoteMetadata,
  noteParentPath: string,
  updatedAt: string,
): InternalLinkCandidate {
  const sectionPath = section.breadcrumb.split(" / ");
  sectionPath.pop();
  if (sectionPath.length > 0) {
    sectionPath[0] = noteDisplayTitle(note.title);
  }
  const noteAncestors =
    noteParentPath === "/"
      ? []
      : noteParentPath.slice(1).split("/").filter(Boolean);
  const path = [...noteAncestors, ...sectionPath];
  return {
    noteId: section.noteId,
    sectionId: section.sectionId,
    title:
      section.sectionId === note.noteId
        ? noteDisplayTitle(note.title)
        : section.displayTitle,
    parentPath: path.join(" / ") || "/",
    shortId: section.sectionId.slice(-8),
    updatedAt,
  };
}

function matchScore(
  candidate: InternalLinkCandidate,
  normalizedTerms: readonly string[],
): number | null {
  const { title, parentPath } = normalizedCandidateText(candidate);
  if (
    !normalizedTerms.every(
      (term) => title.includes(term) || parentPath.includes(term),
    )
  ) {
    return null;
  }
  const first = normalizedTerms[0] ?? "";
  if (title === first) return 0;
  if (title.startsWith(first)) return 1;
  if (title.includes(first)) return 2;
  return 3;
}

function normalizedCandidateText(
  candidate: InternalLinkCandidate,
): NormalizedCandidateText {
  const cached = normalizedCandidateCache.get(candidate);
  if (cached) return cached;
  const normalized = {
    title: normalizeSearchText(candidate.title),
    parentPath: normalizeSearchText(candidate.parentPath),
  };
  normalizedCandidateCache.set(candidate, normalized);
  return normalized;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}
