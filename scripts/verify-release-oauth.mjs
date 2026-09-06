import { readFile } from "node:fs/promises";
import { assertEmbeddedGoogleDesktopClient } from "./google-oauth-client.mjs";

const binaries = process.argv.slice(2);
if (!binaries.length)
  throw new Error("Provide the GUI and/or CLI binary paths");
for (const binary of binaries) {
  assertEmbeddedGoogleDesktopClient(
    await readFile(binary),
    process.env.MEMOKA_GOOGLE_DESKTOP_CLIENT_JSON,
  );
}
process.stdout.write(
  "Release binaries contain the validated Desktop OAuth client.\n",
);
