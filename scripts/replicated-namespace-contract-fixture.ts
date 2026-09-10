import * as Y from "yjs";
import {
  addNoteMetadata,
  createReplicatedWorkspaceDocument,
  createWorkspaceDocument,
  encodeProductDocument,
  listNoteMetadata,
  loadProductDocument,
  type WorkspaceDocument,
} from "../app/src/core/documents";
import {
  applyNamespacePlan,
  listNamespaceEntries,
  planNamespaceEdit,
  type NamespaceEdit,
} from "../app/src/core/namespace";
import { createUuidV7 } from "../app/src/core/ids";

const at = "2026-09-10T00:00:00.000Z";
const fixtures: unknown[] = [];
function edit(workspace: WorkspaceDocument, request: NamespaceEdit) {
  applyNamespacePlan(
    workspace,
    planNamespaceEdit(workspace, request, createUuidV7()),
    "fixture",
  );
}
function group(
  workspace: WorkspaceDocument,
  name: string,
  parentEntryId: string | null = null,
) {
  const entryId = createUuidV7();
  edit(workspace, { kind: "create-group", entryId, parentEntryId, name, at });
  return entryId;
}
function fork(workspace: WorkspaceDocument) {
  return loadProductDocument(
    "workspace",
    workspace.id,
    encodeProductDocument(workspace),
    [],
    createUuidV7(),
  ) as WorkspaceDocument;
}
function capture(
  name: string,
  workspace: WorkspaceDocument,
  legacySnapshot?: number[],
) {
  const entries = Object.fromEntries(
    listNamespaceEntries(workspace.root).map((entry) => [
      entry.entryId,
      {
        entry_id: entry.entryId,
        parent_entry_id: entry.parentEntryId,
        position: entry.position,
        target: entry.target,
        name: entry.name,
        created_at: entry.createdAt,
        updated_at: entry.updatedAt,
        deleted_at: entry.deletedAt ?? null,
        trash_operation_id: entry.trashOperationId ?? null,
      },
    ]),
  );
  const notes = workspace.notes.toJSON();
  for (const note of listNoteMetadata(workspace))
    Object.assign(notes[note.noteId], {
      deleted_at: note.deletedAt ?? null,
      trash_operation_id: note.trashOperationId ?? null,
    });
  fixtures.push({
    name,
    workspaceId: workspace.id,
    snapshot: [...encodeProductDocument(workspace)],
    projection: { entries, notes },
    ...(legacySnapshot ? { legacySnapshot } : {}),
  });
}
const old = createWorkspaceDocument(createUuidV7());
const parent = group(old, "Parent"),
  earlier = group(old, "Earlier Trash", parent);
addNoteMetadata(old, {
  noteId: createUuidV7(),
  title: "Help",
  systemRole: "help",
  notePosition: "a0",
  parentEntryId: parent,
  createdAt: at,
  updatedAt: at,
});
edit(old, { kind: "trash", entryId: earlier, at });
edit(old, { kind: "trash", entryId: parent, at });
const a = createReplicatedWorkspaceDocument(old, createUuidV7());
capture("legacy-ids-help-and-independent-trash", a, [
  ...encodeProductDocument(old),
]);
edit(a, { kind: "restore", entryId: parent, at });
const x = group(a, "X"),
  y = group(a, "Y"),
  z = group(a, "Z");
const b = fork(a),
  c = fork(a);
edit(a, {
  kind: "move-to",
  entryId: x,
  targetParentId: y,
  placement: { kind: "last" },
  at,
});
edit(b, {
  kind: "move-to",
  entryId: y,
  targetParentId: z,
  placement: { kind: "last" },
  at,
});
edit(c, {
  kind: "move-to",
  entryId: z,
  targetParentId: x,
  placement: { kind: "last" },
  at,
});
Y.applyUpdate(a.doc, encodeProductDocument(b));
Y.applyUpdate(a.doc, encodeProductDocument(c));
capture("three-replica-cyclic-move", a);
Y.applyUpdate(b.doc, encodeProductDocument(a));
edit(a, { kind: "trash", entryId: parent, at });
addNoteMetadata(b, {
  noteId: createUuidV7(),
  title: "Offline child",
  notePosition: "a1",
  parentEntryId: parent,
  createdAt: at,
  updatedAt: at,
});
edit(b, { kind: "rename-group", entryId: parent, name: "Edited Parent", at });
Y.applyUpdate(a.doc, encodeProductDocument(b));
capture("deleted-parent-and-concurrent-child-add", a);
edit(a, { kind: "restore", entryId: parent, at });
capture("restored-parent-keeps-concurrent-child", a);
Y.applyUpdate(b.doc, encodeProductDocument(a));
edit(a, { kind: "trash", entryId: parent, at });
const restoration = planNamespaceEdit(
  a,
  { kind: "restore", entryId: parent, at },
  createUuidV7(),
);
edit(b, { kind: "trash", entryId: parent, at });
Y.applyUpdate(a.doc, encodeProductDocument(b));
applyNamespacePlan(a, restoration, "fixture");
capture("observed-restore-preserves-another-delete", a);
for (const workspace of [old, a, b, c]) workspace.doc.destroy();
process.stdout.write(JSON.stringify(fixtures));
