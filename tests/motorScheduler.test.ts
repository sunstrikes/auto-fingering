import { describe, expect, it } from "vitest";
import type { ChunkJunction, MacroSection, MotorChunk, PassageCluster } from "../src/chunking/types";
import type { MotorUnitMemoryState, PiecePracticeState } from "../src/guided/motorFsrs";
import { planGuidedSession } from "../src/guided/sessionPlanner";
import {
  EARLY_MACRO_REST_DURATION_MS,
  EARLY_MACRO_REST_MIN_ELAPSED_MS,
  advanceMotorScheduler,
  createMotorSchedulerState,
  getClusterWarmStartForChunk,
  recordSchedulerBoutOutcome,
  recordSchedulerStage0Graduated,
  shouldOfferEarlyMacroRest,
  skipCircuitBreaker,
  skipEarlyMacroRest,
} from "../src/guided/motorScheduler";

function makeChunk(index: number, opts: Partial<MotorChunk> = {}): MotorChunk {
  const startMeasureIndex = index * 2;
  const endMeasureIndex = startMeasureIndex + 1;
  return {
    chunkId: `chunk-${index}`,
    index,
    sectionId: "sec-1",
    startMeasureIndex,
    endMeasureIndex,
    startCoord: { measureIndex: startMeasureIndex, beatNum: 0, beatDen: 1 },
    endCoord: { measureIndex: endMeasureIndex + 1, beatNum: 0, beatDen: 1 },
    measureCount: 2,
    stepCount: 8,
    densityStepsPerMeasure: 4,
    hasAnacrusisLeadIn: false,
    anacrusisBeats: 0,
    overlapFlag: false,
    boundaryConfidence: 0.9,
    ...opts,
  };
}

function makeJunction(leftIdx: number, rightIdx: number, priorRisk = 0.35): ChunkJunction {
  const m = rightIdx * 2;
  return {
    junctionId: `junc-${leftIdx}-${rightIdx}`,
    leftChunkId: `chunk-${leftIdx}`,
    rightChunkId: `chunk-${rightIdx}`,
    boundaryCoord: { measureIndex: m, beatNum: 0, beatDen: 1 },
    measureIndex: m,
    bridgeWindowSteps: {
      startStepIndex: m * 4 - 2,
      endStepIndex: m * 4 + 2,
      junctionStepIndex: m * 4,
    },
    dimensions: {
      d1TransitionHazard: priorRisk,
      d2PositionLeapVelocity: 0.2,
      d3BimanualCoupling: 0.2,
      d4HeldFingerLoad: 0.1,
      d5SwitchPointInterference: 0,
      d6EmpiricalPosterior: 0,
    },
    priorRisk,
    posteriorRisk: priorRisk,
    isHighRisk: priorRisk >= 0.65,
    reasonTags: priorRisk >= 0.65 ? ["wide-leap"] : [],
    prepCueLabel: "smooth",
  };
}

function makeUnitState(
  chunk: MotorChunk,
  overrides: Partial<MotorUnitMemoryState> = {},
): MotorUnitMemoryState {
  return {
    unitId: chunk.chunkId,
    unitKind: "chunk",
    startCoord: chunk.startCoord,
    endCoord: chunk.endCoord,
    measureIndices: [chunk.startMeasureIndex, chunk.endMeasureIndex],
    handStage: "both",
    stableSpeed: 0.75,
    targetSpeed: 1.0,
    difficulty: 5.0,
    stabilityDays: 2.0,
    retrievability: 0.92,
    intervalDays: 2.0,
    nextReviewDateKey: "2026-11-28",
    lastReviewedAtMs: 1_000_000,
    lastEventTimestampMs: 1_000_000,
    lastSleepUpdateTimestampMs: 1_000_000,
    lastSleepGateDateKey: "2026-11-25",
    sleepConsolidatedNights: 1,
    consecutiveAgainDays: 0,
    reviewCount: 2,
    lastEffectiveGrade: 3,
    ...overrides,
  };
}

function makeSections(chunks: MotorChunk[]): MacroSection[] {
  return [
    {
      sectionId: "sec-1",
      index: 0,
      startMeasureIndex: 0,
      endMeasureIndex: chunks.length * 2 - 1,
      startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
      endCoord: { measureIndex: chunks.length * 2, beatNum: 0, beatDen: 1 },
      measureCount: chunks.length * 2,
      label: "Main",
      boundaryReason: "start",
      chunkIds: chunks.map((c) => c.chunkId),
    },
  ];
}

describe("motorScheduler", () => {
  it("scales Active Rotation Pool (2-3 high-load polyphony, 3-4 standard, 4-5 pure review) and bans back-to-back identical or same-cluster near-variants", () => {
    const denseChunks = [
      makeChunk(0, { densityStepsPerMeasure: 12 }),
      makeChunk(1, { densityStepsPerMeasure: 12 }),
      makeChunk(2, { densityStepsPerMeasure: 12 }),
      makeChunk(3, { densityStepsPerMeasure: 10 }),
      makeChunk(4, { densityStepsPerMeasure: 10 }),
    ];
    const densePlan = planGuidedSession({
      timeBoxMinutes: 25,
      macroSections: makeSections(denseChunks),
      motorChunks: denseChunks,
      chunkJunctions: [makeJunction(0, 1, 0.7), makeJunction(1, 2, 0.7)],
      passageClusters: [],
      performanceCues: [],
      piecePracticeState: null,
      selectedMacroSectionId: null,
      practiceMode: "both",
      nowTimestampMs: 10_000,
      nowLocalDateKey: "2026-11-26",
    });
    expect(densePlan.poolTargetSize).toBeGreaterThanOrEqual(2);
    expect(densePlan.poolTargetSize).toBeLessThanOrEqual(3);

    // Pure review session scales up to 4-5
    const reviewChunks = [0, 1, 2, 3, 4].map((i) => makeChunk(i));
    const reviewStates: Record<string, MotorUnitMemoryState> = {};
    for (const c of reviewChunks) {
      reviewStates[c.chunkId] = makeUnitState(c, {
        stableSpeed: 0.85,
        sleepConsolidatedNights: 2,
        retrievability: 0.94,
      });
    }
    const reviewPlan = planGuidedSession({
      timeBoxMinutes: 25,
      macroSections: makeSections(reviewChunks),
      motorChunks: reviewChunks,
      chunkJunctions: [],
      passageClusters: [],
      performanceCues: [],
      piecePracticeState: {
        reducerVersion: 1,
        pieceId: "p1",
        eventCount: 10,
        bestStableSpeed: 0.85,
        layoutSignature: "sig",
        chunkStates: reviewStates,
        junctionStates: {},
      },
      selectedMacroSectionId: null,
      nowTimestampMs: 10_000,
      nowLocalDateKey: "2026-11-26",
    });
    expect(reviewPlan.poolTargetSize).toBeGreaterThanOrEqual(4);
    expect(reviewPlan.poolTargetSize).toBeLessThanOrEqual(5);

    // Phase 2 pseudorandom interleaving strictly respects back-to-back & same-cluster bans
    const cluster: PassageCluster = {
      clusterId: "cluster-x",
      label: "X",
      prototypeInstanceId: "i0",
      leverageRatio: 2,
      totalCoveredMeasures: 4,
      switchPoints: [],
      instances: [
        {
          instanceId: "i0",
          clusterId: "cluster-x",
          startMeasureIndex: 0,
          endMeasureIndex: 1,
          startCoord: reviewChunks[0].startCoord,
          endCoord: reviewChunks[0].endCoord,
          isPrototype: true,
          transpositionSemitones: 0,
          musicSimilarity: 1,
          fingeringIsomorphism: 1,
          motorReuse: 1,
          variantKind: "exact",
          diffCoords: [],
        },
        {
          instanceId: "i1",
          clusterId: "cluster-x",
          startMeasureIndex: 2,
          endMeasureIndex: 3,
          startCoord: reviewChunks[1].startCoord,
          endCoord: reviewChunks[1].endCoord,
          isPrototype: false,
          transpositionSemitones: 2,
          musicSimilarity: 0.8,
          fingeringIsomorphism: 0.75,
          motorReuse: 0.7,
          variantKind: "transposed",
          diffCoords: [],
        },
      ],
    };

    let state = createMotorSchedulerState({
      plan: reviewPlan,
      chunks: reviewChunks,
      junctions: [],
      passageClusters: [cluster],
      piecePracticeState: {
        reducerVersion: 1,
        pieceId: "p1",
        eventCount: 10,
        bestStableSpeed: 0.85,
        layoutSignature: "sig",
        chunkStates: reviewStates,
        junctionStates: {},
      },
      manualPracticeMode: "both",
      startedAtMs: 10_000,
      seed: 42,
    });

    const visited: Array<{ chunkId: string; clusterId?: string }> = [];
    for (let step = 0; step < 12; step++) {
      const d = state.currentDirective;
      if (d.kind !== "chunk") break;
      visited.push({ chunkId: d.chunk.chunkId, clusterId: d.clusterId });
      state = recordSchedulerBoutOutcome(state, {
        chunkId: d.chunk.chunkId,
        boutKind: "chunk",
        practiceMode: "both",
        speedMultiplier: d.targetSpeed,
        grade: 3,
        pitchAccuracy: 0.98,
        stallDetected: false,
        interiorHesitationCount: 0,
        junctionHesitationRatio: 1,
        dominantHandFaultRatio: { rh: 0, lh: 0 },
        durationMs: 15_000,
        nowMs: 10_000 + (step + 1) * 15_000,
      });
      state = advanceMotorScheduler(state, 10_000 + (step + 1) * 15_000);
    }

    expect(visited.length).toBe(12);
    for (let i = 1; i < visited.length; i++) {
      expect(visited[i].chunkId).not.toBe(visited[i - 1].chunkId);
      if (visited[i].clusterId && visited[i - 1].clusterId) {
        expect(visited[i].clusterId).not.toBe(visited[i - 1].clusterId);
      }
    }
  });

  it("progresses through 3-stage contextual interference: Phase 0 (0.55x, Stage 0 + 1 steady pass, 3-min hard cap) -> Phase 1 (serial) -> Phase 2 (pseudorandom)", () => {
    const chunks = [makeChunk(0), makeChunk(1), makeChunk(2)];
    const plan = planGuidedSession({
      timeBoxMinutes: 25,
      macroSections: makeSections(chunks),
      motorChunks: chunks,
      chunkJunctions: [],
      passageClusters: [],
      performanceCues: [],
      piecePracticeState: null,
      selectedMacroSectionId: null,
      nowTimestampMs: 0,
      nowLocalDateKey: "2026-11-26",
    });

    let state = createMotorSchedulerState({
      plan,
      chunks,
      junctions: [],
      passageClusters: [],
      piecePracticeState: null,
      manualPracticeMode: "both",
      startedAtMs: 0,
    });

    // Starts in Phase 0 at 0.55x decoding speed
    expect(state.units["chunk-0"].phase).toBe(0);
    expect(state.units["chunk-0"].workingSpeed).toBe(0.55);

    // Stage 0 graduation + 1 steady pass promotes chunk-0 to Phase 1
    state = recordSchedulerStage0Graduated(state, "chunk-0", 30_000);
    state = recordSchedulerBoutOutcome(state, {
      chunkId: "chunk-0",
      boutKind: "chunk",
      practiceMode: "both",
      speedMultiplier: 0.55,
      grade: 3,
      pitchAccuracy: 0.96,
      stallDetected: false,
      interiorHesitationCount: 0,
      junctionHesitationRatio: 1,
      dominantHandFaultRatio: { rh: 0, lh: 0 },
      durationMs: 25_000,
      nowMs: 55_000,
    });
    expect(state.units["chunk-0"].phase).toBe(1);
    // Decoding zone (+13%) upgrades 0.55 -> 0.62
    expect(state.units["chunk-0"].workingSpeed).toBeGreaterThan(0.55);

    // Phase 0 3-minute hard cap promotes chunk-1 even without smooth pass
    state = recordSchedulerBoutOutcome(state, {
      chunkId: "chunk-1",
      boutKind: "chunk",
      practiceMode: "both",
      speedMultiplier: 0.55,
      grade: 2,
      pitchAccuracy: 0.86,
      stallDetected: false,
      interiorHesitationCount: 1,
      junctionHesitationRatio: 1,
      dominantHandFaultRatio: { rh: 0.5, lh: 0.5 },
      durationMs: 185_000,
      nowMs: 240_000,
    });
    expect(state.units["chunk-1"].phase).toBe(1);

    // Reach >= 0.75x + 2 non-adjacent clean interleaved rounds -> Phase 2
    state.units["chunk-0"].workingSpeed = 0.75;
    state.units["chunk-0"].stableSpeed = 0.75;
    state.units["chunk-0"].nonAdjacentCleanRounds = 0;

    state = recordSchedulerBoutOutcome(state, {
      chunkId: "chunk-0",
      boutKind: "chunk",
      practiceMode: "both",
      speedMultiplier: 0.75,
      grade: 3,
      pitchAccuracy: 0.98,
      stallDetected: false,
      interiorHesitationCount: 0,
      junctionHesitationRatio: 1,
      dominantHandFaultRatio: { rh: 0, lh: 0 },
      durationMs: 20_000,
      nowMs: 260_000,
    });
    expect(state.units["chunk-0"].phase).toBe(1);

    // Interleave chunk-1 cleanly in between (non-adjacent)
    state = recordSchedulerBoutOutcome(state, {
      chunkId: "chunk-1",
      boutKind: "chunk",
      practiceMode: "both",
      speedMultiplier: 0.55,
      grade: 3,
      pitchAccuracy: 0.97,
      stallDetected: false,
      interiorHesitationCount: 0,
      junctionHesitationRatio: 1,
      dominantHandFaultRatio: { rh: 0, lh: 0 },
      durationMs: 20_000,
      nowMs: 280_000,
    });

    // Second non-adjacent clean round on chunk-0 promotes to Phase 2 AND unlocks at most 1 speed upgrade >= 0.65x
    state = recordSchedulerBoutOutcome(state, {
      chunkId: "chunk-0",
      boutKind: "chunk",
      practiceMode: "both",
      speedMultiplier: 0.75,
      grade: 3,
      pitchAccuracy: 1,
      stallDetected: false,
      interiorHesitationCount: 0,
      junctionHesitationRatio: 1,
      dominantHandFaultRatio: { rh: 0, lh: 0 },
      durationMs: 20_000,
      nowMs: 300_000,
    });
    expect(state.units["chunk-0"].phase).toBe(2);
    expect(state.units["chunk-0"].speedUpgradesThisSession).toBe(1);
    const upgradedSpeed = state.units["chunk-0"].workingSpeed;
    expect(upgradedSpeed).toBeGreaterThan(0.75);
    expect(upgradedSpeed).toBeLessThanOrEqual(0.85);

    // Subsequent clean rounds at >= 0.65x do NOT upgrade speed a second time in the same session
    for (let r = 0; r < 2; r++) {
      state = recordSchedulerBoutOutcome(state, {
        chunkId: "chunk-1",
        boutKind: "chunk",
        practiceMode: "both",
        speedMultiplier: 0.62,
        grade: 3,
        pitchAccuracy: 0.98,
        stallDetected: false,
        interiorHesitationCount: 0,
        junctionHesitationRatio: 1,
        dominantHandFaultRatio: { rh: 0, lh: 0 },
        durationMs: 20_000,
        nowMs: 320_000 + r * 40_000,
      });
      state = recordSchedulerBoutOutcome(state, {
        chunkId: "chunk-0",
        boutKind: "chunk",
        practiceMode: "both",
        speedMultiplier: upgradedSpeed,
        grade: 4,
        pitchAccuracy: 1,
        stallDetected: false,
        interiorHesitationCount: 0,
        junctionHesitationRatio: 1,
        dominantHandFaultRatio: { rh: 0, lh: 0 },
        durationMs: 20_000,
        nowMs: 340_000 + r * 40_000,
      });
    }
    expect(state.units["chunk-0"].speedUpgradesThisSession).toBe(1);
    expect(state.units["chunk-0"].workingSpeed).toBe(upgradedSpeed);
  });

  it("triggers 2-consecutive-fault circuit-breaker in strict priority: Boundary -> Bridge Window > >=75% Single-Hand -> Isolation (<=0.75x & -12% return) > -15% Step-down / Waiting rescue, all C8-skippable", () => {
    const chunks = [makeChunk(0), makeChunk(1), makeChunk(2)];
    const junction01 = makeJunction(0, 1, 0.72);
    const plan = planGuidedSession({
      timeBoxMinutes: 25,
      macroSections: makeSections(chunks),
      motorChunks: chunks,
      chunkJunctions: [junction01],
      passageClusters: [],
      performanceCues: [],
      piecePracticeState: null,
      selectedMacroSectionId: null,
      nowTimestampMs: 0,
      nowLocalDateKey: "2026-11-26",
    });

    // Priority 1: Boundary fault + >=75% single-hand fault simultaneously -> Bridge Window wins!
    let s1 = createMotorSchedulerState({
      plan,
      chunks,
      junctions: [junction01],
      passageClusters: [],
      piecePracticeState: null,
      manualPracticeMode: "both",
      startedAtMs: 0,
    });
    s1.units["chunk-0"].phase = 1;
    s1.units["chunk-0"].workingSpeed = 0.8;

    for (let i = 0; i < 2; i++) {
      s1 = recordSchedulerBoutOutcome(s1, {
        chunkId: "chunk-0",
        boutKind: "chunk",
        junction: junction01,
        practiceMode: "both",
        speedMultiplier: 0.8,
        grade: 1,
        pitchAccuracy: 0.7,
        stallDetected: false,
        interiorHesitationCount: 0,
        junctionHesitationRatio: 2.1,
        boundaryFault: true,
        dominantHandFaultRatio: { rh: 0.9, lh: 0.1 },
        durationMs: 10_000,
        nowMs: (i + 1) * 10_000,
      });
    }
    expect(s1.units["chunk-0"].activeRescue?.kind).toBe("bridge");
    expect(s1.units["chunk-0"].activeRescue?.skippableViaC8).toBe(true);

    // Bridge Window exits on 2 cumulative smooth passes (1 slip in between does NOT reset progress)
    s1 = recordSchedulerBoutOutcome(s1, {
      chunkId: "chunk-0",
      boutKind: "bridge",
      junction: junction01,
      practiceMode: "both",
      speedMultiplier: s1.units["chunk-0"].activeRescue!.targetSpeed,
      grade: 3,
      pitchAccuracy: 0.96,
      stallDetected: false,
      interiorHesitationCount: 0,
      junctionHesitationRatio: 1.1,
      dominantHandFaultRatio: { rh: 0, lh: 0 },
      durationMs: 8_000,
      nowMs: 30_000,
    });
    expect(s1.units["chunk-0"].activeRescue?.smoothPassesDone).toBe(1);
    // 1 slip -> still 1 smooth pass preserved
    s1 = recordSchedulerBoutOutcome(s1, {
      chunkId: "chunk-0",
      boutKind: "bridge",
      junction: junction01,
      practiceMode: "both",
      speedMultiplier: s1.units["chunk-0"].activeRescue!.targetSpeed,
      grade: 2,
      pitchAccuracy: 0.9,
      stallDetected: false,
      interiorHesitationCount: 1,
      junctionHesitationRatio: 1.2,
      dominantHandFaultRatio: { rh: 1, lh: 0 },
      durationMs: 8_000,
      nowMs: 38_000,
    });
    expect(s1.units["chunk-0"].activeRescue?.smoothPassesDone).toBe(1);
    // 2nd smooth pass -> exits bridge cleanly!
    s1 = recordSchedulerBoutOutcome(s1, {
      chunkId: "chunk-0",
      boutKind: "bridge",
      junction: junction01,
      practiceMode: "both",
      speedMultiplier: s1.units["chunk-0"].activeRescue!.targetSpeed,
      grade: 3,
      pitchAccuracy: 1,
      stallDetected: false,
      interiorHesitationCount: 0,
      junctionHesitationRatio: 1.0,
      dominantHandFaultRatio: { rh: 0, lh: 0 },
      durationMs: 8_000,
      nowMs: 46_000,
    });
    expect(s1.units["chunk-0"].activeRescue).toBeNull();

    // Priority 2: Both Hands with >=75% single-hand faults (no boundary fault) -> brief single-hand isolation <=0.75x & -12% return
    let s2 = createMotorSchedulerState({
      plan,
      chunks,
      junctions: [],
      passageClusters: [],
      piecePracticeState: null,
      manualPracticeMode: "both",
      startedAtMs: 0,
    });
    s2.units["chunk-0"].phase = 1;
    s2.units["chunk-0"].workingSpeed = 0.85;
    for (let i = 0; i < 2; i++) {
      s2 = recordSchedulerBoutOutcome(s2, {
        chunkId: "chunk-0",
        boutKind: "chunk",
        practiceMode: "both",
        speedMultiplier: 0.85,
        grade: 1,
        pitchAccuracy: 0.72,
        stallDetected: false,
        interiorHesitationCount: 1,
        junctionHesitationRatio: 1,
        dominantHandFaultRatio: { rh: 0.15, lh: 0.85 },
        durationMs: 10_000,
        nowMs: (i + 1) * 10_000,
      });
    }
    expect(s2.units["chunk-0"].activeRescue?.kind).toBe("single-hand-isolation");
    expect(s2.units["chunk-0"].activeRescue?.isolatedHand).toBe("LH");
    expect(s2.units["chunk-0"].activeRescue!.targetSpeed).toBeLessThanOrEqual(0.75);

    // Complete 1 smooth isolation pass -> returns to Both Hands with -12% compensation
    const isoSpeed = s2.units["chunk-0"].activeRescue!.targetSpeed;
    s2 = recordSchedulerBoutOutcome(s2, {
      chunkId: "chunk-0",
      boutKind: "chunk",
      practiceMode: "lh-only",
      speedMultiplier: isoSpeed,
      grade: 3,
      pitchAccuracy: 0.97,
      stallDetected: false,
      interiorHesitationCount: 0,
      junctionHesitationRatio: 1,
      dominantHandFaultRatio: { rh: 0, lh: 0 },
      durationMs: 12_000,
      nowMs: 32_000,
    });
    expect(s2.units["chunk-0"].activeRescue).toBeNull();
    expect(s2.units["chunk-0"].handMode).toBe("both");
    expect(s2.units["chunk-0"].workingSpeed).toBeCloseTo(0.85 * 0.88, 2);

    // Priority 3: Mixed-hand fault -> -15% speed step-down (floor 0.50x), and C8-skippable
    let s3 = createMotorSchedulerState({
      plan,
      chunks,
      junctions: [],
      passageClusters: [],
      piecePracticeState: null,
      manualPracticeMode: "both",
      startedAtMs: 0,
    });
    s3.units["chunk-0"].phase = 1;
    s3.units["chunk-0"].workingSpeed = 0.8;
    for (let i = 0; i < 2; i++) {
      s3 = recordSchedulerBoutOutcome(s3, {
        chunkId: "chunk-0",
        boutKind: "chunk",
        practiceMode: "both",
        speedMultiplier: 0.8,
        grade: 1,
        pitchAccuracy: 0.7,
        stallDetected: false,
        interiorHesitationCount: 0,
        junctionHesitationRatio: 1,
        dominantHandFaultRatio: { rh: 0.5, lh: 0.5 },
        durationMs: 10_000,
        nowMs: (i + 1) * 10_000,
      });
    }
    expect(s3.units["chunk-0"].workingSpeed).toBeCloseTo(0.68, 2);
    expect(s3.units["chunk-0"].activeRescue?.kind).toBe("speed-step-down");

    // At floor <= 0.55x -> 1-pass Waiting Mode rescue, skippable via C8
    s3 = skipCircuitBreaker(s3, "chunk-0");
    expect(s3.units["chunk-0"].activeRescue).toBeNull();
    s3.units["chunk-0"].workingSpeed = 0.52;
    for (let i = 0; i < 2; i++) {
      s3 = recordSchedulerBoutOutcome(s3, {
        chunkId: "chunk-0",
        boutKind: "chunk",
        practiceMode: "both",
        speedMultiplier: 0.52,
        grade: 1,
        pitchAccuracy: 0.65,
        stallDetected: true,
        interiorHesitationCount: 2,
        junctionHesitationRatio: 1,
        dominantHandFaultRatio: { rh: 0.5, lh: 0.5 },
        durationMs: 10_000,
        nowMs: 40_000 + (i + 1) * 10_000,
      });
    }
    expect(s3.units["chunk-0"].activeRescue?.kind).toBe("waiting-rescue");
    expect(s3.units["chunk-0"].activeRescue?.skippableViaC8).toBe(true);
    s3 = skipCircuitBreaker(s3, "chunk-0");
    expect(s3.units["chunk-0"].activeRescue).toBeNull();
  });

  it("enforces PassageCluster symmetric warm-start (exact >=0.90 skips Stage 0; variant 0.40-0.90 discounted; S capped min(X.S*0.5, 2.0d); SwitchPoint excluded) & anti-entrenchment manual single-hand guard", () => {
    const chunks = [makeChunk(0), makeChunk(1), makeChunk(2)];
    const cluster: PassageCluster = {
      clusterId: "cl-1",
      label: "Theme",
      prototypeInstanceId: "i0",
      leverageRatio: 3,
      totalCoveredMeasures: 6,
      switchPoints: [
        {
          switchId: "sw-2",
          clusterId: "cl-1",
          instanceId: "i2",
          coord: { measureIndex: 5, beatNum: 0, beatDen: 1 },
          measureIndex: 5,
          priorSharedMeasures: 1,
          alternateBranchMidis: [[67]],
          alternateBranchLabels: ["Branch A"],
          description: "Switch",
        },
      ],
      instances: [
        {
          instanceId: "i0",
          clusterId: "cl-1",
          startMeasureIndex: 0,
          endMeasureIndex: 1,
          startCoord: chunks[0].startCoord,
          endCoord: chunks[0].endCoord,
          isPrototype: true,
          transpositionSemitones: 0,
          musicSimilarity: 1,
          fingeringIsomorphism: 1,
          motorReuse: 1,
          variantKind: "exact",
          diffCoords: [],
        },
        {
          instanceId: "i1",
          clusterId: "cl-1",
          startMeasureIndex: 2,
          endMeasureIndex: 3,
          startCoord: chunks[1].startCoord,
          endCoord: chunks[1].endCoord,
          isPrototype: false,
          transpositionSemitones: 0,
          musicSimilarity: 0.96,
          fingeringIsomorphism: 0.95,
          motorReuse: 0.94,
          variantKind: "exact",
          diffCoords: [],
        },
        {
          instanceId: "i2",
          clusterId: "cl-1",
          startMeasureIndex: 4,
          endMeasureIndex: 5,
          startCoord: chunks[2].startCoord,
          endCoord: chunks[2].endCoord,
          isPrototype: false,
          transpositionSemitones: 2,
          musicSimilarity: 0.72,
          fingeringIsomorphism: 0.65,
          motorReuse: 0.62,
          variantKind: "transposed",
          diffCoords: [],
          switchPoint: {
            switchId: "sw-2",
            clusterId: "cl-1",
            instanceId: "i2",
            coord: { measureIndex: 5, beatNum: 0, beatDen: 1 },
            measureIndex: 5,
            priorSharedMeasures: 1,
            alternateBranchMidis: [[67]],
            alternateBranchLabels: ["Branch A"],
            description: "Switch",
          },
        },
      ],
    };

    const pieceState: PiecePracticeState = {
      reducerVersion: 1,
      pieceId: "p-cluster",
      eventCount: 5,
      bestStableSpeed: 0.85,
      layoutSignature: "sig",
      chunkStates: {
        // Non-prototype chunk-1 consolidated first -> symmetric warm-start applies to prototype chunk-0 too!
        "chunk-1": makeUnitState(chunks[1], {
          stableSpeed: 0.85,
          stabilityDays: 6.0,
          sleepConsolidatedNights: 2,
        }),
      },
      junctionStates: {},
    };

    const plan = planGuidedSession({
      timeBoxMinutes: 25,
      macroSections: makeSections(chunks),
      motorChunks: chunks,
      chunkJunctions: [],
      passageClusters: [cluster],
      performanceCues: [],
      piecePracticeState: pieceState,
      selectedMacroSectionId: null,
      nowTimestampMs: 1000,
      nowLocalDateKey: "2026-11-26",
    });

    const state = createMotorSchedulerState({
      plan,
      chunks,
      junctions: [],
      passageClusters: [cluster],
      piecePracticeState: pieceState,
      manualPracticeMode: "both",
      startedAtMs: 1000,
    });

    const warmExact = getClusterWarmStartForChunk(state, "chunk-0");
    expect(warmExact).not.toBeNull();
    expect(warmExact!.skipStage0).toBe(true);
    expect(warmExact!.targetSpeed).toBe(0.85);
    expect(warmExact!.initialStabilityDays).toBe(2.0); // min(6.0 * 0.5, 2.0)

    const warmVariant = getClusterWarmStartForChunk(state, "chunk-2");
    expect(warmVariant).not.toBeNull();
    expect(warmVariant!.skipStage0).toBe(false);
    expect(warmVariant!.targetSpeed).toBeLessThan(0.85);
    expect(warmVariant!.initialStabilityDays).toBe(2.0);
    expect(warmVariant!.switchPointExcluded).toBe(true);

    // Manual single-hand session NEVER advances Both Hands stableSpeed, sleepConsolidatedNights, or Easy eligibility
    let manualHs = createMotorSchedulerState({
      plan,
      chunks,
      junctions: [],
      passageClusters: [cluster],
      piecePracticeState: pieceState,
      manualPracticeMode: "rh-only",
      startedAtMs: 1000,
    });
    const beforeUnit = manualHs.units["chunk-1"];
    manualHs = recordSchedulerBoutOutcome(manualHs, {
      chunkId: "chunk-1",
      boutKind: "chunk",
      practiceMode: "rh-only",
      speedMultiplier: 0.85,
      grade: 4,
      pitchAccuracy: 1,
      stallDetected: false,
      interiorHesitationCount: 0,
      junctionHesitationRatio: 1,
      dominantHandFaultRatio: { rh: 0, lh: 0 },
      durationMs: 15_000,
      nowMs: 16_000,
    });
    expect(manualHs.units["chunk-1"].stableSpeed).toBe(beforeUnit.stableSpeed);
    expect(manualHs.units["chunk-1"].sleepConsolidatedNights).toBe(beforeUnit.sleepConsolidatedNights);
    expect(manualHs.units["chunk-1"].easyEligible).toBe(false);
  });

  it("gates opt-in 1.05x safety probe default OFF and triggers Early Macro-Rest once at 12-15 min ONLY in 25 / 40 min sessions (never 15 min)", () => {
    const chunks = [makeChunk(0), makeChunk(1), makeChunk(2)];
    const consolidated: Record<string, MotorUnitMemoryState> = {
      "chunk-0": makeUnitState(chunks[0], { stableSpeed: 1.0, sleepConsolidatedNights: 2 }),
      "chunk-1": makeUnitState(chunks[1], { stableSpeed: 1.0, sleepConsolidatedNights: 2 }),
      "chunk-2": makeUnitState(chunks[2], { stableSpeed: 1.0, sleepConsolidatedNights: 2 }),
    };
    const pieceState: PiecePracticeState = {
      reducerVersion: 1,
      pieceId: "p-fast",
      eventCount: 12,
      bestStableSpeed: 1.0,
      layoutSignature: "sig",
      chunkStates: consolidated,
      junctionStates: {},
    };

    const plan15 = planGuidedSession({
      timeBoxMinutes: 15,
      macroSections: makeSections(chunks),
      motorChunks: chunks,
      chunkJunctions: [],
      passageClusters: [],
      performanceCues: [],
      piecePracticeState: pieceState,
      selectedMacroSectionId: null,
      nowTimestampMs: 0,
      nowLocalDateKey: "2026-11-26",
    });
    const plan25 = planGuidedSession({
      ...plan15,
      timeBoxMinutes: 25,
      macroSections: makeSections(chunks),
      motorChunks: chunks,
      chunkJunctions: [],
      passageClusters: [],
      performanceCues: [],
      piecePracticeState: pieceState,
      selectedMacroSectionId: null,
      nowTimestampMs: 0,
      nowLocalDateKey: "2026-11-26",
    });

    // Default overspeedProbeEnabled=false caps at 1.00x
    let sDefault = createMotorSchedulerState({
      plan: plan25,
      chunks,
      junctions: [],
      passageClusters: [],
      piecePracticeState: pieceState,
      manualPracticeMode: "both",
      startedAtMs: 0,
    });
    expect(sDefault.overspeedProbeEnabled).toBe(false);
    sDefault = recordSchedulerBoutOutcome(sDefault, {
      chunkId: "chunk-0",
      boutKind: "chunk",
      practiceMode: "both",
      speedMultiplier: 1.0,
      grade: 4,
      pitchAccuracy: 1,
      stallDetected: false,
      interiorHesitationCount: 0,
      junctionHesitationRatio: 1,
      dominantHandFaultRatio: { rh: 0, lh: 0 },
      durationMs: 15_000,
      nowMs: 15_000,
    });
    expect(sDefault.units["chunk-0"].workingSpeed).toBe(1.0);

    // Opt-in overspeedProbeEnabled=true unlocks 1.05x probe for consolidated short chunk
    let sOverspeed = createMotorSchedulerState({
      plan: plan25,
      chunks,
      junctions: [],
      passageClusters: [],
      piecePracticeState: pieceState,
      manualPracticeMode: "both",
      overspeedProbeEnabled: true,
      startedAtMs: 0,
    });
    sOverspeed = recordSchedulerBoutOutcome(sOverspeed, {
      chunkId: "chunk-0",
      boutKind: "chunk",
      practiceMode: "both",
      speedMultiplier: 1.0,
      grade: 4,
      pitchAccuracy: 1,
      stallDetected: false,
      interiorHesitationCount: 0,
      junctionHesitationRatio: 1,
      dominantHandFaultRatio: { rh: 0, lh: 0 },
      durationMs: 15_000,
      nowMs: 15_000,
    });
    expect(sOverspeed.units["chunk-0"].workingSpeed).toBe(1.05);

    // Early Macro-Rest: NEVER triggers in 15 min session
    const s15 = createMotorSchedulerState({
      plan: plan15,
      chunks,
      junctions: [],
      passageClusters: [],
      piecePracticeState: pieceState,
      manualPracticeMode: "both",
      startedAtMs: 0,
    });
    expect(shouldOfferEarlyMacroRest(s15, EARLY_MACRO_REST_MIN_ELAPSED_MS + 60_000)).toBe(false);

    // Early Macro-Rest: Triggers ONCE in 25 min session at >= 12 min elapsed, and is C8-skippable
    expect(shouldOfferEarlyMacroRest(sDefault, EARLY_MACRO_REST_MIN_ELAPSED_MS - 1_000)).toBe(false);
    expect(shouldOfferEarlyMacroRest(sDefault, EARLY_MACRO_REST_MIN_ELAPSED_MS)).toBe(true);
    const sMacro = advanceMotorScheduler(sDefault, EARLY_MACRO_REST_MIN_ELAPSED_MS);
    expect(sMacro.currentDirective.kind).toBe("macro-rest");
    if (sMacro.currentDirective.kind === "macro-rest") {
      expect(sMacro.currentDirective.durationMs).toBe(EARLY_MACRO_REST_DURATION_MS);
      expect(sMacro.currentDirective.skippableViaC8).toBe(true);
    }
    const sAfterSkip = skipEarlyMacroRest(sMacro, EARLY_MACRO_REST_MIN_ELAPSED_MS + 5_000);
    expect(sAfterSkip.earlyMacroRestOffered).toBe(true);
    expect(shouldOfferEarlyMacroRest(sAfterSkip, EARLY_MACRO_REST_MIN_ELAPSED_MS + 120_000)).toBe(false);
  });
});
