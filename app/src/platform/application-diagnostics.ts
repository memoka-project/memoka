import { invoke } from "@tauri-apps/api/core";
import { getBundleType } from "@tauri-apps/api/app";

export type DiagnosticEvent =
  | "application-ready"
  | "workspace-open-failed"
  | "update-check-started"
  | "update-available"
  | "update-not-available"
  | "update-check-failed"
  | "update-install-started"
  | "update-install-failed";

export interface ApplicationDiagnosticsInfo {
  readonly applicationVersion: string;
  readonly tauriVersion: string;
  readonly operatingSystem: string;
  readonly architecture: string;
  readonly bundleType: string;
  readonly logDirectory: string;
  readonly updaterConfigured: boolean;
}

export interface ApplicationDiagnosticsPort {
  info(): Promise<ApplicationDiagnosticsInfo>;
  record(event: DiagnosticEvent): Promise<void>;
}

export class MemoryApplicationDiagnosticsPort implements ApplicationDiagnosticsPort {
  readonly events: DiagnosticEvent[] = [];

  constructor(
    private readonly current: ApplicationDiagnosticsInfo = {
      applicationVersion: "0.1.0-test",
      tauriVersion: "browser",
      operatingSystem: "test",
      architecture: "test",
      bundleType: "none",
      logDirectory: "memory://logs",
      updaterConfigured: true,
    },
  ) {}

  async info(): Promise<ApplicationDiagnosticsInfo> {
    return { ...this.current };
  }

  async record(event: DiagnosticEvent): Promise<void> {
    this.events.push(event);
  }
}

class TauriApplicationDiagnosticsPort implements ApplicationDiagnosticsPort {
  async info(): Promise<ApplicationDiagnosticsInfo> {
    const [info, bundleType] = await Promise.all([
      invoke<ApplicationDiagnosticsInfo>("application_diagnostics_info"),
      getBundleType().catch(() => null),
    ]);
    return bundleType === null ? info : { ...info, bundleType };
  }

  record(event: DiagnosticEvent): Promise<void> {
    return invoke("application_diagnostics_record", { event });
  }
}

export function createDefaultApplicationDiagnosticsPort(): ApplicationDiagnosticsPort {
  const tauri =
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);
  return tauri
    ? new TauriApplicationDiagnosticsPort()
    : new MemoryApplicationDiagnosticsPort();
}
