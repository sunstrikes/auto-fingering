// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { normalizeAbLoopBounds, type AbLoopBounds } from "../src/domain/types";
import {
  buildPracticeSteps,
  createWaitingModeState,
  findAbLoopStepRange,
  handleWaitingNoteOn,
} from "../src/practice/waitingMode";
import { parseMusicXml } from "../src/musicxml/parser";
import { createPianoAudioEngine } from "../src/audio/pianoAudio";
import { createPlaybackEngine } from "../src/audio/playbackEngine";
import type { MetronomeBeatEvent } from "../src/audio/metronome";

const FOUR_MEASURE_LOOP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction placement="above"><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration><type>whole</type><staff>1</staff></note>
    </measure>
    <measure number="2">
      <attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>12</duration><type>half</type><dot/><staff>1</staff></note>
    </measure>
    <measure number="3">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>12</duration><type>half</type><dot/><staff>1</staff></note>
    </measure>
    <measure number="4">
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>12</duration><type>half</type><dot/><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;

function createTrackingAudioContext(initialTime = 0) {
  const oscillators: Array<{
    type: OscillatorType;
    frequency: { setValueAtTime: ReturnType<typeof vi.fn> };
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];

  const rawCtx = {
    currentTime: initialTime,
    state: "running" as AudioContextState,
    destination: {},
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
    })),
    createOscillator: vi.fn(() => {
      const osc = {
        type: "sine" as OscillatorType,
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(osc);
      return osc;
    }),
  };

  return {
    ctx: rawCtx as unknown as AudioContext,
    rawCtx,
    oscillators,
  };
}

function createManualRaf() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      callbacks.delete(id);
    },
    tick: (timeMs = 16) => {
      const entries = [...callbacks.entries()];
      callbacks.clear();
      for (const [, cb] of entries) cb(timeMs);
    },
  };
}

describe("Slice 1: AbLoopBounds normalization", () => {
  it("auto-normalizes reversed bounds so startMeasureIndex <= endMeasureIndex and clamps to measureCount", () => {
    const reversed: AbLoopBounds = {
      startMeasureIndex: 5,
      endMeasureIndex: 2,
      enabled: true,
      loopGap: true,
    };

    expect(normalizeAbLoopBounds(reversed, 8)).toEqual({
      startMeasureIndex: 2,
      endMeasureIndex: 5,
      enabled: true,
      loopGap: true,
    });

    const outOfRange: AbLoopBounds = {
      startMeasureIndex: -3,
      endMeasureIndex: 99,
      enabled: false,
      loopGap: false,
    };

    expect(normalizeAbLoopBounds(outOfRange, 4)).toEqual({
      startMeasureIndex: 0,
      endMeasureIndex: 3,
      enabled: false,
      loopGap: false,
    });
  });
});


describe("Slice 2: PlaybackEngine whole-measure A-B Loop & Loop Gap", () => {
  it("wraps seamlessly from end of measure B back to measure A while preserving SpeedMultiplier and metronome beat alignment", async () => {
    const { ctx, rawCtx, oscillators } = createTrackingAudioContext(0);
    const raf = createManualRaf();
    const triggeredNotes: Array<{ midi: number; time: number; duration: number }> = [];

    const audioEngine = createPianoAudioEngine({
      getAudioContext: () => ctx,
      loadSmplrPiano: async () => ({
        load: Promise.resolve(),
        start: (note) => {
          triggeredNotes.push({
            midi: Number(note.note),
            time: note.time ?? 0,
            duration: note.duration ?? 0,
          });
        },
        stop: vi.fn(),
      }),
    });

    const beatEvents: Array<MetronomeBeatEvent | null> = [];
    const engine = createPlaybackEngine({
      audioEngine,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
      scheduleAheadRealSec: 1.0,
      onMetronomeBeat: (b) => beatEvents.push(b),
    });

    const doc = parseMusicXml(FOUR_MEASURE_LOOP_XML, { DOMParser: window.DOMParser });
    // Measure 0: 4/4 at 120 BPM = 2.0s (C4=60)
    // Measure 1: 3/4 at 120 BPM = 1.5s (D4=62), scoreSec [2.0, 3.5)
    // Measure 2: 3/4 at 120 BPM = 1.5s (E4=64), scoreSec [3.5, 5.0)
    // Measure 3: 3/4 at 120 BPM = 1.5s (F4=65), scoreSec [5.0, 6.5)
    // Loop [1..2] at 0.5x speed -> loop duration = (1.5 + 1.5) / 0.5 = 6.0 real seconds
    engine.setSpeed(0.5);
    engine.setMetronomeEnabled(true);
    engine.setAbLoop({
      startMeasureIndex: 2,
      endMeasureIndex: 1, // reversed -> normalizes to [1..2]
      enabled: true,
      loopGap: false,
    });

    await engine.play(doc);

    // Should start at measure 1 (D4=62), NOT measure 0 (C4=60)
    expect(triggeredNotes.map((n) => n.midi)).toEqual([62]);
    expect(triggeredNotes[0].time).toBeCloseTo(0, 5);
    expect(beatEvents.at(-1)).toMatchObject({
      measureIndex: 1,
      beatNumber: 1,
      totalBeats: 3,
      isAccent: true,
      isCountIn: false,
    });

    // Advance to realTime = 3.0s (scoreSec = 2.0 + 3.0 * 0.5 = 3.5 -> measure 2 starts)
    rawCtx.currentTime = 3.0;
    raf.tick();
    expect(triggeredNotes.map((n) => n.midi)).toEqual([62, 64]);
    expect(triggeredNotes[1].time).toBeCloseTo(3.0, 5);

    // Advance past end of measure 2 (realTime = 6.0s -> wraps back to measure 1 at realTime = 6.0s)
    // Measure 3 (F4=65) must NEVER be scheduled!
    rawCtx.currentTime = 6.05;
    raf.tick();
    expect(engine.getState()).toBe("playing");
    expect(triggeredNotes.map((n) => n.midi)).toEqual([62, 64, 62]);
    expect(triggeredNotes[2].time).toBeCloseTo(6.0, 5);

    // Metronome beat 1 of measure 1 fires at wrap (no measure 3 beat)
    const nonNullBeats = beatEvents.filter((b): b is MetronomeBeatEvent => b !== null);
    expect(nonNullBeats.every((b) => b.measureIndex >= 1 && b.measureIndex <= 2)).toBe(true);
    expect(nonNullBeats.at(-1)).toMatchObject({
      measureIndex: 1,
      beatNumber: 1,
      isAccent: true,
      isCountIn: false,
    });
    expect(oscillators.length).toBeGreaterThan(0);

    engine.dispose();
  });

  it("inserts one full measure of Count-In clicks at measure A's meter when loopGap is enabled", async () => {
    const { ctx, rawCtx } = createTrackingAudioContext(0);
    const raf = createManualRaf();
    const triggeredNotes: Array<{ midi: number; time: number }> = [];

    const audioEngine = createPianoAudioEngine({
      getAudioContext: () => ctx,
      loadSmplrPiano: async () => ({
        load: Promise.resolve(),
        start: (note) => {
          triggeredNotes.push({ midi: Number(note.note), time: note.time ?? 0 });
        },
        stop: vi.fn(),
      }),
    });

    const beatEvents: Array<MetronomeBeatEvent | null> = [];
    const engine = createPlaybackEngine({
      audioEngine,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
      scheduleAheadRealSec: 1.0,
      onMetronomeBeat: (b) => beatEvents.push(b),
    });

    const doc = parseMusicXml(FOUR_MEASURE_LOOP_XML, { DOMParser: window.DOMParser });
    // Loop [1..1] (measure 1 is 3/4 at 120 BPM = 1.5s) at 1.0x speed with loopGap: true
    engine.setAbLoop({
      startMeasureIndex: 1,
      endMeasureIndex: 1,
      enabled: true,
      loopGap: true,
    });

    await engine.play(doc);
    expect(triggeredNotes).toEqual([{ midi: 62, time: 0 }]);

    // Wrap at t = 1.5s -> inserts 1 full 3/4 measure of Count-In clicks [1.5, 2.0, 2.5],
    // then restarts measure 1 at t = 3.0s
    rawCtx.currentTime = 1.52;
    raf.tick();
    expect(beatEvents.at(-1)).toMatchObject({
      measureIndex: 1,
      beatNumber: 1,
      totalBeats: 3,
      isAccent: true,
      isCountIn: true,
      countdownRemaining: 3,
    });

    rawCtx.currentTime = 2.52;
    raf.tick();
    expect(beatEvents.at(-1)).toMatchObject({
      measureIndex: 1,
      beatNumber: 3,
      totalBeats: 3,
      isAccent: false,
      isCountIn: true,
      countdownRemaining: 1,
    });

    // At t = 3.0s, measure 1 restarts
    rawCtx.currentTime = 3.02;
    raf.tick();
    expect(triggeredNotes).toEqual([
      { midi: 62, time: 0 },
      { midi: 62, time: 3.0 },
    ]);

    engine.dispose();
  });

  it("plays a standalone one-measure Count-In via playCountIn and invokes onComplete at bar end", async () => {
    const { ctx, rawCtx } = createTrackingAudioContext(0);
    const raf = createManualRaf();

    const audioEngine = createPianoAudioEngine({
      getAudioContext: () => ctx,
      loadSmplrPiano: async () => ({
        load: Promise.resolve(),
        start: vi.fn(),
        stop: vi.fn(),
      }),
    });

    const beatEvents: Array<MetronomeBeatEvent | null> = [];
    const engine = createPlaybackEngine({
      audioEngine,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
      onMetronomeBeat: (b) => beatEvents.push(b),
    });

    const doc = parseMusicXml(FOUR_MEASURE_LOOP_XML, { DOMParser: window.DOMParser });
    const onComplete = vi.fn();

    await engine.playCountIn(doc, 1, onComplete);
    expect(onComplete).not.toHaveBeenCalled();
    expect(beatEvents.at(-1)).toMatchObject({
      measureIndex: 1,
      beatNumber: 1,
      totalBeats: 3,
      isCountIn: true,
      countdownRemaining: 3,
    });

    rawCtx.currentTime = 1.5;
    raf.tick();
    expect(onComplete).toHaveBeenCalledTimes(1);

    engine.dispose();
  });
});


describe("Slice 3: Pure WaitingMode A-B Loop wrapping", () => {
  it("wraps from completing measure B's final PracticeStep back to measure A's first PracticeStep", () => {
    const doc = parseMusicXml(FOUR_MEASURE_LOOP_XML, { DOMParser: window.DOMParser });
    const steps = buildPracticeSteps(doc, "both");
    // steps: [0: m0 C4(60), 1: m1 D4(62), 2: m2 E4(64), 3: m3 F4(65)]
    const loopBounds: AbLoopBounds = {
      startMeasureIndex: 1,
      endMeasureIndex: 2,
      enabled: true,
      loopGap: false,
    };

    const range = findAbLoopStepRange(steps, loopBounds);
    expect(range).toEqual({ startStepIndex: 1, endStepIndex: 2 });

    // Start at measure 1 (step 1: D4=62)
    let state = createWaitingModeState(range!.startStepIndex);
    const res1 = handleWaitingNoteOn(state, steps, 62, loopBounds);
    expect(res1.matched).toBe(true);
    expect(res1.loopWrapped).toBe(false);
    expect(res1.advancedToStep?.measureIndex).toBe(2);
    state = res1.nextState;

    // Complete measure 2's final step (step 2: E4=64) -> wraps back to step 1 (measure 1, D4=62)
    const res2 = handleWaitingNoteOn(state, steps, 64, loopBounds);
    expect(res2.matched).toBe(true);
    expect(res2.completedScore).toBe(false);
    expect(res2.loopWrapped).toBe(true);
    expect(res2.completedStep?.measureIndex).toBe(2);
    expect(res2.advancedToStep?.stepIndex).toBe(1);
    expect(res2.nextState.currentStepIndex).toBe(1);
    expect(res2.nextState.hitMidis.size).toBe(0);
  });
});
