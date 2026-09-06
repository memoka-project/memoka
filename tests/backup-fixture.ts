import type { BackupPort, BackupState } from "../app/src/core/history";

export function backupFixture(overrides: Partial<BackupPort> = {}): BackupPort {
  return {
    status: async (): Promise<BackupState> => ({
      config: {
        schema_version: 3,
        interval_minutes: 15,
        local_retention: { last: 48, daily: 30, monthly: 12 },
        destinations: [],
      },
      status: {
        phase: "idle",
        last_local_capture_at: null,
        local_error: null,
        maintenance_error: null,
        destinations: {},
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
