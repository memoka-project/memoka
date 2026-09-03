import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { appImageLauncherMarker } from "./linux-appimage-support.mjs";
import { sanitizeLinuxAppDir } from "./sanitize-linux-appdir.mjs";

const root = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const preparationSource = await readFile(
  join(root, "scripts", "prepare-linux-appimage-tools.mjs"),
  "utf8",
);
assert.doesNotMatch(preparationSource, /releases\/download\/continuous\//u);
assert.match(
  preparationSource,
  /releases\/download\/1-alpha-20250213-1\/linuxdeploy-plugin-appimage-x86_64\.AppImage/u,
);

const fixtureRoot = await mkdtemp(join(tmpdir(), "memoka-appdir-test-"));
const appDir = join(fixtureRoot, "Memoka.AppDir");
try {
  await mkdir(join(appDir, "usr", "bin"), { recursive: true });
  await mkdir(join(appDir, "usr", "lib", "nested"), { recursive: true });
  await mkdir(join(appDir, "apprun-hooks"), { recursive: true });
  await writeFile(join(appDir, "usr", "bin", "memoka"), "fixture");
  await writeFile(join(appDir, "usr", "lib", "libgtk-3.so.0"), "keep");
  await writeFile(
    join(appDir, "usr", "lib", "libwayland-client.so.0"),
    "remove",
  );
  await writeFile(
    join(appDir, "usr", "lib", "nested", "libglib-2.0.so.0"),
    "remove",
  );
  await writeFile(join(appDir, "AppRun"), "old launcher");
  await writeFile(join(appDir, "AppRun.wrapped"), "old wrapped launcher");
  await writeFile(join(appDir, "apprun-hooks", "gtk.sh"), "old hook");

  const result = await sanitizeLinuxAppDir(appDir);
  assert.equal(result.removed.length, 2);
  assert.equal(
    await readFile(join(appDir, "usr", "lib", "libgtk-3.so.0"), "utf8"),
    "keep",
  );
  assert.match(
    await readFile(join(appDir, "AppRun"), "utf8"),
    new RegExp(appImageLauncherMarker, "u"),
  );
  await assert.rejects(readFile(join(appDir, "AppRun.wrapped")), {
    code: "ENOENT",
  });

  if (process.platform === "linux") {
    const plugin = join(fixtureRoot, "fake-output-plugin.sh");
    const wrapper = join(
      root,
      "scripts",
      "linux-appimage",
      "output-plugin-wrapper.sh",
    );
    const argumentsFile = join(fixtureRoot, "plugin-arguments.txt");
    await writeFile(
      plugin,
      '#!/usr/bin/env sh\nprintf "%s\\n" "$@" > "$MEMOKA_FAKE_ARGS"\n',
    );
    await chmod(plugin, 0o755);
    await writeFile(join(appDir, "usr", "lib", "libgio-2.0.so.0"), "remove");
    await writeFile(join(appDir, "AppRun"), "old launcher");
    const wrapped = spawnSync(
      "sh",
      [wrapper, `--appdir=${appDir}`, "--plugin-type"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          MEMOKA_APPIMAGE_PLUGIN_REAL: plugin,
          MEMOKA_FAKE_ARGS: argumentsFile,
          MEMOKA_PROJECT_ROOT: root,
        },
      },
    );
    if (wrapped.error) throw wrapped.error;
    assert.equal(wrapped.status, 0, wrapped.stderr);
    assert.deepEqual(
      (await readFile(argumentsFile, "utf8")).trim().split("\n"),
      [`--appdir=${appDir}`, "--plugin-type"],
    );
    await assert.rejects(
      readFile(join(appDir, "usr", "lib", "libgio-2.0.so.0")),
      { code: "ENOENT" },
    );
    assert.match(
      await readFile(join(appDir, "AppRun"), "utf8"),
      new RegExp(appImageLauncherMarker, "u"),
    );
  }
  process.stdout.write("Linux AppImage sanitizer contract passed\n");
} finally {
  await rm(fixtureRoot, { force: true, recursive: true });
}
