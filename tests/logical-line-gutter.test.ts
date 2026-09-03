import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { defaultVimBlockSemantics } from "../app/src/vim/block-semantics";

const defaultIntersectionObserver = globalThis.IntersectionObserver;

class ControlledIntersectionObserver {
  static readonly instances: ControlledIntersectionObserver[] = [];

  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds: readonly number[];
  readonly observed = new Set<Element>();

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? "0px";
    const threshold = options.threshold ?? 0;
    this.thresholds = Array.isArray(threshold) ? threshold : [threshold];
    ControlledIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  trigger(target: Element, isIntersecting = true): void {
    const rect = target.getBoundingClientRect();
    this.callback(
      [
        {
          time: performance.now(),
          target,
          rootBounds: null,
          boundingClientRect: rect,
          intersectionRect: isIntersecting ? rect : new DOMRect(),
          isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
        },
      ],
      this as unknown as IntersectionObserver,
    );
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function blockPosition(editor: Editor, blockId: string): number {
  let result = -1;
  editor.state.doc.descendants((node, position) => {
    if (String(node.attrs.blockId ?? "") === blockId) result = position;
    return result < 0;
  });
  if (result < 0) throw new Error(`Block not found: ${blockId}`);
  return result;
}

afterEach(() => {
  ControlledIntersectionObserver.instances.length = 0;
  globalThis.IntersectionObserver = defaultIntersectionObserver;
});

describe("Vim logical-line gutter virtualization", () => {
  it("keeps every BodyChunk inside the viewport margin richly rendered", async () => {
    globalThis.IntersectionObserver =
      ControlledIntersectionObserver as unknown as typeof IntersectionObserver;
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "Visible chunks",
    });
    const scroll = document.createElement("div");
    scroll.className = "editor-scroll";
    const root = document.createElement("div");
    scroll.append(root);
    document.body.append(scroll);
    const attached = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
      scrollElement: scroll,
    });
    const chunkIds = Array.from({ length: 9 }, () => createUuidV7());
    const blockIds = Array.from({ length: 9 }, () => createUuidV7());

    try {
      attached.editor.commands.setContent({
        type: "section",
        content: [
          {
            type: "sectionHeader",
            attrs: { sectionId: runtime.noteId, tags: "[]" },
            content: [{ type: "text", text: "Visible chunks" }],
          },
          {
            type: "sectionBody",
            content: chunkIds.map((chunkId, index) => ({
              type: "bodyChunk",
              attrs: { chunkId },
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: blockIds[index] },
                  content: [{ type: "text", text: `chunk ${index}` }],
                },
              ],
            })),
          },
          { type: "sectionChildren" },
        ],
      });
      attached.editor.commands.setTextSelection(
        blockPosition(attached.editor, blockIds[0]!) + 1,
      );

      const viewportObserver = ControlledIntersectionObserver.instances.find(
        (observer) => observer.rootMargin === "640px 0px",
      );
      if (!viewportObserver) throw new Error("Expected BodyChunk observer");

      // More than the former three-chunk viewport cap can be visible when a
      // note contains several short Sections. None of them may fall back to
      // the unformatted static preview while it is on screen.
      for (const [offset, chunkId] of chunkIds.slice(2, 8).entries()) {
        const chunk = root.querySelector<HTMLElement>(
          `[data-body-chunk-id="${chunkId}"]`,
        );
        if (!chunk) throw new Error(`Expected BodyChunk ${chunkId}`);
        vi.spyOn(chunk, "getBoundingClientRect").mockReturnValue(
          new DOMRect(0, 80 + offset * 50, 800, 40),
        );
        viewportObserver.trigger(chunk);
      }
      await nextFrame();

      for (const chunkId of chunkIds.slice(2, 8)) {
        expect(
          root.querySelector<HTMLElement>(`[data-body-chunk-id="${chunkId}"]`)
            ?.dataset.bodyChunkVirtualized,
        ).toBe("false");
      }
      expect(
        root.querySelector<HTMLElement>(`[data-body-chunk-id="${chunkIds[8]}"]`)
          ?.dataset.bodyChunkVirtualized,
      ).toBe("true");
    } finally {
      attached.adapter.destroy();
      runtime.destroy();
      scroll.remove();
    }
  });

  it("reconnects line markers when a visible BodyChunk is remounted", async () => {
    globalThis.IntersectionObserver =
      ControlledIntersectionObserver as unknown as typeof IntersectionObserver;
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "Virtual gutter",
    });
    const scroll = document.createElement("div");
    scroll.className = "editor-scroll";
    const root = document.createElement("div");
    scroll.append(root);
    document.body.append(scroll);
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 800, 600),
    );
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 800, 600),
    );
    const attached = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
      scrollElement: scroll,
    });
    const chunkIds = Array.from({ length: 6 }, () => createUuidV7());
    const blockIds = Array.from({ length: 6 }, () => createUuidV7());

    try {
      attached.editor.commands.setContent({
        type: "section",
        content: [
          {
            type: "sectionHeader",
            attrs: { sectionId: runtime.noteId, tags: "[]" },
            content: [{ type: "text", text: "Virtual gutter" }],
          },
          {
            type: "sectionBody",
            content: chunkIds.map((chunkId, index) => ({
              type: "bodyChunk",
              attrs: { chunkId },
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: blockIds[index] },
                  content: [{ type: "text", text: `chunk line ${index}` }],
                },
              ],
            })),
          },
          { type: "sectionChildren" },
        ],
      });
      attached.editor.commands.setTextSelection(
        blockPosition(attached.editor, blockIds[0]!) + 1,
      );
      await nextFrame();

      const targetChunkId = chunkIds[2]!;
      const targetBlockId = blockIds[2]!;
      const targetPosition = blockPosition(attached.editor, targetBlockId);
      const targetAbsolute =
        defaultVimBlockSemantics
          .logicalLineAnchors(attached.editor.view)
          .findIndex((anchor) => anchor.blockPosition === targetPosition) + 1;
      const targetMarker = (): HTMLElement | null =>
        root.querySelector(
          `.memoka-logical-line-number[data-logical-line-number="${targetAbsolute}"]`,
        );
      const staticChunk = root.querySelector<HTMLElement>(
        `[data-body-chunk-id="${targetChunkId}"]`,
      );
      expect(staticChunk?.dataset.bodyChunkVirtualized).toBe("true");
      expect(targetMarker()).toBeNull();

      const viewportObserver = ControlledIntersectionObserver.instances.find(
        (observer) => observer.rootMargin === "640px 0px",
      );
      const gutterObserver = ControlledIntersectionObserver.instances.find(
        (observer) => observer.rootMargin === "80px 0px",
      );
      if (!viewportObserver || !gutterObserver || !staticChunk) {
        throw new Error("Expected BodyChunk and gutter observers");
      }
      viewportObserver.trigger(staticChunk);
      await nextFrame();

      const activeBlock = root.querySelector<HTMLElement>(
        `[data-block-id="${targetBlockId}"]`,
      );
      expect(activeBlock).not.toBeNull();
      expect(attached.editor.view.nodeDOM(targetPosition)).toBe(activeBlock);
      const activeChunk = activeBlock?.closest<HTMLElement>(
        "[data-body-chunk-id]",
      );
      expect(activeChunk?.dataset.bodyChunkVirtualized).toBe("false");
      expect(activeChunk).not.toBe(staticChunk);
      expect(viewportObserver.observed.has(staticChunk)).toBe(false);

      // Replacing the static NodeView destroys its old DOM before the
      // IntersectionObserver reports the new active DOM. That replacement is
      // not a viewport exit and must not immediately virtualize the chunk
      // again, otherwise rich and plain rendering oscillate every frame.
      await nextFrame();
      expect(
        root.querySelector<HTMLElement>(
          `[data-body-chunk-id="${targetChunkId}"]`,
        )?.dataset.bodyChunkVirtualized,
      ).toBe("false");

      viewportObserver.trigger(staticChunk, false);
      await nextFrame();
      expect(
        root.querySelector<HTMLElement>(
          `[data-body-chunk-id="${targetChunkId}"]`,
        )?.dataset.bodyChunkVirtualized,
      ).toBe("false");

      vi.spyOn(activeChunk!, "getBoundingClientRect").mockReturnValue(
        new DOMRect(0, -3_000, 800, 3_500),
      );
      viewportObserver.trigger(activeChunk!);
      for (const [offset, chunkId] of chunkIds.slice(3).entries()) {
        const nearbyChunk = root.querySelector<HTMLElement>(
          `[data-body-chunk-id="${chunkId}"]`,
        );
        if (!nearbyChunk) throw new Error(`Expected nearby chunk ${chunkId}`);
        vi.spyOn(nearbyChunk, "getBoundingClientRect").mockReturnValue(
          new DOMRect(0, 500 + offset * 30, 800, 30),
        );
        viewportObserver.trigger(nearbyChunk);
      }
      await nextFrame();
      expect(
        root.querySelector<HTMLElement>(
          `[data-body-chunk-id="${targetChunkId}"]`,
        )?.dataset.bodyChunkVirtualized,
      ).toBe("false");

      vi.spyOn(activeBlock!, "getBoundingClientRect").mockReturnValue(
        new DOMRect(100, 240, 400, 24),
      );
      await Promise.resolve();
      await nextFrame();
      await vi.waitFor(() => {
        expect(gutterObserver.observed.has(activeBlock!)).toBe(true);
      });
      gutterObserver.trigger(activeBlock!);
      await nextFrame();

      expect(targetMarker()).not.toBeNull();
    } finally {
      attached.adapter.destroy();
      runtime.destroy();
      scroll.remove();
    }
  });
});
