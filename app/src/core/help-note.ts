import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import helpMarkdown from "../../../doc/help.md?raw";
import { parseMarkdownNote } from "../editor/markdown-paste";
import { productMarkdownImportSchema } from "../editor/extensions";
import { createUuidV7 } from "./ids";
import type { SectionSnapshot } from "./section-model";

export const MEMOKA_HELP_TITLE = "Memoka help";
export const MEMOKA_HELP_MARKDOWN = helpMarkdown;

interface HelpSectionDraft {
  readonly sectionId: string;
  readonly title: string;
  readonly sectionKey: string;
  readonly body: readonly unknown[];
  readonly children: readonly HelpSectionDraft[];
}

/**
 * Import the user-facing Markdown resource with the same parser and schema as
 * normal whole-note paste. IDs are then replaced with deterministic values so
 * repeated :help synchronization updates one stable managed Note tree.
 */
export function createMemokaHelpSectionSnapshot(
  noteId: string,
): SectionSnapshot {
  const parsed = parseMarkdownNote(
    helpMarkdown,
    productMarkdownImportSchema(),
    noteId,
  );
  if (!parsed) {
    throw new Error("doc/help.mdをMemoka Noteとして読み込めません");
  }
  if (parsed.title !== MEMOKA_HELP_TITLE) {
    throw new Error(
      `doc/help.mdのH1は「${MEMOKA_HELP_TITLE}」でなければなりません`,
    );
  }
  if (parsed.sourceBlockCount > 0) {
    throw new Error("doc/help.mdに未対応のMarkdown blockがあります");
  }

  const anchors = new Map<string, string>();
  const draft = helpSectionDraft(parsed.root, noteId, [], anchors);
  return finalizeHelpSection(draft, noteId, anchors);
}

function helpSectionDraft(
  section: ProseMirrorNode,
  noteId: string,
  path: readonly number[],
  anchors: Map<string, string>,
): HelpSectionDraft {
  if (section.type.name !== "section" || section.childCount !== 3) {
    throw new Error("doc/help.mdから不正なSection構造が生成されました");
  }
  const header = section.child(0);
  const body = section.child(1);
  const children = section.child(2);
  if (
    header.type.name !== "sectionHeader" ||
    body.type.name !== "sectionBody" ||
    children.type.name !== "sectionChildren"
  ) {
    throw new Error("doc/help.mdから不正なSection構造が生成されました");
  }

  const title = header.textContent;
  const anchor = normalizeHelpAnchor(title);
  const sectionKey =
    path.length === 0 ? "section:root" : `section:${path.join(".")}:${anchor}`;
  const sectionId =
    path.length === 0 ? noteId : stableHelpId(noteId, sectionKey);
  if (!anchor || anchors.has(anchor)) {
    throw new Error(
      `doc/help.mdの見出しanchorが空または重複しています: ${title}`,
    );
  }
  anchors.set(anchor, sectionId);

  const blocks: unknown[] = [];
  for (let chunkIndex = 0; chunkIndex < body.childCount; chunkIndex += 1) {
    const chunk = body.child(chunkIndex);
    if (chunk.type.name !== "bodyChunk") {
      throw new Error("doc/help.mdから不正なBodyChunkが生成されました");
    }
    for (let blockIndex = 0; blockIndex < chunk.childCount; blockIndex += 1) {
      blocks.push(chunk.child(blockIndex).toJSON());
    }
  }

  const childDrafts: HelpSectionDraft[] = [];
  for (let index = 0; index < children.childCount; index += 1) {
    childDrafts.push(
      helpSectionDraft(
        children.child(index),
        noteId,
        [...path, index],
        anchors,
      ),
    );
  }
  return {
    sectionId,
    title,
    sectionKey,
    body: blocks,
    children: childDrafts,
  };
}

function finalizeHelpSection(
  draft: HelpSectionDraft,
  noteId: string,
  anchors: ReadonlyMap<string, string>,
): SectionSnapshot {
  return {
    sectionId: draft.sectionId,
    title: draft.title,
    tags: [],
    body: draft.body.map((block, index) =>
      stabilizeHelpNode(
        block,
        noteId,
        `${draft.sectionKey}:body:${index}`,
        anchors,
      ),
    ),
    children: draft.children.map((child) =>
      finalizeHelpSection(child, noteId, anchors),
    ),
  };
}

function stabilizeHelpNode(
  value: unknown,
  noteId: string,
  key: string,
  anchors: ReadonlyMap<string, string>,
): unknown {
  if (!value || typeof value !== "object") return value;
  const node = value as {
    readonly type?: unknown;
    readonly text?: unknown;
    readonly attrs?: unknown;
    readonly marks?: unknown;
    readonly content?: unknown;
  };
  const type = typeof node.type === "string" ? node.type : "unknown";
  const marks = Array.isArray(node.marks)
    ? node.marks.map((mark) => cloneHelpValue(mark))
    : [];
  const internalLink = marks.findIndex((mark) => {
    if (!mark || typeof mark !== "object") return false;
    const candidate = mark as { type?: unknown; attrs?: unknown };
    if (candidate.type !== "link" || !candidate.attrs) return false;
    const href = (candidate.attrs as { href?: unknown }).href;
    return typeof href === "string" && href.startsWith("#");
  });
  if (type === "text" && internalLink >= 0) {
    const link = marks[internalLink] as {
      readonly attrs?: { readonly href?: unknown };
    };
    const href = String(link.attrs?.href ?? "");
    const targetSectionId = anchors.get(normalizeHelpAnchor(href));
    if (!targetSectionId) {
      throw new Error(`doc/help.mdの内部link先が見つかりません: ${href}`);
    }
    const remainingMarks = marks.filter((_, index) => index !== internalLink);
    return {
      type: "internalSectionLink",
      attrs: { targetSectionId },
      content: [
        {
          type: "text",
          text: typeof node.text === "string" ? node.text : "",
          ...(remainingMarks.length > 0 ? { marks: remainingMarks } : {}),
        },
      ],
    };
  }

  const attrs =
    node.attrs && typeof node.attrs === "object"
      ? { ...(node.attrs as Record<string, unknown>) }
      : undefined;
  if (attrs && Object.hasOwn(attrs, "blockId")) {
    attrs.blockId = stableHelpId(noteId, `${key}:${type}`);
  }
  const content = Array.isArray(node.content)
    ? node.content.map((child, index) =>
        stabilizeHelpNode(child, noteId, `${key}:${index}`, anchors),
      )
    : undefined;
  return {
    ...node,
    ...(attrs ? { attrs } : {}),
    ...(marks.length > 0 ? { marks } : {}),
    ...(content ? { content } : {}),
  };
}

function cloneHelpValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneHelpValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneHelpValue(child)]),
  );
}

function normalizeHelpAnchor(value: string): string {
  const fragment = value.startsWith("#") ? value.slice(1) : value;
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    // Keep the literal fragment so the error points at the authored link.
  }
  return decoded
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replaceAll(/\s+/gu, "-");
}

function stableHelpId(noteId: string, semanticKey: string): string {
  const compact = noteId.replaceAll("-", "");
  const timestamp = Number.parseInt(compact.slice(0, 12), 16);
  let state = hashString(`${noteId}\u0000${semanticKey}`) || 0x9e3779b9;
  return createUuidV7(timestamp, (target) => {
    for (let index = 0; index < target.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      target[index] = state >>> ((index % 4) * 8);
    }
    return target;
  });
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
