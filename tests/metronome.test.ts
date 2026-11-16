// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../src/App";
import type { ScoreRendererHandle } from "../src/components/ScoreViewer";
import { solveFingering } from "../src/solver/solveFingering";
import { createSolverClient, type WorkerLike } from "../src/workers/solverClient";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";
import { parseMusicXml } from "../src/musicxml/parser";
import { createPianoAudioEngine } from "../src/audio/pianoAudio";
import { createPlaybackEngine, type CursorSyncTarget } from "../src/audio/playbackEngine";
import { buildMetronomeBeats, buildCountInBeats, type MetronomeBeatEvent } from "../src/audio/metronome";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const METER_TEMPO_PICKUP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction placement="above">
        <sound tempo="120"/>
      </direction>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    </measure>
    <measure number="1">
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><type>whole</type><staff>1</staff></note>
    </measure>
    <measure number="2">
      <attributes>
        <time><beats>3</beats><beat-type>4</beat-type></time>
      </attributes>
      <direction placement="above">
        <sound tempo="60"/>
      </direction>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>12</duration><type>half</type><dot/><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;

describe("Slice 1: Metronome beat & Count-In generation from MeasureTimeline", () => {
  it("emits only beats within pickup tick span and adapts across meter and tempo changes", () => {
    const doc = parseMusicXml(METER_TEMPO_PICKUP_XML, { DOMParser: window.DOMParser });
    const beats = buildMetronomeBeats(doc);

    // Measure 0 (pickup, 1 quarter at 120 BPM = 0.5s): only 1 beat at t=0
    const m0 = beats.filter((b) => b.measureIndex === 0);
    expect(m0).toHaveLength(1);
    expect(m0[0]).toMatchObject({ beatNumber: 1, isAccent: true, scoreSec: 0 });

    // Measure 1 (4/4 at 120 BPM = 0.5s/beat, starts at 0.5s): 4 beats
    const m1 = beats.filter((b) => b.measureIndex === 1);
    expect(m1).toHaveLength(4);
    expect(m1.map((b) => b.isAccent)).toEqual([true, false, false, false]);
    expect(m1.map((b) => b.scoreSec)).toEqual([0.5, 1.0, 1.5, 2.0]);

    // Measure 2 (3/4 at 60 BPM = 1.0s/beat, starts at 2.5s): 3 beats
    const m2 = beats.filter((b) => b.measureIndex === 2);
    expect(m2).toHaveLength(3);
    expect(m2.map((b) => b.isAccent)).toEqual([true, false, false]);
    expect(m2.map((b) => b.scoreSec)).toEqual([2.5, 3.5, 4.5]);
  });

  it("builds one full measure of Count-In beats at starting measure meter and scaled tempo", () => {
    const doc = parseMusicXml(METER_TEMPO_PICKUP_XML, { DOMParser: window.DOMParser });
    // Starting at measure 2 (3/4, 60 BPM) at 0.5x speed -> 2.0s per beat, 6.0s total
    const countIn = buildCountInBeats(doc, 2, 0.5);
    expect(countIn.totalDurationRealSec).toBeCloseTo(6.0, 5);
    expect(countIn.beats).toHaveLength(3);
    expect(countIn.beats.map((b) => b.offsetRealSec)).toEqual([0, 2.0, 4.0]);
    expect(countIn.beats.map((b) => b.isAccent)).toEqual([true, false, false]);
    expect(countIn.beats.map((b) => b.countdownRemaining)).toEqual([3, 2, 1]);
  });
});

interface TrackedOsc {
  type: string;
  frequency: { value: number; setValueAtTime: ReturnType<typeof vi.fn> };
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface TrackedGain {
  gain: {
    value: number;
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
    cancelScheduledValues: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function createTrackingAudioContext(initialTime = 0) {
  const oscillators: TrackedOsc[] = [];
  const gains: TrackedGain[] = [];

  const ctx = {
    currentTime: initialTime,
    state: "running",
    destination: {} as AudioDestinationNode,
    resume: vi.fn(async () => {}),
    createGain: vi.fn(() => {
      const g: TrackedGain = {
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
          cancelScheduledValues: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(g);
      return g;
    }),
    createOscillator: vi.fn(() => {
      const o: TrackedOsc = {
        type: "sine",
        frequency: { value: 440, setValueAtTime: vi.fn() },
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      oscillators.push(o);
      return o;
    }),
    createBiquadFilter: vi.fn(() => ({
      type: "lowpass",
      frequency: { value: 1000, setValueAtTime: vi.fn() },
      Q: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
  };

  return {
    ctx: ctx as unknown as AudioContext,
    rawCtx: ctx,
    oscillators,
    gains,
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

describe("Slice 2: Isolated Metronome Web Audio & Count-In PlaybackEngine", () => {
  it("synthesizes accented beat-1 and unaccented sub-beat clicks on dedicated nodes isolated from piano stopAll()", async () => {
    const { ctx, rawCtx, oscillators, gains } = createTrackingAudioContext(0);
    const raf = createManualRaf();
    const smplrStopSpy = vi.fn();
    const smplrStartSpy = vi.fn();

    const audioEngine = createPianoAudioEngine({
      getAudioContext: () => ctx,
      loadSmplrPiano: async () => ({
        load: Promise.resolve(),
        start: smplrStartSpy,
        stop: smplrStopSpy,
      }),
    });

    const beatEvents: Array<MetronomeBeatEvent | null> = [];
    const engine = createPlaybackEngine({
      audioEngine,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
      scheduleAheadRealSec: 1.5,
      onMetronomeBeat: (b) => beatEvents.push(b),
    });

    engine.setMetronomeEnabled(true);
    const doc = parseMusicXml(METER_TEMPO_PICKUP_XML, { DOMParser: window.DOMParser });
    await engine.play(doc);

    // Within 1.5s lookahead at 120 BPM: beat at 0.0 (m0 pickup, accent), 0.5 (m1 beat 1, accent),
    // 1.0 (m1 beat 2, sub-beat), 1.5 (m1 beat 3, sub-beat)
    expect(oscillators.length).toBeGreaterThanOrEqual(3);
    const scheduledTimes = oscillators.map((o) => o.start.mock.calls[0]?.[0] as number);
    expect(scheduledTimes.slice(0, 3)).toEqual([0, 0.5, 1.0]);

    // Beat 1 accented (1200 Hz) vs sub-beat (800 Hz)
    const scheduledFreqs = oscillators.map(
      (o) => o.frequency.setValueAtTime.mock.calls[0]?.[0] as number
    );
    expect(scheduledFreqs[0]).toBe(1200);
    expect(scheduledFreqs[1]).toBe(1200);
    expect(scheduledFreqs[2]).toBe(800);

    // Calling piano audioEngine.stopAll() must NOT cancel or stop metronome oscillators/gains
    const metronomeGainsBeforeStop = gains.map((g) => g.gain.cancelScheduledValues.mock.calls.length);
    const metronomeOscStopsBefore = oscillators.map((o) => o.stop.mock.calls.length);
    audioEngine.stopAll();
    expect(smplrStopSpy).toHaveBeenCalledTimes(1);
    expect(gains.map((g) => g.gain.cancelScheduledValues.mock.calls.length)).toEqual(
      metronomeGainsBeforeStop
    );
    expect(oscillators.map((o) => o.stop.mock.calls.length)).toEqual(metronomeOscStopsBefore);

    // Advance time to t=1.0 and tick rAF -> visual beat indicator receives sub-beat 2 of m1
    rawCtx.currentTime = 1.0;
    raf.tick();
    expect(beatEvents.at(-1)).toMatchObject({
      measureIndex: 1,
      beatNumber: 2,
      isAccent: false,
      isCountIn: false,
    });

    engine.dispose();
  });

  it("prepends one full measure of Count-In clicks with countdown feedback before score notes and cursor advance", async () => {
    const { ctx, rawCtx, oscillators } = createTrackingAudioContext(0);
    const raf = createManualRaf();
    const smplrStartSpy = vi.fn();

    const audioEngine = createPianoAudioEngine({
      getAudioContext: () => ctx,
      loadSmplrPiano: async () => ({
        load: Promise.resolve(),
        start: smplrStartSpy,
        stop: vi.fn(),
      }),
    });

    const cursors: Array<CursorSyncTarget | null> = [];
    const beats: Array<MetronomeBeatEvent | null> = [];
    const engine = createPlaybackEngine({
      audioEngine,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
      scheduleAheadRealSec: 1.0,
      onCursorSync: (c) => cursors.push(c),
      onMetronomeBeat: (b) => beats.push(b),
    });

    engine.setCountInEnabled(true);
    engine.setMetronomeEnabled(false);

    // Measure 1 is 4/4 at 120 BPM -> 0.5s per beat, 2.0s Count-In
    const doc = parseMusicXml(METER_TEMPO_PICKUP_XML, { DOMParser: window.DOMParser });
    await engine.play(doc, { fromScoreSec: doc.measureTimelines[1].startSec });

    // At t=0: Count-In has started, score cursor has NOT advanced yet, piano notes NOT triggered yet
    expect(cursors).toEqual([]);
    expect(smplrStartSpy).not.toHaveBeenCalled();
    expect(beats.at(-1)).toMatchObject({
      isCountIn: true,
      beatNumber: 1,
      totalBeats: 4,
      countdownRemaining: 4,
      isAccent: true,
    });

    // Advance to t=1.0s (still inside 2.0s Count-In, beat 3 -> countdown 2)
    rawCtx.currentTime = 1.0;
    raf.tick();
    expect(cursors).toEqual([]);
    expect(beats.at(-1)).toMatchObject({
      isCountIn: true,
      beatNumber: 3,
      countdownRemaining: 2,
      isAccent: false,
    });

    // All 4 Count-In clicks scheduled at [0, 0.5, 1.0, 1.5]
    const clickTimes = oscillators.map((o) => o.start.mock.calls[0]?.[0] as number);
    expect(clickTimes.slice(0, 4)).toEqual([0, 0.5, 1.0, 1.5]);

    // Advance past Count-In to t=2.0s -> score playback & cursor advancement begin!
    rawCtx.currentTime = 2.0;
    raf.tick();
    expect(smplrStartSpy).toHaveBeenCalled();
    expect(cursors.length).toBeGreaterThan(0);
    expect(cursors.at(-1)?.measureIndex).toBe(1);

    engine.dispose();
  });
});

describe("Slice 3: End-to-End Metronome & Count-In UI in <App />", () => {
  let mountedRoot: Root | null = null;
  let mountedContainer: HTMLElement | null = null;

  afterEach(async () => {
    if (mountedRoot) {
      await act(async () => {
        mountedRoot?.unmount();
      });
      mountedRoot = null;
    }
    mountedContainer?.remove();
    mountedContainer = null;
  });

  it("toggles metronome, adjusts volume & Count-In in Practice Settings, and drives countdown + beat indicator on Play", async () => {
    const inProcessWorkerFactory = (): WorkerLike => {
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(msg: unknown) {
          const req = msg as WorkerRequest;
          queueMicrotask(() => {
            const result = solveFingering(req.onsetSlices, req.profile, {
              ignoreExistingFingerings: req.ignoreExistingFingerings,
            });
            const resp: WorkerResponse = { requestId: req.requestId, ok: true, result };
            worker.onmessage?.({ data: resp } as MessageEvent<WorkerResponse>);
          });
        },
        terminate() {},
      };
      return worker;
    };

    const syncCursor = vi.fn();
    const rendererSpy: ScoreRendererHandle = {
      render: vi.fn(async () => ({
        measureCount: 3,
        measureGeometry: [
          { measureIndex: 0, top: 0, height: 100 },
          { measureIndex: 1, top: 100, height: 100 },
          { measureIndex: 2, top: 200, height: 100 },
        ],
      })),
      syncCursor,
      highlightMeasure: vi.fn(),
      markAnchoredNotes: vi.fn(),
      scrollToMeasure: vi.fn(),
      hitTestNoteAtClientPoint: () => null,
      dispose: vi.fn(),
    };

    const { ctx, rawCtx, oscillators, gains } = createTrackingAudioContext(0);
    const raf = createManualRaf();
    const smplrStartSpy = vi.fn();

    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    await act(async () => {
      mountedRoot!.render(
        createElement(App, {
          solverClientFactory: () => createSolverClient(inProcessWorkerFactory),
          scoreRendererFactory: () => rendererSpy,
          audioDeps: {
            getAudioContext: () => ctx,
            loadSmplrPiano: async () => ({
              load: Promise.resolve(),
              start: smplrStartSpy,
              stop: vi.fn(),
            }),
            requestAnimationFrame: raf.requestAnimationFrame,
            cancelAnimationFrame: raf.cancelAnimationFrame,
          },
        })
      );
    });

    // Upload score
    const fileInput = mountedContainer.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([METER_TEMPO_PICKUP_XML], "pickup.musicxml", {
      type: "application/xml",
    });
    Object.defineProperty(file, "text", { value: async () => METER_TEMPO_PICKUP_XML });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    // Toggle metronome on TransportPracticeBar
    const metronomeBtn = mountedContainer.querySelector(
      '[data-testid="metronome-toggle-btn"]'
    ) as HTMLButtonElement;
    expect(metronomeBtn).toBeTruthy();
    expect(metronomeBtn.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      metronomeBtn.click();
    });
    expect(metronomeBtn.getAttribute("aria-pressed")).toBe("true");

    // Open Practice Settings modal -> adjust metronome volume and enable Count-In
    const settingsBtn = mountedContainer.querySelector(
      '[data-testid="practice-settings-btn"]'
    ) as HTMLButtonElement;
    await act(async () => {
      settingsBtn.click();
    });

    const volumeSlider = mountedContainer.querySelector(
      '[data-testid="metronome-volume-slider"]'
    ) as HTMLInputElement;
    expect(volumeSlider).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(volumeSlider, "0.4");
      volumeSlider.dispatchEvent(new Event("input", { bubbles: true }));
      volumeSlider.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const countInToggle = mountedContainer.querySelector(
      '[data-testid="count-in-toggle"]'
    ) as HTMLInputElement;
    expect(countInToggle).toBeTruthy();
    await act(async () => {
      countInToggle.click();
    });
    expect(countInToggle.checked).toBe(true);

    // Close modal
    const closeBtn = mountedContainer.querySelector(
      '[data-testid="practice-settings-close-btn"]'
    ) as HTMLButtonElement;
    await act(async () => {
      closeBtn.click();
    });

    // Start playback from measure 1 (4/4, 120 BPM -> 0.5s/beat, 2.0s Count-In)
    const measure1Btn = mountedContainer.querySelector(
      '[data-testid="measure-ruler-item-1"]'
    ) as HTMLButtonElement;
    await act(async () => {
      measure1Btn.click();
    });

    const playBtn = mountedContainer.querySelector(
      '[data-testid="audio-play-btn"]'
    ) as HTMLButtonElement;
    syncCursor.mockClear();
    await act(async () => {
      playBtn.click();
    });

    // During Count-In (t=0): visual countdown shows, cursor has not advanced, and any lookahead notes are scheduled >= 2.0s
    const countInIndicator = mountedContainer.querySelector(
      '[data-testid="count-in-indicator"]'
    );
    expect(countInIndicator?.textContent).toContain("4");
    expect(syncCursor).not.toHaveBeenCalled();
    for (const call of smplrStartSpy.mock.calls) {
      expect((call[0] as { time: number }).time).toBeGreaterThanOrEqual(2.0);
    }
    // Metronome master gain reflects volume 0.4
    expect(gains[0].gain.value).toBeCloseTo(0.4, 2);

    // Advance into Count-In beat 2 (t=0.5s)
    await act(async () => {
      rawCtx.currentTime = 0.5;
      raf.tick();
    });
    expect(syncCursor).not.toHaveBeenCalled();
    expect(
      mountedContainer.querySelector('[data-testid="count-in-indicator"]')?.textContent
    ).toContain("3");

    // Advance past Count-In (t=2.0s) -> score playback & cursor advancement begin!
    await act(async () => {
      rawCtx.currentTime = 2.0;
      raf.tick();
    });
    expect(syncCursor).toHaveBeenCalled();
    expect(mountedContainer.querySelector('[data-testid="count-in-indicator"]')).toBeNull();
    const beatIndicator = mountedContainer.querySelector(
      '[data-testid="metronome-beat-indicator"]'
    );
    expect(beatIndicator?.textContent).toContain("1/4");
    expect(oscillators.length).toBeGreaterThanOrEqual(4);
  });
});
