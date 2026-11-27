// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import type { ScoreRendererHandle } from "../src/components/ScoreViewer";
import { createSimulatedMidiHarness } from "../src/midi/simulatedMidiHarness";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import { computeNextSpeedStep } from "../src/guided/motorFsrs";
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

function makeRendererFactory() {
  return () =>
    ({
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
    }) satisfies ScoreRendererHandle;
}

// 4-measure grand-staff score (120 BPM => 2s per measure; m1-2 = 4s at 1.0x)
const SCORE_XML = `<?xml version="1.0" encoding="UTF-8"?>
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
    name: "mvp-e2e.musicxml",
    text: async () => SCORE_XML,
    arrayBuffer: async () => new TextEncoder().encode(SCORE_XML).buffer,
  };
  Object.defineProperty(input, "files", { value: [fakeFile], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(100);
  });

  await act(async () => {
    (container.querySelector('[data-testid="guided-strip-start-btn"]') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(30);
  });

  const splitBtn = container.querySelector(
    '[data-testid="chunk-barline-split-2"]',
  ) as HTMLButtonElement | null;
  if (splitBtn) {
    await act(async () => {
      splitBtn.click();
      await vi.advanceTimersByTimeAsync(30);
    });
  }
}

describe("Ticket #33 Guided Session MVP E2E (Simulated MIDI + clockDeps cross-day)", () => {
  it("runs cross-day flow: Stage 0 graduation -> continuous bout attribution -> immutable PracticeEvent persistence -> Micro-Rest -> Hard override -> next-day cold probe & speed upgrade", async () => {
    vi.useFakeTimers();
    let now = Date.UTC(2026, 10, 26, 10, 0, 0);
    const storage = createInMemoryStorage({ now: () => now });
    const harness = createSimulatedMidiHarness();
    const { audioDeps, advanceAudio, resetAudio } = createFakeAudioDeps();

    // DAY 1
    let container = mount(
      createElement(App, {
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: storage,
        audioDeps,
        midiDeps: { requestMIDIAccess: harness.requestMIDIAccess },
        clockDeps: { nowMs: () => now, getTimezoneOffsetMin: () => 0 },
        scoreRendererFactory: makeRendererFactory(),
      }),
    );

    await uploadAndSplitTwoChunks(container);

    // Return briefly to Free Studio to set speed 0.75x (core consolidation zone >= 0.65x)
    await act(async () => {
      (container.querySelector('[data-testid="guided-launch-back-free-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="speed-preset-0.75"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="guided-strip-start-btn"]') as HTMLButtonElement).click();
    });

    // Start Guided Session
    await act(async () => {
      (container.querySelector('[data-testid="guided-start-session-btn"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("Stage 0");

    // Complete Stage 0 chunk 1 cleanly -> graduates to continuous play
    const chunk1Steps = [
      { stepIndex: 0, onsetMs: 0, notes: [{ midi: 60, hand: "RH" as const }, { midi: 48, hand: "LH" as const }] },
      { stepIndex: 1, onsetMs: 1000, notes: [{ midi: 62, hand: "RH" as const }] },
      { stepIndex: 2, onsetMs: 2000, notes: [{ midi: 64, hand: "RH" as const }, { midi: 43, hand: "LH" as const }] },
      { stepIndex: 3, onsetMs: 3000, notes: [{ midi: 65, hand: "RH" as const }] },
    ];
    for (const s of chunk1Steps) {
      await act(async () => {
        for (const n of s.notes) harness.strike(n.midi);
        await vi.advanceTimersByTimeAsync(120);
      });
    }
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("定速连贯");

    // Play continuous bout via Simulated MIDI (at 0.75x => 4s / 0.75 = 5.33s)
    await act(async () => {
      harness.play(chunk1Steps, { speedMultiplier: 0.75, entryLatencyMs: 25, timingJitterMs: 2 });
    });
    for (let t = 0; t < 6; t++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        advanceAudio(1.0);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // Verify Micro-Rest veil & persisted PracticeEvent on Day 1
    expect(container.querySelector('[data-testid="guided-micro-rest-veil"]')).not.toBeNull();
    const profiles = await storage.all("pieceProfiles");
    expect(profiles).toHaveLength(1);
    const pieceId = profiles[0].pieceId;
    const day1Events = await storage.listPracticeEvents(pieceId);
    expect(day1Events).toHaveLength(1);
    expect(day1Events[0].autoGrade).toBeGreaterThanOrEqual(3);
    expect(day1Events[0].fluency.pitchAccuracy).toBe(1);
    expect(day1Events[0].localDateKey).toBe("2026-11-26");

    // Soft-skip Micro-Rest via C8 -> Audiation ready window with "感觉发紧 -> 标 Hard"
    await act(async () => {
      harness.sendCommand("c8");
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("Audiation");
    const markHardBtn = container.querySelector('[data-testid="guided-mark-hard-btn"]') as HTMLButtonElement | null;
    expect(markHardBtn).not.toBeNull();

    // Click "感觉发紧 -> 标 Hard" -> updates persisted PracticeEvent & replays Motor-FSRS
    await act(async () => {
      markHardBtn!.click();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(container.querySelector('[data-testid="guided-marked-hard-badge"]')).not.toBeNull();
    const afterOverrideEvents = await storage.listPracticeEvents(pieceId);
    expect(afterOverrideEvents[0].userGradeOverride).toBe(2);
    const day1Reduced = await loadOrReducePiecePracticeState(storage, pieceId);
    const chunk1Day1 = Object.values(day1Reduced.state.chunkStates)[0];
    expect(chunk1Day1.lastEffectiveGrade).toBe(2);
    expect(chunk1Day1.stabilityDays).toBe(1.0);

    // DAY 2: >= 24h later (local calendar day changed AND >= 8h)
    unmount();
    resetAudio();
    now = Date.UTC(2026, 10, 27, 10, 0, 0);

    container = mount(
      createElement(App, {
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: storage,
        audioDeps,
        midiDeps: { requestMIDIAccess: harness.requestMIDIAccess },
        clockDeps: { nowMs: () => now, getTimezoneOffsetMin: () => 0 },
        scoreRendererFactory: makeRendererFactory(),
      }),
    );

    // Wait for score restore & chunking worker
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    await act(async () => {
      (container.querySelector('[data-testid="guided-strip-start-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(50);
    });

    // Launch card shows 3-segment plan summary with chunk-0 as due cold review and ZERO red overdue badges
    const planSummary = container.querySelector('[data-testid="guided-session-plan-summary"]')?.textContent ?? "";
    expect(planSummary).toContain("开场冷检");
    expect(container.querySelector('[data-testid="guided-overdue-red-badge"]')).toBeNull();

    // Start Day 2 session -> due cold review skips Stage 0 directly into continuous play!
    await act(async () => {
      (container.querySelector('[data-testid="guided-start-session-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(30);
    });
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("定速连贯");

    // Complete clean Cold First-Pass Probe via Simulated MIDI
    await act(async () => {
      harness.play(chunk1Steps, { speedMultiplier: 0.75, entryLatencyMs: 25, timingJitterMs: 2 });
    });
    for (let t = 0; t < 6; t++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        advanceAudio(1.0);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });

    // Day 2 PracticeEvent persisted with wasColdFirstPass=true, Motor-FSRS sleeps consolidated, & speed ladder ready!
    const day2Events = await storage.listPracticeEvents(pieceId);
    expect(day2Events).toHaveLength(2);
    expect(day2Events[1].wasColdFirstPass).toBe(true);
    expect(day2Events[1].autoGrade).toBeGreaterThanOrEqual(3);

    const day2Reduced = await loadOrReducePiecePracticeState(storage, pieceId);
    const chunk1Day2 = Object.values(day2Reduced.state.chunkStates)[0];
    expect(chunk1Day2.sleepConsolidatedNights).toBe(1);
    expect(chunk1Day2.stabilityDays).toBeGreaterThan(1.0);
    expect(computeNextSpeedStep(chunk1Day2.stableSpeed)).toBe(0.82);
  });

  it("offers Early Macro-Rest once at 12-15 min ONLY in 25 / 40 min sessions (never in 15 min) and supports Whole-Piece Quick Triage + 1.05x opt-in toggle", async () => {
    vi.useFakeTimers();
    let now = 100_000;
    const storage = createInMemoryStorage({ now: () => now });
    const harness = createSimulatedMidiHarness();
    const { audioDeps, advanceAudio, resetAudio } = createFakeAudioDeps();

    const container = mount(
      createElement(App, {
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: storage,
        audioDeps,
        midiDeps: { requestMIDIAccess: harness.requestMIDIAccess },
        clockDeps: { nowMs: () => now, getTimezoneOffsetMin: () => 0 },
        scoreRendererFactory: makeRendererFactory(),
      }),
    );

    await uploadAndSplitTwoChunks(container);

    // 1. Verify 1.05x opt-in toggle in Settings defaults OFF and persists when toggled
    await act(async () => {
      (container.querySelector('[data-testid="header-midi-status-btn"]') as HTMLButtonElement).click();
    });
    const overspeedToggle = container.querySelector(
      '[data-testid="overspeed-probe-toggle"]',
    ) as HTMLInputElement;
    expect(overspeedToggle).not.toBeNull();
    expect(overspeedToggle.checked).toBe(false);
    await act(async () => {
      overspeedToggle.click();
    });
    expect(overspeedToggle.checked).toBe(true);
    await act(async () => {
      (container.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(30);
    });
    const savedPrefs = (await storage.all("workspacePrefs")).find(
      (p) => p.overspeedProbeEnabled !== undefined,
    );
    expect(savedPrefs?.overspeedProbeEnabled).toBe(true);

    // 2. In 15 min session: advance 13 min and finish a bout -> NEVER triggers Early Macro-Rest
    await act(async () => {
      (container.querySelector('[data-testid="guided-timebox-15"]') as HTMLButtonElement).click();
      (container.querySelector('[data-testid="guided-start-session-btn"]') as HTMLButtonElement).click();
    });
    for (const step of [[60, 48], [62], [64, 43], [65]]) {
      await act(async () => {
        for (const m of step) harness.strike(m);
        await vi.advanceTimersByTimeAsync(110);
      });
    }
    now += 13 * 60_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
      advanceAudio(5.0);
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(container.querySelector('[data-testid="guided-macro-rest-veil"]')).toBeNull();
    expect(container.querySelector('[data-testid="guided-micro-rest-veil"]')).not.toBeNull();

    // End session and switch to 25 min session -> triggers Early Macro-Rest once at 13 min!
    await act(async () => {
      (container.querySelector('[data-testid="guided-end-session-btn"]') as HTMLButtonElement).click();
      resetAudio();
    });
    await act(async () => {
      (container.querySelector('[data-testid="guided-strip-start-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="guided-timebox-25"]') as HTMLButtonElement).click();
      (container.querySelector('[data-testid="guided-start-session-btn"]') as HTMLButtonElement).click();
    });
    // Wait: chunk 1 may skip Stage 0 if Day 1 event was recorded -> check phase
    if (container.querySelector('[data-testid="guided-phase-badge"]')?.textContent?.includes("Stage 0")) {
      for (const step of [[60, 48], [62], [64, 43], [65]]) {
        await act(async () => {
          for (const m of step) harness.strike(m);
          await vi.advanceTimersByTimeAsync(110);
        });
      }
    }
    now += 13 * 60_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
      advanceAudio(5.0);
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(container.querySelector('[data-testid="guided-macro-rest-veil"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="guided-macro-rest-countdown"]')?.textContent).toContain("2:00");

    // Skippable via C8 into Audiation
    await act(async () => {
      harness.sendCommand("c8");
      await vi.advanceTimersByTimeAsync(110);
    });
    expect(container.querySelector('[data-testid="guided-macro-rest-veil"]')).toBeNull();
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("Audiation");

    // 2b. Verify 40 min session ALSO triggers Early Macro-Rest once at 13 min
    await act(async () => {
      (container.querySelector('[data-testid="guided-end-session-btn"]') as HTMLButtonElement).click();
      resetAudio();
    });
    await act(async () => {
      (container.querySelector('[data-testid="guided-strip-start-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="guided-timebox-40"]') as HTMLButtonElement).click();
      (container.querySelector('[data-testid="guided-start-session-btn"]') as HTMLButtonElement).click();
    });
    if (container.querySelector('[data-testid="guided-phase-badge"]')?.textContent?.includes("Stage 0")) {
      for (const step of [[60, 48], [62], [64, 43], [65]]) {
        await act(async () => {
          for (const m of step) harness.strike(m);
          await vi.advanceTimersByTimeAsync(110);
        });
      }
    }
    now += 13 * 60_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
      advanceAudio(5.0);
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(container.querySelector('[data-testid="guided-macro-rest-veil"]')).not.toBeNull();
    await act(async () => {
      (container.querySelector('[data-testid="guided-skip-macro-rest-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(container.querySelector('[data-testid="guided-macro-rest-veil"]')).toBeNull();

    // 3. Whole-Piece Quick Triage launches all chunks in continuous sweep without Stage 0 lock
    await act(async () => {
      (container.querySelector('[data-testid="guided-end-session-btn"]') as HTMLButtonElement).click();
      resetAudio();
    });
    await act(async () => {
      (container.querySelector('[data-testid="guided-strip-start-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="guided-quick-triage-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(30);
    });
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("定速连贯");
  });
});
