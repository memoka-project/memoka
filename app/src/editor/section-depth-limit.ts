import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import {
  MAX_SECTION_DEPTH,
  SectionDepthLimitError,
} from "../core/section-model";

const depths = new WeakMap<Node, number>();

/** Only walk Section Children. Typing must never traverse the Note's body. */
export function sectionSubtreeDepth(section: Node): number {
  const cached = depths.get(section);
  if (cached !== undefined) return cached;
  let maximum = 0;
  const pending = [{ node: section, depth: 0 }];
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (depth > MAX_SECTION_DEPTH) return depth;
    maximum = Math.max(maximum, depth);
    node.forEach((child) => {
      if (child.type.name === "sectionChildren")
        pending.push({ node: child, depth });
      if (child.type.name === "section")
        pending.push({
          node: child,
          depth: depth + (node.type.name === "sectionChildren" ? 1 : 0),
        });
    });
  }
  depths.set(section, maximum);
  return maximum;
}

export function assertEditorSectionDepth(doc: Node, absoluteDepth = 0): void {
  const maximum = absoluteDepth + sectionSubtreeDepth(doc);
  if (maximum > MAX_SECTION_DEPTH) throw new SectionDepthLimitError(maximum);
}

export function sectionDepthLimit(absoluteDepth: number): Extension {
  return Extension.create({
    name: "memokaSectionDepthLimit",
    priority: 10_000,
    addProseMirrorPlugins() {
      return [
        new Plugin({
          filterTransaction: (transaction) => {
            if (!transaction.docChanged) return true;
            try {
              assertEditorSectionDepth(transaction.doc, absoluteDepth);
              return true;
            } catch (error) {
              if (!(error instanceof SectionDepthLimitError)) throw error;
              queueMicrotask(() =>
                this.editor.view.dom.dispatchEvent(
                  new CustomEvent("memoka-editor-error", {
                    bubbles: true,
                    detail: { code: error.code, message: error.message },
                  }),
                ),
              );
              return false;
            }
          },
        }),
      ];
    },
  });
}
