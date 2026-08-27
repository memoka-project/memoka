import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { format } from "prettier";

const root = new URL("../", import.meta.url);
const pnpm = JSON.parse(
  execFileSync(
    process.platform === "win32" ? "corepack.cmd" : "corepack",
    ["pnpm", "licenses", "list", "--json", "--prod"],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  ),
);
const cargo = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version=1"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }),
);

const javascript = [];
for (const [license, entries] of Object.entries(pnpm)) {
  for (const entry of entries) {
    for (const version of entry.versions) {
      javascript.push({
        name: `${entry.name}@${version}`,
        license,
        homepage: entry.homepage ?? "",
      });
    }
  }
}
const rust = cargo.packages
  .filter((entry) => entry.source !== null)
  .map((entry) => ({
    name: `${entry.name}@${entry.version}`,
    license: entry.license ?? "UNKNOWN",
    homepage: entry.homepage ?? entry.repository ?? "",
  }));

const render = (title, entries) => {
  const unique = new Map(
    entries.map((entry) => [`${entry.name}\0${entry.license}`, entry]),
  );
  const lines = [...unique.values()]
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .map(
      ({ name, license, homepage }) =>
        `- ${name} — ${license}${homepage ? ` — ${homepage}` : ""}`,
    );
  return `## ${title}\n\n${lines.join("\n")}\n`;
};

const document = `# Third-party notices

Memoka includes open-source dependencies listed below. This inventory is generated from the
locked JavaScript and Rust dependency graphs by
\`corepack pnpm release:notices\`. The SPDX SBOM attached to every GitHub Release is the
machine-readable inventory. Each project remains subject to its listed license; consult the
linked upstream project and the dependency source package for the complete license text.

${render("JavaScript dependencies", javascript)}
${render("Rust dependencies", rust)}
`;
await writeFile(
  new URL("THIRD_PARTY_NOTICES.md", root),
  await format(document, { parser: "markdown" }),
  "utf8",
);
