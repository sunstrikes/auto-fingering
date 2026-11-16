import { localResolveFingering } from "../solver/localResolve";
import { solveFingering } from "../solver/solveFingering";
import type { WorkerRequest, WorkerResponse } from "./protocol";

interface WorkerScopeLike {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (msg: WorkerResponse) => void;
}

export function handleWorkerRequest(req: WorkerRequest): WorkerResponse {
  try {
    const result =
      req.type === "local-resolve"
        ? localResolveFingering({
            onsetSlices: req.onsetSlices,
            profile: req.profile,
            priorFingerByNoteUid: req.priorFingerByNoteUid,
            targetNoteUid: req.targetNoteUid,
            override: req.override,
            anchors: req.anchors,
            removedRawAnchorUids: req.removedRawAnchorUids,
            ignoreExistingFingerings: req.ignoreExistingFingerings,
          })
        : solveFingering(req.onsetSlices, req.profile, {
            ignoreExistingFingerings: req.ignoreExistingFingerings,
          });
    return { requestId: req.requestId, ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { requestId: req.requestId, ok: false, error: message };
  }
}

const workerScope = globalThis as unknown as WorkerScopeLike;

workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  workerScope.postMessage(handleWorkerRequest(event.data));
};
