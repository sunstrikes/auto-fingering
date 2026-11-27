// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import type { ScoreRendererHandle } from "../src/components/ScoreViewer";
import { createSimulatedMidiHarness } from "../src/midi/simulatedMidiHarness";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import { loadOrReducePiecePracticeState } from "../src/guided/replayInvalidation";
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

function unmount() {
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
}

afterEach(() => {
  vi.useRealTimers();
  unmount();
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
    getOutputTimestamp: () => ({
      contextTime: audioTime,
      performanceTime: performance.now(),
    }),
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
    load: Promise.resolve(),
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
      cancelAnimationFrame: () => {},
    },
    advanceAudio(deltaSec: number) {
      audioTime += deltaSec;
      const pending = rafQueue.splice(0, rafQueue.length);
      for (const cb of pending) {
        cb(performance.now());
      }
    },
    resetAudio() {
      audioTime = 0;
      rafQueue.length = 0;
    },
  };
}

function makeRendererFactory(measureCount = 4) {
  return () =>
    ({
      async render() {
        return { measureCount, measureGeometry: [] };
      },
      highlightMeasure() {},
      highlightAbLoop() {},
      highlightSpotlightRange() {},
      markAnchoredNotes() {},
      syncCursor() {},
      hitTestNoteAtClientPoint: () => null,
      scrollToMeasure() {},
      dispose() {},
    }) satisfies ScoreRendererHandle;
}

// 4-measure grand-staff score with position leap between m.2 and m.3 (120 BPM => 2s/measure)
const BRIDGE_SCORE_XML = `<?xml version="1.0" encoding="UTF-8"?>
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
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>12</duration><voice>2</voice><type>half</type><dot/><staff>2</staff></note>
      <note><pitch><step>A</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><type>quarter</type><staff>2</staff></note>
    </measure>
    <measure number="3">
      <attributes><barline location="left"><bar-style>light-light</bar-style></barline></attributes>
      <note><pitch><step>C</step><octave>6</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <note><pitch><step>E</step><octave>6</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>2</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
    <measure number="4">
      <note><pitch><step>D</step><octave>6</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <note><pitch><step>C</step><octave>6</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

function pitchToXml(step: string, octave: number, alter = 0): string {
  return `<pitch><step>${step}</step>${alter !== 0 ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch>`;
}

function makeQuarterBarXml(
  measureNum: number,
  rhNotes: ReadonlyArray<[string, number, number?]>,
  lhNotes: ReadonlyArray<[string, number, number?]>,
  isFirst = false,
): string {
  const attrs = isFirst
    ? `<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes><direction placement="above"><sound tempo="120"/></direction>`
    : "";
  const rh = rhNotes
    .map(([s, o, a = 0]) => `<note>${pitchToXml(s, o, a)}<duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>`)
    .join("");
  const lh = lhNotes
    .map(([s, o, a = 0]) => `<note>${pitchToXml(s, o, a)}<duration>4</duration><voice>2</voice><type>quarter</type><staff>2</staff></note>`)
    .join("");
  return `<measure number="${measureNum}">${attrs}${rh}<backup><duration>16</duration></backup>${lh}</measure>`;
}

// 12-measure score:
// m.1-4 == m.7-10 (4-measure exact repeat theme)
// m.5-6 (Branch A: G4-F4-E4-D4 / C4-C4-C4-C4) vs m.11-12 (Branch B: F#5-G#5-A#5-C#6 / F#2-C#3-F#2-C#3)
const SWITCH_SCORE_XML = (() => {
  const themeBar = (num: number, isFirst = false) =>
    makeQuarterBarXml(
      num,
      [["C", 4], ["D", 4], ["E", 4], ["F", 4]],
      [["C", 3], ["G", 3], ["C", 3], ["G", 3]],
      isFirst,
    );
  const measures = [
    themeBar(1, true),
    themeBar(2),
    themeBar(3),
    themeBar(4),
    makeQuarterBarXml(5, [["G", 4], ["F", 4], ["E", 4], ["D", 4]], [["C", 3], ["G", 2], ["C", 3], ["G", 2]]),
    makeQuarterBarXml(6, [["C", 4], ["C", 4], ["C", 4], ["C", 4]], [["C", 3], ["G", 2], ["C", 3], ["G", 2]]),
    themeBar(7),
    themeBar(8),
    themeBar(9),
    themeBar(10),
    makeQuarterBarXml(11, [["F", 5, 1], ["G", 5, 1], ["A", 5, 1], ["C", 6, 1]], [["F", 2, 1], ["C", 3, 1], ["F", 2, 1], ["C", 3, 1]]),
    makeQuarterBarXml(12, [["D", 6, 1], ["C", 6, 1], ["A", 5, 1], ["F", 5, 1]], [["F", 2, 1], ["C", 3, 1], ["F", 2, 1], ["C", 3, 1]]),
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${measures}</part></score-partwise>`;
})();

async function uploadScore(container: HTMLElement, xml: string, fileName: string) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const fakeFile = {
    name: fileName,
    text: async () => xml,
    arrayBuffer: async () => new TextEncoder().encode(xml).buffer,
  };
  Object.defineProperty(input, "files", { value: [fakeFile], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(120);
  });
}

describe("Ticket #34 Bridge Window & Chaffin Cold-Start Probe UI E2E (Simulated MIDI)", () => {
  it("runs static/empirical Bridge Window with UnifiedPiano88 HandPosition preview, 2-pass exit (slip preserves progress) -> linked verify, C8 skip, and preserves Free Studio A-B Loop", async () => {
    vi.useFakeTimers();
    let now = Date.UTC(2026, 10, 26, 10, 0, 0);
    const storage = createInMemoryStorage({ now: () => now });
    const harness = createSimulatedMidiHarness();
    const { audioDeps, advanceAudio } = createFakeAudioDeps();

    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: storage,
        audioDeps,
        midiDeps: { requestMIDIAccess: harness.requestMIDIAccess },
        clockDeps: { nowMs: () => now, getTimezoneOffsetMin: () => 0 },
        scoreRendererFactory: makeRendererFactory(4),
      }),
    );

    await uploadScore(container, BRIDGE_SCORE_XML, "bridge-e2e.musicxml");

    // 1. Configure Free Studio whole-measure A-B Loop (m.1..m.4) via two-step ruler pick before Guided Session
    const abToggle = container.querySelector('[data-testid="ab-loop-toggle-btn"]') as HTMLButtonElement;
    await act(async () => {
      abToggle.click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="measure-ruler-item-0"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="measure-ruler-item-3"]') as HTMLButtonElement).click();
    });
    expect(abToggle.getAttribute("aria-pressed")).toBe("true");
    expect(abToggle.textContent).toContain("1-4");

    // 2. Open Guided Session launch card & split at barline 2 so junction (m.2->m.3) exists
    await act(async () => {
      (container.querySelector('[data-testid="enter-guided-session-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(30);
    });
    const splitBtn = container.querySelector('[data-testid="chunk-barline-split-2"]') as HTMLButtonElement | null;
    if (splitBtn) {
      await act(async () => {
        splitBtn.click();
        await vi.advanceTimersByTimeAsync(50);
      });
    }
    const planSummary = container.querySelector('[data-testid="guided-session-plan-summary"]')?.textContent ?? "";
    expect(planSummary).toContain("接缝桥接");

    // Start Guided Session -> complete Stage 0 chunk 0 cleanly
    await act(async () => {
      (container.querySelector('[data-testid="guided-start-session-btn"]') as HTMLButtonElement).click();
    });
    const chunk0Steps = [
      { stepIndex: 0, onsetMs: 0, notes: [{ midi: 60, hand: "RH" as const }, { midi: 48, hand: "LH" as const }] },
      { stepIndex: 1, onsetMs: 1000, notes: [{ midi: 62, hand: "RH" as const }] },
      { stepIndex: 2, onsetMs: 2000, notes: [{ midi: 64, hand: "RH" as const }, { midi: 55, hand: "LH" as const }] },
      { stepIndex: 3, onsetMs: 3000, notes: [{ midi: 65, hand: "RH" as const }] },
      { stepIndex: 4, onsetMs: 3500, notes: [{ midi: 67, hand: "RH" as const }, { midi: 57, hand: "LH" as const }] },
    ];
    for (const s of chunk0Steps) {
      await act(async () => {
        for (const n of s.notes) harness.strike(n.midi);
        await vi.advanceTimersByTimeAsync(110);
      });
    }
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("定速连贯");

    // Play continuous bout 1 with fault on step 4 -> goes to Micro-Rest
    await act(async () => {
      harness.play(
        [
          chunk0Steps[0],
          chunk0Steps[1],
          chunk0Steps[2],
          chunk0Steps[3],
          { stepIndex: 4, onsetMs: 3500, notes: [{ midi: 68, hand: "RH" as const }] },
        ],
        { speedMultiplier: 1.0, entryLatencyMs: 20 },
      );
    });
    for (let t = 0; t < 6; t++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        advanceAudio(1.0);
      });
    }
    expect(container.querySelector('[data-testid="guided-micro-rest-veil"]')).not.toBeNull();

    // Advance via C8 -> Audiation -> C8 to next item (static prewarm Bridge Window!)
    await act(async () => {
      harness.sendCommand("c8");
      await vi.advanceTimersByTimeAsync(120);
    });
    await act(async () => {
      harness.sendCommand("c8");
      await vi.advanceTimersByTimeAsync(120);
    });

    // Verify Bridge Window active with UnifiedPiano88 before/after HandPosition preview!
    const bridgeStatus = container.querySelector('[data-testid="guided-bridge-status"]')?.textContent ?? "";
    expect(bridgeStatus).toContain("Bridge Window");
    expect(container.querySelector('[data-testid="bridge-hand-position-preview"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="bridge-preview-before-marker"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="bridge-preview-after-marker"]')).not.toBeNull();

    // Bridge steps straddling m.2 -> m.3: step 3 (F4 @ 3.0s), step 4 (G4+A3 @ 3.5s), step 5 (C6+C2 @ 4.0s), step 6 (E6 @ 5.0s)
    const bridgeSteps = [
      { stepIndex: 0, onsetMs: 0, notes: [{ midi: 65, hand: "RH" as const }] },
      { stepIndex: 1, onsetMs: 500, notes: [{ midi: 67, hand: "RH" as const }, { midi: 57, hand: "LH" as const }] },
      { stepIndex: 2, onsetMs: 1000, notes: [{ midi: 84, hand: "RH" as const }, { midi: 36, hand: "LH" as const }] },
      { stepIndex: 3, onsetMs: 2000, notes: [{ midi: 88, hand: "RH" as const }] },
    ];

    // Advance 2-beat Count-In at 0.55x (~1.82 s) + Pass 1 (smooth)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1820);
      advanceAudio(1.82);
      harness.play(bridgeSteps, { speedMultiplier: 0.55, entryLatencyMs: 20 });
    });
    for (let t = 0; t < 6; t++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        advanceAudio(1.0);
      });
    }
    expect(container.querySelector('[data-testid="guided-bridge-status"]')?.textContent).toContain("1/2");

    // Pass 2: single slip -> progress 1/2 MUST remain preserved (not reset!)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1820);
      advanceAudio(1.82);
      harness.play(
        [
          bridgeSteps[0],
          { stepIndex: 1, onsetMs: 500, notes: [{ midi: 66, hand: "RH" as const }] },
          bridgeSteps[2],
          bridgeSteps[3],
        ],
        { speedMultiplier: 0.55, entryLatencyMs: 20 },
      );
    });
    for (let t = 0; t < 6; t++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        advanceAudio(1.0);
      });
    }
    expect(container.querySelector('[data-testid="guided-bridge-status"]')?.textContent).toContain("1/2");

    // Pass 3: smooth -> exits bridging (2/2), restores original speed, enters linked two-chunk verification!
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1820);
      advanceAudio(1.82);
      harness.play(bridgeSteps, { speedMultiplier: 0.55, entryLatencyMs: 20 });
    });
    for (let t = 0; t < 6; t++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        advanceAudio(1.0);
      });
    }
    expect(container.querySelector('[data-testid="guided-bridge-status"]')?.textContent).toContain("双块联排检验");

    // Verify C8 skips linked-verify / Bridge Window cleanly when requested
    await act(async () => {
      harness.sendCommand("c8");
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(container.querySelector('[data-testid="guided-bridge-status"]')).toBeNull();

    // Verify PracticeEvent persisted with boutKind === "bridge" & junctionBoundaryCoord
    const profiles = await storage.all("pieceProfiles");
    const events = await storage.listPracticeEvents(profiles[0].pieceId);
    const bridgeEv = events.find((e) => e.boutKind === "bridge");
    expect(bridgeEv).toBeDefined();
    expect(bridgeEv!.junctionBoundaryCoord).toBeDefined();

    // Return to Free Studio -> whole-measure A-B Loop has ZERO regression!
    await act(async () => {
      (container.querySelector('[data-testid="guided-end-session-btn"]') as HTMLButtonElement).click();
    });
    const abToggleAfter = container.querySelector('[data-testid="ab-loop-toggle-btn"]') as HTMLButtonElement;
    expect(abToggleAfter.getAttribute("aria-pressed")).toBe("true");
    expect(abToggleAfter.textContent).toContain("1-4");
    expect(
      container.querySelector('[data-testid="measure-ruler-item-0"]')?.getAttribute("data-in-ab-loop"),
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="measure-ruler-item-3"]')?.getAttribute("data-in-ab-loop"),
    ).toBe("true");
  });

  it("runs blind Chaffin cold-start drill with B0 1.5s instant peek, detects SwitchPoint divergence -> auto-queues Bridge Window, and keeps same-day S uninflated", async () => {
    vi.useFakeTimers();
    let now = Date.UTC(2026, 10, 26, 14, 0, 0);
    const storage = createInMemoryStorage({ now: () => now });
    const harness = createSimulatedMidiHarness();
    const { audioDeps, advanceAudio } = createFakeAudioDeps();

    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: storage,
        audioDeps,
        midiDeps: { requestMIDIAccess: harness.requestMIDIAccess },
        clockDeps: { nowMs: () => now, getTimezoneOffsetMin: () => 0 },
        scoreRendererFactory: makeRendererFactory(12),
      }),
    );

    await uploadScore(container, SWITCH_SCORE_XML, "switch-probe.musicxml");

    // Open Guided Session Launch Card -> verify always-available Cold-Start Drill + Blind Toggle
    await act(async () => {
      (container.querySelector('[data-testid="enter-guided-session-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(40);
    });
    const coldBtn = container.querySelector('[data-testid="guided-cold-probe-btn"]') as HTMLButtonElement;
    const blindToggle = container.querySelector('[data-testid="guided-cold-probe-blind-toggle"]') as HTMLInputElement;
    expect(coldBtn).not.toBeNull();
    expect(blindToggle).not.toBeNull();
    expect(blindToggle.checked).toBe(false);

    // Enable Blind mode & start Cold-Start Drill
    await act(async () => {
      blindToggle.click();
    });
    expect(blindToggle.checked).toBe(true);
    await act(async () => {
      coldBtn.click();
      await vi.advanceTimersByTimeAsync(30);
    });

    // Blind curtain hides the score!
    expect(container.querySelector('[data-testid="cold-probe-blind-curtain"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cold-probe-peek-active-badge"]')).toBeNull();

    // Press B0 (midi 23) during active play -> instant 1.5s peek reveal!
    await act(async () => {
      harness.strike(23);
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(container.querySelector('[data-testid="cold-probe-blind-curtain"]')).toBeNull();
    expect(container.querySelector('[data-testid="cold-probe-peek-active-badge"]')).not.toBeNull();

    // After 1.5s -> curtain automatically returns!
    await act(async () => {
      now += 1550;
      await vi.advanceTimersByTimeAsync(1550);
    });
    const curtainAfter = container.querySelector('[data-testid="cold-probe-blind-curtain"]');
    expect(curtainAfter).not.toBeNull();
    const probeLabelText = curtainAfter?.textContent ?? "";

    // Also verify F keyboard peek works during blind curtain
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", bubbles: true }));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(container.querySelector('[data-testid="cold-probe-peek-active-badge"]')).not.toBeNull();
    await act(async () => {
      now += 1550;
      await vi.advanceTimersByTimeAsync(1550);
    });
    expect(container.querySelector('[data-testid="cold-probe-blind-curtain"]')).not.toBeNull();

    // Advance 1-measure Count-In (2.67s at 0.75x) then play the alternate SwitchPoint branch!
    await act(async () => {
      now += 2670;
      await vi.advanceTimersByTimeAsync(2670);
      advanceAudio(2.67);
    });
    const isMeasure11 = probeLabelText.includes("第 11 小节");
    const altSwitchSteps = isMeasure11
      ? [
          { stepIndex: 0, onsetMs: 0, notes: [{ midi: 67, hand: "RH" as const }, { midi: 48, hand: "LH" as const }] },
          { stepIndex: 1, onsetMs: 500, notes: [{ midi: 65, hand: "RH" as const }, { midi: 43, hand: "LH" as const }] },
          { stepIndex: 2, onsetMs: 1000, notes: [{ midi: 64, hand: "RH" as const }, { midi: 48, hand: "LH" as const }] },
          { stepIndex: 3, onsetMs: 1500, notes: [{ midi: 62, hand: "RH" as const }, { midi: 43, hand: "LH" as const }] },
        ]
      : [
          { stepIndex: 0, onsetMs: 0, notes: [{ midi: 78, hand: "RH" as const }, { midi: 42, hand: "LH" as const }] },
          { stepIndex: 1, onsetMs: 500, notes: [{ midi: 80, hand: "RH" as const }, { midi: 49, hand: "LH" as const }] },
          { stepIndex: 2, onsetMs: 1000, notes: [{ midi: 82, hand: "RH" as const }, { midi: 42, hand: "LH" as const }] },
          { stepIndex: 3, onsetMs: 1500, notes: [{ midi: 85, hand: "RH" as const }, { midi: 49, hand: "LH" as const }] },
        ];
    await act(async () => {
      harness.play(altSwitchSteps, { speedMultiplier: 0.75, entryLatencyMs: 20 });
    });

    // Finish probe duration (~8s at 0.75x)
    for (let t = 0; t < 12; t++) {
      await act(async () => {
        now += 1000;
        await vi.advanceTimersByTimeAsync(1000);
        advanceAudio(1.0);
      });
    }

    // Probe fails gently (never locks): flags SwitchPoint branch divergence + offers 1 A0 retry OR C8 continue
    const resultBanner = container.querySelector('[data-testid="cold-probe-result-banner"]');
    expect(resultBanner).not.toBeNull();
    expect(container.querySelector('[data-testid="cold-probe-switch-divergence-badge"]')?.textContent).toContain(
      "Switch Point 分支跑偏",
    );
    const retryBtn = container.querySelector('[data-testid="cold-probe-retry-a0-btn"]') as HTMLButtonElement;
    const continueBtn = container.querySelector('[data-testid="cold-probe-continue-c8-btn"]') as HTMLButtonElement;
    expect(retryBtn.disabled).toBe(false);
    expect(continueBtn.disabled).toBe(false);

    // Verify cold-probe PracticeEvent persisted with wasColdFirstPass=false (same-day!) and cueCoord
    const profiles = await storage.all("pieceProfiles");
    const events = await storage.listPracticeEvents(profiles[0].pieceId);
    const probeEv = events.find((e) => e.boutKind === "cold-probe");
    expect(probeEv).toBeDefined();
    expect(probeEv!.cueCoord).toBeDefined();
    expect(probeEv!.wasColdFirstPass).toBe(false);
    expect(probeEv!.fluency.switchBranchMismatch).toBe(true);

    // Same-day probe does NOT inflate S above conservative Day-0 stability
    const reduced = await loadOrReducePiecePracticeState(storage, profiles[0].pieceId);
    for (const u of Object.values(reduced.state.chunkStates)) {
      expect(u.stabilityDays).toBeLessThanOrEqual(1.5);
    }

    // C8 logs-and-continues directly into the auto-queued Bridge Window for the mismatched junction!
    await act(async () => {
      harness.sendCommand("c8");
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(container.querySelector('[data-testid="cold-probe-result-banner"]')).toBeNull();
    expect(container.querySelector('[data-testid="guided-bridge-status"]')?.textContent).toContain("Bridge Window");
    expect(container.querySelector('[data-testid="bridge-hand-position-preview"]')).not.toBeNull();
  });

  it("triggers empirical Bridge Window with -10% to -15% speed step-down after 2 consecutive junction faults on a low-static-risk junction", async () => {
    vi.useFakeTimers();
    let now = Date.UTC(2026, 10, 26, 16, 0, 0);
    const storage = createInMemoryStorage({ now: () => now });
    const harness = createSimulatedMidiHarness();
    const { audioDeps, advanceAudio } = createFakeAudioDeps();

    // Low static-risk 4-measure C-major score (stepwise, priorRisk < 0.65)
    const lowRiskXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    ${makeQuarterBarXml(1, [["C", 4], ["D", 4], ["E", 4], ["F", 4]], [["C", 3], ["D", 3], ["E", 3], ["F", 3]], true)}
    ${makeQuarterBarXml(2, [["G", 4], ["F", 4], ["E", 4], ["D", 4]], [["G", 3], ["F", 3], ["E", 3], ["D", 3]])}
    ${makeQuarterBarXml(3, [["E", 4], ["F", 4], ["G", 4], ["A", 4]], [["E", 3], ["F", 3], ["G", 3], ["A", 3]])}
    ${makeQuarterBarXml(4, [["G", 4], ["F", 4], ["E", 4], ["C", 4]], [["G", 3], ["F", 3], ["E", 3], ["C", 3]])}
  </part>
</score-partwise>`;

    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: storage,
        audioDeps,
        midiDeps: { requestMIDIAccess: harness.requestMIDIAccess },
        clockDeps: { nowMs: () => now, getTimezoneOffsetMin: () => 0 },
        scoreRendererFactory: makeRendererFactory(4),
      }),
    );

    await uploadScore(container, lowRiskXml, "empirical-bridge.musicxml");

    await act(async () => {
      (container.querySelector('[data-testid="enter-guided-session-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(30);
    });
    const splitBtn = container.querySelector('[data-testid="chunk-barline-split-2"]') as HTMLButtonElement | null;
    if (splitBtn) {
      await act(async () => {
        splitBtn.click();
        await vi.advanceTimersByTimeAsync(40);
      });
    }
    // Static risk is low -> NO pre-warm bridge in initial plan
    expect(container.querySelector('[data-testid="guided-session-plan-summary"]')?.textContent ?? "").not.toContain("接缝桥接");

    // Set 0.80x speed in Free Studio before starting so speed step-down (-12% => ~0.70x) is clearly observable
    await act(async () => {
      (container.querySelector('[data-testid="guided-launch-back-free-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="speed-preset-0.75"]') as HTMLButtonElement).click();
      (container.querySelector('[data-testid="enter-guided-session-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="guided-start-session-btn"]') as HTMLButtonElement).click();
    });

    // Graduate Stage 0 for chunk-0 cleanly
    const c0Steps = [
      { stepIndex: 0, onsetMs: 0, notes: [{ midi: 60, hand: "RH" as const }, { midi: 48, hand: "LH" as const }] },
      { stepIndex: 1, onsetMs: 500, notes: [{ midi: 62, hand: "RH" as const }, { midi: 50, hand: "LH" as const }] },
      { stepIndex: 2, onsetMs: 1000, notes: [{ midi: 64, hand: "RH" as const }, { midi: 52, hand: "LH" as const }] },
      { stepIndex: 3, onsetMs: 1500, notes: [{ midi: 65, hand: "RH" as const }, { midi: 53, hand: "LH" as const }] },
      { stepIndex: 4, onsetMs: 2000, notes: [{ midi: 67, hand: "RH" as const }, { midi: 55, hand: "LH" as const }] },
      { stepIndex: 5, onsetMs: 2500, notes: [{ midi: 65, hand: "RH" as const }, { midi: 53, hand: "LH" as const }] },
      { stepIndex: 6, onsetMs: 3000, notes: [{ midi: 64, hand: "RH" as const }, { midi: 52, hand: "LH" as const }] },
      { stepIndex: 7, onsetMs: 3500, notes: [{ midi: 62, hand: "RH" as const }, { midi: 50, hand: "LH" as const }] },
    ];
    for (const s of c0Steps) {
      await act(async () => {
        for (const n of s.notes) harness.strike(n.midi);
        await vi.advanceTimersByTimeAsync(110);
      });
    }

    // Bout 1 on chunk-0: stall / fault at m.2 (4s / 0.75 = 5.33s)
    await act(async () => {
      harness.play(c0Steps.slice(0, 4), { speedMultiplier: 0.75, entryLatencyMs: 20 });
    });
    for (let t = 0; t < 6; t++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        advanceAudio(1.0);
      });
    }
    expect(container.querySelector('[data-testid="guided-micro-rest-veil"]')).not.toBeNull();

    // Replay chunk-0 via C8 -> Audiation -> A0 (or pause/replay) -> Bout 2 fault
    await act(async () => {
      harness.sendCommand("c8");
      await vi.advanceTimersByTimeAsync(120);
    });
    await act(async () => {
      harness.sendCommand("a0");
      await vi.advanceTimersByTimeAsync(120);
    });
    // Graduate Stage 0 again & fault Bout 2 -> 2nd consecutive fault triggers empirical Bridge Window at -12% speed (0.66x)!
    for (const s of c0Steps) {
      await act(async () => {
        for (const n of s.notes) harness.strike(n.midi);
        await vi.advanceTimersByTimeAsync(110);
      });
    }
    await act(async () => {
      harness.play(c0Steps.slice(0, 4), { speedMultiplier: 0.75, entryLatencyMs: 20 });
    });
    for (let t = 0; t < 6; t++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        advanceAudio(1.0);
      });
    }

    // Skip Micro-Rest -> Audiation -> C8 -> enters empirical Bridge Window!
    await act(async () => {
      harness.sendCommand("c8");
      await vi.advanceTimersByTimeAsync(120);
    });
    await act(async () => {
      harness.sendCommand("c8");
      await vi.advanceTimersByTimeAsync(120);
    });

    const empBridgeStatus = container.querySelector('[data-testid="guided-bridge-status"]')?.textContent ?? "";
    expect(empBridgeStatus).toContain("Bridge Window");
    // Speed stepped down -12% from 0.75x -> 0.66x (between -10% and -15%)
    expect(empBridgeStatus).toContain("0.66×");
  });
});
