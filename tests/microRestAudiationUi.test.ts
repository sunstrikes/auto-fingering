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
  const pianoStart = vi.fn();
  const pianoStop = vi.fn();
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
    start: pianoStart,
    stop: pianoStop,
    disconnect: vi.fn(),
  }));

  return {
    pianoStart,
    pianoStop,
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
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
    <measure number="3">
      <attributes><barline location="left"><bar-style>light-light</bar-style></barline></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
    <measure number="4">
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

async function uploadAndSplitTwoChunks(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const fakeFile = {
    name: "two-stage-gap.musicxml",
    text: async () => FOUR_MEASURE_GRAND_STAFF_XML,
    arrayBuffer: async () => new TextEncoder().encode(FOUR_MEASURE_GRAND_STAFF_XML).buffer,
  };
  Object.defineProperty(input, "files", { value: [fakeFile], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(120);
  });

  await act(async () => {
    (container.querySelector('[data-testid="guided-strip-start-btn"]') as HTMLButtonElement).click();
  });
  const splitBtn = container.querySelector('[data-testid="chunk-barline-split-2"]') as HTMLButtonElement | null;
  if (splitBtn) {
    await act(async () => {
      splitBtn.click();
    });
  }
}

describe("Ticket #30: Two-stage Micro-Rest veil & non-blocking Audiation Priming bottom slot", () => {
  it("runs bout end -> zero-data 12s Micro-Rest veil -> accidental keystroke pulse -> timer completion -> Audiation Priming + unfamiliar soft preview auto-interrupted by first target note", async () => {
    vi.useFakeTimers();
    let now = 10_000;
    const { audioDeps, advanceAudio, pianoStart, pianoStop } = createFakeAudioDeps();
    const { midiDeps, sendNoteOn, sendNoteOff } = createSimulatedMidiDeps();
    const highlightSpotlightRange = vi.fn();

    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: createInMemoryStorage(),
        audioDeps,
        midiDeps,
        clockDeps: { nowMs: () => now, getTimezoneOffsetMin: () => 0 },
        scoreRendererFactory: () =>
          ({
            async render() {
              return { measureCount: 4, measureGeometry: [] };
            },
            highlightMeasure() {},
            highlightSpotlightRange,
            markAnchoredNotes() {},
            syncCursor() {},
            hitTestNoteAtClientPoint: () => null,
            scrollToMeasure() {},
            dispose() {},
          }) satisfies ScoreRendererHandle,
      }),
    );

    await uploadAndSplitTwoChunks(container);
    await act(async () => {
      (container.querySelector('[data-testid="guided-start-session-btn"]') as HTMLButtonElement).click();
    });

    // Graduate chunk 1 Stage 0 cleanly
    for (const step of [[60, 48], [62], [64, 43], [65]]) {
      now += 350;
      await act(async () => {
        for (const m of step) sendNoteOn(m, 88, now);
        for (const m of step) sendNoteOff(m, now + 60);
      });
    }
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("定速连贯");

    // Finish chunk 1 continuous bout -> enters 12 s zero-data Micro-Rest veil
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
      advanceAudio(5.0);
      await vi.advanceTimersByTimeAsync(30);
    });

    const veil = container.querySelector('[data-testid="guided-micro-rest-veil"]');
    expect(veil).not.toBeNull();
    expect(container.querySelector('[data-testid="guided-micro-rest-countdown"]')?.textContent).toContain("12");
    expect(veil?.textContent).not.toContain("%");
    expect(veil?.textContent).not.toContain("准确率");
    expect(veil?.textContent).not.toContain("得分");
    expect(veil?.textContent).not.toContain("nPVI");

    // Accidental ordinary keystrokes during Micro-Rest do NOT abort countdown or log wrong notes; pulse reminder increments
    await act(async () => {
      sendNoteOn(62, 80, now + 200);
      sendNoteOff(62, now + 250);
    });
    const reminder1 = container.querySelector('[data-testid="guided-micro-rest-reminder"]');
    expect(reminder1?.textContent).toContain("静放巩固效果更佳 · 按 C8 可跳过");
    expect(reminder1?.getAttribute("data-pulse-token")).toBe("1");
    expect(container.querySelector('[data-testid="waiting-strict-fault-badge"]')).toBeNull();

    await act(async () => {
      sendNoteOn(64, 80, now + 400);
      sendNoteOff(64, now + 450);
    });
    expect(
      container.querySelector('[data-testid="guided-micro-rest-reminder"]')?.getAttribute("data-pulse-token"),
    ).toBe("2");

    // Advance 4 s: countdown updates to 8 s and veil remains active
    now += 4_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(container.querySelector('[data-testid="guided-micro-rest-veil"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="guided-micro-rest-countdown"]')?.textContent).toContain("8");

    // Advance remaining 8 s: Micro-Rest finishes -> immediately enters non-blocking Audiation Priming
    pianoStart.mockClear();
    pianoStop.mockClear();
    highlightSpotlightRange.mockClear();

    now += 8_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(container.querySelector('[data-testid="guided-micro-rest-veil"]')).toBeNull();
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("Audiation");

    // Upper score spotlights next MotorChunk (measures 2..3)
    expect(highlightSpotlightRange).toHaveBeenCalledWith(
      expect.objectContaining({ startMeasureIndex: 2, endMeasureIndex: 3 }),
    );

    // Bottom slot cleanly swaps with 88-key keyboard area
    expect(container.querySelector('[data-testid="unified-piano-88"]')).toBeNull();
    const bottomSlot = container.querySelector('[data-testid="guided-delayed-feedback-panel"]');
    expect(bottomSlot).not.toBeNull();
    const audiationBar = container.querySelector('[data-testid="audiation-priming-bar"]');
    expect(audiationBar).not.toBeNull();
    const cueEl = container.querySelector('[data-testid="audiation-single-line-cue"]');
    expect(cueEl?.textContent).toContain("m.3–4");
    expect(cueEl?.textContent).not.toContain("\n");

    // Unfamiliar next chunk (< 2 passes) auto-triggers 1 soft audio preview
    expect(pianoStart).toHaveBeenCalled();
    const previewCall = pianoStart.mock.calls[0]?.[0] as { velocity?: number } | undefined;
    expect(previewCall?.velocity ?? 99).toBeLessThanOrEqual(60);

    // Striking first target note of chunk 2 (G4 = 67 or E3 = 52) IMMEDIATELY stops preview and enters Stage 0!
    await act(async () => {
      sendNoteOn(67, 88, now + 100);
      sendNoteOff(67, now + 150);
    });
    expect(pianoStop).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("Stage 0");
    expect(container.querySelector('[data-testid="unified-piano-88"]')).not.toBeNull();
  });

  it("persists 10–15s Micro-Rest, manual preview mode, and optional 10s imagery timer; interrupts preview on C8; toggles bottom slot via B0/F/button", async () => {
    vi.useFakeTimers();
    let now = 30_000;
    const { audioDeps, advanceAudio, pianoStart, pianoStop } = createFakeAudioDeps();
    const { midiDeps, sendNoteOn, sendNoteOff } = createSimulatedMidiDeps();
    const storage = createInMemoryStorage();

    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: storage,
        audioDeps,
        midiDeps,
        clockDeps: { nowMs: () => now, getTimezoneOffsetMin: () => 0 },
        scoreRendererFactory: () =>
          ({
            async render() {
              return { measureCount: 4, measureGeometry: [] };
            },
            highlightMeasure() {},
            markAnchoredNotes() {},
            syncCursor() {},
            hitTestNoteAtClientPoint: () => null,
            scrollToMeasure() {},
            dispose() {},
          }) satisfies ScoreRendererHandle,
      }),
    );

    await uploadAndSplitTwoChunks(container);

    // Configure settings: 10 s Micro-Rest, manual preview, 10 s imagery timer ON
    await act(async () => {
      (container.querySelector('[data-testid="header-midi-status-btn"]') as HTMLButtonElement).click();
    });
    const slider = container.querySelector('[data-testid="micro-rest-duration-slider"]') as HTMLInputElement;
    expect(slider.value).toBe("12");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(slider, "10");
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const previewSelect = container.querySelector('[data-testid="audiation-preview-mode-select"]') as HTMLSelectElement;
    expect(previewSelect.value).toBe("auto-unfamiliar");
    await act(async () => {
      previewSelect.value = "manual";
      previewSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const imageryToggle = container.querySelector('[data-testid="audiation-imagery-timer-toggle"]') as HTMLInputElement;
    expect(imageryToggle.checked).toBe(false);
    await act(async () => {
      imageryToggle.click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(30);
    });

    const savedPrefs = (await storage.all("workspacePrefs")).find((p) => p.microRestDurationSec !== undefined);
    expect(savedPrefs).toMatchObject({
      microRestDurationSec: 10,
      audiationPreviewMode: "manual",
      audiationImageryTimerEnabled: true,
    });

    // Launch session and complete chunk 1 -> enters 10 s Micro-Rest
    await act(async () => {
      (container.querySelector('[data-testid="guided-start-session-btn"]') as HTMLButtonElement).click();
    });
    for (const step of [[60, 48], [62], [64, 43], [65]]) {
      now += 350;
      await act(async () => {
        for (const m of step) sendNoteOn(m, 88, now);
        for (const m of step) sendNoteOff(m, now + 60);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
      advanceAudio(5.0);
      await vi.advanceTimersByTimeAsync(30);
    });

    expect(container.querySelector('[data-testid="guided-micro-rest-countdown"]')?.textContent).toContain("10");

    // Soft-skip via >= 44px button -> enters Audiation Priming without auto-preview (manual mode)
    pianoStart.mockClear();
    pianoStop.mockClear();
    await act(async () => {
      (container.querySelector('[data-testid="guided-skip-micro-rest-btn"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("Audiation");
    expect(pianoStart).not.toHaveBeenCalled();

    // Optional 10 s imagery timer is visible and non-blocking
    expect(container.querySelector('[data-testid="audiation-imagery-timer"]')?.textContent).toContain("10");
    now += 4_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(container.querySelector('[data-testid="audiation-imagery-timer"]')?.textContent).toContain("6");

    // B0 -> swaps to 88-key HandPosture; F -> swaps back to AudiationPrimingBar; button -> swaps to 88-key -> B0 back
    await act(async () => {
      sendNoteOn(23, 88, now + 100);
      sendNoteOff(23, now + 140);
    });
    expect(container.querySelector('[data-testid="unified-piano-88"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="piano-command-badge-21"]')?.textContent).toContain("重练");
    expect(container.querySelector('[data-testid="piano-command-badge-23"]')?.textContent).toContain("反馈");
    expect(container.querySelector('[data-testid="piano-command-badge-108"]')?.textContent).toContain("继续");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF" }));
    });
    expect(container.querySelector('[data-testid="audiation-priming-bar"]')).not.toBeNull();

    await act(async () => {
      (container.querySelector('[data-testid="guided-back-to-piano-btn"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="unified-piano-88"]')).not.toBeNull();

    await act(async () => {
      sendNoteOn(23, 88, now + 200);
      sendNoteOff(23, now + 240);
    });
    expect(container.querySelector('[data-testid="audiation-priming-bar"]')).not.toBeNull();

    // Trigger manual soft audio preview, then press C8 to immediately interrupt and start chunk 2
    await act(async () => {
      (container.querySelector('[data-testid="audiation-preview-btn"]') as HTMLButtonElement).click();
    });
    expect(pianoStart).toHaveBeenCalled();

    await act(async () => {
      sendNoteOn(108, 88, now + 300);
      sendNoteOff(108, now + 340);
    });
    expect(pianoStop).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("Stage 0");

    // Complete chunk 2 Stage 0 & continuous play -> Micro-Rest -> summary phase -> B0/F bottom slot toggle
    for (const step of [[67, 52], [69], [71, 55], [72]]) {
      now += 350;
      await act(async () => {
        for (const m of step) sendNoteOn(m, 88, now);
        for (const m of step) sendNoteOff(m, now + 60);
      });
    }
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("定速连贯");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
      advanceAudio(5.0);
      await vi.advanceTimersByTimeAsync(30);
    });
    expect(container.querySelector('[data-testid="guided-micro-rest-veil"]')).not.toBeNull();
    await act(async () => {
      sendNoteOn(108, 88, now + 100);
      sendNoteOff(108, now + 140);
    });
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("本轮小结");
    expect(container.querySelector('[data-testid="guided-delayed-feedback-panel"]')).not.toBeNull();
    await act(async () => {
      sendNoteOn(23, 88, now + 200);
      sendNoteOff(23, now + 240);
    });
    expect(container.querySelector('[data-testid="unified-piano-88"]')).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF" }));
    });
    expect(container.querySelector('[data-testid="guided-delayed-feedback-panel"]')).not.toBeNull();
  });
});
