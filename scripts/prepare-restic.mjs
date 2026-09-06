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
import { RESTIC_VERSION, RESTIC_ARTIFACTS } from "./restic-artifacts.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const target =
  process.argv[2] ??
  execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(
    /^host: (.+)$/m,
  )?.[1];
const artifact = RESTIC_ARTIFACTS[target];
if (!artifact) throw new Error(`No verified Restic artifact for ${target}`);
const filename = `restic_${RESTIC_VERSION}_${artifact.suffix}`;
const cache = path.join(root, ".tools", "restic", filename);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let archive = await readFile(cache).catch(() => null);
if (!archive || digest(archive) !== artifact.sha256) {
  const response = await fetch(
    `https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/${filename}`,
  );
  if (!response.ok)
    throw new Error(`Restic download failed: HTTP ${response.status}`);
  archive = Buffer.from(await response.arrayBuffer());
  if (digest(archive) !== artifact.sha256)
    throw new Error("Restic archive checksum mismatch");
  await mkdir(path.dirname(cache), { recursive: true });
  await writeFile(cache, archive);
}
const destination = path.join(
  root,
  "src-tauri",
  "binaries",
  `restic-${target}${target.includes("windows") ? ".exe" : ""}`,
);
await mkdir(path.dirname(destination), { recursive: true });
let executable;
if (target.includes("linux")) {
  executable = execFileSync("bzip2", ["-dc", cache], {
    maxBuffer: 96 * 1024 * 1024,
  });
} else {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "memoka-restic-"));
  try {
    if (process.platform === "win32") {
      // Constant PowerShell code; paths are process-local env data, not code.
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Expand-Archive -LiteralPath $env:MEMOKA_RESTIC_ARCHIVE -DestinationPath $env:MEMOKA_RESTIC_TEMP",
        ],
        {
          env: {
            ...process.env,
            MEMOKA_RESTIC_ARCHIVE: cache,
            MEMOKA_RESTIC_TEMP: temporary,
          },
        },
      );
    } else execFileSync("unzip", ["-q", cache, "-d", temporary]);
    executable = await readFile(
      path.join(temporary, `restic_${RESTIC_VERSION}_windows_amd64.exe`),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
const previous = await readFile(destination).catch(() => null);
if (
  artifact.executableSha256 &&
  digest(executable) !== artifact.executableSha256
)
  throw new Error("Restic executable checksum mismatch");
if (!previous || digest(previous) !== digest(executable))
  await writeFile(destination, executable);
await chmod(destination, 0o755);
console.log(
  `Restic ${RESTIC_VERSION} (${target}) verified; executable sha256 ${digest(executable)}`,
);
