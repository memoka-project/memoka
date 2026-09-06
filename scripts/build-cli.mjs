import { spawnSync } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(process.execPath, ["scripts/prepare-restic.mjs"]);
run("cargo", [
  "build",
  "--locked",
  "--release",
  "-p",
  "memoka-desktop",
  "--bin",
  "memoka-cli",
]);
const windows = process.platform === "win32";
const target = windows
  ? "x86_64-pc-windows-msvc.exe"
  : "x86_64-unknown-linux-gnu";
await copyFile(
  join(root, "src-tauri", "binaries", `restic-${target}`),
  join(root, "target", "release", windows ? "restic.exe" : "restic"),
);
