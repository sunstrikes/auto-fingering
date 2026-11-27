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

const TWO_CHUNK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>D</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note>
    </measure>
    <measure number="3">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note>
    </measure>
    <measure number="4">
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>F</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

const originalHref = window.location.href;
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
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", originalHref);
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
            data: { requestId: msg.requestId, ok: true, result },
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
      for (const cb of batch) cb(audioTime * 1000);
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
    inputs: new Map([[input.id, input]]),
    onstatechange: null,
  };
  return {
    midiDeps: { requestMIDIAccess: async () => access },
    sendNoteOn(midi: number, velocity = 90, timeStamp = 1000) {
      listener?.({ data: new Uint8Array([0x90, midi, velocity]), timeStamp });
    },
    sendNoteOff(midi: number, timeStamp = 1050) {
      listener?.({ data: new Uint8Array([0x80, midi, 0]), timeStamp });
    },
  };
}

function makeRendererFactory(): () => ScoreRendererHandle {
  return () => ({
    async render() {
      return { measureCount: 4, measureGeometry: [] };
    },
    highlightMeasure() {},
    markAnchoredNotes() {},
    syncCursor() {},
    hitTestNoteAtClientPoint: () => null,
    scrollToMeasure() {},
    dispose() {},
  });
}

async function uploadScore(container: HTMLElement, xml: string) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const fakeFile = {
    name: "two-chunk.musicxml",
    text: async () => xml,
    arrayBuffer: async () => new TextEncoder().encode(xml).buffer,
  };
  Object.defineProperty(input, "files", { value: [fakeFile], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
  });
}

describe("Guided Session App.tsx review fixes", () => {
  it("passes onFocusChunkEditor to GuidedSessionLaunchCard so clicking it opens the Chunk/Cue editor", async () => {
    const { audioDeps } = createFakeAudioDeps();
    const { midiDeps } = createSimulatedMidiDeps();
    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: createInMemoryStorage(),
        audioDeps,
        midiDeps,
        scoreRendererFactory: makeRendererFactory(),
      }),
    );

    await uploadScore(container, TWO_CHUNK_XML);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="enter-guided-session-btn"]')!.click();
    });

    const editBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="guided-launch-edit-chunks-btn"]',
    );
    expect(editBtn).not.toBeNull();

    const dialog = container.querySelector<HTMLDialogElement>(
      '[data-testid="chunk-cue-editor-panel"]',
    )!;
    dialog.showModal = vi.fn(() => {
      dialog.open = true;
    });
    dialog.close = vi.fn(() => {
      dialog.open = false;
    });

    await act(async () => {
      editBtn!.click();
    });
    expect(dialog.open).toBe(true);
    expect(
      container
        .querySelector('[data-testid="chunk-cue-editor-toggle"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("renders guided-count-in-indicator inside guided-control-strip during Count-In of playing phase", async () => {
    let now = 10_000;
    const { audioDeps, advanceAudio } = createFakeAudioDeps();
    const { midiDeps, sendNoteOn, sendNoteOff } = createSimulatedMidiDeps();
    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: createInMemoryStorage(),
        audioDeps,
        midiDeps,
        clockDeps: { nowMs: () => now, getTimezoneOffsetMin: () => 0 },
        scoreRendererFactory: makeRendererFactory(),
      }),
    );

    await uploadScore(container, TWO_CHUNK_XML);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="header-midi-status-btn"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLInputElement>('[data-testid="count-in-toggle"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="practice-settings-close-btn"]')!.click();
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="enter-guided-session-btn"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="guided-start-session-btn"]')!.click();
    });

    // Complete Stage 0 of chunk 1 cleanly -> graduates into continuous playing with Count-In
    for (const step of [
      [60, 48],
      [62, 50],
      [64, 52],
      [65, 53],
    ]) {
      // Stop if Stage 0 already graduated (2-measure chunk = 2 steps)
      if (!container.querySelector('[data-testid="guided-phase-badge"]')?.textContent?.includes("Stage 0")) {
        break;
      }
      now += 350;
      await act(async () => {
        for (const m of step) sendNoteOn(m, 88, now);
        for (const m of step) sendNoteOff(m, now + 50);
      });
    }
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain(
      "定速连贯",
    );

    // Wait for playSegment setup and advance 0.05s to receive first Count-In beat
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
      advanceAudio(0.05);
    });

    const indicator = container.querySelector('[data-testid="guided-count-in-indicator"]');
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("预备拍:");

    // Advance past Count-In into measure 1 -> indicator disappears
    await act(async () => {
      advanceAudio(2.2);
    });
    expect(container.querySelector('[data-testid="guided-count-in-indicator"]')).toBeNull();
  });

  it("scopes handlePlaySimulatedMidi to activeChunkSteps in Guided Session and respects Stage 0 cursor only", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    window.history.replaceState(null, "", "/?simMidi=1");

    const { audioDeps } = createFakeAudioDeps();
    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: createInMemoryStorage(),
        audioDeps,
        midiDeps: {},
        scoreRendererFactory: makeRendererFactory(),
      }),
    );

    await uploadScore(container, TWO_CHUNK_XML);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="enter-guided-session-btn"]')!.click();
    });

    // Split at measure 3 so chunk 1 is mm.1-2 ([60,48], [62,50]) and chunk 2 is mm.3-4 ([64,52], [65,53])
    const splitBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="chunk-barline-split-2"]',
    );
    expect(splitBtn).not.toBeNull();
    await act(async () => {
      splitBtn!.click();
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="guided-start-session-btn"]')!.click();
    });
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain(
      "Stage 0",
    );

    // In Stage 0, advance step 0 manually using Sim MIDI bar (C4=60, C3=48) -> cursor moves to step 1 ([62, 50])
    const pitchInput = container.querySelector<HTMLInputElement>('[data-testid="sim-midi-pitch"]')!;
    const strikeBtn = container.querySelector<HTMLButtonElement>('[data-testid="sim-midi-strike"]')!;
    const setPitchAndStrike = async (midi: number) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(pitchInput, String(midi));
        pitchInput.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        strikeBtn.click();
      });
    };
    await setPitchAndStrike(60);
    await setPitchAndStrike(48);
    expect(container.querySelector('[data-testid="guided-stage0-progress"]')?.textContent).toContain(
      "2/2",
    );

    // Now trigger Simulated MIDI play -> must start from step 1 ([62, 50]) of activeChunkSteps,
    // graduating chunk 1 to "定速连贯" without playing chunk 2's [64, 52]!
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="sim-midi-play"]')!.click();
    });
    // Step 1 ([62, 50]) fires immediately at onsetMs = 0 -> Stage 0 graduates to playing!
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain(
      "定速连贯",
    );

    // Advance simulated timers far enough that full-score playback would have reached measure 3 (E4=64)
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(
      container.querySelector('[data-testid="piano-key-64"]')?.getAttribute("data-key-pressed"),
    ).not.toBe("true");

    // In continuous "playing" phase, sim-midi-play starts from index 0 (C4=60) of activeChunkSteps
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="sim-midi-play"]')!.click();
    });
    expect(
      container.querySelector('[data-testid="piano-key-60"]')?.getAttribute("data-key-pressed"),
    ).toBe("true");
  });
});
