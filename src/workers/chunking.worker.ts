import { handleChunkingWorkerRequest } from "./chunkingHandler";
import type { ChunkingWorkerRequest, ChunkingWorkerResponse } from "./chunkingProtocol";

export { handleChunkingWorkerRequest } from "./chunkingHandler";

interface WorkerScopeLike {
  onmessage: ((ev: MessageEvent<ChunkingWorkerRequest>) => void) | null;
  postMessage: (msg: ChunkingWorkerResponse) => void;
}

// The app's DOM-only tsconfig does not include the WebWorker global declarations.
declare const DedicatedWorkerGlobalScope: { new (): WorkerScopeLike };

// A Window also has onmessage/postMessage. Binding there creates a reply loop.
if (
  typeof DedicatedWorkerGlobalScope !== "undefined" &&
  globalThis instanceof DedicatedWorkerGlobalScope
) {
  const workerScope = globalThis as unknown as WorkerScopeLike;
  workerScope.onmessage = (event: MessageEvent<ChunkingWorkerRequest>) => {
    workerScope.postMessage(handleChunkingWorkerRequest(event.data));
  };
}
