import { describe, it, expect } from "vitest";
import { createSolverClient, SolverCancelledError, type WorkerLike } from "../src/workers/solverClient";
import { solveFingering } from "../src/solver/solveFingering";
import { DEFAULT_HAND_SPAN_PROFILE, type OnsetSlice } from "../src/domain/types";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";

function makeDummySlice(sliceId: string, midi: number, onsetTick: number): OnsetSlice {
  return {
    sliceId,
    hand: "RH",
    measureIndex: 0,
    onsetTick,
    onsetSec: onsetTick * 0.25,
    isGrace: false,
    phraseId: 0,
    notes: [
      {
        noteUid: `n-${sliceId}`,
        measureIndex: 0,
        onsetTick,
        durationTick: 1,
        onsetSec: onsetTick * 0.25,
        durationSec: 0.25,
        midi,
        hand: "RH",
        voice: "1",
        staff: 1,
        isGrace: false,
        isTieStop: false,
        isTieStart: false,
      },
    ],
    heldNotes: [],
  };
}

describe("workers seam: createSolverClient", () => {
  it("resolves SolveResult from worker and cancels superseded in-flight requests", async () => {
    const timers: Array<() => void> = [];

    const fakeWorker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg: unknown) {
        const req = msg as WorkerRequest;
        timers.push(() => {
          const result = solveFingering(req.onsetSlices, req.profile);
          const resp: WorkerResponse = {
            requestId: req.requestId,
            ok: true,
            result,
          };
          fakeWorker.onmessage?.({ data: resp } as MessageEvent<WorkerResponse>);
        });
      },
      terminate() {},
    };

    const client = createSolverClient(() => fakeWorker);

    const p1 = client.solve([makeDummySlice("a", 60, 0)], DEFAULT_HAND_SPAN_PROFILE);
    const p2 = client.solve(
      [makeDummySlice("b", 60, 0), makeDummySlice("c", 62, 1)],
      DEFAULT_HAND_SPAN_PROFILE
    );

    // First request should be rejected with SolverCancelledError
    await expect(p1).rejects.toBeInstanceOf(SolverCancelledError);

    // Flush queued worker responses (both stale #1 and current #2)
    timers.forEach((fn) => fn());

    const res2 = await p2;
    expect(Object.keys(res2.fingerByNoteUid).sort()).toEqual(["n-b", "n-c"]);

    client.dispose();
  });
});
