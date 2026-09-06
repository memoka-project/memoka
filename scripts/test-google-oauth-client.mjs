import assert from "node:assert/strict";
import {
  validateGoogleDesktopClient,
  assertEmbeddedGoogleDesktopClient,
} from "./google-oauth-client.mjs";

const installed = {
  client_id: "offline-release.apps.googleusercontent.com",
  client_secret: "distribution-client-not-a-user-token",
  project_id: "offline",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  redirect_uris: ["http://localhost"],
};
const valid = JSON.stringify({ installed });
validateGoogleDesktopClient(valid);
assertEmbeddedGoogleDesktopClient(
  Buffer.from(`binary-prefix${valid}binary-suffix`),
  valid,
);
assert.throws(() =>
  assertEmbeddedGoogleDesktopClient(Buffer.from("no-profile"), valid),
);
for (const value of [
  undefined,
  "",
  "broken-json-with-private-content",
  "null",
  "[]",
  "{}",
  JSON.stringify({ web: installed }),
  JSON.stringify({ installed, access_token: "private-access-token" }),
  JSON.stringify({
    installed: { ...installed, refresh_token: "private-refresh-token" },
  }),
  JSON.stringify({ installed: { ...installed, private_key: "private-key" } }),
  JSON.stringify({ installed: { ...installed, client_secret: "" } }),
  JSON.stringify({
    installed: { ...installed, client_id: "not-a-google-client" },
  }),
  JSON.stringify({
    installed: { ...installed, token_uri: "https://untrusted.invalid/token" },
  }),
  JSON.stringify({
    installed: { ...installed, redirect_uris: ["https://untrusted.invalid/"] },
  }),
  `${valid}${" ".repeat(65536)}`,
]) {
  assert.throws(
    () => validateGoogleDesktopClient(value),
    (error) => {
      assert.doesNotMatch(
        error.message,
        /private-|untrusted|distribution-client/u,
      );
      return true;
    },
  );
}
process.stdout.write(
  "Release OAuth configuration and embedding contracts passed.\n",
);
