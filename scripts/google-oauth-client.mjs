// Desktop OAuth client configuration is distributable application identity,
// not a user's credentials. Never include supplied values in diagnostics.
export function validateGoogleDesktopClient(source) {
  const invalid = () =>
    new Error(
      "A Google Desktop OAuth client JSON containing only application configuration is required",
    );
  if (typeof source !== "string" || Buffer.byteLength(source) > 65536)
    throw invalid();
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw invalid();
  }
  if (
    !value ||
    Object.keys(value).length !== 1 ||
    !value.installed ||
    typeof value.installed !== "object" ||
    Array.isArray(value.installed)
  )
    throw invalid();
  const allowed = new Set([
    "client_id",
    "client_secret",
    "project_id",
    "auth_uri",
    "token_uri",
    "auth_provider_x509_cert_url",
    "redirect_uris",
  ]);
  const profile = value.installed;
  if (
    Object.keys(profile).some((key) => !allowed.has(key)) ||
    typeof profile.client_id !== "string" ||
    profile.client_id.length >= 256 ||
    !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/u.test(
      profile.client_id,
    ) ||
    typeof profile.client_secret !== "string" ||
    !profile.client_secret.trim() ||
    profile.client_secret.length >= 1024
  )
    throw invalid();
  for (const [key, accepted] of [
    [
      "auth_uri",
      [
        "https://accounts.google.com/o/oauth2/auth",
        "https://accounts.google.com/o/oauth2/v2/auth",
      ],
    ],
    [
      "token_uri",
      [
        "https://oauth2.googleapis.com/token",
        "https://accounts.google.com/o/oauth2/token",
      ],
    ],
    [
      "auth_provider_x509_cert_url",
      ["https://www.googleapis.com/oauth2/v1/certs"],
    ],
  ]) {
    if (key in profile && !accepted.includes(profile[key])) throw invalid();
  }
  if ("project_id" in profile && typeof profile.project_id !== "string")
    throw invalid();
  if (
    "redirect_uris" in profile &&
    (!Array.isArray(profile.redirect_uris) ||
      profile.redirect_uris.some(
        (uri) =>
          typeof uri !== "string" ||
          !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/u.test(
            uri,
          ),
      ))
  )
    throw invalid();
}

export function assertEmbeddedGoogleDesktopClient(binary, source) {
  validateGoogleDesktopClient(source);
  if (!binary.includes(Buffer.from(source.trim())))
    throw new Error(
      "The release binary does not contain the configured Desktop OAuth client",
    );
}
