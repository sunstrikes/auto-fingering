// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import type { ScoreRendererHandle } from "../src/components/ScoreViewer";
import type { MIDIAccessLike, MIDIInputLike, MIDIMessageEventLike } from "../src/midi/webMidi";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import { localResolveFingering } from "../src/solver/localResolve";
import { solveFingering } from "../src/solver/solveFingering";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";
import { createSolverClient, type WorkerLike } from "../src/workers/solverClient";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let mountedRoot: Root | null = null;
let mountedContainer: HTMLElement | null = null;

function mount(element: ReturnType<typeof createElement>): HTMLElement {
  mountedContainer = document.createElement("div");
  document.body.appendChild(mountedContainer);
  mountedRoot = createRoot(mountedContainer);
  act(() => {
    mountedRoot!.render(element);
  });
  return mountedContainer;
}

afterEach(() => {
  vi.useRealTimers();
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

function inProcessSolverFactory() {
  return () => {
    const fakeWorker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(rawMsg: unknown) {
        const msg = rawMsg as WorkerRequest;
        if (msg.type === "load-prior") {
          queueMicrotask(() => {
            fakeWorker.onmessage?.({
              data: { requestId: msg.requestId, type: "prior-ready", ok: true, priorReady: true },
            } as MessageEvent<WorkerResponse>);
          });
          return;
        }
        const result =
          msg.type === "local-resolve"
            ? localResolveFingering(msg)
            : solveFingering(msg.onsetSlices, msg.profile, {
                ignoreExistingFingerings: msg.ignoreExistingFingerings,
              });
        queueMicrotask(() => {
          fakeWorker.onmessage?.({
            data: { requestId: msg.requestId, ok: true, result } satisfies WorkerResponse,
          } as MessageEvent<WorkerResponse>);
        });
      },
      terminate() {},
    };
    return createSolverClient(() => fakeWorker);
  };
}

function createFakeAudioDeps() {
  let audioTime = 0;
  const rafQueue: FrameRequestCallback[] = [];
  const fakeCtx = {
    get currentTime() {
      return audioTime;
    },
    state: "running",
    destination: {},
    sampleRate: 44100,
    resume: vi.fn(async () => undefined),
    createGain: vi.fn(() => ({
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
        value: 1,
      },
      connect: vi.fn(),
    })),
    createOscillator: vi.fn(() => ({
      type: "sine",
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    })),
  } as unknown as AudioContext;

  const loadSmplrPiano = vi.fn(async () => ({
    start: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
  }));

  return {
    audioDeps: {
      getAudioContext: () => fakeCtx,
      loadSmplrPiano,
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length;
      },
      cancelAnimationFrame: vi.fn(),
    },
    advanceAudio(sec: number) {
      audioTime += sec;
      const batch = rafQueue.splice(0, rafQueue.length);
      for (const cb of batch) cb(performance.now());
    },
  };
}

function createSimulatedMidiDeps() {
  let listener: ((event: MIDIMessageEventLike) => void) | null = null;
  const input: MIDIInputLike = {
    id: "sim-piano-1",
    name: "Simulated Digital Piano 88",
    manufacturer: "SimTech",
    state: "connected",
    get onmidimessage() {
      return listener;
    },
    set onmidimessage(fn) {
      listener = fn;
    },
  };
  const access: MIDIAccessLike = {
    inputs: {
      values: () => [input].values(),
    },
    onstatechange: null,
  };

  return {
    midiDeps: {
      requestMIDIAccess: async () => access,
    },
    sendNoteOn(midi: number, velocity: number, timeStampMs: number) {
      listener?.({ data: new Uint8Array([0x90, midi, velocity]), timeStamp: timeStampMs });
    },
    sendNoteOff(midi: number, timeStampMs: number) {
      listener?.({ data: new Uint8Array([0x80, midi, 0]), timeStamp: timeStampMs });
    },
  };
}

// 4 measures at 120 BPM (2.0s per measure; quarter notes at 0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5...)
const FOUR_MEASURE_GRAND_STAFF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction placement="above"><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>8</duration><voice>2</voice><type>half</type><staff>2</staff></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>8</duration><voice>2</voice><type>half</type><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>A</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>8</duration><voice>2</voice><type>half</type><staff>2</staff></note>
      <note><pitch><step>D</step><octave>3</octave></pitch><duration>8</duration><voice>2</voice><type>half</type><staff>2</staff></note>
    </measure>
    <measure number="3">
      <attributes><barline location="left"><bar-style>light-light</bar-style></barline></attributes>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
    <measure number="4">
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

async function uploadXml(container: HTMLElement, xml: string) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const fakeFile = {
    name: "acoustic-ui.musicxml",
    text: async () => xml,
    arrayBuffer: async () => new TextEncoder().encode(xml).buffer,
  };
  Object.defineProperty(input, "files", { value: [fakeFile], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(120);
  });
}

// 8 steps of measures 1..2 (quarter notes at 120 BPM => 500ms apart)
const CHUNK_1_STEPS: ReadonlyArray<{ offsetMs: number; notes: Array<{ midi: number; vel: number }> }> = [
  // Measure 1 (measureIndex = 0): localized rush (-130ms) and drag (+110ms) inside <0.6-beat window so m.1 is flagged
  { offsetMs: 0, notes: [{ midi: 72, vel: 92 }, { midi: 48, vel: 60 }] },
  { offsetMs: 370, notes: [{ midi: 74, vel: 94 }] },
  { offsetMs: 1110, notes: [{ midi: 76, vel: 95 }, { midi: 43, vel: 62 }] },
  { offsetMs: 1500, notes: [{ midi: 77, vel: 93 }] },
  // Measure 2 (measureIndex = 1): steady
  { offsetMs: 2000, notes: [{ midi: 79, vel: 96 }, { midi: 52, vel: 61 }] },
  { offsetMs: 2500, notes: [{ midi: 81, vel: 94 }] },
  { offsetMs: 3000, notes: [{ midi: 79, vel: 92 }, { midi: 50, vel: 63 }] },
  { offsetMs: 3500, notes: [{ midi: 77, vel: 95 }] },
];

const FREE_AB_M2_TROUBLE_STEPS: ReadonlyArray<{ offsetMs: number; notes: Array<{ midi: number; vel: number }> }> = [
  // Measure 1 (measureIndex = 0): steady
  { offsetMs: 0, notes: [{ midi: 72, vel: 92 }, { midi: 48, vel: 60 }] },
  { offsetMs: 500, notes: [{ midi: 74, vel: 94 }] },
  { offsetMs: 1000, notes: [{ midi: 76, vel: 95 }, { midi: 43, vel: 62 }] },
  { offsetMs: 1500, notes: [{ midi: 77, vel: 93 }] },
  // Measure 2 (measureIndex = 1): localized rush (-130ms) and drag (+110ms) inside <0.6-beat window so m.2 is flagged
  { offsetMs: 2000, notes: [{ midi: 79, vel: 96 }, { midi: 52, vel: 61 }] },
  { offsetMs: 2370, notes: [{ midi: 81, vel: 94 }] },
  { offsetMs: 3110, notes: [{ midi: 79, vel: 92 }, { midi: 50, vel: 63 }] },
  { offsetMs: 3500, notes: [{ midi: 77, vel: 95 }] },
];

describe("Ticket #36 UI: Acoustic Profile capsules, hotspot strip & Free Studio in-memory reuse", () => {
  it("keeps AcousticProfileSlot strictly hidden during Micro-Rest, shows 2-3 capsules + hotspot strip post-Micro-Rest, and jumps to fingerings & 88-key HandPosture on hotspot click", async () => {
    vi.useFakeTimers();
    const { audioDeps, advanceAudio } = createFakeAudioDeps();
    const { midiDeps, sendNoteOn, sendNoteOff } = createSimulatedMidiDeps();
    const highlightMeasure = vi.fn();

    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: createInMemoryStorage(),
        audioDeps,
        midiDeps,
        clockDeps: { nowMs: () => performance.now(), getTimezoneOffsetMin: () => 0 },
        scoreRendererFactory: () =>
          ({
            async render() {
              return { measureCount: 4, measureGeometry: [] };
            },
            highlightMeasure,
            highlightSpotlightRange() {},
            markAnchoredNotes() {},
            syncCursor() {},
            hitTestNoteAtClientPoint: () => null,
            scrollToMeasure() {},
            dispose() {},
          }) satisfies ScoreRendererHandle,
      }),
    );

    await uploadXml(container, FOUR_MEASURE_GRAND_STAFF_XML);
    await act(async () => {
      (container.querySelector('[data-testid="guided-strip-start-btn"]') as HTMLButtonElement).click();
    });
    const splitBtn = container.querySelector('[data-testid="chunk-barline-split-2"]') as HTMLButtonElement | null;
    if (splitBtn) {
      await act(async () => {
        splitBtn.click();
      });
    }

    await act(async () => {
      (container.querySelector('[data-testid="guided-start-session-btn"]') as HTMLButtonElement).click();
    });

    // Graduate Stage 0 of chunk 1 cleanly
    for (const s of CHUNK_1_STEPS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
        const ts = performance.now();
        for (const n of s.notes) sendNoteOn(n.midi, n.vel, ts);
        for (const n of s.notes) sendNoteOff(n.midi, ts + 80);
      });
    }
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("定速连贯");

    // Continuous bout begins at t0PerfMs = performance.now()
    const t0PerfMs = performance.now();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });

    // Play continuous bout with rushing/dragging in measure 2 (measureIndex = 1)
    for (const s of CHUNK_1_STEPS) {
      await act(async () => {
        for (const n of s.notes) sendNoteOn(n.midi, n.vel, t0PerfMs + s.offsetMs);
        for (const n of s.notes) sendNoteOff(n.midi, t0PerfMs + s.offsetMs + 180);
      });
    }

    // Complete chunk 1 continuous bout -> enters Micro-Rest
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
      advanceAudio(4.2);
      await vi.advanceTimersByTimeAsync(30);
    });

    // Strictly absent during Micro-Rest!
    expect(container.querySelector('[data-testid="guided-micro-rest-veil"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="acoustic-profile-slot"]')).toBeNull();
    expect(container.querySelector('[data-testid="guided-delayed-feedback-panel"]')).toBeNull();

    // Even pressing B0 during Micro-Rest must NOT surface AcousticProfileSlot during Micro-Rest
    await act(async () => {
      sendNoteOn(23, 88, performance.now());
      sendNoteOff(23, performance.now() + 40);
    });
    expect(container.querySelector('[data-testid="acoustic-profile-slot"]')).toBeNull();

    // Skip Micro-Rest via C8 -> enters Audiation Priming delayed feedback slot
    await act(async () => {
      sendNoteOn(108, 88, performance.now());
      sendNoteOff(108, 88 + 40);
    });
    expect(container.querySelector('[data-testid="guided-delayed-feedback-panel"]')).not.toBeNull();
    const acousticSlot = container.querySelector('[data-testid="acoustic-profile-slot"]');
    expect(acousticSlot).not.toBeNull();

    // Renders 2-3 adaptive capsules and NO 0-100 composite score
    const capsules = acousticSlot!.querySelectorAll('[data-testid^="acoustic-capsule-"]');
    expect(capsules.length).toBeGreaterThanOrEqual(2);
    expect(capsules.length).toBeLessThanOrEqual(3);
    expect(acousticSlot!.textContent).not.toContain("/100");
    expect(acousticSlot!.textContent).not.toContain("总分");

    // Trouble-measure hotspot strip flags measure 1 (0-based index 0)
    const hotspotBtn = acousticSlot!.querySelector(
      '[data-testid="acoustic-hotspot-measure-0"]',
    ) as HTMLButtonElement | null;
    expect(hotspotBtn).not.toBeNull();

    highlightMeasure.mockClear();
    await act(async () => {
      hotspotBtn!.click();
    });

    // Clicking hotspot jumps to measure 0 and immediately switches bottom slot to full fingerings & 88-key HandPosture
    expect(highlightMeasure).toHaveBeenCalledWith(0);
    expect(container.querySelector('[data-testid="unified-piano-88"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="guided-delayed-feedback-panel"]')).toBeNull();
  });

  it("reuses AcousticProfile strictly in-memory read-only in Free Studio after a continuous A-B Loop pass with zero PracticeEvent writes", async () => {
    vi.useFakeTimers();
    const { audioDeps, advanceAudio } = createFakeAudioDeps();
    const { midiDeps, sendNoteOn, sendNoteOff } = createSimulatedMidiDeps();
    const storage = createInMemoryStorage();
    const highlightMeasure = vi.fn();

    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: storage,
        audioDeps,
        midiDeps,
        clockDeps: { nowMs: () => performance.now(), getTimezoneOffsetMin: () => 0 },
        scoreRendererFactory: () =>
          ({
            async render() {
              return { measureCount: 4, measureGeometry: [] };
            },
            highlightMeasure,
            markAnchoredNotes() {},
            syncCursor() {},
            hitTestNoteAtClientPoint: () => null,
            scrollToMeasure() {},
            dispose() {},
          }) satisfies ScoreRendererHandle,
      }),
    );

    await uploadXml(container, FOUR_MEASURE_GRAND_STAFF_XML);

    // Enable A-B Loop [m.1 .. m.2] (indices 0..1) in Free Studio (Waiting Mode OFF)
    await act(async () => {
      (container.querySelector('[data-testid="ab-loop-toggle-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="measure-ruler-item-0"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="measure-ruler-item-1"]') as HTMLButtonElement).click();
    });

    // Start continuous A-B Loop playback
    await act(async () => {
      (container.querySelector('[data-testid="audio-play-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(20);
    });

    const t0PerfMs = performance.now();
    // Play along with the A-B loop pass
    for (const s of FREE_AB_M2_TROUBLE_STEPS) {
      await act(async () => {
        for (const n of s.notes) sendNoteOn(n.midi, n.vel, t0PerfMs + s.offsetMs);
        for (const n of s.notes) sendNoteOff(n.midi, t0PerfMs + s.offsetMs + 180);
      });
    }

    // Complete 1 A-B Loop iteration (measures 0..1 = 4.0s at 120 BPM)
    await act(async () => {
      advanceAudio(4.1);
      await vi.advanceTimersByTimeAsync(20);
    });

    // Badge lights up, NEVER auto-popping modals or dropdowns
    const badgeBtn = container.querySelector(
      '[data-testid="free-acoustic-badge-btn"]',
    ) as HTMLButtonElement | null;
    expect(badgeBtn).not.toBeNull();
    expect(container.querySelector('[data-testid="free-acoustic-popover"]')).toBeNull();
    expect(container.querySelector('[data-testid="practice-report-dropdown"]')).toBeNull();

    // Open on-demand badge -> shows the same 2-3 capsules + hotspot strip
    await act(async () => {
      badgeBtn!.click();
    });
    const popover = container.querySelector('[data-testid="free-acoustic-popover"]');
    expect(popover).not.toBeNull();
    const capsules = popover!.querySelectorAll('[data-testid^="acoustic-capsule-"]');
    expect(capsules.length).toBeGreaterThanOrEqual(2);
    expect(capsules.length).toBeLessThanOrEqual(3);

    const hotspotBtn = popover!.querySelector(
      '[data-testid="acoustic-hotspot-measure-1"]',
    ) as HTMLButtonElement | null;
    expect(hotspotBtn).not.toBeNull();
    highlightMeasure.mockClear();
    await act(async () => {
      hotspotBtn!.click();
    });
    expect(highlightMeasure).toHaveBeenCalledWith(1);

    // Strictly zero PracticeEvents or Motor-FSRS snapshots written!
    expect(await storage.all("practiceEvents")).toHaveLength(0);
    expect(await storage.all("derivedSnapshots")).toHaveLength(0);
  });
});
