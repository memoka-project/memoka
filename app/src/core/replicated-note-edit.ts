import * as Y from "yjs";
import {
  ReplicatedNote,
  derivedReplicaId,
  replicateSectionSnapshot,
  type ContentNode,
} from "./replicated-note";
import type { SectionSnapshot } from "./section-model";
import { siblingPositionsBetween } from "./sibling-position";

/**
 * Core imports and structural commands reconcile by product identity. The
 * temporary candidate validates the entire requested result before any live
 * mutation; none of its Yjs identities are copied into the persisted Note.
 * Keystrokes use the Editor's per-element binding instead of this bulk path.
 */
export function applyReplicatedSectionSnapshot(
  note: ReplicatedNote,
  snapshot: SectionSnapshot,
  origin: unknown,
): void {
  if (snapshot.sectionId !== note.noteId)
    throw new Error("Root Section ID must equal Note ID");
  const candidate = replicateSectionSnapshot(snapshot, note.replicaId);
  try {
    const current = note.project(),
      desired = candidate.project();
    const identities = new Map<string, string>();
    // Infer existing column identity from cells, including virtual empty cells.
    for (const [id, entity] of candidate.entities) {
      if (entity.type !== "table") continue;
      const oldColumns = (current.children.get(id) ?? []).filter(
        (child) => note.type(child) === "tableColumn",
      );
      const used = new Set<string>();
      for (const column of (desired.children.get(id) ?? []).filter(
        (child) => candidate.type(child) === "tableColumn",
      )) {
        const known = new Set<string>();
        for (const [cell, descriptor] of candidate.entities) {
          if (descriptor.columnId !== column) continue;
          const row = desired.parents.get(cell)!.parentId;
          const prior =
            note.entities.get(cell)?.columnId ??
            oldColumns.find(
              (key) => derivedReplicaId(row, `cell:${key}`) === cell,
            );
          if (prior) known.add(prior);
        }
        if (known.size > 1)
          throw new Error("Table cells disagree about a stable column");
        const key = [...known][0] ?? column;
        if (used.has(key)) throw new Error("Duplicate Table column");
        used.add(key);
        identities.set(column, key);
      }
    }
    const identity = (id: string) => identities.get(id) ?? id;
    const nextIds = new Set([...candidate.entities.keys()].map(identity));
    for (const id of nextIds) {
      if (note.entities.has(id) && !current.visible.has(id))
        throw new Error("Protected identities require explicit recovery");
    }
    const positions = new Map<string, string>();
    for (const [parent, children] of desired.children) {
      const groups = new Map<string, string[]>();
      for (const child of children) {
        const region = desired.parents.get(child)!.region;
        const group = groups.get(region) ?? [];
        group.push(identity(child));
        groups.set(region, group);
      }
      for (const [region, children] of groups) {
        const old = (current.children.get(identity(parent)) ?? []).filter(
          (id) => current.parents.get(id)!.region === region,
        );
        for (const [id, position] of reconcileSiblingPositions(
          children,
          old,
          (id) => current.parents.get(id)!.position,
          note.replicaId + parent,
        ))
          positions.set(id, position);
      }
    }
    const ordered: string[] = [],
      pending = [candidate.noteId];
    while (pending.length) {
      const id = pending.pop()!;
      ordered.push(id);
      const children = desired.children.get(id) ?? [];
      for (let index = children.length - 1; index >= 0; index--)
        pending.push(children[index]!);
    }
    // Validate the concrete changes against a clone too: a Core command must
    // not leave a partial Yjs transaction behind if a move is rejected.
    const apply = (target: ReplicatedNote) =>
      target.transact(() => {
        for (const source of ordered) {
          const id = identity(source);
          if (
            target.entities.has(id) &&
            target.type(id) !== candidate.type(source)
          )
            target.attributes(id).set("type", candidate.type(source));
        }
        for (const source of ordered) {
          const id = identity(source),
            entity = candidate.require(source);
          if (!target.entities.has(id)) {
            const edge = desired.parents.get(source)!;
            target.createEntity(
              candidate.type(source),
              identity(edge.parentId),
              edge.region,
              positions.get(id)!,
              {
                id,
                ...(entity.columnId
                  ? { columnId: identity(entity.columnId) }
                  : {}),
              },
            );
          }
        }
        const moves = ordered.flatMap((source) => {
          const id = identity(source),
            old = current.parents.get(id),
            edge = desired.parents.get(source);
          if (!old || !edge) return [];
          const position = positions.get(id)!;
          return old.parentId !== identity(edge.parentId) ||
            old.region !== edge.region ||
            old.position !== position
            ? [
                {
                  entityId: id,
                  parentId: identity(edge.parentId),
                  region: edge.region,
                  position,
                },
              ]
            : [];
        });
        target.moveMany(moves, current.visible);
        for (const source of ordered) {
          const id = identity(source),
            attrs = candidate.attributes(source).toJSON();
          if (candidate.type(source) !== target.require(id).type)
            attrs.type = candidate.type(source);
          replaceReplicatedAttributes(target.attributes(id), attrs);
          if (
            [
              "section",
              "paragraph",
              "detailsSummary",
              "codeBlock",
              "sourceBlock",
            ].includes(candidate.type(source)) ||
            !note.entities.has(id)
          )
            replaceReplicatedInline(
              target.inline(id),
              candidate.inlineContent(source),
            );
        }
        const visible = target.project().visible;
        const removed = [...current.visible].filter(
          (id) => !nextIds.has(id) && visible.has(id),
        );
        if (removed.length) target.deleteMany(removed);
      }, origin);
    const staged = ReplicatedNote.load(
      note.noteId,
      note.replicaId,
      note.snapshot(),
    );
    try {
      apply(staged);
      staged.validate();
    } finally {
      staged.destroy();
    }
    apply(note);
  } finally {
    candidate.destroy();
  }
}

export function replaceReplicatedAttributes(
  attrs: Y.Map<unknown>,
  next: Readonly<Record<string, unknown>>,
): void {
  for (const key of new Set([...attrs.keys(), ...Object.keys(next)])) {
    if (JSON.stringify(attrs.get(key)) === JSON.stringify(next[key])) continue;
    if (next[key] === undefined || next[key] === null) attrs.delete(key);
    else attrs.set(key, next[key]);
  }
}

/** Preserve surviving character identities, including their formatting. */
export function replaceReplicatedInline(
  fragment: Y.XmlFragment,
  nodes: readonly ContentNode[],
): void {
  const desired: (
    | {
        text: string;
        runs: { insert: string; attributes: Record<string, unknown> }[];
      }
    | ContentNode
  )[] = [];
  for (const node of nodes) {
    if (node.type !== "text") {
      desired.push(node);
      continue;
    }
    let text = desired.at(-1);
    if (!text || !("runs" in text)) {
      text = { text: "", runs: [] };
      desired.push(text);
    }
    text.text += node.text ?? "";
    text.runs.push({
      insert: node.text ?? "",
      attributes: Object.fromEntries(
        (node.marks ?? []).map((mark) => [mark.type, mark.attrs ?? {}]),
      ),
    });
  }
  for (const [index, node] of desired.entries()) {
    let current = index < fragment.length ? fragment.get(index) : undefined;
    const compatible =
      "runs" in node
        ? current instanceof Y.XmlText
        : current instanceof Y.XmlElement && current.nodeName === node.type;
    if (!compatible) {
      // Keep a compatible suffix when inserting an atom before existing text.
      const next = desired[index + 1];
      const keep =
        next &&
        ("runs" in next
          ? current instanceof Y.XmlText
          : current instanceof Y.XmlElement && current.nodeName === next.type);
      if (current && !keep) fragment.delete(index, 1);
      current = "runs" in node ? new Y.XmlText() : new Y.XmlElement(node.type);
      fragment.insert(index, [current]);
    }
    if (current instanceof Y.XmlText && "runs" in node) {
      const old = current
          .toDelta()
          .map((part: { insert: unknown }) =>
            typeof part.insert === "string" ? part.insert : "",
          )
          .join(""),
        next = node.text;
      let start = 0,
        end = 0;
      while (
        start < old.length &&
        start < next.length &&
        old[start] === next[start]
      )
        start++;
      while (
        end < old.length - start &&
        end < next.length - start &&
        old[old.length - end - 1] === next[next.length - end - 1]
      )
        end++;
      if (old.length - start - end)
        current.delete(start, old.length - start - end);
      if (next.length - start - end)
        current.insert(start, next.slice(start, next.length - end));
      const previous = current.toDelta() as {
        insert: string;
        attributes?: Record<string, unknown>;
      }[];
      let offset = 0,
        runIndex = 0,
        runOffset = 0;
      for (const part of previous) {
        let left = part.insert.length;
        while (left > 0) {
          const run = node.runs[runIndex]!;
          const size = Math.min(left, run.insert.length - runOffset);
          const changes: Record<string, unknown> = {};
          for (const key of new Set([
            ...Object.keys(part.attributes ?? {}),
            ...Object.keys(run.attributes),
          ]))
            if (
              JSON.stringify(part.attributes?.[key]) !==
              JSON.stringify(run.attributes[key])
            )
              changes[key] = run.attributes[key] ?? null;
          if (Object.keys(changes).length)
            current.format(offset, size, changes);
          offset += size;
          left -= size;
          runOffset += size;
          if (runOffset === run.insert.length) {
            runIndex++;
            runOffset = 0;
          }
        }
      }
    } else if (current instanceof Y.XmlElement && !("runs" in node)) {
      const attrs = node.attrs ?? {};
      for (const key of new Set([
        ...Object.keys(current.getAttributes()),
        ...Object.keys(attrs),
      ])) {
        if (
          JSON.stringify(current.getAttribute(key)) ===
          JSON.stringify(attrs[key])
        )
          continue;
        if (attrs[key] === undefined || attrs[key] === null)
          current.removeAttribute(key);
        else current.setAttribute(key, attrs[key] as string);
      }
    }
  }
  if (fragment.length > desired.length)
    fragment.delete(desired.length, fragment.length - desired.length);
}

export function reconcileSiblingPositions(
  next: readonly string[],
  previous: readonly string[],
  position: (id: string) => string,
  seed: string,
): Map<string, string> {
  if (
    next.length === previous.length &&
    next.every((id, index) => id === previous[index])
  )
    return new Map(next.map((id) => [id, position(id)]));
  const old = new Set(previous),
    entries = next.filter((id) => old.has(id));
  const tails: number[] = [],
    predecessors = new Map<number, number>();
  for (const [index, id] of entries.entries()) {
    let low = 0,
      high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (position(entries[tails[middle]!]!) < position(id)) low = middle + 1;
      else high = middle;
    }
    if (low) predecessors.set(index, tails[low - 1]!);
    tails[low] = index;
  }
  const stable = new Set<string>();
  let cursor = tails.at(-1);
  while (cursor !== undefined) {
    stable.add(entries[cursor]!);
    cursor = predecessors.get(cursor);
  }
  const result = new Map<string, string>();
  let lower: string | null = null,
    index = 0;
  while (index < next.length) {
    let end = index;
    while (end < next.length && !stable.has(next[end]!)) end++;
    const upper = end < next.length ? position(next[end]!) : null;
    const generated = siblingPositionsBetween(
      lower,
      upper,
      end - index,
      seed + next[index]!,
    );
    for (let offset = index; offset < end; offset++)
      result.set(next[offset]!, generated[offset - index]!);
    if (end < next.length) {
      result.set(next[end]!, upper!);
      lower = upper;
    }
    index = end + 1;
  }
  return result;
}
