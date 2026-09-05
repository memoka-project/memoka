import {
  Extension,
  Mark,
  mergeAttributes,
  Node,
  type Editor,
  type NodeViewRendererProps,
} from "@tiptap/core";
import Code from "@tiptap/extension-code";
import Collaboration from "@tiptap/extension-collaboration";
import Image, { type ImageOptions } from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { TableKit } from "@tiptap/extension-table";
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { canSplit, Mapping } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import StarterKit from "@tiptap/starter-kit";
import * as Y from "yjs";
import { createUuidV7, isUuidV7 } from "../core/ids";
import type {
  AttachmentMetadata,
  AttachmentRepository,
} from "../core/attachments";
import { isSafeExternalLink } from "../core/external-links";
import {
  markdownAlertLabel,
  markdownAlertMarker,
  normalizeMarkdownAlertFold,
  normalizeMarkdownAlertTitle,
  normalizeMarkdownAlertType,
} from "../core/markdown-alert";
import {
  markupHeadingLevelForSectionDepth,
  nextMarkupHeadingLevel,
  type MarkupHeadingLevel,
} from "../core/application-theme";
import { NOTE_BLOCK_NODE_NAMES, type NoteDocument } from "../core/documents";
import {
  BODY_CHUNK_HARD_BLOCKS,
  BODY_CHUNK_HARD_BYTES,
  BODY_CHUNK_NODE,
  BODY_CHUNK_TARGET_BLOCKS,
  BODY_CHUNK_TARGET_BYTES,
  findSectionWithDepth,
  SECTION_BODY_NODE,
  SECTION_CHILDREN_NODE,
  SECTION_HEADER_NODE,
  SECTION_NODE,
} from "../core/section-model";
import {
  BODY_CHUNK_VIEWPORT_CHANGED_EVENT,
  type BodyChunkViewportChangedDetail,
} from "./body-chunk-viewport-event";
import { SectionTitleCompositionGuard } from "./section-title-composition";
import { JapaneseLineBreaking } from "./japanese-line-breaking";
import {
  deriveEditorSectionFoldEntries,
  SectionFolding,
  sectionFoldCollapsedSectionIds,
} from "./section-folding";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    memokaDocument: {
      ensureBlockIds: () => ReturnType;
    };
  }
}

export type InternalLinkTitleResolver = (sectionId: string) => string | null;

export type EditorAttachmentRepository = Pick<
  AttachmentRepository,
  "cached" | "previewUrl" | "resolve" | "subscribe"
>;

const ComposableInlineCode = Code.extend({
  excludes: "",
});

const MarkdownHighlight = Mark.create({
  name: "highlight",
  excludes: "",
  parseHTML() {
    return [{ tag: "mark" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "mark",
      mergeAttributes(HTMLAttributes, { "data-memoka-highlight": "true" }),
      0,
    ];
  },
});

const MarkdownAlertAttributes = Extension.create({
  name: "memokaMarkdownAlertAttributes",
  addGlobalAttributes() {
    return [
      {
        types: ["blockquote"],
        attributes: {
          alertType: {
            default: null,
            parseHTML: (element) =>
              normalizeMarkdownAlertType(
                element.getAttribute("data-memoka-alert-type"),
              ),
            renderHTML: (attributes) => {
              const type = normalizeMarkdownAlertType(attributes.alertType);
              if (!type) return {};
              const title = normalizeMarkdownAlertTitle(attributes.alertTitle);
              const fold = normalizeMarkdownAlertFold(attributes.alertFold);
              return {
                "data-memoka-alert-type": type,
                "data-memoka-alert-label": markdownAlertLabel(attributes),
                ...(title ? { "data-memoka-alert-title": title } : {}),
                ...(fold ? { "data-memoka-alert-fold": fold } : {}),
              };
            },
          },
          alertTitle: {
            default: null,
            parseHTML: (element) =>
              normalizeMarkdownAlertTitle(
                element.getAttribute("data-memoka-alert-title"),
              ),
            renderHTML: () => ({}),
          },
          alertFold: {
            default: null,
            parseHTML: (element) =>
              normalizeMarkdownAlertFold(
                element.getAttribute("data-memoka-alert-fold"),
              ),
            renderHTML: () => ({}),
          },
        },
      },
    ];
  },
});

const MEMOKA_BULLET_MARKER_STYLE_COUNT = 6;

export function bulletMarkerStyleForDepth(depth: number): number {
  const normalizedDepth = Number.isSafeInteger(depth) && depth > 0 ? depth : 1;
  return ((normalizedDepth - 1) % MEMOKA_BULLET_MARKER_STYLE_COUNT) + 1;
}

const BulletListMarkers = Extension.create({
  name: "memokaBulletListMarkers",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          nodeViews: {
            bulletList: (node, view, getPos) => {
              const element = view.dom.ownerDocument.createElement("ul");
              let destroyed = false;
              const refreshMarkerStyle = (): void => {
                if (destroyed) return;
                let position: number | undefined;
                try {
                  position = getPos();
                } catch {
                  return;
                }
                if (typeof position !== "number") return;
                const $position = view.state.doc.resolve(position);
                let depth = 1;
                for (
                  let ancestorDepth = 0;
                  ancestorDepth <= $position.depth;
                  ancestorDepth += 1
                ) {
                  const name = $position.node(ancestorDepth).type.name;
                  if (name === "bulletList" || name === "orderedList") {
                    depth += 1;
                  }
                }
                element.dataset.memokaBulletMarker = String(
                  bulletMarkerStyleForDepth(depth),
                );
              };
              queueMicrotask(refreshMarkerStyle);
              return {
                dom: element,
                contentDOM: element,
                update: (nextNode) => {
                  if (nextNode.type !== node.type) return false;
                  node = nextNode;
                  queueMicrotask(refreshMarkerStyle);
                  return true;
                },
                ignoreMutation: (mutation) =>
                  mutation.type === "attributes" &&
                  mutation.target === element &&
                  mutation.attributeName === "data-memoka-bullet-marker",
                destroy: () => {
                  destroyed = true;
                },
              };
            },
          },
        },
      }),
    ];
  },
});

const MemokaExternalLink = Link.extend({
  renderHTML({ HTMLAttributes }) {
    const href =
      typeof HTMLAttributes.href === "string" ? HTMLAttributes.href : "";
    const safeHref = href && isSafeExternalLink(href) ? href : "";
    const authoredTitle =
      typeof HTMLAttributes.title === "string"
        ? HTMLAttributes.title.trim()
        : "";
    const tooltip = safeHref
      ? authoredTitle && authoredTitle !== safeHref
        ? `${authoredTitle}\n${safeHref}`
        : safeHref
      : authoredTitle;
    return [
      "a",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        href: safeHref,
        title: tooltip || null,
      }),
      0,
    ];
  },
});

interface InternalSectionLinkOptions {
  resolveTitle?: InternalLinkTitleResolver;
}

function internalSectionLinkLabel(
  node: ProseMirrorNode,
  resolveTitle?: InternalLinkTitleResolver,
): string {
  const sectionId = node.attrs.targetSectionId;
  const currentTitle =
    typeof sectionId === "string" && sectionId.length > 0
      ? resolveTitle?.(sectionId)
      : null;
  return (currentTitle ?? node.textContent) || "不明なノート";
}

function renderInternalSectionLinkElement(
  element: HTMLElement,
  node: ProseMirrorNode,
  resolveTitle?: InternalLinkTitleResolver,
): void {
  const sectionId = String(node.attrs.targetSectionId ?? "");
  const label = internalSectionLinkLabel(node, resolveTitle);
  element.className = "internal-section-link";
  element.dataset.internalSectionId = sectionId;
  element.dataset.internalLinkAtom = "true";
  element.contentEditable = "false";
  element.draggable = false;
  element.spellcheck = false;
  element.textContent = label;
  element.setAttribute("aria-label", `${label}（内部リンク、gfで開く）`);
  element.title = `gf で開く: ${label}`;
}

export function refreshInternalSectionLinkNodeViews(
  view: Pick<EditorView, "state" | "nodeDOM">,
  resolveTitle?: InternalLinkTitleResolver,
): void {
  view.state.doc.descendants((node, position) => {
    if (node.type.name !== "internalSectionLink") return true;
    const element = view.nodeDOM(position);
    if (element instanceof HTMLElement) {
      renderInternalSectionLinkElement(element, node, resolveTitle);
    }
    return false;
  });
}

export const InternalSectionLink = Node.create<InternalSectionLinkOptions>({
  name: "internalSectionLink",
  inline: true,
  group: "inline",
  content: "text*",
  atom: true,
  selectable: false,
  addOptions() {
    return {};
  },
  addAttributes() {
    return {
      targetSectionId: { default: null },
    };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-internal-section-id]",
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) return false;
          return {
            targetSectionId: element.dataset.internalSectionId ?? null,
          };
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes, node }) {
    const label = internalSectionLinkLabel(node, this.options.resolveTitle);
    return [
      "span",
      {
        "data-internal-section-id": HTMLAttributes.targetSectionId,
        "data-internal-link-atom": "true",
        contenteditable: "false",
        draggable: "false",
        spellcheck: "false",
        "aria-label": `${label}（内部リンク、gfで開く）`,
        title: `gf で開く: ${label}`,
        class: "internal-section-link",
      },
      label,
    ];
  },
  addNodeView() {
    const resolveTitle = this.options.resolveTitle;
    return ({ node }) => {
      const element = document.createElement("span");
      renderInternalSectionLinkElement(element, node, resolveTitle);
      return {
        dom: element,
        update: (nextNode) => {
          if (nextNode.type !== node.type) return false;
          node = nextNode;
          renderInternalSectionLinkElement(element, node, resolveTitle);
          return true;
        },
        ignoreMutation: () => true,
      };
    };
  },
});

interface SectionOptions {
  readonly rootSectionDepth: number;
}

export const Section = Node.create<SectionOptions>({
  name: SECTION_NODE,
  topNode: true,
  content: `${SECTION_HEADER_NODE} ${SECTION_BODY_NODE} ${SECTION_CHILDREN_NODE}`,
  defining: true,
  isolating: true,
  addOptions() {
    return { rootSectionDepth: 0 };
  },
  parseHTML() {
    return [{ tag: "section[data-section]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "section",
      {
        ...HTMLAttributes,
        "data-section": "true",
        class: "memoka-section",
      },
      0,
    ];
  },
  addNodeView() {
    const rootHeadingLevel = markupHeadingLevelForSectionDepth(
      this.options.rootSectionDepth,
    );
    return ({ node }) => {
      const element = document.createElement("section");
      element.className = "memoka-section";
      element.dataset.section = "true";
      let destroyed = false;
      const refreshHeadingLevel = (): void => {
        if (destroyed) return;
        refreshSectionHeadingLevels(element, rootHeadingLevel);
      };
      queueMicrotask(refreshHeadingLevel);
      return {
        dom: element,
        contentDOM: element,
        update: (nextNode) => {
          if (nextNode.type !== node.type) return false;
          node = nextNode;
          queueMicrotask(refreshHeadingLevel);
          return true;
        },
        ignoreMutation: (mutation) =>
          mutation.type === "attributes" &&
          mutation.target === element &&
          mutation.attributeName === "data-memoka-markup-heading",
        destroy: () => {
          destroyed = true;
        },
      };
    };
  },
  addProseMirrorPlugins() {
    const rootSectionDepth = this.options.rootSectionDepth;
    return [
      new Plugin({
        view: (view) => {
          const previous = view.dom.getAttribute("data-memoka-markup-heading");
          applyEditorSectionHeadingDepth(view.dom, rootSectionDepth);
          return {
            destroy: () => {
              if (previous === null) {
                view.dom.removeAttribute("data-memoka-markup-heading");
              } else {
                view.dom.setAttribute("data-memoka-markup-heading", previous);
              }
            },
          };
        },
      }),
    ];
  },
});

export function applyEditorSectionHeadingDepth(
  editorRoot: HTMLElement,
  rootSectionDepth: number,
): void {
  const rootHeadingLevel = markupHeadingLevelForSectionDepth(rootSectionDepth);
  editorRoot.dataset.memokaMarkupHeading = String(rootHeadingLevel);
  for (const section of editorRoot.querySelectorAll<HTMLElement>(
    ".memoka-section",
  )) {
    const parent =
      section.parentElement?.closest<HTMLElement>(".memoka-section");
    const parentLevel = sectionElementHeadingLevel(parent) ?? rootHeadingLevel;
    section.dataset.memokaMarkupHeading = String(
      nextMarkupHeadingLevel(parentLevel),
    );
  }
}

function refreshSectionHeadingLevels(
  root: HTMLElement,
  rootHeadingLevel: MarkupHeadingLevel,
): void {
  const parentSection =
    root.parentElement?.closest<HTMLElement>(".memoka-section");
  const parentLevel =
    sectionElementHeadingLevel(parentSection) ?? rootHeadingLevel;
  const level = nextMarkupHeadingLevel(parentLevel);
  if (root.dataset.memokaMarkupHeading === String(level)) return;
  root.dataset.memokaMarkupHeading = String(level);

  for (const section of root.querySelectorAll<HTMLElement>(".memoka-section")) {
    const parent =
      section.parentElement?.closest<HTMLElement>(".memoka-section");
    const ancestorLevel =
      sectionElementHeadingLevel(parent) ?? rootHeadingLevel;
    section.dataset.memokaMarkupHeading = String(
      nextMarkupHeadingLevel(ancestorLevel),
    );
  }
}

function sectionElementHeadingLevel(
  element: HTMLElement | null | undefined,
): MarkupHeadingLevel | null {
  const level = Number(element?.dataset.memokaMarkupHeading);
  return Number.isSafeInteger(level) && level >= 1 && level <= 6
    ? (level as MarkupHeadingLevel)
    : null;
}

export const SectionHeader = Node.create({
  name: SECTION_HEADER_NODE,
  content: "inline*",
  marks: "",
  defining: true,
  addAttributes() {
    return {
      sectionId: { default: null },
      emoji: { default: null },
      tags: { default: "[]" },
    };
  },
  parseHTML() {
    return [
      {
        tag: "header[data-section-header]",
        getAttrs: (element) =>
          element instanceof HTMLElement
            ? {
                sectionId: element.dataset.sectionId ?? null,
                emoji: element.dataset.sectionEmoji ?? null,
                tags: element.dataset.sectionTags ?? "[]",
              }
            : false,
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "header",
      {
        "data-section-header": "true",
        "data-section-id": HTMLAttributes.sectionId,
        "data-section-emoji": HTMLAttributes.emoji,
        "data-section-tags": HTMLAttributes.tags,
        class: "memoka-section-header",
      },
      0,
    ];
  },
});

export const SectionBody = Node.create({
  name: SECTION_BODY_NODE,
  content: `${BODY_CHUNK_NODE}*`,
  defining: true,
  parseHTML() {
    return [{ tag: "div[data-section-body]" }];
  },
  renderHTML() {
    return [
      "div",
      { "data-section-body": "true", class: "memoka-section-body" },
      0,
    ];
  },
});

interface BodyChunkViewportMeta {
  readonly visibleChunkIds: readonly string[];
}

interface BodyChunkEntry {
  readonly chunkId: string;
  readonly position: number;
  readonly nodeSize: number;
}

interface BodyChunkViewportState {
  readonly visibleChunkIds: readonly string[];
  readonly activeChunkIds: ReadonlySet<string>;
  readonly decorations: DecorationSet;
}

const BODY_CHUNK_VIEWPORT_MARGIN_PX = 640;
const bodyChunkViewportKey = new PluginKey<BodyChunkViewportState>(
  "memokaBodyChunkViewport",
);

function bodyChunkEntries(doc: ProseMirrorNode): BodyChunkEntry[] {
  const entries: BodyChunkEntry[] = [];
  doc.descendants((node, position) => {
    if (node.type.name !== BODY_CHUNK_NODE) return true;
    const chunkId = String(node.attrs.chunkId ?? "");
    if (isUuidV7(chunkId)) {
      entries.push({ chunkId, position, nodeSize: node.nodeSize });
    }
    return false;
  });
  return entries;
}

function nearestBodyChunkIndex(
  entries: readonly BodyChunkEntry[],
  position: number,
): number {
  if (entries.length === 0) return -1;
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const entry = entries[middle]!;
    if (entry.position + entry.nodeSize <= position) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, entries.length - 1);
}

function bodyChunkViewportState(
  state: EditorState,
  visibleChunkIds: readonly string[],
): BodyChunkViewportState {
  const entries = bodyChunkEntries(state.doc);
  const entryIds = new Set(entries.map((entry) => entry.chunkId));
  const required = new Set<string>();
  const headIndex = nearestBodyChunkIndex(entries, state.selection.head);
  const anchorIndex = nearestBodyChunkIndex(entries, state.selection.anchor);
  for (const index of [headIndex - 1, headIndex, headIndex + 1, anchorIndex]) {
    const entry = entries[index];
    if (entry) required.add(entry.chunkId);
  }
  for (const chunkId of visibleChunkIds) {
    if (entryIds.has(chunkId)) required.add(chunkId);
  }
  const decorations: Decoration[] = [];
  for (const entry of entries) {
    if (!required.has(entry.chunkId)) continue;
    decorations.push(
      Decoration.node(
        entry.position,
        entry.position + entry.nodeSize,
        { "data-body-chunk-active": "true" },
        { bodyChunkActive: true },
      ),
    );
  }
  return {
    visibleChunkIds,
    activeChunkIds: required,
    decorations: DecorationSet.create(state.doc, decorations),
  };
}

function bodyChunkIsActive(
  decorations: NodeViewRendererProps["decorations"],
): boolean {
  return decorations.some(
    (decoration) => decoration.spec.bodyChunkActive === true,
  );
}

class BodyChunkViewportRegistry {
  readonly #elements = new Map<HTMLElement, string>();
  readonly #elementsByChunkId = new Map<string, Set<HTMLElement>>();
  readonly #intersecting = new Set<HTMLElement>();
  readonly #visibleChunkIds = new Set<string>();
  #view: EditorView | null = null;
  #observer: IntersectionObserver | null = null;
  #frame: number | null = null;
  #lastVisibleIds = "";

  bind(view: EditorView): void {
    this.#view = view;
    if (typeof IntersectionObserver !== "function") return;
    const root = view.dom.closest<HTMLElement>(".editor-scroll");
    this.#observer = new IntersectionObserver(
      (entries) => {
        let visibilityChanged = false;
        for (const entry of entries) {
          const element = entry.target;
          if (!(element instanceof HTMLElement)) continue;
          const chunkId = this.#elements.get(element);
          if (!chunkId) continue;
          if (entry.isIntersecting) {
            this.#intersecting.add(element);
            if (!this.#visibleChunkIds.has(chunkId)) {
              this.#visibleChunkIds.add(chunkId);
              visibilityChanged = true;
            }
          } else {
            this.#intersecting.delete(element);
            if (
              !this.#hasIntersectingElement(chunkId) &&
              this.#visibleChunkIds.delete(chunkId)
            ) {
              visibilityChanged = true;
            }
          }
        }
        if (visibilityChanged) this.#schedule();
      },
      {
        root,
        rootMargin: `${BODY_CHUNK_VIEWPORT_MARGIN_PX}px 0px`,
      },
    );
    for (const element of this.#elements.keys()) {
      this.#observer.observe(element);
    }
  }

  register(element: HTMLElement, chunkId: string): () => void {
    this.#elements.set(element, chunkId);
    const chunkElements = this.#elementsByChunkId.get(chunkId) ?? new Set();
    chunkElements.add(element);
    this.#elementsByChunkId.set(chunkId, chunkElements);
    this.#observer?.observe(element);
    return () => {
      this.#observer?.unobserve(element);
      this.#elements.delete(element);
      chunkElements.delete(element);
      if (chunkElements.size === 0) this.#elementsByChunkId.delete(chunkId);
      this.#intersecting.delete(element);
      // Decoration changes replace a BodyChunk NodeView. The old visible DOM
      // is destroyed before IntersectionObserver reports the replacement.
      // Publishing in that gap would briefly remove the chunk from the
      // viewport set and alternate active/static rendering every frame. A
      // real viewport exit is reported by IntersectionObserver; document
      // removal is already filtered by bodyChunkViewportState.
      queueMicrotask(() => {
        if (this.#hasRegisteredElement(chunkId)) return;
        if (this.#visibleChunkIds.delete(chunkId)) this.#schedule();
      });
    };
  }

  destroy(): void {
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#observer?.disconnect();
    this.#elements.clear();
    this.#elementsByChunkId.clear();
    this.#intersecting.clear();
    this.#visibleChunkIds.clear();
    this.#view = null;
  }

  #hasRegisteredElement(chunkId: string): boolean {
    return this.#elementsByChunkId.has(chunkId);
  }

  #hasIntersectingElement(chunkId: string): boolean {
    return [...this.#intersecting].some(
      (element) => this.#elements.get(element) === chunkId,
    );
  }

  #schedule(): void {
    if (this.#frame !== null || !this.#view) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#publish();
    });
  }

  #publish(): void {
    const view = this.#view;
    if (!view || view.isDestroyed) return;
    // Every chunk reported inside the viewport margin must stay richly
    // rendered. Capping this set lets a screen containing several short
    // Sections expose the plain-text virtualization preview. Sorting makes
    // the set comparison stable without forcing synchronous layout reads.
    const visibleChunkIds = [...this.#visibleChunkIds].sort();
    const serialized = visibleChunkIds.join("\u0000");
    if (serialized === this.#lastVisibleIds) return;
    this.#lastVisibleIds = serialized;
    const transaction = view.state.tr
      .setMeta(bodyChunkViewportKey, { visibleChunkIds })
      .setMeta("addToHistory", false);
    view.dispatch(transaction);
  }
}

const bodyChunkViewportRegistries = new WeakMap<
  Editor,
  BodyChunkViewportRegistry
>();

function bodyChunkViewportRegistry(editor: Editor): BodyChunkViewportRegistry {
  let registry = bodyChunkViewportRegistries.get(editor);
  if (!registry) {
    registry = new BodyChunkViewportRegistry();
    bodyChunkViewportRegistries.set(editor, registry);
  }
  return registry;
}

function staticTextBlockLines(node: ProseMirrorNode): string[] {
  const text = node.textBetween(0, node.content.size, "\n", "\n");
  return text.split("\n");
}

function staticListLines(node: ProseMirrorNode): string[] {
  const lines: string[] = [];
  let itemNumber = Number(node.attrs.start ?? 1);
  node.forEach((item) => {
    const itemLines: string[] = [];
    item.forEach((child) => itemLines.push(...staticBlockLines(child)));
    if (itemLines.length === 0) itemLines.push("");
    const marker = node.type.name === "orderedList" ? `${itemNumber}.` : "•";
    lines.push(`${marker} ${itemLines[0] ?? ""}`);
    for (const line of itemLines.slice(1)) lines.push(`  ${line}`);
    itemNumber += 1;
  });
  return lines.length > 0 ? lines : [""];
}

function staticTableLines(node: ProseMirrorNode): string[] {
  const lines: string[] = [];
  node.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => {
      cells.push(
        cell
          .textBetween(0, cell.content.size, " ", " ")
          .replace(/\s+/gu, " ")
          .trim(),
      );
    });
    lines.push(cells.join(" | "));
  });
  return lines.length > 0 ? lines : [""];
}

function staticBlockLines(node: ProseMirrorNode): string[] {
  switch (node.type.name) {
    case "bulletList":
    case "orderedList":
      return staticListLines(node);
    case "table":
      return staticTableLines(node);
    case "blockquote": {
      const alertMarker = markdownAlertMarker(node.attrs);
      return [
        ...(alertMarker ? [`> ${alertMarker}`] : []),
        ...(node.content.size === 0
          ? [">"]
          : node.content.content.flatMap((child) =>
              staticBlockLines(child).map((line) => `> ${line}`),
            )),
      ];
    }
    case "horizontalRule":
      return ["────────────────"];
    case "image":
      return [String(node.attrs.alt ?? node.attrs.title ?? "Image")];
    case "attachment":
      return [String(node.attrs.label ?? "Attachment")];
    default:
      if (node.isTextblock) return staticTextBlockLines(node);
      if (node.childCount > 0) {
        return node.content.content.flatMap(staticBlockLines);
      }
      return [node.textContent];
  }
}

function staticBodyChunkLines(node: ProseMirrorNode): string[] {
  const lines = node.content.content.flatMap(staticBlockLines);
  return lines.length > 0 ? lines : [""];
}

function renderStaticBodyChunk(
  element: HTMLElement,
  node: ProseMirrorNode,
): void {
  element.className = "memoka-body-chunk memoka-body-chunk--static";
  element.contentEditable = "false";
  element.replaceChildren();
  const preview = element.ownerDocument.createElement("div");
  preview.className = "memoka-body-chunk__static-content";
  const lines = staticBodyChunkLines(node);
  preview.textContent = lines.join("\n");
  preview.setAttribute("aria-hidden", "true");
  element.style.setProperty("--memoka-body-chunk-rows", String(lines.length));
  element.append(preview);
}

function createBodyChunkNodeView({
  node: initialNode,
  view,
  getPos,
  decorations,
  editor,
}: NodeViewRendererProps) {
  let node = initialNode;
  const active = bodyChunkIsActive(decorations);
  const element = view.dom.ownerDocument.createElement("div");
  const chunkId = String(node.attrs.chunkId ?? "");
  element.dataset.bodyChunk = "true";
  element.dataset.bodyChunkId = chunkId;
  element.dataset.bodyChunkVirtualized = active ? "false" : "true";
  if (active) {
    element.className = "memoka-body-chunk memoka-body-chunk--active";
  } else {
    renderStaticBodyChunk(element, node);
  }
  const unregister = bodyChunkViewportRegistry(editor).register(
    element,
    chunkId,
  );
  const activateAtPointer = (event: PointerEvent): void => {
    if (active || event.button !== 0 || typeof getPos !== "function") return;
    event.preventDefault();
    const coordinates = { left: event.clientX, top: event.clientY };
    const position = getPos();
    if (position === undefined) return;
    const start = position + 1;
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.near(view.state.doc.resolve(start)))
        .setMeta("addToHistory", false),
    );
    view.focus();
    requestAnimationFrame(() => {
      if (view.isDestroyed) return;
      const located = view.posAtCoords(coordinates);
      if (!located) return;
      view.dispatch(
        view.state.tr
          .setSelection(TextSelection.near(view.state.doc.resolve(located.pos)))
          .setMeta("addToHistory", false),
      );
    });
  };
  if (!active) element.addEventListener("pointerdown", activateAtPointer);
  return {
    dom: element,
    ...(active ? { contentDOM: element } : {}),
    update: (
      nextNode: ProseMirrorNode,
      nextDecorations: NodeViewRendererProps["decorations"],
    ) => {
      if (
        nextNode.type !== node.type ||
        bodyChunkIsActive(nextDecorations) !== active ||
        nextNode.attrs.chunkId !== node.attrs.chunkId
      ) {
        return false;
      }
      node = nextNode;
      if (!active) renderStaticBodyChunk(element, node);
      return true;
    },
    ignoreMutation: () => !active,
    stopEvent: (event: Event) => !active && event.type === "pointerdown",
    destroy: () => {
      element.removeEventListener("pointerdown", activateAtPointer);
      unregister();
    },
  };
}

export const BodyChunk = Node.create({
  name: BODY_CHUNK_NODE,
  content: "block*",
  defining: true,
  addAttributes() {
    return {
      chunkId: { default: null },
    };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-body-chunk]",
        getAttrs: (element) =>
          element instanceof HTMLElement
            ? { chunkId: element.dataset.bodyChunkId ?? null }
            : false,
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      {
        "data-body-chunk": "true",
        "data-body-chunk-id": HTMLAttributes.chunkId,
        class: "memoka-body-chunk",
      },
      0,
    ];
  },
  addNodeView() {
    return createBodyChunkNodeView;
  },
});

const BodyChunkViewport = Extension.create({
  name: "memokaBodyChunkViewport",
  priority: 1_130,
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<BodyChunkViewportState>({
        key: bodyChunkViewportKey,
        state: {
          init: (_configuration, state) => bodyChunkViewportState(state, []),
          apply: (transaction, previous, _oldState, newState) => {
            const meta = transaction.getMeta(bodyChunkViewportKey) as
              BodyChunkViewportMeta | undefined;
            if (!transaction.docChanged && !transaction.selectionSet && !meta) {
              return previous;
            }
            return bodyChunkViewportState(
              newState,
              meta?.visibleChunkIds ?? previous.visibleChunkIds,
            );
          },
        },
        props: {
          decorations: (state) =>
            bodyChunkViewportKey.getState(state)?.decorations ?? null,
        },
        view: (view) => {
          const registry = bodyChunkViewportRegistry(editor);
          registry.bind(view);
          let previousActiveChunkIds = new Set(
            bodyChunkViewportKey.getState(view.state)?.activeChunkIds ?? [],
          );
          return {
            update: (nextView) => {
              const activeChunkIds = new Set(
                bodyChunkViewportKey.getState(nextView.state)?.activeChunkIds ??
                  [],
              );
              const changedChunkIds = [
                ...previousActiveChunkIds,
                ...activeChunkIds,
              ].filter(
                (id, index, values) =>
                  values.indexOf(id) === index &&
                  previousActiveChunkIds.has(id) !== activeChunkIds.has(id),
              );
              previousActiveChunkIds = activeChunkIds;
              if (changedChunkIds.length === 0) return;
              const detail: BodyChunkViewportChangedDetail = {
                activeChunkIds: [...activeChunkIds],
                changedChunkIds,
              };
              nextView.dom.dispatchEvent(
                new CustomEvent<BodyChunkViewportChangedDetail>(
                  BODY_CHUNK_VIEWPORT_CHANGED_EVENT,
                  { detail },
                ),
              );
            },
            destroy: () => {
              registry.destroy();
              bodyChunkViewportRegistries.delete(editor);
            },
          };
        },
      }),
    ];
  },
});

/**
 * Test harness top node for exercising direct-body Vim semantics. It is
 * deliberately unavailable to production windows.
 */
const DirectTestDocument = Node.create({
  name: "doc",
  topNode: true,
  content: "block+",
  parseHTML() {
    return [{ tag: "div[data-section-body]" }];
  },
  renderHTML() {
    return [
      "div",
      { "data-section-body": "true", class: "memoka-section-body" },
      0,
    ];
  },
});

export const SectionChildren = Node.create({
  name: SECTION_CHILDREN_NODE,
  content: `${SECTION_NODE}*`,
  defining: true,
  parseHTML() {
    return [{ tag: "div[data-section-children]" }];
  },
  renderHTML() {
    return [
      "div",
      {
        "data-section-children": "true",
        class: "memoka-section-children",
      },
      0,
    ];
  },
});

export const SourceBlock = Node.create({
  name: "sourceBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  addAttributes() {
    return {
      sourceFormat: { default: "markdown" },
    };
  },
  parseHTML() {
    return [
      {
        tag: "pre[data-memoka-source-format]",
        priority: 110,
        preserveWhitespace: "full",
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) return false;
          return {
            sourceFormat: element.dataset.memokaSourceFormat ?? "markdown",
          };
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    const { sourceFormat, ...attributes } = HTMLAttributes;
    return [
      "pre",
      {
        ...attributes,
        "data-memoka-source-format": sourceFormat ?? "markdown",
        class: "memoka-source-block",
      },
      ["code", 0],
    ];
  },
});

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
}

function attachmentMetadataText(metadata: AttachmentMetadata): string {
  return `${metadata.mimeType} · ${formatAttachmentSize(metadata.size)}`;
}

function requestAttachmentMetadata(
  repository: EditorAttachmentRepository | undefined,
  attachmentId: string,
  render: () => void,
): void {
  if (
    !repository ||
    !isUuidV7(attachmentId) ||
    repository.cached(attachmentId)
  ) {
    return;
  }
  void repository.resolve([attachmentId]).then(render, () => undefined);
}

export const AttachmentBlock = Node.create<{
  repository?: EditorAttachmentRepository;
}>({
  name: "attachment",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addOptions() {
    return {};
  },
  addAttributes() {
    return {
      attachmentId: { default: null },
      label: { default: "" },
    };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-memoka-attachment]",
        getAttrs: (element) =>
          element instanceof HTMLElement
            ? {
                attachmentId: element.dataset.attachmentId ?? null,
                label: element.dataset.attachmentLabel ?? "",
              }
            : false,
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      {
        ...HTMLAttributes,
        "data-memoka-attachment": "true",
        "data-attachment-id": HTMLAttributes.attachmentId,
        "data-attachment-label": HTMLAttributes.label,
        class: "memoka-attachment-card",
        contenteditable: "false",
      },
      String(HTMLAttributes.label || "Missing Attachment"),
    ];
  },
  addNodeView() {
    const repository = this.options.repository;
    return ({ node }) => {
      const element = document.createElement("div");
      const icon = document.createElement("span");
      const content = document.createElement("span");
      const name = document.createElement("strong");
      const detail = document.createElement("small");
      element.className = "memoka-attachment-card";
      element.contentEditable = "false";
      element.draggable = false;
      icon.className = "memoka-attachment-card__icon";
      icon.textContent = "📎";
      content.className = "memoka-attachment-card__content";
      name.className = "memoka-attachment-card__name";
      detail.className = "memoka-attachment-card__detail";
      content.append(name, detail);
      element.append(icon, content);
      let unsubscribe: (() => void) | null = null;

      const render = (): void => {
        const attachmentId = String(node.attrs.attachmentId ?? "");
        const metadata = repository?.cached(attachmentId) ?? null;
        element.dataset.memokaAttachment = "true";
        element.dataset.attachmentId = attachmentId;
        element.dataset.attachmentLabel = String(node.attrs.label ?? "");
        element.dataset.attachmentState = metadata?.available
          ? "available"
          : "missing";
        name.textContent =
          String(node.attrs.label ?? "") ||
          metadata?.originalFilename ||
          "Missing Attachment";
        detail.textContent = metadata?.available
          ? attachmentMetadataText(metadata)
          : metadata
            ? "添付ファイルがありません"
            : isUuidV7(attachmentId)
              ? "添付ファイルを確認中…"
              : "添付ファイルがありません";
        element.setAttribute(
          "aria-label",
          `${name.textContent}（添付ファイル、gxで開く）`,
        );
        requestAttachmentMetadata(repository, attachmentId, render);
      };
      unsubscribe =
        repository?.subscribe((attachmentIds) => {
          if (attachmentIds.includes(String(node.attrs.attachmentId ?? ""))) {
            render();
          }
        }) ?? null;
      render();
      return {
        dom: element,
        update: (nextNode) => {
          if (nextNode.type !== node.type) return false;
          node = nextNode;
          render();
          return true;
        },
        ignoreMutation: () => true,
        destroy: () => unsubscribe?.(),
      };
    };
  },
});

const MemokaImage = Image.extend<
  ImageOptions & { repository?: EditorAttachmentRepository }
>({
  addOptions() {
    const parent = this.parent?.();
    return {
      inline: parent?.inline ?? false,
      allowBase64: parent?.allowBase64 ?? false,
      HTMLAttributes: parent?.HTMLAttributes ?? {},
      resize: parent?.resize ?? false,
      repository: undefined,
    };
  },
  addNodeView() {
    const repository = this.options.repository;
    const editor = this.editor;
    return ({ node }) => {
      const element = document.createElement("figure");
      element.className = "memoka-image-node";
      element.contentEditable = "false";
      element.draggable = false;
      let unsubscribe: (() => void) | null = null;
      let resizing: {
        blockId: string;
        startX: number;
        startWidth: number;
        containerWidth: number;
        pointerId: number;
      } | null = null;

      const normalizedWidth = (): number => {
        const value = Number(node.attrs.width);
        return Number.isFinite(value) && value >= 10 && value <= 100
          ? Math.round(value)
          : 100;
      };

      const finishResize = (commit: boolean): void => {
        if (!resizing) return;
        const pending = resizing;
        resizing = null;
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
        window.removeEventListener("keydown", onResizeKeyDown, true);
        element.classList.remove("memoka-image-node--resizing");
        if (!commit) {
          element.style.width = `${pending.startWidth}%`;
          element.dataset.imageWidth = String(pending.startWidth);
          return;
        }
        const width = Number.parseInt(element.dataset.imageWidth ?? "100", 10);
        let position: number | null = null;
        editor.state.doc.descendants((candidate, candidatePosition) => {
          if (
            position === null &&
            candidate.type.name === "image" &&
            candidate.attrs.blockId === pending.blockId
          ) {
            position = candidatePosition;
            return false;
          }
          return position === null;
        });
        if (position === null) {
          element.style.width = `${pending.startWidth}%`;
          element.dataset.imageWidth = String(pending.startWidth);
          return;
        }
        const current = editor.state.doc.nodeAt(position);
        if (!current || current.type.name !== "image") return;
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(position, undefined, {
            ...current.attrs,
            width: width >= 100 ? null : width,
          }),
        );
      };

      const onPointerMove = (event: PointerEvent): void => {
        if (!resizing || event.pointerId !== resizing.pointerId) return;
        const delta = event.clientX - resizing.startX;
        const next = Math.max(
          10,
          Math.min(
            100,
            Math.round(
              ((resizing.startWidth / 100) * resizing.containerWidth + delta) /
                resizing.containerWidth /
                0.01,
            ),
          ),
        );
        element.style.width = `${next}%`;
        element.dataset.imageWidth = String(next);
      };
      const onPointerUp = (event: PointerEvent): void => {
        if (resizing && event.pointerId === resizing.pointerId)
          finishResize(true);
      };
      const onPointerCancel = (event: PointerEvent): void => {
        if (resizing && event.pointerId === resizing.pointerId)
          finishResize(false);
      };
      const onResizeKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        finishResize(false);
      };

      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "memoka-image-resize-handle";
      handle.tabIndex = -1;
      handle.setAttribute("aria-label", "画像幅を変更");
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || resizing) return;
        const containerWidth = element.parentElement?.clientWidth ?? 0;
        const blockId = String(node.attrs.blockId ?? "");
        if (!containerWidth || !blockId) return;
        event.preventDefault();
        event.stopPropagation();
        resizing = {
          blockId,
          startX: event.clientX,
          startWidth: normalizedWidth(),
          containerWidth,
          pointerId: event.pointerId,
        };
        element.dataset.imageWidth = String(resizing.startWidth);
        element.classList.add("memoka-image-node--resizing");
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerCancel);
        window.addEventListener("keydown", onResizeKeyDown, true);
      });

      const render = (): void => {
        const attachmentId = String(node.attrs.attachmentId ?? "");
        const validAttachmentId = isUuidV7(attachmentId);
        const metadata = repository?.cached(attachmentId) ?? null;
        const previewUrl =
          metadata?.previewable && metadata.available
            ? repository?.previewUrl(attachmentId)
            : null;
        const next = previewUrl
          ? document.createElement("img")
          : document.createElement("div");
        next.contentEditable = "false";
        next.draggable = false;
        next.dataset.attachmentId = attachmentId;
        next.dataset.attachmentState = previewUrl
          ? "available"
          : metadata
            ? "missing"
            : validAttachmentId
              ? "loading"
              : "reference";
        if (next instanceof HTMLImageElement && previewUrl) {
          next.className = "memoka-image-block";
          next.alt = String(node.attrs.alt ?? metadata?.originalFilename ?? "");
          next.addEventListener(
            "error",
            () => {
              if (element.firstChild !== next) return;
              const missing = document.createElement("div");
              missing.className = "memoka-image-stub";
              missing.contentEditable = "false";
              missing.dataset.attachmentId = attachmentId;
              missing.dataset.attachmentState = "missing";
              missing.dataset.placeholder = "Missing or damaged Attachment";
              missing.setAttribute("data-memoka-image", "true");
              element.dataset.attachmentState = "missing";
              element.replaceChildren(missing, handle);
            },
            { once: true },
          );
          next.src = previewUrl;
        } else {
          next.className = "memoka-image-stub";
          next.dataset.placeholder =
            attachmentId === "attachment:missing"
              ? String(node.attrs.alt ?? "Image Block stub")
              : metadata?.available === false
                ? "Missing Attachment"
                : validAttachmentId
                  ? "画像を確認中…"
                  : String(node.attrs.alt ?? "External Image");
        }
        next.setAttribute("data-memoka-image", "true");
        next.setAttribute(
          "aria-label",
          `${String(node.attrs.alt ?? metadata?.originalFilename ?? "画像")}（画像添付）`,
        );
        element.dataset.attachmentId = attachmentId;
        element.dataset.attachmentState = next.dataset.attachmentState;
        const width = normalizedWidth();
        element.dataset.imageWidth = String(width);
        element.style.width = `${width}%`;
        element.replaceChildren(next, handle);
        requestAttachmentMetadata(repository, attachmentId, render);
      };
      unsubscribe =
        repository?.subscribe((attachmentIds) => {
          if (attachmentIds.includes(String(node.attrs.attachmentId ?? ""))) {
            render();
          }
        }) ?? null;
      render();
      return {
        dom: element,
        update: (nextNode) => {
          if (nextNode.type !== node.type) return false;
          node = nextNode;
          render();
          return true;
        },
        ignoreMutation: () => true,
        destroy: () => {
          finishResize(false);
          unsubscribe?.();
        },
      };
    };
  },
});

const BLOCK_NODE_NAMES = NOTE_BLOCK_NODE_NAMES;

function mapPastedBlockIdentities(fragment: Fragment): Fragment {
  const children: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      children.push(node);
      return;
    }
    const content =
      node.content.size > 0
        ? mapPastedBlockIdentities(node.content)
        : node.content;
    const attributes = BLOCK_NODE_NAMES.has(node.type.name)
      ? { ...node.attrs, blockId: createUuidV7() }
      : node.attrs;
    children.push(node.type.create(attributes, content, node.marks));
  });
  return Fragment.fromArray(children);
}

/**
 * Clipboard content belongs to a new structural location, so every pasted
 * block receives a fresh identity before the replace transaction is applied.
 * This avoids following a large paste with one setNodeMarkup transaction per
 * block and also prevents IDs copied from another NoteDoc from leaking in.
 */
export function freshBlockIdsInSlice(slice: Slice): Slice {
  return new Slice(
    mapPastedBlockIdentities(slice.content),
    slice.openStart,
    slice.openEnd,
  );
}

function changedNodePositions(
  after: ProseMirrorNode,
  transactions: readonly Transaction[],
  matches: (node: ProseMirrorNode) => boolean,
): number[] {
  const positions = new Set<number>();
  const steps = transactions.flatMap((transaction) =>
    transaction.steps.map((step, index) => ({
      step,
      map: transaction.mapping.maps[index]!,
    })),
  );
  const inspectFinalRange = (start: number, end: number): void => {
    const lower = Math.min(start, end);
    const upper = Math.max(start, end);
    const from = Math.max(0, lower - 1);
    const to = Math.min(after.content.size, Math.max(from + 1, upper + 1));
    after.nodesBetween(from, to, (node, position) => {
      if (matches(node)) positions.add(position);
      return true;
    });
  };
  for (let index = 0; index < steps.length; index += 1) {
    const toFinal = new Mapping();
    for (let later = index + 1; later < steps.length; later += 1) {
      toFinal.appendMap(steps[later]!.map);
    }
    let mappedRange = false;
    steps[index]!.map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      mappedRange = true;
      inspectFinalRange(toFinal.map(newStart, -1), toFinal.map(newEnd, 1));
    });
    if (mappedRange) continue;
    // Attribute and mark Steps can change a document with an empty StepMap.
    const json = steps[index]!.step.toJSON() as Record<string, unknown>;
    const from =
      typeof json.pos === "number"
        ? json.pos
        : typeof json.from === "number"
          ? json.from
          : null;
    const to =
      typeof json.pos === "number"
        ? json.pos
        : typeof json.to === "number"
          ? json.to
          : from;
    if (from !== null && to !== null) {
      inspectFinalRange(toFinal.map(from, -1), toFinal.map(to, 1));
    }
  }
  return [...positions];
}

function bodyChunkSplitOffsets(node: ProseMirrorNode): number[] {
  const approximateBytes =
    new TextEncoder().encode(node.textContent).byteLength +
    node.childCount * 64;
  if (
    node.childCount <= BODY_CHUNK_HARD_BLOCKS &&
    approximateBytes <= BODY_CHUNK_HARD_BYTES
  ) {
    return [];
  }
  const offsets: number[] = [];
  let pendingBlocks = 0;
  let pendingBytes = 0;
  node.forEach((child, offset) => {
    const childBytes =
      new TextEncoder().encode(child.textContent).byteLength + 64;
    if (
      pendingBlocks > 0 &&
      (pendingBlocks >= BODY_CHUNK_TARGET_BLOCKS ||
        pendingBytes + childBytes > BODY_CHUNK_TARGET_BYTES)
    ) {
      offsets.push(offset);
      pendingBlocks = 0;
      pendingBytes = 0;
    }
    pendingBlocks += 1;
    pendingBytes += childBytes;
  });
  return offsets;
}

const BodyChunking = Extension.create({
  name: "memokaBodyChunking",
  priority: 1_125,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) {
            return null;
          }
          const positions = changedNodePositions(
            newState.doc,
            transactions,
            (node) => node.type.name === BODY_CHUNK_NODE,
          ).sort((left, right) => right - left);
          if (positions.length === 0) return null;
          const transaction = newState.tr;
          let changed = false;
          for (const position of positions) {
            const node = newState.doc.nodeAt(position);
            if (!node || node.type.name !== BODY_CHUNK_NODE) continue;
            const mappedPosition = transaction.mapping.map(position, -1);
            if (node.childCount === 0) {
              transaction.delete(
                mappedPosition,
                transaction.mapping.map(position + node.nodeSize, 1),
              );
              changed = true;
              continue;
            }
            if (!isUuidV7(String(node.attrs.chunkId ?? ""))) {
              transaction.setNodeMarkup(mappedPosition, undefined, {
                ...node.attrs,
                chunkId: createUuidV7(),
              });
              changed = true;
            }
            for (const offset of bodyChunkSplitOffsets(node).reverse()) {
              const splitPosition = transaction.mapping.map(
                position + 1 + offset,
                1,
              );
              const typesAfter = [
                {
                  type: node.type,
                  attrs: { ...node.attrs, chunkId: createUuidV7() },
                },
              ];
              if (!canSplit(transaction.doc, splitPosition, 1, typesAfter)) {
                continue;
              }
              transaction.split(splitPosition, 1, typesAfter);
              changed = true;
            }
          }
          return changed ? transaction : null;
        },
      }),
    ];
  },
});

const BLOCK_IDENTITY_REPAIR_META = "memoka:block-identity-repair";

function blockIdentity(
  node: ProseMirrorNode | null | undefined,
): string | null {
  if (!node || !BLOCK_NODE_NAMES.has(node.type.name)) return null;
  const value = node.attrs.blockId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mappedHistoricalBlockIds(
  before: ProseMirrorNode,
  after: ProseMirrorNode,
  mapping: Mapping,
): ReadonlyMap<number, string> {
  const result = new Map<number, string>();
  before.descendants((node, position) => {
    const id = blockIdentity(node);
    if (!id) return true;
    // Map the old node start forward. At an insertion boundary, assoc=1 maps
    // the old block past the insertion and therefore never assigns its ID to
    // the fresh block placed immediately before it.
    const mapped = mapping.mapResult(position, 1);
    if (mapped.deleted) return true;
    const survivingBlock = after.nodeAt(mapped.pos);
    if (blockIdentity(survivingBlock)) result.set(mapped.pos, id);
    return true;
  });
  return result;
}

const BlockIdentity = Extension.create({
  name: "memokaBlockIdentity",
  priority: 1100,
  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_NODE_NAMES],
        attributes: {
          blockId: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-block-id"),
            renderHTML: (attributes) =>
              attributes.blockId
                ? { "data-block-id": String(attributes.blockId) }
                : {},
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      ensureBlockIds:
        () =>
        ({ state, dispatch }) => {
          const transaction = state.tr;
          let changed = false;
          state.doc.descendants((node, position) => {
            const missingBlockId =
              BLOCK_NODE_NAMES.has(node.type.name) && !node.attrs.blockId;
            if (missingBlockId) {
              const attributes = { ...node.attrs };
              if (missingBlockId) attributes.blockId = createUuidV7();
              transaction.setNodeMarkup(position, undefined, attributes);
              changed = true;
            }
          });
          if (changed && dispatch) dispatch(transaction);
          return changed;
        },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          transformPasted: freshBlockIdsInSlice,
        },
        appendTransaction: (transactions, oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) {
            return null;
          }
          if (
            transactions.some((transaction) =>
              transaction.getMeta(BLOCK_IDENTITY_REPAIR_META),
            )
          ) {
            return null;
          }
          const mapping = new Mapping();
          for (const transaction of transactions) {
            mapping.appendMapping(transaction.mapping);
          }
          const historicalIds = mappedHistoricalBlockIds(
            oldState.doc,
            newState.doc,
            mapping,
          );
          const changedPositions = changedNodePositions(
            newState.doc,
            transactions,
            (node) => BLOCK_NODE_NAMES.has(node.type.name),
          );
          const changedIds = new Set<string>();
          const identityAtRisk = changedPositions.some((position) => {
            const node = newState.doc.nodeAt(position);
            const currentId = blockIdentity(node);
            if (!node || !currentId || changedIds.has(currentId)) return true;
            changedIds.add(currentId);
            return !historicalIds.has(position);
          });
          if (!identityAtRisk) return null;

          const blocks: Array<{
            node: ProseMirrorNode;
            position: number;
            currentId: string | null;
            historicalId: string | null;
          }> = [];
          newState.doc.descendants((node, position) => {
            if (!BLOCK_NODE_NAMES.has(node.type.name)) return true;
            blocks.push({
              node,
              position,
              currentId: blockIdentity(node),
              historicalId: historicalIds.get(position) ?? null,
            });
            return true;
          });
          const protectedHistoricalIds = new Set(
            blocks.flatMap(({ historicalId }) =>
              historicalId ? [historicalId] : [],
            ),
          );
          const seen = new Set<string>();
          const transaction = newState.tr.setMeta(
            BLOCK_IDENTITY_REPAIR_META,
            true,
          );
          let changed = false;
          for (const { node, position, currentId, historicalId } of blocks) {
            let nextId =
              historicalId && !seen.has(historicalId)
                ? historicalId
                : currentId &&
                    !seen.has(currentId) &&
                    !protectedHistoricalIds.has(currentId)
                  ? currentId
                  : null;
            if (!nextId) {
              do nextId = createUuidV7();
              while (seen.has(nextId) || protectedHistoricalIds.has(nextId));
            }
            seen.add(nextId);
            if (nextId === currentId) continue;
            transaction.setNodeMarkup(position, undefined, {
              ...node.attrs,
              blockId: nextId,
            });
            changed = true;
          }
          return changed ? transaction : null;
        },
      }),
    ];
  },
});

function sectionHeaderId(
  node: ProseMirrorNode | null | undefined,
): string | null {
  if (node?.type.name !== SECTION_HEADER_NODE) return null;
  const value = node.attrs.sectionId;
  return typeof value === "string" && isUuidV7(value) ? value : null;
}

function changedSectionHeaderPositions(
  after: ProseMirrorNode,
  transactions: readonly Transaction[],
): number[] {
  return changedNodePositions(
    after,
    transactions,
    (node) => node.type.name === SECTION_HEADER_NODE,
  );
}

function mappedHistoricalSectionId(
  before: ProseMirrorNode,
  afterHeader: ProseMirrorNode,
  afterPosition: number,
  inverseMapping: Mapping,
): string | null {
  const mapped = inverseMapping.mapResult(afterPosition, 1);
  const oldHeader = before.nodeAt(mapped.pos);
  const oldId = sectionHeaderId(oldHeader);
  if (!oldHeader || !oldId) return null;
  // A node-markup transaction replaces the wrapper token even though the
  // Section itself survives. Equal Header content distinguishes that case
  // from a generic structural replacement. The mounted root is always the
  // same conceptual Section and must retain the Note ID.
  if (
    afterPosition === 0 ||
    !mapped.deleted ||
    oldHeader.content.eq(afterHeader.content)
  ) {
    return oldId;
  }
  return null;
}

/**
 * Section IDs are structural identities, including when a rich paste replaces
 * the whole visible subtree. The changed range is inspected first so ordinary
 * body typing remains proportional to the edited text rather than the full
 * NoteDoc. Only a Header insertion/replacement or identity mismatch invokes
 * the full uniqueness normalizer.
 */
const SectionIdentity = Extension.create({
  name: "memokaSectionIdentity",
  priority: 1_150,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) {
            return null;
          }
          const mapping = new Mapping();
          for (const transaction of transactions) {
            mapping.appendMapping(transaction.mapping);
          }
          const inverseMapping = mapping.invert();
          const changedHeaders = changedSectionHeaderPositions(
            newState.doc,
            transactions,
          );
          const identityAtRisk = changedHeaders.some((position) => {
            const header = newState.doc.nodeAt(position);
            if (!header || header.type.name !== SECTION_HEADER_NODE)
              return true;
            const currentId = sectionHeaderId(header);
            if (!currentId) return true;
            const mapped = inverseMapping.mapResult(position, 1);
            const oldHeader = oldState.doc.nodeAt(mapped.pos);
            const oldId = sectionHeaderId(oldHeader);
            return (
              !oldHeader ||
              oldHeader.type.name !== SECTION_HEADER_NODE ||
              mapped.deleted ||
              (oldId !== null && oldId !== currentId)
            );
          });
          if (!identityAtRisk) return null;

          const headers: Array<{
            node: ProseMirrorNode;
            position: number;
            currentId: string | null;
            historicalId: string | null;
          }> = [];
          newState.doc.descendants((node, position) => {
            if (node.type.name !== SECTION_HEADER_NODE) return true;
            headers.push({
              node,
              position,
              currentId: sectionHeaderId(node),
              historicalId: mappedHistoricalSectionId(
                oldState.doc,
                node,
                position,
                inverseMapping,
              ),
            });
            return true;
          });
          const protectedHistoricalIds = new Set(
            headers.flatMap(({ historicalId }) =>
              historicalId ? [historicalId] : [],
            ),
          );
          const seen = new Set<string>();
          const transaction = newState.tr;
          let changed = false;
          for (const { node, position, currentId, historicalId } of headers) {
            let nextId =
              historicalId && !seen.has(historicalId)
                ? historicalId
                : currentId &&
                    !seen.has(currentId) &&
                    !protectedHistoricalIds.has(currentId)
                  ? currentId
                  : null;
            if (!nextId) {
              do nextId = createUuidV7();
              while (seen.has(nextId) || protectedHistoricalIds.has(nextId));
            }
            seen.add(nextId);
            if (nextId !== currentId) {
              transaction.setNodeMarkup(position, undefined, {
                ...node.attrs,
                sectionId: nextId,
              });
              changed = true;
            }
          }
          return changed ? transaction : null;
        },
      }),
    ];
  },
});

function sectionTitlePlaceholders(noteId: string): Extension {
  return Extension.create({
    name: "memokaSectionTitlePlaceholders",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            decorations(state) {
              const decorations: Decoration[] = [];
              for (const entry of deriveEditorSectionFoldEntries(state.doc)) {
                const header = state.doc.nodeAt(entry.headerFrom);
                if (header?.content.size === 0) {
                  const rootTitle = entry.sectionId === noteId;
                  decorations.push(
                    Decoration.node(entry.headerFrom, entry.headerTo, {
                      [rootTitle
                        ? "data-note-title-placeholder"
                        : "data-section-title-placeholder"]: rootTitle
                        ? "新しいノート"
                        : "無題のセクション",
                    }),
                  );
                }
              }
              return decorations.length > 0
                ? DecorationSet.create(state.doc, decorations)
                : DecorationSet.empty;
            },
          },
        }),
      ];
    },
  });
}

const AttachmentIdentity = Extension.create({
  name: "memokaAttachmentIdentity",
  addGlobalAttributes() {
    return [
      {
        types: ["image"],
        attributes: {
          attachmentId: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-attachment-id"),
            renderHTML: (attributes) =>
              attributes.attachmentId
                ? { "data-attachment-id": String(attributes.attachmentId) }
                : {},
          },
          alignment: {
            default: "center",
            parseHTML: (element) =>
              element.getAttribute("data-alignment") ?? "center",
            renderHTML: (attributes) => ({
              "data-alignment": String(attributes.alignment ?? "center"),
            }),
          },
          width: {
            default: null,
            parseHTML: (element) => {
              const raw = element.getAttribute("data-width");
              return raw ? Number(raw) : null;
            },
            renderHTML: (attributes) =>
              attributes.width
                ? { "data-width": String(attributes.width) }
                : {},
          },
        },
      },
    ];
  },
});

const TableShortcuts = Extension.create({
  name: "memokaTableShortcuts",
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-9": () =>
        this.editor.commands.insertTable({
          rows: 3,
          cols: 3,
          withHeaderRow: true,
        }),
    };
  },
});

const SectionEditing = Extension.create({
  name: "memokaSectionEditing",
  priority: 2_000,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleTextInput: (view, from, to, text) => {
            if (text !== " " || from !== to) return false;
            const { state } = view;
            const $from = state.doc.resolve(from);
            const chunkDepth = $from.depth - 1;
            const bodyDepth = $from.depth - 2;
            const sectionDepth = $from.depth - 3;
            if (
              $from.parent.type.name !== "paragraph" ||
              $from.parentOffset !== 1 ||
              $from.parent.textContent !== "#" ||
              $from.depth < 3 ||
              $from.node(chunkDepth).type.name !== BODY_CHUNK_NODE ||
              $from.node(bodyDepth).type.name !== SECTION_BODY_NODE ||
              $from.node(sectionDepth).type.name !== SECTION_NODE
            ) {
              return false;
            }
            const body = $from.node(bodyDepth);
            const section = $from.node(sectionDepth);
            const sectionType = state.schema.nodes[SECTION_NODE];
            const headerType = state.schema.nodes[SECTION_HEADER_NODE];
            const bodyType = state.schema.nodes[SECTION_BODY_NODE];
            const childrenType = state.schema.nodes[SECTION_CHILDREN_NODE];
            if (!sectionType || !headerType || !bodyType || !childrenType) {
              return false;
            }
            const newSectionId = createUuidV7();
            const childHeader = headerType.create({
              sectionId: newSectionId,
              emoji: null,
              tags: "[]",
            });
            const childBody = bodyType.create(
              null,
              body.content.cut(
                $from.after($from.depth) - $from.start(bodyDepth),
              ),
            );
            const childChildren = childrenType.create();
            const newChild = sectionType.create(null, [
              childHeader,
              childBody,
              childChildren,
            ]);
            const paragraphStart = $from.before($from.depth);
            const bodyEnd = $from.end(bodyDepth);
            const childrenContentStart =
              $from.start(sectionDepth) +
              section.child(0).nodeSize +
              section.child(1).nodeSize +
              1;
            const transaction = state.tr;
            // Keep the parent header, body prefix and existing child Sections
            // integrated. Only the paragraph boundary and the body suffix
            // whose ownership actually changes are recreated under the new
            // child Section. Replacing the whole Section here made a local
            // "# " command emit a document-sized Yjs update.
            transaction.delete(paragraphStart, bodyEnd);
            transaction.insert(
              transaction.mapping.map(childrenContentStart, -1),
              newChild,
            );
            let headerPosition: number | null = null;
            transaction.doc.descendants((node, position) => {
              if (
                headerPosition === null &&
                node.type.name === SECTION_HEADER_NODE &&
                node.attrs.sectionId === newSectionId
              ) {
                headerPosition = position + 1;
                return false;
              }
              return headerPosition === null;
            });
            if (headerPosition !== null) {
              transaction.setSelection(
                TextSelection.near(transaction.doc.resolve(headerPosition)),
              );
            }
            transaction.setMeta("memoka.section.create", newSectionId);
            view.dispatch(transaction);
            return true;
          },
          handleKeyDown: (view, event) => {
            if (event.key !== "Enter" || event.isComposing) return false;
            const { state } = view;
            const { $from, $to } = state.selection;
            if (
              $from.parent.type.name !== SECTION_HEADER_NODE ||
              $to.parent !== $from.parent ||
              $from.depth < 1 ||
              $from.node($from.depth - 1).type.name !== SECTION_NODE
            ) {
              return false;
            }
            const sectionDepth = $from.depth - 1;
            const section = $from.node(sectionDepth);
            const header = $from.parent;
            const sectionId = String(header.attrs.sectionId ?? "");
            if (sectionFoldCollapsedSectionIds(state).includes(sectionId)) {
              return true;
            }
            const headerType = state.schema.nodes[SECTION_HEADER_NODE];
            const bodyType = state.schema.nodes[SECTION_BODY_NODE];
            const paragraphType = state.schema.nodes.paragraph;
            const chunkType = state.schema.nodes[BODY_CHUNK_NODE];
            const sectionType = state.schema.nodes[SECTION_NODE];
            if (
              !headerType ||
              !bodyType ||
              !paragraphType ||
              !chunkType ||
              !sectionType
            ) {
              return false;
            }
            const prefix = header.content.cut(0, $from.parentOffset);
            const suffix = header.content.cut($to.parentOffset);
            const blockId = createUuidV7();
            const paragraph = paragraphType.create({ blockId }, suffix);
            const nextHeader = headerType.create(header.attrs, prefix);
            const nextBody = bodyType.create(null, [
              chunkType.create({ chunkId: createUuidV7() }, paragraph),
              ...section.child(1).content.content,
            ]);
            const replacement = sectionType.create(section.attrs, [
              nextHeader,
              nextBody,
              section.child(2),
            ]);
            const transaction = state.tr;
            if (sectionDepth === 0) {
              transaction.replaceWith(
                0,
                state.doc.content.size,
                replacement.content,
              );
            } else {
              const start = $from.before(sectionDepth);
              transaction.replaceWith(
                start,
                start + section.nodeSize,
                replacement,
              );
            }
            let paragraphPosition: number | null = null;
            transaction.doc.descendants((node, position) => {
              if (
                paragraphPosition === null &&
                node.attrs.blockId === blockId
              ) {
                paragraphPosition = position + 1;
                return false;
              }
              return paragraphPosition === null;
            });
            if (paragraphPosition !== null) {
              transaction.setSelection(
                TextSelection.near(transaction.doc.resolve(paragraphPosition)),
              );
            }
            view.dispatch(transaction.scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});

export function productEditorExtensions(
  note: NoteDocument,
  options: {
    resolveInternalLinkTitle?: InternalLinkTitleResolver;
    focusedSectionId?: string;
    /** Unit-test harness only: bind the Root Section's direct body. */
    directBodyOnly?: boolean;
    /** Read-only transient views must never own or destroy NoteDoc history. */
    readOnly?: boolean;
    attachmentRepository?: EditorAttachmentRepository;
    /** Window-local Section fold state; never persisted into the NoteDoc. */
    collapsedSectionIds?: readonly string[];
  } = {},
) {
  const focusedSection = options.directBodyOnly
    ? null
    : options.focusedSectionId
      ? findSectionWithDepth(note.rootSection, options.focusedSectionId)
      : { element: note.rootSection, depth: 0 };
  const fragment = options.directBodyOnly
    ? directBodyTestFragment(note)
    : focusedSection?.element;
  if (!fragment) {
    throw new Error(`Unknown focused Section: ${options.focusedSectionId}`);
  }
  return [
    StarterKit.configure({
      code: false,
      document: false,
      heading: false,
      link: false,
      undoRedo: false,
      trailingNode: false,
    }),
    MarkdownAlertAttributes,
    ComposableInlineCode,
    MarkdownHighlight,
    MemokaExternalLink.configure({
      autolink: false,
      defaultProtocol: "https",
      linkOnPaste: false,
      openOnClick: false,
      isAllowedUri: (href) => isSafeExternalLink(href),
    }),
    ...(options.directBodyOnly
      ? [DirectTestDocument]
      : [
          Section.configure({
            rootSectionDepth: focusedSection?.depth ?? 0,
          }),
          SectionHeader,
          SectionBody,
          BodyChunk,
          SectionChildren,
        ]),
    ...(!options.directBodyOnly ? [sectionTitlePlaceholders(note.noteId)] : []),
    ...(!options.directBodyOnly && !options.readOnly
      ? [
          SectionFolding.configure({
            collapsedSectionIds: options.collapsedSectionIds ?? [],
          }),
        ]
      : []),
    TableKit.configure({
      table: {
        resizable: false,
        allowTableNodeSelection: true,
        HTMLAttributes: { class: "memoka-table" },
      },
      tableRow: {
        HTMLAttributes: { class: "memoka-table-row" },
      },
      tableCell: {
        HTMLAttributes: { class: "memoka-table-cell" },
      },
      tableHeader: {
        HTMLAttributes: { class: "memoka-table-header" },
      },
    }),
    MemokaImage.configure({
      inline: false,
      allowBase64: false,
      repository: options.attachmentRepository,
    }),
    AttachmentBlock.configure({ repository: options.attachmentRepository }),
    InternalSectionLink.configure({
      resolveTitle: options.resolveInternalLinkTitle,
    }),
    SourceBlock,
    ...(!options.directBodyOnly ? [SectionTitleCompositionGuard] : []),
    SectionIdentity,
    ...(!options.directBodyOnly ? [BodyChunkViewport, BodyChunking] : []),
    JapaneseLineBreaking,
    BulletListMarkers,
    BlockIdentity,
    AttachmentIdentity,
    TableShortcuts,
    SectionEditing,
    Collaboration.configure({
      fragment,
      yUndoOptions: {
        undoManager: options.readOnly
          ? undefined
          : options.directBodyOnly
            ? directBodyTestUndoManager(fragment)
            : note.undoManager,
      },
    }),
  ];
}

const DIRECT_BODY_TEST_FRAGMENT = "__memoka_vim_test_body";
const directBodyTestUndoManagers = new WeakMap<Y.XmlFragment, Y.UndoManager>();

/**
 * Legacy Vim unit tests need a conventional flat ProseMirror document. Keep
 * that fixture in an explicitly test-only Y.Fragment so binding it cannot
 * rewrite the parent Root Section's header attributes. Production never sets
 * `directBodyOnly` and therefore never creates this fragment.
 */
function directBodyTestFragment(note: NoteDocument): Y.XmlFragment {
  const fragment = note.doc.getXmlFragment(DIRECT_BODY_TEST_FRAGMENT);
  if (fragment.length > 0) return fragment;
  const blocks = note.body
    .toArray()
    .flatMap((value) => (value instanceof Y.XmlElement ? [value.clone()] : []));
  if (blocks.length > 0) fragment.insert(0, blocks);
  return fragment;
}

function directBodyTestUndoManager(fragment: Y.XmlFragment): Y.UndoManager {
  let manager = directBodyTestUndoManagers.get(fragment);
  if (!manager) {
    manager = new Y.UndoManager(fragment, {
      captureTimeout: 500,
      trackedOrigins: new Set([ySyncPluginKey]),
    });
    directBodyTestUndoManagers.set(fragment, manager);
  }
  return manager;
}
