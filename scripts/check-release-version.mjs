import { readFile } from "node:fs/promises";
import process from "node:process";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const tauriConfig = JSON.parse(
  await readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"),
);
const cargoToml = await readFile(new URL("src-tauri/Cargo.toml", root), "utf8");
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"\s*$/mu)?.[1];
const versions = new Map([
  ["package.json", packageJson.version],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
  ["src-tauri/Cargo.toml", cargoVersion],
]);
const unique = new Set(versions.values());
if (unique.size !== 1 || unique.has(undefined)) {
  throw new Error(
    `release versions differ: ${[...versions].map(([file, version]) => `${file}=${version ?? "missing"}`).join(", ")}`,
  );
}
const version = [...unique][0];
if (!/^\d+\.\d+\.\d+$/u.test(version)) {
  throw new Error(
    `public releases require a stable SemVer version: ${version}`,
  );
}
const requested = process.argv
  .find((argument) => argument.startsWith("--version="))
  ?.slice("--version=".length);
const tag =
  process.env.GITHUB_REF_TYPE === "tag"
    ? process.env.GITHUB_REF_NAME?.replace(/^v/u, "")
    : undefined;
for (const [source, candidate] of [
  ["--version", requested],
  ["GITHUB_REF_NAME", tag],
]) {
  if (candidate && candidate !== version) {
    throw new Error(
      `${source}=${candidate} does not match product version ${version}`,
    );
  }
}
process.stdout.write(`${version}\n`);
