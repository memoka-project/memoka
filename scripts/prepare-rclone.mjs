import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  chmod,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { RCLONE_VERSION, RCLONE_ARTIFACTS } from "./rclone-artifacts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const target =
  process.argv[2] ??
  execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(
    /^host: (.+)$/m,
  )?.[1];
const artifact = RCLONE_ARTIFACTS[target];
if (!artifact) throw new Error(`No verified rclone artifact for ${target}`);
const stem = `rclone-v${RCLONE_VERSION}-${artifact.platform}`;
const cache = path.join(root, ".tools", "rclone", `${stem}.zip`);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let archive = await readFile(cache).catch(() => null);
if (!archive || digest(archive) !== artifact.sha256) {
  const response = await fetch(
    `https://downloads.rclone.org/v${RCLONE_VERSION}/${stem}.zip`,
  );
  if (!response.ok)
    throw new Error(`rclone download failed: HTTP ${response.status}`);
  archive = Buffer.from(await response.arrayBuffer());
  if (digest(archive) !== artifact.sha256)
    throw new Error("rclone archive checksum mismatch");
  await mkdir(path.dirname(cache), { recursive: true });
  await writeFile(cache, archive);
}
const temporary = await mkdtemp(path.join(os.tmpdir(), "memoka-rclone-"));
try {
  if (process.platform === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $env:MEMOKA_RCLONE_ARCHIVE -DestinationPath $env:MEMOKA_RCLONE_TEMP",
      ],
      {
        env: {
          ...process.env,
          MEMOKA_RCLONE_ARCHIVE: cache,
          MEMOKA_RCLONE_TEMP: temporary,
        },
      },
    );
  } else execFileSync("unzip", ["-q", cache, "-d", temporary]);
  const suffix = target.includes("windows") ? ".exe" : "";
  const executable = await readFile(
    path.join(temporary, stem, `rclone${suffix}`),
  );
  if (digest(executable) !== artifact.executableSha256)
    throw new Error("rclone executable checksum mismatch");
  const destination = path.join(
    root,
    "src-tauri",
    "binaries",
    `rclone-${target}${suffix}`,
  );
  await mkdir(path.dirname(destination), { recursive: true });
  const previous = await readFile(destination).catch(() => null);
  if (!previous || digest(previous) !== artifact.executableSha256)
    await writeFile(destination, executable);
  await chmod(destination, 0o755);
  console.log(
    `rclone ${RCLONE_VERSION} (${target}) verified; executable sha256 ${digest(executable)}`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
