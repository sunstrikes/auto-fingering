import { describe, expect, it } from "vitest";
import type {
  ChunkJunction,
  MacroSection,
  MotorChunk,
  PassageCluster,
  PerformanceCue,
} from "../src/chunking/types";
import type { MotorUnitMemoryState, PiecePracticeState } from "../src/guided/motorFsrs";
import {
  planGuidedSession,
  planQuickTriageSession,
  type SessionPlannerInput,
} from "../src/guided/sessionPlanner";

function makeChunk(
  index: number,
  sectionId = "sec-1",
  opts: Partial<MotorChunk> = {},
): MotorChunk {
  const startMeasureIndex = index * 2;
  const endMeasureIndex = startMeasureIndex + 1;
  return {
    chunkId: `chunk-${index}`,
    index,
    sectionId,
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

function makeJunction(
  leftIdx: number,
  rightIdx: number,
  opts: Partial<ChunkJunction> = {},
): ChunkJunction {
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
      d1TransitionHazard: 0.3,
      d2PositionLeapVelocity: 0.2,
      d3BimanualCoupling: 0.2,
      d4HeldFingerLoad: 0.1,
      d5SwitchPointInterference: 0,
      d6EmpiricalPosterior: 0,
    },
    priorRisk: 0.3,
    posteriorRisk: 0.3,
    isHighRisk: false,
    reasonTags: [],
    prepCueLabel: "smooth",
    ...opts,
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
    retrievability: 0.82,
    intervalDays: 2.0,
    nextReviewDateKey: "2026-11-26",
    lastReviewedAtMs: 1_000_000,
    lastEventTimestampMs: 1_000_000,
    lastSleepUpdateTimestampMs: 1_000_000,
    lastSleepGateDateKey: "2026-11-24",
    sleepConsolidatedNights: 1,
    consecutiveAgainDays: 0,
    reviewCount: 2,
    lastEffectiveGrade: 3,
    ...overrides,
  };
}

function makeBaseInput(overrides: Partial<SessionPlannerInput> = {}): SessionPlannerInput {
  const macroSections: MacroSection[] = [
    {
      sectionId: "sec-1",
      index: 0,
      startMeasureIndex: 0,
      endMeasureIndex: 7,
      startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
      endCoord: { measureIndex: 8, beatNum: 0, beatDen: 1 },
      measureCount: 8,
      label: "Section A",
      boundaryReason: "start",
      chunkIds: ["chunk-0", "chunk-1", "chunk-2", "chunk-3"],
    },
    {
      sectionId: "sec-2",
      index: 1,
      startMeasureIndex: 8,
      endMeasureIndex: 15,
      startCoord: { measureIndex: 8, beatNum: 0, beatDen: 1 },
      endCoord: { measureIndex: 16, beatNum: 0, beatDen: 1 },
      measureCount: 8,
      label: "Section B",
      boundaryReason: "double-bar",
      chunkIds: ["chunk-4", "chunk-5", "chunk-6", "chunk-7"],
    },
  ];
  const motorChunks = [
    makeChunk(0, "sec-1"),
    makeChunk(1, "sec-1"),
    makeChunk(2, "sec-1"),
    makeChunk(3, "sec-1"),
    makeChunk(4, "sec-2"),
    makeChunk(5, "sec-2"),
    makeChunk(6, "sec-2"),
    makeChunk(7, "sec-2"),
  ];
  return {
    timeBoxMinutes: 25,
    macroSections,
    motorChunks,
    chunkJunctions: [
      makeJunction(0, 1),
      makeJunction(1, 2, { priorRisk: 0.72, isHighRisk: true, reasonTags: ["wide-leap"] }),
      makeJunction(2, 3),
    ],
    passageClusters: [],
    performanceCues: [],
    piecePracticeState: null,
    selectedMacroSectionId: null,
    nowTimestampMs: 2_000_000,
    nowLocalDateKey: "2026-11-26",
    ...overrides,
  };
}

describe("sessionPlanner", () => {
  it("allocates 3-segment budget (40-50% opening due reviews, 45-55% middle building + fragile junctions, closing retrieval reserve) across 15 / 25 / 40 min", () => {
    const base = makeBaseInput();
    const chunkStates: Record<string, MotorUnitMemoryState> = {
      "chunk-0": makeUnitState(base.motorChunks[0], { retrievability: 0.78 }),
      "chunk-1": makeUnitState(base.motorChunks[1], { retrievability: 0.84 }),
      "chunk-2": makeUnitState(base.motorChunks[2], { retrievability: 0.86 }),
      "chunk-3": makeUnitState(base.motorChunks[3], { retrievability: 0.88 }),
    };
    const piecePracticeState: PiecePracticeState = {
      reducerVersion: 1,
      pieceId: "piece-1",
      eventCount: 8,
      bestStableSpeed: 0.75,
      layoutSignature: "sig",
      chunkStates,
      junctionStates: {},
    };
    const cues: PerformanceCue[] = [
      {
        cueId: "cue-1",
        kind: "structural",
        roles: ["structural"],
        priorityWeight: 1.5,
        coord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
        measureIndex: 0,
        label: "A 主部",
        collapsed: false,
        isPrimary: true,
        sectionId: "sec-1",
      },
      {
        cueId: "cue-2",
        kind: "switch",
        roles: ["switch"],
        priorityWeight: 2.0,
        coord: { measureIndex: 4, beatNum: 0, beatDen: 1 },
        measureIndex: 4,
        label: "Switch 分叉",
        collapsed: false,
        isPrimary: true,
        switchPointId: "sw-1",
      },
    ];

    for (const timeBoxMinutes of [15, 25, 40] as const) {
      const plan = planGuidedSession({
        ...base,
        timeBoxMinutes,
        piecePracticeState,
        performanceCues: cues,
      });

      expect(plan.mode).toBe("standard");
      expect(plan.budgetBreakdown.totalBudgetSec).toBe(timeBoxMinutes * 60);
      expect(plan.budgetBreakdown.openingReviewRatio).toBeGreaterThanOrEqual(0.4);
      expect(plan.budgetBreakdown.openingReviewRatio).toBeLessThanOrEqual(0.5);
      expect(plan.budgetBreakdown.middleBuildRatio).toBeGreaterThanOrEqual(0.45);
      expect(plan.budgetBreakdown.middleBuildRatio).toBeLessThanOrEqual(0.55);
      expect(plan.budgetBreakdown.closingRetrievalRatio).toBeGreaterThan(0);

      expect(plan.openingReviews.length).toBeGreaterThan(0);
      expect(plan.openingReviews.every((i) => i.isColdFirstPass && i.skipStage0)).toBe(true);
      expect(plan.middleItems.some((i) => i.boutKind === "bridge")).toBe(true);
      expect(plan.coldProbeUnlocked).toBe(true);
      expect(plan.closingProbes.length).toBeGreaterThanOrEqual(1);
      expect(plan.closingProbes.length).toBeLessThanOrEqual(4);
      expect(plan.earlyMacroRestEligible).toBe(timeBoxMinutes !== 15);
    }
  });

  it("silently caps 10+ overdue items to top 4-5 by lowest retrievability & junction/SwitchPoint risk with zero red badges", () => {
    const chunks = Array.from({ length: 12 }, (_, idx) => makeChunk(idx, idx < 6 ? "sec-1" : "sec-2"));
    const chunkStates: Record<string, MotorUnitMemoryState> = {};
    for (let i = 0; i < 12; i++) {
      chunkStates[chunks[i].chunkId] = makeUnitState(chunks[i], {
        // chunk-10 & chunk-11 have lowest R; chunk-5 has same R as chunk-6 but has SwitchPoint junction risk
        retrievability:
          i === 11 ? 0.52 : i === 10 ? 0.58 : i === 5 || i === 6 ? 0.65 : 0.72 + i * 0.01,
        nextReviewDateKey: "2026-11-20",
      });
    }
    const junctions: ChunkJunction[] = [
      makeJunction(4, 5, {
        priorRisk: 0.85,
        isHighRisk: true,
        reasonTags: ["switch-point"],
        dimensions: {
          d1TransitionHazard: 0.4,
          d2PositionLeapVelocity: 0.3,
          d3BimanualCoupling: 0.3,
          d4HeldFingerLoad: 0.1,
          d5SwitchPointInterference: 0.9,
          d6EmpiricalPosterior: 0,
        },
      }),
    ];
    const plan = planGuidedSession({
      timeBoxMinutes: 25,
      macroSections: [
        {
          sectionId: "sec-1",
          index: 0,
          startMeasureIndex: 0,
          endMeasureIndex: 11,
          startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
          endCoord: { measureIndex: 12, beatNum: 0, beatDen: 1 },
          measureCount: 12,
          label: "Sec 1",
          boundaryReason: "start",
          chunkIds: chunks.slice(0, 6).map((c) => c.chunkId),
        },
        {
          sectionId: "sec-2",
          index: 1,
          startMeasureIndex: 12,
          endMeasureIndex: 23,
          startCoord: { measureIndex: 12, beatNum: 0, beatDen: 1 },
          endCoord: { measureIndex: 24, beatNum: 0, beatDen: 1 },
          measureCount: 12,
          label: "Sec 2",
          boundaryReason: "double-bar",
          chunkIds: chunks.slice(6).map((c) => c.chunkId),
        },
      ],
      motorChunks: chunks,
      chunkJunctions: junctions,
      passageClusters: [],
      performanceCues: [],
      piecePracticeState: {
        reducerVersion: 1,
        pieceId: "piece-backlog",
        eventCount: 24,
        bestStableSpeed: 0.8,
        layoutSignature: "sig",
        chunkStates,
        junctionStates: {},
      },
      selectedMacroSectionId: null,
      nowTimestampMs: 5_000_000,
      nowLocalDateKey: "2026-11-26",
    });

    expect(plan.overdueTotalCount).toBe(12);
    expect(plan.silentBacklogCapped).toBe(true);
    expect(plan.selectedOverdueCount).toBeGreaterThanOrEqual(4);
    expect(plan.selectedOverdueCount).toBeLessThanOrEqual(5);
    expect(plan.openingReviews.length).toBeLessThanOrEqual(5);
    expect(plan.showOverdueRedBadge).toBe(false);
    // Lowest retrievability (chunk-11, chunk-10) and SwitchPoint-risk chunk-5 prioritized ahead of chunk-6
    const reviewIds = plan.openingReviews.map((i) => i.chunk.chunkId);
    expect(reviewIds[0]).toBe("chunk-11");
    expect(reviewIds[1]).toBe("chunk-10");
    expect(reviewIds).toContain("chunk-5");
    expect(plan.summaryText).not.toMatch(/逾期|积压\s*12|overdue/i);
  });

  it("never places identical units or same-PassageCluster near-variants adjacent in middle building queue", () => {
    const chunks = [
      makeChunk(0, "sec-1"),
      makeChunk(1, "sec-1"),
      makeChunk(2, "sec-1"),
      makeChunk(3, "sec-1"),
    ];
    const cluster: PassageCluster = {
      clusterId: "cluster-a",
      label: "Theme A",
      prototypeInstanceId: "inst-0",
      leverageRatio: 2.0,
      totalCoveredMeasures: 4,
      switchPoints: [],
      instances: [
        {
          instanceId: "inst-0",
          clusterId: "cluster-a",
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
          instanceId: "inst-1",
          clusterId: "cluster-a",
          startMeasureIndex: 2,
          endMeasureIndex: 3,
          startCoord: chunks[1].startCoord,
          endCoord: chunks[1].endCoord,
          isPrototype: false,
          transpositionSemitones: 2,
          musicSimilarity: 0.85,
          fingeringIsomorphism: 0.8,
          motorReuse: 0.72,
          variantKind: "transposed",
          diffCoords: [],
        },
      ],
    };

    const plan = planGuidedSession(
      makeBaseInput({
        motorChunks: chunks,
        chunkJunctions: [],
        passageClusters: [cluster],
      }),
    );

    const chunkSeq = plan.middleItems.filter((i) => i.boutKind === "chunk");
    for (let i = 1; i < chunkSeq.length; i++) {
      expect(chunkSeq[i].chunk.chunkId).not.toBe(chunkSeq[i - 1].chunk.chunkId);
      if (chunkSeq[i].clusterId && chunkSeq[i - 1].clusterId) {
        expect(chunkSeq[i].clusterId).not.toBe(chunkSeq[i - 1].clusterId);
      }
    }
  });

  it("builds Whole-Piece Quick Triage queue covering all chunks in score order without Stage 0 lock", () => {
    const base = makeBaseInput();
    const triage = planQuickTriageSession({
      ...base,
      selectedMacroSectionId: "sec-2",
    });

    expect(triage.mode).toBe("quick-triage");
    expect(triage.items).toHaveLength(base.motorChunks.length);
    expect(triage.items.map((i) => i.chunk.chunkId)).toEqual(
      base.motorChunks.map((c) => c.chunkId),
    );
    expect(triage.items.every((i) => i.skipStage0 && i.segment === "quick-triage")).toBe(true);
  });
});
