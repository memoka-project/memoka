import { useEffect, useState, type RefObject } from "react";
import {
  InputLatencyMonitor,
  type InputLatencySnapshot,
} from "../core/development-diagnostics";
import {
  backupCopyingDestinations,
  backupErrorCount,
  type BackupPort,
  type BackupState,
} from "../core/history";
import type {
  CoreRuntime,
  RuntimeBackgroundTaskSnapshot,
} from "../core/runtime";

const DEBUG_REFRESH_MS = 250;

interface DevelopmentDebugSnapshot {
  readonly runtime: RuntimeBackgroundTaskSnapshot;
  readonly input: InputLatencySnapshot;
}

export function DevelopmentDebugTasks({
  runtime,
  backup,
  applicationRoot,
}: {
  runtime: CoreRuntime;
  backup: BackupPort | null;
  applicationRoot: RefObject<HTMLElement | null>;
}) {
  const [diagnostics, setDiagnostics] = useState<DevelopmentDebugSnapshot>(() =>
    initialSnapshot(runtime),
  );
  const [backupState, setBackupState] = useState<BackupState | null>(null);
  useEffect(() => {
    if (!backup) return;
    let active = true;
    const refresh = (): void => {
      void backup
        .status()
        .then((state) => {
          if (active) setBackupState(state);
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [backup]);

  useEffect(() => {
    const latency = applicationRoot.current
      ? new InputLatencyMonitor(applicationRoot.current)
      : null;
    const refresh = (): void => {
      const next: DevelopmentDebugSnapshot = {
        runtime: runtime.backgroundTaskSnapshot(),
        input: latency?.snapshot() ?? emptyInputSnapshot(),
      };
      setDiagnostics((current) =>
        sameDebugSnapshot(current, next) ? current : next,
      );
    };
    refresh();
    const timer = globalThis.setInterval(refresh, DEBUG_REFRESH_MS);
    return () => {
      globalThis.clearInterval(timer);
      latency?.destroy();
    };
  }, [applicationRoot, runtime]);

  const search = diagnostics.runtime.searchIndex;
  const input = diagnostics.input;
  return (
    <>
      <span
        data-background-task="fts"
        data-background-task-phase={search.phase}
        title={search.detail ?? undefined}
      >
        fts {formatSearchTask(search)}
      </span>
      <span
        data-background-task="backup"
        data-background-task-phase={backupState?.status.phase ?? "off"}
      >
        backup {backupState?.status.phase || "off"} / copy{" "}
        {backupState ? backupCopyingDestinations(backupState).length : 0} active
        /{" "}
        {backupState?.config.destinations.filter((target) => target.enabled)
          .length ?? 0}{" "}
        enabled / {backupState ? backupErrorCount(backupState) : 0} errors (
        {backupState?.config.destinations
          .filter((target) => target.enabled)
          .reduce(
            (sum, target) =>
              sum +
              (backupState.status.destinations[target.id]?.pending_copy_count ??
                0),
            0,
          ) ?? 0}{" "}
        pending /{" "}
        {backupState?.config.destinations
          .filter((target) => target.enabled)
          .reduce(
            (sum, target) =>
              sum +
              (backupState.status.destinations[target.id]
                ?.pending_verification_count ?? 0),
            0,
          ) ?? 0}{" "}
        unverified)
      </span>
      <span
        data-input-latency-last-ms={formatDataNumber(input.lastMs)}
        data-input-latency-p95-ms={formatDataNumber(input.p95Ms)}
        data-input-latency-max-ms={formatDataNumber(input.maxMs)}
        title="keydownから対応するinput/DOM変更後の次描画frameまで（直近120件）"
      >
        input {formatInputLatency(input)}
      </span>
    </>
  );
}

function initialSnapshot(runtime: CoreRuntime): DevelopmentDebugSnapshot {
  return {
    runtime: runtime.backgroundTaskSnapshot(),
    input: emptyInputSnapshot(),
  };
}

function emptyInputSnapshot(): InputLatencySnapshot {
  return {
    lastKey: null,
    lastMs: null,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
    sampleCount: 0,
    slowSampleCount: 0,
  };
}

function formatSearchTask(
  search: RuntimeBackgroundTaskSnapshot["searchIndex"],
): string {
  const phase =
    search.phase === "unavailable"
      ? "off"
      : search.phase === "waiting"
        ? "wait"
        : search.phase === "queued"
          ? "queue"
          : search.phase === "running"
            ? "run"
            : search.phase;
  const detail = search.detail ? `:${shortDetail(search.detail)}` : "";
  const last =
    search.phase === "idle" && search.lastDurationMs !== null
      ? ` (${search.lastTask ?? "task"} ${formatMilliseconds(search.lastDurationMs)})`
      : "";
  return `${phase}${detail}${last}`;
}

function formatInputLatency(input: InputLatencySnapshot): string {
  if (input.lastMs === null) return "-";
  const slow =
    input.slowSampleCount > 0 ? ` slow:${input.slowSampleCount}` : "";
  return `${input.lastKey ?? "?"} ${formatMilliseconds(input.lastMs)} p95:${formatMilliseconds(input.p95Ms)} max:${formatMilliseconds(input.maxMs)} n:${input.sampleCount}${slow}`;
}

function formatMilliseconds(value: number | null): string {
  return value === null ? "-" : `${Math.round(value)}ms`;
}

function formatDataNumber(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

function shortDetail(value: string): string {
  return value.length > 48 ? `${value.slice(0, 47)}…` : value;
}

function sameDebugSnapshot(
  left: DevelopmentDebugSnapshot,
  right: DevelopmentDebugSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
