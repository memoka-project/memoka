// Printed fixture is consumed by Rust contract tests. No DOM or Editor mount.
import * as Y from "yjs";
import {
  createWorkspaceDocument,
  createNoteDocumentFromSectionSnapshot,
  addNoteMetadata,
} from "../app/src/core/documents";
import { sectionSnapshot } from "../app/src/core/section-model";
const id = (value: number) =>
  `01a30000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
let next = 10;
const block = (type: string, content: unknown[] = [], attrs: object = {}) => ({
  type,
  attrs: { blockId: id(next++), ...attrs },
  content,
});
const text = (text: string, marks: unknown[] = []) => ({
  type: "text",
  text,
  marks,
});
const paragraph = (...content: unknown[]) => block("paragraph", content);
const title = "読み出し契約";
const note = createNoteDocumentFromSectionSnapshot(
  id(2),
  {
    sectionId: id(2),
    title,
    tags: ["試験"],
    body: [
      paragraph(
        text("日本語 ", [{ type: "bold" }]),
        text("italic", [{ type: "italic" }]),
        text("strike", [{ type: "strike" }]),
        text("色", [{ type: "highlight" }]),
        text("code`value", [{ type: "code" }]),
        { type: "hardBreak" },
        text("external", [
          { type: "link", attrs: { href: "https://example.org/?a=1&b=2" } },
        ]),
      ),
      block("bulletList", [
        block("listItem", [
          paragraph(text("親")),
          block("orderedList", [block("listItem", [paragraph(text("子"))])], {
            start: 3,
          }),
        ]),
      ]),
      block("blockquote", [paragraph(text("注意"))], {
        alertType: "warning",
        alertTitle: "独自タイトル",
        alertFold: "collapsed",
      }),
      block("codeBlock", [text("a = `value`\n```\nb")], { language: "js" }),
      block("table", [
        block("tableRow", [
          block("tableHeader", [paragraph(text("見出し"))]),
          block("tableHeader", [paragraph(text("右"))]),
        ]),
        block("tableRow", [
          block("tableCell", [paragraph(text("太字", [{ type: "bold" }]))]),
          block("tableCell", [paragraph(text("値|1"))]),
        ]),
      ]),
      block("horizontalRule"),
      paragraph({
        type: "internalSectionLink",
        attrs: { targetSectionId: id(3), label: "子セクション" },
      }),
    ],
    children: [
      {
        sectionId: id(3),
        title: "子セクション",
        tags: [],
        body: [paragraph(text("本文 一致語"))],
        children: [],
      },
    ],
  },
  { createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z" },
);
const workspace = createWorkspaceDocument(id(1));
addNoteMetadata(workspace, {
  noteId: id(2),
  entryId: id(4),
  title,
  notePosition: "a0",
  createdAt: "2026-09-06T00:00:00Z",
  updatedAt: "2026-09-06T00:00:00Z",
});
const documents = [workspace, note].map((document) => ({
  kind: document.kind,
  document_id: document.id,
  schema_version: document.schemaVersion,
  revision: 1,
  snapshot_revision: 1,
  snapshot: [...Y.encodeStateAsUpdate(document.doc)],
  updates: [],
}));
const legacy = documents.map((document) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(document.snapshot));
  if (document.kind === "workspace") {
    const root = doc.getMap("workspace");
    root.set("schema_version", 2);
    root.delete("main_namespace");
    const notes = root.get("notes") as Y.Map<Y.Map<unknown>>;
    for (const value of notes.values()) {
      value.set("parent_note_id", null);
      value.set("note_position", "a0");
    }
  } else {
    doc.getMap("meta").set("schema_version", 2);
    const pending = [doc.getXmlFragment("body").get(0) as Y.XmlElement];
    while (pending.length) {
      const section = pending.pop()!;
      const body = section.get(1) as Y.XmlElement;
      const blocks = body
        .toArray()
        .flatMap((chunk) =>
          (chunk as Y.XmlElement)
            .toArray()
            .map((block) => (block as Y.XmlElement).clone()),
        );
      body.delete(0, body.length);
      body.insert(0, blocks);
      pending.push(
        ...((section.get(2) as Y.XmlElement).toArray() as Y.XmlElement[]),
      );
    }
  }
  return {
    ...document,
    schema_version: 2,
    snapshot: [...Y.encodeStateAsUpdate(doc)],
  };
});
console.log(
  JSON.stringify({
    documents,
    legacy_documents: legacy,
    expected: sectionSnapshot(note.rootSection),
  }),
);
