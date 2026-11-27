// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import type { ScoreRendererHandle } from "../src/components/ScoreViewer";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import type { MIDIAccessLike, MIDIInputLike, MIDIMessageEventLike } from "../src/midi/webMidi";
import { solveFingering } from "../src/solver/solveFingering";
import { localResolveFingering } from "../src/solver/localResolve";
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
        const response: WorkerResponse = {
          requestId: msg.requestId,
          ok: true,
          result,
        };
        queueMicrotask(() => {
          fakeWorker.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
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
    sendCc64(value: number, timeStampMs: number) {
      listener?.({ data: new Uint8Array([0xb0, 64, value]), timeStamp: timeStampMs });
    },
  };
}

// 4-measure grand-staff MusicXML with repeated 2-measure pattern (A1 = m1-2, A2 = m3-4)
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
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
    <measure number="4">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

// Score whose first measure legitimately uses both A0 (21) and A#0 (22)
const DUAL_LOW_PITCH_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction placement="above"><sound tempo="120"/></direction>
      <note><pitch><step>A</step><octave>0</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <note><pitch><step>A</step><alter>1</alter><octave>0</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;

async function uploadXml(container: HTMLElement, xml: string, fileName = "guided-test.musicxml") {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const fakeFile = {
    name: fileName,
    text: async () => xml,
    arrayBuffer: async () => new TextEncoder().encode(xml).buffer,
  };
  Object.defineProperty(input, "files", { value: [fakeFile], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
  });
}

describe("<App /> Guided Session end-to-end (Simulated MIDI + DI seams)", () => {
  it("lands in Free Studio, launches Guided Session card, runs Stage 0 -> A0+A#0 pause -> suspend/anchor/resume -> A0/B0/C8 hands-free flow", async () => {
    let now = 10_000;
    const { audioDeps, advanceAudio } = createFakeAudioDeps();
    const { midiDeps, sendNoteOn, sendNoteOff } = createSimulatedMidiDeps();
    const highlightSpotlightRange = vi.fn();
    const scrollToMeasure = vi.fn();
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
            highlightSpotlightRange,
            markAnchoredNotes() {},
            syncCursor() {},
            hitTestNoteAtClientPoint: () => ({ measureIndex: 0, midi: 60, staffId: 1 }),
            scrollToMeasure,
            dispose() {},
          }) satisfies ScoreRendererHandle,
      }),
    );

    await uploadXml(container, FOUR_MEASURE_GRAND_STAFF_XML);

    // 1. Lands in Free Studio with non-blocking Guided Session launch strip
    expect(container.querySelector('[data-testid="guided-launch-strip"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="guided-launch-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="practice-mode-both"]')?.getAttribute("aria-pressed")).toBe("true");

    // 2. Open Guided Session Launch Card (single-piece, 15/25/40, leverage, MacroSection, queue preview)
    await act(async () => {
      (container.querySelector('[data-testid="guided-strip-start-btn"]') as HTMLButtonElement).click();
    });

    const launchCard = container.querySelector('[data-testid="guided-launch-card"]');
    expect(launchCard).not.toBeNull();
    expect(container.querySelector('[data-testid="guided-timebox-15"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="guided-timebox-25"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="guided-timebox-40"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="guided-leverage-summary"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="guided-macro-section-select"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="guided-queue-preview"]')).not.toBeNull();
    // Pre-launch chunk/cue editing is available on ScoreViewer; split at barline 2 so m.1-2 & m.3-4 are two chunks
    expect(container.querySelector('[data-testid="motor-chunk-strip"]')).not.toBeNull();
    const splitBtn = container.querySelector('[data-testid="chunk-barline-split-2"]') as HTMLButtonElement | null;
    if (splitBtn) {
      await act(async () => {
        splitBtn.click();
      });
    }

    // Verify orthogonal PracticeMode switch (RH-only) works inside Guided Session without leaving Guided
    await act(async () => {
      (container.querySelector('[data-testid="practice-mode-rh-only"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="practice-mode-rh-only"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-testid="guided-launch-card"]')).not.toBeNull();
    // Switch back to Both Hands
    await act(async () => {
      (container.querySelector('[data-testid="practice-mode-both"]') as HTMLButtonElement).click();
    });

    // Verify inline Piano Command Keys badges on A0 (21), B0 (23), C8 (108)
    expect(container.querySelector('[data-testid="piano-command-badge-21"]')?.textContent).toContain("重练");
    expect(container.querySelector('[data-testid="piano-command-badge-23"]')?.textContent).toContain("反馈");
    expect(container.querySelector('[data-testid="piano-command-badge-108"]')?.textContent).toContain("继续");

    // Select 15 min preset and launch via C8 (midi 108)
    await act(async () => {
      (container.querySelector('[data-testid="guided-timebox-15"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      sendNoteOn(108, 90, now);
      sendNoteOff(108, now + 50);
    });

    // 3. Stage 0 active: slim header, chunk spotlighting, fingerings & HandPosture visible
    expect(container.querySelector('[data-testid="guided-session-header"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("Stage 0");
    expect(highlightSpotlightRange).toHaveBeenCalled();
    expect(scrollToMeasure).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="hand-overlay-RH"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="hand-overlay-LH"]')).not.toBeNull();

    // Single-key B0 ignored as view-toggle command during active Stage 0 (treated as non-target keystroke)
    await act(async () => {
      sendNoteOn(23, 85, now + 100);
      sendNoteOff(23, now + 150);
    });
    expect(container.querySelector('[data-testid="guided-delayed-feedback-panel"]')).toBeNull();

    // Pass 1 has 1 wrong note (B0) out of 6 notes (83.3% < 90%) -> remains in Stage 0 for retry
    const chunk1Steps: number[][] = [
      [60, 48], // C4 + C3
      [62],     // D4
      [64, 43], // E4 + G2
      [65],     // F4
    ];
    for (let s = 0; s < chunk1Steps.length; s++) {
      now += 400;
      await act(async () => {
        for (const midi of chunk1Steps[s]) {
          sendNoteOn(midi, 88, now);
        }
        for (const midi of chunk1Steps[s]) {
          sendNoteOff(midi, now + 80);
        }
      });
    }
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("Stage 0");

    // Pass 2 cleanly (>= 90% and 0 long hesitation) -> graduates to continuous playing!
    for (let s = 0; s < chunk1Steps.length; s++) {
      now += 400;
      await act(async () => {
        for (const midi of chunk1Steps[s]) {
          sendNoteOn(midi, 88, now);
        }
        for (const midi of chunk1Steps[s]) {
          sendNoteOff(midi, now + 80);
        }
      });
    }

    // Graduated to continuous playing!
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("定速连贯");

    // 4. During active continuous play: single-key C8 ignored, dual-key A0+A#0 pauses!
    await act(async () => {
      sendNoteOn(108, 88, now + 100);
      sendNoteOff(108, now + 140);
    });
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("定速连贯");

    await act(async () => {
      sendNoteOn(21, 88, now + 200);
      sendNoteOn(22, 88, now + 240);
      sendNoteOff(21, now + 300);
      sendNoteOff(22, now + 300);
    });
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("已暂停");

    // 5. Suspend ("暂离调指法") -> edit FingerAnchor in Free Studio -> resume via persistent header pill
    await act(async () => {
      (container.querySelector('[data-testid="guided-suspend-btn"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="guided-resume-pill"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="undo-btn"]')).not.toBeNull();

    // Edit FingerAnchor on measure 1 C4 (midi 60) while suspended in Free Studio
    await act(async () => {
      (container.querySelector('[data-testid="osmd-canvas-surface"]') as HTMLElement).click();
    });
    expect(container.querySelector('[data-testid="note-anchor-popover"]')).not.toBeNull();
    await act(async () => {
      (container.querySelector('[data-testid="finger-btn-5"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(container.querySelector('[data-testid="anchor-indicators"]')?.textContent).toContain(": 5");

    // Resume back to Guided Session with refreshed FingerAssignment/TransitionCue overlays
    await act(async () => {
      (container.querySelector('[data-testid="guided-resume-pill"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="guided-session-header"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("已暂停");
    expect(container.querySelector('[data-testid="anchor-indicators"]')?.textContent).toContain(": 5");

    // 6. In paused non-playing window: B0 toggles delayed feedback <-> 88-key posture; A0 replays Stage 0
    await act(async () => {
      sendNoteOn(23, 88, now + 500);
      sendNoteOff(23, now + 550);
    });
    expect(container.querySelector('[data-testid="guided-delayed-feedback-panel"]')).not.toBeNull();

    await act(async () => {
      sendNoteOn(23, 88, now + 600);
      sendNoteOff(23, now + 650);
    });
    expect(container.querySelector('[data-testid="piano-key-60"]')).not.toBeNull();

    // A0 replays current chunk in Stage 0
    await act(async () => {
      sendNoteOn(21, 88, now + 700);
      sendNoteOff(21, now + 750);
    });
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("Stage 0");

    // Explicit end session returns cleanly to Free Studio
    await act(async () => {
      (container.querySelector('[data-testid="guided-end-session-btn"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="guided-session-header"]')).toBeNull();
    expect(container.querySelector('[data-testid="guided-launch-strip"]')).not.toBeNull();
    void advanceAudio;
  });

  it("auto-disables A0+A#0 pause on dual-pitch conflict, keeps CC64 opt-in, and auto-graduates Stage 0 at 2-minute cap", async () => {
    vi.useFakeTimers();
    let now = 50_000;
    const { audioDeps } = createFakeAudioDeps();
    const { midiDeps, sendNoteOn, sendNoteOff, sendCc64 } = createSimulatedMidiDeps();

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
              return { measureCount: 2, measureGeometry: [] };
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

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const fakeFile = {
      name: "dual-low.musicxml",
      text: async () => DUAL_LOW_PITCH_XML,
      arrayBuffer: async () => new TextEncoder().encode(DUAL_LOW_PITCH_XML).buffer,
    };
    Object.defineProperty(input, "files", { value: [fakeFile], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(100);
    });

    await act(async () => {
      (container.querySelector('[data-testid="guided-strip-start-btn"]') as HTMLButtonElement).click();
    });

    // CC64 does NOT start session when cc64CommandEnabled is false (default)
    await act(async () => {
      sendCc64(127, now);
      sendCc64(0, now + 50);
    });
    expect(container.querySelector('[data-testid="guided-launch-card"]')).not.toBeNull();

    // Enable CC64 opt-in in Settings
    await act(async () => {
      (container.querySelector('[data-testid="header-midi-status-btn"]') as HTMLButtonElement).click();
    });
    const cc64Toggle = container.querySelector('[data-testid="cc64-command-toggle"]') as HTMLInputElement;
    expect(cc64Toggle.checked).toBe(false);
    await act(async () => {
      cc64Toggle.click();
    });
    expect(cc64Toggle.checked).toBe(true);
    await act(async () => {
      (container.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement).click();
    });

    // Now CC64 in non-playing launch window starts the session!
    await act(async () => {
      sendCc64(127, now + 100);
      sendCc64(0, now + 150);
    });
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("Stage 0");

    // Dual-pitch conflict notice is visible and A0+A#0 badges show disabled
    expect(container.querySelector('[data-testid="guided-dual-pitch-notice"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="piano-command-badge-21"]')?.getAttribute("data-command-disabled"),
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="piano-command-badge-22"]')?.getAttribute("data-command-disabled"),
    ).toBe("true");

    // Pressing A0 + A#0 does NOT trigger emergency pause when disabled
    await act(async () => {
      sendNoteOn(21, 90, now + 200);
      sendNoteOn(22, 90, now + 230);
      sendNoteOff(21, now + 280);
      sendNoteOff(22, now + 280);
    });
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("Stage 0");

    // Advancing 2 minutes (120_000 ms) auto-graduates Stage 0 to continuous playing!
    now += 120_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("定速连贯");
  });

  it("shows zero-data Micro-Rest veil after continuous play, pulses reminder on accidental keystroke, and soft-skips via C8 into first-note ready start", async () => {
    let now = 20_000;
    const { audioDeps, advanceAudio } = createFakeAudioDeps();
    const { midiDeps, sendNoteOn, sendNoteOff } = createSimulatedMidiDeps();

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

    // Complete Stage 0 chunk 1 cleanly -> graduates to continuous playing
    for (const step of [[60, 48], [62], [64, 43], [65]]) {
      now += 350;
      await act(async () => {
        for (const m of step) sendNoteOn(m, 88, now);
        for (const m of step) sendNoteOff(m, now + 60);
      });
    }
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("定速连贯");

    // Advance fake AudioContext past chunk 1 end (4 seconds at 120 bpm = 2 measures * 2s)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
      advanceAudio(5.0);
      await new Promise((r) => setTimeout(r, 20));
    });

    // Micro-Rest veil appears with zero diagnostic metrics
    const veil = container.querySelector('[data-testid="guided-micro-rest-veil"]');
    expect(veil).not.toBeNull();
    expect(veil?.textContent).not.toContain("nPVI");
    expect(veil?.textContent).not.toContain("准确率");

    // Accidental non-command note during Micro-Rest pulses gentle reminder without aborting
    await act(async () => {
      sendNoteOn(62, 85, now + 200);
      sendNoteOff(62, now + 250);
    });
    expect(container.querySelector('[data-testid="guided-micro-rest-veil"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="guided-micro-rest-reminder"]')).not.toBeNull();

    // Soft-skip Micro-Rest with C8 -> enters Audiation ready window
    await act(async () => {
      sendNoteOn(108, 85, now + 300);
      sendNoteOff(108, now + 350);
    });
    expect(container.querySelector('[data-testid="guided-micro-rest-veil"]')).toBeNull();
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("Audiation");

    // Playing first target note of next chunk (C4 = 60) starts immediately!
    await act(async () => {
      sendNoteOn(60, 88, now + 400);
      sendNoteOff(60, now + 450);
    });
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("Stage 0");
  });
});
