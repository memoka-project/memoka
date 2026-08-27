import {
  splitPlainTextPasteBlocks,
  type LargePasteWorkerRequest,
  type LargePasteWorkerResponse,
} from "./large-paste-protocol";

let requestSequence = 0;

export interface LargePlainTextPasteOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (processed: number, total: number) => void;
}

export async function prepareLargePlainTextPaste(
  text: string,
  options: LargePlainTextPasteOptions = {},
): Promise<readonly string[]> {
  if (options.signal?.aborted) throw abortError();
  if (typeof Worker !== "function") {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    if (options.signal?.aborted) throw abortError();
    options.onProgress?.(0, text.length);
    const blocks = splitPlainTextPasteBlocks(text);
    options.onProgress?.(text.length, text.length);
    return blocks;
  }

  const id = ++requestSequence;
  const worker = new Worker(
    new URL("./large-paste.worker.ts", import.meta.url),
    {
      type: "module",
      name: "memoka-large-paste",
    },
  );
  return new Promise<readonly string[]>((resolve, reject) => {
    const cleanup = (): void => {
      options.signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = (): void => {
      cleanup();
      reject(abortError());
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "Large paste Worker failed"));
    };
    worker.onmessage = (event: MessageEvent<LargePasteWorkerResponse>) => {
      const response = event.data;
      if (response.id !== id) return;
      if (response.kind === "progress") {
        options.onProgress?.(response.processed, response.total);
        return;
      }
      cleanup();
      if (response.kind === "complete") resolve(response.blocks);
      else reject(new Error(response.message));
    };
    worker.postMessage({ id, text } satisfies LargePasteWorkerRequest);
  });
}

function abortError(): DOMException {
  return new DOMException("Large paste was cancelled", "AbortError");
}
