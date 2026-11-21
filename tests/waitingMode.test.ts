import { describe, it, expect, vi } from "vitest";
import type { NoteEvent, OnsetSlice, ScoreDocument, TransitionCue } from "../src/domain/types";
import { createPianoAudioEngine } from "../src/audio/pianoAudio";
import { createPlaybackEngine } from "../src/audio/playbackEngine";
import {
  advanceWaitingHoldProgress,
  buildPracticeSteps,
  computeStepRequiredHoldSec,
  createWaitingModeState,
  doesNoteOnMatchPausedStep,
  handleWaitingNoteOff,
  handleWaitingNoteOffWithResult,
  handleWaitingNoteOn,
} from "../src/practice/waitingMode";
import {
  buildMeasureErrorSummaries,
  buildPracticeRepeatRecommendations,
  createPracticeAnalyticsState,
  evaluatePracticeProgression,
  recordPracticeStepCompleted,
  recordPracticeStepFault,
  resetMeasureCleanStreak,
} from "../src/practice/practiceAnalytics";

function makeNote(
  overrides: Partial<NoteEvent> & { noteUid: string; midi: number; hand: "RH" | "LH" }
): NoteEvent {
  return {
    measureIndex: 0,
    onsetTick: 0,
    durationTick: 4,
    onsetSec: 0,
    durationSec: 0.5,
    voice: "1",
    staff: overrides.hand === "RH" ? 1 : 2,
    isGrace: false,
    isTieStop: false,
    isTieStart: false,
    ...overrides,
  };
}

function makeScoreDoc(noteEvents: NoteEvent[], onsetSlices: OnsetSlice[] = []): ScoreDocument {
  return {
    title: "Test Score",
    xmlDoc: {} as Document,
    xmlDeclaration: "",
    noteElementsByUid: new Map(),
    noteEvents,
    onsetSlices,
    isSingleStaff: false,
    defaultSingleStaffHand: "RH",
    measureCount: 1,
    ticksPerQuarter: 4,
    tempoPoints: [{ tick: 0, bpm: 120 }],
    timeSignaturePoints: [{ tick: 0, beats: 4, beatType: 4 }],
    measureTimelines: [
      {
        measureIndex: 0,
        startTick: 0,
        endTick: 16,
        startSec: 0,
        endSec: 2,
        timeBeats: 4,
        timeBeatType: 4,
        isPickup: false,
      },
    ],
  };
}

describe("PracticeStep projection (buildPracticeSteps)", () => {
  it("merges simultaneous RH and LH non-TieContinuation notes, computes expectedDurationSec, and partitions by PracticeMode", () => {
    const notes: NoteEvent[] = [
      makeNote({ noteUid: "rh-1", midi: 64, hand: "RH", onsetTick: 0, onsetSec: 0, durationSec: 1.0, isTieStart: true }),
      makeNote({ noteUid: "rh-2", midi: 67, hand: "RH", onsetTick: 0, onsetSec: 0, durationSec: 0.5 }),
      makeNote({ noteUid: "lh-1", midi: 48, hand: "LH", onsetTick: 0, onsetSec: 0, durationSec: 0.5 }),
      // Tie continuation at tick 4 should be excluded
      makeNote({
        noteUid: "rh-tie",
        midi: 64,
        hand: "RH",
        onsetTick: 4,
        onsetSec: 0.5,
        durationSec: 0.5,
        isTieStop: true,
        tieChainRootUid: "rh-1",
      }),
      makeNote({ noteUid: "lh-2", midi: 55, hand: "LH", onsetTick: 4, onsetSec: 0.5, durationSec: 0.5 }),
      // Repeated pitch at tick 8
      makeNote({ noteUid: "rh-3", midi: 64, hand: "RH", onsetTick: 8, onsetSec: 1.0, durationSec: 0.75 }),
    ];

    const slices: OnsetSlice[] = [
      {
        sliceId: "s0",
        hand: "RH",
        measureIndex: 0,
        onsetTick: 0,
        onsetSec: 0,
        isGrace: false,
        phraseId: 0,
        notes: [notes[0], notes[1]],
        heldNotes: [],
      },
      {
        sliceId: "s1",
        hand: "LH",
        measureIndex: 0,
        onsetTick: 4,
        onsetSec: 0.5,
        isGrace: false,
        phraseId: 0,
        notes: [notes[4]],
        heldNotes: [],
      },
    ];

    const doc = makeScoreDoc(notes, slices);

    // Both Hands: tick 0 merges 48, 64, 67; tick 4 only has LH 55 (tie stop excluded); tick 8 has RH 64
    const bothSteps = buildPracticeSteps(doc, "both");
    expect(bothSteps).toHaveLength(3);
    expect(bothSteps[0].expectedMidis).toEqual([48, 64, 67]);
    expect(bothSteps[0].expectedDurationSec).toBeCloseTo(0.5, 4);
    expect(bothSteps[0].accompanimentNotes).toEqual([]);
    expect(bothSteps[0].primarySliceId).toBe("s0");
    expect(bothSteps[1].expectedMidis).toEqual([55]);
    expect(bothSteps[2].expectedMidis).toEqual([64]);
    expect(bothSteps[2].expectedDurationSec).toBeCloseTo(0.75, 4);

    // RH Only: tick 0 expects [64, 67] with LH 48 as accompaniment; tick 4 has no RH notes so skipped
    const rhSteps = buildPracticeSteps(doc, "rh-only");
    expect(rhSteps).toHaveLength(2);
    expect(rhSteps[0].expectedMidis).toEqual([64, 67]);
    expect(rhSteps[0].accompanimentNotes.map((n) => n.midi)).toEqual([48]);
    expect(rhSteps[1].expectedMidis).toEqual([64]);

    // LH Only: tick 0 expects [48] with RH [64, 67] as accompaniment; tick 4 expects [55]
    const lhSteps = buildPracticeSteps(doc, "lh-only");
    expect(lhSteps).toHaveLength(2);
    expect(lhSteps[0].expectedMidis).toEqual([48]);
    expect(lhSteps[0].accompanimentNotes.map((n) => n.midi)).toEqual([64, 67]);
    expect(lhSteps[1].expectedMidis).toEqual([55]);
  });

  it("orders grace notes sequentially before their main beat with expectedDurationSec=0 and skips them when skipGraceNotes is true", () => {
    const notes: NoteEvent[] = [
      makeNote({ noteUid: "g2", midi: 62, hand: "RH", onsetTick: 4, onsetSec: 0.5, isGrace: true, graceOrder: 1 }),
      makeNote({ noteUid: "g1", midi: 61, hand: "RH", onsetTick: 4, onsetSec: 0.5, isGrace: true, graceOrder: 0 }),
      makeNote({ noteUid: "main", midi: 64, hand: "RH", onsetTick: 4, onsetSec: 0.5, isGrace: false }),
    ];
    const doc = makeScoreDoc(notes);

    const withGrace = buildPracticeSteps(doc, "both", { skipGraceNotes: false });
    expect(
      withGrace.map((s) => ({
        midis: s.expectedMidis,
        isGrace: s.isGrace,
        dur: s.expectedDurationSec,
      }))
    ).toEqual([
      { midis: [61], isGrace: true, dur: 0 },
      { midis: [62], isGrace: true, dur: 0 },
      { midis: [64], isGrace: false, dur: 0.5 },
    ]);

    const withoutGrace = buildPracticeSteps(doc, "both", { skipGraceNotes: true });
    expect(withoutGrace.map((s) => ({ midis: s.expectedMidis, isGrace: s.isGrace }))).toEqual([
      { midis: [64], isGrace: false },
    ]);
  });
});

describe("WaitingMode state machine (Absolute Strictness & Hold Duration Verification)", () => {
  it("enforces Absolute Strictness: any wrong note taints the step, clears prior hitMidis, and requires all held keys to be released before retrying", () => {
    const notes: NoteEvent[] = [
      makeNote({ noteUid: "c1-a", midi: 60, hand: "RH", onsetTick: 0, onsetSec: 0 }),
      makeNote({ noteUid: "c1-b", midi: 64, hand: "RH", onsetTick: 0, onsetSec: 0 }),
      makeNote({ noteUid: "c1-lh", midi: 48, hand: "LH", onsetTick: 0, onsetSec: 0 }),
      // Consecutive step with identical MIDI 64
      makeNote({ noteUid: "c2-a", midi: 64, hand: "RH", onsetTick: 4, onsetSec: 0.5 }),
    ];
    const doc = makeScoreDoc(notes);
    const steps = buildPracticeSteps(doc, "rh-only");
    expect(steps).toHaveLength(2);

    let state = createWaitingModeState(0);

    // 1. Hit 60 first -> stays on step 0 with hitMidis={60}
    const r1 = handleWaitingNoteOn(state, steps, 60);
    expect(r1.matched).toBe(true);
    expect(r1.completedStep).toBeNull();
    expect(Array.from(r1.nextState.hitMidis)).toEqual([60]);
    state = r1.nextState;

    // 2. Wrong note 61 -> taints step, clears hitMidis, records faultReason="wrong-note"
    const rWrong = handleWaitingNoteOn(state, steps, 61);
    expect(rWrong.matched).toBe(false);
    expect(rWrong.faultReason).toBe("wrong-note");
    expect(rWrong.nextState.tainted).toBe(true);
    expect(Array.from(rWrong.nextState.hitMidis)).toEqual([]);
    expect(Array.from(rWrong.nextState.wrongMidis)).toEqual([61]);
    state = rWrong.nextState;

    // 3. Pressing the remaining expected note 64 while 60 and 61 are still held is rejected because tainted=true
    const rWhileTainted = handleWaitingNoteOn(state, steps, 64);
    expect(rWhileTainted.matched).toBe(false);
    expect(rWhileTainted.completedStep).toBeNull();
    expect(rWhileTainted.nextState.tainted).toBe(true);
    state = rWhileTainted.nextState;

    // 4. Releasing wrong note 61 alone still leaves 60 & 64 held in activeStepMidis -> still tainted!
    state = handleWaitingNoteOff(state, 61);
    expect(Array.from(state.wrongMidis)).toEqual([]);
    expect(state.tainted).toBe(true);

    // 5. Releasing 60 and 64 clears activeStepMidis -> untaints step for a fresh clean attempt
    state = handleWaitingNoteOff(state, 60);
    expect(state.tainted).toBe(true);
    state = handleWaitingNoteOff(state, 64);
    expect(state.tainted).toBe(false);
    expect(state.lastResetReason).toBeNull();

    // 6. Also verify simultaneous chord holding: pressing 60 then releasing 60 removes it from hitMidis
    state = handleWaitingNoteOn(state, steps, 60).nextState;
    expect(Array.from(state.hitMidis)).toEqual([60]);
    state = handleWaitingNoteOff(state, 60);
    expect(Array.from(state.hitMidis)).toEqual([]);

    // 7. Cleanly hold 60 and 64 simultaneously -> completes step 0 and advances to step 1
    state = handleWaitingNoteOn(state, steps, 60).nextState;
    const r2 = handleWaitingNoteOn(state, steps, 64);
    expect(r2.matched).toBe(true);
    expect(r2.completedStep?.stepIndex).toBe(0);
    expect(r2.completedStep?.accompanimentNotes.map((n) => n.midi)).toEqual([48]);
    expect(r2.advancedToStep?.stepIndex).toBe(1);
    expect(r2.nextState.currentStepIndex).toBe(1);
    expect(Array.from(r2.nextState.hitMidis)).toEqual([]);
    state = r2.nextState;

    // 8. Fresh NoteOn 64 completes step 1 and finishes score
    const r3 = handleWaitingNoteOn(state, steps, 64);
    expect(r3.matched).toBe(true);
    expect(r3.completedScore).toBe(true);
    expect(r3.advancedToStep).toBeNull();
  });

  it("verifies note hold duration (2.A): enters isHolding on clean chord press, rejects early release or mid-hold wrong note, and advances once requiredHoldSec elapses", () => {
    const notes: NoteEvent[] = [
      // Half note (1.0s at 120 BPM) -> at 1.0x speed and 0.8 ratio, requiredHoldSec = 0.8s
      makeNote({ noteUid: "n1", midi: 60, hand: "RH", onsetTick: 0, onsetSec: 0, durationSec: 1.0 }),
      makeNote({ noteUid: "n2", midi: 62, hand: "RH", onsetTick: 8, onsetSec: 1.0, durationSec: 0.5 }),
    ];
    const steps = buildPracticeSteps(makeScoreDoc(notes), "both");
    expect(computeStepRequiredHoldSec(steps[0], 1.0, 0.8)).toBeCloseTo(0.8, 4);
    expect(computeStepRequiredHoldSec(steps[0], 0.5, 0.8)).toBeCloseTo(1.6, 4);

    let state = createWaitingModeState(0);

    // 1. Press 60 at t=1.0s with enforceHoldDuration=true -> enters isHolding, does NOT advance immediately
    const on1 = handleWaitingNoteOn(state, steps, 60, null, {
      enforceHoldDuration: true,
      nowSec: 1.0,
      speedMultiplier: 1.0,
    });
    expect(on1.matched).toBe(true);
    expect(on1.completedStep).toBeNull();
    expect(on1.nextState.isHolding).toBe(true);
    expect(on1.nextState.requiredHoldSec).toBeCloseTo(0.8, 4);
    state = on1.nextState;

    // 2. Advance hold clock to t=1.4s (50% of 0.8s) -> holdProgress = 0.5, still holding
    const progHalf = advanceWaitingHoldProgress(state, steps, 1.4);
    expect(progHalf.completedStep).toBeNull();
    expect(progHalf.nextState.holdProgress).toBeCloseTo(0.5, 3);
    state = progHalf.nextState;

    // 3. Early release at t=1.4s (without sustain pedal) -> fails with faultReason="early-release"
    const offEarly = handleWaitingNoteOffWithResult(state, 60, { sustainPedalPressed: false });
    expect(offEarly.faultReason).toBe("early-release");
    expect(offEarly.nextState.isHolding).toBe(false);
    expect(offEarly.nextState.hitMidis.size).toBe(0);
    expect(offEarly.nextState.lastResetReason).toBe("early-release");
    // Since 60 was the only key held, activeStepMidis is now empty so tainted is false (ready to re-press)
    expect(offEarly.nextState.tainted).toBe(false);
    state = offEarly.nextState;

    // 4. Re-press 60 at t=2.0s and hold until t=2.8s (0.8s elapsed) -> completes step 0 and advances to step 1!
    state = handleWaitingNoteOn(state, steps, 60, null, {
      enforceHoldDuration: true,
      nowSec: 2.0,
      speedMultiplier: 1.0,
    }).nextState;
    expect(state.isHolding).toBe(true);

    const progDone = advanceWaitingHoldProgress(state, steps, 2.81);
    expect(progDone.completedStep?.stepIndex).toBe(0);
    expect(progDone.advancedToStep?.stepIndex).toBe(1);
    expect(progDone.nextState.currentStepIndex).toBe(1);
    expect(progDone.nextState.isHolding).toBe(false);
  });

  it("detects when a NoteOn matches the current paused cursor step", () => {
    const notes: NoteEvent[] = [
      makeNote({ noteUid: "n1", midi: 60, hand: "RH", onsetTick: 0, onsetSec: 0 }),
      makeNote({ noteUid: "n2", midi: 67, hand: "RH", onsetTick: 0, onsetSec: 0 }),
    ];
    const steps = buildPracticeSteps(makeScoreDoc(notes), "both");
    expect(doesNoteOnMatchPausedStep(steps[0], 60)).toBe(true);
    expect(doesNoteOnMatchPausedStep(steps[0], 61)).toBe(false);
    expect(doesNoteOnMatchPausedStep(undefined, 60)).toBe(false);
  });
});

describe("Multi-pass PracticeAnalytics & Repeat Recommendations", () => {
  it("tracks recurrent pitch and duration faults across passes and clusters adjacent trouble measures into actionable A-B Loop prescriptions", () => {
    const steps = [
      {
        stepIndex: 0,
        onsetTick: 0,
        onsetSec: 0,
        measureIndex: 0,
        isGrace: false,
        expectedMidis: [60],
        expectedNotes: [makeNote({ noteUid: "m0", midi: 60, hand: "RH", measureIndex: 0 })],
        accompanimentNotes: [],
        primarySliceId: "s0",
        expectedDurationSec: 0.5,
      },
      {
        stepIndex: 1,
        onsetTick: 16,
        onsetSec: 2,
        measureIndex: 1,
        isGrace: false,
        expectedMidis: [64],
        expectedNotes: [makeNote({ noteUid: "m1", midi: 64, hand: "LH", measureIndex: 1 })],
        accompanimentNotes: [],
        primarySliceId: "s1",
        expectedDurationSec: 1.0,
      },
      {
        stepIndex: 2,
        onsetTick: 32,
        onsetSec: 4,
        measureIndex: 2,
        isGrace: false,
        expectedMidis: [67],
        expectedNotes: [makeNote({ noteUid: "m2", midi: 67, hand: "LH", measureIndex: 2 })],
        accompanimentNotes: [],
        primarySliceId: "s2",
        expectedDurationSec: 1.0,
      },
    ];

    let analytics = createPracticeAnalyticsState();

    // Pass 1: Step 0 clean; Step 1 has 2 wrong-note faults; Step 2 has 1 early-release fault -> finish Pass 1
    analytics = recordPracticeStepCompleted(analytics); // step 0 clean
    analytics = recordPracticeStepFault(analytics, steps[1], "wrong-note", 63);
    analytics = recordPracticeStepFault(analytics, steps[1], "wrong-note", 65);
    analytics = recordPracticeStepCompleted(analytics); // step 1 done
    analytics = recordPracticeStepFault(analytics, steps[2], "early-release", 67);
    analytics = recordPracticeStepCompleted(analytics, { passCompleted: true }); // step 2 done + pass 1 complete

    expect(analytics.completedPasses).toBe(1);
    expect(analytics.totalStepsCompleted).toBe(3);
    expect(analytics.firstTryCleanSteps).toBe(1);
    // Burst of 2 faults in step 1 during Pass 1 only counts as 1 failedPass
    expect(analytics.stepStatsByIndex[1].failedPasses).toBe(1);

    // Pass 2: Step 1 faults again -> recurrentPasses becomes 2!
    analytics = recordPracticeStepCompleted(analytics); // step 0 clean
    analytics = recordPracticeStepFault(analytics, steps[1], "wrong-note", 63);
    analytics = recordPracticeStepCompleted(analytics); // step 1 done
    analytics = recordPracticeStepCompleted(analytics, { passCompleted: true }); // step 2 clean + pass 2 complete

    expect(analytics.completedPasses).toBe(2);
    expect(analytics.stepStatsByIndex[1].failedPasses).toBe(2);

    const summaries = buildMeasureErrorSummaries(analytics);
    expect(summaries.has(0)).toBe(false);
    expect(summaries.get(1)?.recurrentPasses).toBe(2);
    expect(summaries.get(1)?.pitchErrors).toBe(3);
    expect(summaries.get(2)?.durationErrors).toBe(1);

    const warnings: TransitionCue[] = [
      {
        sliceId: "s1",
        hand: "LH",
        measureIndex: 1,
        type: "position-shift",
        severity: "warn",
        cost: 3,
        label: "左手移位",
      },
    ];

    const recs = buildPracticeRepeatRecommendations(analytics, {
      measureCount: 4,
      currentSpeed: 1.0,
      currentPracticeMode: "both",
      isSingleStaff: false,
      warnings,
    });

    // Adjacent trouble measures 1 and 2 (1-based: 第 2–3 小节) are merged into a single recommendation
    expect(recs).toHaveLength(1);
    expect(recs[0].startMeasureIndex).toBe(1);
    expect(recs[0].endMeasureIndex).toBe(2);
    expect(recs[0].recurrentPasses).toBe(2);
    expect(recs[0].recommendedSpeedMultiplier).toBe(0.75);
    expect(recs[0].recommendedPracticeMode).toBe("lh-only");
    expect(recs[0].recommendMetronome).toBe(true);
    expect(recs[0].headline).toContain("第 2–3 小节");
    expect(recs[0].prescription).toContain("仅左手");
    expect(recs[0].prescription).toContain("左手移位");
  });

  it("evaluates 3-pass consecutive clean mastery, graduates mastered measures out of trouble recommendations, and guides hand/speed/next-measure progression", () => {
    const steps = [
      {
        stepIndex: 0,
        onsetTick: 0,
        onsetSec: 0,
        measureIndex: 0,
        isGrace: false,
        expectedMidis: [60],
        expectedNotes: [makeNote({ noteUid: "m0-0", midi: 60, hand: "RH", measureIndex: 0 })],
        accompanimentNotes: [],
        primarySliceId: "s0",
        expectedDurationSec: 0.5,
      },
      {
        stepIndex: 1,
        onsetTick: 4,
        onsetSec: 0.5,
        measureIndex: 0,
        isGrace: false,
        expectedMidis: [62],
        expectedNotes: [makeNote({ noteUid: "m0-1", midi: 62, hand: "RH", measureIndex: 0 })],
        accompanimentNotes: [],
        primarySliceId: "s1",
        expectedDurationSec: 0.5,
      },
    ];

    let analytics = createPracticeAnalyticsState();

    // Pass 1: Fault on step 0 in measure 0 -> cleanStreak = 0, mastered = false
    analytics = recordPracticeStepFault(analytics, steps[0], "wrong-note", 61);
    analytics = recordPracticeStepCompleted(analytics, { completedStep: steps[0], nowSec: 0.5 });
    analytics = recordPracticeStepCompleted(analytics, {
      completedStep: steps[1],
      passCompleted: true,
      nowSec: 1.0,
    });
    expect(analytics.measureCleanStreakByIndex[0]).toBe(0);
    expect(buildMeasureErrorSummaries(analytics).get(0)?.mastered).toBe(false);
    expect(
      buildPracticeRepeatRecommendations(analytics, {
        measureCount: 4,
        currentSpeed: 1.0,
        currentPracticeMode: "both",
      })
    ).toHaveLength(1);

    // Pass 2 & Pass 3: 2 consecutive clean passes -> cleanStreak = 2, status = "recovering"
    for (let pass = 0; pass < 2; pass += 1) {
      analytics = recordPracticeStepCompleted(analytics, {
        completedStep: steps[0],
        nowSec: 2.0 + pass * 2,
      });
      analytics = recordPracticeStepCompleted(analytics, {
        completedStep: steps[1],
        passCompleted: true,
        nowSec: 2.5 + pass * 2,
      });
    }
    expect(analytics.measureCleanStreakByIndex[0]).toBe(2);
    expect(buildMeasureErrorSummaries(analytics).get(0)?.status).toBe("recovering");

    const progBeforeMastery = evaluatePracticeProgression(analytics, {
      measureCount: 4,
      abLoop: { startMeasureIndex: 0, endMeasureIndex: 0, enabled: true, loopGap: false },
      currentSpeed: 1.0,
      currentPracticeMode: "both",
    });
    expect(progBeforeMastery.stage).toBe("practicing");
    expect(progBeforeMastery.cleanStreak).toBe(2);
    expect(progBeforeMastery.isCleanStreakMet).toBe(false);

    // Pass 4: 3rd consecutive clean pass (with a hesitation gap of 3.0s between step 0 and step 1) -> cleanStreak = 3, mastered = true!
    analytics = recordPracticeStepCompleted(analytics, {
      completedStep: steps[0],
      nowSec: 10.0,
    });
    analytics = recordPracticeStepCompleted(analytics, {
      completedStep: steps[1],
      passCompleted: true,
      nowSec: 13.0,
    });

    const summaryAfter3 = buildMeasureErrorSummaries(analytics).get(0);
    expect(summaryAfter3?.cleanStreak).toBe(3);
    expect(summaryAfter3?.mastered).toBe(true);
    expect(summaryAfter3?.status).toBe("mastered");
    expect(summaryAfter3?.hesitationCount).toBe(1);

    // Mastered measure automatically graduates out of trouble repeat recommendations!
    expect(
      buildPracticeRepeatRecommendations(analytics, {
        measureCount: 4,
        currentSpeed: 1.0,
        currentPracticeMode: "both",
      })
    ).toHaveLength(0);

    // Verify staged graduation guidance:
    // 1) If currently in single-hand mode ("rh-only"), advises restoring both hands ("step-up-hand")
    const progSingleHand = evaluatePracticeProgression(analytics, {
      measureCount: 4,
      abLoop: { startMeasureIndex: 0, endMeasureIndex: 0, enabled: true, loopGap: false },
      currentSpeed: 0.75,
      currentPracticeMode: "rh-only",
      isSingleStaff: false,
    });
    expect(progSingleHand.stage).toBe("step-up-hand");
    expect(progSingleHand.recommendedNextPracticeMode).toBe("both");

    // 2) If in both-hands mode at slow speed (0.75x), advises stepping up speed ("step-up-speed")
    const progSlowSpeed = evaluatePracticeProgression(analytics, {
      measureCount: 4,
      abLoop: { startMeasureIndex: 0, endMeasureIndex: 0, enabled: true, loopGap: false },
      currentSpeed: 0.75,
      targetSpeed: 1.0,
      currentPracticeMode: "both",
      isSingleStaff: false,
    });
    expect(progSlowSpeed.stage).toBe("step-up-speed");
    expect(progSlowSpeed.recommendedNextSpeedMultiplier).toBe(0.9);

    // 3) If in both-hands mode at target speed (1.0x), advises advancing to next measure ("ready-next-measure")
    const progReadyNext = evaluatePracticeProgression(analytics, {
      measureCount: 4,
      abLoop: { startMeasureIndex: 0, endMeasureIndex: 0, enabled: true, loopGap: false },
      currentSpeed: 1.0,
      targetSpeed: 1.0,
      currentPracticeMode: "both",
      isSingleStaff: false,
    });
    expect(progReadyNext.stage).toBe("ready-next-measure");
    expect(progReadyNext.nextStartMeasureIndex).toBe(1);
    expect(progReadyNext.nextEndMeasureIndex).toBe(1);
    expect(progReadyNext.bridgeStartMeasureIndex).toBe(0);
    expect(progReadyNext.bridgeEndMeasureIndex).toBe(1);
    expect(progReadyNext.recentPassHadHesitation).toBe(true);

    // Resetting streak for a new difficulty stage resets cleanStreak back to 0
    const afterReset = resetMeasureCleanStreak(analytics, 0, 0);
    expect(afterReset.measureCleanStreakByIndex[0]).toBe(0);
  });
});

describe("PlaybackEngine metronome pause/resume for Waiting Mode", () => {
  it("cancels pending clicks when paused and triggers beat on resume/step advance", () => {
    const oscStarts: number[] = [];
    const oscStops: number[] = [];
    const ctx = {
      currentTime: 0,
      state: "running",
      destination: {} as AudioDestinationNode,
      resume: vi.fn(async () => {}),
      createGain: vi.fn(() => ({
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
          cancelScheduledValues: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      })),
      createOscillator: vi.fn(() => ({
        type: "sine",
        frequency: { value: 440, setValueAtTime: vi.fn() },
        start: vi.fn((t: number) => oscStarts.push(t)),
        stop: vi.fn((t: number) => oscStops.push(t)),
        connect: vi.fn(),
        disconnect: vi.fn(),
      })),
    } as unknown as AudioContext;

    const audioEngine = createPianoAudioEngine({ getAudioContext: () => ctx });
    const beats: unknown[] = [];
    const engine = createPlaybackEngine({
      audioEngine,
      onMetronomeBeat: (b) => beats.push(b),
    });

    engine.setMetronomeEnabled(true);
    engine.setMetronomePaused(true);
    expect(engine.isMetronomePaused()).toBe(true);

    // While paused, triggerMetronomeBeat should not fire clicks
    engine.triggerMetronomeBeat({
      measureIndex: 0,
      beatIndex: 0,
      beatNumber: 1,
      totalBeats: 4,
      isAccent: true,
      isCountIn: false,
    });
    expect(oscStarts).toHaveLength(0);

    // Unpause -> triggers click on step advance
    engine.setMetronomePaused(false);
    expect(engine.isMetronomePaused()).toBe(false);
    engine.triggerMetronomeBeat({
      measureIndex: 0,
      beatIndex: 1,
      beatNumber: 2,
      totalBeats: 4,
      isAccent: false,
      isCountIn: false,
    });
    expect(oscStarts).toHaveLength(1);
    expect(beats.length).toBeGreaterThan(0);
    engine.dispose();
  });
});
