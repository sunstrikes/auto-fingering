import { describe, expect, it } from "vitest";
import type { PracticeStep } from "../src/domain/types";
import {
  STAGE0_ACCURACY_THRESHOLD,
  STAGE0_TIME_CAP_MS,
  buildStage0TelemetrySummary,
  createStage0State,
  evaluateStage0Tick,
  pauseStage0,
  recordStage0StepCompleted,
  recordStage0WrongNote,
  resumeStage0,
} from "../src/guided/stage0Controller";

function makeSteps(count: number, gapSec = 0.5): PracticeStep[] {
  return Array.from({ length: count }, (_, idx) => ({
    stepIndex: idx,
    measureIndex: Math.floor(idx / 4),
    onsetTick: idx * 480,
    onsetSec: idx * gapSec,
    expectedDurationSec: gapSec,
    isGrace: false,
    expectedNotes: [
      {
        noteUid: `n-${idx}`,
        midi: 60 + (idx % 5),
        hand: "RH",
        measureIndex: Math.floor(idx / 4),
        onsetTick: idx * 480,
        durationTick: 480,
        onsetSec: idx * gapSec,
        durationSec: gapSec,
        isTieStart: false,
        isTieStop: false,
        isGrace: false,
        staff: 1,
        voice: "1",
      },
    ],
    accompanimentNotes: [],
    expectedMidis: [60 + (idx % 5)],
    primarySliceId: `slice-${idx}`,
  }));
}

describe("stage0Controller", () => {
  it("graduates upon 1 smooth pass (>= 90% accuracy and zero long hesitation)", () => {
    const steps = makeSteps(10, 0.5);
    let state = createStage0State({
      chunkId: "chunk-0",
      steps,
      startedAtMs: 1000,
      speedMultiplier: 1.0,
    });

    // 1 wrong note out of 10 notes = 90% accuracy (>= 0.90)
    state = recordStage0WrongNote(state, 61, 1200);

    for (let i = 0; i < steps.length; i++) {
      state = recordStage0StepCompleted(state, i, 1200 + i * 500);
    }

    expect(STAGE0_ACCURACY_THRESHOLD).toBe(0.9);
    expect(state.graduated).toBe(true);
    expect(state.graduationReason).toBe("smooth-pass");
    expect(state.lastPassAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(state.longHesitationCount).toBe(0);

    const telemetry = buildStage0TelemetrySummary(state);
    expect(telemetry.telemetryIsolated).toBe(true);
    expect(telemetry.acoustic).toBeUndefined();
  });

  it("does not graduate on < 90% accuracy or long hesitation, then graduates on next smooth pass", () => {
    const steps = makeSteps(4, 0.5);
    let state = createStage0State({
      chunkId: "chunk-0",
      steps,
      startedAtMs: 1000,
      speedMultiplier: 1.0,
    });

    // Pass 1: 1 wrong note out of 4 = 75% (< 90%) + long hesitation (> 1.6 * 500 + 450)
    state = recordStage0WrongNote(state, 69, 1100);
    state = recordStage0StepCompleted(state, 0, 1200);
    state = recordStage0StepCompleted(state, 1, 3000); // 1800ms gap vs 500ms expected -> long hesitation
    state = recordStage0StepCompleted(state, 2, 3500);
    state = recordStage0StepCompleted(state, 3, 4000);

    expect(state.graduated).toBe(false);
    expect(state.passAttempts).toBe(1);
    expect(state.currentStepIndex).toBe(0);
    expect(state.wrongNoteCount).toBe(0);
    expect(state.longHesitationCount).toBe(0);

    // Pass 2: clean smooth pass
    for (let i = 0; i < steps.length; i++) {
      state = recordStage0StepCompleted(state, i, 4500 + i * 500);
    }
    expect(state.graduated).toBe(true);
    expect(state.graduationReason).toBe("smooth-pass");
    expect(state.passAttempts).toBe(2);
  });

  it("graduates automatically at the 2-minute (120_000 ms) active cap while excluding paused time", () => {
    const steps = makeSteps(8, 0.5);
    let state = createStage0State({
      chunkId: "chunk-0",
      steps,
      startedAtMs: 10_000,
      speedMultiplier: 0.75,
    });

    expect(STAGE0_TIME_CAP_MS).toBe(120_000);

    // Pause for 60s -> should NOT count toward 2-min cap
    state = pauseStage0(state, 30_000); // 20s elapsed
    state = evaluateStage0Tick(state, 90_000);
    expect(state.graduated).toBe(false);

    state = resumeStage0(state, 90_000);
    state = evaluateStage0Tick(state, 189_999); // 20s + 99.999s = 119.999s active
    expect(state.graduated).toBe(false);

    state = evaluateStage0Tick(state, 190_000); // 20s + 100s = 120s active
    expect(state.graduated).toBe(true);
    expect(state.graduationReason).toBe("time-cap");

    const telemetry = buildStage0TelemetrySummary(state);
    expect(telemetry.telemetryIsolated).toBe(true);
    expect(telemetry.acoustic).toBeUndefined();
    expect(telemetry.activeElapsedMs).toBe(120_000);
  });
});
