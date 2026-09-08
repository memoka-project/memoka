/** Indent every line of every block, including blank paragraph separators. */
export function listItemMarkdown(
  blocks: readonly string[],
  marker: string,
  indentation = "",
  nested: readonly boolean[] = [],
  checked?: boolean | null,
  firstParagraph = true,
): string {
  if (typeof checked === "boolean" && !firstParagraph) {
    return listItemMarkdown(
      ["", ...blocks],
      marker,
      indentation,
      [false, ...nested],
      checked,
    );
  }
  const lines = blocks
    .map(
      (block, index) =>
        (index ? (nested[index] ? "\n" : "\n\n") : "") +
        block.replace(/\n+$/u, ""),
    )
    .join("")
    .split("\n");
  const padding = indentation + " ".repeat(marker.length + 1);
  const task = typeof checked === "boolean" ? `[${checked ? "x" : " "}] ` : "";
  return `${indentation}${marker} ${task}${lines[0] ?? ""}\n${lines
    .slice(1)
    .map((line) => `${padding}${line}\n`)
    .join("")}`;
}
