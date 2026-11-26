import { analyzeScoreStatic } from "../chunking/staticAnalyzer";
import type { ChunkingWorkerRequest, ChunkingWorkerResponse } from "./chunkingProtocol";

interface WorkerScopeLike {
  onmessage: ((ev: MessageEvent<ChunkingWorkerRequest>) => void) | null;
  postMessage: (msg: ChunkingWorkerResponse) => void;
}

/**
 * Pure synchronous handler for static symbolic chunking worker requests.
 */
export function handleChunkingWorkerRequest(
  req: ChunkingWorkerRequest,
): ChunkingWorkerResponse {
  try {
    if (!req || typeof req !== "object" || !req.input) {
      throw new Error("Invalid chunking worker request: missing input.");
    }
    const result = analyzeScoreStatic(req.input);
    return {
      requestId: req.requestId,
      ok: true,
      result,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      requestId: req?.requestId ?? 0,
      ok: false,
      error: message,
    };
  }
}

const workerScope = globalThis as unknown as WorkerScopeLike;

workerScope.onmessage = (event: MessageEvent<ChunkingWorkerRequest>) => {
  workerScope.postMessage(handleChunkingWorkerRequest(event.data));
};
