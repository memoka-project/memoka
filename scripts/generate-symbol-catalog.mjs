// Run explicitly when upgrading the pinned Unicode/Lucide catalogs.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { format } from "prettier";

const directory = new URL("../node_modules/lucide/dist/esm/", import.meta.url);
const exports = await readFile(new URL("lucide.mjs", directory), "utf8");
const names = (await readdir(new URL("icons/", directory)))
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => name.slice(0, -4))
  .sort();
const icons = {};
const aliases = {};
for (const name of names) {
  const module = await import(new URL(`icons/${name}.mjs`, directory));
  const declaration = exports
    .split("\n")
    .find((line) => line.endsWith(`'./icons/${name}.mjs';`));
  const exportNames = [
    ...(declaration ?? "").matchAll(/default as (\w+)/g),
  ].map((match) => match[1]);
  icons[name] = { aliases: exportNames, node: module.default };
  for (const alias of exportNames) {
    const kebab = alias
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
      .toLowerCase();
    if (kebab !== name) aliases[kebab] = name;
  }
}
const response = await fetch(
  "https://www.unicode.org/Public/17.0.0/emoji/emoji-test.txt",
);
if (!response.ok) throw new Error(`Unicode download: ${response.status}`);
const source = await response.text();
if (!source.includes("# Version: 17.0"))
  throw new Error("Unexpected Unicode version");
const emoji = [
  ...source.matchAll(
    /^([A-F0-9 ]+)\s*; (?:fully-qualified|component)\s*# \S+ E[\d.]+ (.+)$/gm,
  ),
].map((match) => [
  String.fromCodePoint(
    ...match[1]
      .trim()
      .split(/\s+/)
      .map((value) => parseInt(value, 16)),
  ),
  match[2],
]);
if (emoji.length < 3900 || names.length < 1500)
  throw new Error("Incomplete catalog");
for (const [path, data] of [
  ["app/src/core/data/symbol-icons.json", icons],
  ["app/src/core/data/symbol-names.json", names],
  ["app/src/core/data/symbol-aliases.json", aliases],
  ["app/src/core/data/symbol-emoji.json", emoji],
]) {
  const content = await format(JSON.stringify(data), { parser: "json" });
  await writeFile(new URL(`../${path}`, import.meta.url), content, "utf8");
}
console.log(`${emoji.length} emoji, ${names.length} Lucide icons`);
