import { describe, expect, it } from "vitest";
import type {
  ChunkJunction,
  MacroSection,
  MotorChunk,
  PassageCluster,
  PerformanceCue,
} from "../src/chunking/types";
import type { PlaybackClockAnchor } from "../src/audio/playbackEngine";
import type {
  MeasureTimeline,
  NoteEvent,
  PracticeStep,
  ScoreDocument,
} from "../src/domain/types";
import { attributeContinuousBout } from "../src/guided/boundedAttribution";
import {
  buildColdStartProbeItems,
  computeColdProbeIsCrossDay,
  computeColdProbeSpan,
  evaluateColdStartProbeOutcome,
  isColdProbeLocallyUnlocked,
} from "../src/guided/coldStartProbe";
import {
  EIGHT_HOURS_MS,
  reducePiecePracticeState,
  type MotorUnitMemoryState,
  type PiecePracticeState,
} from "../src/guided/motorFsrs";
import type { MidiInputEvent } from "../src/midi/webMidi";
import type { PracticeEvent } from "../src/persistence/storagePort";

function makeChunks(count = 6): {
  macroSections: MacroSection[];
  motorChunks: MotorChunk[];
  chunkJunctions: ChunkJunction[];
  scoreDoc: ScoreDocument;
  practiceSteps: PracticeStep[];
} {
  // 12 measures (2 measures per chunk)
  const measureCount = count * 2;
  const ticksPerQuarter = 4;
  const ticksPerMeasure = 16;
  const measureSec = 2.0; // 120 BPM 4/4
  const measureTimelines: MeasureTimeline[] = [];
  const noteEvents: NoteEvent[] = [];
  const practiceSteps: PracticeStep[] = [];

  for (let m = 0; m < measureCount; m++) {
    measureTimelines.push({
      measureIndex: m,
      startTick: m * ticksPerMeasure,
      endTick: (m + 1) * ticksPerMeasure,
      startSec: m * measureSec,
      endSec: (m + 1) * measureSec,
      timeBeats: 4,
      timeBeatType: 4,
      isPickup: false,
    });

    for (let b = 0; b < 4; b++) {
      const idx = m * 4 + b;
      const midi = 60 + ((m + b) % 7);
      const onsetTick = m * ticksPerMeasure + b * 4;
      const onsetSec = m * measureSec + b * 0.5;
      const note: NoteEvent = {
        noteUid: `n-${idx}`,
        measureIndex: m,
        staff: 1,
        voice: "1",
        hand: "RH",
        midi,
        onsetTick,
        durationTick: 4,
        onsetSec,
        durationSec: 0.5,
        isGrace: false,
        isTieStart: false,
        isTieStop: false,
        scoreCoord: { measureIndex: m, beatNum: b, beatDen: 1 },
      };
      noteEvents.push(note);
      practiceSteps.push({
        stepIndex: idx,
        measureIndex: m,
        onsetTick,
        onsetSec,
        expectedDurationSec: 0.5,
        isGrace: false,
        expectedMidis: [midi],
        expectedNotes: [note],
        accompanimentNotes: [],
        primarySliceId: `s-${idx}`,
      });
    }
  }

  const motorChunks: MotorChunk[] = Array.from({ length: count }, (_, i) => ({
    chunkId: `chunk-${i}`,
    index: i,
    sectionId: i < 3 ? "sec-0" : "sec-1",
    startMeasureIndex: i * 2,
    endMeasureIndex: i * 2 + 1,
    startCoord: { measureIndex: i * 2, beatNum: 0, beatDen: 1 },
    endCoord: { measureIndex: i * 2 + 2, beatNum: 0, beatDen: 1 },
    measureCount: 2,
    stepCount: 8,
    densityStepsPerMeasure: 4,
    hasAnacrusisLeadIn: false,
    anacrusisBeats: 0,
    overlapFlag: false,
    boundaryConfidence: 0.9,
  }));

  const macroSections: MacroSection[] = [
    {
      sectionId: "sec-0",
      index: 0,
      startMeasureIndex: 0,
      endMeasureIndex: 5,
      startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
      endCoord: { measureIndex: 6, beatNum: 0, beatDen: 1 },
      measureCount: 6,
      label: "Section A",
      boundaryReason: "start",
      chunkIds: ["chunk-0", "chunk-1", "chunk-2"],
    },
    {
      sectionId: "sec-1",
      index: 1,
      startMeasureIndex: 6,
      endMeasureIndex: 11,
      startCoord: { measureIndex: 6, beatNum: 0, beatDen: 1 },
      endCoord: { measureIndex: 12, beatNum: 0, beatDen: 1 },
      measureCount: 6,
      label: "Section B",
      boundaryReason: "double-bar",
      chunkIds: ["chunk-3", "chunk-4", "chunk-5"],
    },
  ];

  const chunkJunctions: ChunkJunction[] = Array.from({ length: count - 1 }, (_, i) => {
    const m = (i + 1) * 2;
    return {
      junctionId: `junc-${i}-${i + 1}`,
      leftChunkId: `chunk-${i}`,
      rightChunkId: `chunk-${i + 1}`,
      boundaryCoord: { measureIndex: m, beatNum: 0, beatDen: 1 },
      measureIndex: m,
      bridgeWindowSteps: {
        startStepIndex: m * 4 - 2,
        endStepIndex: m * 4 + 2,
        junctionStepIndex: m * 4,
      },
      dimensions: {
        d1TransitionHazard: 0.4,
        d2PositionLeapVelocity: 0.3,
        d3BimanualCoupling: 0.2,
        d4HeldFingerLoad: 0.1,
        d5SwitchPointInterference: i === 0 ? 0.85 : 0,
        d6EmpiricalPosterior: 0,
      },
      priorRisk: i === 0 ? 0.78 : 0.35,
      posteriorRisk: i === 0 ? 0.78 : 0.35,
      isHighRisk: i === 0,
      reasonTags: i === 0 ? ["switch-point"] : [],
      prepCueLabel: i === 0 ? "m.3 Switch 分叉" : "平滑过渡",
    };
  });

  const scoreDoc = {
    xmlString: "<score-partwise/>",
    xmlDoc: null as unknown as Document,
    title: "Cold Probe Test",
    ticksPerQuarter,
    measureCount,
    noteEvents,
    onsetSlices: [],
    measureTimelines,
    tempoPoints: [{ tick: 0, bpm: 120 }],
    timeSignaturePoints: [{ tick: 0, beats: 4, beatType: 4 }],
    pedalIntervals: [],
    hasUnresolvedConflicts: false,
    warnings: [],
    diagnostics: [],
  } as unknown as ScoreDocument;

  return { macroSections, motorChunks, chunkJunctions, scoreDoc, practiceSteps };
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
    stableSpeed: 0.8,
    targetSpeed: 1.0,
    difficulty: 5,
    stabilityDays: 2.0,
    retrievability: 0.9,
    intervalDays: 2.0,
    lastReviewedAtMs: 1_000_000,
    lastEventTimestampMs: 1_000_000,
    lastSleepUpdateTimestampMs: 1_000_000,
    lastSleepGateDateKey: "2026-11-26",
    sleepConsolidatedNights: 1,
    consecutiveAgainDays: 0,
    reviewCount: 1,
    lastEffectiveGrade: 3,
    ...overrides,
  };
}

describe("coldStartProbe", () => {
  it("unlocks locally ONLY once >= 1 MacroSection OR >= 3 contiguous MotorChunks finish Stage 0 + initial linking (never during early decoding)", () => {
    const { macroSections, motorChunks } = makeChunks(6);

    // 0 chunks finished -> locked
    expect(
      isColdProbeLocallyUnlocked({
        macroSections,
        motorChunks,
        piecePracticeState: null,
      }),
    ).toBe(false);

    // Only 2 chunks in sec-0 (3-chunk section) -> still locked
    expect(
      isColdProbeLocallyUnlocked({
        macroSections,
        motorChunks,
        piecePracticeState: null,
        inSessionCompletedChunkIds: new Set(["chunk-0", "chunk-1"]),
      }),
    ).toBe(false);

    // Non-contiguous 3 chunks (0, 2, 4) without completing any MacroSection -> still locked
    expect(
      isColdProbeLocallyUnlocked({
        macroSections,
        motorChunks,
        piecePracticeState: null,
        inSessionCompletedChunkIds: new Set(["chunk-0", "chunk-2", "chunk-4"]),
      }),
    ).toBe(false);

    // 3 contiguous chunks spanning across sections (chunk-2, chunk-3, chunk-4) -> unlocked!
    expect(
      isColdProbeLocallyUnlocked({
        macroSections,
        motorChunks,
        piecePracticeState: null,
        inSessionCompletedChunkIds: new Set(["chunk-2", "chunk-3", "chunk-4"]),
      }),
    ).toBe(true);

    // Full MacroSection sec-0 finished in persisted PiecePracticeState -> unlocked!
    const piecePracticeState: PiecePracticeState = {
      reducerVersion: 1,
      pieceId: "p1",
      eventCount: 3,
      bestStableSpeed: 0.75,
      layoutSignature: "sig",
      chunkStates: {
        "chunk-0": makeUnitState(motorChunks[0]),
        "chunk-1": makeUnitState(motorChunks[1]),
        "chunk-2": makeUnitState(motorChunks[2]),
      },
      junctionStates: {},
    };
    expect(
      isColdProbeLocallyUnlocked({
        macroSections,
        motorChunks,
        piecePracticeState,
      }),
    ).toBe(true);
  });

  it("computes 1-measure Count-In, span to next cue or 2-4 measures (>= 2 measures past SwitchPoint), and always-available manual drill items", () => {
    const { macroSections, motorChunks, scoreDoc, practiceSteps } = makeChunks(6);
    const cues: PerformanceCue[] = [
      {
        cueId: "cue-struct-0",
        kind: "structural",
        roles: ["structural"],
        priorityWeight: 1.5,
        coord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
        measureIndex: 0,
        label: "A 主部",
        collapsed: false,
        isPrimary: true,
        sectionId: "sec-0",
      },
      {
        cueId: "cue-switch-2",
        kind: "switch",
        roles: ["switch"],
        priorityWeight: 2.0,
        coord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
        measureIndex: 2,
        label: "Switch 分叉",
        collapsed: false,
        isPrimary: true,
        switchPointId: "sw-1",
      },
      {
        cueId: "cue-tech-3",
        kind: "technical",
        roles: ["technical"],
        priorityWeight: 1.0,
        coord: { measureIndex: 3, beatNum: 0, beatDen: 1 },
        measureIndex: 3,
        label: "技术拐点",
        collapsed: false,
        isPrimary: true,
      },
      {
        cueId: "cue-struct-6",
        kind: "structural",
        roles: ["structural"],
        priorityWeight: 1.5,
        coord: { measureIndex: 6, beatNum: 0, beatDen: 1 },
        measureIndex: 6,
        label: "B 段",
        collapsed: false,
        isPrimary: true,
        sectionId: "sec-1",
      },
    ];

    const cluster: PassageCluster = {
      clusterId: "cl-1",
      label: "Theme",
      prototypeInstanceId: "i0",
      leverageRatio: 2,
      totalCoveredMeasures: 4,
      switchPoints: [
        {
          switchId: "sw-1",
          clusterId: "cl-1",
          instanceId: "i0",
          coord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
          measureIndex: 2,
          priorSharedMeasures: 2,
          alternateBranchMidis: [[72], [74]],
          alternateBranchLabels: ["Branch B"],
          description: "Switch to B",
        },
      ],
      instances: [
        {
          instanceId: "i0",
          clusterId: "cl-1",
          startMeasureIndex: 0,
          endMeasureIndex: 3,
          startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
          endCoord: { measureIndex: 4, beatNum: 0, beatDen: 1 },
          isPrototype: true,
          transpositionSemitones: 0,
          musicSimilarity: 1,
          fingeringIsomorphism: 1,
          motorReuse: 1,
          variantKind: "exact",
          diffCoords: [],
          switchPoint: {
            switchId: "sw-1",
            clusterId: "cl-1",
            instanceId: "i0",
            coord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
            measureIndex: 2,
            priorSharedMeasures: 2,
            alternateBranchMidis: [[72], [74]],
            alternateBranchLabels: ["Branch B"],
            description: "Switch to B",
          },
        },
      ],
    };

    // SwitchPoint cue at measure 2 MUST span >= 2 measures past SwitchPoint (endCoord.measureIndex >= 5) even though next cue is at measure 3!
    const switchSpan = computeColdProbeSpan({
      cue: cues[1],
      allCues: cues,
      motorChunks,
      passageClusters: [cluster],
      scoreDoc,
      practiceSteps,
    });
    expect(switchSpan.countInBeats).toBe(4); // 1-measure Count-In (4/4)
    expect(switchSpan.endCoord.measureIndex).toBeGreaterThanOrEqual(5);
    expect(switchSpan.switchPointSpec).toBeDefined();

    // Structural cue at measure 6 with no nearby nextCue spans 2-4 measures
    const structSpan = computeColdProbeSpan({
      cue: cues[3],
      allCues: cues,
      motorChunks,
      passageClusters: [cluster],
      scoreDoc,
      practiceSteps,
    });
    expect(structSpan.endCoord.measureIndex - structSpan.cue.measureIndex).toBeGreaterThanOrEqual(2);
    expect(structSpan.endCoord.measureIndex - structSpan.cue.measureIndex).toBeLessThanOrEqual(4);

    // Manual drill works even before unlock and even if performanceCues is empty
    const manualItems = buildColdStartProbeItems({
      macroSections,
      motorChunks,
      performanceCues: [],
      passageClusters: [],
      piecePracticeState: null,
      nowTimestampMs: 1000,
      nowLocalDateKey: "2026-11-26",
      manualMode: true,
    });
    expect(manualItems.length).toBeGreaterThanOrEqual(1);
    expect(manualItems.every((i) => i.boutKind === "cold-probe")).toBe(true);
  });

  it("applies gentle pass criteria, offers 1 immediate A0 retry or C8 log-and-continue on fail, and flags SwitchPoint mismatch -> auto-queues Bridge Window", () => {
    const { chunkJunctions, scoreDoc, practiceSteps } = makeChunks(6);
    const cue: PerformanceCue = {
      cueId: "cue-switch-2",
      kind: "switch",
      roles: ["switch"],
      priorityWeight: 2.0,
      coord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
      measureIndex: 2,
      label: "Switch 分叉",
      collapsed: false,
      isPrimary: true,
      switchPointId: "sw-1",
    };

    const probeSteps = practiceSteps.filter((s) => s.measureIndex >= 2 && s.measureIndex <= 4);
    const startScoreSec = probeSteps[0].onsetSec;
    const endScoreSec = probeSteps[probeSteps.length - 1].onsetSec + 0.5;
    const clockAnchor: PlaybackClockAnchor = {
      t0PerfMs: 5000,
      audioStartTimeSec: 0,
      startScoreSec,
      endScoreSec,
      speedMultiplier: 1.0,
    };

    // 1. Clean pass with 300ms entry latency (<= 1 beat 500ms & <= 0.6s) -> PASS
    const cleanMidi: MidiInputEvent[] = probeSteps.map((s) => ({
      type: "noteon",
      midi: s.expectedMidis[0],
      velocity: 85,
      channel: 0,
      portId: "sim",
      source: "midi",
      timeStampMs: 5000 + (s.onsetSec - startScoreSec) * 1000 + 80,
    }));
    const cleanAttr = attributeContinuousBout({
      clockAnchor,
      expectedSteps: probeSteps,
      midiEvents: cleanMidi,
      measureTimelines: scoreDoc.measureTimelines,
    });
    const cleanEval = evaluateColdStartProbeOutcome({
      attribution: cleanAttr,
      clockAnchor,
      expectedSteps: probeSteps,
      midiEvents: cleanMidi,
      measureTimelines: scoreDoc.measureTimelines,
      cue,
      chunkJunctions,
      retriesUsed: 0,
    });
    expect(cleanEval.passed).toBe(true);
    expect(cleanEval.branchDivergenceDetected).toBe(false);

    // 2. Entry hesitation > 0.6s & > 1 beat -> FAIL with 1 A0 retry & C8 continue
    const lateMidi: MidiInputEvent[] = probeSteps.map((s) => ({
      type: "noteon",
      midi: s.expectedMidis[0],
      velocity: 85,
      channel: 0,
      portId: "sim",
      source: "midi",
      timeStampMs: 5000 + (s.onsetSec - startScoreSec) * 1000 + 850,
    }));
    const lateAttr = attributeContinuousBout({
      clockAnchor,
      expectedSteps: probeSteps,
      midiEvents: lateMidi,
      measureTimelines: scoreDoc.measureTimelines,
    });
    const lateEval = evaluateColdStartProbeOutcome({
      attribution: lateAttr,
      clockAnchor,
      expectedSteps: probeSteps,
      midiEvents: lateMidi,
      measureTimelines: scoreDoc.measureTimelines,
      cue,
      chunkJunctions,
      retriesUsed: 0,
    });
    expect(lateEval.passed).toBe(false);
    expect(lateEval.canRetryA0).toBe(true);
    expect(lateEval.canContinueC8).toBe(true);

    // After 1 retry already used -> A0 retry exhausted, C8 still available (never locks)
    const retryExhaustedEval = evaluateColdStartProbeOutcome({
      attribution: lateAttr,
      clockAnchor,
      expectedSteps: probeSteps,
      midiEvents: lateMidi,
      measureTimelines: scoreDoc.measureTimelines,
      cue,
      chunkJunctions,
      retriesUsed: 1,
    });
    expect(retryExhaustedEval.canRetryA0).toBe(false);
    expect(retryExhaustedEval.canContinueC8).toBe(true);

    // 3. SwitchPoint alternate-branch mismatch -> flags branch divergence & auto-queues junction for Bridge Window!
    const altBranchNotes = [77, 79, 81, 83];
    const mismatchMidi: MidiInputEvent[] = probeSteps.map((s, idx) => ({
      type: "noteon",
      midi: idx >= 2 ? altBranchNotes[(idx - 2) % altBranchNotes.length] : s.expectedMidis[0],
      velocity: 85,
      channel: 0,
      portId: "sim",
      source: "midi",
      timeStampMs: 5000 + (s.onsetSec - startScoreSec) * 1000 + 20,
    }));
    const mismatchAttr = attributeContinuousBout({
      clockAnchor,
      expectedSteps: probeSteps,
      midiEvents: mismatchMidi,
      measureTimelines: scoreDoc.measureTimelines,
      switchPoint: {
        startStepIndex: 2,
        alternateBranches: [{ branchId: "alt", stepMidis: [[77], [79]] }],
      },
    });
    expect(mismatchAttr.fluency.switchBranchMismatch).toBe(true);

    const mismatchEval = evaluateColdStartProbeOutcome({
      attribution: mismatchAttr,
      clockAnchor,
      expectedSteps: probeSteps,
      midiEvents: mismatchMidi,
      measureTimelines: scoreDoc.measureTimelines,
      cue,
      chunkJunctions,
      retriesUsed: 0,
    });
    expect(mismatchEval.passed).toBe(false);
    expect(mismatchEval.branchDivergenceDetected).toBe(true);
    expect(mismatchEval.queuedBridgeJunction?.junctionId).toBe("junc-0-1");
  });

  it("same-day cold-start probe does NOT inflate S, while cross-day probe sets wasColdFirstPass=true and updates Motor-FSRS", () => {
    const { motorChunks } = makeChunks(2);
    const day1Ts = Date.UTC(2026, 10, 26, 10, 0, 0);
    const sameDayTs = day1Ts + 2 * 60 * 60 * 1000;
    const day2Ts = day1Ts + 24 * 60 * 60 * 1000;

    const unit = makeUnitState(motorChunks[0], {
      stabilityDays: 1.5,
      lastReviewedAtMs: day1Ts,
      lastEventTimestampMs: day1Ts,
      lastSleepUpdateTimestampMs: day1Ts,
      lastSleepGateDateKey: "2026-11-26",
    });

    expect(computeColdProbeIsCrossDay(unit, sameDayTs, "2026-11-26")).toBe(false);
    expect(computeColdProbeIsCrossDay(unit, day1Ts + EIGHT_HOURS_MS, "2026-11-26")).toBe(false);
    expect(computeColdProbeIsCrossDay(unit, day2Ts, "2026-11-27")).toBe(true);

    const day1ChunkEvent: PracticeEvent = {
      eventId: "ev-1",
      pieceId: "p1",
      scoreFingerprint: "fp1",
      timestampMs: day1Ts,
      localDateKey: "2026-11-26",
      timezoneOffsetMin: 0,
      sessionId: "s1",
      boutKind: "chunk",
      startCoord: motorChunks[0].startCoord,
      endCoord: motorChunks[0].endCoord,
      practiceMode: "both",
      speedMultiplier: 0.8,
      durationSec: 10,
      passCount: 1,
      wasColdFirstPass: false,
      scaffoldingLevel: 1,
      autoGrade: 3,
      fluency: {
        pitchAccuracy: 0.98,
        interiorHesitationCount: 0,
        junctionHesitationRatio: 1,
        timingCv: 0.05,
        stallDetected: false,
        dominantHandFaultRatio: { rh: 0, lh: 0 },
        switchBranchMismatch: false,
        reanchorCount: 0,
      },
      measureFaultCounts: {},
    };

    const sameDayProbeEvent: PracticeEvent = {
      ...day1ChunkEvent,
      eventId: "ev-same-day-probe",
      timestampMs: sameDayTs,
      boutKind: "cold-probe",
      cueCoord: motorChunks[0].startCoord,
      wasColdFirstPass: false,
    };

    const afterSameDay = reducePiecePracticeState([day1ChunkEvent, sameDayProbeEvent], {
      pieceId: "p1",
      chunks: motorChunks,
      nowTimestampMs: sameDayTs,
      nowLocalDateKey: "2026-11-26",
    });
    expect(afterSameDay.chunkStates["chunk-0"].stabilityDays).toBe(1.5);

    const crossDayProbeEvent: PracticeEvent = {
      ...day1ChunkEvent,
      eventId: "ev-day2-probe",
      timestampMs: day2Ts,
      localDateKey: "2026-11-27",
      boutKind: "cold-probe",
      cueCoord: motorChunks[0].startCoord,
      wasColdFirstPass: true,
    };

    const afterCrossDay = reducePiecePracticeState([day1ChunkEvent, crossDayProbeEvent], {
      pieceId: "p1",
      chunks: motorChunks,
      nowTimestampMs: day2Ts,
      nowLocalDateKey: "2026-11-27",
    });
    expect(afterCrossDay.chunkStates["chunk-0"].stabilityDays).toBeGreaterThan(1.5);
    expect(afterCrossDay.chunkStates["chunk-0"].sleepConsolidatedNights).toBe(1);
  });
});
