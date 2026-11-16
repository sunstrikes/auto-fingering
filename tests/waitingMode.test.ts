import { describe, it, expect, vi } from "vitest";
import type { NoteEvent, OnsetSlice, ScoreDocument } from "../src/domain/types";
import { createPianoAudioEngine } from "../src/audio/pianoAudio";
import { createPlaybackEngine } from "../src/audio/playbackEngine";
import {
  buildPracticeSteps,
  createWaitingModeState,
  doesNoteOnMatchPausedStep,
  handleWaitingNoteOff,
  handleWaitingNoteOn,
} from "../src/practice/waitingMode";

function makeNote(overrides: Partial<NoteEvent> & { noteUid: string; midi: number; hand: "RH" | "LH" }): NoteEvent {
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
  it("merges simultaneous RH and LH non-TieContinuation notes and partitions by PracticeMode", () => {
    const notes: NoteEvent[] = [
      makeNote({ noteUid: "rh-1", midi: 64, hand: "RH", onsetTick: 0, onsetSec: 0 }),
      makeNote({ noteUid: "rh-2", midi: 67, hand: "RH", onsetTick: 0, onsetSec: 0 }),
      makeNote({ noteUid: "lh-1", midi: 48, hand: "LH", onsetTick: 0, onsetSec: 0 }),
      // Tie continuation at tick 4 should be excluded
      makeNote({ noteUid: "rh-tie", midi: 64, hand: "RH", onsetTick: 4, onsetSec: 0.5, isTieStop: true }),
      makeNote({ noteUid: "lh-2", midi: 55, hand: "LH", onsetTick: 4, onsetSec: 0.5 }),
      // Repeated pitch at tick 8
      makeNote({ noteUid: "rh-3", midi: 64, hand: "RH", onsetTick: 8, onsetSec: 1.0 }),
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
    expect(bothSteps[0].accompanimentNotes).toEqual([]);
    expect(bothSteps[0].primarySliceId).toBe("s0");
    expect(bothSteps[1].expectedMidis).toEqual([55]);
    expect(bothSteps[2].expectedMidis).toEqual([64]);

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

  it("orders grace notes sequentially before their main beat and skips them when skipGraceNotes is true", () => {
    const notes: NoteEvent[] = [
      makeNote({ noteUid: "g2", midi: 62, hand: "RH", onsetTick: 4, onsetSec: 0.5, isGrace: true, graceOrder: 1 }),
      makeNote({ noteUid: "g1", midi: 61, hand: "RH", onsetTick: 4, onsetSec: 0.5, isGrace: true, graceOrder: 0 }),
      makeNote({ noteUid: "main", midi: 64, hand: "RH", onsetTick: 4, onsetSec: 0.5, isGrace: false }),
    ];
    const doc = makeScoreDoc(notes);

    const withGrace = buildPracticeSteps(doc, "both", { skipGraceNotes: false });
    expect(withGrace.map((s) => ({ midis: s.expectedMidis, isGrace: s.isGrace }))).toEqual([
      { midis: [61], isGrace: true },
      { midis: [62], isGrace: true },
      { midis: [64], isGrace: false },
    ]);

    const withoutGrace = buildPracticeSteps(doc, "both", { skipGraceNotes: true });
    expect(withoutGrace.map((s) => ({ midis: s.expectedMidis, isGrace: s.isGrace }))).toEqual([
      { midis: [64], isGrace: false },
    ]);
  });
});

describe("WaitingMode state machine", () => {
  it("supports cumulative rolled chord matching, anti-bleed on consecutive identical pitches, and wrongMidis retention", () => {
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

    // Rolled chord: hit 60 first -> stays on step 0 with hitMidis={60}
    const r1 = handleWaitingNoteOn(state, steps, 60);
    expect(r1.matched).toBe(true);
    expect(r1.completedStep).toBeNull();
    expect(r1.nextState.currentStepIndex).toBe(0);
    expect(Array.from(r1.nextState.hitMidis)).toEqual([60]);
    state = r1.nextState;

    // Wrong note 61 -> added to wrongMidis, hitMidis={60} preserved
    const rWrong = handleWaitingNoteOn(state, steps, 61);
    expect(rWrong.matched).toBe(false);
    expect(Array.from(rWrong.nextState.hitMidis)).toEqual([60]);
    expect(Array.from(rWrong.nextState.wrongMidis)).toEqual([61]);
    state = rWrong.nextState;

    // NoteOff 61 clears wrongMidis without clearing hitMidis
    state = handleWaitingNoteOff(state, 61);
    expect(Array.from(state.wrongMidis)).toEqual([]);
    expect(Array.from(state.hitMidis)).toEqual([60]);

    // Wrong note 62 pressed again, then completing chord with 64 advances and clears both hitMidis & wrongMidis
    state = handleWaitingNoteOn(state, steps, 62).nextState;
    const r2 = handleWaitingNoteOn(state, steps, 64);
    expect(r2.matched).toBe(true);
    expect(r2.completedStep?.stepIndex).toBe(0);
    expect(r2.completedStep?.accompanimentNotes.map((n) => n.midi)).toEqual([48]);
    expect(r2.advancedToStep?.stepIndex).toBe(1);
    expect(r2.completedScore).toBe(false);
    expect(r2.nextState.currentStepIndex).toBe(1);
    // Anti-bleed: hitMidis must be empty on step 1 even though 64 was just played for step 0
    expect(Array.from(r2.nextState.hitMidis)).toEqual([]);
    expect(Array.from(r2.nextState.wrongMidis)).toEqual([]);
    state = r2.nextState;

    // Fresh NoteOn 64 completes step 1 and finishes score
    const r3 = handleWaitingNoteOn(state, steps, 64);
    expect(r3.matched).toBe(true);
    expect(r3.completedScore).toBe(true);
    expect(r3.advancedToStep).toBeNull();
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
