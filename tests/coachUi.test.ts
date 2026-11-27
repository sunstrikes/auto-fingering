// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import {
  COACH_SECRET_STORAGE_KEY,
  COACH_SETTINGS_STORAGE_KEY,
} from "../src/coach/secretStorage";
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

beforeEach(() => {
  try {
    window.sessionStorage.clear();
    window.localStorage.clear();
  } catch {
    // ignore
  }
});

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

  return {
    audioDeps: {
      getAudioContext: () => fakeCtx,
      loadSmplrPiano: vi.fn(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      })),
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
    name: "coach-ui.musicxml",
    text: async () => xml,
    arrayBuffer: async () => new TextEncoder().encode(xml).buffer,
  };
  Object.defineProperty(input, "files", { value: [fakeFile], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(120);
  });
}

function makeRendererFactory(): () => ScoreRendererHandle {
  return () => ({
    async render() {
      return { measureCount: 4, measureGeometry: [] };
    },
    highlightMeasure() {},
    highlightSpotlightRange() {},
    markAnchoredNotes() {},
    syncCursor() {},
    hitTestNoteAtClientPoint: () => null,
    scrollToMeasure() {},
    dispose() {},
  });
}

const CHUNK_1_STEPS: ReadonlyArray<{ offsetMs: number; notes: Array<{ midi: number; vel: number }> }> = [
  { offsetMs: 0, notes: [{ midi: 72, vel: 92 }, { midi: 48, vel: 60 }] },
  { offsetMs: 370, notes: [{ midi: 74, vel: 94 }] },
  { offsetMs: 1110, notes: [{ midi: 76, vel: 95 }, { midi: 43, vel: 62 }] },
  { offsetMs: 1500, notes: [{ midi: 77, vel: 93 }] },
  { offsetMs: 2000, notes: [{ midi: 79, vel: 96 }, { midi: 52, vel: 61 }] },
  { offsetMs: 2500, notes: [{ midi: 81, vel: 94 }] },
  { offsetMs: 3000, notes: [{ midi: 79, vel: 92 }, { midi: 50, vel: 63 }] },
  { offsetMs: 3500, notes: [{ midi: 77, vel: 95 }] },
];

function setInputValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Ticket #37 UI: ExternalFocusCoachCard, CoachSettingsSection, Free Studio tip & Cue polish", () => {
  it("renders 0 ms offline external-focus template in GuidedBottomSlot, supports on-demand G-key BYOK trigger with plain-text XSS escaping, and never blocks C8", async () => {
    vi.useFakeTimers();
    const { audioDeps, advanceAudio } = createFakeAudioDeps();
    const { midiDeps, sendNoteOn, sendNoteOff } = createSimulatedMidiDeps();
    const storage = createInMemoryStorage();

    let resolveCoachCall: ((res: Response) => void) | null = null;
    const coachFetch = vi.fn<typeof fetch>(() => {
      return new Promise<Response>((resolve) => {
        resolveCoachCall = resolve;
      });
    });

    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: storage,
        audioDeps,
        midiDeps,
        coachFetch,
        clockDeps: { nowMs: () => performance.now(), getTimezoneOffsetMin: () => 0 },
        scoreRendererFactory: makeRendererFactory(),
      }),
    );

    await uploadXml(container, FOUR_MEASURE_GRAND_STAFF_XML);

    // Configure BYOK OpenRouter in PracticeSettingsModal (default sessionStorage, on-demand cadence)
    await act(async () => {
      (container.querySelector('[data-testid="practice-settings-btn"]') as HTMLButtonElement).click();
    });
    const enabledToggle = container.querySelector(
      '[data-testid="coach-enabled-toggle"]',
    ) as HTMLInputElement;
    expect(enabledToggle).not.toBeNull();
    await act(async () => {
      enabledToggle.click();
    });
    const keyInput = container.querySelector('[data-testid="coach-apikey-input"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(keyInput, "sk-or-ui-session-secret");
    });

    // Key is stored ONLY in sessionStorage by default, NEVER in localStorage
    expect(window.sessionStorage.getItem(COACH_SECRET_STORAGE_KEY)).toBe("sk-or-ui-session-secret");
    expect(window.localStorage.getItem(COACH_SECRET_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(COACH_SETTINGS_STORAGE_KEY)).not.toContain("sk-or-ui-session-secret");

    await act(async () => {
      (container.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement).click();
    });

    // Start Guided Session with split chunks
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

    // Graduate Stage 0 of chunk 1
    for (const s of CHUNK_1_STEPS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
        const ts = performance.now();
        for (const n of s.notes) sendNoteOn(n.midi, n.vel, ts);
        for (const n of s.notes) sendNoteOff(n.midi, ts + 80);
      });
    }

    // Play continuous bout
    const t0 = performance.now();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    for (const s of CHUNK_1_STEPS) {
      await act(async () => {
        for (const n of s.notes) sendNoteOn(n.midi, n.vel, t0 + s.offsetMs);
        for (const n of s.notes) sendNoteOff(n.midi, t0 + s.offsetMs + 180);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
      advanceAudio(4.2);
      await vi.advanceTimersByTimeAsync(30);
    });

    // Skip Micro-Rest -> Audiation Priming feedback slot
    await act(async () => {
      sendNoteOn(108, 88, performance.now());
      sendNoteOff(108, performance.now() + 40);
    });

    // 0 ms offline template renders immediately and on-demand cadence did NOT auto-call coachFetch
    const coachCard = container.querySelector('[data-testid="external-focus-coach-card"]');
    expect(coachCard).not.toBeNull();
    expect(coachCard!.textContent).toContain("第");
    expect(coachFetch).not.toHaveBeenCalled();

    // Trigger on-demand via 'G' key
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", code: "KeyG", bubbles: true }));
    });
    expect(coachFetch).toHaveBeenCalledTimes(1);

    // Resolve with an XSS-containing valid-whitelist payload -> rendered strictly as plain text
    await act(async () => {
      resolveCoachCall?.(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    praise: "第1-2小节声响平稳 <img src=x onerror=alert(1)>。",
                    focusCues: [
                      {
                        evidenceId: "ev-m1-evenness",
                        measures: [1],
                        soundCue: "第1小节想象颗粒像珍珠滚过琴键。",
                      },
                    ],
                    nextPassListeningGoal: "下一遍听清乐句颗粒均匀推进。",
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(coachCard!.querySelector("img")).toBeNull();
    expect(coachCard!.querySelector("script")).toBeNull();
    expect(coachCard!.textContent).toContain("<img src=x onerror=alert(1)>");

    // Non-blocking C8 continue works immediately even if a second async coach request is in-flight
    await act(async () => {
      (container.querySelector('[data-testid="coach-trigger-btn"]') as HTMLButtonElement).click();
    });
    expect(coachFetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      sendNoteOn(108, 88, performance.now());
      sendNoteOff(108, performance.now() + 40);
    });
    expect(container.querySelector('[data-testid="guided-micro-rest-veil"]')).toBeNull();
    expect(["stage0", "playing"]).toContain(
      container.querySelector('[data-testid="guided-phase-badge"]')?.getAttribute("data-phase") ??
        (container.querySelector('[data-testid="guided-phase-badge"]')?.textContent?.includes("Stage 0")
          ? "stage0"
          : "playing"),
    );
  });

  it("shows offline external-focus tip in Free Studio acoustic badge, supports 1-click PerformanceCue polish, and renders Ollama/OpenAI diagnostics in settings", async () => {
    vi.useFakeTimers();
    const { audioDeps, advanceAudio } = createFakeAudioDeps();
    const { midiDeps, sendNoteOn, sendNoteOff } = createSimulatedMidiDeps();
    const storage = createInMemoryStorage();

    const coachFetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.openai.com")) {
        throw new TypeError("Failed to fetch");
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ label: "听见新乐句明亮起唱" }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: storage,
        audioDeps,
        midiDeps,
        coachFetch,
        clockDeps: { nowMs: () => performance.now(), getTimezoneOffsetMin: () => 0 },
        scoreRendererFactory: makeRendererFactory(),
      }),
    );

    await uploadXml(container, FOUR_MEASURE_GRAND_STAFF_XML);

    // Free Studio A-B Loop -> offline external-focus tip inside free-acoustic-popover
    await act(async () => {
      (container.querySelector('[data-testid="ab-loop-toggle-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="measure-ruler-item-0"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="measure-ruler-item-1"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="audio-play-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(20);
    });
    const t0 = performance.now();
    for (const s of CHUNK_1_STEPS) {
      await act(async () => {
        for (const n of s.notes) sendNoteOn(n.midi, n.vel, t0 + s.offsetMs);
        for (const n of s.notes) sendNoteOff(n.midi, t0 + s.offsetMs + 180);
      });
    }
    await act(async () => {
      advanceAudio(4.1);
      await vi.advanceTimersByTimeAsync(20);
    });

    await act(async () => {
      (container.querySelector('[data-testid="free-acoustic-badge-btn"]') as HTMLButtonElement).click();
    });
    const tipEl = container.querySelector('[data-testid="free-acoustic-coach-tip"]');
    expect(tipEl).not.toBeNull();
    expect(tipEl!.textContent?.length).toBeGreaterThan(0);
    expect(coachFetch).not.toHaveBeenCalled();

    // Stop playback so chunk/cue strip is enabled, then configure BYOK and test 1-click PerformanceCue polish
    await act(async () => {
      (container.querySelector('[data-testid="audio-stop-btn"]') as HTMLButtonElement).click();
    });

    await act(async () => {
      (container.querySelector('[data-testid="practice-settings-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="coach-enabled-toggle"]') as HTMLInputElement).click();
    });
    await act(async () => {
      setInputValue(
        container.querySelector('[data-testid="coach-apikey-input"]') as HTMLInputElement,
        "sk-test-key",
      );
    });

    // Verify Ollama exact-origin wizard (never *)
    await act(async () => {
      setInputValue(
        container.querySelector('[data-testid="coach-provider-select"]') as HTMLSelectElement,
        "ollama",
      );
    });
    const ollamaBox = container.querySelector('[data-testid="coach-ollama-origins"]');
    expect(ollamaBox).not.toBeNull();
    expect(ollamaBox!.textContent).toContain("OLLAMA_ORIGINS=");
    expect(ollamaBox!.textContent).not.toContain('OLLAMA_ORIGINS="*"');

    // Verify OpenAI 401 missing-CORS diagnostic when testing connection
    await act(async () => {
      setInputValue(
        container.querySelector('[data-testid="coach-provider-select"]') as HTMLSelectElement,
        "openai",
      );
    });
    await act(async () => {
      (container.querySelector('[data-testid="coach-test-connection-btn"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const diagAlert = container.querySelector('[data-testid="coach-diagnostic-alert"]');
    expect(diagAlert).not.toBeNull();
    expect(diagAlert!.textContent).toContain("401");
    expect(diagAlert!.textContent).toContain("CORS");

    // Switch back to OpenRouter and close modal to polish a PerformanceCue
    await act(async () => {
      setInputValue(
        container.querySelector('[data-testid="coach-provider-select"]') as HTMLSelectElement,
        "openrouter",
      );
    });
    await act(async () => {
      (container.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement).click();
    });

    const polishBtn = container.querySelector('[data-testid^="cue-polish-btn-"]') as HTMLButtonElement | null;
    expect(polishBtn).not.toBeNull();
    await act(async () => {
      polishBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="performance-cue-bar"]')?.textContent).toContain(
      "听见新乐句明亮起唱",
    );
  });

  it("supports every-3-bouts cadence (never per-bout), opt-in localStorage key persistence with warning, and zero dangerouslySetInnerHTML", async () => {
    for (const file of [
      "src/components/ExternalFocusCoachCard.tsx",
      "src/components/CoachSettingsSection.tsx",
    ]) {
      const src = fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
      expect(src).not.toContain("dangerouslySetInnerHTML");
    }

    vi.useFakeTimers();
    const { audioDeps, advanceAudio } = createFakeAudioDeps();
    const { midiDeps, sendNoteOn, sendNoteOff } = createSimulatedMidiDeps();
    const storage = createInMemoryStorage();

    const coachFetch = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  praise: "第1-4小节声响清晰均匀。",
                  focusCues: [],
                  nextPassListeningGoal: "下一遍继续听见流畅的乐句呼吸。",
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: storage,
        audioDeps,
        midiDeps,
        coachFetch,
        clockDeps: { nowMs: () => performance.now(), getTimezoneOffsetMin: () => 0 },
        scoreRendererFactory: makeRendererFactory(),
      }),
    );

    await uploadXml(container, FOUR_MEASURE_GRAND_STAFF_XML);

    // Enable coach with opt-in localStorage persistence + every-3-bouts cadence
    await act(async () => {
      (container.querySelector('[data-testid="practice-settings-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="coach-enabled-toggle"]') as HTMLInputElement).click();
    });
    await act(async () => {
      setInputValue(
        container.querySelector('[data-testid="coach-apikey-input"]') as HTMLInputElement,
        "sk-local-remember-key",
      );
    });
    await act(async () => {
      (container.querySelector('[data-testid="coach-remember-key-toggle"]') as HTMLInputElement).click();
    });
    expect(container.textContent).toContain("公共/共享电脑");
    expect(window.localStorage.getItem(COACH_SECRET_STORAGE_KEY)).toBe("sk-local-remember-key");
    expect(window.sessionStorage.getItem(COACH_SECRET_STORAGE_KEY)).toBeNull();

    await act(async () => {
      setInputValue(
        container.querySelector('[data-testid="coach-cadence-select"]') as HTMLSelectElement,
        "every-3-bouts",
      );
    });
    await act(async () => {
      (container.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement).click();
    });

    // Launch Guided Session (no split -> single 4-measure chunk)
    await act(async () => {
      (container.querySelector('[data-testid="guided-strip-start-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="guided-start-session-btn"]') as HTMLButtonElement).click();
    });

    // Helper to finish Stage 0 (if active) + 1 continuous bout
    const playOneBout = async () => {
      const phaseBadge = container.querySelector('[data-testid="guided-phase-badge"]');
      if (phaseBadge?.textContent?.includes("Stage 0")) {
        for (const s of CHUNK_1_STEPS) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
            const ts = performance.now();
            for (const n of s.notes) sendNoteOn(n.midi, n.vel, ts);
            for (const n of s.notes) sendNoteOff(n.midi, ts + 60);
          });
        }
        // Complete remaining measures 3-4 of Stage 0 cleanly
        for (const step of [
          [{ midi: 76, vel: 90 }, { midi: 48, vel: 60 }],
          [{ midi: 74, vel: 90 }],
          [{ midi: 72, vel: 90 }, { midi: 43, vel: 60 }],
        ]) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
            const ts = performance.now();
            for (const n of step) sendNoteOn(n.midi, n.vel, ts);
            for (const n of step) sendNoteOff(n.midi, ts + 60);
          });
        }
      }

      const boutStart = performance.now();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      for (const s of CHUNK_1_STEPS) {
        await act(async () => {
          for (const n of s.notes) sendNoteOn(n.midi, n.vel, boutStart + s.offsetMs);
          for (const n of s.notes) sendNoteOff(n.midi, boutStart + s.offsetMs + 150);
        });
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
        advanceAudio(16);
        await vi.advanceTimersByTimeAsync(20);
      });
    };

    // Bout 1: completes -> 0 auto remote calls
    await playOneBout();
    expect(coachFetch).toHaveBeenCalledTimes(0);
    // Skip Micro-Rest (C8) -> replay same chunk (A0) -> graduate/play Bout 2
    await act(async () => {
      sendNoteOn(108, 88, performance.now());
      sendNoteOff(108, performance.now() + 40);
    });
    await act(async () => {
      sendNoteOn(21, 88, performance.now());
      sendNoteOff(21, performance.now() + 40);
    });
    await playOneBout();
    expect(coachFetch).toHaveBeenCalledTimes(0);

    // Skip Micro-Rest (C8) -> replay same chunk (A0) -> Bout 3 triggers every-3-bouts auto call once!
    await act(async () => {
      sendNoteOn(108, 88, performance.now());
      sendNoteOff(108, performance.now() + 40);
    });
    await act(async () => {
      sendNoteOn(21, 88, performance.now());
      sendNoteOff(21, performance.now() + 40);
    });
    await playOneBout();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(coachFetch).toHaveBeenCalledTimes(1);
  });
});
