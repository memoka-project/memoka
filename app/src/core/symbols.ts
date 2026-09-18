import names from "./data/symbol-names.json";
import aliases from "./data/symbol-aliases.json";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

const knownNames = new Set<string>(names);
export function canonicalIconName(name: string): string | undefined {
  return knownNames.has(name)
    ? name
    : Object.hasOwn(aliases, name)
      ? (aliases as Readonly<Record<string, string>>)[name]
      : undefined;
}
export interface IconToken {
  readonly from: number;
  readonly to: number;
  readonly name: string;
}
export function iconTokens(text: string): IconToken[] {
  return [...text.matchAll(/:lucide-([a-z0-9]+(?:-[a-z0-9]+)*):/g)]
    .filter((match) => canonicalIconName(match[1]!) !== undefined)
    .map((match) => ({
      from: match.index,
      to: match.index + match[0].length,
      name: canonicalIconName(match[1]!)!,
    }));
}

const byNode = new WeakMap<ProseMirrorNode, readonly IconToken[]>();
/** Offsets are UTF-16 content offsets; code marks and inline atoms split tokens. */
export function textblockIconTokens(
  node: ProseMirrorNode,
): readonly IconToken[] {
  const cached = byNode.get(node);
  if (cached) return cached;
  let text = "";
  if (node.isTextblock && !node.type.spec.code) {
    node.forEach((child) => {
      text +=
        child.isText && !child.marks.some((mark) => mark.type.name === "code")
          ? child.text!
          : "\n".repeat(child.nodeSize);
    });
  }
  const tokens = iconTokens(text);
  byNode.set(node, tokens);
  return tokens;
}

export type SymbolFilter = "All" | "Emoji" | "Lucide";
export interface SymbolEntry {
  readonly id: string;
  readonly type: Exclude<SymbolFilter, "All">;
  readonly name: string;
  readonly value: string;
  readonly aliases: readonly string[];
}
export async function loadSymbolCatalog(): Promise<readonly SymbolEntry[]> {
  const [{ default: emoji }, { default: icons }] = await Promise.all([
    import("./data/symbol-emoji.json"),
    import("./data/symbol-icons.json"),
  ]);
  return [
    ...emoji.map(([value, name]) => ({
      id: value!,
      type: "Emoji" as const,
      name: name!,
      value: value!,
      aliases: [],
    })),
    ...Object.entries(icons).map(([name, data]) => ({
      id: name,
      type: "Lucide" as const,
      name,
      value: `:lucide-${name}:`,
      aliases: data.aliases,
    })),
  ];
}
export function filterSymbols(
  catalog: readonly SymbolEntry[],
  query: string,
  filter: SymbolFilter,
): SymbolEntry[] {
  const normalized = query.trim().toLowerCase();
  const words = normalized.split(/\s+/);
  return catalog
    .filter((entry) => filter === "All" || entry.type === filter)
    .map((entry) => {
      const labels = [
        entry.name,
        entry.value,
        ...entry.aliases.flatMap((alias) => {
          const kebab = alias
            .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
            .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
            .toLowerCase();
          return [alias, kebab, `:lucide-${kebab}:`];
        }),
      ].map((value) => value.toLowerCase());
      const score = !normalized
        ? 0
        : labels.some((value) => value === normalized)
          ? 0
          : labels.some((value) => value.startsWith(normalized))
            ? 1
            : words.every((word) =>
                  labels.some((value) => value.split(/[\s-]+/).includes(word)),
                )
              ? 2
              : words.every((word) =>
                    labels.some((value) => value.includes(word)),
                  )
                ? 3
                : 4;
      return { entry, score };
    })
    .filter(({ score }) => score < 4)
    .sort((a, b) => a.score - b.score)
    .map(({ entry }) => entry);
}
