// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../src/App";
import type { ScoreRendererHandle } from "../src/components/ScoreViewer";
import { solveFingering } from "../src/solver/solveFingering";
import { createSolverClient, type WorkerLike } from "../src/workers/solverClient";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";
import type { OnsetSlice, ScoreDocument, SolveResult } from "../src/domain/types";
import { UnifiedPiano88 } from "../src/components/UnifiedPiano88";

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

describe("UnifiedPiano88 PracticeMode dimming & wrongMidis highlight", () => {
  it("dims accompaniment-hand visuals in single-hand mode and highlights wrongMidis in red", () => {
    const slices: OnsetSlice[] = [
      {
        sliceId: "s0",
        hand: "RH",
        measureIndex: 0,
        onsetTick: 0,
        onsetSec: 0,
        isGrace: false,
        phraseId: 0,
        notes: [
          {
            noteUid: "n-rh",
            measureIndex: 0,
            onsetTick: 0,
            durationTick: 4,
            onsetSec: 0,
            durationSec: 0.5,
            midi: 64,
            hand: "RH",
            voice: "1",
            staff: 1,
            isGrace: false,
            isTieStop: false,
            isTieStart: false,
          },
        ],
        heldNotes: [],
      },
      {
        sliceId: "s1",
        hand: "LH",
        measureIndex: 0,
        onsetTick: 0,
        onsetSec: 0,
        isGrace: false,
        phraseId: 0,
        notes: [
          {
            noteUid: "n-lh",
            measureIndex: 0,
            onsetTick: 0,
            durationTick: 4,
            onsetSec: 0,
            durationSec: 0.5,
            midi: 48,
            hand: "LH",
            voice: "2",
            staff: 2,
            isGrace: false,
            isTieStop: false,
            isTieStart: false,
          },
        ],
        heldNotes: [],
      },
    ];

    const scoreDoc = {
      title: "Test",
      xmlDoc: {} as Document,
      xmlDeclaration: "",
      noteElementsByUid: new Map(),
      noteEvents: [...slices[0].notes, ...slices[1].notes],
      onsetSlices: slices,
      isSingleStaff: false,
      defaultSingleStaffHand: "RH",
      measureCount: 1,
      ticksPerQuarter: 4,
      tempoPoints: [{ tick: 0, bpm: 120 }],
      timeSignaturePoints: [{ tick: 0, beats: 4, beatType: 4 }],
      measureTimelines: [],
    } satisfies ScoreDocument;

    const solveResult: SolveResult = {
      fingerByNoteUid: { "n-rh": 3, "n-lh": 5 },
      handPositions: [],
      transitionCues: [],
      warnings: [],
      repairedAnchorUids: [],
      solveTimeMs: 1,
    };

    const container = mount(
      createElement(UnifiedPiano88, {
        scoreDoc,
        solveResult,
        selectedSliceId: "s0",
        practiceMode: "rh-only",
        wrongMidis: new Set([61]),
      })
    );

    const rhOverlay = container.querySelector('[data-testid="hand-overlay-RH"]');
    const lhOverlay = container.querySelector('[data-testid="hand-overlay-LH"]');
    expect(rhOverlay?.getAttribute("data-dimmed")).toBe("false");
    expect(lhOverlay?.getAttribute("data-dimmed")).toBe("true");

    const rhLane = container.querySelector('[data-testid="overhead-lane-RH"]');
    const lhLane = container.querySelector('[data-testid="overhead-lane-LH"]');
    expect(rhLane?.getAttribute("data-dimmed")).toBe("false");
    expect(lhLane?.getAttribute("data-dimmed")).toBe("true");

    const wrongKey = container.querySelector('[data-testid="piano-key-61"]');
    expect(wrongKey?.getAttribute("data-wrong-note")).toBe("true");
    const wrongRect = wrongKey?.querySelector("rect");
    expect(wrongRect?.getAttribute("fill")).toBe("#dc2626");
  });
});

function createInProcessSolverClientFactory() {
  return () => {
    const fakeWorker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg: WorkerRequest) {
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

const TWO_HAND_SCORE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction placement="above"><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
      <backup><duration>8</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>quarter</type><staff>2</staff></note>
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration><type>quarter</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

const SINGLE_STAFF_LH_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

async function uploadXml(container: HTMLElement, xml: string, name = "test.musicxml") {
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
  const triggeredMidis: number[] = [];
  const ctx = {
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
      disconnect: vi.fn(),
    })),
    createOscillator: vi.fn(() => ({
      type: "sine",
      frequency: { value: 440, setValueAtTime: vi.fn() },
      start: vi.fn(),
      stop: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
  } as unknown as AudioContext;

  return {
    triggeredMidis,
    audioDeps: {
      getAudioContext: () => ctx,
      loadSmplrPiano: async () => ({
        load: Promise.resolve(),
        start: ({ note }: { note: number }) => {
          triggeredMidis.push(note);
        },
        stop: vi.fn(),
      }),
    },
  };
}

describe("<App /> PracticeMode & WaitingMode end-to-end", () => {
  it("supports PracticeMode selection, single-staff locking, skipGraceNotes setting, and WaitingMode rehearsal flow", async () => {
    const syncCursor = vi.fn();
    let triggerNoteClick: ((noteUid: string) => void) | null = null;
    const rendererFactory = () =>
      ({
        render: vi.fn(async () => ({ measureCount: 1, measureGeometry: [] })),
        highlightMeasure: vi.fn(),
        markAnchoredNotes: vi.fn(),
        scrollToMeasure: vi.fn(),
        syncCursor,
        hitTestNoteAtClientPoint: vi.fn(() => null),
        dispose: vi.fn(),
      }) satisfies ScoreRendererHandle;

    const { triggeredMidis, audioDeps } = createFakeAudioDeps();

    const container = mount(
      createElement(App, {
        solverClientFactory: createInProcessSolverClientFactory(),
        scoreRendererFactory: rendererFactory,
        audioDeps,
      })
    );

    await uploadXml(container, TWO_HAND_SCORE_XML);

    // 1. PracticeMode selector in header: switch to rh-only
    const rhBtn = container.querySelector('[data-testid="practice-mode-rh-only"]') as HTMLButtonElement;
    expect(rhBtn).not.toBeNull();
    act(() => {
      rhBtn.click();
    });
    expect(rhBtn.getAttribute("aria-pressed")).toBe("true");
    expect(
      container.querySelector('[data-testid="hand-overlay-LH"]')?.getAttribute("data-dimmed")
    ).toBe("true");

    // 2. Open Practice Settings -> verify skipGraceNotes & midiLocalSound toggles
    act(() => {
      (container.querySelector('[data-testid="practice-settings-btn"]') as HTMLButtonElement).click();
    });
    const skipGraceToggle = container.querySelector('[data-testid="skip-grace-notes-toggle"]') as HTMLInputElement;
    expect(skipGraceToggle).not.toBeNull();
    expect(skipGraceToggle.checked).toBe(false);
    act(() => {
      skipGraceToggle.click();
    });
    expect(skipGraceToggle.checked).toBe(true);
    act(() => {
      (container.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement).click();
    });

    // 3. Enable Waiting Mode -> MIDI Local Sound defaults to off; metronome pauses when waiting
    const waitingBtn = container.querySelector('[data-testid="waiting-mode-toggle-btn"]') as HTMLButtonElement;
    expect(waitingBtn).not.toBeNull();
    act(() => {
      waitingBtn.click();
    });
    expect(waitingBtn.getAttribute("aria-pressed")).toBe("true");

    // Start Waiting Mode playback
    act(() => {
      (container.querySelector('[data-testid="audio-play-btn"]') as HTMLButtonElement).click();
    });

    // A graze on the neighboring key flashes red without cancelling the first hit.
    const key60 = container.querySelector('[data-testid="piano-key-60"]') as SVGGElement;
    const key61 = container.querySelector('[data-testid="piano-key-61"]') as SVGGElement;
    const key64 = container.querySelector('[data-testid="piano-key-64"]') as SVGGElement;
    await act(async () => {
      key60.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      key61.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(key61.getAttribute("data-wrong-note")).toBe("true");
    expect(key60.getAttribute("data-hit-note")).toBe("true");
    expect(container.querySelector('[data-testid="waiting-strict-fault-badge"]')).toBeNull();
    expect(triggeredMidis).toHaveLength(0);

    // Release C, then finish the rolled chord while the grazed key is still held.
    await act(async () => {
      key60.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      key64.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    // Accompaniment C3 (48) should have played automatically!
    expect(triggeredMidis).toContain(48);

    await act(async () => {
      key61.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      key64.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await Promise.resolve();
    });

    // Pause, then play step 1's E4 (64) -> immediately starts waiting rehearsal & completes step 1
    act(() => {
      (container.querySelector('[data-testid="audio-pause-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      key64.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await Promise.resolve();
    });
    // Accompaniment G3 (55) should have played!
    expect(triggeredMidis).toContain(55);

    // Completing a pass lights the status badge without opening the report.
    const reportBtn = container.querySelector(
      '[data-testid="practice-report-toggle-btn"]'
    ) as HTMLButtonElement;
    expect(reportBtn).not.toBeNull();
    expect(reportBtn.textContent).toContain("已练 1 遍");
    expect(container.querySelector('[data-testid="practice-report-dropdown"]')).toBeNull();
    act(() => reportBtn.click());
    expect(container.querySelector('[data-testid="practice-recommendation-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="measure-ruler-error-dot-0"]')).not.toBeNull();

    // Clicking "循环第 1 小节" in the recommendation panel activates A-B Loop on measure 1
    act(() => {
      (container.querySelector('[data-testid="practice-rec-loop-btn-0"]') as HTMLButtonElement).click();
    });
    expect(
      container.querySelector('[data-testid="ab-loop-toggle-btn"]')?.getAttribute("aria-pressed")
    ).toBe("true");

    // 4. Single-staff score locks PracticeMode to defaultSingleStaffHand (LH -> lh-only)
    await uploadXml(container, SINGLE_STAFF_LH_XML, "single-lh.musicxml");
    const lhBtn = container.querySelector('[data-testid="practice-mode-lh-only"]') as HTMLButtonElement;
    const bothBtn = container.querySelector('[data-testid="practice-mode-both"]') as HTMLButtonElement;
    expect(lhBtn.getAttribute("aria-pressed")).toBe("true");
    expect(bothBtn.disabled).toBe(true);
    expect(rhBtn.disabled).toBe(true);

    // 5. Loading a two-staff score afterward unlocks PracticeMode
    await uploadXml(container, TWO_HAND_SCORE_XML, "two-hand-again.musicxml");
    expect(bothBtn.disabled).toBe(false);
    expect(rhBtn.disabled).toBe(false);
    expect(lhBtn.disabled).toBe(false);
    act(() => {
      bothBtn.click();
    });
    expect(bothBtn.getAttribute("aria-pressed")).toBe("true");

    void triggerNoteClick;
  });

  it("resets MIDI Local Sound to false when toggling Waiting Mode on and allows explicit opt-in while in Waiting Mode", async () => {
    const { triggeredMidis, audioDeps } = createFakeAudioDeps();
    const rendererFactory = () =>
      ({
        render: vi.fn(async () => ({ measureCount: 1, measureGeometry: [] })),
        highlightMeasure: vi.fn(),
        markAnchoredNotes: vi.fn(),
        scrollToMeasure: vi.fn(),
        syncCursor: vi.fn(),
        hitTestNoteAtClientPoint: vi.fn(() => null),
        dispose: vi.fn(),
      }) satisfies ScoreRendererHandle;

    const container = mount(
      createElement(App, {
        solverClientFactory: createInProcessSolverClientFactory(),
        scoreRendererFactory: rendererFactory,
        audioDeps,
      })
    );

    await uploadXml(container, TWO_HAND_SCORE_XML);

    // Explicitly turn MIDI Local Sound ON before enabling Waiting Mode
    act(() => {
      (container.querySelector('[data-testid="practice-settings-btn"]') as HTMLButtonElement).click();
    });
    const localSoundToggleBefore = container.querySelector(
      '[data-testid="midi-local-sound-toggle"]'
    ) as HTMLInputElement;
    expect(localSoundToggleBefore.checked).toBe(false);
    act(() => {
      localSoundToggleBefore.click();
    });
    expect(localSoundToggleBefore.checked).toBe(true);
    act(() => {
      (container.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement).click();
    });

    // Enable Waiting Mode -> MIDI Local Sound must reset to false
    act(() => {
      (container.querySelector('[data-testid="waiting-mode-toggle-btn"]') as HTMLButtonElement).click();
    });

    // PracticeSettingsModal must display false
    act(() => {
      (container.querySelector('[data-testid="practice-settings-btn"]') as HTMLButtonElement).click();
    });
    const localSoundToggleInWaiting = container.querySelector(
      '[data-testid="midi-local-sound-toggle"]'
    ) as HTMLInputElement;
    expect(localSoundToggleInWaiting.checked).toBe(false);

    // Explicitly opt back in while in Waiting Mode
    act(() => {
      localSoundToggleInWaiting.click();
    });
    expect(localSoundToggleInWaiting.checked).toBe(true);
    act(() => {
      (container.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement).click();
    });

    // Playing a key now triggers local sound
    const key60 = container.querySelector('[data-testid="piano-key-60"]') as SVGGElement;
    await act(async () => {
      key60.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(triggeredMidis).toContain(60);
  });

  it("jumps cursor without opening NoteAnchorPopover when clicking score while Waiting Mode is active", async () => {
    const { audioDeps } = createFakeAudioDeps();
    const rendererFactory = () =>
      ({
        render: vi.fn(async () => ({ measureCount: 1, measureGeometry: [] })),
        highlightMeasure: vi.fn(),
        markAnchoredNotes: vi.fn(),
        scrollToMeasure: vi.fn(),
        syncCursor: vi.fn(),
        hitTestNoteAtClientPoint: vi.fn(() => null),
        dispose: vi.fn(),
      }) satisfies ScoreRendererHandle;

    const container = mount(
      createElement(App, {
        solverClientFactory: createInProcessSolverClientFactory(),
        scoreRendererFactory: rendererFactory,
        audioDeps,
      })
    );

    await uploadXml(container, TWO_HAND_SCORE_XML);

    // Enable Waiting Mode
    act(() => {
      (container.querySelector('[data-testid="waiting-mode-toggle-btn"]') as HTMLButtonElement).click();
    });

    // Click a measure on the ruler -> no popover opens
    act(() => {
      (container.querySelector('[data-testid="measure-ruler-item-0"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="note-anchor-popover"]')).toBeNull();
  });

  it("automatically reduces speed by 12% on return to both hands and leaves the explanation on demand", async () => {
    const container = mount(createElement(App, {
      solverClientFactory: createInProcessSolverClientFactory(),
      scoreRendererFactory: () => ({
        render: vi.fn(async () => ({ measureCount: 1, measureGeometry: [] })),
        highlightMeasure: vi.fn(), markAnchoredNotes: vi.fn(), scrollToMeasure: vi.fn(),
        syncCursor: vi.fn(), hitTestNoteAtClientPoint: vi.fn(() => null), dispose: vi.fn(),
      }),
      audioDeps: createFakeAudioDeps().audioDeps,
    }));
    await uploadXml(container, TWO_HAND_SCORE_XML);
    const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const click = (id: string) => act(() => find(id)!.click());
    click("practice-mode-rh-only");
    click("speed-preset-0.75");
    click("practice-mode-both");
    expect(find("bpm-readout-btn")?.textContent).toContain("0.66x");
    click("practice-mode-both");
    expect(find("bpm-readout-btn")?.textContent).toContain("0.66x");
    expect(find("practice-report-dropdown")).toBeNull();
    expect(find("practice-report-toggle-btn")?.textContent).toContain("合手调速");
    click("practice-report-toggle-btn");
    expect(find("practice-report-dropdown")?.textContent).toContain("−12%");
  });

  it("shows a brief red flash even if the wrong key is released in the same input burst", async () => {
    const container = mount(createElement(App, {
      solverClientFactory: createInProcessSolverClientFactory(),
      scoreRendererFactory: () => ({
        render: vi.fn(async () => ({ measureCount: 1, measureGeometry: [] })),
        highlightMeasure: vi.fn(), markAnchoredNotes: vi.fn(), scrollToMeasure: vi.fn(),
        syncCursor: vi.fn(), hitTestNoteAtClientPoint: vi.fn(() => null), dispose: vi.fn(),
      }),
      audioDeps: createFakeAudioDeps().audioDeps,
    }));
    await uploadXml(container, TWO_HAND_SCORE_XML);
    const click = (id: string) => act(() => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.click());
    click("waiting-mode-toggle-btn");
    click("audio-play-btn");
    const key = container.querySelector('[data-testid="piano-key-61"]')!;
    vi.useFakeTimers();
    try {
      await act(async () => {
        key.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        key.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
      expect(key.getAttribute("data-wrong-note")).toBe("true");
      act(() => vi.advanceTimersByTime(250));
      expect(key.getAttribute("data-wrong-note")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("only resets chord hits after a wrong note when Absolute Strictness is enabled in Settings", async () => {
    const { triggeredMidis, audioDeps } = createFakeAudioDeps();
    const container = mount(createElement(App, {
      solverClientFactory: createInProcessSolverClientFactory(),
      scoreRendererFactory: () => ({
        render: vi.fn(async () => ({ measureCount: 1, measureGeometry: [] })),
        highlightMeasure: vi.fn(), markAnchoredNotes: vi.fn(), scrollToMeasure: vi.fn(),
        syncCursor: vi.fn(), hitTestNoteAtClientPoint: vi.fn(() => null), dispose: vi.fn(),
      }),
      audioDeps,
    }));
    await uploadXml(container, TWO_HAND_SCORE_XML);
    const click = (id: string) => act(() => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.click());
    const key = (midi: number) => container.querySelector<SVGGElement>(`[data-testid="piano-key-${midi}"]`)!;
    const play = async (type: "mousedown" | "mouseup", ...midis: number[]) => {
      await act(async () => {
        for (const midi of midis) key(midi).dispatchEvent(new MouseEvent(type, { bubbles: true }));
      });
    };
    click("practice-mode-rh-only");
    click("practice-settings-btn");
    const absoluteStrictness = container.querySelector<HTMLInputElement>('[data-testid="absolute-strictness-toggle"]');
    expect(absoluteStrictness?.checked).toBe(false);
    expect(container.querySelector<HTMLInputElement>('[data-testid="strict-hold-duration-toggle"]')?.checked).toBe(false);
    click("absolute-strictness-toggle");
    expect(absoluteStrictness?.checked).toBe(true);
    click("practice-settings-close-btn");
    click("waiting-mode-toggle-btn");
    click("audio-play-btn");

    await play("mousedown", 60, 61);
    expect(key(60).getAttribute("data-hit-note")).toBeNull();
    expect(container.querySelector('[data-testid="waiting-strict-fault-badge"]')).not.toBeNull();
    await play("mouseup", 61);
    await play("mousedown", 64);
    expect(triggeredMidis).not.toContain(48);
    await play("mouseup", 60, 64);
    await play("mousedown", 60, 64);
    expect(triggeredMidis).toContain(48);
  });

  it("enforces strict hold duration in UI when enabled: displays hold progress badge, flags early release, and advances once held to required duration", async () => {
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
        disconnect: vi.fn(),
      })),
      createOscillator: vi.fn(() => ({
        type: "sine",
        frequency: { value: 440, setValueAtTime: vi.fn() },
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      })),
    };

    const tickRaf = () => {
      const entries = [...rafCallbacks.entries()];
      rafCallbacks.clear();
      for (const [, cb] of entries) cb(16);
    };

    const triggeredMidis: number[] = [];
    const rendererFactory = () =>
      ({
        render: vi.fn(async () => ({ measureCount: 1, measureGeometry: [] })),
        highlightMeasure: vi.fn(),
        markAnchoredNotes: vi.fn(),
        scrollToMeasure: vi.fn(),
        syncCursor: vi.fn(),
        hitTestNoteAtClientPoint: vi.fn(() => null),
        dispose: vi.fn(),
      }) satisfies ScoreRendererHandle;

    const container = mount(
      createElement(App, {
        solverClientFactory: createInProcessSolverClientFactory(),
        scoreRendererFactory: rendererFactory,
        audioDeps: {
          getAudioContext: () => rawCtx as unknown as AudioContext,
          loadSmplrPiano: async () => ({
            load: Promise.resolve(),
            start: ({ note }: { note: number }) => {
              triggeredMidis.push(note);
            },
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
      })
    );

    await uploadXml(container, TWO_HAND_SCORE_XML);

    // Switch to RH-only and enable Strict Hold Duration in Practice Settings
    act(() => {
      (container.querySelector('[data-testid="practice-mode-rh-only"]') as HTMLButtonElement).click();
      (container.querySelector('[data-testid="practice-settings-btn"]') as HTMLButtonElement).click();
    });
    const strictHoldToggle = container.querySelector(
      '[data-testid="strict-hold-duration-toggle"]'
    ) as HTMLInputElement;
    expect(strictHoldToggle).not.toBeNull();
    expect(strictHoldToggle.checked).toBe(false);
    act(() => {
      strictHoldToggle.click();
    });
    expect(strictHoldToggle.checked).toBe(true);
    act(() => {
      (container.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement).click();
    });

    // Enable Waiting Mode and start playback
    act(() => {
      (container.querySelector('[data-testid="waiting-mode-toggle-btn"]') as HTMLButtonElement).click();
    });
    act(() => {
      (container.querySelector('[data-testid="audio-play-btn"]') as HTMLButtonElement).click();
    });

    const key60 = container.querySelector('[data-testid="piano-key-60"]') as SVGGElement;
    const key64 = container.querySelector('[data-testid="piano-key-64"]') as SVGGElement;

    // Step 0 is a quarter note at 120 BPM (0.5s) -> requiredHoldSec = 0.5 * 0.8 = 0.4s
    // Press C4 (60) + E4 (64) at t=0 -> enters isHolding, does NOT play accompaniment 48 yet!
    await act(async () => {
      key60.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      key64.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="waiting-hold-progress-badge"]')).not.toBeNull();
    expect(triggeredMidis).toHaveLength(0);

    // Advance time to t=0.2s (50%) and release key64 early -> triggers early-release fault!
    act(() => {
      rawCtx.currentTime = 0.2;
      tickRaf();
    });
    expect(
      container
        .querySelector('[data-testid="waiting-hold-progress-badge"]')
        ?.getAttribute("data-hold-progress")
    ).toBe("50");

    await act(async () => {
      key64.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await Promise.resolve();
    });
    const faultBadge = container.querySelector('[data-testid="waiting-strict-fault-badge"]');
    expect(faultBadge?.getAttribute("data-fault-reason")).toBe("early-release");
    expect(triggeredMidis).toHaveLength(0);

    // Release remaining key60 so step untaints
    await act(async () => {
      key60.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await Promise.resolve();
    });

    // Re-press C4 (60) + E4 (64) at t=1.0s and hold until t=1.42s -> completes step 0 and plays LH accompaniment 48!
    rawCtx.currentTime = 1.0;
    await act(async () => {
      key60.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      key64.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="waiting-hold-progress-badge"]')).not.toBeNull();

    await act(async () => {
      rawCtx.currentTime = 1.42;
      tickRaf();
      await Promise.resolve();
    });
    expect(triggeredMidis).toContain(48);
  });

  it("marks a measure green after two smooth low-fault passes and offers optional progression on demand", async () => {
    const TWO_MEASURE_SINGLE_STAFF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

    const { audioDeps } = createFakeAudioDeps();
    const rendererFactory = () =>
      ({
        render: vi.fn(async () => ({ measureCount: 2, measureGeometry: [] })),
        highlightMeasure: vi.fn(),
        markAnchoredNotes: vi.fn(),
        scrollToMeasure: vi.fn(),
        syncCursor: vi.fn(),
        hitTestNoteAtClientPoint: vi.fn(() => null),
        dispose: vi.fn(),
      }) satisfies ScoreRendererHandle;

    const container = mount(
      createElement(App, {
        solverClientFactory: createInProcessSolverClientFactory(),
        scoreRendererFactory: rendererFactory,
        audioDeps,
      })
    );

    await uploadXml(container, TWO_MEASURE_SINGLE_STAFF_XML);

    // Enable Waiting Mode and set A-B Loop on Measure 1 (index 0)
    act(() => {
      (container.querySelector('[data-testid="waiting-mode-toggle-btn"]') as HTMLButtonElement).click();
      (container.querySelector('[data-testid="ab-loop-toggle-btn"]') as HTMLButtonElement).click();
    });
    act(() => {
      (container.querySelector('[data-testid="measure-ruler-item-0"]') as HTMLButtonElement).click();
    });
    act(() => {
      (container.querySelector('[data-testid="measure-ruler-item-0"]') as HTMLButtonElement).click();
    });
    act(() => {
      (container.querySelector('[data-testid="audio-play-btn"]') as HTMLButtonElement).click();
    });

    const key60 = container.querySelector('[data-testid="piano-key-60"]') as SVGGElement;
    const key61 = container.querySelector('[data-testid="piano-key-61"]') as SVGGElement;

    // Pass 1: Make a wrong-note fault (61), release, then hit 60 -> completes Pass 1 with an error on Measure 1
    await act(async () => {
      key61.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      key61.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      key60.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      key60.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="measure-ruler-error-dot-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="measure-ruler-mastered-dot-0"]')).toBeNull();

    // A second smooth pass with a single accidental slip still earns fluency.
    await act(async () => {
      key61.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      key61.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      key60.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      key60.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    // Measure 1 ruler indicator transitions from rose error dot to emerald mastered dot!
    expect(container.querySelector('[data-testid="measure-ruler-error-dot-0"]')).toBeNull();
    expect(container.querySelector('[data-testid="measure-ruler-mastered-dot-0"]')).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="measure-ruler-item-0"]')
        ?.getAttribute("data-practice-mastered")
    ).toBe("true");

    // Advice never opens automatically; the badge reveals it when requested.
    expect(container.querySelector('[data-testid="practice-report-dropdown"]')).toBeNull();
    act(() => (container.querySelector('[data-testid="practice-report-toggle-btn"]') as HTMLButtonElement).click());
    const progCard = container.querySelector('[data-testid="practice-progression-card"]');
    expect(progCard).not.toBeNull();
    expect(progCard?.textContent).toContain("已流畅");
    expect(progCard?.getAttribute("data-progression-stage")).toBe("ready-next-measure");

    // Clicking "进入第 2 小节 →" advances the A-B loop to Measure 2 (index 1)
    const nextMeasureBtn = container.querySelector(
      '[data-testid="progression-next-measure-btn"]'
    ) as HTMLButtonElement;
    expect(nextMeasureBtn).not.toBeNull();
    act(() => {
      nextMeasureBtn.click();
    });

    expect(
      container.querySelector('[data-testid="ab-loop-toggle-btn"]')?.textContent
    ).toContain("循环中 2-2");
    expect(
      container
        .querySelector('[data-testid="measure-ruler-item-1"]')
        ?.getAttribute("data-in-ab-loop")
    ).toBe("true");
  });
});
