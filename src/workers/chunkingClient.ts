import type { StaticChunkingResult, StaticScoreInput } from "../chunking/types";
import type { ScoreDocument } from "../domain/types";
import type { ChunkingWorkerRequest, ChunkingWorkerResponse } from "./chunkingProtocol";

export class ChunkingCancelledError extends Error {
  constructor(message = "Static chunking request was superseded by a newer request.") {
    super(message);
    this.name = "ChunkingCancelledError";
  }
}

export interface ChunkingWorkerLike {
  onmessage: ((ev: MessageEvent<ChunkingWorkerResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface ChunkingClient {
  analyzeStatic(input: ScoreDocument | StaticScoreInput): Promise<StaticChunkingResult>;
  dispose(): void;
}

interface PendingChunkingRequest {
  requestId: number;
  resolve: (result: StaticChunkingResult) => void;
  reject: (err: unknown) => void;
}

/**
 * Extracts only structured-clone-safe score fields (stripping XML DOM nodes/maps)
 * so static chunking payloads never trigger DataCloneError across postMessage.
 */
export function toStaticScoreInput(
  score: ScoreDocument | StaticScoreInput,
): StaticScoreInput {
  return {
    noteEvents: score.noteEvents,
    onsetSlices: score.onsetSlices,
    measureTimelines: score.measureTimelines,
    ticksPerQuarter: score.ticksPerQuarter,
    measureCount: score.measureCount,
    ...(score.measureStructuralMeta
      ? { measureStructuralMeta: score.measureStructuralMeta }
      : {}),
    ...(score.slurSpans ? { slurSpans: score.slurSpans } : {}),
    ...(score.tempoPoints ? { tempoPoints: score.tempoPoints } : {}),
  };
}

function defaultChunkingWorkerFactory(): ChunkingWorkerLike {
  return new Worker(new URL("./chunking.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as ChunkingWorkerLike;
}

/**
 * Typed RPC client over the dedicated lightweight static-chunking Web Worker.
 * Cancels superseded in-flight requests automatically (latest-wins).
 */
export function createChunkingClient(
  workerFactory: () => ChunkingWorkerLike = defaultChunkingWorkerFactory,
): ChunkingClient {
  let worker: ChunkingWorkerLike | null = null;
  let nextRequestId = 1;
  let activeRequest: PendingChunkingRequest | null = null;

  function ensureWorker(): ChunkingWorkerLike {
    if (!worker) {
      worker = workerFactory();
      worker.onmessage = (event: MessageEvent<ChunkingWorkerResponse>) => {
        const resp = event.data;
        if (!activeRequest || resp.requestId !== activeRequest.requestId) {
          return;
        }
        const pending = activeRequest;
        activeRequest = null;
        if (resp.ok) {
          pending.resolve(resp.result);
        } else {
          pending.reject(new Error(resp.error));
        }
      };
      worker.onerror = (event: ErrorEvent) => {
        if (activeRequest) {
          const pending = activeRequest;
          activeRequest = null;
          pending.reject(new Error(event.message || "Chunking worker execution error"));
        }
      };
    }
    return worker;
  }

  return {
    analyzeStatic(input: ScoreDocument | StaticScoreInput): Promise<StaticChunkingResult> {
      if (activeRequest) {
        const superseded = activeRequest;
        activeRequest = null;
        superseded.reject(new ChunkingCancelledError());
      }

      const requestId = nextRequestId++;
      const w = ensureWorker();
      const payload: ChunkingWorkerRequest = {
        type: "analyze-static",
        requestId,
        input: toStaticScoreInput(input),
      };

      return new Promise<StaticChunkingResult>((resolve, reject) => {
        activeRequest = { requestId, resolve, reject };
        w.postMessage(payload);
      });
    },

    dispose() {
      if (activeRequest) {
        const pending = activeRequest;
        activeRequest = null;
        pending.reject(new ChunkingCancelledError("Chunking client disposed."));
      }
      if (worker) {
        worker.terminate();
        worker = null;
      }
    },
  };
}
