import {
  splitPlainTextPasteBlocks,
  type LargePasteWorkerRequest,
  type LargePasteWorkerResponse,
} from "./large-paste-protocol";

interface WorkerScope {
  onmessage: ((event: MessageEvent<LargePasteWorkerRequest>) => void) | null;
  postMessage(message: LargePasteWorkerResponse): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { id, text } = event.data;
  try {
    scope.postMessage({
      id,
      kind: "progress",
      processed: 0,
      total: text.length,
    });
    const blocks = splitPlainTextPasteBlocks(text);
    scope.postMessage({
      id,
      kind: "progress",
      processed: text.length,
      total: text.length,
    });
    scope.postMessage({ id, kind: "complete", blocks });
  } catch (error) {
    scope.postMessage({
      id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
