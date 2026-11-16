// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../src/App";
import type { ScoreRendererHandle } from "../src/components/ScoreViewer";
import { solveFingering } from "../src/solver/solveFingering";
import { createSolverClient, type WorkerLike } from "../src/workers/solverClient";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";

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

function inProcessWorkerFactory() {
  return () => {
    const fakeWorker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(rawMsg: unknown) {
        const msg = rawMsg as WorkerRequest;
        if (msg.type !== "local-resolve") {
          const result = solveFingering(msg.onsetSlices, msg.profile, {
            ignoreExistingFingerings: msg.ignoreExistingFingerings,
          });
          const response: WorkerResponse = {
            requestId: msg.requestId,
            ok: true,
            result,
          };
          queueMicrotask(() => {
            fakeWorker.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
          });
        }
      },
      terminate() {},
    };
    return createSolverClient(() => fakeWorker);
  };
}

function createNoopScoreRenderer(): ScoreRendererHandle {
  return {
    async render() {
      return { measureCount: 4, measureGeometry: [] };
    },
    highlightMeasure() {},
    markAnchoredNotes() {},
    syncCursor() {},
    hitTestNoteAtClientPoint: () => null,
    scrollToMeasure() {},
    dispose() {},
  };
}

const FOUR_MEASURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
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

async function uploadXml(container: HTMLElement, xml: string, name = "ab-loop.musicxml") {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const fakeFile = {
    name,
    text: async () => xml,
    arrayBuffer: async () => new TextEncoder().encode(xml).buffer,
  };
  Object.defineProperty(input, "files", { value: [fakeFile], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
  });
}

function createFakeAudioDeps() {
  const rafCallbacks = new Map<number, FrameRequestCallback>();
  let nextRafId = 1;
  const rawCtx = {
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
    })),
    createOscillator: vi.fn(() => ({
      type: "sine",
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    })),
  };

  return {
    rawCtx,
    tickRaf: () => {
      const entries = [...rafCallbacks.entries()];
      rafCallbacks.clear();
      for (const [, cb] of entries) cb(16);
    },
    audioDeps: {
      getAudioContext: () => rawCtx as unknown as AudioContext,
      loadSmplrPiano: async () => ({
        load: Promise.resolve(),
        start: vi.fn(),
        stop: vi.fn(),
      }),
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        const id = nextRafId++;
        rafCallbacks.set(id, cb);
        return id;
      },
      cancelAnimationFrame: (id: number) => {
        rafCallbacks.delete(id);
      },
    },
  };
}

function createMockMidiDeps() {
  const listeners = new Set<(e: { data: Uint8Array }) => void>();
  const inputs = new Map([
    [
      "dev-1",
      {
        id: "dev-1",
        name: "Mock Piano",
        manufacturer: "Test",
        state: "connected" as const,
        type: "input" as const,
        onmidimessage: null as ((e: { data: Uint8Array | number[] | null }) => void) | null,
      },
    ],
  ]);

  return {
    sendNoteOn: (midi: number, velocity = 96) => {
      const dev = inputs.get("dev-1")!;
      const msg = { data: new Uint8Array([0x90, midi, velocity]) };
      dev.onmidimessage?.(msg);
      for (const l of listeners) l(msg);
    },
    midiDeps: {
      requestMIDIAccess: async () => ({
        inputs,
        onstatechange: null,
      }),
    },
  };
}

describe("Slice 4: Whole-Measure A-B Loop & Loop Gap in <App />", () => {
  it("allows toggling A-B Loop, picking/normalizing A and B bounds, highlighting [A..B] on the measure ruler, and clearing the loop", async () => {
    const { audioDeps } = createFakeAudioDeps();
    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessWorkerFactory(),
        scoreRendererFactory: () => createNoopScoreRenderer(),
        audioDeps,
      })
    );

    await uploadXml(container, FOUR_MEASURE_XML);

    const toggleBtn = container.querySelector('[data-testid="ab-loop-toggle-btn"]') as HTMLButtonElement;
    const startSelect = container.querySelector('[data-testid="ab-loop-start-select"]') as HTMLSelectElement;
    const endSelect = container.querySelector('[data-testid="ab-loop-end-select"]') as HTMLSelectElement;
    const clearBtn = container.querySelector('[data-testid="ab-loop-clear-btn"]') as HTMLButtonElement;

    expect(toggleBtn.getAttribute("aria-pressed")).toBe("false");

    // Pick A = 2 (m.3), B = 1 (m.2) -> auto-normalizes to A = 1, B = 2
    act(() => {
      startSelect.value = "2";
      startSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      endSelect.value = "1";
      endSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(startSelect.value).toBe("1");
    expect(endSelect.value).toBe("2");

    // Enable A-B Loop
    act(() => {
      toggleBtn.click();
    });
    expect(toggleBtn.getAttribute("aria-pressed")).toBe("true");

    // Ruler measures 1 and 2 (0-based) are highlighted, 0 and 3 are not
    expect(
      container.querySelector('[data-testid="measure-ruler-item-0"]')?.getAttribute("data-in-ab-loop")
    ).toBe("false");
    expect(
      container.querySelector('[data-testid="measure-ruler-item-1"]')?.getAttribute("data-in-ab-loop")
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="measure-ruler-item-2"]')?.getAttribute("data-in-ab-loop")
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="measure-ruler-item-3"]')?.getAttribute("data-in-ab-loop")
    ).toBe("false");

    // Clear resets loop
    act(() => {
      clearBtn.click();
    });
    expect(toggleBtn.getAttribute("aria-pressed")).toBe("false");
    expect(
      container.querySelector('[data-testid="measure-ruler-item-1"]')?.getAttribute("data-in-ab-loop")
    ).toBe("false");
  });

  it("wraps Waiting Mode from measure B's final PracticeStep back to measure A's first PracticeStep with Loop Gap Count-In", async () => {
    const { audioDeps, rawCtx, tickRaf } = createFakeAudioDeps();
    const { midiDeps, sendNoteOn } = createMockMidiDeps();

    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessWorkerFactory(),
        scoreRendererFactory: () => createNoopScoreRenderer(),
        audioDeps,
        midiDeps,
      })
    );

    await uploadXml(container, FOUR_MEASURE_XML);

    // Open Practice Settings and enable Loop Gap
    const settingsBtn = container.querySelector('[data-testid="practice-settings-btn"]') as HTMLButtonElement;
    act(() => {
      settingsBtn.click();
    });
    const loopGapToggle = container.querySelector('[data-testid="loop-gap-toggle"]') as HTMLInputElement;
    expect(loopGapToggle.checked).toBe(false);
    act(() => {
      loopGapToggle.click();
    });
    expect(loopGapToggle.checked).toBe(true);
    const closeBtn = container.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement;
    act(() => {
      closeBtn.click();
    });

    // Set A-B Loop to [1..2] (m.2..m.3: D4=62, E4=64) and enable
    const startSelect = container.querySelector('[data-testid="ab-loop-start-select"]') as HTMLSelectElement;
    const endSelect = container.querySelector('[data-testid="ab-loop-end-select"]') as HTMLSelectElement;
    const abToggleBtn = container.querySelector('[data-testid="ab-loop-toggle-btn"]') as HTMLButtonElement;
    act(() => {
      startSelect.value = "1";
      startSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      endSelect.value = "2";
      endSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      abToggleBtn.click();
    });

    // Enable Waiting Mode and click Play
    const waitingBtn = container.querySelector('[data-testid="waiting-mode-toggle-btn"]') as HTMLButtonElement;
    act(() => {
      waitingBtn.click();
    });
    const playBtn = container.querySelector('[data-testid="audio-play-btn"]') as HTMLButtonElement;
    await act(async () => {
      playBtn.click();
      await new Promise((r) => setTimeout(r, 10));
    });

    // Should start waiting on measure 2 (0-based 1, D4=62)
    expect(
      container.querySelector('[data-testid="measure-ruler-item-1"]')?.className
    ).toContain("bg-blue-600");

    // Play D4 (62) -> advances to measure 3 (0-based 2, E4=64)
    act(() => {
      sendNoteOn(62);
    });
    expect(
      container.querySelector('[data-testid="measure-ruler-item-2"]')?.className
    ).toContain("bg-blue-600");

    // Play E4 (64) -> wraps to measure 2 (0-based 1) and triggers 1-measure Count-In Loop Gap (3/4 at 120 BPM = 1.5s)
    await act(async () => {
      sendNoteOn(64);
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.querySelector('[data-testid="count-in-indicator"]')?.textContent).toContain(
      "预备拍: 3"
    );

    // Finish the 1.5s Loop Gap Count-In
    act(() => {
      rawCtx.currentTime = 1.52;
      tickRaf();
    });

    expect(container.querySelector('[data-testid="count-in-indicator"]')).toBeNull();
    // Now waiting on measure 2 (0-based 1, D4=62) again!
    expect(
      container.querySelector('[data-testid="measure-ruler-item-1"]')?.className
    ).toContain("bg-blue-600");
  });

  it("cancels in-progress Loop Gap Count-In cleanly when Waiting Mode is turned off or Stop is pressed", async () => {
    const { audioDeps, rawCtx, tickRaf } = createFakeAudioDeps();
    const { midiDeps, sendNoteOn } = createMockMidiDeps();

    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessWorkerFactory(),
        scoreRendererFactory: () => createNoopScoreRenderer(),
        audioDeps,
        midiDeps,
      })
    );

    await uploadXml(container, FOUR_MEASURE_XML);

    // Enable Loop Gap in Practice Settings
    act(() => {
      (container.querySelector('[data-testid="practice-settings-btn"]') as HTMLButtonElement).click();
    });
    act(() => {
      (container.querySelector('[data-testid="loop-gap-toggle"]') as HTMLInputElement).click();
    });
    act(() => {
      (container.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement).click();
    });

    // Enable A-B Loop on [1..1] (m.2 only: D4=62)
    const startSelect = container.querySelector('[data-testid="ab-loop-start-select"]') as HTMLSelectElement;
    const endSelect = container.querySelector('[data-testid="ab-loop-end-select"]') as HTMLSelectElement;
    const abToggleBtn = container.querySelector('[data-testid="ab-loop-toggle-btn"]') as HTMLButtonElement;
    act(() => {
      startSelect.value = "1";
      startSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      endSelect.value = "1";
      endSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      abToggleBtn.click();
    });

    // Enable Metronome + Waiting Mode and start Play
    act(() => {
      (container.querySelector('[data-testid="metronome-toggle-btn"]') as HTMLButtonElement).click();
    });
    const waitingBtn = container.querySelector('[data-testid="waiting-mode-toggle-btn"]') as HTMLButtonElement;
    act(() => {
      waitingBtn.click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="audio-play-btn"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 10));
    });

    // Complete m.2 (D4=62) -> wraps back to m.2 and starts Loop Gap Count-In
    await act(async () => {
      sendNoteOn(62);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(container.querySelector('[data-testid="count-in-indicator"]')?.textContent).toContain(
      "预备拍: 3"
    );

    // Turn off Waiting Mode mid-Count-In -> must cancel Count-In and unpause metronome
    act(() => {
      waitingBtn.click();
    });
    expect(waitingBtn.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('[data-testid="count-in-indicator"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="metronome-beat-indicator"]')?.getAttribute("data-metronome-paused")
    ).toBe("false");

    // Advancing audio time later must NOT trigger any stale callback or re-pause metronome
    act(() => {
      rawCtx.currentTime = 2.0;
      tickRaf();
    });
    expect(container.querySelector('[data-testid="count-in-indicator"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="metronome-beat-indicator"]')?.getAttribute("data-metronome-paused")
    ).toBe("false");

    // Re-enable Waiting Mode, trigger Loop Gap again, then press Stop mid-Count-In
    act(() => {
      waitingBtn.click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="audio-play-btn"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 10));
    });
    await act(async () => {
      sendNoteOn(62);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(container.querySelector('[data-testid="count-in-indicator"]')).not.toBeNull();

    act(() => {
      (container.querySelector('[data-testid="audio-stop-btn"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="count-in-indicator"]')).toBeNull();
    act(() => {
      rawCtx.currentTime = 4.0;
      tickRaf();
    });
    expect(container.querySelector('[data-testid="count-in-indicator"]')).toBeNull();
  });
});
