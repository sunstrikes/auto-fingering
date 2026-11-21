import type { FingeringPrior } from "../domain/types";
import { getCachedLumikeyPrior, loadLumikeyPrior } from "../prior/loader";
import { localResolveFingering } from "../solver/localResolve";
import { solveFingering } from "../solver/solveFingering";
import type { WorkerRequest, WorkerResponse } from "./protocol";

interface WorkerScopeLike {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (msg: WorkerResponse) => void;
}

/**
 * Synchronous worker handler for heuristic or already-cached prior requests.
 */
export function handleWorkerRequest(
  req: WorkerRequest,
  priorOverride?: FingeringPrior | null
): WorkerResponse {
  try {
    if (req.type === "load-prior") {
      return {
        requestId: req.requestId,
        type: "prior-ready",
        ok: true,
        priorReady: true,
      };
    }

    const usePrior = req.priorMode === "model-assist" && (req.lambda === undefined || req.lambda > 0);
    const activePrior = usePrior ? (priorOverride ?? getCachedLumikeyPrior()) : null;

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
            priorModel: activePrior,
            priorLambda: req.lambda,
          })
        : solveFingering(req.onsetSlices, req.profile, {
            ignoreExistingFingerings: req.ignoreExistingFingerings,
            priorModel: activePrior,
            priorLambda: req.lambda,
          });
    return {
      requestId: req.requestId,
      ok: true,
      result,
      priorReady: Boolean(activePrior),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { requestId: req.requestId, ok: false, error: message };
  }
}

export async function handleWorkerRequestAsync(
  req: WorkerRequest,
  postProgress?: (msg: WorkerResponse) => void
): Promise<WorkerResponse> {
  try {
    if (req.type === "load-prior") {
      await loadLumikeyPrior({
        baseUrl: req.customModelBaseUrl,
        onProgress: ({ loadedBytes, totalBytes }) => {
          postProgress?.({
            requestId: req.requestId,
            type: "prior-progress",
            loadedBytes,
            totalBytes,
          });
        },
      });
      return {
        requestId: req.requestId,
        type: "prior-ready",
        ok: true,
        priorReady: true,
      };
    }

    const usePrior = req.priorMode === "model-assist" && (req.lambda === undefined || req.lambda > 0);
    let priorModel: FingeringPrior | null = null;
    let fallbackReason: string | undefined;

    if (usePrior) {
      priorModel = getCachedLumikeyPrior();
      if (!priorModel) {
        try {
          priorModel = await loadLumikeyPrior({
            baseUrl: req.customModelBaseUrl,
            onProgress: ({ loadedBytes, totalBytes }) => {
              postProgress?.({
                requestId: req.requestId,
                type: "prior-progress",
                loadedBytes,
                totalBytes,
              });
            },
          });
        } catch (err) {
          fallbackReason = err instanceof Error ? err.message : String(err);
          priorModel = null;
        }
      }
    }

    const resp = handleWorkerRequest(req, priorModel);
    if ("ok" in resp && resp.ok && "result" in resp && fallbackReason) {
      resp.result = {
        ...resp.result,
        priorUsed: false,
        priorFallbackReason: fallbackReason,
      };
    }
    return resp;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { requestId: req.requestId, ok: false, error: message };
  }
}

const workerScope = globalThis as unknown as WorkerScopeLike;

workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  const needsAsync =
    req.type === "load-prior" ||
    (req.priorMode === "model-assist" && !getCachedLumikeyPrior());

  if (needsAsync) {
    void handleWorkerRequestAsync(req, (msg) => workerScope.postMessage(msg)).then((resp) => {
      workerScope.postMessage(resp);
    });
  } else {
    workerScope.postMessage(handleWorkerRequest(req));
  }
};
