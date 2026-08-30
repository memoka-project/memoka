import { access, chmod, copyFile, realpath, rm } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  inspectSanitizedAppDir,
  isForbiddenAppImageLibrary,
  listFilesRecursively,
} from "./linux-appimage-support.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const launcher = join(scriptDirectory, "linux-appimage", "AppRun");

export async function sanitizeLinuxAppDir(candidate) {
  const appDir = await realpath(resolve(candidate));
  if (appDir === parse(appDir).root || !appDir.endsWith(".AppDir")) {
    throw new Error(`refusing to sanitize unexpected AppDir path: ${appDir}`);
  }
  await access(join(appDir, "usr", "bin", "memoka"));

  const libraryRoot = join(appDir, "usr", "lib");
  const libraries = await listFilesRecursively(libraryRoot);
  const removed = libraries.filter(isForbiddenAppImageLibrary);
  await Promise.all(removed.map((path) => rm(path, { force: true })));

  await rm(join(appDir, "apprun-hooks"), { force: true, recursive: true });
  await rm(join(appDir, "AppRun.wrapped"), { force: true });
  await copyFile(launcher, join(appDir, "AppRun"));
  await chmod(join(appDir, "AppRun"), 0o755);

  const inspected = await inspectSanitizedAppDir(appDir);
  if (inspected.forbiddenLibraries.length > 0) {
    throw new Error(
      `forbidden AppImage libraries remain: ${inspected.forbiddenLibraries.join(", ")}`,
    );
  }
  process.stdout.write(
    `Sanitized ${appDir}: removed ${removed.length} host-integration libraries\n`,
  );
  return { appDir, removed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const candidate = process.argv[2];
  if (!candidate) throw new Error("usage: sanitize-linux-appdir.mjs <AppDir>");
  await sanitizeLinuxAppDir(candidate);
}
