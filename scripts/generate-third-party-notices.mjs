import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { RESTIC_VERSION, RESTIC_ARTIFACTS } from "./restic-artifacts.mjs";
import { RCLONE_VERSION, RCLONE_ARTIFACTS } from "./rclone-artifacts.mjs";

const root = new URL("../", import.meta.url);
const host =
  process.platform === "win32"
    ? "x86_64-pc-windows-msvc"
    : "x86_64-unknown-linux-gnu";
const rcloneBinary = new URL(
  `src-tauri/binaries/rclone-${host}${process.platform === "win32" ? ".exe" : ""}`,
  root,
);
if (
  createHash("sha256")
    .update(await readFile(rcloneBinary))
    .digest("hex") !== RCLONE_ARTIFACTS[host].executableSha256
)
  throw new Error("Prepare the pinned rclone before generating notices");
const rcloneBuild = execFileSync(
  fileURLToPath(rcloneBinary),
  ["version", "--deps"],
  { encoding: "utf8", maxBuffer: 1024 * 1024 },
);
const goModules = (rcloneBuild.split("Dependencies:\n")[1] ?? "")
  .trim()
  .split("\n")
  .filter((line) => line.startsWith("- "));
if (goModules.length < 10)
  throw new Error("Bundled rclone Go module inventory is missing");
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

const nightfoxNotice = `## Bundled color palettes

Memoka derives its seven built-in color palettes from
[EdenEast/nightfox.nvim](https://github.com/EdenEast/nightfox.nvim) at commit
\`4dacd3f0185a2227bdf3b6c0975a8f0bf87cac9a\`.
Carbonfox incorporates the coherent Carbon Design palette proposed in
[nightfox.nvim PR #487](https://github.com/EdenEast/nightfox.nvim/pull/487) at commit
\`b97bb277cf5f5abdf408afc1988a8ea6cf74d2d5\`; that pull request was closed without merge.

\`\`\`text
MIT License

Copyright (c) 2021 James Simpson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
\`\`\`
`;

const resticNotice = `## Bundled Restic

[Restic ${RESTIC_VERSION}](https://github.com/restic/restic/releases/tag/v${RESTIC_VERSION}) is bundled unchanged as a local backup sidecar, under the [BSD 2-Clause license](https://github.com/restic/restic/blob/v${RESTIC_VERSION}/LICENSE).
The build verifies these official release archive SHA-256 values:

${Object.values(RESTIC_ARTIFACTS)
  .map(
    (artifact) =>
      `- restic_${RESTIC_VERSION}_${artifact.suffix}: \`${artifact.sha256}\``,
  )
  .join("\n")}

The release SBOM also inventories the Go modules embedded in the bundled executable.

\`\`\`text
${(await readFile(new URL("LICENSES/restic.txt", root), "utf8")).trimEnd()}
\`\`\`
`;

const document = `# Third-party notices

Memoka includes open-source dependencies and bundled palette data listed below. The dependency inventory is generated from the
locked JavaScript and Rust dependency graphs by
\`corepack pnpm release:notices\`. The SPDX SBOM attached to every GitHub Release is the
machine-readable inventory. Each project remains subject to its listed license; consult the
linked upstream project and the dependency source package for the complete license text.

${nightfoxNotice}
${resticNotice}
## Bundled rclone

[rclone ${RCLONE_VERSION}](https://github.com/rclone/rclone/releases/tag/v${RCLONE_VERSION}) is bundled unchanged as the Google Drive transport for Restic, under the MIT license.
Archives and executable hashes are pinned in scripts/rclone-artifacts.mjs. The release SBOM inventories the executable's embedded Go modules.

${Object.values(RCLONE_ARTIFACTS)
  .map(
    (artifact) =>
      `- rclone-v${RCLONE_VERSION}-${artifact.platform}.zip: \`${artifact.sha256}\``,
  )
  .join("\n")}

\`\`\`text
${(await readFile(new URL("LICENSES/rclone.txt", root), "utf8")).trimEnd()}
\`\`\`

${render("JavaScript dependencies", javascript)}
${render("Rust dependencies", rust)}

## Bundled rclone Go module inventory (${RCLONE_ARTIFACTS[host].platform})

Read directly from the verified executable's Go build information. The Release SPDX SBOM includes this compiled dependency graph.
Module licenses and source are available from each module's versioned source distribution; rclone's MIT license does not relicense its dependencies.

${goModules
  .map((line) => {
    const [module, version] = line.slice(2).split(" ");
    return `- [${module}@${version}](https://pkg.go.dev/${module}@${version}?tab=licenses)`;
  })
  .join("\n")}
`;
await writeFile(
  new URL("THIRD_PARTY_NOTICES.md", root),
  await format(document, { parser: "markdown" }),
  "utf8",
);
await writeFile(
  new URL("SIDECARS.json", root),
  JSON.stringify(
    {
      schema_version: 1,
      restic: { version: RESTIC_VERSION, artifacts: RESTIC_ARTIFACTS },
      rclone: { version: RCLONE_VERSION, artifacts: RCLONE_ARTIFACTS },
    },
    null,
    2,
  ) + "\n",
  "utf8",
);
