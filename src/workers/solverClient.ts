import type { HandSpanProfile, OnsetSlice, SolveResult } from "../domain/types";
import type { WorkerRequest, WorkerResponse } from "./protocol";

export class SolverCancelledError extends Error {
  constructor(message = "Fingering solve request was superseded by a newer request.") {
    super(message);
    this.name = "SolverCancelledError";
  }
}

export interface WorkerLike {
  onmessage: ((ev: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface SolverClient {
  solve(onsetSlices: OnsetSlice[], profile: HandSpanProfile): Promise<SolveResult>;
  dispose(): void;
}

interface PendingRequest {
  requestId: number;
  resolve: (result: SolveResult) => void;
  reject: (err: unknown) => void;
}

function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL("./fingering.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;
}

/**
 * Create a lightweight typed RPC client over the fingering Web Worker.
 * Automatically cancels any previous in-flight request when a new one starts.
 */
export function createSolverClient(
  workerFactory: () => WorkerLike = defaultWorkerFactory
): SolverClient {
  let worker: WorkerLike | null = null;
  let nextRequestId = 1;
  let activeRequest: PendingRequest | null = null;

  function ensureWorker(): WorkerLike {
    if (!worker) {
      worker = workerFactory();
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
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
          pending.reject(new Error(event.message || "Worker execution error"));
        }
      };
    }
    return worker;
  }

  return {
    solve(onsetSlices: OnsetSlice[], profile: HandSpanProfile): Promise<SolveResult> {
      if (activeRequest) {
        const superseded = activeRequest;
        activeRequest = null;
        superseded.reject(new SolverCancelledError());
      }

      const requestId = nextRequestId++;
      const w = ensureWorker();

      return new Promise<SolveResult>((resolve, reject) => {
        activeRequest = { requestId, resolve, reject };
        const req: WorkerRequest = { requestId, onsetSlices, profile };
        w.postMessage(req);
      });
    },

    dispose() {
      if (activeRequest) {
        const pending = activeRequest;
        activeRequest = null;
        pending.reject(new SolverCancelledError("Solver client disposed."));
      }
      if (worker) {
        worker.terminate();
        worker = null;
      }
    },
  };
}
