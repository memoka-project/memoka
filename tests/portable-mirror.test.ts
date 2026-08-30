import { describe, expect, it, vi } from "vitest";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import {
  createPortableMirrorPublication,
  createPortableMirrorUpdate,
  PortableMirrorController,
  type PortableMirrorPort,
  type PortableMirrorPublication,
  type PortableMirrorStatus,
} from "../app/src/core/portable-mirror";
import { createUuidV7 } from "../app/src/core/ids";
import {
  createNoteDocument,
  replaceNoteSectionTree,
  type NoteBlock,
} from "../app/src/core/documents";
import { sectionSnapshot } from "../app/src/core/section-model";

function blockJson(block: NoteBlock): unknown {
  const note = createNoteDocument(createUuidV7(), [block]);
  const result = sectionSnapshot(note.rootSection).body[0];
  note.doc.destroy();
  return result;
}

async function mirrorStatus(
  runtime: CoreRuntime,
  manifest: PortableMirrorPublication["manifest"] | null,
): Promise<PortableMirrorStatus> {
  const current = await createPortableMirrorPublication(runtime, []);
  return {
    manifest,
    mirrorNeedsRepair: false,
    documentRevisions: current.manifest.documents.map((document) => ({
      kind: document.kind,
      documentId: document.documentId,
      revision: document.sourceRevision,
    })),
  };
}

describe("portable Workspace mirror", () => {
  it("emits readable Markdown, title paths and compact recovery documents", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "Project",
    });
    const firstAttachment = createUuidV7();
    const secondAttachment = createUuidV7();
    const publication = await createPortableMirrorPublication(
      runtime,
      [
        {
          attachmentId: firstAttachment,
          sha256: "1".repeat(64),
          size: 12,
          originalFilename: "diagram.png",
          mimeType: "image/png",
          createdAt: "2026-08-24T00:00:00.000Z",
          available: true,
          previewable: true,
        },
        {
          attachmentId: secondAttachment,
          sha256: "2".repeat(64),
          size: 14,
          originalFilename: "diagram.png",
          mimeType: "image/png",
          createdAt: "2026-08-24T00:00:01.000Z",
          available: true,
          previewable: true,
        },
      ],
      "2026-08-24T00:00:02.000Z",
    );

    expect(publication.manifest).toMatchObject({
      schemaVersion: 1,
      generatedAt: "2026-08-24T00:00:02.000Z",
      notes: [{ markdownPath: "Project.md" }],
      attachments: [
        { path: "memoka-attachments/diagram.png" },
        { path: "memoka-attachments/diagram (2).png" },
      ],
    });
    expect(
      publication.manifest.documents.map(({ kind, path }) => ({ kind, path })),
    ).toEqual([
      { kind: "workspace", path: "memoka-recovery/workspace.yjs" },
      { kind: "note", path: "memoka-recovery/Project.yjs" },
    ]);
    const markdown = publication.uploads.find(
      ({ path }) => path === "Project.md",
    );
    const markdownText = new TextDecoder().decode(markdown?.bytes);
    expect(markdownText).toContain("# Project");
    expect(markdownText).toContain("memoka_portable_mirror: 1");
    expect(markdownText).not.toContain("body_payload_hex");
    expect(
      publication.uploads.filter(
        ({ sourceAttachmentId }) => sourceAttachmentId,
      ),
    ).toHaveLength(2);
    expect(
      publication.manifest.files.every(({ sha256 }) =>
        /^[0-9a-f]{64}$/u.test(sha256),
      ),
    ).toBe(true);
    runtime.destroy();
  });

  it("uses encoded relative destinations for title paths with Markdown punctuation", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "Project",
    });
    const childId = createUuidV7();
    const attachmentId = createUuidV7();
    replaceNoteSectionTree(
      runtime.noteDocument,
      {
        sectionId: runtime.noteId,
        title: "Project",
        tags: [],
        body: [
          blockJson({
            type: "paragraph",
            blockId: createUuidV7(),
            content: [
              {
                type: "internalSectionLink",
                targetSectionId: childId,
                text: "child",
              },
            ],
          }),
          blockJson({
            type: "image",
            blockId: createUuidV7(),
            attachmentId,
            altText: "diagram",
          }),
        ],
        children: [
          {
            sectionId: childId,
            title: "Child Link (A) %",
            tags: [],
            body: [],
            children: [],
          },
        ],
      },
      "2026-08-24T00:00:00.000Z",
    );
    const publication = await createPortableMirrorPublication(runtime, [
      {
        attachmentId,
        sha256: "a".repeat(64),
        size: 1,
        originalFilename: "my image(1)%.png",
        mimeType: "image/png",
        createdAt: "2026-08-24T00:00:00.000Z",
        available: true,
        previewable: true,
      },
    ]);
    const root = publication.uploads.find(({ path }) => path === "Project.md");
    const markdown = new TextDecoder().decode(root?.bytes);
    expect(markdown).toContain(
      "[[Project.sections/Child%20Link%20%28A%29%20%2525.md|child]]",
    );
    expect(markdown).toContain(
      "![diagram](memoka-attachments/my%20image%281%29%2525.png)",
    );
    runtime.destroy();
  });

  it("publishes only dirty revisions and retries a failed flush", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "Project",
    });
    const publications: PortableMirrorPublication[] = [];
    let manifest: PortableMirrorPublication["manifest"] | null = null;
    let failNext = true;
    const port: PortableMirrorPort = {
      status: () => mirrorStatus(runtime, manifest),
      listAttachments: async () => [],
      publish: async (publication) => {
        if (failNext) {
          failNext = false;
          throw new Error("injected publish failure");
        }
        publications.push(publication);
        manifest = publication.manifest;
      },
    };
    const errors: Error[] = [];
    const controller = new PortableMirrorController(
      runtime,
      port,
      (error) => errors.push(error),
      60_000,
    );
    await expect(controller.flush()).rejects.toThrow(
      "injected publish failure",
    );
    expect(controller.activitySnapshot()).toMatchObject({
      phase: "error",
      lastResult: "error",
    });
    await controller.flush();
    await controller.flush();
    expect(publications).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(controller.activitySnapshot()).toMatchObject({
      phase: "idle",
      dirty: false,
      lastResult: "published",
    });

    await runtime.createNoteAtEnd("window-1", "Second");
    await controller.flush();
    expect(publications).toHaveLength(2);
    expect(publications[1]!.manifest.notes).toHaveLength(2);
    controller.destroy();
    expect(controller.activitySnapshot().phase).toBe("off");
    runtime.destroy();
  });

  it("does not publish when startup revisions already match the manifest", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "Project",
    });
    const baseline = await createPortableMirrorPublication(runtime, []);
    const publish = vi.fn(async () => undefined);
    const controller = new PortableMirrorController(
      runtime,
      {
        status: () => mirrorStatus(runtime, baseline.manifest),
        listAttachments: async () => [],
        publish,
      },
      () => undefined,
      60_000,
    );

    await controller.flush();

    expect(publish).not.toHaveBeenCalled();
    expect(controller.activitySnapshot()).toMatchObject({
      phase: "idle",
      dirty: false,
      lastResult: null,
    });
    controller.destroy();
    runtime.destroy();
  });

  it("regenerates only the changed Note when portable paths stay stable", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "Project",
    });
    const projectId = runtime.noteId;
    const second = await runtime.createNoteAtEnd("window-1", "Second");
    await runtime.flushDurableState();
    const baseline = await createPortableMirrorPublication(runtime, []);
    replaceNoteSectionTree(
      runtime.noteDocument,
      {
        sectionId: second.noteId,
        title: "Second",
        tags: [],
        body: [
          blockJson({
            type: "paragraph",
            blockId: createUuidV7(),
            content: [{ type: "text", text: "changed body" }],
          }),
        ],
        children: [],
      },
      "2026-08-24T00:00:03.000Z",
      Symbol("portable-mirror-delta-test"),
    );
    await runtime.flushDurableState();
    const status = await mirrorStatus(runtime, baseline.manifest);

    const update = await createPortableMirrorUpdate(
      runtime,
      [],
      status,
      "2026-08-24T00:00:04.000Z",
    );

    expect(update).not.toBeNull();
    expect(update!.uploads.map(({ path }) => path)).toEqual([
      "memoka-recovery/workspace.yjs",
      "Second.md",
      "memoka-recovery/Second.yjs",
    ]);
    const unchangedDocument = baseline.manifest.documents.find(
      ({ kind, documentId }) => kind === "note" && documentId === projectId,
    );
    expect(
      update!.manifest.documents.find(
        ({ kind, documentId }) => kind === "note" && documentId === projectId,
      ),
    ).toEqual(unchangedDocument);
    runtime.destroy();
  });

  it("uses a full publication when the existing mirror needs repair", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "Project",
    });
    const baseline = await createPortableMirrorPublication(runtime, []);
    const status = await mirrorStatus(runtime, baseline.manifest);

    const repair = await createPortableMirrorUpdate(runtime, [], {
      ...status,
      mirrorNeedsRepair: true,
    });

    expect(repair).not.toBeNull();
    expect(repair!.uploads).toHaveLength(baseline.uploads.length);
    runtime.destroy();
  });

  it("yields between bounded Section work and cancels a stale preparation", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "Project",
    });
    replaceNoteSectionTree(
      runtime.noteDocument,
      {
        sectionId: runtime.noteId,
        title: "Project",
        tags: [],
        body: [],
        children: Array.from({ length: 30 }, (_, sectionIndex) => ({
          sectionId: createUuidV7(),
          title: `Section ${sectionIndex + 1}`,
          tags: [],
          body: Array.from({ length: 10 }, (_, lineIndex) =>
            blockJson({
              type: "paragraph",
              blockId: createUuidV7(),
              content: [
                {
                  type: "text",
                  text: `line ${sectionIndex + 1}-${lineIndex + 1}`,
                },
              ],
            }),
          ),
          children: [],
        })),
      },
      "2026-08-24T00:00:00.000Z",
    );
    let yields = 0;
    let heartbeat = 0;
    const timer = globalThis.setInterval(() => {
      heartbeat += 1;
    }, 0);
    const publication = await createPortableMirrorPublication(
      runtime,
      [],
      "2026-08-24T00:00:01.000Z",
      {
        budgetMilliseconds: 0,
        yieldControl: async () => {
          yields += 1;
          await new Promise<void>((resolve) =>
            globalThis.setTimeout(resolve, 0),
          );
        },
      },
    );
    globalThis.clearInterval(timer);
    expect(publication.uploads).toHaveLength(33);
    expect(yields).toBeGreaterThan(30);
    expect(heartbeat).toBeGreaterThan(0);

    const abort = new AbortController();
    await expect(
      createPortableMirrorPublication(runtime, [], "2026-08-24T00:00:02.000Z", {
        signal: abort.signal,
        budgetMilliseconds: 0,
        yieldControl: async () => {
          abort.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    runtime.destroy();
  });

  it("drains a revision that becomes dirty during an in-flight flush", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "Project",
    });
    const publications: PortableMirrorPublication[] = [];
    let manifest: PortableMirrorPublication["manifest"] | null = null;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const port: PortableMirrorPort = {
      status: () => mirrorStatus(runtime, manifest),
      listAttachments: async () => [],
      publish: async (publication) => {
        publications.push(publication);
        if (publications.length === 1) {
          firstStarted();
          await firstGate;
        }
        manifest = publication.manifest;
      },
    };
    const controller = new PortableMirrorController(
      runtime,
      port,
      () => undefined,
      60_000,
    );
    const flushing = controller.flush();
    await started;
    await runtime.createNoteAtEnd("window-1", "Second");
    releaseFirst();
    await flushing;
    expect(publications).toHaveLength(2);
    expect(publications[0]!.manifest.notes).toHaveLength(1);
    expect(publications[1]!.manifest.notes).toHaveLength(2);
    controller.destroy();
    runtime.destroy();
  });
});
