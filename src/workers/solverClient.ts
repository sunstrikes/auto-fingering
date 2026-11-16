import type {
  AnchorOverride,
  Finger,
  HandSpanProfile,
  OnsetSlice,
  SolveOptions,
  SolveResult,
} from "../domain/types";
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

export interface LocalResolveClientInput {
  onsetSlices: OnsetSlice[];
  profile: HandSpanProfile;
  priorFingerByNoteUid: Record<string, Finger>;
  targetNoteUid: string;
  override: AnchorOverride | null;
  anchors: Record<string, AnchorOverride>;
  removedRawAnchorUids?: string[];
  ignoreExistingFingerings?: boolean;
}

export interface SolverClient {
  solve(
    onsetSlices: OnsetSlice[],
    profile: HandSpanProfile,
    options?: SolveOptions
  ): Promise<SolveResult>;
  resolveLocal?(input: LocalResolveClientInput): Promise<SolveResult>;
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

  function dispatch(buildRequest: (requestId: number) => WorkerRequest): Promise<SolveResult> {
    if (activeRequest) {
      const superseded = activeRequest;
      activeRequest = null;
      superseded.reject(new SolverCancelledError());
    }

    const requestId = nextRequestId++;
    const w = ensureWorker();

    return new Promise<SolveResult>((resolve, reject) => {
      activeRequest = { requestId, resolve, reject };
      w.postMessage(buildRequest(requestId));
    });
  }

  return {
    solve(
      onsetSlices: OnsetSlice[],
      profile: HandSpanProfile,
      options?: SolveOptions
    ): Promise<SolveResult> {
      return dispatch((requestId) => ({
        requestId,
        onsetSlices,
        profile,
        ignoreExistingFingerings: options?.ignoreExistingFingerings,
      }));
    },

    resolveLocal(input: LocalResolveClientInput): Promise<SolveResult> {
      return dispatch((requestId) => ({
        type: "local-resolve",
        requestId,
        onsetSlices: input.onsetSlices,
        profile: input.profile,
        priorFingerByNoteUid: input.priorFingerByNoteUid,
        targetNoteUid: input.targetNoteUid,
        override: input.override,
        anchors: input.anchors,
        removedRawAnchorUids: input.removedRawAnchorUids,
        ignoreExistingFingerings: input.ignoreExistingFingerings,
      }));
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
