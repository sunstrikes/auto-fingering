import { describe, expect, it } from "vitest";
import type { MotorChunk } from "../src/chunking/types";
import type { PracticeStep, SolveResult } from "../src/domain/types";
import {
  ADVANCED_IMAGERY_TIMER_SEC,
  DEFAULT_MICRO_REST_DURATION_SEC,
  MAX_MICRO_REST_DURATION_SEC,
  MICRO_REST_REMINDER_TEXT,
  MIN_MICRO_REST_DURATION_SEC,
  clampMicroRestDurationSec,
  completeAudiationPreview,
  createAudiationPrimingState,
  createMicroRestState,
  deriveAudiationCue,
  evaluateAudiationImageryTick,
  evaluateMicroRestTick,
  interruptAudiationPreview,
  markAudiationPreviewPlaying,
  recordMicroRestAccidentalKeystroke,
  shouldAutoTriggerAudiationPreview,
} from "../src/guided/transitionFlow";

function makeTestChunk(overrides: Partial<MotorChunk> = {}): MotorChunk {
  return {
    chunkId: "chunk-2",
    index: 1,
    sectionId: "sec-1",
    startMeasureIndex: 2,
    endMeasureIndex: 3,
    startCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
    endCoord: { measureIndex: 4, beatNum: 0, beatDen: 1 },
    measureCount: 2,
    stepCount: 4,
    densityStepsPerMeasure: 2,
    hasAnacrusisLeadIn: false,
    anacrusisBeats: 0,
    overlapFlag: false,
    boundaryConfidence: 0.9,
    ...overrides,
  };
}

function makeTestStep(overrides: Partial<PracticeStep> = {}): PracticeStep {
  return {
    stepIndex: 0,
    measureIndex: 2,
    onsetTick: 32,
    onsetSec: 4.0,
    expectedDurationSec: 0.5,
    isGrace: false,
    primarySliceId: "slice-m3-rh-0",
    expectedMidis: [48, 64],
    expectedNotes: [
      {
        noteUid: "n-rh-1",
        measureIndex: 2,
        onsetTick: 32,
        durationTick: 8,
        onsetSec: 4.0,
        durationSec: 1.0,
        midi: 64,
        hand: "RH",
        voice: "1",
        staff: 1,
        isGrace: false,
        isTieStop: false,
        isTieStart: false,
      },
      {
        noteUid: "n-lh-1",
        measureIndex: 2,
        onsetTick: 32,
        durationTick: 8,
        onsetSec: 4.0,
        durationSec: 1.0,
        midi: 48,
        hand: "LH",
        voice: "2",
        staff: 2,
        isGrace: false,
        isTieStop: false,
        isTieStart: false,
      },
    ],
    accompanimentNotes: [],
    ...overrides,
  };
}

describe("transitionFlow: Micro-Rest", () => {
  it("clamps Micro-Rest duration to 10–15 s with 12 s default and evaluates countdown ticks without aborting on accidental keystrokes", () => {
    expect(DEFAULT_MICRO_REST_DURATION_SEC).toBe(12);
    expect(MIN_MICRO_REST_DURATION_SEC).toBe(10);
    expect(MAX_MICRO_REST_DURATION_SEC).toBe(15);

    expect(clampMicroRestDurationSec(undefined)).toBe(12);
    expect(clampMicroRestDurationSec(Number.NaN)).toBe(12);
    expect(clampMicroRestDurationSec(4)).toBe(10);
    expect(clampMicroRestDurationSec(13.4)).toBe(13);
    expect(clampMicroRestDurationSec(25)).toBe(15);

    const initial = createMicroRestState({ startedAtMs: 1_000 });
    expect(initial.durationMs).toBe(12_000);
    expect(initial.accidentalKeystrokeCount).toBe(0);
    expect(initial.reminderPulseToken).toBe(0);
    expect(initial.reminderMessage).toBeNull();

    const midTick = evaluateMicroRestTick(initial, 5_500);
    expect(midTick).toEqual({
      elapsedMs: 4_500,
      remainingMs: 7_500,
      remainingSec: 8,
      progress: 4_500 / 12_000,
      completed: false,
    });

    // Accidental ordinary keystrokes do NOT abort or alter countdown timing
    const afterKey1 = recordMicroRestAccidentalKeystroke(initial, 5_600);
    expect(afterKey1.startedAtMs).toBe(1_000);
    expect(afterKey1.durationMs).toBe(12_000);
    expect(afterKey1.accidentalKeystrokeCount).toBe(1);
    expect(afterKey1.reminderPulseToken).toBe(1);
    expect(afterKey1.reminderMessage).toBe(MICRO_REST_REMINDER_TEXT);

    const afterKey2 = recordMicroRestAccidentalKeystroke(afterKey1, 6_000);
    expect(afterKey2.accidentalKeystrokeCount).toBe(2);
    expect(afterKey2.reminderPulseToken).toBe(2);

    expect(evaluateMicroRestTick(afterKey2, 12_999).completed).toBe(false);
    const doneTick = evaluateMicroRestTick(afterKey2, 13_000);
    expect(doneTick.completed).toBe(true);
    expect(doneTick.remainingMs).toBe(0);
    expect(doneTick.remainingSec).toBe(0);
    expect(doneTick.progress).toBe(1);
  });
});

describe("transitionFlow: Audiation Priming", () => {
  it("derives single-line audiation & HandPosition cue and gates unfamiliar (< 2 passes) auto-preview by mode", () => {
    const chunk = makeTestChunk();
    const step = makeTestStep();
    const solveResult: SolveResult = {
      fingerByNoteUid: { "n-rh-1": 3, "n-lh-1": 5 },
      handPositions: [
        {
          hand: "RH",
          startSliceId: "slice-m3-rh-0",
          endSliceId: "slice-m3-rh-3",
          thumbKey: 28,
          pinkyKey: 32,
          minMidi: 60,
          maxMidi: 67,
        },
        {
          hand: "LH",
          startSliceId: "slice-m3-lh-0",
          endSliceId: "slice-m3-lh-3",
          thumbKey: 24,
          pinkyKey: 20,
          minMidi: 48,
          maxMidi: 55,
        },
      ],
      transitionCues: [
        {
          sliceId: "slice-m3-rh-0",
          hand: "RH",
          measureIndex: 2,
          type: "position-shift",
          severity: "info",
          cost: 2,
          label: "换把移位",
        },
      ],
      warnings: [],
      repairedAnchorUids: [],
      solveTimeMs: 1,
    };

    const cueAuto = deriveAudiationCue({
      nextChunk: chunk,
      nextChunkSteps: [step],
      solveResult,
      practiceMode: "both",
      onsetSlices: [
        {
          sliceId: "slice-m3-rh-0",
          hand: "RH",
          measureIndex: 2,
          onsetTick: 32,
          onsetSec: 4.0,
          isGrace: false,
          phraseId: 1,
          notes: [],
          heldNotes: [],
        },
        {
          sliceId: "slice-m3-lh-0",
          hand: "LH",
          measureIndex: 2,
          onsetTick: 32,
          onsetSec: 4.0,
          isGrace: false,
          phraseId: 1,
          notes: [],
          heldNotes: [],
        },
      ],
      historicalPassCount: 1,
      previewMode: "auto-unfamiliar",
    });

    expect(cueAuto.isUnfamiliar).toBe(true);
    expect(cueAuto.shouldAutoPreview).toBe(true);
    expect(cueAuto.firstTargetMidis).toEqual([48, 64]);
    expect(cueAuto.handPositionLabels.rh).toContain("C4");
    expect(cueAuto.handPositionLabels.rh).toContain("G4");
    expect(cueAuto.handPositionLabels.lh).toContain("C3");
    expect(cueAuto.handPositionLabels.lh).toContain("G3");
    expect(cueAuto.singleLinePrompt).not.toContain("\n");
    expect(cueAuto.singleLinePrompt).toContain("m.3–4");
    expect(cueAuto.singleLinePrompt).toContain("C4–G4");

    // Familiar chunk (>= 2 passes) does NOT auto-trigger preview
    const cueFamiliar = deriveAudiationCue({
      nextChunk: chunk,
      nextChunkSteps: [step],
      solveResult,
      practiceMode: "both",
      historicalPassCount: 2,
      previewMode: "auto-unfamiliar",
    });
    expect(cueFamiliar.isUnfamiliar).toBe(false);
    expect(cueFamiliar.shouldAutoPreview).toBe(false);

    // Manual mode never auto-triggers even for unfamiliar chunk
    const cueManual = deriveAudiationCue({
      nextChunk: chunk,
      nextChunkSteps: [step],
      solveResult,
      practiceMode: "rh-only",
      historicalPassCount: 0,
      previewMode: "manual",
    });
    expect(cueManual.isUnfamiliar).toBe(true);
    expect(cueManual.shouldAutoPreview).toBe(false);
    expect(cueManual.handPositionLabels.lh).toBeUndefined();
  });

  it("tracks preview playback + immediate C8 / first-note interruption and optional non-blocking 10 s imagery timer", () => {
    expect(ADVANCED_IMAGERY_TIMER_SEC).toBe(10);

    const state = createAudiationPrimingState({
      enteredAtMs: 20_000,
      chunkId: "chunk-2",
      historicalPassCount: 0,
      previewMode: "auto-unfamiliar",
      imageryTimerEnabled: false,
    });
    expect(shouldAutoTriggerAudiationPreview(state)).toBe(true);
    expect(evaluateAudiationImageryTick(state, 25_000).active).toBe(false);

    const playing = markAudiationPreviewPlaying(state);
    expect(playing.previewStatus).toBe("playing");

    const interrupted = interruptAudiationPreview(playing, "first-note");
    expect(interrupted.previewStatus).toBe("interrupted");
    expect(interrupted.previewInterruptedReason).toBe("first-note");

    const completed = completeAudiationPreview(playing);
    expect(completed.previewStatus).toBe("completed");

    // Optional opt-in 10 s advanced imagery timer
    const withTimer = createAudiationPrimingState({
      enteredAtMs: 30_000,
      chunkId: "chunk-2",
      historicalPassCount: 2,
      previewMode: "auto-unfamiliar",
      imageryTimerEnabled: true,
    });
    expect(shouldAutoTriggerAudiationPreview(withTimer)).toBe(false);
    expect(evaluateAudiationImageryTick(withTimer, 34_200)).toEqual({
      active: true,
      remainingMs: 5_800,
      remainingSec: 6,
      completed: false,
    });
    expect(evaluateAudiationImageryTick(withTimer, 40_000)).toEqual({
      active: true,
      remainingMs: 0,
      remainingSec: 0,
      completed: true,
    });
  });
});

