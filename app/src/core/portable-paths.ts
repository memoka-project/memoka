import type { NoteMetadata } from "./documents";
import { compareNoteMetadata } from "./note-tree";
import type { SectionSnapshot } from "./section-model";

export const PORTABLE_COMPONENT_MAX_BYTES = 180;
export const PORTABLE_RELATIVE_PATH_MAX_BYTES = 2_048;

export interface PortableNotePathInput {
  readonly metadata: NoteMetadata;
  readonly rootSection: SectionSnapshot;
}

export interface PortableSectionPath {
  readonly sectionId: string;
  readonly markdownPath: string;
}

export interface PortableNotePath {
  readonly noteId: string;
  readonly markdownPath: string;
  readonly recoveryPath: string;
  readonly sections: readonly PortableSectionPath[];
}

export interface PortablePathProjection {
  readonly notes: readonly PortableNotePath[];
  readonly markdownPathBySectionId: ReadonlyMap<string, string>;
}

export interface PortablePathProjectionOptions {
  readonly checkpoint?: () => void | Promise<void>;
}

interface PendingNote {
  readonly note: PortableNotePathInput;
  readonly parentStemPath: string | null;
  readonly trash: boolean;
  readonly component: string;
}

const WINDOWS_RESERVED_COMPONENT =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const FORBIDDEN_ASCII = new Set([
  "/",
  "\\",
  "<",
  ">",
  ":",
  '"',
  "|",
  "?",
  "*",
  "%",
]);

/**
 * Projects Note / Section titles to a portable, deterministic sidecar tree.
 * IDs remain in the manifest/frontmatter and are deliberately absent here.
 */
export async function createPortablePathProjection(
  inputs: readonly PortableNotePathInput[],
  options: PortablePathProjectionOptions = {},
): Promise<PortablePathProjection> {
  validateInputs(inputs);
  const byId = new Map(inputs.map((input) => [input.metadata.noteId, input]));
  const live = inputs.filter(({ metadata }) => !metadata.deletedAt);
  const trash = inputs.filter(({ metadata }) => Boolean(metadata.deletedAt));
  const liveChildren = groupNotes(live, () => true);
  const trashChildren = groupNotes(trash, (parentId) =>
    parentId === null ? true : Boolean(byId.get(parentId)?.metadata.deletedAt),
  );

  const paths: PortableNotePath[] = [];
  const markdownPathBySectionId = new Map<string, string>();
  const pending: PendingNote[] = [];
  await appendRootNotes(pending, liveChildren.get(null) ?? [], false, options);
  await appendRootNotes(pending, trashChildren.get(null) ?? [], true, options);

  while (pending.length > 0) {
    const current = pending.shift()!;
    const siblings = current.trash ? trashChildren : liveChildren;
    const stemPath = current.parentStemPath
      ? `${current.parentStemPath}.notes/${current.component}`
      : `${current.trash ? "memoka-trash/" : ""}${current.component}`;
    const markdownPath = await boundedMarkdownPath(stemPath, {
      kind: current.trash ? "trash-note" : "note",
      logicalPath: stemPath,
      title: current.note.metadata.title || "新しいノート",
    });
    const sectionPaths = await projectSectionPaths(
      current.note.rootSection,
      markdownPath,
      options,
    );
    markdownPathBySectionId.set(
      current.note.rootSection.sectionId,
      markdownPath,
    );
    for (const section of sectionPaths) {
      markdownPathBySectionId.set(section.sectionId, section.markdownPath);
    }
    paths.push({
      noteId: current.note.metadata.noteId,
      markdownPath,
      recoveryPath: await recoveryPathFor(markdownPath),
      sections: sectionPaths,
    });

    const children = siblings.get(current.note.metadata.noteId) ?? [];
    const childComponents = await allocateSiblingComponents(
      children.map(({ metadata }) => ({
        id: metadata.noteId,
        title: metadata.title || "新しいノート",
      })),
    );
    for (const child of children) {
      // Store the already allocated stem in a lightweight title override so
      // the queue remains iterative even for very deep Note trees.
      const childComponent = childComponents.get(child.metadata.noteId)!;
      pending.push({
        note: child,
        parentStemPath: stemPath,
        trash: current.trash,
        component: childComponent,
      });
    }
    await options.checkpoint?.();
  }

  return { notes: paths, markdownPathBySectionId };
}

async function appendRootNotes(
  pending: PendingNote[],
  roots: readonly PortableNotePathInput[],
  trash: boolean,
  options: PortablePathProjectionOptions,
): Promise<void> {
  // Allocation is performed up front to make collision suffixes independent
  // from async hash completion order. The queue itself still projects deeply
  // nested trees without recursion.
  const components = await allocateSiblingComponents(
    roots.map(({ metadata }) => ({
      id: metadata.noteId,
      title: metadata.title || "新しいノート",
    })),
    options,
  );
  pending.push(
    ...roots.map((note) => ({
      note,
      parentStemPath: null,
      trash,
      component: components.get(note.metadata.noteId)!,
    })),
  );
}

async function projectSectionPaths(
  root: SectionSnapshot,
  noteMarkdownPath: string,
  options: PortablePathProjectionOptions,
): Promise<PortableSectionPath[]> {
  const noteStem = noteMarkdownPath.slice(0, -".md".length);
  const result: PortableSectionPath[] = [];
  const pending: Array<{
    section: SectionSnapshot;
    parentStem: string;
    ordinal: number;
    component: string;
  }> = [];
  const rootComponents = await allocateSectionComponents(
    root.children,
    options,
  );
  root.children.forEach((section, index) => {
    pending.push({
      section,
      parentStem: noteStem,
      ordinal: index,
      component: rootComponents.get(section.sectionId)!,
    });
  });
  while (pending.length > 0) {
    const current = pending.shift()!;
    const stem = `${current.parentStem}.sections/${current.component}`;
    const markdownPath = await boundedMarkdownPath(stem, {
      kind: "section",
      logicalPath: stem,
      title: current.section.title || "無題",
      ordinal: current.ordinal,
    });
    result.push({
      sectionId: current.section.sectionId,
      markdownPath,
    });
    const components = await allocateSectionComponents(
      current.section.children,
      options,
    );
    current.section.children.forEach((section, index) => {
      pending.push({
        section,
        parentStem: markdownPath.slice(0, -".md".length),
        ordinal: index,
        component: components.get(section.sectionId)!,
      });
    });
    await options.checkpoint?.();
  }
  return result;
}

function allocateSectionComponents(
  sections: readonly SectionSnapshot[],
  options: PortablePathProjectionOptions,
): Promise<ReadonlyMap<string, string>> {
  return allocateSiblingComponents(
    sections.map((section) => ({
      id: section.sectionId,
      title: section.title || "無題",
    })),
    options,
  );
}

async function allocateSiblingComponents(
  siblings: readonly { readonly id: string; readonly title: string }[],
  options: PortablePathProjectionOptions = {},
): Promise<ReadonlyMap<string, string>> {
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const sibling of siblings) {
    let ordinal = 1;
    let component = await portableComponent(sibling.title, ordinal);
    while (used.has(collisionKey(component))) {
      ordinal += 1;
      component = await portableComponent(sibling.title, ordinal);
    }
    used.add(collisionKey(component));
    result.set(sibling.id, component);
    await options.checkpoint?.();
  }
  return result;
}

export async function portableComponent(
  title: string,
  ordinal = 1,
): Promise<string> {
  const normalized = title.normalize("NFC") || "無題";
  const suffix = ordinal <= 1 ? "" : ` (${ordinal})`;
  const encoded = encodeComponent(normalized);
  if (utf8Length(encoded + suffix) <= PORTABLE_COMPONENT_MAX_BYTES) {
    return `${encoded}${suffix}`;
  }
  const digest = (await sha256Hex(new TextEncoder().encode(normalized))).slice(
    0,
    12,
  );
  const tail = `~${digest}${suffix}`;
  const budget = PORTABLE_COMPONENT_MAX_BYTES - utf8Length(tail);
  let prefix = "";
  for (const segment of encodedSegments(normalized)) {
    if (utf8Length(prefix + segment) > budget) break;
    prefix += segment;
  }
  return `${prefix || "%00"}${tail}`;
}

/** Adds a collision ordinal before a conventional filename extension. */
export function portableFileComponent(
  filename: string,
  ordinal = 1,
): Promise<string> {
  const normalized = filename.normalize("NFC") || "添付ファイル";
  if (ordinal <= 1) return portableComponent(normalized);
  const separator = normalized.lastIndexOf(".");
  const hasExtension = separator > 0 && separator < normalized.length - 1;
  const stem = hasExtension ? normalized.slice(0, separator) : normalized;
  const extension = hasExtension ? normalized.slice(separator) : "";
  return portableComponent(`${stem} (${ordinal})${extension}`);
}

function encodeComponent(value: string): string {
  return encodedSegments(value).join("");
}

function encodedSegments(value: string): string[] {
  const normalized = value.normalize("NFC");
  const characters = [...normalized];
  const trailingStart = (() => {
    let index = characters.length;
    while (index > 0 && /[ .]/u.test(characters[index - 1]!)) index -= 1;
    return index;
  })();
  const reserved = WINDOWS_RESERVED_COMPONENT.test(normalized);
  const exactDots = normalized === "." || normalized === "..";
  return characters.map((character, index) => {
    const codePoint = character.codePointAt(0)!;
    const control =
      codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    if (
      control ||
      FORBIDDEN_ASCII.has(character) ||
      index >= trailingStart ||
      exactDots ||
      (reserved && index === 0)
    ) {
      return percentEncode(character);
    }
    return character;
  });
}

function percentEncode(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
}

async function boundedMarkdownPath(
  stem: string,
  identity: {
    readonly kind: string;
    readonly logicalPath: string;
    readonly title: string;
    readonly ordinal?: number;
  },
): Promise<string> {
  const path = `${stem}.md`;
  if (utf8Length(path) <= PORTABLE_RELATIVE_PATH_MAX_BYTES) return path;
  const logicalIdentity = `${identity.kind}\0${identity.logicalPath.normalize("NFC")}\0${identity.ordinal ?? 0}`;
  const digest = await sha256Hex(new TextEncoder().encode(logicalIdentity));
  const shortTitle = await portableComponent(identity.title, 1);
  return `memoka-overflow/${digest}/${truncateUtf8(shortTitle, 96)}.md`;
}

async function recoveryPathFor(markdownPath: string): Promise<string> {
  const path = `memoka-recovery/${markdownPath.slice(0, -".md".length)}.yjs`;
  if (utf8Length(path) <= PORTABLE_RELATIVE_PATH_MAX_BYTES) return path;
  const digest = await sha256Hex(new TextEncoder().encode(markdownPath));
  const filename = markdownPath.split("/").at(-1)!.slice(0, -3);
  return `memoka-recovery/memoka-overflow/${digest}/${truncateUtf8(filename, 96)}.yjs`;
}

function groupNotes(
  inputs: readonly PortableNotePathInput[],
  keepParent: (parentId: string | null) => boolean,
): Map<string | null, PortableNotePathInput[]> {
  const ids = new Set(inputs.map(({ metadata }) => metadata.noteId));
  const result = new Map<string | null, PortableNotePathInput[]>();
  for (const input of inputs) {
    const requestedParent = input.metadata.parentNoteId;
    const parent =
      requestedParent !== null &&
      ids.has(requestedParent) &&
      keepParent(requestedParent)
        ? requestedParent
        : null;
    const siblings = result.get(parent) ?? [];
    siblings.push(input);
    result.set(parent, siblings);
  }
  for (const siblings of result.values()) {
    siblings.sort((left, right) =>
      compareNoteMetadata(left.metadata, right.metadata),
    );
  }
  return result;
}

function validateInputs(inputs: readonly PortableNotePathInput[]): void {
  const noteIds = new Set<string>();
  const sectionIds = new Set<string>();
  for (const input of inputs) {
    if (noteIds.has(input.metadata.noteId)) {
      throw new Error(`Duplicate Note ID: ${input.metadata.noteId}`);
    }
    if (input.rootSection.sectionId !== input.metadata.noteId) {
      throw new Error("Root Section ID must equal Note ID");
    }
    noteIds.add(input.metadata.noteId);
    const pending = [input.rootSection];
    while (pending.length > 0) {
      const section = pending.pop()!;
      if (sectionIds.has(section.sectionId)) {
        throw new Error(`Duplicate Section ID: ${section.sectionId}`);
      }
      sectionIds.add(section.sectionId);
      pending.push(...section.children);
    }
  }
}

function collisionKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let result = "";
  for (const character of value) {
    if (utf8Length(result + character) > maximumBytes) break;
    result += character;
  }
  return result || "%00";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
