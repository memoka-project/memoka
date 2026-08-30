import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const root = new URL("../", import.meta.url);
const source = new URL("src-tauri/tauri.conf.json", root);
const output = new URL("src-tauri/tauri.release.generated.json", root);
const platform =
  process.argv
    .find((argument) => argument.startsWith("--platform="))
    ?.slice("--platform=".length) ?? process.platform;
if (platform !== "linux") {
  throw new Error(
    `public release bundles are Linux-only; unsupported platform: ${platform}`,
  );
}
const publicKey = process.env.MEMOKA_UPDATER_PUBLIC_KEY?.trim();
if (!publicKey) {
  throw new Error("MEMOKA_UPDATER_PUBLIC_KEY is required for a release build");
}

const config = JSON.parse(await readFile(source, "utf8"));
config.app.security.csp =
  "default-src 'self' ipc: http://ipc.localhost; connect-src 'self' ipc: http://ipc.localhost; img-src 'self' data: blob: memoka-attachment: http://memoka-attachment.localhost; style-src 'self' 'unsafe-inline'; script-src 'self'";
config.bundle.createUpdaterArtifacts = true;
config.bundle.targets = ["appimage"];
config.plugins ??= {};
config.plugins.updater = {
  endpoints: [
    "https://github.com/memoka-project/memoka/releases/latest/download/latest.json",
  ],
  pubkey: publicKey,
};

await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});
process.stdout.write(`${output.pathname}\n`);
