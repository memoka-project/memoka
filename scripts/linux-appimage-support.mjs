import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const appImageLauncherMarker = "memoka-appimage-launcher-v1";

const forbiddenLibraryPatterns = [
  /^libwayland-.*\.so(?:\..*)?$/u,
  /^libglib-2\.0\.so(?:\..*)?$/u,
  /^libgio-2\.0\.so(?:\..*)?$/u,
  /^libgobject-2\.0\.so(?:\..*)?$/u,
  /^libgmodule-2\.0\.so(?:\..*)?$/u,
  /^libgthread-2\.0\.so(?:\..*)?$/u,
  /^libgst.*\.so(?:\..*)?$/u,
  /^libmount\.so(?:\..*)?$/u,
  /^libblkid\.so(?:\..*)?$/u,
  /^libselinux\.so(?:\..*)?$/u,
  /^libpcre2-8\.so(?:\..*)?$/u,
  /^libzstd\.so(?:\..*)?$/u,
  /^libelf\.so(?:\..*)?$/u,
  /^libffi\.so(?:\..*)?$/u,
];

export function isForbiddenAppImageLibrary(path) {
  const name = basename(path);
  return forbiddenLibraryPatterns.some((pattern) => pattern.test(name));
}

export async function listFilesRecursively(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

export async function inspectSanitizedAppDir(appDir) {
  const launcher = await readFile(join(appDir, "AppRun"), "utf8");
  const files = await listFilesRecursively(join(appDir, "usr", "lib"));
  return {
    launcher,
    forbiddenLibraries: files.filter(isForbiddenAppImageLibrary),
  };
}
