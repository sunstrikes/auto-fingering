import { analyzeScoreStatic } from "../chunking/staticAnalyzer";
import type { ChunkingWorkerRequest, ChunkingWorkerResponse } from "./chunkingProtocol";

/**
 * Side-effect-free handler shared by the dedicated worker and main-thread fallback.
 * Importing this module must never install a global message listener.
 */
export function handleChunkingWorkerRequest(
  req: ChunkingWorkerRequest,
): ChunkingWorkerResponse {
  try {
    if (!req || typeof req !== "object" || !req.input) {
      throw new Error("Invalid chunking worker request: missing input.");
    }
    return {
      requestId: req.requestId,
      ok: true,
      result: analyzeScoreStatic(req.input),
    };
  } catch (err) {
    return {
      requestId: req?.requestId ?? 0,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
