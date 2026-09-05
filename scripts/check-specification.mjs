import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const entryPath = path.join(repositoryRoot, "doc", "specification.md");
const categoryDirectory = path.join(repositoryRoot, "doc", "specification");
const commandCatalogPath = path.join(
  repositoryRoot,
  "app",
  "src",
  "core",
  "application-command.ts",
);
const leaderCatalogPath = path.join(
  repositoryRoot,
  "app",
  "src",
  "core",
  "leader-shortcuts.ts",
);

const failures = [];

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(target)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(target);
    }
  }
  return files.sort();
}

function localMarkdownTargets(source) {
  const targets = [];
  const expression = /!?\[[^\]]*\]\(([^)]+)\)/gu;
  for (const match of source.matchAll(expression)) {
    const raw = match[1]?.trim();
    if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(raw)) {
      continue;
    }
    const unwrapped =
      raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
    const pathname = decodeURIComponent(unwrapped.split("#", 1)[0] ?? "");
    if (pathname) targets.push(pathname);
  }
  return targets;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(entryPath))) {
  failures.push("missing canonical entry: doc/specification.md");
} else {
  const entry = await readFile(entryPath, "utf8");
  const categories = await markdownFiles(categoryDirectory);
  for (const category of categories) {
    const relative = path
      .relative(path.dirname(entryPath), category)
      .split(path.sep)
      .join("/");
    if (!entry.includes("](" + relative + ")")) {
      failures.push("orphan specification category: " + relative);
    }
  }

  const allDocuments = [entryPath, ...categories];
  for (const document of allDocuments) {
    const source = await readFile(document, "utf8");
    if (document !== entryPath && !source.includes("](../specification.md)")) {
      failures.push(
        "specification category does not link back to the canonical entry: " +
          path.relative(repositoryRoot, document),
      );
    }
    for (const target of localMarkdownTargets(source)) {
      const resolved = path.resolve(path.dirname(document), target);
      if (!(await exists(resolved))) {
        failures.push(
          "broken local link in " +
            path.relative(repositoryRoot, document) +
            ": " +
            target,
        );
      }
    }
  }

  const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
  if (!readme.includes("](doc/specification.md)")) {
    failures.push("README.md does not link to doc/specification.md");
  }

  const commandCatalog = await readFile(commandCatalogPath, "utf8");
  const commandSpecification = await readFile(
    path.join(categoryDirectory, "configuration-and-commands.md"),
    "utf8",
  );
  const commandNames = [
    ...commandCatalog.matchAll(/\n\s+name: "([^"]+)"/gu),
  ].map((match) => match[1]);
  const commandAliases = [
    ...commandCatalog.matchAll(/\n\s+aliases: \[([^\]]*)\]/gu),
  ].flatMap((match) =>
    [...(match[1] ?? "").matchAll(/"([^"]+)"/gu)].map((alias) => alias[1]),
  );
  for (const command of [...commandNames, ...commandAliases]) {
    if (command && !commandSpecification.includes("`:" + command)) {
      failures.push(
        "application command is missing from the specification: :" + command,
      );
    }
  }

  const leaderCatalog = await readFile(leaderCatalogPath, "utf8");
  const vimSpecification = await readFile(
    path.join(categoryDirectory, "vim-operations.md"),
    "utf8",
  );
  const leaderKeys = [...leaderCatalog.matchAll(/\n\s+key: "([^"]+)"/gu)].map(
    (match) => match[1],
  );
  for (const key of leaderKeys) {
    if (key && !vimSpecification.includes("`<Leader>" + key + "`")) {
      failures.push(
        "Leader category is missing from the specification: <Leader>" + key,
      );
    }
  }

  if (
    /memoka_specification_v0\.4|文書バージョン\s*:|Phase 1実装基準/u.test(entry)
  ) {
    failures.push(
      "doc/specification.md must remain a versionless living specification",
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write("specification check: " + failure + "\n");
  }
  process.exitCode = 1;
} else {
  process.stdout.write("Specification links and category index are valid.\n");
}
