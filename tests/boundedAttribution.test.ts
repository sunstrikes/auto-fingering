// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attributeContinuousBout } from "../src/guided/boundedAttribution";
import { createSimulatedMidiHarness, type SimulatedMidiStep } from "../src/midi/simulatedMidiHarness";
import { createWebMidiController, type MidiInputEvent } from "../src/midi/webMidi";
import { createMidiSessionCapture } from "../src/midi/midiSessionCapture";
import { createPianoAudioEngine } from "../src/audio/pianoAudio";
import { createPlaybackEngine, type PlaybackClockAnchor } from "../src/audio/playbackEngine";
import { parseMusicXml } from "../src/musicxml/parser";
import { buildPracticeSteps } from "../src/practice/waitingMode";
import { perfBudget } from "./perfBudget";
import type { MeasureTimeline, NoteEvent, PracticeStep } from "../src/domain/types";

function makeMeasureTimelines(count: number, bpm = 120, beats = 4, beatType = 4): MeasureTimeline[] {
  const beatSec = (60 / bpm) * (4 / beatType);
  const measureSec = beats * beatSec;
  const ticksPerBeat = 480 * (4 / beatType);
  const measureTicks = beats * ticksPerBeat;
  return Array.from({ length: count }, (_, m) => ({
    measureIndex: m,
    startTick: m * measureTicks,
    endTick: (m + 1) * measureTicks,
    startSec: m * measureSec,
    endSec: (m + 1) * measureSec,
    timeBeats: beats,
    timeBeatType: beatType,
    isPickup: false,
  }));
}

function makeSteps(
  defs: ReadonlyArray<{
    onsetSec: number;
    measureIndex?: number;
    notes: ReadonlyArray<{ midi: number; hand?: "RH" | "LH"; durationSec?: number }>;
    isGrace?: boolean;
  }>,
  beatSec = 0.5
): PracticeStep[] {
  return defs.map((d, stepIndex) => {
    const measureIndex = d.measureIndex ?? Math.floor(d.onsetSec / (4 * beatSec));
    const expectedNotes: NoteEvent[] = d.notes.map((n, ni) => ({
      noteUid: `n-${stepIndex}-${ni}`,
      measureIndex,
      onsetTick: Math.round(d.onsetSec * 960),
      durationTick: Math.round((n.durationSec ?? beatSec) * 960),
      onsetSec: d.onsetSec,
      durationSec: n.durationSec ?? beatSec,
      midi: n.midi,
      hand: n.hand ?? "RH",
      voice: "1",
      staff: (n.hand ?? "RH") === "RH" ? 1 : 2,
      isGrace: Boolean(d.isGrace),
      isTieStop: false,
      isTieStart: false,
    }));
    const expectedMidis = [...new Set(expectedNotes.map((n) => n.midi))].sort((a, b) => a - b);
    return {
      stepIndex,
      onsetTick: Math.round(d.onsetSec * 960),
      onsetSec: d.onsetSec,
      measureIndex,
      isGrace: Boolean(d.isGrace),
      expectedMidis,
      expectedNotes,
      accompanimentNotes: [],
      primarySliceId: `s-${stepIndex}`,
      expectedDurationSec: d.isGrace ? 0 : Math.min(...expectedNotes.map((n) => n.durationSec)),
    };
  });
}

describe("Bounded Window Attribution", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("calibrates +80 ms fixed audio/BLE entry latency via SimulatedMidiHarness -> WebMIDI -> MidiSessionCapture without false lateness", async () => {
    const harness = createSimulatedMidiHarness();
    const capture = createMidiSessionCapture();
    capture.setMode("continuous");
    capture.setTransport("playing", true);

    const controller = createWebMidiController({
      requestMIDIAccess: harness.requestMIDIAccess,
      onStateChange: () => {},
      onMidiEvent: (ev) => capture.record(ev),
    });
    await controller.connect();

    // 8 quarter-note steps at 120 BPM (0.5s apart) starting at t0PerfMs = 1000
    const steps = makeSteps([
      { onsetSec: 0.0, notes: [{ midi: 60, hand: "RH" }, { midi: 48, hand: "LH" }] },
      { onsetSec: 0.5, notes: [{ midi: 62, hand: "RH" }] },
      { onsetSec: 1.0, notes: [{ midi: 64, hand: "RH" }] },
      { onsetSec: 1.5, notes: [{ midi: 65, hand: "RH" }] },
      { onsetSec: 2.0, notes: [{ midi: 67, hand: "RH" }, { midi: 43, hand: "LH" }] },
      { onsetSec: 2.5, notes: [{ midi: 65, hand: "RH" }] },
      { onsetSec: 3.0, notes: [{ midi: 64, hand: "RH" }] },
      { onsetSec: 3.5, notes: [{ midi: 62, hand: "RH" }] },
    ]);

    vi.advanceTimersByTime(1000);
    const clockAnchor: PlaybackClockAnchor = {
      t0PerfMs: performance.now(),
      audioStartTimeSec: 1.0,
      startScoreSec: 0,
      endScoreSec: 4.0,
      speedMultiplier: 1.0,
    };

    const simSteps: SimulatedMidiStep[] = steps.map((s) => ({
      stepIndex: s.stepIndex,
      onsetMs: s.onsetSec * 1000,
      notes: s.expectedNotes.map((n) => ({ midi: n.midi, hand: n.hand, durationMs: 250 })),
    }));

    harness.play(simSteps, {
      speedMultiplier: 1.0,
      entryLatencyMs: 80,
      timingJitterMs: 5,
    });
    vi.advanceTimersByTime(4500);
    controller.dispose();

    const captured = capture.sliceWindow(clockAnchor.t0PerfMs - 200, clockAnchor.t0PerfMs + 5000, {
      mode: "continuous",
      transport: "playing",
    });

    const result = attributeContinuousBout({
      clockAnchor,
      expectedSteps: steps,
      midiEvents: captured,
      measureTimelines: makeMeasureTimelines(2, 120),
    });

    expect(result.calibratedEntryOffsetMs).toBeGreaterThanOrEqual(72);
    expect(result.calibratedEntryOffsetMs).toBeLessThanOrEqual(88);
    expect(result.matchedNotes).toHaveLength(10);
    expect(result.missedNotes).toHaveLength(0);
    expect(result.extraEvents).toHaveLength(0);
    expect(result.fluency.pitchAccuracy).toBe(1);
    expect(result.fluency.stallDetected).toBe(false);
    expect(result.fluency.reanchorCount).toBe(0);
    for (const m of result.matchedNotes) {
      expect(Math.abs(m.timingErrorMs)).toBeLessThanOrEqual(15);
    }
  });

  it("isolates missed notes/chords without cascading mismatch, filters velocity <= 1 ghost touches and exempt keys, and excludes extra strikes from timingCv", () => {
    const steps = makeSteps([
      { onsetSec: 0.0, notes: [{ midi: 60, hand: "RH" }, { midi: 48, hand: "LH" }] },
      { onsetSec: 0.5, notes: [{ midi: 62, hand: "RH" }, { midi: 50, hand: "LH" }] }, // missed chord
      { onsetSec: 1.0, notes: [{ midi: 64, hand: "RH" }] }, // missed single note
      { onsetSec: 1.5, notes: [{ midi: 65, hand: "RH" }] },
      { onsetSec: 2.0, notes: [{ midi: 67, hand: "RH" }, { midi: 43, hand: "LH" }] },
      { onsetSec: 2.5, notes: [{ midi: 69, hand: "RH" }] },
    ]);
    const t0 = 2000;
    const clockAnchor: PlaybackClockAnchor = {
      t0PerfMs: t0,
      audioStartTimeSec: 2.0,
      startScoreSec: 0,
      endScoreSec: 3.0,
      speedMultiplier: 1.0,
    };

    const noteOn = (midi: number, velocity: number, offsetMs: number): MidiInputEvent => ({
      type: "noteon",
      midi,
      velocity,
      channel: 0,
      portId: "sim",
      source: "midi",
      timeStampMs: t0 + offsetMs,
    });

    const midiEvents: MidiInputEvent[] = [
      noteOn(60, 88, 0),
      noteOn(48, 66, 2),
      // Ghost touch (velocity === 1) near step 1
      noteOn(61, 1, 510),
      // Exempt B0 peek key (midi 23) during step 2
      noteOn(23, 80, 1020),
      // Exempt A0 + A#0 command keys
      noteOn(21, 90, 1250),
      noteOn(22, 90, 1250),
      // Step 3 matched cleanly
      noteOn(65, 84, 1500),
      // Extra wrong note right next to step 3/4 (should affect pitchAccuracy, NOT timingCv)
      noteOn(66, 78, 1620),
      // Step 4 & 5 matched cleanly on grid
      noteOn(67, 85, 2000),
      noteOn(43, 64, 2000),
      noteOn(69, 86, 2500),
    ];

    const result = attributeContinuousBout({
      clockAnchor,
      expectedSteps: steps,
      midiEvents,
      measureTimelines: makeMeasureTimelines(2, 120),
      isExemptCommandKey: (ev) => ev.type === "noteon" && (ev.midi === 21 || ev.midi === 22),
      isExemptPeekKey: (ev) => ev.type === "noteon" && ev.midi === 23,
    });

    // Steps 0, 3, 4, 5 matched cleanly (6 notes); steps 1 & 2 missed (3 notes); 1 extra (66)
    expect(result.matchedNotes.map((m) => m.note.midi)).toEqual([60, 48, 65, 67, 43, 69]);
    expect(result.missedNotes.map((m) => m.note.midi)).toEqual([62, 50, 64]);
    expect(result.extraEvents.map((e) => e.type === "noteon" ? e.midi : -1)).toEqual([66]);
    expect(result.filteredGhostCount).toBe(1);
    expect(result.filteredExemptCount).toBe(3);

    // pitchAccuracy = 6 / (9 expected + 1 extra) = 0.6
    expect(result.fluency.pitchAccuracy).toBeCloseTo(0.6, 5);
    // Matched steps are unpolluted by the extra note at 1620ms (same timingCv with or without extra note)
    const withoutExtra = attributeContinuousBout({
      clockAnchor,
      expectedSteps: steps,
      midiEvents: midiEvents.filter((e) => !(e.type === "noteon" && e.midi === 66)),
      measureTimelines: makeMeasureTimelines(2, 120),
      isExemptCommandKey: (ev) => ev.type === "noteon" && (ev.midi === 21 || ev.midi === 22),
      isExemptPeekKey: (ev) => ev.type === "noteon" && ev.midi === 23,
    });
    expect(result.fluency.timingCv).toBe(withoutExtra.fluency.timingCv);
    expect(result.fluency.timingCv).toBeLessThan(0.001);
    expect(result.measureFaultCounts).toEqual({
      0: { missed: 3, extra: 1, hesitations: 0 },
    });
    // 2 RH missed + 1 extra inferred RH (66 near 65) + 1 LH missed = 3 RH / 4 total = 0.75
    expect(result.fluency.dominantHandFaultRatio.rh).toBeCloseTo(0.75, 5);
    expect(result.fluency.dominantHandFaultRatio.lh).toBeCloseTo(0.25, 5);
  });

  it("re-anchors locally on strong beats up to 2 times for > 0.6 beat stalls, distinguishes interior vs junction hesitations, and flags stallDetected when cap exceeded or severe", () => {
    const timelines = makeMeasureTimelines(4, 120); // 1 beat = 500ms, 4 beats/bar
    // 16 quarter-note steps across 4 measures (strong beats at indices 0,2,4,6,8,10,12,14)
    const steps = makeSteps(
      Array.from({ length: 16 }, (_, i) => ({
        onsetSec: i * 0.5,
        measureIndex: Math.floor(i / 4),
        notes: [{ midi: 60 + (i % 8), hand: "RH" }],
      }))
    );

    const t0 = 5000;
    const anchor: PlaybackClockAnchor = {
      t0PerfMs: t0,
      audioStartTimeSec: 0,
      startScoreSec: 0,
      endScoreSec: 8.0,
      speedMultiplier: 1.0,
    };

    const makeEventsWithStalls = (stallAtSteps: Record<number, number>): MidiInputEvent[] => {
      let accShift = 0;
      return steps.map((s) => {
        accShift += stallAtSteps[s.stepIndex] ?? 0;
        return {
          type: "noteon",
          midi: s.expectedMidis[0],
          velocity: 84,
          channel: 0,
          portId: "sim",
          source: "midi",
          timeStampMs: t0 + s.onsetSec * 1000 + accShift,
        };
      });
    };

    // Case 1: 1 moderate interior stall (+450ms = 0.9 beat) at strong beat step 4 (measure 1 beat 1)
    const interiorStall = attributeContinuousBout({
      clockAnchor: anchor,
      expectedSteps: steps,
      midiEvents: makeEventsWithStalls({ 4: 450 }),
      measureTimelines: timelines,
      junctionBoundaryCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
    });
    expect(interiorStall.fluency.reanchorCount).toBe(1);
    expect(interiorStall.fluency.interiorHesitationCount).toBe(1);
    expect(interiorStall.fluency.junctionHesitationRatio).toBeCloseTo(1.0, 2);
    expect(interiorStall.fluency.stallDetected).toBe(false);
    expect(interiorStall.matchedNotes).toHaveLength(16);
    expect(interiorStall.hesitationBreaks[0]).toMatchObject({
      stepIndex: 4,
      measureIndex: 1,
      isJunction: false,
      reanchored: true,
    });

    // Case 2: Stall right at Chunk Junction (measure 2 beat 1, step 8, +450ms)
    const junctionStall = attributeContinuousBout({
      clockAnchor: anchor,
      expectedSteps: steps,
      midiEvents: makeEventsWithStalls({ 8: 450 }),
      measureTimelines: timelines,
      junctionBoundaryCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
    });
    expect(junctionStall.fluency.reanchorCount).toBe(1);
    expect(junctionStall.fluency.interiorHesitationCount).toBe(0);
    expect(junctionStall.fluency.junctionHesitationRatio).toBeCloseTo(1.9, 2);
    expect(junctionStall.fluency.stallDetected).toBe(false);

    // Case 3: 3 separate stalls (+400ms each at strong beats 4, 8, 12) -> capped at 2 re-anchors, 3rd triggers stallDetected
    const threeStalls = attributeContinuousBout({
      clockAnchor: anchor,
      expectedSteps: steps,
      midiEvents: makeEventsWithStalls({ 4: 400, 8: 400, 12: 400 }),
      measureTimelines: timelines,
    });
    expect(threeStalls.fluency.reanchorCount).toBe(2);
    expect(threeStalls.fluency.stallDetected).toBe(true);
    expect(threeStalls.hesitationBreaks.filter((b) => b.reanchored)).toHaveLength(2);
    expect(threeStalls.hesitationBreaks.some((b) => !b.reanchored)).toBe(true);
  });

  it("detects post-SwitchPoint alternate-branch mismatch without false positives on random wrong notes or clean runs", () => {
    const steps = makeSteps([
      { onsetSec: 0.0, notes: [{ midi: 60, hand: "RH" }] },
      { onsetSec: 0.5, notes: [{ midi: 62, hand: "RH" }] },
      // SwitchPoint starts at step 2: expected branch goes E4(64) -> F4(65) -> G4(67)
      { onsetSec: 1.0, notes: [{ midi: 64, hand: "RH" }] },
      { onsetSec: 1.5, notes: [{ midi: 65, hand: "RH" }] },
      { onsetSec: 2.0, notes: [{ midi: 67, hand: "RH" }] },
    ]);
    const t0 = 1000;
    const anchor: PlaybackClockAnchor = {
      t0PerfMs: t0,
      audioStartTimeSec: 0,
      startScoreSec: 0,
      endScoreSec: 2.5,
      speedMultiplier: 1.0,
    };
    const switchPoint = {
      startStepIndex: 2,
      alternateBranches: [{ branchId: "A2", stepMidis: [[72], [74], [76]] }],
    };

    const mk = (midis: number[]): MidiInputEvent[] =>
      midis.map((midi, i) => ({
        type: "noteon",
        midi,
        velocity: 85,
        channel: 0,
        portId: "sim",
        source: "midi",
        timeStampMs: t0 + i * 500,
      }));

    // Wrong branch played after SwitchPoint (C5, D5, E5) -> switchBranchMismatch = true
    const wrongBranch = attributeContinuousBout({
      clockAnchor: anchor,
      expectedSteps: steps,
      midiEvents: mk([60, 62, 72, 74, 76]),
      measureTimelines: makeMeasureTimelines(2, 120),
      switchPoint,
    });
    expect(wrongBranch.fluency.switchBranchMismatch).toBe(true);

    // Unrelated slip (61 instead of 64) -> switchBranchMismatch = false
    const unrelatedSlip = attributeContinuousBout({
      clockAnchor: anchor,
      expectedSteps: steps,
      midiEvents: mk([60, 62, 61, 65, 67]),
      measureTimelines: makeMeasureTimelines(2, 120),
      switchPoint,
    });
    expect(unrelatedSlip.fluency.switchBranchMismatch).toBe(false);

    // Clean run -> switchBranchMismatch = false
    const cleanRun = attributeContinuousBout({
      clockAnchor: anchor,
      expectedSteps: steps,
      midiEvents: mk([60, 62, 64, 65, 67]),
      measureTimelines: makeMeasureTimelines(2, 120),
      switchPoint,
    });
    expect(cleanRun.fluency.switchBranchMismatch).toBe(false);
  });

  it("attributes a 200-note SimulatedMidiHarness bout within < perfBudget(2) ms wall-clock and integrates end-to-end with PlaybackEngine.playSegment", async () => {
    // 1) 200-note performance budget test (100 two-hand steps = 200 notes) via SimulatedMidiHarness
    const steps200 = makeSteps(
      Array.from({ length: 100 }, (_, i) => ({
        onsetSec: i * 0.25,
        measureIndex: Math.floor(i / 8),
        notes: [
          { midi: 60 + (i % 12), hand: "RH" },
          { midi: 48 + (i % 7), hand: "LH" },
        ],
      }))
    );
    const sim200 = createSimulatedMidiHarness();
    const cap200 = createMidiSessionCapture();
    cap200.setMode("continuous");
    cap200.setTransport("playing", true);
    const ctrl200 = createWebMidiController({
      requestMIDIAccess: sim200.requestMIDIAccess,
      onStateChange: () => {},
      onMidiEvent: (ev) => cap200.record(ev),
    });
    await ctrl200.connect();

    vi.advanceTimersByTime(10_000);
    const anchor200: PlaybackClockAnchor = {
      t0PerfMs: performance.now(),
      audioStartTimeSec: 1.0,
      startScoreSec: 0,
      endScoreSec: 25.0,
      speedMultiplier: 1.0,
    };
    sim200.play(
      steps200.map((s) => ({
        stepIndex: s.stepIndex,
        onsetMs: s.onsetSec * 1000,
        notes: s.expectedNotes.map((n) => ({ midi: n.midi, hand: n.hand, durationMs: 150 })),
      })),
      { speedMultiplier: 1.0, entryLatencyMs: 75, timingJitterMs: 4 }
    );
    vi.advanceTimersByTime(26_000);
    ctrl200.dispose();

    const captured200 = cap200.sliceWindow(anchor200.t0PerfMs - 200, anchor200.t0PerfMs + 27_000, {
      mode: "continuous",
      transport: "playing",
    });

    // Switch back to real timers to measure actual wall-clock attribution runtime
    vi.useRealTimers();
    const timelines200 = makeMeasureTimelines(13, 120);
    const startWall = performance.now();
    const res200 = attributeContinuousBout({
      clockAnchor: anchor200,
      expectedSteps: steps200,
      midiEvents: captured200,
      measureTimelines: timelines200,
    });
    const elapsedMs = performance.now() - startWall;
    expect(res200.matchedNotes).toHaveLength(200);
    expect(res200.fluency.pitchAccuracy).toBe(1);
    expect(elapsedMs).toBeLessThan(perfBudget(2));

    // Re-enable fake timers for integrated PlaybackEngine.playSegment + SimulatedMidiHarness test
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });

    // 2) Integrated clock-anchor -> SimulatedMidiHarness -> MidiSessionCapture -> attributeContinuousBout
    const scoreXml = `<?xml version="1.0" encoding="UTF-8"?>
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
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;
    const doc = parseMusicXml(scoreXml);
    const practiceSteps = buildPracticeSteps(doc, "both");

    let rafId = 1;
    const rafCbs = new Map<number, FrameRequestCallback>();
    const rawCtx = {
      currentTime: 0,
      state: "running",
      destination: {},
      resume: vi.fn(async () => {}),
      getOutputTimestamp: () => ({ contextTime: rawCtx.currentTime - 0.02, performanceTime: performance.now() }),
      createGain: vi.fn(() => ({
        gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      })),
      createOscillator: vi.fn(() => ({
        type: "sine",
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      })),
    };

    const engine = createPlaybackEngine({
      audioEngine: createPianoAudioEngine({
        getAudioContext: () => rawCtx as unknown as AudioContext,
        loadSmplrPiano: async () => ({ load: Promise.resolve(), start: vi.fn(), stop: vi.fn() }),
      }),
      requestAnimationFrame: (cb) => {
        const id = rafId++;
        rafCbs.set(id, cb);
        return id;
      },
      cancelAnimationFrame: (id) => rafCbs.delete(id),
      createBackgroundTicker: () => ({ start: vi.fn(), stop: vi.fn() }),
    });
    const tickRaf = () => {
      const entries = [...rafCbs.entries()];
      rafCbs.clear();
      for (const [, cb] of entries) cb(performance.now());
    };

    const harness = createSimulatedMidiHarness();
    const capture = createMidiSessionCapture();
    capture.setMode("continuous");
    capture.setTransport("playing", true);
    const midiController = createWebMidiController({
      requestMIDIAccess: harness.requestMIDIAccess,
      onStateChange: () => {},
      onMidiEvent: (ev) => capture.record(ev),
    });
    await midiController.connect();

    let capturedAnchor: PlaybackClockAnchor | null = null;
    let segmentDone = false;
    await engine.playSegment(doc, {
      startScoreSec: 0,
      endScoreSec: 2.0,
      countInBeats: 2,
      muteTargetHand: true,
      metronomeMode: "count-in-only",
      onClockAnchor: (a) => {
        capturedAnchor = a;
      },
      onSegmentComplete: () => {
        segmentDone = true;
      },
    });

    // Advance 1.0s Count-In
    rawCtx.currentTime = 1.0;
    vi.advanceTimersByTime(1000);
    tickRaf();
    expect(capturedAnchor).not.toBeNull();

    // Perform with +80ms BLE latency from Count-In end
    harness.play(
      practiceSteps.map((s) => ({
        stepIndex: s.stepIndex,
        onsetMs: s.onsetSec * 1000,
        notes: s.expectedNotes.map((n) => ({ midi: n.midi, hand: n.hand })),
      })),
      { speedMultiplier: 1.0, entryLatencyMs: 80, timingJitterMs: 3 }
    );
    rawCtx.currentTime = 3.0;
    vi.advanceTimersByTime(2200);
    tickRaf();
    expect(segmentDone).toBe(true);

    const stream = capture.sliceWindow(
      capturedAnchor!.t0PerfMs - 200,
      capturedAnchor!.t0PerfMs + 3000,
      { mode: "continuous", transport: "playing" }
    );
    const finalAttr = attributeContinuousBout({
      clockAnchor: capturedAnchor!,
      expectedSteps: practiceSteps,
      midiEvents: stream,
      measureTimelines: doc.measureTimelines,
    });
    expect(finalAttr.matchedNotes).toHaveLength(4);
    expect(finalAttr.fluency.pitchAccuracy).toBe(1);
    expect(finalAttr.calibratedEntryOffsetMs).toBeGreaterThanOrEqual(55);
    midiController.dispose();
  });
});
