import { describe, expect, it } from "vitest";
import {
  MOTOR_FSRS_REDUCER_VERSION,
  computeAutoMidiGrade,
  computeFsrsRetrievability,
  computeMaintenanceIntervalDays,
  computeNextSpeedStep,
  normalizeUserGradeOverride,
  reducePiecePracticeState,
} from "../src/guided/motorFsrs";
import type { ChunkJunction, MotorChunk } from "../src/chunking/types";
import type { PracticeEvent } from "../src/persistence/storagePort";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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

function makeJunction(
  junctionId: string,
  leftChunk: MotorChunk,
  rightChunk: MotorChunk,
  opts: { priorRisk?: number; switchPoint?: boolean } = {},
): ChunkJunction {
  const priorRisk = opts.priorRisk ?? 0.3;
  return {
    junctionId,
    leftChunkId: leftChunk.chunkId,
    rightChunkId: rightChunk.chunkId,
    boundaryCoord: rightChunk.startCoord,
    measureIndex: rightChunk.startMeasureIndex,
    bridgeWindowSteps: { startStepIndex: 6, endStepIndex: 10, junctionStepIndex: 8 },
    dimensions: {
      d1TransitionHazard: priorRisk,
      d2PositionLeapVelocity: 0.2,
      d3BimanualCoupling: 0.2,
      d4HeldFingerLoad: 0.1,
      d5SwitchPointInterference: opts.switchPoint ? 0.75 : 0,
      d6EmpiricalPosterior: 0,
    },
    priorRisk,
    posteriorRisk: priorRisk,
    isHighRisk: priorRisk >= 0.65,
    reasonTags: opts.switchPoint ? ["switch-point"] : [],
    prepCueLabel: `m.${rightChunk.startMeasureIndex + 1} transition`,
  };
}

function makeEvent(overrides: Partial<PracticeEvent> = {}): PracticeEvent {
  return {
    eventId: overrides.eventId ?? "ev-1",
    pieceId: overrides.pieceId ?? "piece-1",
    scoreFingerprint: overrides.scoreFingerprint ?? "fp-1",
    timestampMs: overrides.timestampMs ?? Date.UTC(2026, 10, 20, 10, 0, 0),
    localDateKey: overrides.localDateKey ?? "2026-11-20",
    timezoneOffsetMin: overrides.timezoneOffsetMin ?? 0,
    sessionId: overrides.sessionId ?? "sess-1",
    boutKind: overrides.boutKind ?? "chunk",
    startCoord: overrides.startCoord ?? { measureIndex: 0, beatNum: 0, beatDen: 1 },
    endCoord: overrides.endCoord ?? { measureIndex: 2, beatNum: 0, beatDen: 1 },
    practiceMode: overrides.practiceMode ?? "both",
    speedMultiplier: overrides.speedMultiplier ?? 0.75,
    durationSec: overrides.durationSec ?? 30,
    passCount: overrides.passCount ?? 1,
    wasColdFirstPass: overrides.wasColdFirstPass ?? true,
    scaffoldingLevel: overrides.scaffoldingLevel ?? 1,
    autoGrade: overrides.autoGrade ?? 3,
    fluency: overrides.fluency ?? {
      pitchAccuracy: 0.98,
      interiorHesitationCount: 0,
      junctionHesitationRatio: 1.0,
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

describe("Motor-FSRS pure deterministic reducer", () => {
  it("exports version 1 and uses FSRS-6 power-law forgetting curve & conservative Day-1 stabilities", () => {
    expect(MOTOR_FSRS_REDUCER_VERSION).toBe(1);
    expect(computeFsrsRetrievability(0, 5)).toBe(1);
    expect(computeFsrsRetrievability(5, 5)).toBeCloseTo(0.9, 6);
    expect(computeFsrsRetrievability(10, 5)).toBeLessThan(0.9);
    expect(computeFsrsRetrievability(10, 5)).toBeGreaterThan(0.75);

    const chunk = makeChunk("c0", 0, 1);
    // Day-1 Easy must NOT jump to FSRS language default 8.3 days; capped conservatively <= 3.5 days
    const easyDay0 = makeEvent({
      eventId: "ev-easy-day0",
      speedMultiplier: 0.9,
      practiceMode: "both",
      autoGrade: 4,
      fluency: {
        pitchAccuracy: 1,
        interiorHesitationCount: 0,
        junctionHesitationRatio: 1,
        timingCv: 0.03,
        stallDetected: false,
        dominantHandFaultRatio: { rh: 0, lh: 0 },
        switchBranchMismatch: false,
        reanchorCount: 0,
      },
    });
    const state = reducePiecePracticeState([easyDay0], {
      pieceId: "piece-1",
      chunks: [chunk],
    });
    const unit = state.chunkStates["c0"];
    expect(unit).toBeDefined();
    expect(unit.stabilityDays).toBeGreaterThanOrEqual(3.0);
    expect(unit.stabilityDays).toBeLessThanOrEqual(3.5);
    expect(unit.sleepConsolidatedNights).toBe(0);
  });

  it("enforces strict sleep gate: same-day and <8h cross-day events never inflate S; >=8h new calendar day Cold First-Pass Probe updates S", () => {
    const chunk = makeChunk("c0", 0, 1);
    const t0 = Date.UTC(2026, 10, 20, 22, 0, 0); // 2026-11-20 22:00

    const e0 = makeEvent({
      eventId: "e0",
      timestampMs: t0,
      localDateKey: "2026-11-20",
      speedMultiplier: 0.75,
      autoGrade: 3,
      wasColdFirstPass: true,
    });
    // Same day, 1 hour later, even Easy-grade performance must NOT inflate S
    const e1SameDay = makeEvent({
      eventId: "e1",
      timestampMs: t0 + HOUR_MS,
      localDateKey: "2026-11-20",
      speedMultiplier: 0.75,
      autoGrade: 4,
      wasColdFirstPass: true,
      fluency: {
        pitchAccuracy: 1,
        interiorHesitationCount: 0,
        junctionHesitationRatio: 1,
        timingCv: 0.02,
        stallDetected: false,
        dominantHandFaultRatio: { rh: 0, lh: 0 },
        switchBranchMismatch: false,
        reanchorCount: 0,
      },
    });
    // Crossed calendar day (2026-11-21 04:00) but only 5h since e1 (< 8h): must NOT inflate S
    const e2ShortNight = makeEvent({
      eventId: "e2",
      timestampMs: t0 + 6 * HOUR_MS,
      localDateKey: "2026-11-21",
      speedMultiplier: 0.75,
      autoGrade: 3,
      wasColdFirstPass: true,
    });

    const blockedState = reducePiecePracticeState([e0, e1SameDay, e2ShortNight], {
      pieceId: "piece-1",
      chunks: [chunk],
    });
    const baseS = blockedState.chunkStates["c0"].stabilityDays;
    expect(baseS).toBeCloseTo(1.5, 4);
    expect(blockedState.chunkStates["c0"].sleepConsolidatedNights).toBe(0);

    // Next morning after >= 8h sleep since last event & new localDateKey ("2026-11-22"), non-cold probe must NOT update S
    const e3Warmup = makeEvent({
      eventId: "e3",
      timestampMs: t0 + 6 * HOUR_MS + 24 * HOUR_MS,
      localDateKey: "2026-11-22",
      speedMultiplier: 0.75,
      autoGrade: 3,
      wasColdFirstPass: false,
    });
    const nonColdState = reducePiecePracticeState([e0, e1SameDay, e2ShortNight, e3Warmup], {
      pieceId: "piece-1",
      chunks: [chunk],
    });
    expect(nonColdState.chunkStates["c0"].stabilityDays).toBeCloseTo(baseS, 4);
    expect(nonColdState.chunkStates["c0"].sleepConsolidatedNights).toBe(0);

    // Genuine Cold First-Pass Probe after >= 8h & new calendar day MUST update S and increment sleepConsolidatedNights
    const e4ColdNextDay = makeEvent({
      eventId: "e4",
      timestampMs: t0 + 30 * HOUR_MS, // 2026-11-22 04:00 (24h after e2)
      localDateKey: "2026-11-22",
      speedMultiplier: 0.75,
      autoGrade: 3,
      wasColdFirstPass: true,
    });
    // Second cold probe on the SAME calendar day (10 hours later on 2026-11-22) must NOT inflate S further
    const e5SameDaySecondProbe = makeEvent({
      eventId: "e5",
      timestampMs: t0 + 40 * HOUR_MS, // 2026-11-22 14:00
      localDateKey: "2026-11-22",
      speedMultiplier: 0.75,
      autoGrade: 3,
      wasColdFirstPass: true,
    });

    const afterSleep = reducePiecePracticeState([e0, e1SameDay, e2ShortNight, e4ColdNextDay], {
      pieceId: "piece-1",
      chunks: [chunk],
    });
    expect(afterSleep.chunkStates["c0"].stabilityDays).toBeGreaterThan(baseS);
    expect(afterSleep.chunkStates["c0"].sleepConsolidatedNights).toBe(1);

    const afterSecondSameDay = reducePiecePracticeState(
      [e0, e1SameDay, e2ShortNight, e4ColdNextDay, e5SameDaySecondProbe],
      { pieceId: "piece-1", chunks: [chunk] },
    );
    expect(afterSecondSameDay.chunkStates["c0"].stabilityDays).toBeCloseTo(
      afterSleep.chunkStates["c0"].stabilityDays,
      6,
    );
    expect(afterSecondSameDay.chunkStates["c0"].sleepConsolidatedNights).toBe(1);
  });

  it("gates automatic MIDI grading strictly (Easy requires both+>=0.85x+0 faults/hesitations) and replays userGradeOverride deterministically", () => {
    const cleanFluency = {
      pitchAccuracy: 1,
      interiorHesitationCount: 0,
      junctionHesitationRatio: 1.0,
      timingCv: 0.04,
      stallDetected: false,
      dominantHandFaultRatio: { rh: 0, lh: 0 },
      switchBranchMismatch: false,
      reanchorCount: 0,
    };

    // Single-hand cannot earn Easy even at 1.0x with 0 faults
    expect(
      computeAutoMidiGrade({
        practiceMode: "rh-only",
        speedMultiplier: 1.0,
        fluency: cleanFluency,
        measureFaultCounts: {},
      }),
    ).toBe(3);

    // Both hands < 0.85x cannot earn Easy
    expect(
      computeAutoMidiGrade({
        practiceMode: "both",
        speedMultiplier: 0.8,
        fluency: cleanFluency,
        measureFaultCounts: {},
      }),
    ).toBe(3);

    // Both hands >= 0.85x with 0 faults/hesitations earns Easy
    expect(
      computeAutoMidiGrade({
        practiceMode: "both",
        speedMultiplier: 0.85,
        fluency: cleanFluency,
        measureFaultCounts: {},
      }),
    ).toBe(4);

    // >= 95% & 0 interior hesitations -> Good
    expect(
      computeAutoMidiGrade({
        practiceMode: "both",
        speedMultiplier: 0.9,
        fluency: { ...cleanFluency, pitchAccuracy: 0.96 },
        measureFaultCounts: { 0: { missed: 1, extra: 0, hesitations: 0 } },
      }),
    ).toBe(3);

    // 85%-95% or interior/junction hesitation -> Hard
    expect(
      computeAutoMidiGrade({
        practiceMode: "both",
        speedMultiplier: 0.9,
        fluency: { ...cleanFluency, pitchAccuracy: 0.88 },
        measureFaultCounts: {},
      }),
    ).toBe(2);
    expect(
      computeAutoMidiGrade({
        practiceMode: "both",
        speedMultiplier: 0.9,
        fluency: { ...cleanFluency, interiorHesitationCount: 1 },
        measureFaultCounts: {},
      }),
    ).toBe(2);

    // < 85% or stall -> Again
    expect(
      computeAutoMidiGrade({
        practiceMode: "both",
        speedMultiplier: 0.9,
        fluency: { ...cleanFluency, pitchAccuracy: 0.84 },
        measureFaultCounts: {},
      }),
    ).toBe(1);
    expect(
      computeAutoMidiGrade({
        practiceMode: "both",
        speedMultiplier: 0.9,
        fluency: { ...cleanFluency, stallDetected: true },
        measureFaultCounts: {},
      }),
    ).toBe(1);

    // userGradeOverride helper mapping ("hard" -> 2) and deterministic replay
    expect(normalizeUserGradeOverride("hard")).toBe(2);
    expect(normalizeUserGradeOverride(2)).toBe(2);

    const chunk = makeChunk("c0", 0, 1);
    const t0 = Date.UTC(2026, 10, 20, 10, 0, 0);
    const base = makeEvent({
      eventId: "e0",
      timestampMs: t0,
      localDateKey: "2026-11-20",
      speedMultiplier: 0.9,
      autoGrade: 3,
    });
    const nextEasy = makeEvent({
      eventId: "e1",
      timestampMs: t0 + DAY_MS,
      localDateKey: "2026-11-21",
      speedMultiplier: 0.9,
      autoGrade: 4,
      fluency: cleanFluency,
    });
    const nextOverriddenHard = { ...nextEasy, userGradeOverride: normalizeUserGradeOverride("hard") };

    const sEasy = reducePiecePracticeState([base, nextEasy], { pieceId: "p1", chunks: [chunk] });
    const sHard = reducePiecePracticeState([base, nextOverriddenHard], { pieceId: "p1", chunks: [chunk] });
    expect(sHard.chunkStates["c0"].stabilityDays).toBeLessThan(sEasy.chunkStates["c0"].stabilityDays);
    expect(sHard.chunkStates["c0"].lastEffectiveGrade).toBe(2);
    expect(sHard.chunkStates["c0"].sleepConsolidatedNights).toBe(0);
  });

  it("discounts S = min(S * 0.5, 2.0) and preserves D on speed and hand-stage upgrades, resetting sleepConsolidatedNights", () => {
    const chunk = makeChunk("c0", 0, 1);
    const t0 = Date.UTC(2026, 10, 10, 10, 0, 0);

    // Start in rh-only at 0.65x, consolidate across several days
    const events: PracticeEvent[] = [
      makeEvent({
        eventId: "e0",
        timestampMs: t0,
        localDateKey: "2026-11-10",
        practiceMode: "rh-only",
        speedMultiplier: 0.65,
        autoGrade: 3,
      }),
      makeEvent({
        eventId: "e1",
        timestampMs: t0 + 2 * DAY_MS,
        localDateKey: "2026-11-12",
        practiceMode: "both",
        speedMultiplier: 0.65,
        autoGrade: 3,
      }),
      makeEvent({
        eventId: "e2",
        timestampMs: t0 + 4 * DAY_MS,
        localDateKey: "2026-11-14",
        practiceMode: "both",
        speedMultiplier: 0.65,
        autoGrade: 3,
      }),
      makeEvent({
        eventId: "e3",
        timestampMs: t0 + 7 * DAY_MS,
        localDateKey: "2026-11-17",
        practiceMode: "both",
        speedMultiplier: 0.65,
        autoGrade: 3,
      }),
    ];

    const preUpgrade = reducePiecePracticeState(events, { pieceId: "p1", chunks: [chunk] }).chunkStates["c0"];
    expect(preUpgrade.handStage).toBe("both");
    expect(preUpgrade.sleepConsolidatedNights).toBe(2);
    expect(preUpgrade.stabilityDays).toBeGreaterThan(4.0);

    // Speed upgrade 0.65x -> 0.72x
    const upgradeEvent = makeEvent({
      eventId: "e4",
      timestampMs: t0 + 7 * DAY_MS + 10 * 60_000,
      localDateKey: "2026-11-17",
      practiceMode: "both",
      speedMultiplier: 0.72,
      autoGrade: 3,
      wasColdFirstPass: false,
    });
    const postUpgrade = reducePiecePracticeState([...events, upgradeEvent], {
      pieceId: "p1",
      chunks: [chunk],
    }).chunkStates["c0"];

    expect(postUpgrade.difficulty).toBeCloseTo(preUpgrade.difficulty, 6);
    expect(postUpgrade.stabilityDays).toBeCloseTo(Math.min(preUpgrade.stabilityDays * 0.5, 2.0), 6);
    expect(postUpgrade.sleepConsolidatedNights).toBe(0);
    expect(postUpgrade.stableSpeed).toBe(0.72);

    // Also verify single-hand -> both-hands transition discounts S and resets sleepConsolidatedNights
    const rhOnlyState = reducePiecePracticeState([events[0]], { pieceId: "p1", chunks: [chunk] }).chunkStates["c0"];
    const handUpgradeEvent = makeEvent({
      eventId: "e-hand",
      timestampMs: t0 + 30 * 60_000,
      localDateKey: "2026-11-10",
      practiceMode: "both",
      speedMultiplier: 0.58,
      autoGrade: 3,
      wasColdFirstPass: false,
    });
    const afterHandUpgrade = reducePiecePracticeState([events[0], handUpgradeEvent], {
      pieceId: "p1",
      chunks: [chunk],
    }).chunkStates["c0"];
    expect(afterHandUpgrade.handStage).toBe("both");
    expect(afterHandUpgrade.difficulty).toBeCloseTo(rhOnlyState.difficulty, 6);
    expect(afterHandUpgrade.stabilityDays).toBeCloseTo(Math.min(rhOnlyState.stabilityDays * 0.5, 2.0), 6);
    expect(afterHandUpgrade.sleepConsolidatedNights).toBe(0);
    expect(afterHandUpgrade.stableSpeed).toBe(0.58);
  });

  it("steps stableSpeed down -10% after 2 consecutive cross-day Again review days or deep-decay (R < 0.60) collapse (< 75%)", () => {
    const chunk = makeChunk("c0", 0, 1);
    const t0 = Date.UTC(2026, 10, 10, 10, 0, 0);

    const e0 = makeEvent({
      eventId: "e0",
      timestampMs: t0,
      localDateKey: "2026-11-10",
      speedMultiplier: 0.8,
      autoGrade: 3,
    });
    const e1AgainDay1 = makeEvent({
      eventId: "e1",
      timestampMs: t0 + 1 * DAY_MS,
      localDateKey: "2026-11-11",
      speedMultiplier: 0.8,
      autoGrade: 1,
      fluency: {
        pitchAccuracy: 0.8,
        interiorHesitationCount: 1,
        junctionHesitationRatio: 1.0,
        timingCv: 0.1,
        stallDetected: false,
        dominantHandFaultRatio: { rh: 0.5, lh: 0.5 },
        switchBranchMismatch: false,
        reanchorCount: 0,
      },
    });
    const afterOneAgain = reducePiecePracticeState([e0, e1AgainDay1], {
      pieceId: "p1",
      chunks: [chunk],
    }).chunkStates["c0"];
    expect(afterOneAgain.stableSpeed).toBe(0.8);
    expect(afterOneAgain.consecutiveAgainDays).toBe(1);

    const e2AgainDay2 = {
      ...e1AgainDay1,
      eventId: "e2",
      timestampMs: t0 + 2 * DAY_MS,
      localDateKey: "2026-11-12",
    };
    const afterTwoAgains = reducePiecePracticeState([e0, e1AgainDay1, e2AgainDay2], {
      pieceId: "p1",
      chunks: [chunk],
    }).chunkStates["c0"];
    expect(afterTwoAgains.stableSpeed).toBeCloseTo(0.72, 2);
    expect(afterTwoAgains.sleepConsolidatedNights).toBe(0);

    // Deep-decay collapse: S = 1.5 d -> under FSRS-6 power-law decay, after 45 days R < 0.60; accuracy 0.70 (< 75%) -> -10% step-down
    expect(computeFsrsRetrievability(45, 1.5)).toBeLessThan(0.6);
    const eDeepDecay = makeEvent({
      eventId: "e-deep",
      timestampMs: t0 + 45 * DAY_MS,
      localDateKey: "2026-12-25",
      speedMultiplier: 0.8,
      autoGrade: 1,
      fluency: {
        pitchAccuracy: 0.7,
        interiorHesitationCount: 2,
        junctionHesitationRatio: 1.2,
        timingCv: 0.2,
        stallDetected: true,
        dominantHandFaultRatio: { rh: 0.5, lh: 0.5 },
        switchBranchMismatch: false,
        reanchorCount: 1,
      },
    });
    const afterDeepDecay = reducePiecePracticeState([e0, eDeepDecay], {
      pieceId: "p1",
      chunks: [chunk],
    }).chunkStates["c0"];
    expect(afterDeepDecay.stableSpeed).toBeCloseTo(0.72, 2);
  });

  it("caps maintenance interval at 21-30d and tightens when optional performanceDateKey is near", () => {
    const defaultCap = computeMaintenanceIntervalDays(120, {
      currentDateKey: "2026-11-20",
    });
    expect(defaultCap).toBeGreaterThanOrEqual(21);
    expect(defaultCap).toBeLessThanOrEqual(30);

    const tightened = computeMaintenanceIntervalDays(120, {
      currentDateKey: "2026-11-20",
      performanceDateKey: "2026-11-30",
    });
    expect(tightened).toBeLessThanOrEqual(9);
    expect(tightened).toBeGreaterThanOrEqual(1);
  });

  it("lazily activates ChunkJunction cards only on priorRisk >= 0.65, SwitchPoint, or empirical fault/hesitation", () => {
    const c0 = makeChunk("c0", 0, 1);
    const c1 = makeChunk("c1", 2, 3);
    const c2 = makeChunk("c2", 4, 5);
    const c3 = makeChunk("c3", 6, 7);

    const jLow = makeJunction("j-low", c0, c1, { priorRisk: 0.35 });
    const jHigh = makeJunction("j-high", c1, c2, { priorRisk: 0.72 });
    const jSwitch = makeJunction("j-switch", c2, c3, { priorRisk: 0.4, switchPoint: true });

    const baseState = reducePiecePracticeState([], {
      pieceId: "p1",
      chunks: [c0, c1, c2, c3],
      junctions: [jLow, jHigh, jSwitch],
    });
    expect(baseState.junctionStates["j-low"]).toBeUndefined();
    expect(baseState.junctionStates["j-high"]).toBeDefined();
    expect(baseState.junctionStates["j-switch"]).toBeDefined();

    // Empirical fault/hesitation on j-low activates it lazily
    const bridgeEvent = makeEvent({
      eventId: "ev-bridge",
      boutKind: "bridge",
      startCoord: { measureIndex: 1, beatNum: 2, beatDen: 1 },
      endCoord: { measureIndex: 2, beatNum: 2, beatDen: 1 },
      junctionBoundaryCoord: jLow.boundaryCoord,
      autoGrade: 2,
      fluency: {
        pitchAccuracy: 0.92,
        interiorHesitationCount: 0,
        junctionHesitationRatio: 1.9,
        timingCv: 0.08,
        stallDetected: false,
        dominantHandFaultRatio: { rh: 0.5, lh: 0.5 },
        switchBranchMismatch: false,
        reanchorCount: 0,
      },
    });
    const afterBridge = reducePiecePracticeState([bridgeEvent], {
      pieceId: "p1",
      chunks: [c0, c1, c2, c3],
      junctions: [jLow, jHigh, jSwitch],
    });
    expect(afterBridge.junctionStates["j-low"]).toBeDefined();
    expect(afterBridge.junctionStates["j-low"].stabilityDays).toBe(1.0);
  });

  it("prevents manual single-hand sessions from inflating Both-Hands stableSpeed or sleepConsolidatedNights, and follows zoned speed ladder", () => {
    expect(computeNextSpeedStep(0.55)).toBe(0.62); // +13% decoding zone
    expect(computeNextSpeedStep(0.75)).toBe(0.82); // +9% core zone
    expect(computeNextSpeedStep(0.92)).toBe(0.97); // +5% sprint zone
    expect(computeNextSpeedStep(0.98)).toBe(1.0); // capped at targetSpeed 1.0

    const chunk = makeChunk("c0", 0, 1);
    const t0 = Date.UTC(2026, 10, 10, 10, 0, 0);
    const e0 = makeEvent({
      eventId: "e0",
      timestampMs: t0,
      localDateKey: "2026-11-10",
      practiceMode: "both",
      speedMultiplier: 0.75,
      autoGrade: 3,
    });
    const e1Rh = makeEvent({
      eventId: "e1-rh",
      timestampMs: t0 + DAY_MS,
      localDateKey: "2026-11-11",
      practiceMode: "rh-only",
      speedMultiplier: 0.95,
      autoGrade: 4,
    });

    const beforeRh = reducePiecePracticeState([e0], { pieceId: "p1", chunks: [chunk] });
    const afterRh = reducePiecePracticeState([e0, e1Rh], { pieceId: "p1", chunks: [chunk] });
    expect(afterRh.chunkStates["c0"].stableSpeed).toBe(0.75);
    expect(afterRh.chunkStates["c0"].sleepConsolidatedNights).toBe(0);
    expect(afterRh.chunkStates["c0"].stabilityDays).toBe(beforeRh.chunkStates["c0"].stabilityDays);
    expect(afterRh.bestStableSpeed).toBe(0.75);
  });
});
