import { createUuidV7 } from "../../app/src/core/ids";
import type { CoreRuntime } from "../../app/src/core/runtime";

export async function addSecondWindow(runtime: CoreRuntime): Promise<void> {
  if (runtime.windows.has("window-2")) return;
  await runtime.executeCommand({
    name: "window.split",
    operationId: createUuidV7(),
    source: "internal",
    payload: {
      targetWindowId: "window-1",
      newWindowId: "window-2",
      splitId: "split-1",
      direction: "vertical",
    },
  });
  await runtime.executeCommand({
    name: "window.update_view",
    operationId: createUuidV7(),
    source: "internal",
    payload: {
      windowId: "window-2",
      update: { mode: "insert" },
    },
  });
}
