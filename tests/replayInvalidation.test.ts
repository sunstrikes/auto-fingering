import { describe, expect, it } from "vitest";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import { MOTOR_FSRS_REDUCER_VERSION, reducePiecePracticeState } from "../src/guided/motorFsrs";
import {
  SOFT_INVALIDATION_STABILITY_FACTOR,
  applyChunkBoundaryOverrides,
  buildDerivedSnapshot,
  loadOrReducePiecePracticeState,
  projectPieceStateForScore,
  readValidDerivedSnapshot,
  writeDerivedSnapshot,
} from "../src/guided/replayInvalidation";
import type { MotorChunk } from "../src/chunking/types";
import type { PracticeEvent } from "../src/persistence/storagePort";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeChunk(chunkId: string, startM: number, endM: number): MotorChunk {
  return {
    chunkId,
    index: startM,
    sectionId: "sec-0",
    startMeasureIndex: startM,
    endMeasureIndex: endM,
    startCoord: { measureIndex: startM, beatNum: 0, beatDen: 1 },
    endCoord: { measureIndex: endM + 1, beatNum: 0, beatDen: 1 },
    measureCount: endM - startM + 1,
    stepCount: 8 * (endM - startM + 1),
    densityStepsPerMeasure: 8,
    hasAnacrusisLeadIn: false,
    anacrusisBeats: 0,
    overlapFlag: false,
    boundaryConfidence: 0.9,
  };
}

function makeEvent(overrides: Partial<PracticeEvent> = {}): PracticeEvent {
  return {
    eventId: overrides.eventId ?? "ev-1",
    pieceId: overrides.pieceId ?? "piece-1",
    scoreFingerprint: overrides.scoreFingerprint ?? "fp-orig",
    timestampMs: overrides.timestampMs ?? Date.UTC(2026, 10, 10, 10, 0, 0),
    localDateKey: overrides.localDateKey ?? "2026-11-10",
    timezoneOffsetMin: overrides.timezoneOffsetMin ?? 0,
    sessionId: overrides.sessionId ?? "sess-1",
    boutKind: overrides.boutKind ?? "chunk",
    startCoord: overrides.startCoord ?? { measureIndex: 0, beatNum: 0, beatDen: 1 },
    endCoord: overrides.endCoord ?? { measureIndex: 2, beatNum: 0, beatDen: 1 },
    practiceMode: overrides.practiceMode ?? "both",
    speedMultiplier: overrides.speedMultiplier ?? 0.8,
    durationSec: overrides.durationSec ?? 30,
    passCount: overrides.passCount ?? 1,
    wasColdFirstPass: overrides.wasColdFirstPass ?? true,
    scaffoldingLevel: overrides.scaffoldingLevel ?? 1,
    autoGrade: overrides.autoGrade ?? 3,
    fluency: overrides.fluency ?? {
      pitchAccuracy: 0.98,
      interiorHesitationCount: 0,
      junctionHesitationRatio: 1,
      timingCv: 0.05,
      stallDetected: false,
      dominantHandFaultRatio: { rh: 0.5, lh: 0.5 },
      switchBranchMismatch: false,
      reanchorCount: 0,
    },
    measureFaultCounts: overrides.measureFaultCounts ?? {},
    ...overrides,
  };
}

describe("Span-anchored Split/Merge replay & undo-safe per-measure soft invalidation", () => {
  it("replays parent span events onto Split sub-chunks with 0.80x discount weighted by per-measure faults", () => {
    const t0 = Date.UTC(2026, 10, 10, 10, 0, 0);
    const parentChunk = makeChunk("c-parent", 0, 1);

    // Practice parent chunk [0..1] across days; faults concentrated in measure 1
    const events: PracticeEvent[] = [
      makeEvent({
        eventId: "e0",
        timestampMs: t0,
        localDateKey: "2026-11-10",
        startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
        endCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
        autoGrade: 3,
        measureFaultCounts: {
          0: { missed: 0, extra: 0, hesitations: 0 },
          1: { missed: 2, extra: 1, hesitations: 1 },
        },
      }),
      makeEvent({
        eventId: "e1",
        timestampMs: t0 + DAY_MS,
        localDateKey: "2026-11-11",
        startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
        endCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
        autoGrade: 3,
        measureFaultCounts: {
          0: { missed: 0, extra: 0, hesitations: 0 },
          1: { missed: 1, extra: 0, hesitations: 1 },
        },
      }),
    ];

    const preSplit = reducePiecePracticeState(events, {
      pieceId: "piece-1",
      chunks: [parentChunk],
    }).chunkStates["c-parent"];

    // Apply Split override at measure 1
    const splitChunks = applyChunkBoundaryOverrides([parentChunk], {
      addedBoundaries: [{ measureIndex: 1, beatNum: 0, beatDen: 1 }],
      removedBoundaries: [],
      updatedAtMs: t0 + 2 * DAY_MS,
    });
    expect(splitChunks).toHaveLength(2);

    const postSplit = reducePiecePracticeState(events, {
      pieceId: "piece-1",
      chunks: splitChunks,
    });
    const cleanChild = postSplit.chunkStates[splitChunks[0].chunkId];
    const faultChild = postSplit.chunkStates[splitChunks[1].chunkId];

    // Clean measure 0 gets exact 0.80x conservative discount
    expect(cleanChild.stabilityDays).toBeCloseTo(preSplit.stabilityDays * 0.8, 5);
    expect(cleanChild.inheritedFromSplit).toBe(true);
    // Fault-heavy measure 1 gets weighted lower stability than clean measure 0
    expect(faultChild.stabilityDays).toBeLessThan(cleanChild.stabilityDays);
    expect(faultChild.inheritedFromSplit).toBe(true);

    // Subsequent event on faultChild progresses from discounted state
    const postSplitEvent = makeEvent({
      eventId: "e2",
      timestampMs: t0 + 2 * DAY_MS,
      localDateKey: "2026-11-12",
      startCoord: splitChunks[1].startCoord,
      endCoord: splitChunks[1].endCoord,
      autoGrade: 3,
    });
    const afterPractice = reducePiecePracticeState([...events, postSplitEvent], {
      pieceId: "piece-1",
      chunks: splitChunks,
    }).chunkStates[splitChunks[1].chunkId];
    expect(afterPractice.stabilityDays).toBeGreaterThan(faultChild.stabilityDays);
  });

  it("replays sub-chunk events onto Merged chunk using min(stabilityDays) & min(stableSpeed) and marks internal seam for verification", () => {
    const t0 = Date.UTC(2026, 10, 10, 10, 0, 0);
    const c0 = makeChunk("c0", 0, 0);
    const c1 = makeChunk("c1", 1, 1);

    // c0 is fast and well consolidated; c1 is slower and less stable
    const events: PracticeEvent[] = [
      makeEvent({
        eventId: "c0-d0",
        timestampMs: t0,
        localDateKey: "2026-11-10",
        startCoord: c0.startCoord,
        endCoord: c0.endCoord,
        speedMultiplier: 0.9,
        autoGrade: 3,
      }),
      makeEvent({
        eventId: "c0-d1",
        timestampMs: t0 + 2 * DAY_MS,
        localDateKey: "2026-11-12",
        startCoord: c0.startCoord,
        endCoord: c0.endCoord,
        speedMultiplier: 0.9,
        autoGrade: 3,
      }),
      makeEvent({
        eventId: "c1-d0",
        timestampMs: t0,
        localDateKey: "2026-11-10",
        startCoord: c1.startCoord,
        endCoord: c1.endCoord,
        speedMultiplier: 0.65,
        autoGrade: 2,
      }),
    ];

    const preMerge = reducePiecePracticeState(events, {
      pieceId: "piece-1",
      chunks: [c0, c1],
    });
    const s0 = preMerge.chunkStates["c0"];
    const s1 = preMerge.chunkStates["c1"];
    expect(s0.stabilityDays).toBeGreaterThan(s1.stabilityDays);
    expect(s0.stableSpeed).toBe(0.9);
    expect(s1.stableSpeed).toBe(0.65);

    const mergedChunks = applyChunkBoundaryOverrides([c0, c1], {
      addedBoundaries: [],
      removedBoundaries: [{ measureIndex: 1, beatNum: 0, beatDen: 1 }],
      updatedAtMs: t0 + 3 * DAY_MS,
    });
    expect(mergedChunks).toHaveLength(1);

    const postMerge = reducePiecePracticeState(events, {
      pieceId: "piece-1",
      chunks: mergedChunks,
    });
    const mergedState = postMerge.chunkStates[mergedChunks[0].chunkId];
    expect(mergedState.stabilityDays).toBeCloseTo(Math.min(s0.stabilityDays, s1.stabilityDays), 6);
    expect(mergedState.stableSpeed).toBe(0.65);
    expect(mergedState.pendingInternalJunctionVerify).toBe(true);
    expect(mergedState.internalJunctionCoords).toEqual([c1.startCoord]);
  });

  it("soft-invalidates only edited measures at projection time and restores 100% stability losslessly on Undo", () => {
    const t0 = Date.UTC(2026, 10, 10, 10, 0, 0);
    const c0 = makeChunk("c0", 0, 0);
    const c1 = makeChunk("c1", 1, 1);
    const c2 = makeChunk("c2", 2, 2);

    const fpOrig = "fp-orig";
    const fpEdited = "fp-edited";
    const hashesOrig = ["h0", "h1", "h2"];
    const hashesEdited = ["h0", "h1-repaired", "h2"];
    const measureHashesByFingerprint = {
      [fpOrig]: hashesOrig,
      [fpEdited]: hashesEdited,
    };

    const events: PracticeEvent[] = [
      makeEvent({
        eventId: "e-c0",
        scoreFingerprint: fpOrig,
        timestampMs: t0,
        localDateKey: "2026-11-10",
        startCoord: c0.startCoord,
        endCoord: c0.endCoord,
        autoGrade: 3,
      }),
      makeEvent({
        eventId: "e-c1-0",
        scoreFingerprint: fpOrig,
        timestampMs: t0,
        localDateKey: "2026-11-10",
        startCoord: c1.startCoord,
        endCoord: c1.endCoord,
        autoGrade: 3,
      }),
      makeEvent({
        eventId: "e-c1-1",
        scoreFingerprint: fpOrig,
        timestampMs: t0 + DAY_MS,
        localDateKey: "2026-11-11",
        startCoord: c1.startCoord,
        endCoord: c1.endCoord,
        autoGrade: 3,
      }),
      makeEvent({
        eventId: "e-c2",
        scoreFingerprint: fpOrig,
        timestampMs: t0,
        localDateKey: "2026-11-10",
        startCoord: c2.startCoord,
        endCoord: c2.endCoord,
        autoGrade: 3,
      }),
    ];

    const baseState = reducePiecePracticeState(events, {
      pieceId: "piece-1",
      chunks: [c0, c1, c2],
    });
    const origS0 = baseState.chunkStates["c0"].stabilityDays;
    const origS1 = baseState.chunkStates["c1"].stabilityDays;
    const origS2 = baseState.chunkStates["c2"].stabilityDays;

    // Project onto repaired score (only measure 1 changed)
    const repairedProjection = projectPieceStateForScore(baseState, {
      currentFingerprint: fpEdited,
      currentMeasureHashes: hashesEdited,
      measureHashesByFingerprint,
    });

    // Untouched measures retain 100% stability
    expect(repairedProjection.chunkStates["c0"].stabilityDays).toBe(origS0);
    expect(repairedProjection.chunkStates["c0"].needsRevisionReview).toBeFalsy();
    expect(repairedProjection.chunkStates["c2"].stabilityDays).toBe(origS2);
    expect(repairedProjection.chunkStates["c2"].needsRevisionReview).toBeFalsy();

    // Edited measure 1 is softly discounted & flagged
    expect(repairedProjection.chunkStates["c1"].stabilityDays).toBeCloseTo(
      origS1 * SOFT_INVALIDATION_STABILITY_FACTOR,
      6,
    );
    expect(repairedProjection.chunkStates["c1"].needsRevisionReview).toBe(true);
    expect(repairedProjection.chunkStates["c1"].changedMeasureIndices).toEqual([1]);

    // Undo back to original fingerprint restores 100% original stability losslessly
    const undoneProjection = projectPieceStateForScore(baseState, {
      currentFingerprint: fpOrig,
      currentMeasureHashes: hashesOrig,
      measureHashesByFingerprint,
    });
    expect(undoneProjection.chunkStates["c1"].stabilityDays).toBe(origS1);
    expect(undoneProjection.chunkStates["c1"].needsRevisionReview).toBeFalsy();
    expect(undoneProjection.chunkStates["c0"].stabilityDays).toBe(origS0);
    expect(undoneProjection.chunkStates["c2"].stabilityDays).toBe(origS2);
  });

  it("caches derivedSnapshots stamped with reducerVersion & lastEventId and invalidates on stale version or new event", async () => {
    const storage = createInMemoryStorage();
    const chunk = makeChunk("c0", 0, 1);
    const ev1 = makeEvent({ eventId: "ev-1", timestampMs: 1000, localDateKey: "2026-11-10" });
    await storage.commit({ practiceEvents: [ev1] });

    const first = await loadOrReducePiecePracticeState(storage, "piece-1", {
      pieceId: "piece-1",
      chunks: [chunk],
    });
    expect(first.fromCache).toBe(false);
    expect(first.state.lastEventId).toBe("ev-1");

    const cached = await readValidDerivedSnapshot(storage, "piece-1", "ev-1", first.state.layoutSignature);
    expect(cached).toEqual(first.state);

    // Second load hits cache
    const second = await loadOrReducePiecePracticeState(storage, "piece-1", {
      pieceId: "piece-1",
      chunks: [chunk],
    });
    expect(second.fromCache).toBe(true);
    expect(second.state).toEqual(first.state);

    // Adding a new event invalidates cache via lastEventId mismatch
    const ev2 = makeEvent({ eventId: "ev-2", timestampMs: 1000 + DAY_MS, localDateKey: "2026-11-11" });
    await storage.commit({ practiceEvents: [ev2] });
    const third = await loadOrReducePiecePracticeState(storage, "piece-1", {
      pieceId: "piece-1",
      chunks: [chunk],
    });
    expect(third.fromCache).toBe(false);
    expect(third.state.lastEventId).toBe("ev-2");
    expect(third.state.chunkStates["c0"].stabilityDays).toBeGreaterThan(
      first.state.chunkStates["c0"].stabilityDays,
    );

    // Stale reducerVersion in derivedSnapshots is rejected
    const staleSnap = buildDerivedSnapshot("piece-1", third.state);
    await writeDerivedSnapshot(storage, "piece-1", third.state);
    await storage.commit({
      derivedSnapshots: [{ ...staleSnap, reducerVersion: MOTOR_FSRS_REDUCER_VERSION + 99 }],
    });
    expect(
      await readValidDerivedSnapshot(storage, "piece-1", "ev-2", third.state.layoutSignature),
    ).toBeUndefined();
  });
});
