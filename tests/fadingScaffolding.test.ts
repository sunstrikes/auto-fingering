import { describe, expect, it } from "vitest";
import { attributeContinuousBout } from "../src/guided/boundedAttribution";
import {
  collectL2PreservedFingeringTargets,
  createPeekKeyExemptionPredicate,
  deriveScaffoldingLevel,
  deriveScaffoldingPolicy,
} from "../src/guided/fadingScaffolding";
import { createEmptyUnitState, type MotorUnitMemoryState } from "../src/guided/motorFsrs";
import {
  PIANO_COMMAND_MIDI,
  createPianoCommandRouter,
  hasB0Collision,
  routeKeyboardCommand,
} from "../src/guided/pianoCommandKeys";
import type { MidiInputEvent } from "../src/midi/webMidi";
import { createPracticeBackup, importPracticeBackup } from "../src/persistence/backupMerge";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import { GLOBAL_WORKSPACE } from "../src/persistence/storagePort";
import type { NoteEvent, PracticeStep, ScoreCoord, ScoreDocument, SolveResult } from "../src/domain/types";

const START: ScoreCoord = { measureIndex: 0, beatNum: 0, beatDen: 1 };
const END: ScoreCoord = { measureIndex: 2, beatNum: 0, beatDen: 1 };

function makeUnit(overrides: Partial<MotorUnitMemoryState> = {}): MotorUnitMemoryState {
  return {
    ...createEmptyUnitState({
      unitId: "chunk-0",
      unitKind: "chunk",
      startCoord: START,
      endCoord: END,
      measureIndices: [0, 1],
      targetSpeed: 1.0,
    }),
    ...overrides,
  };
}

describe("fadingScaffolding pure derivation", () => {
  it("derives L0–L3 deterministically from Motor-FSRS state", () => {
    // L0: Stage 0 Waiting Mode or Phase 0 unpracticed unit
    const brandNew = makeUnit({ reviewCount: 0 });
    expect(deriveScaffoldingLevel(brandNew, { useWaitingMode: true })).toBe(0);
    expect(deriveScaffoldingLevel(brandNew, { phase: 0 })).toBe(0);
    expect(deriveScaffoldingLevel(null, { useWaitingMode: true })).toBe(0);

    // L1: Continuous steady play before L2 thresholds
    const phase1Unit = makeUnit({
      reviewCount: 2,
      handStage: "both",
      stableSpeed: 0.65,
      sleepConsolidatedNights: 0,
    });
    expect(deriveScaffoldingLevel(phase1Unit, { phase: 1, useWaitingMode: false })).toBe(1);

    // Single-hand or <0.75x with overnight Good stays L1 unless Phase 2
    const slowOvernight = makeUnit({
      reviewCount: 3,
      handStage: "both",
      stableSpeed: 0.7,
      sleepConsolidatedNights: 1,
    });
    expect(deriveScaffoldingLevel(slowOvernight, { phase: 1, useWaitingMode: false })).toBe(1);

    const rhOnlyFast = makeUnit({
      reviewCount: 4,
      handStage: "rh-only",
      stableSpeed: 0.95,
      sleepConsolidatedNights: 2,
    });
    expect(deriveScaffoldingLevel(rhOnlyFast, { phase: 1, useWaitingMode: false })).toBe(1);

    // L2: Phase 2 OR (Both Hands + stableSpeed >= 0.75x + >= 1 overnight Good)
    const l2ByFsrs = makeUnit({
      reviewCount: 3,
      handStage: "both",
      stableSpeed: 0.75,
      sleepConsolidatedNights: 1,
      lastEffectiveGrade: 3,
    });
    expect(deriveScaffoldingLevel(l2ByFsrs, { phase: 1, useWaitingMode: false })).toBe(2);
    expect(deriveScaffoldingLevel(phase1Unit, { phase: 2, useWaitingMode: false })).toBe(2);

    // L3: Both Hands + stableSpeed >= 0.90x + >= 2 overnight Good
    const l3Unit = makeUnit({
      reviewCount: 5,
      handStage: "both",
      stableSpeed: 0.9,
      sleepConsolidatedNights: 2,
      lastEffectiveGrade: 3,
    });
    expect(deriveScaffoldingLevel(l3Unit, { phase: 2, useWaitingMode: false })).toBe(3);
  });

  it("applies the 3 ScaffoldingPreference modes and automatic 1-tier step-down on Again or circuit-breaker", () => {
    const l3Unit = makeUnit({
      reviewCount: 6,
      handStage: "both",
      stableSpeed: 0.95,
      sleepConsolidatedNights: 2,
      lastEffectiveGrade: 3,
    });
    const l2Unit = makeUnit({
      reviewCount: 4,
      handStage: "both",
      stableSpeed: 0.8,
      sleepConsolidatedNights: 1,
      lastEffectiveGrade: 3,
    });
    const l1Unit = makeUnit({
      reviewCount: 2,
      handStage: "both",
      stableSpeed: 0.65,
      sleepConsolidatedNights: 0,
      lastEffectiveGrade: 3,
    });

    // always-full caps continuous play at L1 (never hides fingerings/keyboard)
    expect(
      deriveScaffoldingLevel(l3Unit, {
        preference: "always-full",
        phase: 2,
        useWaitingMode: false,
      }),
    ).toBe(1);
    expect(
      deriveScaffoldingPolicy(l3Unit, {
        preference: "always-full",
        phase: 2,
        useWaitingMode: false,
      }),
    ).toMatchObject({
      level: 1,
      scoreFingeringMode: "all",
      hideKeyboardTargets: false,
      hideHandSkeleton: false,
      suppressLiveWrongFlash: true,
    });

    // hide-keyboard-early hides keyboard targets & skeleton starting at L1 while keeping score fingerings at L1
    expect(
      deriveScaffoldingPolicy(l1Unit, {
        preference: "hide-keyboard-early",
        phase: 1,
        useWaitingMode: false,
      }),
    ).toMatchObject({
      level: 1,
      scoreFingeringMode: "all",
      hideKeyboardTargets: true,
      hideHandSkeleton: true,
      suppressLiveWrongFlash: true,
      cuesObscured: true,
    });

    // Automatic 1-tier step-down on Again (lastEffectiveGrade === 1) or circuit-breaker trigger
    const l3WithAgain = makeUnit({ ...l3Unit, lastEffectiveGrade: 1 });
    expect(deriveScaffoldingLevel(l3WithAgain, { phase: 2, useWaitingMode: false })).toBe(2);

    const l2WithAgain = makeUnit({ ...l2Unit, lastEffectiveGrade: 1 });
    expect(deriveScaffoldingLevel(l2WithAgain, { phase: 2, useWaitingMode: false })).toBe(1);

    expect(
      deriveScaffoldingLevel(l3Unit, {
        phase: 2,
        useWaitingMode: false,
        circuitBreakerTriggered: true,
      }),
    ).toBe(2);
    expect(
      deriveScaffoldingLevel(l2Unit, {
        phase: 2,
        useWaitingMode: false,
        circuitBreakerTriggered: true,
      }),
    ).toBe(1);

    // Waiting-mode rescue drops back to L0
    expect(
      deriveScaffoldingLevel(l3Unit, {
        phase: 2,
        useWaitingMode: true,
        circuitBreakerTriggered: true,
      }),
    ).toBe(0);
  });

  it("enforces active-play B0 symmetric collision guard and exempts peek strikes in Bounded Window Attribution", () => {
    expect(hasB0Collision([60, 64, 67])).toBe(false);
    expect(hasB0Collision([23, 60, 64])).toBe(true);

    const router = createPianoCommandRouter();
    const noteOn = (midi: number, timeStampMs: number): MidiInputEvent => ({
      type: "noteon",
      midi,
      velocity: 88,
      channel: 0,
      portId: "sim-1",
      source: "midi",
      timeStampMs,
    });

    // When cues are NOT obscured during active play, B0 is ignored
    expect(
      router.routeMidi(noteOn(PIANO_COMMAND_MIDI.B0, 100), {
        phase: "playing",
        firstTargetMidis: [60],
        chunkMidis: [60, 62, 64],
        cc64CommandEnabled: false,
        cuesObscured: false,
      }),
    ).toEqual({ action: "none" });

    // When cues ARE obscured (L2/L3/EHS) and chunk has NO B0, B0 triggers non-pausing peek-fingerings
    expect(
      router.routeMidi(noteOn(PIANO_COMMAND_MIDI.B0, 1000), {
        phase: "playing",
        firstTargetMidis: [60],
        chunkMidis: [60, 62, 64],
        cc64CommandEnabled: false,
        cuesObscured: true,
      }),
    ).toEqual({ action: "peek-fingerings" });

    // When chunk legitimately contains B0 (23), active-play B0 is auto-disabled
    expect(
      router.routeMidi(noteOn(PIANO_COMMAND_MIDI.B0, 1500), {
        phase: "playing",
        firstTargetMidis: [23],
        chunkMidis: [23, 60, 62],
        cc64CommandEnabled: false,
        cuesObscured: true,
      }),
    ).toEqual({ action: "none", b0PeekDisabled: true });

    // Keyboard 'f' still triggers peek-fingerings during obscured active play even if B0 is in chunk
    expect(
      routeKeyboardCommand(
        { key: "f", code: "KeyF", metaKey: false, ctrlKey: false, altKey: false, repeat: false },
        "playing",
        { cuesObscured: true },
      ),
    ).toBe("peek-fingerings");

    // Bounded Window Attribution exempts recorded B0 peek strike (zero extra faults)
    const n1: NoteEvent = {
      noteUid: "n1",
      measureIndex: 0,
      onsetTick: 0,
      durationTick: 480,
      onsetSec: 0,
      durationSec: 0.5,
      midi: 60,
      hand: "RH",
      voice: "1",
      staff: 1,
      isGrace: false,
      isTieStart: false,
      isTieStop: false,
    };
    const n2: NoteEvent = {
      ...n1,
      noteUid: "n2",
      onsetTick: 480,
      onsetSec: 0.5,
      midi: 64,
    };
    const steps: PracticeStep[] = [
      {
        stepIndex: 0,
        measureIndex: 0,
        onsetTick: 0,
        isGrace: false,
        onsetSec: 0,
        expectedDurationSec: 0.5,
        primarySliceId: "s0",
        expectedNotes: [n1],
        expectedMidis: [60],
        accompanimentNotes: [],
      },
      {
        stepIndex: 1,
        measureIndex: 0,
        onsetTick: 480,
        isGrace: false,
        onsetSec: 0.5,
        expectedDurationSec: 0.5,
        primarySliceId: "s1",
        expectedNotes: [n2],
        expectedMidis: [64],
        accompanimentNotes: [],
      },
    ];
    const midiEvents: MidiInputEvent[] = [
      noteOn(60, 1000),
      noteOn(PIANO_COMMAND_MIDI.B0, 1250),
      noteOn(64, 1500),
    ];

    const withoutExemption = attributeContinuousBout({
      clockAnchor: {
        t0PerfMs: 1000,
        audioStartTimeSec: 0,
        startScoreSec: 0,
        endScoreSec: 1.0,
        speedMultiplier: 1.0,
      },
      expectedSteps: steps,
      midiEvents,
    });
    expect(withoutExemption.extraEvents).toHaveLength(1);

    const withExemption = attributeContinuousBout({
      clockAnchor: {
        t0PerfMs: 1000,
        audioStartTimeSec: 0,
        startScoreSec: 0,
        endScoreSec: 1.0,
        speedMultiplier: 1.0,
      },
      expectedSteps: steps,
      midiEvents,
      isExemptPeekKey: createPeekKeyExemptionPredicate([1250]),
    });
    expect(withExemption.extraEvents).toHaveLength(0);
    expect(withExemption.filteredExemptCount).toBe(1);
    expect(withExemption.fluency.pitchAccuracy).toBe(1);
  });

  it("collects L2 preserved noteUids and measureIndices from FingerAnchors and high-risk TransitionCues", () => {
    const nAnchor: NoteEvent = {
      noteUid: "n-anchor",
      measureIndex: 0,
      onsetTick: 0,
      durationTick: 480,
      onsetSec: 0,
      durationSec: 0.5,
      midi: 60,
      hand: "RH",
      voice: "1",
      staff: 1,
      isGrace: false,
      isTieStart: false,
      isTieStop: false,
    };
    const nRoutine: NoteEvent = {
      ...nAnchor,
      noteUid: "n-routine",
      onsetTick: 480,
      onsetSec: 0.5,
      midi: 62,
    };
    const nWarn: NoteEvent = {
      ...nAnchor,
      noteUid: "n-warn",
      measureIndex: 1,
      onsetTick: 960,
      onsetSec: 1.0,
      midi: 69,
    };
    const scoreDoc = {
      noteEvents: [nAnchor, nRoutine, nWarn],
      onsetSlices: [
        { sliceId: "s0", measureIndex: 0, onsetTick: 0, onsetSec: 0, hand: "RH", isGrace: false, notes: [nAnchor], heldNotes: [] },
        { sliceId: "s1", measureIndex: 0, onsetTick: 480, onsetSec: 0.5, hand: "RH", isGrace: false, notes: [nRoutine], heldNotes: [] },
        { sliceId: "s2", measureIndex: 1, onsetTick: 960, onsetSec: 1.0, hand: "RH", isGrace: false, notes: [nWarn], heldNotes: [] },
      ],
    } as unknown as ScoreDocument;
    const solveResult = {
      fingerByNoteUid: { "n-anchor": 1, "n-routine": 2, "n-warn": 4 },
      handPositions: [],
      transitionCues: [
        { sliceId: "s1", hand: "RH", measureIndex: 0, type: "thumb-under", severity: "info", cost: 1, label: "Info" },
        { sliceId: "s2", hand: "RH", measureIndex: 1, type: "wide-stretch", severity: "warn", cost: 5, label: "Wide" },
      ],
      warnings: [],
      repairedAnchorUids: [],
      solveTimeMs: 1,
    } as SolveResult;

    const preserved = collectL2PreservedFingeringTargets(scoreDoc, solveResult, {
      "n-anchor": { finger: 1, mode: "phrase" },
    });
    expect(preserved.preservedNoteUids).toEqual(["n-anchor", "n-warn"]);
    expect(preserved.preservedMeasureIndices).toEqual([0, 1]);
  });

  it("persists and merges scaffoldingPreference and l3SilentBeatEnabled through WorkspacePrefs & backupMerge", async () => {
    const srcStorage = createInMemoryStorage();
    await srcStorage.commit({
      workspacePrefs: [
        {
          scopeKey: GLOBAL_WORKSPACE,
          scaffoldingPreference: "hide-keyboard-early",
          l3SilentBeatEnabled: false,
          updatedAtMs: 5000,
        },
      ],
    });
    const backup = await createPracticeBackup(srcStorage);

    const dstStorage = createInMemoryStorage();
    await importPracticeBackup(dstStorage, backup.metadataOnlyJson);
    const restored = await dstStorage.get("workspacePrefs", GLOBAL_WORKSPACE);
    expect(restored?.scaffoldingPreference).toBe("hide-keyboard-early");
    expect(restored?.l3SilentBeatEnabled).toBe(false);

    // Invalid scaffoldingPreference must be rejected by backup validation
    const tampered = JSON.parse(backup.metadataOnlyJson) as {
      workspacePrefs: Array<Record<string, unknown>>;
    };
    tampered.workspacePrefs[0].scaffoldingPreference = "invalid-tier";
    await expect(
      importPracticeBackup(createInMemoryStorage(), JSON.stringify(tampered)),
    ).rejects.toThrow();
  });
});
