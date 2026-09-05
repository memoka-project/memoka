import { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import {
  AttachmentRepository,
  MAX_ATTACHMENT_BATCH_BYTES,
  MemoryAttachmentPort,
  validateAttachmentBatch,
  type AttachmentMetadata,
} from "../app/src/core/attachments";
import { createNoteDocument } from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { insertAttachmentBlocks } from "../app/src/editor/attachment-insert";
import { productEditorExtensions } from "../app/src/editor/extensions";
import { parseMarkdownPaste } from "../app/src/editor/markdown-paste";

function deterministicIds(): () => string {
  let counter = 0;
  return () => createUuidV7(1_795_435_200_000 + counter++);
}

function press(
  editor: Editor,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

function fileLike(bytes: Uint8Array, name: string, type: string): File {
  return {
    name,
    type,
    size: bytes.byteLength,
    slice: (start = 0, end = bytes.byteLength) => ({
      arrayBuffer: async () => bytes.slice(start, end).buffer,
    }),
  } as unknown as File;
}

describe("Memoka attachment boundary", () => {
  it("imports a batch in source order and deduplicates equal bytes in CAS", async () => {
    const repository = new AttachmentRepository(
      new MemoryAttachmentPort(),
      deterministicIds(),
      () => "2026-08-22T00:00:00.000Z",
    );
    const imported = await repository.importFiles([
      fileLike(png, "preview.png", "image/png"),
      fileLike(new TextEncoder().encode("same"), "first.txt", "text/plain"),
      fileLike(new TextEncoder().encode("same"), "second.txt", "text/plain"),
      fileLike(
        new TextEncoder().encode("not a PNG"),
        "spoofed.png",
        "image/png",
      ),
    ]);

    expect(imported.map(({ originalFilename }) => originalFilename)).toEqual([
      "preview.png",
      "first.txt",
      "second.txt",
      "spoofed.png",
    ]);
    expect(imported[0]).toMatchObject({
      mimeType: "image/png",
      previewable: true,
      available: true,
    });
    expect(imported[1]?.sha256).toBe(imported[2]?.sha256);
    expect(imported[1]?.attachmentId).not.toBe(imported[2]?.attachmentId);
    expect(imported[3]).toMatchObject({
      mimeType: "application/octet-stream",
      previewable: false,
    });
  });

  it("rejects unsafe names and oversized actions before writing", () => {
    expect(() =>
      validateAttachmentBatch([
        {
          attachmentId: createUuidV7(),
          originalFilename: "../unsafe.txt",
          declaredMimeType: "text/plain",
          expectedSize: 1,
        },
      ]),
    ).toThrow("安全でない添付ファイル名");
    expect(() =>
      validateAttachmentBatch([
        {
          attachmentId: createUuidV7(),
          originalFilename: "large.bin",
          declaredMimeType: "application/octet-stream",
          expectedSize: MAX_ATTACHMENT_BATCH_BYTES + 1,
        },
      ]),
    ).toThrow("128 MiB");
  });

  it("cancels a failed native-path batch before reporting the error", async () => {
    const port = new MemoryAttachmentPort();
    const cancel = vi.fn(async () => undefined);
    port.importNativePaths = vi.fn(async () => {
      throw new Error("native read failed");
    });
    port.cancelBatch = cancel;
    const repository = new AttachmentRepository(port, deterministicIds());

    await expect(
      repository.importNativePaths(["/tmp/missing.txt"]),
    ).rejects.toThrow("native read failed");
    expect(cancel).toHaveBeenCalledWith(
      expect.stringMatching(/-7[0-9a-f]{3}-/u),
    );
  });

  it("inserts safe raster images and generic files as ordered atomic blocks", () => {
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
    const editor = new Editor({
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    const attachments: AttachmentMetadata[] = [
      {
        attachmentId: "01900000-0001-7000-8000-000000000001",
        sha256: "a".repeat(64),
        size: png.length,
        originalFilename: "preview.png",
        mimeType: "image/png",
        createdAt: "2026-08-22T00:00:00.000Z",
        available: true,
        previewable: true,
      },
      {
        attachmentId: "01900000-0002-7000-8000-000000000002",
        sha256: "b".repeat(64),
        size: 4,
        originalFilename: "notes.pdf",
        mimeType: "application/pdf",
        createdAt: "2026-08-22T00:00:00.000Z",
        available: true,
        previewable: false,
      },
    ];
    try {
      const result = insertAttachmentBlocks(editor.view, attachments);
      expect(result).toMatchObject({
        changed: true,
        populatedImageStub: false,
      });
      expect(editor.state.doc.toJSON().content).toEqual([
        expect.objectContaining({
          type: "image",
          attrs: expect.objectContaining({
            attachmentId: attachments[0]?.attachmentId,
            src: `attachment:${attachments[0]?.attachmentId}`,
          }),
        }),
        expect.objectContaining({
          type: "attachment",
          attrs: expect.objectContaining({
            attachmentId: attachments[1]?.attachmentId,
            label: "notes.pdf",
          }),
        }),
      ]);
      expect(editor.state.selection.from).toBe(
        editor.state.doc.firstChild?.nodeSize ?? -1,
      );
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });

  it("uses an explicit drop position instead of a separately selected image stub", () => {
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
    const editor = new Editor({
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    const attachment: AttachmentMetadata = {
      attachmentId: "01900000-0001-7000-8000-000000000001",
      sha256: "a".repeat(64),
      size: png.length,
      originalFilename: "dropped.png",
      mimeType: "image/png",
      createdAt: "2026-08-22T00:00:00.000Z",
      available: true,
      previewable: true,
    };
    try {
      editor.commands.setContent({
        type: "doc",
        content: [
          {
            type: "image",
            attrs: {
              src: "attachment:missing",
              attachmentId: "attachment:missing",
              alt: "Image Block stub",
            },
          },
          { type: "paragraph" },
        ],
      });
      editor.commands.setNodeSelection(0);

      expect(
        insertAttachmentBlocks(editor.view, [attachment], { position: 1 }),
      ).toMatchObject({ changed: true, populatedImageStub: false });
      expect(
        editor.state.doc.content.content.map((node) => node.attrs.attachmentId),
      ).toEqual(["attachment:missing", attachment.attachmentId]);
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });

  it("round-trips generic attachment references through Markdown blocks", () => {
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
    const editor = new Editor({ extensions: productEditorExtensions(note) });
    try {
      const id = "01900000-0002-7000-8000-000000000002";
      const parsed = parseMarkdownPaste(
        `[manual \\[final\\].pdf](attachment:${id})`,
        editor.schema,
      );
      expect(parsed?.slice.content.firstChild?.toJSON()).toMatchObject({
        type: "attachment",
        attrs: { attachmentId: id, label: "manual [final].pdf" },
      });
      expect(parsed?.sourceBlockCount).toBe(0);
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });

  it("treats an Attachment Block as one Vim line for i/a, yank/put, and gx", async () => {
    const open = vi.fn(async () => undefined);
    const copyFiles = vi.fn(async () => undefined);
    const port = new MemoryAttachmentPort();
    port.open = open;
    port.copyFiles = copyFiles;
    const repository = new AttachmentRepository(port, deterministicIds());
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      attachmentRepository: repository,
    });
    const attachmentId = "01900000-0002-7000-8000-000000000002";
    try {
      editor.commands.setContent({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "before" }] },
          {
            type: "attachment",
            attrs: { attachmentId, label: "manual [final].pdf" },
          },
          { type: "paragraph", content: [{ type: "text", text: "after" }] },
        ],
      });
      const attachmentPosition = editor.state.doc.firstChild?.nodeSize ?? -1;
      editor.commands.setNodeSelection(attachmentPosition);
      press(editor, "Escape");
      expect(press(editor, "g").defaultPrevented).toBe(true);
      expect(press(editor, "x").defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(open).toHaveBeenCalledWith(attachmentId));

      editor.commands.setNodeSelection(attachmentPosition);
      press(editor, "y");
      press(editor, "y");
      await vi.waitFor(() => expect(copyFiles).toHaveBeenCalledTimes(1));
      expect(copyFiles).toHaveBeenCalledWith(
        [attachmentId],
        expect.objectContaining({
          markdown: `[manual \\[final\\].pdf](attachment:${attachmentId})`,
          plain: `[manual \\[final\\].pdf](attachment:${attachmentId})`,
        }),
      );
      press(editor, "p");
      const attachments: Array<{ blockId: string; attachmentId: string }> = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === "attachment") {
          attachments.push({
            blockId: String(node.attrs.blockId),
            attachmentId: String(node.attrs.attachmentId),
          });
        }
      });
      expect(attachments).toHaveLength(2);
      expect(new Set(attachments.map(({ attachmentId: id }) => id))).toEqual(
        new Set([attachmentId]),
      );
      expect(new Set(attachments.map(({ blockId }) => blockId)).size).toBe(2);

      editor.commands.setNodeSelection(attachmentPosition);
      press(editor, "i");
      expect(adapter.vimSnapshot.mode).toBe("insert");
      expect(editor.state.selection.$from.parent.textContent).toBe("before");
    } finally {
      adapter.destroy();
      runtime.destroy();
      root.remove();
    }
  });

  it("puts externally copied files with p/P while preserving later local register puts", async () => {
    const port = new MemoryAttachmentPort();
    const importNativePaths = vi.fn(
      async (
        operationId: string,
        createdAt: string,
        items: readonly { attachmentId: string; path: string }[],
      ) => ({
        operationId,
        deduplicated: false,
        attachments: items.map(({ attachmentId, path }) => ({
          attachmentId,
          sha256: "c".repeat(64),
          size: 4,
          originalFilename: path.split("/").at(-1) ?? "external.txt",
          mimeType: "text/plain",
          createdAt,
          available: true,
          previewable: false,
        })),
      }),
    );
    Object.defineProperty(port, "importNativePaths", {
      configurable: true,
      value: importNativePaths,
    });
    const repository = new AttachmentRepository(
      port,
      deterministicIds(),
      () => "2026-08-23T00:00:00.000Z",
    );
    const readPreferredClipboard = vi.fn(async () => ({
      availableTypes: ["text/uri-list"],
      internal: null,
      markdown: null,
      filePaths: ["/tmp/external.txt"],
    }));
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      attachmentRepository: repository,
      readPreferredClipboard,
    });
    try {
      editor.commands.setContent({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "first" }] },
          { type: "paragraph", content: [{ type: "text", text: "second" }] },
        ],
      });
      editor.commands.setTextSelection(1);
      press(editor, "Escape");

      expect(press(editor, "p").defaultPrevented).toBe(true);
      await vi.waitFor(() =>
        expect(
          editor.state.doc.content.content.map((node) => node.type.name),
        ).toEqual(["paragraph", "attachment", "paragraph"]),
      );
      expect(importNativePaths).toHaveBeenCalledTimes(1);

      expect(press(editor, "P").defaultPrevented).toBe(true);
      await vi.waitFor(() =>
        expect(
          editor.state.doc.content.content.map((node) => node.type.name),
        ).toEqual(["paragraph", "attachment", "attachment", "paragraph"]),
      );
      expect(readPreferredClipboard).toHaveBeenCalledTimes(1);
      expect(importNativePaths).toHaveBeenCalledTimes(2);
      const firstAttachmentId =
        importNativePaths.mock.calls[0]![2][0]!.attachmentId;
      const secondAttachmentId =
        importNativePaths.mock.calls[1]![2][0]!.attachmentId;
      expect(
        editor.state.doc.content.content
          .filter((node) => node.type.name === "attachment")
          .map((node) => node.attrs.attachmentId),
      ).toEqual([secondAttachmentId, firstAttachmentId]);

      editor.commands.setTextSelection(1);
      press(editor, "d");
      press(editor, "d");
      press(editor, "p");
      expect(importNativePaths).toHaveBeenCalledTimes(2);
      expect(editor.state.doc.textContent).toContain("first");

      window.dispatchEvent(new Event("focus"));
      press(editor, "2");
      press(editor, "p");
      await vi.waitFor(() =>
        expect(importNativePaths).toHaveBeenCalledTimes(3),
      );
      expect(readPreferredClipboard).toHaveBeenCalledTimes(2);
      expect(importNativePaths.mock.calls[2]![2]).toHaveLength(2);
    } finally {
      adapter.destroy();
      runtime.destroy();
      root.remove();
    }
  });

  it("imports a raw Clipboard image once for a counted put and publishes exact image yanks", async () => {
    const port = new MemoryAttachmentPort();
    const imageAttachmentId = "01900000-0004-7000-8000-000000000004";
    const importClipboardImage = vi.fn(
      async (
        operationId: string,
        attachmentId: string,
        createdAt: string,
        originalFilename: string,
      ) => ({
        operationId,
        deduplicated: false,
        attachments: [
          {
            attachmentId: imageAttachmentId || attachmentId,
            sha256: "d".repeat(64),
            size: png.length,
            originalFilename,
            mimeType: "image/png",
            createdAt,
            available: true,
            previewable: true,
          },
        ],
      }),
    );
    const copyFiles = vi.fn(async () => undefined);
    const openImage = vi.fn(async () => undefined);
    port.importClipboardImage = importClipboardImage;
    port.copyFiles = copyFiles;
    const repository = new AttachmentRepository(
      port,
      deterministicIds(),
      () => "2026-09-05T12:34:56.000Z",
    );
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      attachmentRepository: repository,
      readPreferredClipboard: async () => ({
        availableTypes: ["image/png"],
        internal: null,
        markdown: null,
        imageAvailable: true,
      }),
      onOpenImage: openImage,
    });
    try {
      editor.commands.setContent({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "before" }] },
          { type: "paragraph", content: [{ type: "text", text: "after" }] },
        ],
      });
      editor.commands.setTextSelection(1);
      press(editor, "Escape");
      press(editor, "2");
      press(editor, "p");
      await vi.waitFor(() =>
        expect(importClipboardImage).toHaveBeenCalledTimes(1),
      );
      await vi.waitFor(() => {
        const images = editor.state.doc.content.content.filter(
          (node) => node.type.name === "image",
        );
        expect(images).toHaveLength(2);
        expect(
          images.every((node) => node.attrs.attachmentId === imageAttachmentId),
        ).toBe(true);
      });
      const imagePosition = editor.state.doc.firstChild?.nodeSize ?? -1;
      editor.commands.setNodeSelection(imagePosition);
      expect(adapter.currentImageWidthPercent()).toBe(100);
      expect(adapter.setCurrentImageWidthPercent(50)).toBe(true);
      expect(editor.state.doc.nodeAt(imagePosition)?.attrs.width).toBe(50);

      press(editor, "g");
      press(editor, "f");
      await vi.waitFor(() =>
        expect(openImage).toHaveBeenCalledWith(
          imageAttachmentId,
          false,
          expect.objectContaining({ noteId: runtime.noteId }),
        ),
      );
      press(editor, "w", { ctrlKey: true });
      press(editor, "g");
      press(editor, "f");
      await vi.waitFor(() =>
        expect(openImage).toHaveBeenCalledWith(
          imageAttachmentId,
          true,
          expect.objectContaining({ noteId: runtime.noteId }),
        ),
      );

      press(editor, "y");
      press(editor, "y");
      await vi.waitFor(() =>
        expect(copyFiles).toHaveBeenCalledWith(
          [imageAttachmentId],
          expect.objectContaining({
            markdown: expect.stringContaining('width="50%"'),
          }),
          true,
        ),
      );
    } finally {
      adapter.destroy();
      runtime.destroy();
      root.remove();
    }
  });
});
