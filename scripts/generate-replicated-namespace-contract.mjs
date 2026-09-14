import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { format } from "prettier";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "memoka-namespace-contract-"));
try {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["scripts/replicated-namespace-contract-fixture.ts"],
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
    join(root, "tests/fixtures/replicated-namespace-contract.json"),
    await format(JSON.stringify(JSON.parse(output)), { parser: "json" }),
  );
  const native = join(root, "tests/fixtures/replicated-namespace-native.json");
  execFileSync(
    "cargo",
    [
      "test",
      "-p",
      "memoka-desktop",
      "replicated_namespace::tests::native_moves_after_cycle_correction_preserve_stable_entry_identity",
      "--lib",
    ],
    {
      cwd: root,
      stdio: "pipe",
      env: { ...process.env, MEMOKA_NAMESPACE_NATIVE_FIXTURE: native },
    },
  );
  await writeFile(
    native,
    await format(await readFile(native, "utf8"), { parser: "json" }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
