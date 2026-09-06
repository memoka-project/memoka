import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CoreRuntime } from "./runtime";

/** CLI reads confirmed Core transactions only. This deliberately does not
 * blur, commit composition, mount a Note or trigger Help/index/mirror work. */
export async function installNativeSaveBarrier(
  currentRuntime: () => CoreRuntime | null,
): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  return listen<string>("memoka-save-barrier", ({ payload: id }) => {
    void (async () => {
      const runtime = currentRuntime();
      let saved = false;
      try {
        if (runtime) {
          await runtime.flushDurableState();
          saved = currentRuntime() === runtime;
        }
      } finally {
        await invoke("workspace_save_barrier_ack", { id, saved });
      }
    })().catch(() => undefined);
  });
}
