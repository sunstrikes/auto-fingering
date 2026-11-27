// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseMusicXml } from "../src/musicxml/parser";
import { createPianoAudioEngine } from "../src/audio/pianoAudio";
import {
  createPlaybackEngine,
  type PlaybackClockAnchor,
} from "../src/audio/playbackEngine";

const TWO_HAND_PICKUP_SEGMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction placement="above"><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>8</duration><type>half</type><staff>2</staff></note>
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>8</duration><type>half</type><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>8</duration><type>half</type><staff>1</staff></note>
      <note><pitch><step>A</step><octave>5</octave></pitch><duration>8</duration><type>half</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>16</duration><type>whole</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

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

function createTrackingAudioContext(
  initialTime = 0,
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number }
) {
  const oscillators: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    frequency: { setValueAtTime: ReturnType<typeof vi.fn> };
  }> = [];

  const rawCtx = {
    currentTime: initialTime,
    state: "running" as AudioContextState,
    destination: {},
    resume: vi.fn(async () => {}),
    ...(getOutputTimestamp ? { getOutputTimestamp } : {}),
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
    createOscillator: vi.fn(() => {
      const osc = {
        type: "sine" as OscillatorType,
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(osc);
      return osc;
    }),
  };

  return { ctx: rawCtx as unknown as AudioContext, rawCtx, oscillators };
}

describe("PlaybackEngine segment playback & PlaybackClockAnchor", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("plays an arbitrary anacrusis segment with compact 2-beat Count-In and emits getOutputTimestamp-calibrated PlaybackClockAnchor at Count-In end", async () => {
    const doc = parseMusicXml(TWO_HAND_PICKUP_SEGMENT_XML, { DOMParser: window.DOMParser });
    const raf = createManualRaf();
    // Output latency 30ms: contextTime lags currentTime by 0.03s while performanceTime = 1000 + currentTime*1000
    const { ctx, rawCtx, oscillators } = createTrackingAudioContext(5.0, () => ({
      contextTime: rawCtx.currentTime - 0.03,
      performanceTime: 1000 + rawCtx.currentTime * 1000,
    }));
    const triggeredNotes: Array<{ midi: number; time: number; duration: number }> = [];
    const anchors: PlaybackClockAnchor[] = [];
    let completed = 0;

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

    const engine = createPlaybackEngine({
      audioEngine,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
      createBackgroundTicker: () => ({ start: vi.fn(), stop: vi.fn() }),
    });
    engine.setSpeed(1.0);

    // Play anacrusis starting at beat 4 of measure 1 (scoreSec=1.5) through beat 2 of measure 2 (scoreSec=3.0)
    // 120 BPM => 0.5s per beat; 2-beat Count-In => 1.0s real time (audioStartTimeSec = 6.0)
    await engine.playSegment(doc, {
      startScoreSec: 1.5,
      endScoreSec: 3.0,
      countInBeats: 2,
      metronomeMode: "full",
      onClockAnchor: (anchor) => anchors.push(anchor),
      onSegmentComplete: () => {
        completed += 1;
      },
    });

    // During Count-In (at t=5.5s), anchor has not fired yet
    rawCtx.currentTime = 5.5;
    raf.tick();
    expect(anchors).toHaveLength(0);
    expect(completed).toBe(0);

    // At Count-In end (t=6.0s), anchor fires once calibrated with +30ms output latency
    rawCtx.currentTime = 6.0;
    raf.tick();
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toEqual({
      t0PerfMs: expect.closeTo(7030, 3),
      audioStartTimeSec: 6.0,
      startScoreSec: 1.5,
      endScoreSec: 3.0,
      speedMultiplier: 1.0,
    });

    // Only notes in [1.5, 3.0) are triggered (sorted by onsetSec then midi): F5 (77) at 1.5s, C3 (48) & G5 (79) at 2.0s
    expect(triggeredNotes.map((n) => n.midi)).toEqual([77, 48, 79]);
    expect(triggeredNotes.map((n) => n.time)).toEqual([6.0, 6.5, 6.5]);

    // 2 Count-In clicks (5.0, 5.5) + segment beats in [1.5, 3.0) => 1.5s, 2.0s, 2.5s (3 clicks)
    expect(oscillators).toHaveLength(5);

    // Advancing to segment end (6.0 + 1.5 = 7.5s) stops playback and calls onSegmentComplete
    rawCtx.currentTime = 7.5;
    raf.tick();
    expect(completed).toBe(1);
    expect(engine.getState()).toBe("stopped");
  });

  it("mutes target hand audio in both, rh-only (keeping LH accompaniment), and lh-only (keeping RH accompaniment)", async () => {
    const doc = parseMusicXml(TWO_HAND_PICKUP_SEGMENT_XML, { DOMParser: window.DOMParser });
    const runMode = async (practiceMode: "both" | "rh-only" | "lh-only") => {
      const raf = createManualRaf();
      const { ctx, rawCtx } = createTrackingAudioContext(0);
      const triggered: number[] = [];
      let completed = 0;

      const audioEngine = createPianoAudioEngine({
        getAudioContext: () => ctx,
        loadSmplrPiano: async () => ({
          load: Promise.resolve(),
          start: (note) => triggered.push(Number(note.note)),
          stop: vi.fn(),
        }),
      });
      const engine = createPlaybackEngine({
        audioEngine,
        requestAnimationFrame: raf.requestAnimationFrame,
        cancelAnimationFrame: raf.cancelAnimationFrame,
        createBackgroundTicker: () => ({ start: vi.fn(), stop: vi.fn() }),
      });

      await engine.playSegment(doc, {
        startScoreSec: 0,
        endScoreSec: 2.0,
        countInBeats: 0,
        muteTargetHand: true,
        practiceMode,
        metronomeMode: "off",
        onSegmentComplete: () => {
          completed += 1;
        },
      });
      rawCtx.currentTime = 2.0;
      raf.tick();
      expect(completed).toBe(1);
      return triggered;
    };

    expect(await runMode("both")).toEqual([]);
    // RH muted -> only LH C3 (48), G3 (55) play
    expect(await runMode("rh-only")).toEqual([48, 55]);
    // LH muted -> only RH C5 (72), D5 (74), E5 (76), F5 (77) play
    expect(await runMode("lh-only")).toEqual([72, 74, 76, 77]);
  });

  it("supports count-in-only and off metronome modes plus performance.now() fallback when getOutputTimestamp is unavailable or uninitialized", async () => {
    const doc = parseMusicXml(TWO_HAND_PICKUP_SEGMENT_XML, { DOMParser: window.DOMParser });

    // 1) count-in-only + uninitialized { contextTime: 0, performanceTime: 0 } fallback
    const raf1 = createManualRaf();
    const ctx1 = createTrackingAudioContext(2.0, () => ({ contextTime: 0, performanceTime: 0 }));
    const anchors1: PlaybackClockAnchor[] = [];
    const beats1: Array<boolean> = [];
    const engine1 = createPlaybackEngine({
      audioEngine: createPianoAudioEngine({
        getAudioContext: () => ctx1.ctx,
        loadSmplrPiano: async () => ({ load: Promise.resolve(), start: vi.fn(), stop: vi.fn() }),
      }),
      requestAnimationFrame: raf1.requestAnimationFrame,
      cancelAnimationFrame: raf1.cancelAnimationFrame,
      createBackgroundTicker: () => ({ start: vi.fn(), stop: vi.fn() }),
      onMetronomeBeat: (b) => {
        if (b) beats1.push(b.isCountIn);
      },
    });
    engine1.setSpeed(0.5);

    vi.advanceTimersByTime(250); // performance.now() === 250
    await engine1.playSegment(doc, {
      startScoreSec: 0,
      endScoreSec: 1.0,
      countInBeats: 2,
      metronomeMode: "count-in-only",
      onClockAnchor: (a) => anchors1.push(a),
    });

    // At 0.5x speed and 120 BPM, 1 beat = 1.0s real, so 2-beat count-in = 2.0s (audioStartTimeSec = 4.0)
    // Only 2 count-in clicks scheduled, zero score beat clicks scheduled
    expect(ctx1.oscillators).toHaveLength(2);
    expect(beats1).toEqual([true]);

    ctx1.rawCtx.currentTime = 4.01;
    vi.advanceTimersByTime(2010); // performance.now() === 2260
    raf1.tick();
    expect(anchors1).toHaveLength(1);
    // Fallback: 2260 + (4.0 - 4.01) * 1000 = 2250
    expect(anchors1[0].t0PerfMs).toBeCloseTo(2250, 3);
    expect(anchors1[0].speedMultiplier).toBe(0.5);
    expect(ctx1.oscillators).toHaveLength(2);

    // 2) metronomeMode: "off" without getOutputTimestamp
    const raf2 = createManualRaf();
    const ctx2 = createTrackingAudioContext(1.0);
    const anchors2: PlaybackClockAnchor[] = [];
    const engine2 = createPlaybackEngine({
      audioEngine: createPianoAudioEngine({
        getAudioContext: () => ctx2.ctx,
        loadSmplrPiano: async () => ({ load: Promise.resolve(), start: vi.fn(), stop: vi.fn() }),
      }),
      requestAnimationFrame: raf2.requestAnimationFrame,
      cancelAnimationFrame: raf2.cancelAnimationFrame,
      createBackgroundTicker: () => ({ start: vi.fn(), stop: vi.fn() }),
    });
    // Enable A-B loop to verify playSegment does not loop on or mutate AbLoopBounds
    engine2.setAbLoop({ startMeasureIndex: 0, endMeasureIndex: 0, enabled: true, loopGap: true });

    await engine2.playSegment(doc, {
      startScoreSec: 0,
      endScoreSec: 2.0,
      metronomeMode: "off",
      onClockAnchor: (a) => anchors2.push(a),
    });

    expect(ctx2.oscillators).toHaveLength(0);
    expect(anchors2).toHaveLength(1);
    expect(anchors2[0]).toMatchObject({
      audioStartTimeSec: 1.0,
      startScoreSec: 0,
      endScoreSec: 2.0,
      speedMultiplier: 1.0,
    });
    expect(engine2.getAbLoop()).toEqual({
      startMeasureIndex: 0,
      endMeasureIndex: 0,
      enabled: true,
      loopGap: true,
    });
  });
});
