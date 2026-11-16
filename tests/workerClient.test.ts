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

  it("forwards ignoreExistingFingerings through WorkerRequest to solveFingering and worker entrypoint", async () => {
    const anchoredScale: OnsetSlice[] = [
      {
        ...makeDummySlice("s0", 60, 0),
        notes: [
          {
            ...makeDummySlice("s0", 60, 0).notes[0],
            anchorFinger: 5,
            anchorRawPreserved: true,
          },
        ],
      },
      makeDummySlice("s1", 62, 1),
      makeDummySlice("s2", 64, 2),
    ];

    const capturedRequests: WorkerRequest[] = [];
    const fakeWorker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg: unknown) {
        const req = msg as WorkerRequest;
        capturedRequests.push(req);
        queueMicrotask(() => {
          const result = solveFingering(req.onsetSlices, req.profile, {
            ignoreExistingFingerings: req.ignoreExistingFingerings,
          });
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

    const withAnchors = await client.solve(anchoredScale, DEFAULT_HAND_SPAN_PROFILE);
    expect(withAnchors.fingerByNoteUid["n-s0"]).toBe(5);
    expect(capturedRequests[0].ignoreExistingFingerings).toBeUndefined();

    const ignoringAnchors = await client.solve(anchoredScale, DEFAULT_HAND_SPAN_PROFILE, {
      ignoreExistingFingerings: true,
    });
    expect(capturedRequests[1].ignoreExistingFingerings).toBe(true);
    expect(ignoringAnchors.fingerByNoteUid["n-s0"]).toBe(1);

    client.dispose();
  });

  it("supports resolveLocal WorkerRequest for phrase & pinOnly overrides and cancels superseded requests", async () => {
    const scale: OnsetSlice[] = [
      makeDummySlice("s0", 60, 0),
      makeDummySlice("s1", 62, 1),
      makeDummySlice("s2", 64, 2),
      makeDummySlice("s3", 65, 3),
    ];

    const timers: Array<() => void> = [];
    const capturedTypes: Array<string | undefined> = [];

    const { handleWorkerRequest } = await import("../src/workers/fingering.worker");

    const fakeWorker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg: unknown) {
        const req = msg as WorkerRequest;
        capturedTypes.push(req.type);
        timers.push(() => {
          const resp = handleWorkerRequest(req);
          fakeWorker.onmessage?.({ data: resp } as MessageEvent<WorkerResponse>);
        });
      },
      terminate() {},
    };

    const client = createSolverClient(() => fakeWorker);
    const pFull = client.solve(scale, DEFAULT_HAND_SPAN_PROFILE);
    timers.shift()!();
    const fullRes = await pFull;
    expect(fullRes.fingerByNoteUid["n-s1"]).toBe(2);

    const pLocal1 = client.resolveLocal!({
      onsetSlices: scale,
      profile: DEFAULT_HAND_SPAN_PROFILE,
      priorFingerByNoteUid: fullRes.fingerByNoteUid,
      targetNoteUid: "n-s1",
      override: { finger: 4, mode: "phrase" },
      anchors: { "n-s1": { finger: 4, mode: "phrase" } },
    });
    const pLocal2 = client.resolveLocal!({
      onsetSlices: scale,
      profile: DEFAULT_HAND_SPAN_PROFILE,
      priorFingerByNoteUid: fullRes.fingerByNoteUid,
      targetNoteUid: "n-s1",
      override: { finger: 5, mode: "pinOnly" },
      anchors: { "n-s1": { finger: 5, mode: "pinOnly" } },
    });

    await expect(pLocal1).rejects.toBeInstanceOf(SolverCancelledError);
    timers.forEach((fn) => fn());
    const localRes = await pLocal2;

    expect(capturedTypes).toContain("local-resolve");
    expect(localRes.fingerByNoteUid["n-s1"]).toBe(5);
    expect(localRes.fingerByNoteUid["n-s0"]).toBe(fullRes.fingerByNoteUid["n-s0"]);
    expect(localRes.fingerByNoteUid["n-s2"]).toBe(fullRes.fingerByNoteUid["n-s2"]);

    client.dispose();
  });
});
