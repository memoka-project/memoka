import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "linux") {
  console.log(
    "Direct synchronization network tracing requires Linux and strace; skipped.",
  );
  process.exit(0);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 600_000,
  });
  assert.equal(
    result.status,
    0,
    `${command} failed: ${result.error ?? result.stderr}\n${result.stdout}`,
  );
  return result.stdout;
}

const artifacts = run("cargo", [
  "test",
  "-p",
  "memoka-desktop",
  "--lib",
  "--no-run",
  "--message-format=json",
])
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const executable = artifacts.find(
  (artifact) =>
    artifact.reason === "compiler-artifact" &&
    artifact.target.name === "memoka_desktop" &&
    artifact.profile.test &&
    artifact.executable,
)?.executable;
assert.ok(executable, "Native test executable was not produced");

const directory = mkdtempSync(join(tmpdir(), "memoka-sync-network-"));
try {
  const trace = join(directory, "syscalls.txt");
  run("strace", [
    "-f",
    "-e",
    "trace=network,write,writev,close",
    "-o",
    trace,
    executable,
    "--exact",
    "replication::direct::tests::explicit_direct_endpoints_use_only_manual_udp_and_authenticate_public_keys",
    "--test-threads=1",
  ]);
  const routeSockets = new Set();
  let packets = 0;
  for (const line of readFileSync(trace, "utf8").split("\n")) {
    if (/^\d+\s+socket\(AF_INET/.test(line)) {
      assert.ok(
        line.includes("SOCK_DGRAM"),
        "Direct mode opened a non-UDP IP socket",
      );
    }
    const call = line.match(/^\d+\s+(\w+)\((\d+)/);
    if (!call) continue;
    const [, operation, fd] = call;
    if (operation === "close") {
      routeSockets.delete(fd);
      continue;
    }
    if (operation === "connect" && line.includes("sa_family=AF_INET")) {
      // netdev asks the local kernel which source address a UDP route would
      // select. UDP connect itself sends no packet. Any later write to that
      // socket is forbidden, including write/writev rather than sendto.
      assert.ok(
        (line.includes("sin_port=htons(1)") &&
          line.includes('inet_addr("10.254.254.254")')) ||
          (line.includes("sin6_port=htons(1)") &&
            line.includes('"fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"')),
        "Unexpected IP connection outside the manually configured peer",
      );
      routeSockets.add(fd);
    }
    if (
      ["sendto", "sendmsg", "sendmmsg", "write", "writev"].includes(operation)
    ) {
      assert.ok(
        !routeSockets.has(fd),
        "Route inspection unexpectedly sent data",
      );
      if (line.includes("sa_family=AF_INET")) {
        assert.ok(
          line.includes('sin_addr=inet_addr("127.0.0.1")') ||
            line.includes('inet_pton(AF_INET6, "::1"'),
          "Packet sent outside the loopback peer",
        );
        packets += 1;
      }
    }
  }
  assert.ok(packets > 0, "No actual direct packets were observed");
  console.log(
    `Direct synchronization: ${packets} UDP sends stayed on the configured loopback connection; no discovery, relay or port-mapping traffic.`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
