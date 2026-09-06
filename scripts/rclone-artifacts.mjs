// Official v1.75.1 archives verified against downloads.rclone.org/v1.75.1/SHA256SUMS.
// Executable hashes are pinned as well; runtime never searches PATH/downloads.
export const RCLONE_VERSION = "1.75.1";
export const RCLONE_ARTIFACTS = {
  "x86_64-unknown-linux-gnu": {
    platform: "linux-amd64",
    sha256: "982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab",
    executableSha256:
      "f66d8c1d552ad90296a11bc8b46d56a7fa5da1a7fa05e7ca522d95df92c4a4c0",
  },
  "x86_64-pc-windows-msvc": {
    platform: "windows-amd64",
    sha256: "200eb602c126d82aa38b51e0f6b9ae837473ff99b51278d3f6f837574c494d6e",
    executableSha256:
      "033eee51c9ad47c2de2624b6674d355274bcd6cf0027a5f85db4437ba24ae81c",
  },
};
