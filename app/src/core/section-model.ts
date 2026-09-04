import * as Y from "yjs";
import { assertUuidV7, createUuidV7 } from "./ids";
import { yXmlTextVisibleText } from "./yxml-text";

export const SECTION_NODE = "section";
export const SECTION_HEADER_NODE = "sectionHeader";
export const SECTION_BODY_NODE = "sectionBody";
export const BODY_CHUNK_NODE = "bodyChunk";
export const SECTION_CHILDREN_NODE = "sectionChildren";

export const BODY_CHUNK_TARGET_BLOCKS = 256;
export const BODY_CHUNK_TARGET_BYTES = 128 * 1024;
export const BODY_CHUNK_HARD_BLOCKS = 512;
export const BODY_CHUNK_HARD_BYTES = 256 * 1024;

const utf8Encoder = new TextEncoder();

function approximateJsonBytes(value: unknown): number {
  return utf8Encoder.encode(JSON.stringify(value)).byteLength;
}

export interface SectionProperties {
  emoji?: string;
  tags: string[];
}

export interface SectionCatalogEntry {
  readonly noteId: string;
  readonly sectionId: string;
  readonly parentSectionId: string | null;
  readonly depth: number;
  readonly order: number;
  readonly title: string;
  readonly displayTitle: string;
  readonly breadcrumb: string;
  readonly properties: SectionProperties;
  readonly element: Y.XmlElement;
}

export interface LocatedSection {
  readonly element: Y.XmlElement;
  /** Zero-based depth from the Note Root. */
  readonly depth: number;
}

export interface SectionSnapshot {
  readonly sectionId: string;
  readonly title: string;
  readonly emoji?: string;
  readonly tags: readonly string[];
  readonly body: readonly unknown[];
  readonly children: readonly SectionSnapshot[];
}

export interface SectionSnapshotAsyncOptions {
  readonly signal?: AbortSignal;
  readonly checkpoint?: () => void | Promise<void>;
}

export interface SectionValidationResult {
  readonly sectionCount: number;
  readonly maximumDepth: number;
}

export interface CloneSectionResult {
  readonly snapshot: SectionSnapshot;
  readonly idMap: ReadonlyMap<string, string>;
}

export type SectionDepthShiftDirection = "deeper" | "shallower";

export interface SectionDepthShiftPlan {
  readonly snapshot: SectionSnapshot;
  readonly changed: boolean;
  /** Includes selected and unselected Sections whose resulting depth changed. */
  readonly affectedSectionIds: readonly string[];
}

export function createSectionXml(
  sectionId: string,
  title = "",
  body: readonly Y.XmlElement[] = [],
  children: readonly Y.XmlElement[] = [],
  properties: Partial<SectionProperties> = {},
  bodyByteSizes?: readonly number[],
): Y.XmlElement {
  assertUuidV7(sectionId, "sectionId");
  validateSectionTitle(title);
  validateSectionProperties(properties);
  for (const child of children) {
    if (child.nodeName !== SECTION_NODE) {
      throw new Error("Section children may only contain Section nodes");
    }
  }

  const section = new Y.XmlElement(SECTION_NODE);
  const header = new Y.XmlElement(SECTION_HEADER_NODE);
  header.setAttribute("sectionId", sectionId);
  if (properties.emoji) header.setAttribute("emoji", properties.emoji);
  header.setAttribute("tags", JSON.stringify(properties.tags ?? []));
  if (title) {
    const text = new Y.XmlText();
    text.insert(0, title);
    header.insert(0, [text]);
  }

  const sectionBody = new Y.XmlElement(SECTION_BODY_NODE);
  const chunks = createBodyChunks(body, bodyByteSizes);
  if (chunks.length > 0) sectionBody.insert(0, chunks);
  const sectionChildren = new Y.XmlElement(SECTION_CHILDREN_NODE);
  if (children.length > 0) sectionChildren.insert(0, [...children]);
  section.insert(0, [header, sectionBody, sectionChildren]);
  return section;
}

export function sectionHeader(section: Y.XmlElement): Y.XmlElement {
  assertSectionElement(section);
  return requiredContainer(section, 0, SECTION_HEADER_NODE);
}

export function sectionBody(section: Y.XmlElement): Y.XmlElement {
  assertSectionElement(section);
  return requiredContainer(section, 1, SECTION_BODY_NODE);
}

export function createBodyChunkXml(
  blocks: readonly Y.XmlElement[] = [],
  chunkId = createUuidV7(),
): Y.XmlElement {
  assertUuidV7(chunkId, "chunkId");
  const chunk = new Y.XmlElement(BODY_CHUNK_NODE);
  chunk.setAttribute("chunkId", chunkId);
  if (blocks.length > 0) chunk.insert(0, [...blocks]);
  return chunk;
}

export function createBodyChunks(
  blocks: readonly Y.XmlElement[],
  approximateByteSizes?: readonly number[],
): Y.XmlElement[] {
  if (approximateByteSizes && approximateByteSizes.length !== blocks.length) {
    throw new Error("Body chunk byte estimates must match the block count");
  }
  const chunks: Y.XmlElement[] = [];
  let pending: Y.XmlElement[] = [];
  let pendingBytes = 0;
  const flush = (): void => {
    if (pending.length === 0) return;
    chunks.push(createBodyChunkXml(pending));
    pending = [];
    pendingBytes = 0;
  };
  for (const [index, block] of blocks.entries()) {
    if (block.nodeName === SECTION_NODE || block.nodeName === BODY_CHUNK_NODE) {
      throw new Error(
        "Section body chunks may only contain direct body blocks",
      );
    }
    const blockBytes = Math.max(0, approximateByteSizes?.[index] ?? 0);
    if (
      pending.length > 0 &&
      (pending.length >= BODY_CHUNK_TARGET_BLOCKS ||
        pendingBytes + blockBytes > BODY_CHUNK_TARGET_BYTES)
    ) {
      flush();
    }
    pending.push(block);
    pendingBytes += blockBytes;
  }
  flush();
  return chunks;
}

export function sectionBodyChunks(section: Y.XmlElement): Y.XmlElement[] {
  const body = sectionBody(section);
  return body.toArray().map((value) => {
    if (
      !(value instanceof Y.XmlElement) ||
      value.nodeName !== BODY_CHUNK_NODE
    ) {
      throw new Error(
        `Section ${sectionId(section)} body contains an invalid chunk`,
      );
    }
    const chunkId = value.getAttribute("chunkId");
    assertUuidV7(typeof chunkId === "string" ? chunkId : "", "chunkId");
    return value;
  });
}

export function sectionBodyBlocks(section: Y.XmlElement): Y.XmlElement[] {
  return sectionBodyChunks(section).flatMap((chunk) =>
    chunk.toArray().map((value) => {
      if (
        !(value instanceof Y.XmlElement) ||
        value.nodeName === SECTION_NODE ||
        value.nodeName === BODY_CHUNK_NODE
      ) {
        throw new Error(
          `Section ${sectionId(section)} body chunk contains an invalid block`,
        );
      }
      return value;
    }),
  );
}

export function sectionChildren(section: Y.XmlElement): Y.XmlElement {
  assertSectionElement(section);
  return requiredContainer(section, 2, SECTION_CHILDREN_NODE);
}

export function sectionId(section: Y.XmlElement): string {
  const value = sectionHeader(section).getAttribute("sectionId");
  const id = typeof value === "string" ? value : String(value ?? "");
  assertUuidV7(id, "sectionId");
  return id;
}

export function sectionTitle(section: Y.XmlElement): string {
  return sectionHeader(section)
    .toArray()
    .map((value) =>
      value instanceof Y.XmlElement || value instanceof Y.XmlText
        ? xmlTextContent(value)
        : "",
    )
    .join("");
}

export function sectionDisplayTitle(section: Y.XmlElement): string {
  return sectionTitle(section) || "無題";
}

export function sectionProperties(section: Y.XmlElement): SectionProperties {
  const header = sectionHeader(section);
  const rawEmoji = header.getAttribute("emoji");
  const rawTags = header.getAttribute("tags");
  let tags: unknown = [];
  if (typeof rawTags === "string") {
    try {
      tags = JSON.parse(rawTags);
    } catch {
      throw new Error(`Section ${sectionId(section)} has invalid tags`);
    }
  }
  const properties = {
    emoji:
      typeof rawEmoji === "string" && rawEmoji.length > 0
        ? rawEmoji
        : undefined,
    tags: Array.isArray(tags) ? tags.map(String) : [],
  };
  validateSectionProperties(properties);
  return properties;
}

export function updateSectionTitle(section: Y.XmlElement, title: string): void {
  validateSectionTitle(title);
  const header = sectionHeader(section);
  header.delete(0, header.length);
  if (title) {
    const text = new Y.XmlText();
    text.insert(0, title);
    header.insert(0, [text]);
  }
}

export function updateSectionProperties(
  section: Y.XmlElement,
  properties: Partial<SectionProperties>,
): void {
  validateSectionProperties(properties);
  const header = sectionHeader(section);
  if (properties.emoji === undefined || properties.emoji === "") {
    header.removeAttribute("emoji");
  } else {
    header.setAttribute("emoji", properties.emoji);
  }
  if (properties.tags !== undefined) {
    header.setAttribute("tags", JSON.stringify(properties.tags));
  }
}

export function childSections(section: Y.XmlElement): Y.XmlElement[] {
  return sectionChildren(section)
    .toArray()
    .map((value) => {
      if (!(value instanceof Y.XmlElement) || value.nodeName !== SECTION_NODE) {
        throw new Error(
          `Section ${sectionId(section)} has a non-Section child`,
        );
      }
      return value;
    });
}

export function findSectionById(
  root: Y.XmlElement,
  targetSectionId: string,
): Y.XmlElement | null {
  assertUuidV7(targetSectionId, "targetSectionId");
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (sectionId(current) === targetSectionId) return current;
    const children = childSections(current);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]!);
    }
  }
  return null;
}

export function findSectionWithDepth(
  root: Y.XmlElement,
  targetSectionId: string,
): LocatedSection | null {
  assertUuidV7(targetSectionId, "targetSectionId");
  const pending: LocatedSection[] = [{ element: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (sectionId(current.element) === targetSectionId) return current;
    const children = childSections(current.element);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({
        element: children[index]!,
        depth: current.depth + 1,
      });
    }
  }
  return null;
}

export function findParentSection(
  root: Y.XmlElement,
  targetSectionId: string,
): Y.XmlElement | null {
  if (sectionId(root) === targetSectionId) return null;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of childSections(current)) {
      if (sectionId(child) === targetSectionId) return current;
      pending.push(child);
    }
  }
  return null;
}

/**
 * Returns the direct child of `ancestorSectionId` whose subtree contains
 * `descendantSectionId`. Equal, missing, or unrelated Sections have no step.
 */
export function findChildSectionToward(
  root: Y.XmlElement,
  ancestorSectionId: string,
  descendantSectionId: string,
): Y.XmlElement | null {
  if (ancestorSectionId === descendantSectionId) return null;
  const ancestor = findSectionById(root, ancestorSectionId);
  if (!ancestor) return null;
  for (const child of childSections(ancestor)) {
    if (findSectionById(child, descendantSectionId)) return child;
  }
  return null;
}

export function deriveSectionCatalog(
  noteId: string,
  root: Y.XmlElement,
): SectionCatalogEntry[] {
  assertUuidV7(noteId, "noteId");
  const result: SectionCatalogEntry[] = [];
  const pending: Array<{
    element: Y.XmlElement;
    parentSectionId: string | null;
    depth: number;
    ancestors: string[];
  }> = [{ element: root, parentSectionId: null, depth: 0, ancestors: [] }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const id = sectionId(current.element);
    const title = sectionTitle(current.element);
    const displayTitle = title || "無題";
    result.push({
      noteId,
      sectionId: id,
      parentSectionId: current.parentSectionId,
      depth: current.depth,
      order: result.length,
      title,
      displayTitle,
      breadcrumb: [...current.ancestors, displayTitle].join(" / "),
      properties: sectionProperties(current.element),
      element: current.element,
    });
    const children = childSections(current.element);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({
        element: children[index]!,
        parentSectionId: id,
        depth: current.depth + 1,
        ancestors: [...current.ancestors, displayTitle],
      });
    }
  }
  return result;
}

export function validateSectionTree(
  root: Y.XmlElement,
  expectedRootId?: string,
): SectionValidationResult {
  if (expectedRootId !== undefined) {
    assertUuidV7(expectedRootId, "expectedRootId");
  }
  const seenIds = new Set<string>();
  let maximumDepth = 0;
  let sectionCount = 0;
  const pending: Array<{ section: Y.XmlElement; depth: number }> = [
    { section: root, depth: 0 },
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    assertSectionElement(current.section);
    if (current.section.length !== 3) {
      throw new Error("Section must contain exactly header, body and children");
    }
    const id = sectionId(current.section);
    if (seenIds.has(id)) throw new Error(`Duplicate Section ID: ${id}`);
    seenIds.add(id);
    sectionCount += 1;
    maximumDepth = Math.max(maximumDepth, current.depth);
    sectionTitle(current.section);
    sectionProperties(current.section);
    const chunkIds = new Set<string>();
    for (const chunk of sectionBodyChunks(current.section)) {
      const chunkId = String(chunk.getAttribute("chunkId"));
      if (chunkIds.has(chunkId)) {
        throw new Error(`Section ${id} has a duplicate body chunk ID`);
      }
      chunkIds.add(chunkId);
      if (chunk.length === 0) {
        throw new Error(`Section ${id} contains an empty body chunk`);
      }
      for (const value of chunk.toArray()) {
        if (
          !(value instanceof Y.XmlElement) ||
          value.nodeName === SECTION_NODE ||
          value.nodeName === BODY_CHUNK_NODE
        ) {
          throw new Error(`Section ${id} body chunk contains an invalid block`);
        }
      }
    }
    const children = childSections(current.section);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ section: children[index]!, depth: current.depth + 1 });
    }
  }
  if (expectedRootId !== undefined && sectionId(root) !== expectedRootId) {
    throw new Error("Root Section ID must equal Note ID");
  }
  return { sectionCount, maximumDepth };
}

export function sectionSnapshot(section: Y.XmlElement): SectionSnapshot {
  type MutableSnapshot = {
    sectionId: string;
    title: string;
    emoji?: string;
    tags: readonly string[];
    body: readonly unknown[];
    children: MutableSnapshot[];
  };
  const snapshotFor = (value: Y.XmlElement): MutableSnapshot => ({
    sectionId: sectionId(value),
    title: sectionTitle(value),
    ...sectionProperties(value),
    body: sectionBodyBlocks(value).map(yValueToJson),
    children: [],
  });
  const root = snapshotFor(section);
  const pending: Array<{ source: Y.XmlElement; target: MutableSnapshot }> = [
    { source: section, target: root },
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const children = childSections(current.source);
    current.target.children = children.map(snapshotFor);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({
        source: children[index]!,
        target: current.target.children[index]!,
      });
    }
  }
  return root;
}

/**
 * Produces the same disposable JSON snapshot as `sectionSnapshot` while
 * yielding between bounded BodyChunks and Sections. The source revision must
 * still be checked by the caller after this cooperative read completes.
 */
export async function sectionSnapshotAsync(
  section: Y.XmlElement,
  options: SectionSnapshotAsyncOptions = {},
): Promise<SectionSnapshot> {
  type MutableSnapshot = {
    sectionId: string;
    title: string;
    emoji?: string;
    tags: readonly string[];
    body: unknown[];
    children: MutableSnapshot[];
  };
  const checkpoint = async (): Promise<void> => {
    throwIfSnapshotAborted(options.signal);
    await options.checkpoint?.();
    throwIfSnapshotAborted(options.signal);
  };
  const snapshotFor = async (value: Y.XmlElement): Promise<MutableSnapshot> => {
    const body: unknown[] = [];
    for (const chunk of sectionBodyChunks(value)) {
      for (const item of chunk.toArray()) {
        if (
          !(item instanceof Y.XmlElement) ||
          item.nodeName === SECTION_NODE ||
          item.nodeName === BODY_CHUNK_NODE
        ) {
          throw new Error(
            `Section ${sectionId(value)} body chunk contains an invalid block`,
          );
        }
        body.push(yValueToJson(item));
      }
      await checkpoint();
    }
    return {
      sectionId: sectionId(value),
      title: sectionTitle(value),
      ...sectionProperties(value),
      body,
      children: [],
    };
  };

  const root = await snapshotFor(section);
  const pending: Array<{ source: Y.XmlElement; target: MutableSnapshot }> = [
    { source: section, target: root },
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const children = childSections(current.source);
    const childSnapshots: MutableSnapshot[] = [];
    for (const child of children) {
      childSnapshots.push(await snapshotFor(child));
      await checkpoint();
    }
    current.target.children = childSnapshots;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({
        source: children[index]!,
        target: childSnapshots[index]!,
      });
    }
  }
  return root;
}

function throwIfSnapshotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Portable mirror preparation was cancelled");
  error.name = "AbortError";
  throw error;
}

/**
 * Changes Section depth without changing preorder display order.
 *
 * Only explicitly selected Section headers receive the requested one-level
 * shift. Later Sections keep their absolute depth unless that would create an
 * invalid preorder depth jump, in which case they are made just shallow
 * enough to keep the tree valid. The supplied snapshot is the displayed
 * Focused Section boundary and its root can never move across that boundary.
 */
export function planSectionDepthShift(
  boundary: SectionSnapshot,
  targetSectionIds: readonly string[],
  direction: SectionDepthShiftDirection,
): SectionDepthShiftPlan {
  validateSectionSnapshot(boundary);
  const flattened = flattenSectionSnapshot(boundary);
  const knownIds = new Set(flattened.map(({ snapshot }) => snapshot.sectionId));
  const requestedIds = new Set(targetSectionIds);
  for (const targetSectionId of requestedIds) {
    assertUuidV7(targetSectionId, "targetSectionId");
    if (!knownIds.has(targetSectionId)) {
      throw new Error(
        `Section is outside the Focused Section: ${targetSectionId}`,
      );
    }
  }

  const resultingDepths = flattened.map(({ depth }, index) => {
    if (
      index === 0 ||
      !requestedIds.has(flattened[index]!.snapshot.sectionId)
    ) {
      return depth;
    }
    return direction === "deeper" ? depth + 1 : Math.max(1, depth - 1);
  });

  // A preorder tree may descend at most one level from the previous Section.
  // Clamp only the invalid suffix; this preserves every unaffected absolute
  // depth whenever the requested header shift permits it.
  for (let index = 1; index < resultingDepths.length; index += 1) {
    resultingDepths[index] = Math.max(
      1,
      Math.min(resultingDepths[index]!, resultingDepths[index - 1]! + 1),
    );
  }

  const affectedSectionIds = flattened
    .filter(({ depth }, index) => depth !== resultingDepths[index])
    .map(({ snapshot }) => snapshot.sectionId);
  if (affectedSectionIds.length === 0) {
    return { snapshot: boundary, changed: false, affectedSectionIds: [] };
  }

  return {
    snapshot: rebuildSectionSnapshot(flattened, resultingDepths),
    changed: true,
    affectedSectionIds,
  };
}

export function cloneSectionSubtree(
  source: Y.XmlElement,
  options: {
    preserveIds?: boolean;
    occupiedIds?: ReadonlySet<string>;
    idFactory?: () => string;
  } = {},
): CloneSectionResult {
  const snapshot = sectionSnapshot(source);
  const occupied = new Set(options.occupiedIds ?? []);
  const idFactory = options.idFactory ?? createUuidV7;
  const idMap = new Map<string, string>();
  const pending = [snapshot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let nextId = current.sectionId;
    if (!options.preserveIds || occupied.has(nextId)) {
      do nextId = idFactory();
      while (occupied.has(nextId));
    }
    occupied.add(nextId);
    idMap.set(current.sectionId, nextId);
    pending.push(...current.children);
  }
  return {
    snapshot: remapSectionSnapshot(snapshot, idMap),
    idMap,
  };
}

/**
 * Replaces one integrated Section in place. Keeping the root Y.XmlElement
 * identity is important because editor bindings and the shared UndoManager
 * observe that exact type.
 */
export function applySectionSnapshot(
  target: Y.XmlElement,
  snapshot: SectionSnapshot,
): void {
  if (sectionId(target) !== snapshot.sectionId) {
    throw new Error("Section snapshot ID does not match its target");
  }
  validateSectionSnapshot(snapshot);
  replaceSectionFields(target, snapshot);
  replaceSectionChildren(target, snapshot);
}

/** Reparents descendants while retaining the mounted boundary Section itself. */
export function applySectionHierarchySnapshot(
  target: Y.XmlElement,
  snapshot: SectionSnapshot,
): void {
  if (sectionId(target) !== snapshot.sectionId) {
    throw new Error("Section hierarchy snapshot ID does not match its target");
  }
  validateSectionSnapshot(snapshot);
  reconcileSectionHierarchy(target, snapshot);
}

/**
 * Applies a preorder-preserving hierarchy change without rebuilding every
 * descendant of the mounted Section boundary.
 *
 * Yjs shared types cannot be moved after integration. A Section whose parent
 * changes therefore has to be cloned, but siblings outside that moved region
 * can and should retain their shared-type identity. Keeping those identities
 * avoids document-sized updates for a one-header depth command.
 */
function reconcileSectionHierarchy(
  target: Y.XmlElement,
  snapshot: SectionSnapshot,
): void {
  interface CurrentEntry {
    readonly element: Y.XmlElement;
    readonly parentId: string | null;
  }
  const targetId = sectionId(target);
  const currentById = new Map<string, CurrentEntry>();
  const currentPending: Array<{
    element: Y.XmlElement;
    parentId: string | null;
  }> = [{ element: target, parentId: null }];
  while (currentPending.length > 0) {
    const current = currentPending.pop()!;
    const id = sectionId(current.element);
    currentById.set(id, current);
    const children = childSections(current.element);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      currentPending.push({ element: children[index]!, parentId: id });
    }
  }

  const desiredById = new Map<string, SectionSnapshot>();
  const desiredParentById = new Map<string, string | null>();
  const desiredPending: Array<{
    value: SectionSnapshot;
    parentId: string | null;
  }> = [{ value: snapshot, parentId: null }];
  while (desiredPending.length > 0) {
    const current = desiredPending.pop()!;
    desiredById.set(current.value.sectionId, current.value);
    desiredParentById.set(current.value.sectionId, current.parentId);
    for (
      let index = current.value.children.length - 1;
      index >= 0;
      index -= 1
    ) {
      desiredPending.push({
        value: current.value.children[index]!,
        parentId: current.value.sectionId,
      });
    }
  }
  if (
    currentById.size !== desiredById.size ||
    [...currentById.keys()].some((id) => !desiredById.has(id))
  ) {
    throw new Error("Section hierarchy snapshot must preserve every Section");
  }

  const movedIds = new Set(
    [...currentById.entries()]
      .filter(([id, current]) => desiredParentById.get(id) !== current.parentId)
      .map(([id]) => id),
  );
  if (movedIds.size === 0) {
    validateSectionTree(target);
    return;
  }
  if (movedIds.has(targetId)) {
    throw new Error("Focused Section boundary cannot change parent");
  }

  // If a moved Section is below another moved Section in the desired tree,
  // the outer clone already contains it. Only the outermost moved roots need
  // independent insertion.
  const cloneRootIds = [...movedIds].filter((id) => {
    let parentId = desiredParentById.get(id) ?? null;
    while (parentId !== null) {
      if (movedIds.has(parentId)) return false;
      parentId = desiredParentById.get(parentId) ?? null;
    }
    return true;
  });
  const clonedIds = new Set<string>();
  for (const rootId of cloneRootIds) {
    const rootSnapshot = desiredById.get(rootId)!;
    const pending = [rootSnapshot];
    while (pending.length > 0) {
      const current = pending.pop()!;
      clonedIds.add(current.sectionId);
      pending.push(...current.children);
    }
  }

  // Remove the smallest non-overlapping set of current subtrees represented
  // by the desired clones. Descendants disappear with an included ancestor.
  const removalRootIds = [...clonedIds].filter((id) => {
    let parentId = currentById.get(id)?.parentId ?? null;
    while (parentId !== null) {
      if (clonedIds.has(parentId)) return false;
      parentId = currentById.get(parentId)?.parentId ?? null;
    }
    return true;
  });
  const removalsByParent = new Map<Y.XmlElement, number[]>();
  for (const id of removalRootIds) {
    const current = currentById.get(id)!;
    if (current.parentId === null) {
      throw new Error("Focused Section boundary cannot be replaced");
    }
    const parent = currentById.get(current.parentId)!.element;
    const index = childSections(parent).findIndex(
      (child) => sectionId(child) === id,
    );
    if (index < 0) throw new Error(`Section disappeared before move: ${id}`);
    const indices = removalsByParent.get(parent) ?? [];
    indices.push(index);
    removalsByParent.set(parent, indices);
  }

  const clones = new Map(
    cloneRootIds.map((id) => [
      id,
      createSectionFromSnapshot(desiredById.get(id)!),
    ]),
  );
  for (const [parent, indices] of removalsByParent) {
    const children = sectionChildren(parent);
    for (const index of indices.sort((left, right) => right - left)) {
      children.delete(index, 1);
    }
  }

  const insertionParentIds = new Set(
    cloneRootIds.map((id) => desiredParentById.get(id)!),
  );
  for (const parentId of insertionParentIds) {
    if (parentId === null || clonedIds.has(parentId)) {
      throw new Error("Moved Section has an invalid destination parent");
    }
    const parent = currentById.get(parentId)?.element;
    const desiredParent = desiredById.get(parentId);
    if (!parent || !desiredParent) {
      throw new Error(`Unknown Section move destination: ${parentId}`);
    }
    const children = sectionChildren(parent);
    for (let index = 0; index < desiredParent.children.length; index += 1) {
      const desiredChildId = desiredParent.children[index]!.sectionId;
      const clone = clones.get(desiredChildId);
      if (clone) {
        children.insert(index, [clone]);
        continue;
      }
      const retained = children.get(index);
      if (
        !(retained instanceof Y.XmlElement) ||
        sectionId(retained) !== desiredChildId
      ) {
        throw new Error("Section move would reorder an unaffected sibling");
      }
    }
  }
  validateSectionTree(target);
}

function replaceSectionChildren(
  target: Y.XmlElement,
  snapshot: SectionSnapshot,
): void {
  const pending: Array<{
    target: Y.XmlElement;
    snapshot: SectionSnapshot;
  }> = [{ target, snapshot }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const targetChildren = sectionChildren(current.target);
    targetChildren.delete(0, targetChildren.length);
    const children = current.snapshot.children.map((child) =>
      createSectionXml(
        child.sectionId,
        child.title,
        sectionBodyFromSnapshot(child),
        [],
        { emoji: child.emoji, tags: [...child.tags] },
        child.body.map(approximateJsonBytes),
      ),
    );
    if (children.length > 0) targetChildren.insert(0, children);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({
        target: children[index]!,
        snapshot: current.snapshot.children[index]!,
      });
    }
  }
  validateSectionTree(target);
}

export function createSectionFromSnapshot(
  snapshot: SectionSnapshot,
): Y.XmlElement {
  // Preliminary Yjs types cannot be traversed. Construct descendants first
  // and hand them to their parent exactly once instead of creating an empty
  // tree and reading it back before integration.
  const created = new Map<SectionSnapshot, Y.XmlElement>();
  const pending: Array<{
    value: SectionSnapshot;
    visited: boolean;
  }> = [{ value: snapshot, visited: false }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!current.visited) {
      pending.push({ ...current, visited: true });
      for (
        let index = current.value.children.length - 1;
        index >= 0;
        index -= 1
      ) {
        pending.push({
          value: current.value.children[index]!,
          visited: false,
        });
      }
      continue;
    }
    const children = current.value.children.map((child) => {
      const value = created.get(child);
      if (!value) throw new Error("Section snapshot child was not created");
      return value;
    });
    created.set(
      current.value,
      createSectionXml(
        current.value.sectionId,
        current.value.title,
        sectionBodyFromSnapshot(current.value),
        children,
        {
          emoji: current.value.emoji,
          tags: [...current.value.tags],
        },
        current.value.body.map(approximateJsonBytes),
      ),
    );
  }
  const root = created.get(snapshot);
  if (!root) throw new Error("Section snapshot root was not created");
  return root;
}

export function insertChildSection(
  parent: Y.XmlElement,
  child: Y.XmlElement,
  index = childSections(parent).length,
): void {
  if (child.nodeName !== SECTION_NODE) {
    throw new Error("Section children may only contain Section nodes");
  }
  const children = sectionChildren(parent);
  if (!Number.isSafeInteger(index) || index < 0 || index > children.length) {
    throw new Error("Section insertion index is outside the child list");
  }
  children.insert(index, [child]);
  try {
    validateSectionTree(rootSectionFor(parent));
  } catch (error) {
    // A preliminary Y.XmlElement cannot be traversed reliably until it is
    // integrated. Validate immediately after insertion and remove it again in
    // the same caller-owned transaction if it violates the tree invariant.
    children.delete(index, 1);
    throw error;
  }
}

export function removeChildSection(
  parent: Y.XmlElement,
  targetSectionId: string,
): Y.XmlElement {
  const children = sectionChildren(parent);
  const index = childSections(parent).findIndex(
    (child) => sectionId(child) === targetSectionId,
  );
  if (index < 0) throw new Error(`Unknown child Section: ${targetSectionId}`);
  const child = children.get(index);
  if (!(child instanceof Y.XmlElement)) {
    throw new Error("Section child disappeared during deletion");
  }
  children.delete(index, 1);
  return child;
}

export function isSectionBodySemanticallyEmpty(section: Y.XmlElement): boolean {
  for (const value of sectionBodyBlocks(section)) {
    if (value.nodeName !== "paragraph" || xmlTextContent(value).length > 0) {
      return false;
    }
  }
  return true;
}

export function validateSectionTitle(title: string): void {
  if (title.includes("\n") || title.includes("\r")) {
    throw new Error("Section title must be a single line");
  }
}

function validateSectionProperties(
  properties: Partial<SectionProperties>,
): void {
  if (
    properties.emoji !== undefined &&
    (typeof properties.emoji !== "string" || properties.emoji.includes("\n"))
  ) {
    throw new Error("Section emoji must be a single-line string");
  }
  if (
    properties.tags !== undefined &&
    (!Array.isArray(properties.tags) ||
      properties.tags.some(
        (tag) => typeof tag !== "string" || tag.length === 0,
      ))
  ) {
    throw new Error("Section tags must be non-empty strings");
  }
}

interface FlattenedSectionSnapshot {
  readonly snapshot: SectionSnapshot;
  readonly depth: number;
}

function flattenSectionSnapshot(
  root: SectionSnapshot,
): FlattenedSectionSnapshot[] {
  const result: FlattenedSectionSnapshot[] = [];
  const pending: FlattenedSectionSnapshot[] = [{ snapshot: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    result.push(current);
    for (
      let index = current.snapshot.children.length - 1;
      index >= 0;
      index -= 1
    ) {
      pending.push({
        snapshot: current.snapshot.children[index]!,
        depth: current.depth + 1,
      });
    }
  }
  return result;
}

function rebuildSectionSnapshot(
  flattened: readonly FlattenedSectionSnapshot[],
  depths: readonly number[],
): SectionSnapshot {
  type MutableSectionSnapshot = Omit<SectionSnapshot, "children"> & {
    children: MutableSectionSnapshot[];
  };
  if (flattened.length === 0 || depths.length !== flattened.length) {
    throw new Error("Section depth plan is incomplete");
  }
  const clone = (snapshot: SectionSnapshot): MutableSectionSnapshot => ({
    sectionId: snapshot.sectionId,
    title: snapshot.title,
    ...(snapshot.emoji === undefined ? {} : { emoji: snapshot.emoji }),
    tags: snapshot.tags,
    body: snapshot.body,
    children: [],
  });
  const root = clone(flattened[0]!.snapshot);
  const ancestors: MutableSectionSnapshot[] = [root];
  for (let index = 1; index < flattened.length; index += 1) {
    const depth = depths[index]!;
    const parent = ancestors[depth - 1];
    if (!parent || depth > ancestors.length) {
      throw new Error("Section depth plan contains an invalid preorder jump");
    }
    const current = clone(flattened[index]!.snapshot);
    parent.children.push(current);
    ancestors.length = depth;
    ancestors[depth] = current;
  }
  return root;
}

function assertSectionElement(value: Y.XmlElement): void {
  if (!(value instanceof Y.XmlElement) || value.nodeName !== SECTION_NODE) {
    throw new Error("Expected a Section Y.XmlElement");
  }
}

function rootSectionFor(section: Y.XmlElement): Y.XmlElement {
  let current = section;
  while (true) {
    const container = current.parent;
    if (
      !(container instanceof Y.XmlElement) ||
      container.nodeName !== SECTION_CHILDREN_NODE
    ) {
      return current;
    }
    const ancestor = container.parent;
    if (
      !(ancestor instanceof Y.XmlElement) ||
      ancestor.nodeName !== SECTION_NODE
    ) {
      throw new Error("Section children container has no parent Section");
    }
    current = ancestor;
  }
}

function requiredContainer(
  section: Y.XmlElement,
  index: number,
  nodeName: string,
): Y.XmlElement {
  const value = section.get(index);
  if (!(value instanceof Y.XmlElement) || value.nodeName !== nodeName) {
    throw new Error(
      `Section ${String(section.get(0) ?? "")} is missing ${nodeName}`,
    );
  }
  return value;
}

function xmlTextContent(value: Y.XmlElement | Y.XmlText): string {
  if (value instanceof Y.XmlText) return yXmlTextVisibleText(value);
  let result = "";
  for (const child of value.toArray()) {
    if (child instanceof Y.XmlElement || child instanceof Y.XmlText) {
      result += xmlTextContent(child);
    }
  }
  return result;
}

function yValueToJson(value: Y.XmlElement | Y.XmlText): unknown {
  if (value instanceof Y.XmlText) {
    return value
      .toDelta()
      .flatMap(
        (delta: { insert: unknown; attributes?: Record<string, unknown> }) => {
          if (typeof delta.insert !== "string" || delta.insert.length === 0) {
            return [];
          }
          const marks = Object.entries(delta.attributes ?? {}).map(
            ([encodedName, attrs]) => {
              const type = encodedName.replace(/--[a-zA-Z0-9+/=]{8}$/u, "");
              return attrs &&
                typeof attrs === "object" &&
                Object.keys(attrs).length > 0
                ? { type, attrs }
                : { type };
            },
          );
          return [
            {
              type: "text",
              text: delta.insert,
              ...(marks.length > 0 ? { marks } : {}),
            },
          ];
        },
      );
  }
  return {
    type: value.nodeName,
    attrs: Object.fromEntries(
      Object.entries(value.getAttributes()).map(([key, item]) => [key, item]),
    ),
    content: value
      .toArray()
      .filter(
        (child): child is Y.XmlElement | Y.XmlText =>
          child instanceof Y.XmlElement || child instanceof Y.XmlText,
      )
      .flatMap((child) => {
        const serialized = yValueToJson(child);
        return Array.isArray(serialized) ? serialized : [serialized];
      }),
  };
}

function yValueFromJson(value: unknown): Y.XmlElement | Y.XmlText {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid serialized Section body value");
  }
  const record = value as {
    type?: unknown;
    text?: unknown;
    attrs?: unknown;
    marks?: unknown;
    content?: unknown;
  };
  if (record.type === "text") {
    const text = new Y.XmlText();
    if (typeof record.text === "string" && record.text) {
      const attributes: Record<string, unknown> = {};
      if (Array.isArray(record.marks)) {
        for (const value of record.marks) {
          if (!value || typeof value !== "object") {
            throw new Error("Invalid serialized Section body mark");
          }
          const mark = value as { type?: unknown; attrs?: unknown };
          if (typeof mark.type !== "string" || !mark.type) {
            throw new Error("Invalid serialized Section body mark");
          }
          if (
            mark.attrs !== undefined &&
            (!mark.attrs || typeof mark.attrs !== "object")
          ) {
            throw new Error("Invalid serialized Section body mark attributes");
          }
          attributes[mark.type] = mark.attrs ?? {};
        }
      }
      text.applyDelta([
        {
          insert: record.text,
          ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        },
      ]);
    }
    return text;
  }
  if (typeof record.type !== "string" || record.type === SECTION_NODE) {
    throw new Error("Invalid serialized Section body node");
  }
  const element = new Y.XmlElement(record.type);
  if (record.attrs && typeof record.attrs === "object") {
    for (const [name, attribute] of Object.entries(record.attrs)) {
      element.setAttribute(name, attribute as string);
    }
  }
  if (Array.isArray(record.content)) {
    element.insert(0, record.content.map(yValueFromJson));
  }
  return element;
}

function remapSectionSnapshot(
  snapshot: SectionSnapshot,
  idMap: ReadonlyMap<string, string>,
): SectionSnapshot {
  const created = new Map<SectionSnapshot, SectionSnapshot>();
  const pending: Array<{ snapshot: SectionSnapshot; visited: boolean }> = [
    { snapshot, visited: false },
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!current.visited) {
      pending.push({ ...current, visited: true });
      for (
        let index = current.snapshot.children.length - 1;
        index >= 0;
        index -= 1
      ) {
        pending.push({
          snapshot: current.snapshot.children[index]!,
          visited: false,
        });
      }
      continue;
    }
    const children = current.snapshot.children.map((child) => {
      const value = created.get(child);
      if (!value) throw new Error("Section snapshot child was not restored");
      return value;
    });
    created.set(current.snapshot, {
      sectionId:
        idMap.get(current.snapshot.sectionId) ?? current.snapshot.sectionId,
      title: current.snapshot.title,
      emoji: current.snapshot.emoji,
      tags: [...current.snapshot.tags],
      body: current.snapshot.body.map((value) =>
        remapInternalLinkJson(value, idMap),
      ),
      children,
    });
  }
  const root = created.get(snapshot);
  if (!root) throw new Error("Section snapshot root was not restored");
  return root;
}

function validateSectionSnapshot(snapshot: SectionSnapshot): void {
  const ids = new Set<string>();
  const pending = [snapshot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    assertUuidV7(current.sectionId, "snapshot Section ID");
    if (ids.has(current.sectionId)) {
      throw new Error(`Duplicate Section ID: ${current.sectionId}`);
    }
    ids.add(current.sectionId);
    validateSectionTitle(current.title);
    validateSectionProperties({
      emoji: current.emoji,
      tags: [...current.tags],
    });
    sectionBodyFromSnapshot(current);
    pending.push(...current.children);
  }
}

function replaceSectionFields(
  target: Y.XmlElement,
  snapshot: SectionSnapshot,
): void {
  updateSectionTitle(target, snapshot.title);
  updateSectionProperties(target, {
    emoji: snapshot.emoji ?? "",
    tags: [...snapshot.tags],
  });
  replaceSectionBodySnapshot(target, snapshot.body);
}

/** Replaces only one Section body while leaving its Header and children live. */
export function replaceSectionBodySnapshot(
  target: Y.XmlElement,
  bodySnapshot: readonly unknown[],
): void {
  const targetBody = sectionBody(target);
  targetBody.delete(0, targetBody.length);
  const body = sectionBodyFromSnapshot({ body: bodySnapshot });
  const chunks = createBodyChunks(body, bodySnapshot.map(approximateJsonBytes));
  if (chunks.length > 0) targetBody.insert(0, chunks);
}

function sectionBodyFromSnapshot(
  snapshot: Pick<SectionSnapshot, "body">,
): Y.XmlElement[] {
  const body = snapshot.body.map((value) => yValueFromJson(value));
  if (body.some((value) => !(value instanceof Y.XmlElement))) {
    throw new Error("Section body root must contain block elements");
  }
  return body as Y.XmlElement[];
}

function remapInternalLinkJson(
  value: unknown,
  idMap: ReadonlyMap<string, string>,
): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as {
    type?: unknown;
    attrs?: unknown;
    content?: unknown;
  };
  const attrs: Record<string, unknown> | unknown =
    record.attrs && typeof record.attrs === "object"
      ? { ...(record.attrs as Record<string, unknown>) }
      : record.attrs;
  if (
    record.type === "internalSectionLink" &&
    attrs &&
    typeof attrs === "object"
  ) {
    const linkAttrs = attrs as Record<string, unknown>;
    const target = linkAttrs.targetSectionId;
    if (typeof target === "string" && idMap.has(target)) {
      linkAttrs.targetSectionId = idMap.get(target)!;
    }
  }
  return {
    ...record,
    ...(attrs === undefined ? {} : { attrs }),
    ...(Array.isArray(record.content)
      ? {
          content: record.content.map((child) =>
            remapInternalLinkJson(child, idMap),
          ),
        }
      : {}),
  };
}
