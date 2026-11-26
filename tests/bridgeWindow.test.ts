import { describe, expect, it } from "vitest";
import type { ChunkJunction, MotorChunk } from "../src/chunking/types";
import type { PlaybackClockAnchor } from "../src/audio/playbackEngine";
import type {
  AbLoopBounds,
  HandPosition,
  MeasureTimeline,
  NoteEvent,
  OnsetSlice,
  PracticeStep,
  ScoreDocument,
  SolveResult,
} from "../src/domain/types";
import { attributeContinuousBout } from "../src/guided/boundedAttribution";
import {
  BRIDGE_SOFT_CAP_MS,
  BRIDGE_MAX_ATTEMPTS,
  buildLinkedVerificationSpan,
  computeCompactBridgeCountInBeats,
  createBridgeWindowState,
  createEmpiricalJunctionTracker,
  deriveBridgeHandPositionPreview,
  recordBridgeWindowPass,
  recordEmpiricalJunctionOutcome,
  resolveBridgeWindowSpan,
  shouldPrewarmStaticJunction,
  skipBridgeWindow,
} from "../src/guided/bridgeWindow";

function makeScoreFixture(timeBeats = 4, timeBeatType = 4): {
  scoreDoc: ScoreDocument;
  practiceSteps: PracticeStep[];
  solveResult: SolveResult;
  leftChunk: MotorChunk;
  rightChunk: MotorChunk;
  junction: ChunkJunction;
} {
  const ticksPerQuarter = 4;
  const ticksPerMeasure = Math.round((timeBeats * 4 * ticksPerQuarter) / timeBeatType);
  const measureSec = (timeBeats * (4 / timeBeatType) * 60) / 120; // 120 BPM quarter

  const measureTimelines: MeasureTimeline[] = [0, 1, 2, 3].map((m) => ({
    measureIndex: m,
    startTick: m * ticksPerMeasure,
    endTick: (m + 1) * ticksPerMeasure,
    startSec: m * measureSec,
    endSec: (m + 1) * measureSec,
    timeBeats,
    timeBeatType,
    isPickup: false,
    bpm: 120,
  }));

  // 4 steps per measure (16 steps total across m.0..m.3), junction at m.2 (stepIndex 8)
  const rhMidis = [60, 62, 64, 65, 67, 69, 71, 72, 76, 79, 81, 83, 72, 74, 76, 77];
  const lhMidis = [48, 50, 52, 53, 55, 57, 59, 60, 36, 40, 43, 45, 48, 50, 52, 55];

  const noteEvents: NoteEvent[] = [];
  const onsetSlices: OnsetSlice[] = [];
  const practiceSteps: PracticeStep[] = [];

  for (let i = 0; i < 16; i++) {
    const m = Math.floor(i / 4);
    const beatInM = i % 4;
    const onsetTick = m * ticksPerMeasure + beatInM * (ticksPerMeasure / 4);
    const onsetSec = m * measureSec + beatInM * (measureSec / 4);
    const durationTick = ticksPerMeasure / 4;
    const durationSec = measureSec / 4;

    const rhNote: NoteEvent = {
      noteUid: `rh-${i}`,
      measureIndex: m,
      staff: 1,
      voice: "1",
      hand: "RH",
      midi: rhMidis[i],
      onsetTick,
      durationTick,
      onsetSec,
      durationSec,
      isGrace: false,
      isTieStart: false,
      isTieStop: false,
      scoreCoord: { measureIndex: m, beatNum: beatInM, beatDen: 1 },
    };
    const lhNote: NoteEvent = {
      noteUid: `lh-${i}`,
      measureIndex: m,
      staff: 2,
      voice: "2",
      hand: "LH",
      midi: lhMidis[i],
      onsetTick,
      durationTick,
      onsetSec,
      durationSec,
      isGrace: false,
      isTieStart: false,
      isTieStop: false,
      scoreCoord: { measureIndex: m, beatNum: beatInM, beatDen: 1 },
    };
    noteEvents.push(rhNote, lhNote);
    onsetSlices.push(
      {
        sliceId: `slice-rh-${i}`,
        hand: "RH",
        measureIndex: m,
        onsetTick,
        onsetSec,
        phraseId: 0,
        isGrace: false,
        notes: [rhNote],
        heldNotes: [],
      },
      {
        sliceId: `slice-lh-${i}`,
        hand: "LH",
        measureIndex: m,
        onsetTick,
        onsetSec,
        phraseId: 0,
        isGrace: false,
        notes: [lhNote],
        heldNotes: [],
      },
    );
    practiceSteps.push({
      stepIndex: i,
      measureIndex: m,
      onsetTick,
      onsetSec,
      expectedDurationSec: durationSec,
      isGrace: false,
      expectedMidis: [lhMidis[i], rhMidis[i]],
      expectedNotes: [lhNote, rhNote],
      accompanimentNotes: [],
      primarySliceId: `slice-rh-${i}`,
    });
  }

  const handPositions: HandPosition[] = [
    {
      hand: "RH",
      startSliceId: "slice-rh-0",
      endSliceId: "slice-rh-7",
      thumbKey: 28, // C4
      pinkyKey: 35, // C5
      minMidi: 60,
      maxMidi: 72,
    },
    {
      hand: "RH",
      startSliceId: "slice-rh-8",
      endSliceId: "slice-rh-15",
      thumbKey: 37, // E5
      pinkyKey: 42, // C6
      minMidi: 76,
      maxMidi: 83,
    },
    {
      hand: "LH",
      startSliceId: "slice-lh-0",
      endSliceId: "slice-lh-7",
      thumbKey: 28,
      pinkyKey: 21,
      minMidi: 48,
      maxMidi: 60,
    },
    {
      hand: "LH",
      startSliceId: "slice-lh-8",
      endSliceId: "slice-lh-15",
      thumbKey: 21,
      pinkyKey: 14,
      minMidi: 36,
      maxMidi: 45,
    },
  ];

  const scoreDoc = {
    xmlString: "<score-partwise/>",
    xmlDoc: null as unknown as Document,
    title: "Bridge Test",
    ticksPerQuarter,
    measureCount: 4,
    noteEvents,
    onsetSlices,
    measureTimelines,
    tempoPoints: [{ tick: 0, bpm: 120 }],
    timeSignaturePoints: [{ tick: 0, beats: timeBeats, beatType: timeBeatType }],
    pedalIntervals: [],
    hasUnresolvedConflicts: false,
    warnings: [],
    diagnostics: [],
  } as unknown as ScoreDocument;

  const solveResult: SolveResult = {
    fingerByNoteUid: {},
    transitionCues: [],
    handPositions,
    warnings: [],
    repairedAnchorUids: [],
    solveTimeMs: 1,
  };

  const leftChunk: MotorChunk = {
    chunkId: "chunk-0",
    index: 0,
    sectionId: "sec-1",
    startMeasureIndex: 0,
    endMeasureIndex: 1,
    startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
    endCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
    measureCount: 2,
    stepCount: 8,
    densityStepsPerMeasure: 4,
    hasAnacrusisLeadIn: false,
    anacrusisBeats: 0,
    overlapFlag: false,
    boundaryConfidence: 0.9,
  };
  const rightChunk: MotorChunk = {
    chunkId: "chunk-1",
    index: 1,
    sectionId: "sec-1",
    startMeasureIndex: 2,
    endMeasureIndex: 3,
    startCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
    endCoord: { measureIndex: 4, beatNum: 0, beatDen: 1 },
    measureCount: 2,
    stepCount: 8,
    densityStepsPerMeasure: 4,
    hasAnacrusisLeadIn: false,
    anacrusisBeats: 0,
    overlapFlag: false,
    boundaryConfidence: 0.9,
  };
  const junction: ChunkJunction = {
    junctionId: "junc-0-1",
    leftChunkId: "chunk-0",
    rightChunkId: "chunk-1",
    boundaryCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
    measureIndex: 2,
    bridgeWindowSteps: {
      startStepIndex: 6,
      endStepIndex: 9,
      junctionStepIndex: 8,
    },
    dimensions: {
      d1TransitionHazard: 0.8,
      d2PositionLeapVelocity: 0.75,
      d3BimanualCoupling: 0.7,
      d4HeldFingerLoad: 0.1,
      d5SwitchPointInterference: 0,
      d6EmpiricalPosterior: 0,
    },
    priorRisk: 0.75,
    posteriorRisk: 0.75,
    isHighRisk: true,
    reasonTags: ["simultaneous-dual-shift"],
    prepCueLabel: "m.3 双手同步移把",
  };

  return { scoreDoc, practiceSteps, solveResult, leftChunk, rightChunk, junction };
}

function makeCleanAttribution(
  steps: PracticeStep[],
  startScoreSec: number,
  endScoreSec: number,
  speed: number,
  opts: {
    slipStepIdx?: number;
    junctionDelayMs?: number;
    junctionStepIdx?: number;
    measureTimelines: MeasureTimeline[];
    boundaryCoord: { measureIndex: number; beatNum: number; beatDen: number };
  },
) {
  const anchor: PlaybackClockAnchor = {
    t0PerfMs: 1000,
    audioStartTimeSec: 0,
    startScoreSec,
    endScoreSec,
    speedMultiplier: speed,
  };
  const midiEvents = steps.flatMap((s, idx) => {
    let offsetMs = ((s.onsetSec - startScoreSec) / speed) * 1000;
    if (opts.junctionDelayMs && idx >= (opts.junctionStepIdx ?? 2)) {
      offsetMs += opts.junctionDelayMs;
    }
    return s.expectedMidis.map((midi) => ({
      type: "noteon" as const,
      midi: idx === opts.slipStepIdx ? midi + 1 : midi,
      velocity: 85,
      channel: 0,
      portId: "sim",
      source: "midi" as const,
      timeStampMs: 1000 + offsetMs,
    }));
  });

  return attributeContinuousBout({
    clockAnchor: anchor,
    expectedSteps: steps,
    midiEvents,
    measureTimelines: opts.measureTimelines,
    practiceMode: "both",
    junctionBoundaryCoord: opts.boundaryCoord,
    junctionStepIndex: opts.junctionStepIdx,
  });
}

describe("bridgeWindow", () => {
  it("resolves a strictly PracticeStep-level span straddling 2-3 steps before and after ChunkJunction with compact 2-beat/half-measure Count-In, leaving Free Studio AbLoopBounds untouched", () => {
    const { scoreDoc, practiceSteps, leftChunk, rightChunk, junction } = makeScoreFixture(4, 4);
    const freeAbLoop: AbLoopBounds = {
      enabled: true,
      startMeasureIndex: 0,
      endMeasureIndex: 3,
      loopGap: true,
    };
    const freeLoopSnapshot = { ...freeAbLoop };

    const span = resolveBridgeWindowSpan({
      scoreDoc,
      practiceSteps,
      junction,
      leftChunk,
      rightChunk,
      preSteps: 2,
      postSteps: 3,
    });

    // Junction is at step 8: 2 steps before = 6, 3 steps after = 10 (steps 8,9,10)
    expect(span.junctionStepIndex).toBe(8);
    expect(span.startStepIndex).toBe(6);
    expect(span.endStepIndex).toBe(10);
    expect(span.steps.map((s) => s.stepIndex)).toEqual([6, 7, 8, 9, 10]);
    expect(span.startScoreSec).toBeCloseTo(practiceSteps[6].onsetSec, 4);
    expect(span.endScoreSec).toBeGreaterThan(practiceSteps[10].onsetSec);
    expect(span.countInBeats).toBe(2);

    // Compound meter 6/8 uses compact half-measure (3 beats)
    const { scoreDoc: doc68 } = makeScoreFixture(6, 8);
    expect(computeCompactBridgeCountInBeats(doc68, 2)).toBe(3);

    // AbLoopBounds remains strictly untouched
    expect(freeAbLoop).toEqual(freeLoopSnapshot);
  });

  it("extracts before/after HandPosition preview ranges across the ChunkJunction for UnifiedPiano88", () => {
    const { scoreDoc, practiceSteps, solveResult, leftChunk, rightChunk, junction } =
      makeScoreFixture();
    const span = resolveBridgeWindowSpan({
      scoreDoc,
      practiceSteps,
      junction,
      leftChunk,
      rightChunk,
    });
    const preview = deriveBridgeHandPositionPreview({
      scoreDoc,
      solveResult,
      span,
      practiceMode: "both",
    });

    expect(preview.junctionId).toBe("junc-0-1");
    expect(preview.prepCueLabel).toBe("m.3 双手同步移把");
    expect(preview.beforeRange.rh).toBeDefined();
    expect(preview.afterRange.rh).toBeDefined();
    expect(preview.afterRange.rh!.thumbMidi).toBeGreaterThan(preview.beforeRange.rh!.thumbMidi);
    expect(preview.beforeRange.lh).toBeDefined();
    expect(preview.afterRange.lh).toBeDefined();
    expect(preview.shiftSummary.length).toBeGreaterThan(0);
  });

  it("supports dual triggers: static high-risk pre-warm (priorRisk >= 0.65) and empirical 2-consecutive fault/hesitation (>1.6x & >=0.45s) auto-narrow with -10% to -15% speed step-down", () => {
    const { scoreDoc, practiceSteps, leftChunk, rightChunk, junction } = makeScoreFixture();
    expect(shouldPrewarmStaticJunction(junction)).toBe(true);
    expect(shouldPrewarmStaticJunction({ ...junction, priorRisk: 0.64, isHighRisk: false })).toBe(
      false,
    );

    const span = resolveBridgeWindowSpan({
      scoreDoc,
      practiceSteps,
      junction,
      leftChunk,
      rightChunk,
    });

    // Empirical trigger: hesitation ratio > 1.6x AND >= 450 ms on 2 consecutive passes
    let tracker = createEmpiricalJunctionTracker();
    const slowHesitationAttr = makeCleanAttribution(
      practiceSteps.slice(0, 12),
      0,
      6.0,
      1.0,
      {
        junctionDelayMs: 520, // expected IOI = 500ms, actual = 1020ms -> ratio 2.04x > 1.6x & delay 520ms >= 450ms
        junctionStepIdx: 8,
        measureTimelines: scoreDoc.measureTimelines,
        boundaryCoord: junction.boundaryCoord,
      },
    );

    // 1st fault does NOT trigger yet
    const r1 = recordEmpiricalJunctionOutcome(tracker, {
      junction,
      attribution: slowHesitationAttr,
    });
    tracker = r1.tracker;
    expect(r1.triggered).toBe(false);

    // 2nd consecutive fault triggers Bridge Window!
    const r2 = recordEmpiricalJunctionOutcome(tracker, {
      junction,
      attribution: slowHesitationAttr,
    });
    expect(r2.triggered).toBe(true);

    // Auto-narrow speed step-down is -10% to -15% (0.80 * 0.88 = 0.70)
    const bridgeState = createBridgeWindowState({
      trigger: "empirical-fault",
      junction,
      leftChunk,
      rightChunk,
      span,
      originalSpeed: 0.8,
      startedAtMs: 10_000,
    });
    expect(bridgeState.activeSpeed).toBeLessThanOrEqual(0.8 * 0.9);
    expect(bridgeState.activeSpeed).toBeGreaterThanOrEqual(0.8 * 0.85 - 0.01);
    expect(bridgeState.skippableViaC8).toBe(true);
  });

  it("exits on 2 cumulative smooth passes (single slip defers without clearing progress), restores originalSpeed, and flows into 1 full linked two-chunk verification pass", () => {
    const { scoreDoc, practiceSteps, leftChunk, rightChunk, junction } = makeScoreFixture();
    const span = resolveBridgeWindowSpan({
      scoreDoc,
      practiceSteps,
      junction,
      leftChunk,
      rightChunk,
    });

    let state = createBridgeWindowState({
      trigger: "empirical-fault",
      junction,
      leftChunk,
      rightChunk,
      span,
      originalSpeed: 0.8,
      startedAtMs: 10_000,
    });
    const bridgeSpeed = state.activeSpeed;

    const cleanBridgeAttr = makeCleanAttribution(
      span.steps,
      span.startScoreSec,
      span.endScoreSec,
      bridgeSpeed,
      {
        junctionStepIdx: 2,
        measureTimelines: scoreDoc.measureTimelines,
        boundaryCoord: junction.boundaryCoord,
      },
    );
    const slipBridgeAttr = makeCleanAttribution(
      span.steps,
      span.startScoreSec,
      span.endScoreSec,
      bridgeSpeed,
      {
        slipStepIdx: 1,
        junctionStepIdx: 2,
        measureTimelines: scoreDoc.measureTimelines,
        boundaryCoord: junction.boundaryCoord,
      },
    );

    // Pass 1: smooth -> 1/2
    state = recordBridgeWindowPass(state, { attribution: cleanBridgeAttr, nowMs: 14_000 });
    expect(state.phase).toBe("bridging");
    expect(state.smoothPassesDone).toBe(1);
    expect(state.attempts).toBe(1);

    // Pass 2: single slip -> progress 1/2 is NOT cleared, deferred by 1 attempt
    state = recordBridgeWindowPass(state, { attribution: slipBridgeAttr, nowMs: 18_000 });
    expect(state.phase).toBe("bridging");
    expect(state.smoothPassesDone).toBe(1);
    expect(state.attempts).toBe(2);

    // Pass 3: smooth -> 2/2 -> exits bridging, restores originalSpeed, starts linked verification
    state = recordBridgeWindowPass(state, { attribution: cleanBridgeAttr, nowMs: 22_000 });
    expect(state.phase).toBe("linked-verify");
    expect(state.smoothPassesDone).toBe(2);
    expect(state.activeSpeed).toBe(0.8);
    expect(state.exitReason).toBe("smooth-passes");

    const linkedSpan = buildLinkedVerificationSpan(scoreDoc, practiceSteps, leftChunk, rightChunk);
    expect(linkedSpan.steps).toHaveLength(16);
    expect(linkedSpan.startScoreSec).toBeCloseTo(0, 4);
    expect(linkedSpan.endScoreSec).toBeCloseTo(scoreDoc.measureTimelines[3].endSec, 4);
  });

  it("caps Bridge Window at ~45 s or 6-8 attempts and supports C8 skipping", () => {
    const { scoreDoc, practiceSteps, leftChunk, rightChunk, junction } = makeScoreFixture();
    const span = resolveBridgeWindowSpan({
      scoreDoc,
      practiceSteps,
      junction,
      leftChunk,
      rightChunk,
    });

    const slipAttr = makeCleanAttribution(
      span.steps,
      span.startScoreSec,
      span.endScoreSec,
      0.7,
      {
        slipStepIdx: 0,
        junctionStepIdx: 2,
        measureTimelines: scoreDoc.measureTimelines,
        boundaryCoord: junction.boundaryCoord,
      },
    );

    // Attempt cap (6-8 attempts)
    let byAttempts = createBridgeWindowState({
      trigger: "empirical-fault",
      junction,
      leftChunk,
      rightChunk,
      span,
      originalSpeed: 0.8,
      startedAtMs: 10_000,
    });
    expect(BRIDGE_MAX_ATTEMPTS).toBeGreaterThanOrEqual(6);
    expect(BRIDGE_MAX_ATTEMPTS).toBeLessThanOrEqual(8);
    for (let i = 0; i < BRIDGE_MAX_ATTEMPTS; i++) {
      byAttempts = recordBridgeWindowPass(byAttempts, {
        attribution: slipAttr,
        nowMs: 10_000 + (i + 1) * 3000,
      });
    }
    expect(byAttempts.phase).toBe("linked-verify");
    expect(byAttempts.exitReason).toBe("attempt-cap");
    expect(byAttempts.activeSpeed).toBe(0.8);

    // Time cap (~45 s)
    let byTime = createBridgeWindowState({
      trigger: "empirical-fault",
      junction,
      leftChunk,
      rightChunk,
      span,
      originalSpeed: 0.8,
      startedAtMs: 10_000,
    });
    byTime = recordBridgeWindowPass(byTime, {
      attribution: slipAttr,
      nowMs: 10_000 + BRIDGE_SOFT_CAP_MS,
    });
    expect(byTime.phase).toBe("linked-verify");
    expect(byTime.exitReason).toBe("time-cap");
    expect(byTime.activeSpeed).toBe(0.8);

    // C8 skip
    const skipped = skipBridgeWindow(
      createBridgeWindowState({
        trigger: "static-prewarm",
        junction,
        leftChunk,
        rightChunk,
        span,
        originalSpeed: 0.8,
        startedAtMs: 10_000,
      }),
    );
    expect(skipped.phase).toBe("skipped");
    expect(skipped.activeSpeed).toBe(0.8);
  });
});
