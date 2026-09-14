import { assertUuidV7 } from "./ids";
import {
  compareSiblingPositions,
  isCanonicalSiblingPosition,
} from "./sibling-position";

/** Parent and sibling position are one immutable operation, never two LWW keys. */
export interface Placement {
  readonly operationId: string;
  readonly replicaId: string;
  readonly counter: number;
  readonly entityId: string;
  readonly parentId: string;
  readonly region: string;
  readonly position: string;
}

export interface TreeProjection {
  readonly parents: ReadonlyMap<string, Placement>;
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly reverted: ReadonlySet<string>;
}

export function comparePlacement(left: Placement, right: Placement): number {
  return (
    left.counter - right.counter ||
    compareSiblingPositions(left.replicaId, right.replicaId) ||
    compareSiblingPositions(left.operationId, right.operationId) ||
    compareSiblingPositions(left.entityId, right.entityId)
  );
}

export function validatePlacement(value: Placement): void {
  for (const field of [
    "operationId",
    "replicaId",
    "entityId",
    "parentId",
  ] as const) {
    assertUuidV7(value[field], field);
  }
  if (
    !Number.isSafeInteger(value.counter) ||
    value.counter < 1 ||
    !isCanonicalSiblingPosition(value.position) ||
    typeof value.region !== "string" ||
    value.region.length === 0 ||
    value.region.length > 80
  ) {
    throw new Error("Invalid replicated placement");
  }
  if (value.entityId === value.parentId)
    throw new Error("A node cannot parent itself");
}

/**
 * Mutable Tree Hierarchy: select latest edges, then attach disconnected components
 * through their highest-priority historical edge to the rooted component. This is
 * a read-only projection. In particular, receiving a cycle never emits an update.
 * https://madebyevan.com/algos/crdt-mutable-tree-hierarchy/
 */
export function deriveReplicatedTree(
  rootId: string,
  entityIds: ReadonlySet<string>,
  history: Iterable<Placement>,
): TreeProjection {
  assertUuidV7(rootId, "rootId");
  if (!entityIds.has(rootId)) throw new Error("Replicated tree has no root");
  const latest = new Map<string, Placement>();
  const alternatives = new Map<string, Placement[]>();
  const operations = new Set<string>();
  for (const edge of history) {
    validatePlacement(edge);
    if (
      !entityIds.has(edge.entityId) ||
      !entityIds.has(edge.parentId) ||
      edge.entityId === rootId
    ) {
      throw new Error(
        "Replicated placement references an unknown node or moves the root",
      );
    }
    if (operations.has(edge.operationId))
      throw new Error("Duplicate placement operation");
    operations.add(edge.operationId);
    const previous = latest.get(edge.entityId);
    if (!previous || comparePlacement(previous, edge) < 0)
      latest.set(edge.entityId, edge);
    const edges = alternatives.get(edge.parentId) ?? [];
    edges.push(edge);
    alternatives.set(edge.parentId, edges);
  }
  for (const id of entityIds) {
    if (id !== rootId && !latest.has(id))
      throw new Error(`Node has no placement: ${id}`);
  }

  const parents = new Map(latest);
  const reverse = new Map<string, Set<string>>();
  for (const [child, edge] of parents) {
    const siblings = reverse.get(edge.parentId) ?? new Set<string>();
    siblings.add(child);
    reverse.set(edge.parentId, siblings);
  }
  const rooted = new Set<string>();
  const queue = new PlacementHeap();
  const attach = (first: string) => {
    const pending = [first];
    while (pending.length) {
      const id = pending.pop()!;
      if (rooted.has(id)) continue;
      rooted.add(id);
      for (const edge of alternatives.get(id) ?? []) queue.push(edge);
      for (const child of reverse.get(id) ?? []) pending.push(child);
    }
  };
  attach(rootId);
  while (queue.size) {
    const edge = queue.pop();
    if (rooted.has(edge.entityId)) continue;
    const old = parents.get(edge.entityId)!;
    reverse.get(old.parentId)?.delete(edge.entityId);
    parents.set(edge.entityId, edge);
    const siblings = reverse.get(edge.parentId) ?? new Set<string>();
    siblings.add(edge.entityId);
    reverse.set(edge.parentId, siblings);
    attach(edge.entityId);
  }
  if (rooted.size !== entityIds.size)
    throw new Error("Replicated tree has no rooted parent history");
  const children = new Map<string, string[]>();
  const reverted = new Set<string>();
  for (const [id, edge] of parents) {
    if (edge !== latest.get(id)) reverted.add(id);
    const siblings = children.get(edge.parentId) ?? [];
    siblings.push(id);
    children.set(edge.parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => {
      const left = parents.get(a)!;
      const right = parents.get(b)!;
      return (
        compareSiblingPositions(left.region, right.region) ||
        compareSiblingPositions(left.position, right.position) ||
        compareSiblingPositions(a, b)
      );
    });
  }
  return { parents, children, reverted };
}

/** Bounded by the number of edges; avoids rescanning a large tree for each cycle. */
class PlacementHeap {
  private readonly values: Placement[] = [];
  get size(): number {
    return this.values.length;
  }
  push(value: Placement): void {
    let index = this.values.length;
    this.values.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (comparePlacement(this.values[parent]!, value) >= 0) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = value;
  }
  pop(): Placement {
    const first = this.values[0]!;
    const last = this.values.pop()!;
    if (!this.values.length) return first;
    let index = 0;
    while (index * 2 + 1 < this.values.length) {
      let next = index * 2 + 1;
      if (
        next + 1 < this.values.length &&
        comparePlacement(this.values[next + 1]!, this.values[next]!) > 0
      )
        next++;
      if (comparePlacement(last, this.values[next]!) >= 0) break;
      this.values[index] = this.values[next]!;
      index = next;
    }
    this.values[index] = last;
    return first;
  }
}
