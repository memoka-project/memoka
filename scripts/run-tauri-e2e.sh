#!/usr/bin/env bash
set -euo pipefail

workspace_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
evidence_dir="${MEMOKA_EVIDENCE_DIR:-${workspace_dir}/evidence/generated}"
application="${workspace_dir}/target/release/memoka"
runtime_dir="$(mktemp -d)"
driver_pid=""

cleanup() {
  cleanup_status=$?
  trap - EXIT
  if [[ -n "${driver_pid}" ]]; then
    kill "${driver_pid}" 2>/dev/null || true
    wait "${driver_pid}" 2>/dev/null || true
  fi
  if [[ -d "${runtime_dir}" ]]; then
    # WebKit's Mesa cache worker can finish a final write just after the
    # WebDriver session closes. Retry this private mktemp directory cleanup so
    # a harmless cache race does not turn a passing GUI assertion into exit 1.
    for _ in $(seq 1 20); do
      rm -rf "${runtime_dir}" 2>/dev/null || true
      [[ ! -e "${runtime_dir}" ]] && break
      sleep 0.05
    done
  fi
  exit "${cleanup_status}"
}
trap cleanup EXIT

if ! command -v tauri-driver >/dev/null 2>&1; then
  printf '%s\n' "tauri-driver is required" >&2
  exit 2
fi
if [[ ! -x "${application}" ]]; then
  printf '%s\n' "Memoka release application is required: ${application}" >&2
  exit 2
fi

mkdir -p "${evidence_dir}"
workspace_data="${runtime_dir}/workspace"
application_config="${runtime_dir}/config/dev.memoka.desktop"
mkdir -p "${workspace_data}/.memoka" "${application_config}"
printf '%s\n' '{"schemaVersion":1,"kind":"memoka-data-area"}' \
  >"${workspace_data}/.memoka/data-area.json"
printf '{"schemaVersion":1,"path":"%s"}\n' "${workspace_data}" \
  >"${application_config}/selected-workspace.json"
cd "${workspace_dir}"
XDG_DATA_HOME="${runtime_dir}/data" \
XDG_CONFIG_HOME="${runtime_dir}/config" \
XDG_CACHE_HOME="${runtime_dir}/cache" \
tauri-driver --port 4447 \
  >"${evidence_dir}/tauri-driver.log" 2>&1 &
driver_pid=$!

for _ in $(seq 1 100); do
  if curl --fail --silent http://127.0.0.1:4447/status >/dev/null; then
    break
  fi
  sleep 0.1
done

MEMOKA_TAURI_APP="${application}" \
MEMOKA_WEBDRIVER="http://127.0.0.1:4447" \
MEMOKA_EVIDENCE_DIR="${evidence_dir}" \
MEMOKA_E2E_DATA_HOME="${runtime_dir}/data" \
MEMOKA_E2E_WORKSPACE="${workspace_data}" \
node scripts/tauri-e2e.mjs
