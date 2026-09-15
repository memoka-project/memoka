import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { isCodeLanguage } from "../core/code-blocks";
import type { CodeCopyResult } from "../editor/code-block";

export interface CodeBlockActionSelection {
  readonly blockId: string;
  readonly beforeCursor: number;
  readonly language: string | null;
}

export type CodeBlockActionFailure = "missing" | "invalid" | "no-op";

export interface CodeBlockLanguageResult {
  readonly changed: boolean;
  readonly reason: "changed" | CodeBlockActionFailure;
  readonly position: number;
  readonly language: string | null;
}

interface PositionedCodeBlock {
  readonly node: ProseMirrorNode;
  readonly position: number;
}

function locateCodeBlock(
  doc: ProseMirrorNode,
  blockId: string,
): PositionedCodeBlock | null {
  let result: PositionedCodeBlock | null = null;
  doc.descendants((node, position) => {
    if (
      result === null &&
      node.type.name === "codeBlock" &&
      node.attrs.blockId === blockId
    ) {
      result = { node, position };
      return false;
    }
    return result === null;
  });
  return result;
}

export function captureCodeBlockActionSelection(
  view: Pick<EditorView, "state">,
): CodeBlockActionSelection | null {
  const selection = view.state.selection;
  const $head = selection.$head;
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    const node = $head.node(depth);
    if (node.type.name !== "codeBlock") continue;
    const blockId = node.attrs.blockId;
    if (typeof blockId !== "string" || !blockId) return null;
    return {
      blockId,
      beforeCursor: selection.head,
      language:
        typeof node.attrs.language === "string" && node.attrs.language
          ? String(node.attrs.language)
          : null,
    };
  }
  return null;
}

export function codeBlockText(
  view: Pick<EditorView, "state">,
  selection: CodeBlockActionSelection,
): string | null {
  return (
    locateCodeBlock(view.state.doc, selection.blockId)?.node.textContent ?? null
  );
}

export function setCodeBlockLanguage(
  view: Pick<EditorView, "state" | "dispatch" | "focus">,
  selection: CodeBlockActionSelection,
  language: string | null,
): CodeBlockLanguageResult {
  const target = locateCodeBlock(view.state.doc, selection.blockId);
  if (!target) {
    return {
      changed: false,
      reason: "missing",
      position: selection.beforeCursor,
      language,
    };
  }
  if (!isCodeLanguage(language)) {
    return {
      changed: false,
      reason: "invalid",
      position: selection.beforeCursor,
      language,
    };
  }
  const current =
    typeof target.node.attrs.language === "string" && target.node.attrs.language
      ? String(target.node.attrs.language)
      : null;
  if (current === language) {
    return {
      changed: false,
      reason: "no-op",
      position: selection.beforeCursor,
      language,
    };
  }
  const transaction = view.state.tr.setNodeMarkup(
    target.position,
    undefined,
    { ...target.node.attrs, language },
    target.node.marks,
  );
  view.dispatch(transaction);
  view.focus();
  return {
    changed: true,
    reason: "changed",
    position: Math.min(selection.beforeCursor, transaction.doc.content.size),
    language,
  };
}

export interface CodeBlockActionRequest {
  readonly selection: CodeBlockActionSelection;
  readonly copy: () => Promise<CodeCopyResult>;
  readonly setLanguage: (language: string | null) => CodeBlockLanguageResult;
}
