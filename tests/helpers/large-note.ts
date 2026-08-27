export interface ParagraphPasteFixtureOptions {
  paragraphCount: number;
  approximateParagraphBytes?: number;
}

/**
 * Deterministic, non-personal text shaped like a long technical document.
 * Blank separators deliberately exercise the browser's native plain-text
 * paste parser, which creates one Paragraph per entry.
 */
export function paragraphPasteFixture({
  paragraphCount,
  approximateParagraphBytes = 64,
}: ParagraphPasteFixtureOptions): string {
  const prefixes = [
    "日本語の検証行",
    "Runtime and editor note",
    "構造化された本文",
    "0123456789 performance sample",
  ];
  return Array.from({ length: paragraphCount }, (_, index) => {
    const prefix = `${prefixes[index % prefixes.length]} ${String(index + 1).padStart(6, "0")} `;
    const paddingLength = Math.max(
      0,
      approximateParagraphBytes - prefix.length,
    );
    return `${prefix}${"x".repeat(paddingLength)}`;
  }).join("\n\n");
}

export const HUGE_NOTE_TARGET_BYTES = 10 * 1024 * 1024;
export const HUGE_NOTE_TARGET_LOGICAL_LINES = 100_000;

/**
 * Large but structurally simple Markdown used to exercise native Clipboard
 * transport without making parser complexity dominate the regression test.
 */
export function largeMarkdownNoteFixture(minimumBytes = 128 * 1024): string {
  const title = "# Native large Markdown\n\nRoot introduction.\n\n";
  const moduleBody =
    "日本語とASCIIを含む外部Markdownの転送確認 line 0123456789\n".repeat(64);
  const module = (index: number) =>
    `# Module ${index}\n\n${moduleBody}\n## Details ${index}\n\n${moduleBody}`;
  const firstModule = module(1);
  const moduleCount = Math.max(
    2,
    Math.ceil((minimumBytes - title.length) / firstModule.length),
  );
  return `${title}${Array.from({ length: moduleCount }, (_, index) => module(index + 1)).join("\n\n")}`;
}
