// Offline feasibility gate: real pinned executables, no Google/user config.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  copyFile,
  chmod,
  readFile,
  mkdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const windows = process.platform === "win32";
const target = windows
  ? "x86_64-pc-windows-msvc.exe"
  : "x86_64-unknown-linux-gnu";
const scratch = await mkdtemp(join(tmpdir(), "memoka rclone 日本語-"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(RESTIC_|RCLONE_|_RCLONE_|LD_PRELOAD|DYLD_)/i.test(key),
  ),
);
const key = randomBytes(32).toString("hex");
const token = randomBytes(32).toString("hex");
function run(binary, args, extra = {}, input, inspect) {
  const result = spawnSync(binary, args, {
    env: { ...env, ...extra },
    input,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
  // Never include argv/env/stdout/stderr in thrown errors (may contain secrets).
  assert.equal(
    result.status,
    0,
    `sidecar exit ${result.status}; ${result.error?.code ?? "no spawn error"}`,
  );
  inspect?.(result);
  return result.stdout;
}
try {
  const rclone = join(scratch, windows ? "rclone 日本語.exe" : "rclone 日本語");
  await copyFile(resolve(`src-tauri/binaries/rclone-${target}`), rclone);
  await chmod(rclone, 0o755);
  const restic = resolve(`src-tauri/binaries/restic-${target}`);
  const config = join(scratch, "rclone.conf");
  run(
    rclone,
    ["--config", config, "config", "encryption", "set"],
    {},
    `${key}\n${key}\n`,
  );
  assert.match(await readFile(config, "utf8"), /RCLONE_ENCRYPT_V0:/);
  const childEnv = {
    RCLONE_CONFIG_PASS: key,
    RCLONE_CONFIG: config,
    RCLONE_ASK_PASSWORD: "false",
  };
  // Fixed JSON state machine; never parse terminal prompts. Secrets travel in
  // the child-only RCLONE_RESULT, not argv, files, or an HTTP RC server.
  let question = JSON.parse(
    run(
      rclone,
      [
        "config",
        "create",
        "memoka_drive",
        "drive",
        "client_id",
        "offline-test.apps.googleusercontent.com",
        "scope",
        "drive.file",
        "--non-interactive",
      ],
      childEnv,
    ),
  );
  for (let step = 0; question.State && step < 8; step++) {
    const answers = {
      config_is_local: "false",
      config_change_team_drive: "false",
      config_token: Buffer.from(
        JSON.stringify({
          token: JSON.stringify({
            access_token: token,
            refresh_token: token,
            token_type: "Bearer",
            expiry: "2099-01-01T00:00:00Z",
          }),
          client_secret: "offline-client",
        }),
      )
        .toString("base64")
        .replace(/=+$/, ""),
    };
    assert.ok(
      Object.hasOwn(answers, question.Option?.Name),
      `Unknown config question ${question.Option?.Name}`,
    );
    question = JSON.parse(
      run(
        rclone,
        [
          "config",
          "update",
          "memoka_drive",
          "--non-interactive",
          "--continue",
          "--state",
          question.State,
        ],
        { ...childEnv, RCLONE_RESULT: answers[question.Option.Name] },
      ),
    );
  }
  assert.equal(question.State, "");
  assert.equal((await readFile(config, "utf8")).includes(token), false);
  const data = JSON.parse(run(rclone, ["config", "dump"], childEnv));
  assert.equal(JSON.parse(data.memoka_drive.token).access_token, token);
  // The test transport only is local; production accepts GoogleDrive only.
  run(
    rclone,
    ["config", "create", "memoka_local_test", "local", "--non-interactive"],
    childEnv,
  );
  const remote = `rclone:memoka_local_test:${join(scratch, "repository")}`;
  // Restic parses this option again with shellquote; always quote its path.
  const program = `'${rclone.replaceAll("'", "'\\''")}'`;
  const cache = join(scratch, "transfer-cache");
  await mkdir(cache, { mode: 0o700 });
  const args = [
    "--repo",
    remote,
    "--cache-dir",
    cache,
    "-o",
    `rclone.program=${program}`,
    "-o",
    "rclone.args=serve restic --stdio",
  ];
  const repositoryEnv = {
    ...childEnv,
    RESTIC_PASSWORD: randomBytes(32).toString("hex"),
  };
  const sourceRepo = join(scratch, "local-history");
  const sourceArgs = [
    "--repo",
    sourceRepo,
    "--insecure-no-password",
    "--no-cache",
  ];
  run(restic, [...sourceArgs, "init"]);
  run(
    restic,
    [
      ...args,
      "init",
      "--from-repo",
      sourceRepo,
      "--from-insecure-no-password",
      "--copy-chunker-params",
    ],
    repositoryEnv,
  );
  const sourceConfig = JSON.parse(
    run(restic, [...sourceArgs, "cat", "config"]),
  );
  const destinationConfig = JSON.parse(
    run(restic, [...args, "cat", "config"], repositoryEnv),
  );
  assert.notEqual(sourceConfig.id, destinationConfig.id);
  assert.equal(
    sourceConfig.chunker_polynomial,
    destinationConfig.chunker_polynomial,
  );
  const source = join(scratch, "source");
  await mkdir(source);
  await writeFile(join(source, "text.txt"), "日本語 round trip\n");
  run(restic, [
    ...sourceArgs,
    "backup",
    source,
    "--tag",
    "memoka-generation:offline-roundtrip",
  ]);
  const copyArgs = [
    ...args,
    "copy",
    "--from-repo",
    sourceRepo,
    "--from-insecure-no-password",
  ];
  run(restic, copyArgs, repositoryEnv);
  // Retry after a lost success response adopts the same generation.
  run(restic, copyArgs, repositoryEnv);
  const snapshots = JSON.parse(
    run(restic, [...args, "snapshots", "--json"], repositoryEnv),
  );
  assert.equal(snapshots.length, 1);
  assert.ok(snapshots[0].tags.includes("memoka-generation:offline-roundtrip"));
  run(restic, [...args, "check", "--read-data"], repositoryEnv);
  const files = JSON.parse(
    run(restic, [...args, "ls", "latest", "--json"], repositoryEnv)
      .trim()
      .split("\n")
      .at(-1),
  );
  assert.equal(
    run(restic, [...args, "dump", "latest", files.path], repositoryEnv),
    "日本語 round trip\n",
  );
  const restored = join(scratch, "restored");
  run(
    restic,
    [...args, "restore", "latest", "--target", restored],
    repositoryEnv,
  );
  assert.equal(
    await readFile(
      join(restored, files.path.replace(/^[A-Za-z]:/u, "")),
      "utf8",
    ),
    "日本語 round trip\n",
  );
  // Exercise the exact numeric telemetry protocol using real stdio children.
  // This is local transport, not a substitute for a Google Drive test.
  await writeFile(join(source, "progress.bin"), randomBytes(96 * 1024));
  run(restic, [...sourceArgs, "backup", source]);
  run(
    restic,
    [...copyArgs, "--limit-upload", "32"],
    {
      ...repositoryEnv,
      RCLONE_USE_JSON_LOG: "true",
      RCLONE_STATS: "1s",
      RCLONE_STATS_LOG_LEVEL: "ERROR",
      RCLONE_LOG_LEVEL: "ERROR",
    },
    undefined,
    (result) => {
      const measurements = result.stderr.split("\n").flatMap((line) => {
        try {
          const stats = JSON.parse(line.replace(/^rclone: /u, "")).stats;
          return stats && typeof stats.bytes === "number" ? [stats.bytes] : [];
        } catch {
          return [];
        }
      });
      assert.ok(
        measurements.some((bytes) => bytes > 0),
        "Real rclone JSON file-transfer stats must reach Restic stderr",
      );
    },
  );
  run(restic, [...args, "--no-cache", "check", "--read-data"], repositoryEnv);
  console.log(
    "PASS: private job cache / real numeric stdio transfer telemetry / uncached full check",
  );
  if (process.env.MEMOKA_TEST_LONG_CLOUD_COPY === "1") {
    await writeFile(join(source, "large.bin"), randomBytes(512 * 1024));
    run(restic, [
      ...sourceArgs,
      "backup",
      source,
      "--tag",
      "memoka-generation:long-copy",
    ]);
    const began = Date.now();
    run(restic, [...copyArgs, "--limit-upload", "8"], repositoryEnv);
    assert.ok(
      Date.now() - began > 30000,
      "The explicit long transfer must exceed the old 30-second deadline",
    );
    run(restic, [...args, "check", "--read-data"], repositoryEnv);
    console.log(
      "PASS: actual rate-limited stdio copy >30 seconds and full data check",
    );
  }
  console.log(
    "PASS: encrypted config / secret-free argv / real stdio init-copy-retry-list-check-restore / independent keys / spaces and Japanese executable path",
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
