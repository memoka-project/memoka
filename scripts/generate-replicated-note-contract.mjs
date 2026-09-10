import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { format } from "prettier";

// Use the compiler bundled with the pinned Vite toolchain. No network or CLI install.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "memoka-replication-contract-"));
try {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["scripts/replicated-note-contract-fixture.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const file = join(directory, "fixture.mjs");
  await writeFile(file, result.outputFiles[0].contents);
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    await import(pathToFileURL(file).href);
  } finally {
    process.stdout.write = original;
  }
  await writeFile(
    join(root, "tests/fixtures/replicated-note-contract.json"),
    await format(JSON.stringify(JSON.parse(output)), { parser: "json" }),
  );
  const native = join(root, "tests/fixtures/replicated-note-native.json");
  execFileSync(
    "cargo",
    [
      "test",
      "-p",
      "memoka-desktop",
      "replicated_note::edit::tests::native_update_fixture",
      "--lib",
    ],
    {
      cwd: root,
      stdio: "pipe",
      env: { ...process.env, MEMOKA_REPLICATED_NATIVE_FIXTURE: native },
    },
  );
  await writeFile(
    native,
    await format(await readFile(native, "utf8"), { parser: "json" }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
