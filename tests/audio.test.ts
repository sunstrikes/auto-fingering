// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createPianoAudioEngine,
  DEFAULT_PIANO_TIMBRE,
  type AudioEngineStatus,
  type PianoTimbreId,
} from "../src/audio/pianoAudio";
import { buildPlaybackSchedule, createPlaybackEngine, type CursorSyncTarget, type PlaybackState } from "../src/audio/playbackEngine";
import { ScoreViewer, type ScoreRendererHandle } from "../src/components/ScoreViewer";
import App from "../src/App";
import { parseMusicXml } from "../src/musicxml/parser";
import { solveFingering } from "../src/solver/solveFingering";
import { createSolverClient, type WorkerLike } from "../src/workers/solverClient";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function createMockAudioContext(initialTime = 0): AudioContext {
  const dummyNode = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: {
      value: 0,
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
    },
    frequency: {
      value: 440,
      setValueAtTime: vi.fn(),
    },
    Q: { value: 1 },
    type: "sine",
    start: vi.fn(),
    stop: vi.fn(),
  };

  return {
    currentTime: initialTime,
    state: "running",
    destination: {} as AudioDestinationNode,
    resume: vi.fn(async () => {}),
    createGain: vi.fn(() => ({ ...dummyNode, gain: { ...dummyNode.gain } })),
    createOscillator: vi.fn(() => ({
      ...dummyNode,
      frequency: { ...dummyNode.frequency },
    })),
    createBiquadFilter: vi.fn(() => ({
      ...dummyNode,
      frequency: { ...dummyNode.frequency },
      Q: { ...dummyNode.Q },
    })),
  } as unknown as AudioContext;
}

describe("Seam 1: Lazy Piano Audio + Web Audio Synth Fallback", () => {
  it("does not load samples on creation and lazy-loads smplr only when prepare() is called", async () => {
    const startSpy = vi.fn();
    const stopSpy = vi.fn();
    const loadSmplr = vi.fn(async () => ({
      load: Promise.resolve(),
      start: startSpy,
      stop: stopSpy,
    }));

    const statuses: AudioEngineStatus[] = [];
    const ctx = createMockAudioContext(1.0);
    const engine = createPianoAudioEngine({
      getAudioContext: () => ctx,
      loadSmplrPiano: loadSmplr,
      onStatusChange: (s) => statuses.push(s),
    });

    expect(engine.getStatus()).toBe("idle");
    expect(loadSmplr).not.toHaveBeenCalled();

    const mode = await engine.prepare();
    expect(mode).toBe("samples");
    expect(engine.getStatus()).toBe("samples");
    expect(loadSmplr).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["loading", "samples"]);

    // Subsequent prepare() reuses loaded instance without re-fetching
    await engine.prepare();
    expect(loadSmplr).toHaveBeenCalledTimes(1);

    engine.triggerNote({ midi: 60, time: 1.5, duration: 0.5, velocity: 90 });
    expect(startSpy).toHaveBeenCalledWith({
      note: 60,
      time: 1.5,
      duration: 0.5,
      velocity: 90,
    });

    engine.stopAll();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to pure Web Audio harmonic-envelope synthesizer when sample loading fails and supports stopAll()", async () => {
    const oscInstances: Array<{
      type: string;
      frequency: { setValueAtTime: ReturnType<typeof vi.fn> };
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    const gainInstances: Array<{
      gain: {
        setValueAtTime: ReturnType<typeof vi.fn>;
        linearRampToValueAtTime: ReturnType<typeof vi.fn>;
        exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
        cancelScheduledValues: ReturnType<typeof vi.fn>;
      };
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];

    const mockCtx = {
      currentTime: 2.0,
      state: "running",
      destination: {} as AudioDestinationNode,
      resume: vi.fn(async () => {}),
      createOscillator: vi.fn(() => {
        const osc = {
          type: "sine",
          frequency: { value: 440, setValueAtTime: vi.fn() },
          start: vi.fn(),
          stop: vi.fn(),
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        oscInstances.push(osc);
        return osc;
      }),
      createGain: vi.fn(() => {
        const g = {
          gain: {
            value: 0,
            setValueAtTime: vi.fn(),
            linearRampToValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
            cancelScheduledValues: vi.fn(),
          },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        gainInstances.push(g);
        return g;
      }),
      createBiquadFilter: vi.fn(() => ({
        type: "lowpass",
        frequency: { value: 2000, setValueAtTime: vi.fn() },
        Q: { value: 1 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      })),
    } as unknown as AudioContext;

    const statuses: AudioEngineStatus[] = [];
    const engine = createPianoAudioEngine({
      getAudioContext: () => mockCtx,
      loadSmplrPiano: async () => {
        throw new Error("Offline: sample fetch failed");
      },
      onStatusChange: (s) => statuses.push(s),
    });

    const mode = await engine.prepare();
    expect(mode).toBe("synth");
    expect(engine.getStatus()).toBe("synth");
    expect(statuses).toEqual(["loading", "synth"]);

    // Trigger A4 (MIDI 69 -> 440 Hz) at t=2.25s for 0.5s
    engine.triggerNote({ midi: 69, time: 2.25, duration: 0.5, velocity: 100 });

    // Harmonic synthesizer creates fundamental + overtones (>= 2 oscillators) and envelope gains
    expect(oscInstances.length).toBeGreaterThanOrEqual(2);
    expect(oscInstances[0].frequency.setValueAtTime).toHaveBeenCalledWith(440, 2.25);
    expect(oscInstances[0].start).toHaveBeenCalledWith(2.25);
    expect(oscInstances[0].stop).toHaveBeenCalled();
    expect(gainInstances.length).toBeGreaterThanOrEqual(1);
    expect(gainInstances[0].gain.linearRampToValueAtTime).toHaveBeenCalled();

    // Stopping all voices cancels scheduled audio cleanly without throwing
    engine.stopAll();
    expect(oscInstances[0].stop).toHaveBeenCalledTimes(2);
    expect(gainInstances[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it("cancels smplr scheduler queue and returned StopFn handles on stopAll() so queued future notes never overlap", async () => {
    let currentTime = 0;
    const ctx = createMockAudioContext(0);
    Object.defineProperty(ctx, "currentTime", { get: () => currentTime });

    const queued: Array<{ note: number; time: number; cancelled: boolean }> = [];
    const schedulerStopSpy = vi.fn(() => {
      for (const item of queued) item.cancelled = true;
    });
    const smplrStopSpy = vi.fn();

    const engine = createPianoAudioEngine({
      getAudioContext: () => ctx,
      loadSmplrPiano: async () => ({
        load: Promise.resolve(),
        scheduler: { stop: schedulerStopSpy },
        start(event) {
          const entry = { note: event.note, time: event.time ?? currentTime, cancelled: false };
          queued.push(entry);
          return () => {
            entry.cancelled = true;
          };
        },
        stop: smplrStopSpy,
      }),
    });

    await engine.prepare();

    // Schedule two future notes (simulating 4s lookahead)
    engine.triggerNote({ midi: 60, time: 0.5, duration: 0.5 });
    engine.triggerNote({ midi: 64, time: 2.0, duration: 0.5 });
    expect(queued.every((q) => !q.cancelled)).toBe(true);

    engine.stopAll();

    expect(schedulerStopSpy).toHaveBeenCalledTimes(1);
    expect(smplrStopSpy).toHaveBeenCalledTimes(1);
    expect(queued.every((q) => q.cancelled)).toBe(true);
  });
});

describe("Seam 2: Playback Scheduling, TieContinuations, Tempo & Clock Sync", () => {
  it("honors <sound tempo>, skips TieContinuation re-strikes while sustaining root duration, and supports startFromSliceId", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction placement="above">
        <direction-type><words>Allegro</words></direction-type>
        <sound tempo="120"/>
      </direction>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch>
        <duration>1</duration>
        <tie type="start"/>
        <voice>1</voice>
        <staff>1</staff>
        <notations><tied type="start"/></notations>
      </note>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch>
        <duration>1</duration>
        <tie type="stop"/>
        <voice>1</voice>
        <staff>1</staff>
        <notations><tied type="stop"/></notations>
      </note>
      <note>
        <pitch><step>E</step><octave>5</octave></pitch>
        <duration>1</duration>
        <voice>1</voice>
        <staff>1</staff>
      </note>
      <backup><duration>3</duration></backup>
      <note>
        <pitch><step>C</step><octave>3</octave></pitch>
        <duration>2</duration>
        <voice>2</voice>
        <staff>2</staff>
      </note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(xml);
    // At 120 BPM, 1 quarter = 0.5s.
    // Beat 0: RH C5 (tied across 2 beats -> sustained 1.0s!) + LH C3 (duration 2 -> 1.0s)
    // Beat 1: RH C5 TieContinuation (must NOT be re-struck!)
    // Beat 2 (t = 1.0s): RH E5 (duration 1 -> 0.5s)
    const fullSchedule = buildPlaybackSchedule(scoreDoc);
    expect(fullSchedule.totalDurationSec).toBeCloseTo(1.5, 5);
    expect(fullSchedule.notes.map((n) => ({ midi: n.midi, onsetSec: n.onsetSec, durationSec: n.durationSec }))).toEqual([
      { midi: 48, onsetSec: 0, durationSec: 1.0 },
      { midi: 72, onsetSec: 0, durationSec: 1.0 },
      { midi: 76, onsetSec: 1.0, durationSec: 0.5 },
    ]);

    // Start from the E5 slice at beat 2
    const e5Slice = scoreDoc.onsetSlices.find((s) => s.notes.some((n) => n.midi === 76))!;
    const fromSliceSchedule = buildPlaybackSchedule(scoreDoc, e5Slice.sliceId);
    expect(fromSliceSchedule.startScoreSec).toBeCloseTo(1.0, 5);
    expect(fromSliceSchedule.notes.map((n) => ({ midi: n.midi, onsetSec: n.onsetSec, durationSec: n.durationSec }))).toEqual([
      { midi: 76, onsetSec: 1.0, durationSec: 0.5 },
    ]);
  });

  it("schedules notes by speed on AudioContext.currentTime and advances slice + cursor sync via rAF with pause/resume/stop", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(xml);
    // 3 slices: m.1 C4 (0s), m.1 D4 (0.5s), m.2 E4 (1.0s), total = 1.5s
    let currentTime = 10.0;
    const mockCtx = {
      get currentTime() {
        return currentTime;
      },
      state: "running",
      destination: {} as AudioDestinationNode,
      resume: vi.fn(async () => {}),
      createOscillator: vi.fn(),
      createGain: vi.fn(),
      createBiquadFilter: vi.fn(),
    } as unknown as AudioContext;

    const triggered: Array<{ midi: number; time: number; duration: number }> = [];
    const stopAllSpy = vi.fn();
    const audioEngine = {
      getStatus: () => "samples" as const,
      getTimbre: () => DEFAULT_PIANO_TIMBRE,
      setTimbre: vi.fn(() => null),
      getAudioContext: () => mockCtx,
      prepare: vi.fn(async () => "samples" as const),
      triggerNote: vi.fn((p: { midi: number; time: number; duration: number }) => {
        triggered.push({ midi: p.midi, time: p.time, duration: p.duration });
      }),
      stopAll: stopAllSpy,
      dispose: vi.fn(),
    };

    const rafCallbacks = new Map<number, FrameRequestCallback>();
    let nextRafId = 1;
    const states: PlaybackState[] = [];
    const sliceIds: string[] = [];
    const cursorTargets: Array<CursorSyncTarget | null> = [];

    const engine = createPlaybackEngine({
      audioEngine,
      requestAnimationFrame: (cb) => {
        const id = nextRafId++;
        rafCallbacks.set(id, cb);
        return id;
      },
      cancelAnimationFrame: (id) => {
        rafCallbacks.delete(id);
      },
      onStateChange: (s) => states.push(s),
      onSliceChange: (s) => sliceIds.push(s.sliceId),
      onCursorSync: (c) => cursorTargets.push(c),
    });

    const tickRaf = (timeSec: number) => {
      currentTime = timeSec;
      const pending = Array.from(rafCallbacks.entries());
      rafCallbacks.clear();
      for (const [, cb] of pending) {
        cb(timeSec * 1000);
      }
    };

    // Play at 0.5x speed -> 0s->10.0, 0.5s->11.0, 1.0s->12.0, duration 0.5s->1.0s
    engine.setSpeed(0.5);
    await engine.play(scoreDoc);

    expect(audioEngine.prepare).toHaveBeenCalledTimes(1);
    expect(states[states.length - 1]).toBe("playing");
    expect(triggered).toEqual([
      { midi: 60, time: 10.0, duration: 1.0 },
      { midi: 62, time: 11.0, duration: 1.0 },
      { midi: 64, time: 12.0, duration: 1.0 },
    ]);
    expect(sliceIds).toEqual([scoreDoc.onsetSlices[0].sliceId]);
    expect(cursorTargets[cursorTargets.length - 1]).toMatchObject({
      measureIndex: 0,
      onsetTick: 0,
    });

    // Advance to 11.05s (score time 0.525s -> slice 1: D4)
    tickRaf(11.05);
    expect(sliceIds).toEqual([
      scoreDoc.onsetSlices[0].sliceId,
      scoreDoc.onsetSlices[1].sliceId,
    ]);

    // Pause at 11.2s (score time 0.6s)
    currentTime = 11.2;
    engine.pause();
    expect(engine.getState()).toBe("paused");
    expect(stopAllSpy).toHaveBeenCalledTimes(1);

    // Resume at 1.0x speed from paused score time 0.6s -> E4 (1.0s) scheduled at +0.4s
    triggered.length = 0;
    engine.setSpeed(1.0);
    currentTime = 20.0;
    await engine.play(scoreDoc);
    expect(triggered).toEqual([{ midi: 64, time: 20.4, duration: 0.5 }]);

    // Advance to 20.45s (score time 1.05s -> measure 1 E4)
    tickRaf(20.45);
    expect(sliceIds[sliceIds.length - 1]).toBe(scoreDoc.onsetSlices[2].sliceId);
    expect(cursorTargets[cursorTargets.length - 1]).toMatchObject({
      measureIndex: 1,
    });

    // Advance past end (21.0s -> score time 1.6s > 1.5s) -> auto stops & hides cursor
    tickRaf(21.0);
    expect(engine.getState()).toBe("stopped");
    expect(cursorTargets[cursorTargets.length - 1]).toBeNull();
  });
});

let mountedRoot: Root | null = null;
let mountedContainer: HTMLElement | null = null;

afterEach(() => {
  if (mountedRoot) {
    act(() => {
      mountedRoot!.unmount();
    });
    mountedRoot = null;
  }
  if (mountedContainer) {
    mountedContainer.remove();
    mountedContainer = null;
  }
});

describe("Seam 3: ScoreViewer Cursor Sync & Top-bar Audio Controls in App", () => {
  it("forwards cursorTarget updates and null stop signal to ScoreRendererHandle.syncCursor", async () => {
    const syncCursor = vi.fn();
    const fakeRenderer: ScoreRendererHandle = {
      render: vi.fn(async () => ({
        measureCount: 2,
        measureGeometry: [
          { measureIndex: 0, top: 0, height: 100 },
          { measureIndex: 1, top: 100, height: 100 },
        ],
      })),
      highlightMeasure: vi.fn(),
      markAnchoredNotes: vi.fn(),
      scrollToMeasure: vi.fn(),
      syncCursor,
      dispose: vi.fn(),
    };

    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    const target: CursorSyncTarget = {
      sliceId: "slice-1",
      measureIndex: 1,
      onsetTick: 4,
      isGrace: false,
      midis: [64],
    };

    await act(async () => {
      mountedRoot!.render(
        createElement(ScoreViewer, {
          xmlString: "<score-partwise/>",
          selectedMeasureIndex: 1,
          selectedSliceId: "slice-1",
          cursorTarget: target,
          rendererFactory: () => fakeRenderer,
        })
      );
      await Promise.resolve();
    });

    expect(syncCursor).toHaveBeenLastCalledWith(target);

    await act(async () => {
      mountedRoot!.render(
        createElement(ScoreViewer, {
          xmlString: "<score-partwise/>",
          selectedMeasureIndex: 1,
          selectedSliceId: "slice-1",
          cursorTarget: null,
          rendererFactory: () => fakeRenderer,
        })
      );
      await Promise.resolve();
    });

    expect(syncCursor).toHaveBeenLastCalledWith(null);
  });

  it("lazy-loads on Play with offline synth fallback, honors speed & from-slice controls, and syncs OSMD cursor + DualTrackKeyboard via rAF", async () => {
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
        measureCount: 2,
        measureGeometry: [
          { measureIndex: 0, top: 0, height: 100 },
          { measureIndex: 1, top: 100, height: 100 },
        ],
      })),
      highlightMeasure: vi.fn(),
      markAnchoredNotes: vi.fn(),
      scrollToMeasure: vi.fn(),
      syncCursor,
      dispose: vi.fn(),
    };

    let currentTime = 0;
    const mockCtx = createMockAudioContext(0);
    Object.defineProperty(mockCtx, "currentTime", {
      get: () => currentTime,
    });

    const loadSmplrPiano = vi.fn(async () => {
      throw new Error("Network offline");
    });

    const rafCallbacks = new Map<number, FrameRequestCallback>();
    let nextRafId = 1;

    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    await act(async () => {
      mountedRoot!.render(
        createElement(App, {
          solverClientFactory: () => createSolverClient(inProcessWorkerFactory),
          scoreRendererFactory: () => rendererSpy,
          audioDeps: {
            getAudioContext: () => mockCtx,
            loadSmplrPiano,
            requestAnimationFrame: (cb) => {
              const id = nextRafId++;
              rafCallbacks.set(id, cb);
              return id;
            },
            cancelAnimationFrame: (id) => {
              rafCallbacks.delete(id);
            },
          },
        })
      );
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const fileInput = mountedContainer.querySelector('input[type="file"]') as HTMLInputElement;
    const fakeFile = {
      name: "playback-sync.musicxml",
      text: async () => xml,
      arrayBuffer: async () => new TextEncoder().encode(xml).buffer,
    };
    Object.defineProperty(fileInput, "files", { value: [fakeFile], configurable: true });

    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });

    // Zero sample loads on initial page load or score import
    expect(loadSmplrPiano).not.toHaveBeenCalled();
    const statusBadge = mountedContainer.querySelector('[data-testid="audio-engine-status"]')!;
    expect(statusBadge.textContent).toContain("待机");

    // Set playback speed to 0.5x via Transport & Practice Bar preset
    const speed05Btn = mountedContainer.querySelector('[data-testid="speed-preset-0.5"]') as HTMLButtonElement;
    await act(async () => {
      speed05Btn.click();
    });

    // Press Play -> lazy-loads smplr once, falls back to Synth Fallback cleanly
    const playBtn = mountedContainer.querySelector('[data-testid="audio-play-btn"]') as HTMLButtonElement;
    await act(async () => {
      playBtn.click();
      await Promise.resolve();
    });

    expect(loadSmplrPiano).toHaveBeenCalledTimes(1);
    expect(statusBadge.textContent).toContain("合成器回退");

    // At t=0s (0.5x speed), measure 0 C4 is active
    expect(syncCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({ measureIndex: 0, midis: [60] })
    );

    // Advance AudioContext.currentTime to 2.1s -> at 0.5x speed, scoreSec = 1.05s -> measure 1 E4!
    await act(async () => {
      currentTime = 2.1;
      const pending = Array.from(rafCallbacks.entries());
      rafCallbacks.clear();
      for (const [, cb] of pending) cb(2100);
      await Promise.resolve();
    });

    const viewer = mountedContainer.querySelector('[data-testid="score-viewer"]') as HTMLElement;
    const piano = mountedContainer.querySelector('[data-testid="unified-piano-88"]')!;
    expect(viewer.dataset.activeMeasure).toBe("1");
    expect(piano.textContent).toContain("第2小节 · 右手");
    expect(piano.textContent).toContain("切片 3/4");
    expect(syncCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({ measureIndex: 1, midis: [64] })
    );

    // Advance to 3.1s -> scoreSec = 1.55s -> measure 1 F5 (slice 4, triggers position-shift TransitionCue!)
    await act(async () => {
      currentTime = 3.1;
      const pending = Array.from(rafCallbacks.entries());
      rafCallbacks.clear();
      for (const [, cb] of pending) cb(3100);
      await Promise.resolve();
    });
    expect(piano.textContent).toContain("第2小节 · 右手");
    expect(piano.textContent).toContain("切片 4/4");
    expect(piano.querySelector('[data-testid="hand-overlay-RH"]')).not.toBeNull();

    // Press Stop -> stops playback and hides cursor
    const stopBtn = mountedContainer.querySelector('[data-testid="audio-stop-btn"]') as HTMLButtonElement;
    await act(async () => {
      stopBtn.click();
      await Promise.resolve();
    });
    expect(syncCursor).toHaveBeenLastCalledWith(null);

    // Play from selected slice (currently slice 4 in m.2)
    const fromSliceBtn = mountedContainer.querySelector('[data-testid="audio-play-slice-btn"]') as HTMLButtonElement;
    await act(async () => {
      currentTime = 5.0;
      fromSliceBtn.click();
      await Promise.resolve();
    });
    expect(syncCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({ measureIndex: 1, midis: [77] })
    );
  });

  it("assigns short audible duration to Grace Notes and reschedules cleanly when speed changes mid-playback", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction><sound tempo="120"/></direction>
      <note><grace/><pitch><step>B</step><octave>4</octave></pitch><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(xml);
    const schedule = buildPlaybackSchedule(scoreDoc);
    expect(schedule.notes[0]).toMatchObject({ midi: 71, isGrace: true });
    expect(schedule.notes[0].durationSec).toBeGreaterThan(0.05);

    let currentTime = 0;
    const mockCtx = createMockAudioContext(0);
    Object.defineProperty(mockCtx, "currentTime", { get: () => currentTime });

    const triggered: Array<{ midi: number; time: number; duration: number }> = [];
    const stopAllSpy = vi.fn();
    const audioEngine = {
      getStatus: () => "samples" as const,
      getTimbre: () => DEFAULT_PIANO_TIMBRE,
      setTimbre: vi.fn(() => null),
      getAudioContext: () => mockCtx,
      prepare: vi.fn(async () => "samples" as const),
      triggerNote: vi.fn((p: { midi: number; time: number; duration: number }) => {
        triggered.push({ midi: p.midi, time: p.time, duration: p.duration });
      }),
      stopAll: stopAllSpy,
      dispose: vi.fn(),
    };

    const engine = createPlaybackEngine({
      audioEngine,
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
    });

    await engine.play(scoreDoc);
    expect(triggered.map((t) => t.midi)).toEqual([71, 72, 74]);

    // Advance to 0.25s (before D5 at 0.5s) and switch speed to 1.25x
    triggered.length = 0;
    currentTime = 0.25;
    engine.setSpeed(1.25);
    expect(stopAllSpy).toHaveBeenCalled();
    // Remaining note D5 (onsetSec 0.5, remaining scoreSec 0.25) scheduled at 0.25 + 0.25 / 1.25 = 0.45s
    expect(triggered).toEqual([
      { midi: 74, time: 0.45, duration: 0.5 / 1.25 },
    ]);
  });

  it("supports continuous Speed Multiplier (0.25x-1.5x), clamps out-of-range values, scales mid-piece tempo shifts proportionally, and jumps via fromScoreSec", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <time><beats>2</beats><beat-type>4</beat-type></time>
      </attributes>
      <direction><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
    <measure number="2">
      <direction><sound tempo="60"/></direction>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(xml);
    const mockCtx = createMockAudioContext(0);
    const triggered: Array<{ midi: number; time: number; duration: number }> = [];
    const audioEngine = {
      getStatus: () => "samples" as const,
      getTimbre: () => DEFAULT_PIANO_TIMBRE,
      setTimbre: vi.fn(() => null),
      getAudioContext: () => mockCtx,
      prepare: vi.fn(async () => "samples" as const),
      triggerNote: vi.fn((p: { midi: number; time: number; duration: number }) => {
        triggered.push({ midi: p.midi, time: p.time, duration: p.duration });
      }),
      stopAll: vi.fn(),
      dispose: vi.fn(),
    };

    const engine = createPlaybackEngine({
      audioEngine,
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
    });

    engine.setSpeed(0.1);
    expect(engine.getSpeed()).toBe(0.25);
    engine.setSpeed(2.5);
    expect(engine.getSpeed()).toBe(1.5);

    engine.setSpeed(0.6);
    expect(engine.getSpeed()).toBe(0.6);

    // At 0.6x:
    // m1 (120 BPM): C4 onset 0s -> 0s, dur 0.5/0.6; D4 onset 0.5s -> 0.5/0.6
    // m2 (60 BPM): E4 onset 1.0s -> 1.0/0.6, dur 1.0/0.6; F4 onset 2.0s -> 2.0/0.6
    await engine.play(scoreDoc);
    expect(triggered.map((t) => ({ midi: t.midi, time: Number(t.time.toFixed(4)) }))).toEqual([
      { midi: 60, time: 0 },
      { midi: 62, time: Number((0.5 / 0.6).toFixed(4)) },
      { midi: 64, time: Number((1.0 / 0.6).toFixed(4)) },
      { midi: 65, time: Number((2.0 / 0.6).toFixed(4)) },
    ]);

    // Jump directly to measure 2 via fromScoreSec
    triggered.length = 0;
    await engine.play(scoreDoc, { fromScoreSec: scoreDoc.measureTimelines[1].startSec });
    expect(triggered.map((t) => t.midi)).toEqual([64, 65]);
    expect(triggered[0].time).toBe(0);
  });

  it("renders TransportPracticeBar between score and piano, supports BPM editor, measure ruler jump, settings modal, and click disambiguation", async () => {
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
    let capturedHitTestNote: ((x: number, y: number) => { noteUid: string; measureIndex: number; midi: number } | null) | undefined;
    let firstNoteUid = "";
    let thirdNoteUid = "";

    const rendererSpy: ScoreRendererHandle = {
      render: vi.fn(async () => ({
        measureCount: 2,
        measureGeometry: [
          { measureIndex: 0, top: 0, height: 100 },
          { measureIndex: 1, top: 100, height: 100 },
        ],
      })),
      syncCursor,
      highlightMeasure: vi.fn(),
      markAnchoredNotes: vi.fn(),
      scrollToMeasure: vi.fn(),
      hitTestNoteAtClientPoint: (x: number, y: number) => capturedHitTestNote?.(x, y) ?? null,
      dispose: vi.fn(),
    };

    const mockCtx = createMockAudioContext(0);
    const audioDeps = {
      getAudioContext: () => mockCtx,
      loadSmplrPiano: async () => {
        throw new Error("offline");
      },
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
    };

    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    await act(async () => {
      mountedRoot!.render(
        createElement(App, {
          solverClientFactory: () => createSolverClient(inProcessWorkerFactory),
          scoreRendererFactory: () => rendererSpy,
          audioDeps,
        })
      );
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const parsed = parseMusicXml(xml);
    firstNoteUid = parsed.noteEvents[0].noteUid;
    thirdNoteUid = parsed.noteEvents[2].noteUid;

    const fileInput = mountedContainer.querySelector('input[type="file"]') as HTMLInputElement;
    const fakeFile = {
      name: "transport-test.musicxml",
      text: async () => xml,
      arrayBuffer: async () => new TextEncoder().encode(xml).buffer,
    };
    Object.defineProperty(fileInput, "files", { value: [fakeFile], configurable: true });

    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });

    // 1. Transport & Practice Bar sits between top-score-pane and bottom-piano-pane
    const topPane = mountedContainer.querySelector('[data-testid="top-score-pane"]')!;
    const transportBar = mountedContainer.querySelector('[data-testid="transport-practice-bar"]')!;
    const bottomPane = mountedContainer.querySelector('[data-testid="bottom-piano-pane"]')!;
    expect(topPane).not.toBeNull();
    expect(transportBar).not.toBeNull();
    expect(bottomPane).not.toBeNull();
    expect(
      Boolean(topPane.compareDocumentPosition(transportBar) & Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true);
    expect(
      Boolean(transportBar.compareDocumentPosition(bottomPane) & Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true);

    // 2. All 8 speed presets exist, steppers work, and BPM editor computes speedMultiplier = targetBpm / baseBpm
    for (const preset of [0.25, 0.5, 0.6, 0.75, 0.9, 1, 1.25, 1.5]) {
      expect(mountedContainer.querySelector(`[data-testid="speed-preset-${preset}"]`)).not.toBeNull();
    }
    const bpmBtn = mountedContainer.querySelector('[data-testid="bpm-readout-btn"]') as HTMLButtonElement;
    expect(bpmBtn.textContent).toContain("120");
    await act(async () => {
      bpmBtn.click();
    });
    const bpmInput = mountedContainer.querySelector('[data-testid="bpm-input"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(bpmInput, "90");
      bpmInput.dispatchEvent(new Event("input", { bubbles: true }));
      bpmInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const updatedBpmBtn = mountedContainer.querySelector('[data-testid="bpm-readout-btn"]') as HTMLButtonElement;
    expect(updatedBpmBtn.textContent).toContain("90");
    expect(
      mountedContainer.querySelector('[data-testid="speed-preset-0.75"]')?.getAttribute("aria-pressed")
    ).toBe("true");

    // 3. Practice Settings modal shell opens and closes
    const settingsBtn = mountedContainer.querySelector('[data-testid="practice-settings-btn"]') as HTMLButtonElement;
    await act(async () => {
      settingsBtn.click();
    });
    expect(mountedContainer.querySelector('[data-testid="practice-settings-modal"]')).not.toBeNull();
    const closeSettingsBtn = mountedContainer.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement;
    await act(async () => {
      closeSettingsBtn.click();
    });
    expect(mountedContainer.querySelector('[data-testid="practice-settings-modal"]')).toBeNull();

    // 4. Click disambiguation: while stopped, clicking a note opens NoteAnchorPopover
    const surface = mountedContainer.querySelector('[data-testid="osmd-canvas-surface"]') as HTMLElement;
    capturedHitTestNote = () => ({ noteUid: firstNoteUid, measureIndex: 0, midi: 60 });
    await act(async () => {
      surface.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    });
    expect(mountedContainer.querySelector('[data-testid="note-anchor-popover"]')).not.toBeNull();

    // Start playback -> popover closes; clicking a note in measure 2 jumps cursor without opening popover
    const playBtn = mountedContainer.querySelector('[data-testid="audio-play-btn"]') as HTMLButtonElement;
    await act(async () => {
      playBtn.click();
      await Promise.resolve();
    });
    expect(mountedContainer.querySelector('[data-testid="note-anchor-popover"]')).toBeNull();

    capturedHitTestNote = () => ({ noteUid: thirdNoteUid, measureIndex: 1, midi: 64 });
    await act(async () => {
      surface.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 50, clientY: 10 }));
      await Promise.resolve();
    });
    expect(mountedContainer.querySelector('[data-testid="note-anchor-popover"]')).toBeNull();
    expect(syncCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({ measureIndex: 1, midis: [64] })
    );

    // 5. Measure ruler click jumps playback to clicked measure; Jump-to-Start jumps to measure 0
    const rulerM1 = mountedContainer.querySelector('[data-testid="measure-ruler-item-0"]') as HTMLButtonElement;
    await act(async () => {
      rulerM1.click();
      await Promise.resolve();
    });
    expect(syncCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({ measureIndex: 0, midis: [60] })
    );

    const rulerM2 = mountedContainer.querySelector('[data-testid="measure-ruler-item-1"]') as HTMLButtonElement;
    await act(async () => {
      rulerM2.click();
      await Promise.resolve();
    });
    expect(syncCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({ measureIndex: 1, midis: [64] })
    );

    const jumpStartBtn = mountedContainer.querySelector('[data-testid="transport-jump-start-btn"]') as HTMLButtonElement;
    await act(async () => {
      jumpStartBtn.click();
      await Promise.resolve();
    });
    expect(syncCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({ measureIndex: 0, midis: [60] })
    );
  });

  it("stops previously queued smplr notes immediately on measure jump and restart without overlap", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction><sound tempo="60"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;

    // Simulate smplr's 0.2s lookahead scheduler queue (smplr.stop() alone does NOT clear it!)
    let currentTime = 0;
    const mockCtx = createMockAudioContext(0);
    Object.defineProperty(mockCtx, "currentTime", { get: () => currentTime });

    const queuedNotes: Array<{ midi: number; time: number }> = [];
    const soundedNotes: Array<{ midi: number; time: number }> = [];
    const flushSmplrScheduler = (now: number) => {
      const lookahead = now + 0.2;
      const due = queuedNotes.filter((item) => item.time <= lookahead).sort((a, b) => a.time - b.time);
      for (const item of due) {
        soundedNotes.push(item);
        const idx = queuedNotes.indexOf(item);
        if (idx >= 0) queuedNotes.splice(idx, 1);
      }
    };

    const audioEngine = createPianoAudioEngine({
      getAudioContext: () => mockCtx,
      loadSmplrPiano: async () => ({
        load: Promise.resolve(),
        scheduler: {
          stop() {
            queuedNotes.length = 0;
          },
        },
        start(event) {
          const item = { midi: event.note, time: event.time ?? currentTime };
          if (item.time <= currentTime + 0.2) {
            soundedNotes.push(item);
            return () => {};
          }
          queuedNotes.push(item);
          return () => {
            const idx = queuedNotes.indexOf(item);
            if (idx >= 0) queuedNotes.splice(idx, 1);
          };
        },
        stop: vi.fn(),
      }),
    });

    const engine = createPlaybackEngine({
      audioEngine,
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
    });

    const scoreDoc = parseMusicXml(xml);
    // Start playing from measure 1 at t=0 -> C4(0s) sounds immediately; D4(1s), E4(2s), F4(3s) queued
    await engine.play(scoreDoc);
    expect(soundedNotes.map((n) => n.midi)).toEqual([60]);
    expect(queuedNotes.map((n) => n.midi)).toEqual([62, 64, 65]);

    // At t=0.5s, jump to measure 2 -> old D4/E4/F4 from measure 1 schedule must be cancelled!
    currentTime = 0.5;
    await engine.play(scoreDoc, { fromScoreSec: scoreDoc.measureTimelines[1].startSec });
    // Flush scheduler across time: ONLY E4(0.5s) and F4(1.5s) from measure 2 may sound, NEVER D4(62)!
    currentTime = 2.0;
    flushSmplrScheduler(currentTime);
    expect(soundedNotes.map((n) => n.midi)).toEqual([60, 64, 65]);

    // Now restart from beginning while playing -> old queued notes cancelled, fresh C4/D4/E4/F4 play
    soundedNotes.length = 0;
    currentTime = 2.2;
    await engine.play(scoreDoc, { restart: true });
    currentTime = 5.5;
    flushSmplrScheduler(currentTime);
    expect(soundedNotes.map((n) => n.midi)).toEqual([60, 62, 64, 65]);

    engine.stop();
  });

  it("resets paused position when switching measures in <App /> so pressing Play starts from the selected measure", async () => {
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
        measureCount: 2,
        measureGeometry: [
          { measureIndex: 0, top: 0, height: 100 },
          { measureIndex: 1, top: 100, height: 100 },
        ],
      })),
      syncCursor,
      highlightMeasure: vi.fn(),
      markAnchoredNotes: vi.fn(),
      scrollToMeasure: vi.fn(),
      dispose: vi.fn(),
    };

    let currentTime = 0;
    const mockCtx = createMockAudioContext(0);
    Object.defineProperty(mockCtx, "currentTime", { get: () => currentTime });

    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    await act(async () => {
      mountedRoot!.render(
        createElement(App, {
          solverClientFactory: () => createSolverClient(inProcessWorkerFactory),
          scoreRendererFactory: () => rendererSpy,
          audioDeps: {
            getAudioContext: () => mockCtx,
            loadSmplrPiano: async () => {
              throw new Error("offline");
            },
            requestAnimationFrame: () => 1,
            cancelAnimationFrame: () => {},
          },
        })
      );
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction><sound tempo="60"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const fileInput = mountedContainer.querySelector('input[type="file"]') as HTMLInputElement;
    const fakeFile = {
      name: "pause-switch.musicxml",
      text: async () => xml,
      arrayBuffer: async () => new TextEncoder().encode(xml).buffer,
    };
    Object.defineProperty(fileInput, "files", { value: [fakeFile], configurable: true });

    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });

    const playBtn = mountedContainer.querySelector('[data-testid="audio-play-btn"]') as HTMLButtonElement;
    const pauseBtn = mountedContainer.querySelector('[data-testid="audio-pause-btn"]') as HTMLButtonElement;
    const rulerM2 = mountedContainer.querySelector('[data-testid="measure-ruler-item-1"]') as HTMLButtonElement;

    // Play measure 1, pause at t=0.2s, switch to measure 2, then press Play
    await act(async () => {
      playBtn.click();
      await Promise.resolve();
    });
    expect(syncCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({ measureIndex: 0, midis: [60] })
    );

    await act(async () => {
      currentTime = 0.2;
      pauseBtn.click();
      await Promise.resolve();
    });

    await act(async () => {
      rulerM2.click();
      await Promise.resolve();
    });

    await act(async () => {
      playBtn.click();
      await Promise.resolve();
    });
    expect(syncCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({ measureIndex: 1, midis: [64] })
    );
  });

  it("defaults to electric piano timbre, preserves lazy-loading when switching while idle, and reloads cleanly while discarding stale loads", async () => {
    const ctx = createMockAudioContext(0);
    const loadedTimbres: PianoTimbreId[] = [];
    const disconnected: PianoTimbreId[] = [];
    let resolvePending: () => void = () => {};

    const engine = createPianoAudioEngine({
      getAudioContext: () => ctx,
      loadSmplrPiano: async (_ctx, timbre) => {
        loadedTimbres.push(timbre);
        if (timbre === "ep-cp80") {
          await new Promise<void>((resolve) => {
            resolvePending = resolve;
          });
        }
        return {
          load: Promise.resolve(),
          start: vi.fn(),
          stop: vi.fn(),
          disconnect: () => disconnected.push(timbre),
        };
      },
    });

    expect(engine.getTimbre()).toBe(DEFAULT_PIANO_TIMBRE);
    expect(DEFAULT_PIANO_TIMBRE).toBe("ep-fluid-ep1");

    // Switching while idle should NOT trigger sample loading
    const idleResult = engine.setTimbre("ep-cp80");
    expect(idleResult).toBeNull();
    expect(engine.getTimbre()).toBe("ep-cp80");
    expect(loadedTimbres).toEqual([]);

    // Start preparing ep-cp80 (stays in-flight), then switch immediately to ep-musyng-ep1
    const firstPrepare = engine.prepare();
    await Promise.resolve();
    expect(loadedTimbres).toEqual(["ep-cp80"]);

    const secondPrepare = engine.setTimbre("ep-musyng-ep1");
    expect(secondPrepare).not.toBeNull();
    expect(await secondPrepare).toBe("samples");
    expect(engine.getTimbre()).toBe("ep-musyng-ep1");
    expect(engine.getStatus()).toBe("samples");

    // Now resolve the stale ep-cp80 load -> it must be disconnected and never overwrite active engine
    resolvePending();
    await firstPrepare;
    expect(disconnected).toContain("ep-cp80");
    expect(engine.getTimbre()).toBe("ep-musyng-ep1");
  });

  it("allows selecting and previewing electric piano timbre in PracticeSettingsModal and reflects it on TransportPracticeBar", async () => {
    globalThis.localStorage?.removeItem("auto-fingering:piano-timbre");
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

    const startSpy = vi.fn();
    const loadSmplrPiano = vi.fn(async (_ctx: AudioContext, _timbre: PianoTimbreId) => ({
      load: Promise.resolve(),
      start: startSpy,
      stop: vi.fn(),
      disconnect: vi.fn(),
    }));
    const mockCtx = createMockAudioContext(0);

    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    await act(async () => {
      mountedRoot!.render(
        createElement(App, {
          solverClientFactory: () => createSolverClient(inProcessWorkerFactory),
          scoreRendererFactory: () => ({
            render: async () => ({
              measureCount: 1,
              measureGeometry: [{ measureIndex: 0, top: 0, height: 100 }],
            }),
            highlightMeasure: () => {},
            markAnchoredNotes: () => {},
            scrollToMeasure: () => {},
            syncCursor: () => {},
            dispose: () => {},
          }),
          audioDeps: {
            getAudioContext: () => mockCtx,
            loadSmplrPiano,
            requestAnimationFrame: () => 1,
            cancelAnimationFrame: () => {},
          },
        })
      );
    });

    const settingsBtn = mountedContainer.querySelector('[data-testid="practice-settings-btn"]') as HTMLButtonElement;
    await act(async () => {
      settingsBtn.click();
    });

    const timbreSelect = mountedContainer.querySelector('[data-testid="piano-timbre-select"]') as HTMLSelectElement;
    expect(timbreSelect.value).toBe("ep-fluid-ep1");
    expect(loadSmplrPiano).not.toHaveBeenCalled();

    // Switch to Yamaha CP-80 while idle, then click Preview button
    await act(async () => {
      timbreSelect.value = "ep-cp80";
      timbreSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(loadSmplrPiano).not.toHaveBeenCalled();

    const previewBtn = mountedContainer.querySelector('[data-testid="piano-timbre-preview-btn"]') as HTMLButtonElement;
    await act(async () => {
      previewBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadSmplrPiano).toHaveBeenCalledTimes(1);
    expect(loadSmplrPiano).toHaveBeenLastCalledWith(mockCtx, "ep-cp80");
    expect(startSpy).toHaveBeenCalledTimes(4);

    const statusBadge = mountedContainer.querySelector('[data-testid="audio-engine-status"]')!;
    expect(statusBadge.textContent).toContain("Yamaha CP-80");

    // Switching timbre while already active triggers immediate reload of new timbre
    await act(async () => {
      timbreSelect.value = "ep-wurlitzer";
      timbreSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadSmplrPiano).toHaveBeenCalledTimes(2);
    expect(loadSmplrPiano).toHaveBeenLastCalledWith(mockCtx, "ep-wurlitzer");
    expect(statusBadge.textContent).toContain("Wurlitzer EP200");
  });
});
