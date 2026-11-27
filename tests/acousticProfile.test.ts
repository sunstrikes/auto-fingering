import { describe, expect, it, vi } from "vitest";
import type { PlaybackClockAnchor } from "../src/audio/playbackEngine";
import type { MeasureTimeline, NoteEvent, PracticeStep } from "../src/domain/types";
import { analyzeAcousticProfile, toPracticeEventAcoustic } from "../src/guided/acousticProfile";
import { attributeContinuousBout } from "../src/guided/boundedAttribution";
import { computeAutoMidiGrade, reducePiecePracticeState } from "../src/guided/motorFsrs";
import { createSimulatedMidiHarness, type SimulatedMidiStep } from "../src/midi/simulatedMidiHarness";
import { createMidiSessionCapture } from "../src/midi/midiSessionCapture";
import { createWebMidiController, type MidiInputEvent } from "../src/midi/webMidi";
import { createPracticeBackup, importPracticeBackup } from "../src/persistence/backupMerge";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import type { PieceProfile, PracticeEvent } from "../src/persistence/storagePort";

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
    isArpeggiated?: boolean;
  }>,
  beatSec = 0.5,
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
      isArpeggiated: Boolean(d.isArpeggiated),
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

function notePair(
  midi: number,
  velocity: number,
  onMs: number,
  durationMs = 180,
  source: "midi" | "virtual" | "qwerty" = "midi",
  portId = "usb-piano-1",
): MidiInputEvent[] {
  return [
    {
      type: "noteon",
      midi,
      velocity,
      channel: 0,
      portId,
      source,
      timeStampMs: onMs,
    },
    {
      type: "noteoff",
      midi,
      velocity: 0,
      channel: 0,
      portId,
      source,
      timeStampMs: onMs + durationMs,
    },
  ];
}

describe("Acoustic Profile 5-dimensional analyzer", () => {
  it("keeps Timing Evenness green under smooth musical ritardando while pinpointing localized rushing/dragging measure", () => {
    const t0 = 1000;
    // 16 eighth notes across 4 measures (4 eighth notes per 2/4 measure at 120 BPM => 250ms nominal IOI)
    const timelines = makeMeasureTimelines(4, 120, 2, 4);
    const steps = makeSteps(
      Array.from({ length: 16 }, (_, i) => ({
        onsetSec: i * 0.25,
        measureIndex: Math.floor(i / 4),
        notes: [{ midi: 60 + (i % 8), hand: "RH", durationSec: 0.25 }],
      })),
      0.5,
    );
    const clockAnchor: PlaybackClockAnchor = {
      t0PerfMs: t0,
      audioStartTimeSec: 0,
      startScoreSec: 0,
      endScoreSec: 4.0,
      speedMultiplier: 1.0,
    };

    // 1) Smooth musical ritardando: IOIs gradually widen from 250 ms to ~380 ms (~4% per step)
    const ritEvents: MidiInputEvent[] = [];
    let cursorMs = t0;
    for (let i = 0; i < steps.length; i++) {
      const vel = 76 + ((i % 4) - 1.5) * 4;
      ritEvents.push(...notePair(steps[i].expectedNotes[0].midi, Math.round(vel), cursorMs, 180));
      const stepIoi = 250 * Math.pow(1.038, i);
      cursorMs += stepIoi;
    }

    const ritAttr = attributeContinuousBout({
      clockAnchor,
      expectedSteps: steps,
      midiEvents: ritEvents,
      measureTimelines: timelines,
      l3RelaxedDrift: true,
    });
    const ritProfile = analyzeAcousticProfile({
      attribution: ritAttr,
      midiEvents: ritEvents,
      speedMultiplier: 1.0,
      measureTimelines: timelines,
    });

    expect(ritAttr.matchedNotes.length).toBeGreaterThanOrEqual(8);
    expect(ritProfile.timingEvennessStatus).toBe("green");
    expect(ritProfile.timingNormNpvi).toBeLessThan(5.0);
    expect(ritProfile.worstTimingMeasure).toBeUndefined();

    // 2) Localized rushing/dragging in measure index 2 (steps 8..11)
    const unevenEvents: MidiInputEvent[] = [];
    const nominalMs = steps.map((s) => t0 + s.onsetSec * 1000);
    // Rush step 9 by -95ms and drag step 10 by +95ms inside measure 2
    nominalMs[9] -= 95;
    nominalMs[10] += 95;
    nominalMs[11] -= 75;
    for (let i = 0; i < steps.length; i++) {
      const vel = 76 + ((i % 4) - 1.5) * 4;
      unevenEvents.push(...notePair(steps[i].expectedNotes[0].midi, Math.round(vel), nominalMs[i], 140));
    }

    const unevenAttr = attributeContinuousBout({
      clockAnchor,
      expectedSteps: steps,
      midiEvents: unevenEvents,
      measureTimelines: timelines,
    });
    const unevenProfile = analyzeAcousticProfile({
      attribution: unevenAttr,
      midiEvents: unevenEvents,
      speedMultiplier: 1.0,
      measureTimelines: timelines,
    });

    expect(unevenProfile.timingEvennessStatus).not.toBe("green");
    expect(unevenProfile.timingNormNpvi).toBeGreaterThanOrEqual(5.0);
    expect(unevenProfile.worstTimingMeasure).toBe(2);
  });

  it("computes square-law voicing dB & curve-invariant melodyRankDominance for MIDI, switches to Articulation KOR on unpedaled single-line, and silently hides on non-MIDI or IQR < 3", () => {
    const t0 = 2000;
    const timelines = makeMeasureTimelines(2, 120, 4, 4);
    const bimanualSteps = makeSteps(
      Array.from({ length: 8 }, (_, i) => ({
        onsetSec: i * 0.5,
        measureIndex: Math.floor(i / 4),
        notes: [
          { midi: 72 + (i % 4), hand: "RH", durationSec: 0.45 },
          { midi: 48 + (i % 2) * 5, hand: "LH", durationSec: 0.45 },
        ],
      })),
    );
    const anchor: PlaybackClockAnchor = {
      t0PerfMs: t0,
      audioStartTimeSec: 0,
      startScoreSec: 0,
      endScoreSec: 4.0,
      speedMultiplier: 1.0,
    };

    // 1) Good voicing on real MIDI (RH 92..100, LH 56..64 => deltaDb > 6 dB, R_dom = 1.0)
    const rhVels = [92, 96, 94, 100, 93, 98, 95, 99];
    const lhVels = [56, 60, 58, 64, 57, 62, 59, 63];
    const buildVoicingEvents = (
      rhList: number[],
      lhList: number[],
      source: "midi" | "virtual" | "qwerty" = "midi",
    ): MidiInputEvent[] => {
      const evs: MidiInputEvent[] = [];
      for (let i = 0; i < bimanualSteps.length; i++) {
        const ms = t0 + bimanualSteps[i].onsetSec * 1000;
        evs.push(...notePair(bimanualSteps[i].expectedNotes[0].midi, rhList[i], ms, 220, source));
        evs.push(...notePair(bimanualSteps[i].expectedNotes[1].midi, lhList[i], ms + 5, 220, source));
      }
      return evs;
    };

    const goodEvs = buildVoicingEvents(rhVels, lhVels, "midi");
    const goodAttr = attributeContinuousBout({
      clockAnchor: anchor,
      expectedSteps: bimanualSteps,
      midiEvents: goodEvs,
      measureTimelines: timelines,
    });
    const goodProfile = analyzeAcousticProfile({
      attribution: goodAttr,
      midiEvents: goodEvs,
      speedMultiplier: 1.0,
      practiceMode: "both",
    });

    expect(goodProfile.secondaryDimension).toBe("voicing");
    expect(goodProfile.voicingDeltaDb).toBeGreaterThanOrEqual(6);
    expect(goodProfile.melodyRankDominance).toBe(1);
    expect(goodProfile.voicingStatus).toBe("green");
    expect(goodProfile.capsules.some((c) => c.id === "voicing" && c.status === "green")).toBe(true);

    // Monotonic soft-keyboard curve transform leaves melodyRankDominance 100% invariant
    const softCurve = (v: number) => Math.max(2, Math.min(127, Math.round(127 * Math.pow(v / 127, 0.55))));
    const softEvs = buildVoicingEvents(rhVels.map(softCurve), lhVels.map(softCurve), "midi");
    const softAttr = attributeContinuousBout({
      clockAnchor: anchor,
      expectedSteps: bimanualSteps,
      midiEvents: softEvs,
      measureTimelines: timelines,
    });
    const softProfile = analyzeAcousticProfile({
      attribution: softAttr,
      midiEvents: softEvs,
      speedMultiplier: 1.0,
      practiceMode: "both",
    });
    expect(softProfile.melodyRankDominance).toBe(goodProfile.melodyRankDominance);

    // 2) Non-MIDI ("virtual" / "qwerty") silently hides secondaryDimension with zero errors
    for (const nonMidiSource of ["virtual", "qwerty"] as const) {
      const nonMidiEvs = buildVoicingEvents(rhVels, lhVels, nonMidiSource);
      const nonMidiAttr = attributeContinuousBout({
        clockAnchor: anchor,
        expectedSteps: bimanualSteps,
        midiEvents: nonMidiEvs,
        measureTimelines: timelines,
      });
      const nonMidiProfile = analyzeAcousticProfile({
        attribution: nonMidiAttr,
        midiEvents: nonMidiEvs,
        speedMultiplier: 1.0,
        practiceMode: "both",
      });
      expect(nonMidiProfile.secondaryDimension).toBe("hidden");
      expect(nonMidiProfile.voicingDeltaDb).toBeUndefined();
      expect(nonMidiProfile.melodyRankDominance).toBeUndefined();
      expect(nonMidiProfile.capsules.some((c) => c.id === "voicing" || c.id === "articulation")).toBe(false);
    }

    // 3) Fixed velocity MIDI (IQR(velocity) < 3) silently hides secondaryDimension with zero errors
    const flatVels = [80, 81, 80, 81, 80, 81, 80, 81];
    const flatEvs = buildVoicingEvents(flatVels, flatVels, "midi");
    const flatAttr = attributeContinuousBout({
      clockAnchor: anchor,
      expectedSteps: bimanualSteps,
      midiEvents: flatEvs,
      measureTimelines: timelines,
    });
    const flatProfile = analyzeAcousticProfile({
      attribution: flatAttr,
      midiEvents: flatEvs,
      speedMultiplier: 1.0,
      practiceMode: "both",
    });
    expect(flatProfile.secondaryDimension).toBe("hidden");
    expect(flatProfile.voicingDeltaDb).toBeUndefined();

    // 4) Unpedaled single-line passage switches automatically to Articulation KOR
    const singleSteps = makeSteps(
      Array.from({ length: 8 }, (_, i) => ({
        onsetSec: i * 0.25,
        measureIndex: Math.floor(i / 4),
        notes: [{ midi: 60 + i, hand: "RH", durationSec: 0.25 }],
      })),
      0.5,
    );
    // Clean legato overlap: release 30ms after next onset (IOI=250ms => KOR = +0.12)
    const legatoEvs: MidiInputEvent[] = [];
    const staccatoEvs: MidiInputEvent[] = [];
    for (let i = 0; i < singleSteps.length; i++) {
      const ms = t0 + singleSteps[i].onsetSec * 1000;
      const vel = 70 + (i % 4) * 8; // IQR >= 3
      legatoEvs.push(...notePair(singleSteps[i].expectedNotes[0].midi, vel, ms, 280, "midi"));
      staccatoEvs.push(...notePair(singleSteps[i].expectedNotes[0].midi, vel, ms, 125, "midi")); // KOR = -0.5
    }
    const legatoAttr = attributeContinuousBout({
      clockAnchor: anchor,
      expectedSteps: singleSteps,
      midiEvents: legatoEvs,
      measureTimelines: timelines,
    });
    const legatoProfile = analyzeAcousticProfile({
      attribution: legatoAttr,
      midiEvents: legatoEvs,
      speedMultiplier: 1.0,
      practiceMode: "rh-only",
    });
    expect(legatoProfile.secondaryDimension).toBe("articulation");
    expect(legatoProfile.articulationKor).toBeCloseTo(0.12, 2);
    expect(legatoProfile.articulationStatus).toBe("green");
    expect(legatoProfile.capsules.some((c) => c.id === "articulation")).toBe(true);

    const staccatoAttr = attributeContinuousBout({
      clockAnchor: anchor,
      expectedSteps: singleSteps,
      midiEvents: staccatoEvs,
      measureTimelines: timelines,
    });
    const staccatoProfile = analyzeAcousticProfile({
      attribution: staccatoAttr,
      midiEvents: staccatoEvs,
      speedMultiplier: 1.0,
      practiceMode: "rh-only",
    });
    expect(staccatoProfile.secondaryDimension).toBe("articulation");
    expect(staccatoProfile.articulationKor).toBeCloseTo(-0.5, 2);
  });

  it("auto-distinguishes binary switch vs continuous half-pedal CC64 with Schmitt hysteresis, 30ms debounce, and 0-220ms syncopated pedal window", () => {
    const t0 = 3000;
    // 4 measures of harmonic changes (C -> G -> Am -> F, 2 beats per bar at 60 BPM => 2000ms per bar)
    const timelines = makeMeasureTimelines(4, 60, 2, 4);
    const bassMidis = [48, 43, 45, 41];
    const melMidis = [72, 71, 69, 65];
    const steps = makeSteps(
      [0, 1, 2, 3].map((m) => ({
        onsetSec: m * 2,
        measureIndex: m,
        notes: [
          { midi: melMidis[m], hand: "RH", durationSec: 1.8 },
          { midi: bassMidis[m], hand: "LH", durationSec: 1.8 },
        ],
      })),
      1.0,
    );
    const anchor: PlaybackClockAnchor = {
      t0PerfMs: t0,
      audioStartTimeSec: 0,
      startScoreSec: 0,
      endScoreSec: 8.0,
      speedMultiplier: 1.0,
    };

    const baseNotes: MidiInputEvent[] = [];
    for (let m = 0; m < 4; m++) {
      const ms = t0 + m * 2000;
      baseNotes.push(...notePair(melMidis[m], 90 + m * 2, ms, 1600));
      baseNotes.push(...notePair(bassMidis[m], 62 + m * 2, ms + 8, 1600));
    }
    const baseAttr = attributeContinuousBout({
      clockAnchor: anchor,
      expectedSteps: steps,
      midiEvents: baseNotes,
      measureTimelines: timelines,
    });

    const sustain = (offsetMs: number, value: number): MidiInputEvent => ({
      type: "sustain",
      value,
      pressed: value >= 64,
      channel: 0,
      portId: "usb-piano-1",
      source: "midi",
      timeStampMs: t0 + offsetMs,
    });

    // 1) Binary switch {0, 127} with clean syncopated changes at +100ms on boundaries m=1, 2, 3 (t = 2000, 4000, 6000)
    const switchEvents: MidiInputEvent[] = [
      ...baseNotes,
      sustain(50, 127),
      sustain(2100, 0),
      sustain(2180, 127),
      sustain(4110, 0),
      sustain(4190, 127),
      sustain(6090, 0),
      sustain(6170, 127),
      sustain(7900, 0),
    ];
    const switchProfile = analyzeAcousticProfile({
      attribution: baseAttr,
      midiEvents: switchEvents,
      speedMultiplier: 1.0,
      measureTimelines: timelines,
    });
    expect(switchProfile.tertiaryDimension).toBe("pedal");
    expect(switchProfile.pedalHardware).toBe("switch");
    expect(switchProfile.pedalClarityRate).toBe(1);
    expect(switchProfile.pedalStatus).toBe("green");

    // 2) Continuous half-pedal:
    //    - Boundary m=1 (2000ms): clean clear <=20 for 70ms (2090 -> 2160) within 220ms window
    //    - Boundary m=2 (4000ms): incomplete half-lift to 32 (never <=20!) -> muddy!
    //    - Boundary m=3 (6000ms): micro-chatter dip to 19 for only 15ms (6080 -> 6095ms < 30ms debounce) -> debounced/unclear!
    const contEvents: MidiInputEvent[] = [
      ...baseNotes,
      sustain(50, 95),
      sustain(1500, 52), // hysteresis keeps engaged (>20)
      sustain(2050, 34),
      sustain(2090, 18), // cleared >=30ms (70ms)
      sustain(2160, 88),
      // m=2 incomplete half-lift (dips to 32, never <=20)
      sustain(4080, 32),
      sustain(4160, 92),
      // m=3 15ms micro-bounce <=20 (<30ms debounce) -> ignored
      sustain(6080, 19),
      sustain(6095, 48),
      sustain(7900, 0),
    ];
    const contProfile = analyzeAcousticProfile({
      attribution: baseAttr,
      midiEvents: contEvents,
      speedMultiplier: 1.0,
      measureTimelines: timelines,
    });
    expect(contProfile.tertiaryDimension).toBe("pedal");
    expect(contProfile.pedalHardware).toBe("continuous");
    expect(contProfile.pedalClarityRate).toBeCloseTo(1 / 3, 2);
    expect(contProfile.pedalStatus).toBe("red");
    expect(contProfile.troubleMeasures.some((m) => m.measureIndex === 2)).toBe(true);
  });

  it("applies Goebl 35ms strong-hand / 22ms weak-hand asymmetric deadzones on unpedaled bimanual chords", () => {
    const t0 = 4000;
    const timelines = makeMeasureTimelines(2, 120, 4, 4);
    const steps = makeSteps(
      Array.from({ length: 4 }, (_, i) => ({
        onsetSec: i * 0.5,
        measureIndex: 0,
        notes: [
          { midi: 72 + i, hand: "RH", durationSec: 0.4 },
          { midi: 48 + i, hand: "LH", durationSec: 0.4 },
        ],
      })),
    );
    const anchor: PlaybackClockAnchor = {
      t0PerfMs: t0,
      audioStartTimeSec: 0,
      startScoreSec: 0,
      endScoreSec: 2.0,
      speedMultiplier: 1.0,
    };

    const runSyncCase = (rhLeadMs: number) => {
      const evs: MidiInputEvent[] = [];
      for (let i = 0; i < 4; i++) {
        const ms = t0 + i * 500;
        const rhVel = 94 + (i % 3) * 3;
        const lhVel = 60 + (i % 3) * 3;
        // Positive rhLeadMs => RH strikes earlier than LH
        evs.push(...notePair(72 + i, rhVel, ms - rhLeadMs / 2, 250));
        evs.push(...notePair(48 + i, lhVel, ms + rhLeadMs / 2, 250));
      }
      const attr = attributeContinuousBout({
        clockAnchor: anchor,
        expectedSteps: steps,
        midiEvents: evs,
        measureTimelines: timelines,
      });
      return analyzeAcousticProfile({
        attribution: attr,
        midiEvents: evs,
        speedMultiplier: 1.0,
        practiceMode: "both",
      });
    };

    // Strong hand (RH vel ~96 vs LH vel ~62) leading by 30ms -> within 35ms Goebl deadzone => GREEN
    const strongLead = runSyncCase(30);
    expect(strongLead.tertiaryDimension).toBe("hand-sync");
    expect(strongLead.handSyncStatus).toBe("green");
    expect(strongLead.handSyncMedianEffOffsetMs).toBe(0);

    // Same 30ms magnitude, but WEAK hand (LH) leading RH -> exceeds 22ms deadzone => NOT green
    const weakLead = runSyncCase(-30);
    expect(weakLead.tertiaryDimension).toBe("hand-sync");
    expect(weakLead.handSyncStatus).not.toBe("green");
    expect(weakLead.handSyncMedianEffOffsetMs).toBeCloseTo(8, 1);
  });

  it("detects BLE MIDI burst quantization via SimulatedMidiHarness and relaxes timing deadzones by 1.4x", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    try {
      const timelines = makeMeasureTimelines(2, 120, 4, 4);
      const steps = makeSteps(
        Array.from({ length: 8 }, (_, i) => ({
          onsetSec: i * 0.25,
          measureIndex: Math.floor(i / 4),
          notes: [
            { midi: 72 + (i % 4), hand: "RH", durationSec: 0.2 },
            { midi: 48 + (i % 2) * 5, hand: "LH", durationSec: 0.2 },
          ],
        })),
        0.5,
      );

      const simSteps: SimulatedMidiStep[] = steps.map((s) => ({
        stepIndex: s.stepIndex,
        onsetMs: s.onsetSec * 1000,
        notes: s.expectedNotes.map((n) => ({ midi: n.midi, hand: n.hand, durationMs: 140 })),
      }));

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

      const t0 = performance.now();
      const anchor: PlaybackClockAnchor = {
        t0PerfMs: t0,
        audioStartTimeSec: 0,
        startScoreSec: 0,
        endScoreSec: 2.0,
        speedMultiplier: 1.0,
      };

      harness.play(simSteps, {
        speedMultiplier: 1.0,
        bleBurstIntervalMs: 15,
        timingJitterMs: 6,
        baseVelocityRh: 92,
        baseVelocityLh: 62,
        velocityJitter: 5,
      });

      vi.advanceTimersByTime(2400);
      controller.dispose();

      const captured = capture.sliceWindow(t0 - 100, t0 + 3000, {
        mode: "continuous",
        transport: "playing",
      });
      const attr = attributeContinuousBout({
        clockAnchor: anchor,
        expectedSteps: steps,
        midiEvents: captured,
        measureTimelines: timelines,
      });
      const profile = analyzeAcousticProfile({
        attribution: attr,
        midiEvents: captured,
        speedMultiplier: 1.0,
        practiceMode: "both",
      });

      expect(profile.bleQuantizationRelaxed).toBe(true);
      // With 15ms BLE bursts on 250ms 8th-notes, nPVI ~5-6% would normally be amber (>5.0),
      // but 1.4x relaxation (green threshold 7.0) keeps it green!
      expect(profile.timingEvennessStatus).toBe("green");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never degrades Motor-FSRS autoGrade or stability under poor acoustic metrics and survives backup validation", async () => {
    const fluency: PracticeEvent["fluency"] = {
      pitchAccuracy: 1.0,
      interiorHesitationCount: 0,
      junctionHesitationRatio: 1.0,
      timingCv: 0.02,
      stallDetected: false,
      dominantHandFaultRatio: { rh: 0, lh: 0 },
      switchBranchMismatch: false,
      reanchorCount: 0,
    };
    const measureFaultCounts: PracticeEvent["measureFaultCounts"] = {};
    const autoGrade = computeAutoMidiGrade({
      practiceMode: "both",
      speedMultiplier: 0.9,
      fluency,
      measureFaultCounts,
    });
    expect(autoGrade).toBe(4); // Easy!

    const baseEvent: PracticeEvent = {
      eventId: "ev-acoustic-decouple-1",
      pieceId: "piece-1",
      scoreFingerprint: "fp-1",
      timestampMs: 1_700_000_000_000,
      localDateKey: "2026-11-26",
      timezoneOffsetMin: 0,
      sessionId: "s-1",
      boutKind: "chunk",
      startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
      endCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
      practiceMode: "both",
      speedMultiplier: 0.9,
      durationSec: 4,
      passCount: 1,
      wasColdFirstPass: true,
      scaffoldingLevel: 1,
      autoGrade,
      fluency,
      measureFaultCounts,
    };

    const terribleAcoustic: NonNullable<PracticeEvent["acoustic"]> = {
      timingEvennessStatus: "green",
      timingNormNpvi: 2.1,
      secondaryDimension: "articulation",
      articulationKor: -0.62,
      tertiaryDimension: "pedal",
      pedalClarityRate: 0.1,
      bleQuantizationRelaxed: false,
    };

    const cleanState = reducePiecePracticeState([baseEvent]);
    const terribleAcousticState = reducePiecePracticeState([
      { ...baseEvent, acoustic: terribleAcoustic },
    ]);

    expect(terribleAcousticState.chunkStates).toEqual(cleanState.chunkStates);

    // Also verify negative articulationKor passes backupMerge validation cleanly
    const sourceStorage = createInMemoryStorage();
    const targetStorage = createInMemoryStorage();
    const profile: PieceProfile = {
      pieceId: "piece-1",
      title: "Test",
      fingerprints: ["fp-1"],
      measureHashesByFingerprint: { "fp-1": ["h0", "h1"] },
    };
    await sourceStorage.commit({
      pieceProfiles: [profile],
      practiceEvents: [{ ...baseEvent, acoustic: terribleAcoustic }],
    });
    const exported = await createPracticeBackup(sourceStorage);
    await importPracticeBackup(targetStorage, exported.metadataOnlyJson);
    const persistedEvents = await targetStorage.listPracticeEvents("piece-1");
    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0].acoustic?.articulationKor).toBe(-0.62);
    expect(toPracticeEventAcoustic({
      ...terribleAcoustic,
      capsules: [],
      troubleMeasures: [],
      pedalHardware: "continuous",
    })).toEqual(terribleAcoustic);
  });
});
