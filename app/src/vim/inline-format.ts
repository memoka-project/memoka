import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Selection } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type {
  InlineFormatAction,
  InlineMarkFormat,
} from "../core/inline-formats";
import { normalizeExternalLink } from "../core/external-links";

const SUPPORTED_MARKS = [
  "italic",
  "bold",
  "strike",
  "code",
  "link",
  "highlight",
] as const;
const DISALLOWED_BLOCKS = new Set([
  "sectionHeader",
  "codeBlock",
  "sourceBlock",
  "image",
]);

export interface InlineFormatSelection {
  readonly document: ProseMirrorNode;
  readonly selection: Selection;
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly existingHref: string | null;
}

export type InlineFormatResult =
  | {
      readonly changed: true;
      readonly from: number;
      readonly action: InlineFormatAction;
    }
  | {
      readonly changed: false;
      readonly reason:
        | "missing"
        | "stale"
        | "empty"
        | "unsupported-block"
        | "link-multiple-blocks"
        | "link-internal-atom"
        | "invalid-link"
        | "no-op";
    };

interface SelectionContent {
  readonly textNodes: readonly ProseMirrorNode[];
  readonly textRanges: readonly {
    readonly from: number;
    readonly to: number;
  }[];
  readonly textBlockPositions: ReadonlySet<number>;
  readonly containsInternalLink: boolean;
  readonly containsDisallowedBlock: boolean;
}

export function captureInlineFormatSelection(
  view: EditorView,
): InlineFormatSelection | null {
  const { selection, doc } = view.state;
  if (selection.empty) return null;
  const content = inspectSelection(doc, selection.from, selection.to);
  if (content.textNodes.length === 0) return null;
  return {
    document: doc,
    selection,
    from: selection.from,
    to: selection.to,
    text: doc.textBetween(selection.from, selection.to, "\n", "\uFFFC"),
    existingHref: uniformLinkHref(content.textNodes),
  };
}

export function runInlineFormatCommand(
  view: EditorView,
  target: InlineFormatSelection,
  action: InlineFormatAction,
): InlineFormatResult {
  if (view.isDestroyed) return { changed: false, reason: "missing" };
  if (
    view.state.doc !== target.document ||
    !view.state.selection.eq(target.selection)
  ) {
    return { changed: false, reason: "stale" };
  }
  const content = inspectSelection(view.state.doc, target.from, target.to);
  if (content.textNodes.length === 0) {
    return { changed: false, reason: "empty" };
  }
  if (content.containsDisallowedBlock) {
    return { changed: false, reason: "unsupported-block" };
  }
  const normalizedLink =
    action.kind === "link" ? normalizeExternalLink(action.href) : null;
  if (action.kind === "link") {
    if (!normalizedLink?.valid) {
      return { changed: false, reason: "invalid-link" };
    }
    if (content.containsInternalLink) {
      return { changed: false, reason: "link-internal-atom" };
    }
    if (content.textBlockPositions.size !== 1) {
      return { changed: false, reason: "link-multiple-blocks" };
    }
  }
  const canonicalHref = normalizedLink?.valid ? normalizedLink.href : null;

  const { schema } = view.state;
  const transaction = view.state.tr;
  if (action.kind === "clear") {
    for (const name of SUPPORTED_MARKS) {
      const mark = schema.marks[name];
      if (!mark) continue;
      for (const range of content.textRanges) {
        transaction.removeMark(range.from, range.to, mark);
      }
    }
  } else {
    const markName =
      action.kind === "link" ? "link" : markNameFor(action.format);
    const markType = schema.marks[markName];
    if (!markType) return { changed: false, reason: "missing" };
    if (
      action.kind === "link"
        ? uniformLinkHref(content.textNodes) === canonicalHref
        : content.textNodes.every((node) =>
            node.marks.some(({ type }) => type === markType),
          )
    ) {
      return { changed: false, reason: "no-op" };
    }
    if (action.kind === "link") {
      for (const range of content.textRanges) {
        transaction.removeMark(range.from, range.to, markType);
        transaction.addMark(
          range.from,
          range.to,
          markType.create({ href: canonicalHref }),
        );
      }
    } else {
      for (const range of content.textRanges) {
        transaction.addMark(range.from, range.to, markType.create());
      }
    }
  }

  if (transaction.steps.length === 0) {
    return { changed: false, reason: "no-op" };
  }
  transaction.setSelection(TextSelection.create(transaction.doc, target.from));
  const appliedAction: InlineFormatAction =
    action.kind === "link" && canonicalHref !== null
      ? { kind: "link", href: canonicalHref }
      : action;
  transaction.setMeta("memoka.inline-format", appliedAction);
  view.dispatch(transaction);
  return { changed: true, from: target.from, action: appliedAction };
}

export function externalLinkAtPosition(
  document: ProseMirrorNode,
  position: number,
): string | null {
  const bounded = Math.max(0, Math.min(position, document.content.size));
  const resolved = document.resolve(bounded);
  const candidate = resolved.nodeAfter ?? resolved.nodeBefore;
  if (!candidate?.isText) return null;
  const link = candidate.marks.find(({ type }) => type.name === "link");
  const href = link?.attrs.href;
  if (typeof href === "string" && href.length > 0) return href;
  return null;
}

function inspectSelection(
  document: ProseMirrorNode,
  from: number,
  to: number,
): SelectionContent {
  const textNodes: ProseMirrorNode[] = [];
  const textRanges: Array<{ from: number; to: number }> = [];
  const textBlockPositions = new Set<number>();
  let containsInternalLink = false;
  let containsDisallowedBlock = false;
  document.nodesBetween(from, to, (node, position) => {
    const nodeFrom = node.isText || node.isAtom ? position : position + 1;
    const nodeTo =
      node.isText || node.isAtom
        ? position + node.nodeSize
        : position + node.nodeSize - 1;
    const intersects = Math.max(from, nodeFrom) < Math.min(to, nodeTo);
    if (!intersects) return true;
    if (node.type.name === "internalSectionLink") {
      containsInternalLink = true;
      return false;
    }
    if (node.isText) {
      textNodes.push(node);
      textRanges.push({
        from: Math.max(from, position),
        to: Math.min(to, position + node.nodeSize),
      });
    }
    if (node.isTextblock) {
      textBlockPositions.add(position);
      if (node.type.name !== "paragraph") containsDisallowedBlock = true;
    }
    if (DISALLOWED_BLOCKS.has(node.type.name)) containsDisallowedBlock = true;
    return true;
  });
  return {
    textNodes,
    textRanges,
    textBlockPositions,
    containsInternalLink,
    containsDisallowedBlock,
  };
}

function uniformLinkHref(nodes: readonly ProseMirrorNode[]): string | null {
  let href: string | null = null;
  for (const node of nodes) {
    const link = node.marks.find(({ type }) => type.name === "link");
    const current = link?.attrs.href;
    if (typeof current !== "string" || !current) return null;
    if (href !== null && href !== current) return null;
    href = current;
  }
  return href;
}

function markNameFor(format: InlineMarkFormat): string {
  return format;
}
