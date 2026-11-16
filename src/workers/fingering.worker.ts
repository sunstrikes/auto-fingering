import { solveFingering } from "../solver/solveFingering";
import type { WorkerRequest, WorkerResponse } from "./protocol";

interface WorkerScopeLike {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (msg: WorkerResponse) => void;
}

const workerScope = globalThis as unknown as WorkerScopeLike;

workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { requestId, onsetSlices, profile } = event.data;
  try {
    const result = solveFingering(onsetSlices, profile);
    workerScope.postMessage({ requestId, ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    workerScope.postMessage({ requestId, ok: false, error: message });
  }
};
