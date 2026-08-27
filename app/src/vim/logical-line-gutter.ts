import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { BODY_CHUNK_NODE } from "../core/section-model";
import {
  BODY_CHUNK_VIEWPORT_CHANGED_EVENT,
  type BodyChunkViewportChangedDetail,
} from "../editor/body-chunk-viewport-event";
import {
  defaultVimBlockSemantics,
  type VimLogicalLineAnchor,
} from "./block-semantics";
import { measureVimCharacterCell } from "./caret-geometry";

interface VimLineRect {
  top: number;
  bottom: number;
  height: number;
}

interface LogicalLineLayoutItem {
  anchor: VimLogicalLineAnchor;
  bodyChunkId: string | null;
  element: HTMLElement | null;
  indexInBlock: number;
}

interface BodyChunkRange {
  id: string;
  from: number;
  to: number;
}

interface DeferredPositionShift {
  startIndex: number;
  delta: number;
}

const blockSemantics = defaultVimBlockSemantics;
const GUTTER_OVERSCAN_PX = 80;
const MAX_DEFERRED_POSITION_SHIFTS = 64;
const MAX_LAYOUT_UNAVAILABLE_GUTTER_LINES = 256;

export function vimRelativeLineNumberValue(
  absolute: number,
  currentAbsolute: number,
): number {
  return absolute === currentAbsolute
    ? absolute
    : Math.abs(absolute - currentAbsolute);
}

function asHTMLElement(node: Node | null): HTMLElement | null {
  return node?.nodeType === 1 ? (node as HTMLElement) : null;
}

function lineHeightOf(element: HTMLElement): number {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const parsed = Number.parseFloat(style?.lineHeight ?? "");
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const fontSize = Number.parseFloat(style?.fontSize ?? "");
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.2 : 20;
}

function normalizedRect(rect: {
  top: number;
  bottom: number;
  height?: number;
}): VimLineRect {
  const height = Math.max(1, rect.height ?? rect.bottom - rect.top);
  return {
    top: rect.top,
    bottom: rect.top + height,
    height,
  };
}

function mapAnchor(
  anchor: VimLogicalLineAnchor,
  delta: number,
): VimLogicalLineAnchor {
  if (delta === 0) return anchor;
  return {
    ...anchor,
    from: anchor.from + delta,
    to: anchor.to + delta,
    blockFrom: anchor.blockFrom + delta,
    blockTo: anchor.blockTo + delta,
    blockPosition: anchor.blockPosition + delta,
  };
}

export class VimLogicalLineGutter {
  private view: EditorView;
  private readonly host: HTMLElement;
  private readonly gutter: HTMLDivElement;
  private readonly scrollRoot: HTMLElement | null;
  private readonly intersectionObserver: IntersectionObserver | null;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly bodyChunkViewportListener: EventListener;
  private readonly observedElements = new Set<HTMLElement>();
  private readonly visibleElements = new Set<HTMLElement>();
  private readonly indicesByElement = new Map<HTMLElement, number[]>();
  private readonly indicesByBodyChunkId = new Map<string, number[]>();
  private readonly pendingBodyChunkIds = new Set<string>();
  private readonly bodyChunkRefreshRetries = new Map<string, number>();
  private activeBodyChunkIds = new Set<string>();
  private items: LogicalLineLayoutItem[] = [];
  private positionShifts: DeferredPositionShift[] = [];
  private cursor: number;
  private modelDirty = true;
  private renderDirty = true;
  private renderedCurrentIndex = -1;
  private frame: number | null = null;

  constructor(view: EditorView, cursor: number) {
    this.view = view;
    this.cursor = cursor;
    this.host = view.dom.parentElement ?? view.dom;
    this.host.classList.add("memoka-editor-host");
    this.gutter = view.dom.ownerDocument.createElement("div");
    this.gutter.className = "memoka-logical-line-gutter";
    this.gutter.setAttribute("aria-hidden", "true");
    this.host.append(this.gutter);
    this.scrollRoot = view.dom.closest<HTMLElement>(".editor-scroll");

    if (typeof IntersectionObserver === "function") {
      this.intersectionObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const element = asHTMLElement(entry.target);
            if (!element) continue;
            if (entry.isIntersecting) this.visibleElements.add(element);
            else this.visibleElements.delete(element);
          }
          this.renderDirty = true;
          this.schedule();
        },
        {
          root: this.scrollRoot,
          rootMargin: `${GUTTER_OVERSCAN_PX}px 0px`,
        },
      );
    } else {
      this.intersectionObserver = null;
    }

    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => {
        this.renderDirty = true;
        this.schedule();
      });
      this.resizeObserver.observe(view.dom);
    } else {
      this.resizeObserver = null;
    }

    this.bodyChunkViewportListener = (event) => {
      const detail = (event as CustomEvent<BodyChunkViewportChangedDetail>)
        .detail;
      if (!detail) return;
      this.activeBodyChunkIds = new Set(detail.activeChunkIds);
      for (const id of detail.changedChunkIds) {
        this.queueBodyChunkRefresh(id);
      }
      this.schedule();
    };
    view.dom.addEventListener(
      BODY_CHUNK_VIEWPORT_CHANGED_EVENT,
      this.bodyChunkViewportListener,
    );

    this.schedule();
  }

  update(view: EditorView, previous: EditorState, cursor: number): void {
    this.view = view;
    this.cursor = cursor;
    if (
      previous.doc !== view.state.doc &&
      !this.patchSingleSemanticBlock(previous)
    ) {
      this.modelDirty = true;
    }
    this.schedule();
  }

  refreshCursor(cursor: number): void {
    if (this.cursor === cursor) return;
    this.cursor = cursor;
    this.schedule();
  }

  destroy(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.intersectionObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.view.dom.removeEventListener(
      BODY_CHUNK_VIEWPORT_CHANGED_EVENT,
      this.bodyChunkViewportListener,
    );
    this.gutter.remove();
    if (
      !this.host.querySelector(
        ".memoka-logical-line-gutter, .memoka-visual-line-overlay",
      )
    ) {
      this.host.classList.remove("memoka-editor-host");
    }
  }

  private schedule(): void {
    const rangePrototype =
      this.view.dom.ownerDocument.defaultView?.Range?.prototype;
    if (typeof rangePrototype?.getClientRects !== "function") {
      this.refresh();
      return;
    }
    // Coalesce into the first pending frame and render from the latest view.
    // Cancelling and re-queuing here makes line-number work (and the caret
    // frame behind it) wait until rapid input stops.
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.refresh();
    });
  }

  private refresh(): void {
    if (this.view.isDestroyed || !this.host.isConnected) return;
    if (this.modelDirty && this.rebuildModel()) this.renderDirty = true;
    if (this.refreshPendingBodyChunkElements()) this.renderDirty = true;
    const currentIndex = this.currentLineIndex(this.cursor);
    this.refreshCurrentChunkElements(currentIndex);
    if (currentIndex !== this.renderedCurrentIndex) this.renderDirty = true;
    if (!this.renderDirty) return;
    this.render(currentIndex);
  }

  private rebuildModel(): boolean {
    const previousItems = this.items;
    const anchors = blockSemantics.logicalLineAnchors({
      state: this.view.state,
    });
    const bodyChunks: BodyChunkRange[] = [];
    this.view.state.doc.descendants((node, position) => {
      if (node.type.name !== BODY_CHUNK_NODE) return true;
      const id = String(node.attrs.chunkId ?? "");
      if (id) {
        bodyChunks.push({ id, from: position, to: position + node.nodeSize });
      }
      return false;
    });
    const indices = new Map<number, number>();
    let bodyChunkIndex = 0;
    this.items = anchors.map((anchor) => {
      while (
        bodyChunkIndex < bodyChunks.length &&
        anchor.blockPosition >= bodyChunks[bodyChunkIndex]!.to
      ) {
        bodyChunkIndex += 1;
      }
      const bodyChunk = bodyChunks[bodyChunkIndex];
      const bodyChunkId =
        bodyChunk &&
        anchor.blockPosition >= bodyChunk.from &&
        anchor.blockPosition < bodyChunk.to
          ? bodyChunk.id
          : null;
      const indexInBlock = indices.get(anchor.blockPosition) ?? 0;
      indices.set(anchor.blockPosition, indexInBlock + 1);
      return {
        anchor,
        bodyChunkId,
        element: this.elementForAnchor(anchor),
        indexInBlock,
      };
    });
    this.positionShifts = [];
    const topologyChanged =
      previousItems.length !== this.items.length ||
      this.items.some((item, index) => {
        const previous = previousItems[index];
        return (
          !previous ||
          previous.element !== item.element ||
          previous.bodyChunkId !== item.bodyChunkId ||
          previous.indexInBlock !== item.indexInBlock ||
          previous.anchor.kind !== item.anchor.kind ||
          previous.anchor.blockNodeName !== item.anchor.blockNodeName
        );
      });
    this.syncObservedElements();
    this.activeBodyChunkIds = this.mountedActiveBodyChunkIds();
    this.pendingBodyChunkIds.clear();
    this.bodyChunkRefreshRetries.clear();
    this.modelDirty = false;
    return topologyChanged;
  }

  private elementForAnchor(anchor: VimLogicalLineAnchor): HTMLElement | null {
    const element = asHTMLElement(this.view.nodeDOM(anchor.blockPosition));
    if (!element || !this.view.dom.contains(element)) return null;
    const bodyChunk = element.closest<HTMLElement>("[data-body-chunk]");
    if (bodyChunk?.dataset.bodyChunkVirtualized === "true") return null;
    return element;
  }

  private refreshPendingBodyChunkElements(): boolean {
    if (this.pendingBodyChunkIds.size === 0) return false;
    const pendingIds = [...this.pendingBodyChunkIds];
    this.pendingBodyChunkIds.clear();
    const changedIndices = new Set<number>();
    const previousElements = new Set<HTMLElement>();
    for (const id of pendingIds) {
      let activeElementUnavailable = false;
      for (const index of this.indicesByBodyChunkId.get(id) ?? []) {
        const item = this.items[index];
        if (!item) continue;
        const element = this.elementForAnchor(this.resolvedAnchor(index));
        if (!element && this.activeBodyChunkIds.has(id)) {
          activeElementUnavailable = true;
        }
        if (element === item.element) continue;
        if (item.element) previousElements.add(item.element);
        item.element = element;
        changedIndices.add(index);
      }
      if (activeElementUnavailable) {
        const retries = this.bodyChunkRefreshRetries.get(id) ?? 0;
        if (retries < 2) {
          this.bodyChunkRefreshRetries.set(id, retries + 1);
          this.pendingBodyChunkIds.add(id);
          continue;
        }
      }
      this.bodyChunkRefreshRetries.delete(id);
    }
    if (changedIndices.size > 0) {
      this.syncChangedElements(changedIndices, previousElements);
    }
    if (this.pendingBodyChunkIds.size > 0) this.schedule();
    return changedIndices.size > 0;
  }

  private queueBodyChunkRefresh(id: string): void {
    this.pendingBodyChunkIds.add(id);
    if (!this.bodyChunkRefreshRetries.has(id)) {
      this.bodyChunkRefreshRetries.set(id, 0);
    }
  }

  private mountedActiveBodyChunkIds(): Set<string> {
    const chunkIds = new Set<string>();
    for (const element of this.view.dom.querySelectorAll<HTMLElement>(
      '[data-body-chunk-id][data-body-chunk-virtualized="false"]',
    )) {
      const id = element.dataset.bodyChunkId;
      if (id) chunkIds.add(id);
    }
    return chunkIds;
  }

  /**
   * Text input normally changes one semantic block. Patch that block and map
   * later anchor positions by the document-size delta instead of traversing
   * every Section/body node in a large note. Structural edits and ambiguous
   * diffs deliberately fall back to the full semantic rebuild.
   */
  private patchSingleSemanticBlock(previous: EditorState): boolean {
    if (this.modelDirty || this.items.length === 0) return false;
    const nextDoc = this.view.state.doc;
    const start = previous.doc.content.findDiffStart(nextDoc.content);
    if (start === null) return true;
    const end = previous.doc.content.findDiffEnd(nextDoc.content);
    if (!end) return false;
    const previousItemIndex = this.currentLineIndex(start);
    if (previousItemIndex < 0) return false;
    const previousItem = this.resolvedItem(previousItemIndex);
    if (
      start < previousItem.anchor.blockFrom ||
      start > previousItem.anchor.blockTo
    ) {
      return false;
    }
    const previousBlockPosition = previousItem.anchor.blockPosition;
    const previousBlock = previous.doc.nodeAt(previousBlockPosition);
    if (!previousBlock) return false;

    const delta = nextDoc.content.size - previous.doc.content.size;
    const nextBlockPosition =
      previousBlockPosition <= start
        ? previousBlockPosition
        : previousBlockPosition + delta;
    const nextBlock = nextDoc.nodeAt(nextBlockPosition);
    if (
      !nextBlock ||
      nextBlock.type !== previousBlock.type ||
      nextBlock.attrs.blockId !== previousBlock.attrs.blockId
    ) {
      return false;
    }
    const previousBlockEnd = previousBlockPosition + previousBlock.nodeSize;
    const nextBlockEnd = nextBlockPosition + nextBlock.nodeSize;
    if (end.a > previousBlockEnd || end.b > nextBlockEnd) return false;

    const replacementAnchors = blockSemantics.logicalLineAnchorsForNode(
      { state: this.view.state },
      nextBlock,
      nextBlockPosition,
    );
    if (!replacementAnchors) return false;
    let first = previousItemIndex;
    while (
      first > 0 &&
      this.resolvedAnchor(first - 1).blockPosition === previousBlockPosition
    ) {
      first -= 1;
    }
    let last = previousItemIndex;
    while (
      last + 1 < this.items.length &&
      this.resolvedAnchor(last + 1).blockPosition === previousBlockPosition
    ) {
      last += 1;
    }
    if (replacementAnchors.length !== last - first + 1) return false;

    const replacementElement = replacementAnchors[0]
      ? this.elementForAnchor(replacementAnchors[0])
      : null;
    const existingShift = this.positionShiftAt(first);
    const changedElementIndices = new Set<number>();
    const previousElements = new Set<HTMLElement>();
    replacementAnchors.forEach((anchor, indexInBlock) => {
      const index = first + indexInBlock;
      const previousElement = this.items[index]?.element ?? null;
      if (previousElement !== replacementElement) {
        if (previousElement) previousElements.add(previousElement);
        changedElementIndices.add(index);
      }
      this.items[first + indexInBlock] = {
        anchor: mapAnchor(anchor, -existingShift),
        bodyChunkId: previousItem.bodyChunkId,
        element: replacementElement,
        indexInBlock,
      };
    });
    if (last + 1 < this.items.length && delta !== 0) {
      const previousShift = this.positionShifts.at(-1);
      if (previousShift?.startIndex === last + 1) previousShift.delta += delta;
      else this.positionShifts.push({ startIndex: last + 1, delta });
      if (this.positionShifts.length >= MAX_DEFERRED_POSITION_SHIFTS) {
        this.materializePositionShifts();
      }
    }
    if (changedElementIndices.size > 0) {
      this.syncChangedElements(changedElementIndices, previousElements);
    }
    return true;
  }

  private positionShiftAt(index: number): number {
    let shift = 0;
    for (const entry of this.positionShifts) {
      if (entry.startIndex > index) continue;
      shift += entry.delta;
    }
    return shift;
  }

  private resolvedAnchor(index: number): VimLogicalLineAnchor {
    return mapAnchor(this.items[index]!.anchor, this.positionShiftAt(index));
  }

  private resolvedItem(index: number): LogicalLineLayoutItem {
    const item = this.items[index]!;
    return { ...item, anchor: this.resolvedAnchor(index) };
  }

  private materializePositionShifts(): void {
    if (this.positionShifts.length === 0) return;
    this.items = this.items.map((item, index) => ({
      ...item,
      anchor: mapAnchor(item.anchor, this.positionShiftAt(index)),
    }));
    this.positionShifts = [];
  }

  private currentLineIndex(position: number): number {
    if (this.items.length === 0) return 0;
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.resolvedAnchor(middle).from <= position) low = middle + 1;
      else high = middle;
    }
    const index = Math.max(0, low - 1);
    const candidate = this.resolvedAnchor(index);
    if (
      position <= candidate.to ||
      (position >= candidate.blockPosition && position < candidate.blockTo)
    ) {
      return index;
    }
    return Math.min(index + 1, this.items.length - 1);
  }

  private syncObservedElements(): void {
    const nextElements = new Set(
      this.items
        .map(({ element }) => element)
        .filter((element): element is HTMLElement => element !== null),
    );
    for (const element of this.observedElements) {
      if (nextElements.has(element)) continue;
      this.intersectionObserver?.unobserve(element);
      this.observedElements.delete(element);
      this.visibleElements.delete(element);
    }
    for (const element of nextElements) {
      if (this.observedElements.has(element)) continue;
      this.observedElements.add(element);
      if (this.intersectionObserver) this.intersectionObserver.observe(element);
      else this.visibleElements.add(element);
    }
    this.indicesByElement.clear();
    this.indicesByBodyChunkId.clear();
    this.items.forEach(({ bodyChunkId, element }, index) => {
      if (bodyChunkId) {
        const chunkIndices = this.indicesByBodyChunkId.get(bodyChunkId) ?? [];
        chunkIndices.push(index);
        this.indicesByBodyChunkId.set(bodyChunkId, chunkIndices);
      }
      if (!element) return;
      const indices = this.indicesByElement.get(element) ?? [];
      indices.push(index);
      this.indicesByElement.set(element, indices);
    });
  }

  private syncChangedElements(
    changedIndices: ReadonlySet<number>,
    previousElements: ReadonlySet<HTMLElement>,
  ): void {
    for (const element of previousElements) {
      const remaining = (this.indicesByElement.get(element) ?? []).filter(
        (index) =>
          !changedIndices.has(index) && this.items[index]?.element === element,
      );
      if (remaining.length > 0) {
        this.indicesByElement.set(element, remaining);
        continue;
      }
      this.indicesByElement.delete(element);
      this.intersectionObserver?.unobserve(element);
      this.observedElements.delete(element);
      this.visibleElements.delete(element);
    }
    for (const index of changedIndices) {
      const element = this.items[index]?.element;
      if (!element) continue;
      const indices = this.indicesByElement.get(element) ?? [];
      if (!indices.includes(index)) {
        indices.push(index);
        this.indicesByElement.set(element, indices);
      }
      if (this.observedElements.has(element)) continue;
      this.observedElements.add(element);
      if (this.intersectionObserver) this.intersectionObserver.observe(element);
      else this.visibleElements.add(element);
    }
  }

  private refreshCurrentChunkElements(currentIndex: number): void {
    const current = this.items[currentIndex];
    if (!current) return;
    const anchor = this.resolvedAnchor(currentIndex);
    const bounded = Math.max(
      0,
      Math.min(anchor.blockPosition, this.view.state.doc.content.size),
    );
    const $position = this.view.state.doc.resolve(bounded);
    let chunkFrom = -1;
    let chunkTo = -1;
    for (let depth = $position.depth; depth > 0; depth -= 1) {
      const node = $position.node(depth);
      if (node.type.name !== "bodyChunk") continue;
      chunkFrom = $position.before(depth);
      chunkTo = chunkFrom + node.nodeSize;
      break;
    }
    if (chunkFrom < 0) return;
    const changedIndices = new Set<number>();
    const previousElements = new Set<HTMLElement>();
    let index = currentIndex;
    while (index > 0 && this.resolvedAnchor(index - 1).from >= chunkFrom) {
      index -= 1;
    }
    for (; index < this.items.length; index += 1) {
      const item = this.items[index]!;
      const resolved = this.resolvedAnchor(index);
      if (resolved.blockPosition >= chunkTo) break;
      const element = this.elementForAnchor(resolved);
      if (element === item.element) continue;
      if (item.element) previousElements.add(item.element);
      item.element = element;
      changedIndices.add(index);
    }
    if (changedIndices.size > 0) {
      this.syncChangedElements(changedIndices, previousElements);
    }
  }

  private render(currentIndex: number): void {
    if (this.items.length === 0) {
      this.gutter.replaceChildren();
      this.renderedCurrentIndex = -1;
      this.renderDirty = false;
      return;
    }
    const currentAbsolute = currentIndex + 1;
    const hostRect = this.host.getBoundingClientRect();
    const layoutUnavailable = hostRect.width === 0 && hostRect.height === 0;
    const viewportRect = this.scrollRoot?.getBoundingClientRect() ?? null;
    const markers: HTMLElement[] = [];
    const candidateIndices = layoutUnavailable
      ? this.layoutUnavailableCandidateIndices(currentIndex)
      : [
          ...new Set([
            currentIndex,
            ...[...this.visibleElements].flatMap(
              (element) => this.indicesByElement.get(element) ?? [],
            ),
          ]),
        ].sort((left, right) => left - right);

    for (const index of candidateIndices) {
      const item = this.resolvedItem(index);
      const current = index === currentIndex;
      if (
        item.element &&
        !current &&
        !layoutUnavailable &&
        !this.visibleElements.has(item.element)
      ) {
        continue;
      }
      const row = this.anchorRect(item);
      if (!row || (!current && !this.isVisible(row, viewportRect))) continue;
      const absolute = index + 1;
      const relative = Math.abs(absolute - currentAbsolute);
      const marker = this.gutter.ownerDocument.createElement("span");
      marker.className = `memoka-logical-line-number${current ? " memoka-logical-line-number--current" : ""}`;
      marker.dataset.logicalLineNumber = String(absolute);
      marker.dataset.logicalLineKind = item.anchor.kind;
      marker.dataset.logicalLineBlockPosition = String(
        item.anchor.blockPosition,
      );
      marker.dataset.logicalLineIndexInBlock = String(item.indexInBlock);
      marker.dataset.relativeLineNumber = String(relative);
      marker.dataset.displayLineNumber = String(
        vimRelativeLineNumberValue(absolute, currentAbsolute),
      );
      marker.style.top = `${row.top - hostRect.top}px`;
      marker.style.height = `${Math.max(1, row.height)}px`;
      marker.textContent = marker.dataset.displayLineNumber;
      markers.push(marker);
    }
    const fragment = this.gutter.ownerDocument.createDocumentFragment();
    fragment.append(...markers);
    this.gutter.replaceChildren(fragment);
    this.renderedCurrentIndex = currentIndex;
    this.renderDirty = false;
  }

  private layoutUnavailableCandidateIndices(currentIndex: number): number[] {
    if (this.items.length <= MAX_LAYOUT_UNAVAILABLE_GUTTER_LINES) {
      return this.items.map((_item, index) => index);
    }
    const maximumStart =
      this.items.length - MAX_LAYOUT_UNAVAILABLE_GUTTER_LINES;
    const start = Math.max(
      0,
      Math.min(
        currentIndex - Math.floor(MAX_LAYOUT_UNAVAILABLE_GUTTER_LINES / 2),
        maximumStart,
      ),
    );
    return Array.from(
      { length: MAX_LAYOUT_UNAVAILABLE_GUTTER_LINES },
      (_item, index) => start + index,
    );
  }

  private anchorRect(item: LogicalLineLayoutItem): VimLineRect | null {
    const measured = measureVimCharacterCell(this.view, item.anchor.from);
    if (measured) {
      return {
        top: measured.top,
        bottom: measured.top + measured.height,
        height: measured.height,
      };
    }
    try {
      return normalizedRect(this.view.coordsAtPos(item.anchor.from, 1));
    } catch {
      if (!item.element) return null;
      const rect = item.element.getBoundingClientRect();
      const height = lineHeightOf(item.element);
      return {
        top: rect.top,
        bottom: rect.top + height,
        height,
      };
    }
  }

  private isVisible(row: VimLineRect, viewport: DOMRect | null): boolean {
    if (!viewport || (viewport.width === 0 && viewport.height === 0)) {
      return true;
    }
    return (
      row.bottom >= viewport.top - GUTTER_OVERSCAN_PX &&
      row.top <= viewport.bottom + GUTTER_OVERSCAN_PX
    );
  }
}
