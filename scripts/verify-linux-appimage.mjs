import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  appImageLauncherMarker,
  inspectSanitizedAppDir,
} from "./linux-appimage-support.mjs";

async function findDefaultAppImage() {
  const directory = resolve("target/release/bundle/appimage");
  const candidates = (await readdir(directory))
    .filter((name) => name.endsWith(".AppImage"))
    .sort();
  if (candidates.length !== 1) {
    throw new Error(
      `expected one AppImage in ${directory}, found ${candidates.length}`,
    );
  }
  return join(directory, candidates[0]);
}

const appImage = resolve(process.argv[2] ?? (await findDefaultAppImage()));
const extractionRoot = await mkdtemp(join(tmpdir(), "memoka-appimage-verify-"));
try {
  await chmod(appImage, 0o755);
  const extracted = spawnSync(appImage, ["--appimage-extract"], {
    cwd: extractionRoot,
    encoding: "utf8",
  });
  if (extracted.error) throw extracted.error;
  if (extracted.status !== 0) {
    throw new Error(
      `failed to extract ${appImage}: ${extracted.stderr || extracted.stdout}`,
    );
  }
  const appDir = join(extractionRoot, "squashfs-root");
  const { launcher, forbiddenLibraries } = await inspectSanitizedAppDir(appDir);
  if (!launcher.includes(appImageLauncherMarker)) {
    throw new Error("Memoka AppImage launcher marker is missing");
  }
  if (launcher.includes("GTK_IM_MODULE_FILE")) {
    throw new Error("AppImage launcher must not force a build-host IME cache");
  }
  if (/GDK_BACKEND\s*=\s*x11/u.test(launcher)) {
    throw new Error("AppImage launcher must not force XWayland");
  }
  if (forbiddenLibraries.length > 0) {
    throw new Error(
      `AppImage contains host-conflicting libraries: ${forbiddenLibraries.join(", ")}`,
    );
  }
  try {
    await readFile(join(appDir, "AppRun.wrapped"));
    throw new Error("AppImage still contains the generated AppRun.wrapped");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  process.stdout.write(
    `Verified ${basename(appImage)}: native session launcher and host runtime boundary\n`,
  );
} finally {
  await rm(extractionRoot, { force: true, recursive: true });
}
