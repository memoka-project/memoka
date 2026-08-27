import { useEffect, useState, type RefObject } from "react";
import {
  InputLatencyMonitor,
  type InputLatencySnapshot,
} from "../core/development-diagnostics";
import type {
  PortableMirrorActivitySnapshot,
  PortableMirrorController,
} from "../core/portable-mirror";
import type {
  CoreRuntime,
  RuntimeBackgroundTaskSnapshot,
} from "../core/runtime";

const DEBUG_REFRESH_MS = 250;

interface DevelopmentDebugSnapshot {
  readonly runtime: RuntimeBackgroundTaskSnapshot;
  readonly mirror: PortableMirrorActivitySnapshot;
  readonly input: InputLatencySnapshot;
}

export function DevelopmentDebugTasks({
  runtime,
  mirrorController,
  applicationRoot,
}: {
  runtime: CoreRuntime;
  mirrorController: RefObject<PortableMirrorController | null>;
  applicationRoot: RefObject<HTMLElement | null>;
}) {
  const [diagnostics, setDiagnostics] = useState<DevelopmentDebugSnapshot>(() =>
    initialSnapshot(runtime),
  );

  useEffect(() => {
    const latency = applicationRoot.current
      ? new InputLatencyMonitor(applicationRoot.current)
      : null;
    const refresh = (): void => {
      const next: DevelopmentDebugSnapshot = {
        runtime: runtime.backgroundTaskSnapshot(),
        mirror:
          mirrorController.current?.activitySnapshot() ?? offMirrorSnapshot(),
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
  }, [applicationRoot, mirrorController, runtime]);

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
        data-background-task="mirror"
        data-background-task-phase={diagnostics.mirror.phase}
      >
        mirror {formatMirrorTask(diagnostics.mirror)}
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
    mirror: offMirrorSnapshot(),
    input: emptyInputSnapshot(),
  };
}

function offMirrorSnapshot(): PortableMirrorActivitySnapshot {
  return {
    phase: "off",
    dirty: false,
    lastResult: null,
    lastDurationMs: null,
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

function formatMirrorTask(mirror: PortableMirrorActivitySnapshot): string {
  const last =
    (mirror.phase === "idle" || mirror.phase === "waiting") &&
    mirror.lastDurationMs !== null
      ? ` (${mirror.lastResult ?? "done"} ${formatMilliseconds(mirror.lastDurationMs)})`
      : "";
  return `${mirror.phase}${last}`;
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
