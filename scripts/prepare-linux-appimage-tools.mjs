import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

if (process.platform !== "linux") {
  process.stdout.write("Skipping Linux AppImage tool preparation\n");
  process.exit(0);
}
if (process.arch !== "x64") {
  throw new Error(
    `unsupported Linux AppImage build architecture: ${process.arch}`,
  );
}

const root = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const toolsDirectory = join(root, "target", ".tauri");
const realPlugin = join(toolsDirectory, "appimage-output-real-x86_64.AppImage");
const wrapper = join(toolsDirectory, "linuxdeploy-plugin-appimage.AppImage");
const wrapperSource = join(
  root,
  "scripts",
  "linux-appimage",
  "output-plugin-wrapper.sh",
);
const pluginUrl =
  "https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage";
const expectedSha256 =
  "a45d3e227bc7f397e9cf6bfa4c9507494efa2293357b6e86690a3de2ca992e79";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hasExpectedPlugin() {
  try {
    return digest(await readFile(realPlugin)) === expectedSha256;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

await mkdir(toolsDirectory, { recursive: true });
if (!(await hasExpectedPlugin())) {
  const response = await fetch(pluginUrl, {
    headers: { "User-Agent": "memoka-appimage-builder" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      `failed to download pinned AppImage output plugin: ${response.status}`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualSha256 = digest(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `AppImage output plugin checksum mismatch: ${actualSha256}`,
    );
  }
  const temporary = `${realPlugin}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o755 });
    await rename(temporary, realPlugin);
  } finally {
    await rm(temporary, { force: true });
  }
}
await chmod(realPlugin, 0o755);
await copyFile(wrapperSource, wrapper);
await chmod(wrapper, 0o755);
process.stdout.write(`Prepared AppImage output wrapper in ${toolsDirectory}\n`);
