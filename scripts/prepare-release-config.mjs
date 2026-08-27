import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const root = new URL("../", import.meta.url);
const source = new URL("src-tauri/tauri.conf.json", root);
const output = new URL("src-tauri/tauri.release.generated.json", root);
const platform =
  process.argv
    .find((argument) => argument.startsWith("--platform="))
    ?.slice("--platform=".length) ??
  (process.platform === "win32" ? "windows" : "linux");
if (platform !== "linux" && platform !== "windows") {
  throw new Error(`unsupported release platform: ${platform}`);
}
const publicKey = process.env.MEMOKA_UPDATER_PUBLIC_KEY?.trim();
if (!publicKey) {
  throw new Error("MEMOKA_UPDATER_PUBLIC_KEY is required for a release build");
}

const config = JSON.parse(await readFile(source, "utf8"));
config.app.security.csp =
  "default-src 'self' ipc: http://ipc.localhost; connect-src 'self' ipc: http://ipc.localhost; img-src 'self' data: blob: memoka-attachment: http://memoka-attachment.localhost; style-src 'self' 'unsafe-inline'; script-src 'self'";
config.bundle.createUpdaterArtifacts = true;
config.bundle.targets = platform === "windows" ? ["nsis"] : ["deb", "appimage"];
config.plugins ??= {};
config.plugins.updater = {
  endpoints: [
    "https://github.com/memoka-project/memoka/releases/latest/download/latest.json",
  ],
  pubkey: publicKey,
  windows: {
    installMode: "passive",
  },
};

if (platform === "windows") {
  const endpoint = requiredEnvironment("AZURE_ARTIFACT_SIGNING_ENDPOINT");
  const account = requiredEnvironment("AZURE_ARTIFACT_SIGNING_ACCOUNT");
  const profile = requiredEnvironment("AZURE_ARTIFACT_SIGNING_PROFILE");
  config.bundle.windows = {
    signCommand: `artifact-signing-cli -e ${shellArgument(endpoint)} -a ${shellArgument(account)} -c ${shellArgument(profile)} -d Memoka %1`,
    nsis: {
      installMode: "currentUser",
      displayLanguageSelector: false,
    },
  };
}

await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});
process.stdout.write(`${output.pathname}\n`);

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required for a Windows release build`);
  return value;
}

function shellArgument(value) {
  if (!/^[A-Za-z0-9._:/-]+$/u.test(value)) {
    throw new Error(
      "Azure signing configuration contains unsupported characters",
    );
  }
  return value;
}
