import { spawnSync } from "node:child_process";
import process from "node:process";

const bundles =
  process.platform === "win32"
    ? ["nsis"]
    : process.platform === "linux"
      ? ["deb", "appimage"]
      : null;
if (!bundles) {
  throw new Error(`unsupported local release platform: ${process.platform}`);
}

const result = spawnSync(
  process.platform === "win32" ? "corepack.cmd" : "corepack",
  ["pnpm", "tauri", "build", "--bundles", bundles.join(",")],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
