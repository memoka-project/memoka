import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import process from "node:process";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const platform = process.platform === "win32" ? "windows" : "linux";
const executable = `memoka-cli${platform === "windows" ? ".exe" : ""}`;
const directoryName = `memoka-cli-v${packageJson.version}-${platform}-x64`;
const outputRoot = new URL("dist-release/", root);
const directory = join(outputRoot.pathname, directoryName);
await mkdir(directory, { recursive: true });
for (const source of [
  new URL(`target/release/${executable}`, root),
  new URL("LICENSE", root),
  new URL("README.md", root),
  new URL("PRIVACY.md", root),
  new URL("THIRD_PARTY_NOTICES.md", root),
]) {
  await copyFile(source, join(directory, basename(source.pathname)));
}
await writeFile(join(directory, "VERSION"), `${packageJson.version}\n`, "utf8");
process.stdout.write(`${directory}\n`);
