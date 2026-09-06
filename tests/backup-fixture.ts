import type { BackupPort, BackupState } from "../app/src/core/history";

export function backupFixture(overrides: Partial<BackupPort> = {}): BackupPort {
  return {
    status: async (): Promise<BackupState> => ({
      config: { interval_minutes: 15, additional: null },
      status: {
        phase: "idle",
        additional_phase: "idle",
        last_local_capture_at: null,
        additional_protected_capture_at: null,
        local_error: null,
        additional_error: null,
        maintenance_error: null,
        pending_copy_count: 0,
        expired_copy_count: 0,
        known_missing_count: 0,
      },
    }),
    run: async () => undefined,
    cancel: async () => undefined,
    resume: async () => undefined,
    maintainIdle: async () => undefined,
    settings: async () => undefined,
    chooseAdditional: async () => null,
    history: async () => ({ generations: [] }),
    read: async () => {
      throw new Error("Unknown history resource");
    },
    tree: async () => [],
    imageUrl: () => "",
    exportAttachment: async () => undefined,
    ...overrides,
  };
}
