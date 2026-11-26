// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import {
  createOsmdScoreRenderer,
  type FadingScaffoldingVisual,
  type ScoreRendererHandle,
} from "../src/components/ScoreViewer";
import { getScoreIdentity } from "../src/persistence/fingerprint";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import type { PieceProfile, PracticeEvent } from "../src/persistence/storagePort";
import type { MIDIAccessLike, MIDIInputLike, MIDIMessageEventLike } from "../src/midi/webMidi";
import { parseMusicXml } from "../src/musicxml/parser";
import { localResolveFingering } from "../src/solver/localResolve";
import { solveFingering } from "../src/solver/solveFingering";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";
import { createSolverClient, type WorkerLike } from "../src/workers/solverClient";
import { perfBudget } from "./perfBudget";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const FINGERING_SCORE_XML = `<?xml version="1.0" encoding="UTF-8"?>
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
      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type><sound tempo="120"/></direction>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch>
        <duration>8</duration><voice>1</voice><type>half</type><staff>1</staff>
        <notations><technical><fingering>1</fingering></technical></notations>
      </note>
      <note>
        <chord/>
        <pitch><step>E</step><octave>5</octave></pitch>
        <duration>8</duration><voice>1</voice><type>half</type><staff>1</staff>
        <notations><technical><fingering>3</fingering></technical></notations>
      </note>
      <note>
        <pitch><step>G</step><octave>5</octave></pitch>
        <duration>8</duration><voice>1</voice><type>half</type><staff>1</staff>
        <notations><technical><fingering>5</fingering></technical></notations>
      </note>
      <backup><duration>16</duration></backup>
      <note>
        <pitch><step>C</step><octave>3</octave></pitch>
        <duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff>
        <notations><technical><fingering>5</fingering></technical></notations>
      </note>
    </measure>
    <measure number="2">
      <note>
        <pitch><step>F</step><octave>5</octave></pitch>
        <duration>8</duration><voice>1</voice><type>half</type><staff>1</staff>
        <notations><technical><fingering>4</fingering></technical></notations>
      </note>
      <note>
        <pitch><step>E</step><octave>5</octave></pitch>
        <duration>8</duration><voice>1</voice><type>half</type><staff>1</staff>
        <notations><technical><fingering>3</fingering></technical></notations>
      </note>
      <backup><duration>16</duration></backup>
      <note>
        <pitch><step>G</step><octave>2</octave></pitch>
        <duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff>
        <notations><technical><fingering>5</fingering></technical></notations>
      </note>
    </measure>
  </part>
</score-partwise>`;

describe("OSMD native SVG zero-reflow Fading Scaffolding", () => {
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    container?.remove();
    container = null;
  });

  it("toggles native OSMD .osmd-fingering SVG opacity for L0–L3 and 1.5s peek in <1ms without reflow or re-render, with measure-level fallback", async () => {
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => ({
      font: "",
      measureText: (t: string) => ({ width: (t?.length || 1) * 8 }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    try {
      container = document.createElement("div");
      Object.defineProperty(container, "offsetWidth", { value: 1000, configurable: true });
      Object.defineProperty(container, "clientWidth", { value: 1000, configurable: true });
      document.body.appendChild(container);

      const scoreDoc = parseMusicXml(FINGERING_SCORE_XML);
      const renderer = createOsmdScoreRenderer(container);
      await renderer.render(FINGERING_SCORE_XML, { layoutMode: "page", zoom: 0.85 });
      renderer.setNoteEvents?.(scoreDoc.noteEvents);

      const fingeringEls = Array.from(
        container.querySelectorAll<SVGElement>(".osmd-fingering"),
      );
      expect(fingeringEls.length).toBeGreaterThanOrEqual(6);

      // Spy on SVG count & DOM identity to prove zero re-layout/re-render
      const svgBefore = container.querySelector("svg");
      const preservedNote = scoreDoc.noteEvents.find(
        (n) => n.measureIndex === 0 && n.midi === 76,
      )!;
      expect(preservedNote).toBeDefined();

      // L1: all fingerings visible
      renderer.setFadingScaffoldingVisual?.({
        level: 1,
        peekActive: false,
        preservedNoteUids: [preservedNote.noteUid],
        preservedMeasureIndices: [0],
      });
      expect(fingeringEls.every((el) => el.style.opacity === "1")).toBe(true);

      // L2: only preserved NoteEvent (E5 fingering "3") stays opacity 1; routine fingerings fade to 0
      const tL2Start = performance.now();
      renderer.setFadingScaffoldingVisual?.({
        level: 2,
        peekActive: false,
        preservedNoteUids: [preservedNote.noteUid],
        preservedMeasureIndices: [0],
      });
      const l2Elapsed = performance.now() - tL2Start;
      expect(l2Elapsed).toBeLessThanOrEqual(perfBudget(2));

      const visibleAtL2 = fingeringEls.filter((el) => el.style.opacity === "1");
      const hiddenAtL2 = fingeringEls.filter((el) => el.style.opacity === "0");
      expect(visibleAtL2.length).toBe(1);
      expect(visibleAtL2[0].textContent?.trim()).toBe("3");
      expect(hiddenAtL2.length).toBe(fingeringEls.length - 1);

      // L3: all fingerings hidden (opacity 0)
      renderer.setFadingScaffoldingVisual?.({
        level: 3,
        peekActive: false,
        preservedNoteUids: [preservedNote.noteUid],
        preservedMeasureIndices: [0],
      });
      expect(fingeringEls.every((el) => el.style.opacity === "0")).toBe(true);

      // Instant peek reveal restores opacity to 1 in < 1 ms without reflow or re-render
      const tPeekStart = performance.now();
      renderer.setFadingScaffoldingVisual?.({
        level: 3,
        peekActive: true,
        preservedNoteUids: [preservedNote.noteUid],
        preservedMeasureIndices: [0],
      });
      const peekElapsed = performance.now() - tPeekStart;
      expect(peekElapsed).toBeLessThanOrEqual(perfBudget(1));
      expect(fingeringEls.every((el) => el.style.opacity === "1")).toBe(true);
      expect(container.querySelector("svg")).toBe(svgBefore);

      // Measure-level safe fallback: an unmapped .osmd-fingering node inside a preserved measure stays visible at L2,
      // while an unmapped node in an unpreserved measure hides.
      const m0Container = document.createElementNS("http://www.w3.org/2000/svg", "g");
      m0Container.setAttribute("data-measure-index", "0");
      const unmappedM0 = document.createElementNS("http://www.w3.org/2000/svg", "g");
      unmappedM0.setAttribute("class", "osmd-fingering");
      m0Container.appendChild(unmappedM0);

      const m1Container = document.createElementNS("http://www.w3.org/2000/svg", "g");
      m1Container.setAttribute("data-measure-index", "1");
      const unmappedM1 = document.createElementNS("http://www.w3.org/2000/svg", "g");
      unmappedM1.setAttribute("class", "osmd-fingering");
      m1Container.appendChild(unmappedM1);

      svgBefore?.appendChild(m0Container);
      svgBefore?.appendChild(m1Container);
      renderer.setNoteEvents?.([...scoreDoc.noteEvents]);
      renderer.setFadingScaffoldingVisual?.({
        level: 2,
        peekActive: false,
        preservedNoteUids: [preservedNote.noteUid],
        preservedMeasureIndices: [0],
      });
      expect(unmappedM0.style.opacity).toBe("1");
      expect(unmappedM1.style.opacity).toBe("0");

      renderer.dispose();
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetContext;
    }
  });
});

let mountedRoot: Root | null = null;
let mountedContainer: HTMLElement | null = null;

function mountApp(element: ReturnType<typeof createElement>): HTMLElement {
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
  const oscillatorStarts: number[] = [];
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
      start: vi.fn((when?: number) => {
        oscillatorStarts.push(when ?? audioTime);
      }),
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
    oscillatorStarts,
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
    inputs: { values: () => [input].values() },
    onstatechange: null,
  };
  return {
    midiDeps: { requestMIDIAccess: async () => access },
    sendNoteOn(midi: number, velocity: number, timeStampMs: number) {
      listener?.({ data: new Uint8Array([0x90, midi, velocity]), timeStamp: timeStampMs });
    },
    sendNoteOff(midi: number, timeStampMs: number) {
      listener?.({ data: new Uint8Array([0x80, midi, 0]), timeStamp: timeStampMs });
    },
  };
}

function createTrackingScoreRendererFactory() {
  let renderCount = 0;
  const visualHistory: Array<FadingScaffoldingVisual | null> = [];
  const factory = (): ScoreRendererHandle => ({
    async render(xmlString) {
      renderCount += 1;
      const doc = parseMusicXml(xmlString);
      return {
        measureCount: doc.measureCount,
        measureGeometry: Array.from({ length: doc.measureCount }, (_, m) => ({
          measureIndex: m,
          top: m * 60,
          height: 50,
          left: m * 120,
          width: 110,
        })),
      };
    },
    setFadingScaffoldingVisual(visual) {
      visualHistory.push(visual);
    },
    highlightMeasure() {},
    scrollToMeasure() {},
    markAnchoredNotes() {},
    dispose() {},
  });
  return {
    factory,
    getRenderCount: () => renderCount,
    visualHistory,
    latestVisual: () => visualHistory[visualHistory.length - 1] ?? null,
  };
}

const TWO_MEASURE_SIMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
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
      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

const B0_IN_SCORE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type><sound tempo="120"/></direction>
      <note><pitch><step>B</step><octave>0</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;

async function uploadXml(container: HTMLElement, xml: string, fileName = "scaffolding.musicxml") {
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

function makeSeedEvent(overrides: Partial<PracticeEvent> & {
  eventId: string;
  pieceId: string;
  scoreFingerprint: string;
  timestampMs: number;
  localDateKey: string;
}): PracticeEvent {
  return {
    timezoneOffsetMin: 0,
    sessionId: "seed-session",
    boutKind: "chunk",
    startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
    endCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
    practiceMode: "both",
    speedMultiplier: 0.78,
    durationSec: 4,
    passCount: 1,
    wasColdFirstPass: true,
    scaffoldingLevel: 1,
    autoGrade: 3,
    fluency: {
      pitchAccuracy: 1,
      interiorHesitationCount: 0,
      junctionHesitationRatio: 1,
      timingCv: 0.02,
      stallDetected: false,
      dominantHandFaultRatio: { rh: 0, lh: 0 },
      switchBranchMismatch: false,
      reanchorCount: 0,
    },
    measureFaultCounts: {},
    ...overrides,
  };
}

describe("<App /> Fading Scaffolding root DI integration", () => {
  it("hides 88-key targets/hand skeleton & suppresses live red flashes at L2, switches 3 preferences without re-rendering, and steps down on Again", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 20, 12, 0, 0) });

    const scoreDoc = parseMusicXml(TWO_MEASURE_SIMPLE_XML);
    const identity = getScoreIdentity(scoreDoc);
    const storage = createInMemoryStorage();
    const pieceId = "piece-l2-test";
    const profile: PieceProfile = {
      pieceId,
      title: "L2 Scaffolding Test",
      fingerprints: [identity.fingerprint],
      measureHashesByFingerprint: { [identity.fingerprint]: identity.measureHashes },
      lastPracticedAtMs: Date.UTC(2026, 10, 19, 10, 0, 0),
    };
    await storage.commit({
      pieceProfiles: [profile],
      practiceEvents: [
        makeSeedEvent({
          eventId: "ev-d1",
          pieceId,
          scoreFingerprint: identity.fingerprint,
          timestampMs: Date.UTC(2026, 10, 18, 10, 0, 0),
          localDateKey: "2026-11-18",
          speedMultiplier: 0.78,
          wasColdFirstPass: false,
        }),
        makeSeedEvent({
          eventId: "ev-d2",
          pieceId,
          scoreFingerprint: identity.fingerprint,
          timestampMs: Date.UTC(2026, 10, 19, 10, 0, 0),
          localDateKey: "2026-11-19",
          speedMultiplier: 0.78,
          wasColdFirstPass: true,
        }),
      ],
    });

    const { audioDeps, advanceAudio } = createFakeAudioDeps();
    const { midiDeps, sendNoteOn, sendNoteOff } = createSimulatedMidiDeps();
    const tracker = createTrackingScoreRendererFactory();

    const container = mountApp(
      createElement(App, {
        midiDeps,
        audioDeps,
        scoreRendererFactory: tracker.factory,
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: storage,
        clockDeps: { nowMs: () => Date.now(), getTimezoneOffsetMin: () => 0 },
      }),
    );

    await uploadXml(container, TWO_MEASURE_SIMPLE_XML);
    const renderCountAfterUpload = tracker.getRenderCount();

    // Launch Guided Session
    await act(async () => {
      (container.querySelector('[data-testid="enter-guided-session-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(40);
    });
    await act(async () => {
      (container.querySelector('[data-testid="guided-start-session-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(40);
    });

    // Should start directly in continuous play at L2 (zero XML/OSMD re-render)
    expect(tracker.getRenderCount()).toBe(renderCountAfterUpload);
    expect(container.querySelector('[data-testid="guided-scaffolding-badge"]')?.textContent).toContain("L2");
    expect(tracker.latestVisual()?.level).toBe(2);

    // UnifiedPiano88 hides hand posture skeleton & overhead lanes & targets in L2
    const piano = container.querySelector('[data-testid="unified-piano-88"]')!;
    expect(piano.getAttribute("data-scaffolding-hidden")).toBe("true");
    expect(container.querySelector('[data-layer="hand-posture-simulation"]')).toBeNull();
    expect(container.querySelector('[data-testid="overhead-lane-RH"]')).toBeNull();

    // Send a wrong note (F#4 = 66) during L2 continuous play -> zero live red flash, calm key-press echo only
    await act(async () => {
      sendNoteOn(66, 85, performance.now());
    });
    const wrongKeyEl = container.querySelector('[data-testid="piano-key-66"]')!;
    expect(wrongKeyEl.getAttribute("data-wrong-note")).toBeNull();
    expect(wrongKeyEl.getAttribute("data-key-pressed")).toBe("true");
    await act(async () => {
      sendNoteOff(66, performance.now() + 50);
    });

    // Switch preference in PracticeSettingsModal to "always-full" -> restores L1 without OSMD re-render
    await act(async () => {
      (container.querySelector('[data-testid="header-midi-status-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="scaffolding-pref-always-full"]') as HTMLButtonElement).click();
    });
    expect(tracker.getRenderCount()).toBe(renderCountAfterUpload);
    expect(container.querySelector('[data-testid="guided-scaffolding-badge"]')?.textContent).toContain("L1");
    expect(piano.getAttribute("data-scaffolding-hidden")).toBe("false");
    expect(container.querySelector('[data-layer="hand-posture-simulation"]')).not.toBeNull();

    // Switch preference to "hide-keyboard-early" -> keeps L2 obscured
    await act(async () => {
      (container.querySelector('[data-testid="scaffolding-pref-hide-keyboard-early"]') as HTMLButtonElement).click();
    });
    expect(piano.getAttribute("data-scaffolding-hidden")).toBe("true");
    expect(tracker.latestVisual()?.level).toBe(2);

    // Switch back to "auto-fade" and close settings
    await act(async () => {
      (container.querySelector('[data-testid="scaffolding-pref-auto-fade"]') as HTMLButtonElement).click();
      (container.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="guided-scaffolding-badge"]')?.textContent).toContain("L2");

    // Finish bout with missed notes -> Again (grade 1) -> PracticeEvent stamps scaffoldingLevel: 2 and steps down to L1
    await act(async () => {
      advanceAudio(7.0);
      await vi.advanceTimersByTimeAsync(200);
    });

    const events = await storage.listPracticeEvents(pieceId);
    const latest = events[events.length - 1];
    expect(latest.scaffoldingLevel).toBe(2);
    expect(latest.autoGrade).toBe(1);

    // After Again, Motor-FSRS steps down L2 -> L1 automatically (and hide-keyboard-early hides keyboard at L1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(container.querySelector('[data-testid="guided-scaffolding-badge"]')?.textContent).toContain("L1");
    expect(container.querySelector('[data-testid="guided-scaffolding-badge"]')?.textContent).toContain("已自动退降1级");
    const snap = await storage.get("derivedSnapshots", pieceId);
    expect(snap).toBeDefined();
  });

  it("runs L3 count-in-only silent beat with relaxed drift and supports active-play B0 1.5s peek exempted from attribution", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 22, 12, 0, 0) });

    const scoreDoc = parseMusicXml(TWO_MEASURE_SIMPLE_XML);
    const identity = getScoreIdentity(scoreDoc);
    const storage = createInMemoryStorage();
    const pieceId = "piece-l3-test";
    const profile: PieceProfile = {
      pieceId,
      title: "L3 Scaffolding Test",
      fingerprints: [identity.fingerprint],
      measureHashesByFingerprint: { [identity.fingerprint]: identity.measureHashes },
      lastPracticedAtMs: Date.UTC(2026, 10, 21, 10, 0, 0),
    };
    await storage.commit({
      pieceProfiles: [profile],
      practiceEvents: [
        makeSeedEvent({
          eventId: "ev-d1",
          pieceId,
          scoreFingerprint: identity.fingerprint,
          timestampMs: Date.UTC(2026, 10, 19, 10, 0, 0),
          localDateKey: "2026-11-19",
          speedMultiplier: 0.92,
          wasColdFirstPass: false,
        }),
        makeSeedEvent({
          eventId: "ev-d2",
          pieceId,
          scoreFingerprint: identity.fingerprint,
          timestampMs: Date.UTC(2026, 10, 20, 10, 0, 0),
          localDateKey: "2026-11-20",
          speedMultiplier: 0.92,
          wasColdFirstPass: true,
        }),
        makeSeedEvent({
          eventId: "ev-d3",
          pieceId,
          scoreFingerprint: identity.fingerprint,
          timestampMs: Date.UTC(2026, 10, 21, 10, 0, 0),
          localDateKey: "2026-11-21",
          speedMultiplier: 0.92,
          wasColdFirstPass: true,
        }),
      ],
    });

    const { audioDeps, oscillatorStarts, advanceAudio } = createFakeAudioDeps();
    const { midiDeps, sendNoteOn, sendNoteOff } = createSimulatedMidiDeps();
    const tracker = createTrackingScoreRendererFactory();

    const container = mountApp(
      createElement(App, {
        midiDeps,
        audioDeps,
        scoreRendererFactory: tracker.factory,
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: storage,
        clockDeps: { nowMs: () => Date.now(), getTimezoneOffsetMin: () => 0 },
      }),
    );

    await uploadXml(container, TWO_MEASURE_SIMPLE_XML);
    await act(async () => {
      (container.querySelector('[data-testid="enter-guided-session-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(40);
    });
    await act(async () => {
      (container.querySelector('[data-testid="guided-start-session-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(40);
    });

    // Should enter L3 with count-in-only silent beat enabled
    expect(container.querySelector('[data-testid="guided-scaffolding-badge"]')?.textContent).toContain("L3");
    expect(container.querySelector('[data-testid="guided-l3-silent-beat-toggle"]')).not.toBeNull();
    expect(tracker.latestVisual()?.level).toBe(3);

    // Count-In (1 measure = 4 beats at 0.92x = ~2.17s) plays metronome clicks, then silent play!
    const countInClicks = oscillatorStarts.length;
    expect(countInClicks).toBe(4);

    // Advance past Count-In into active play
    await act(async () => {
      advanceAudio(2.2);
      await vi.advanceTimersByTimeAsync(50);
    });
    const anchorTimeMs = performance.now();
    const clicksAfterCountIn = oscillatorStarts.length;
    expect(clicksAfterCountIn).toBe(countInClicks);

    // Press B0 (midi 23) during active L3 play -> triggers 1.5s peek WITHOUT pausing
    await act(async () => {
      sendNoteOn(23, 88, anchorTimeMs + 100);
      sendNoteOff(23, anchorTimeMs + 160);
    });
    expect(container.querySelector('[data-testid="guided-phase-badge"]')?.textContent).toContain("演奏");
    expect(tracker.latestVisual()?.peekActive).toBe(true);
    expect(container.querySelector('[data-testid="unified-piano-88"]')?.getAttribute("data-scaffolding-hidden")).toBe("false");

    // Advance 1.5s -> peek automatically expires back to obscured state
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1550);
    });
    expect(tracker.latestVisual()?.peekActive).toBe(false);
    expect(container.querySelector('[data-testid="unified-piano-88"]')?.getAttribute("data-scaffolding-hidden")).toBe("true");

    // Play the chunk's notes at ~0.92x (quarter beat ~543ms; measure 1 = 0..2174ms, measure 2 = 2174..4348ms)
    // Include slight local drift (+200ms) on m2 notes to verify L3 relaxed drift passes 100%
    const stepOnsets = [
      { ms: 0, midis: [72, 48] },
      { ms: 1087, midis: [74] },
      { ms: 2374, midis: [76, 43] },
      { ms: 3461, midis: [77] },
    ];
    for (const s of stepOnsets) {
      await act(async () => {
        for (const m of s.midis) sendNoteOn(m, 86, anchorTimeMs + s.ms);
        for (const m of s.midis) sendNoteOff(m, anchorTimeMs + s.ms + 120);
      });
    }

    // Complete segment -> still zero extra metronome clicks during silent-beat L3 play
    await act(async () => {
      advanceAudio(5.0);
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(oscillatorStarts.length).toBe(countInClicks);

    const events = await storage.listPracticeEvents(pieceId);
    const latest = events[events.length - 1];
    expect(latest.scaffoldingLevel).toBe(3);
    expect(latest.fluency.pitchAccuracy).toBe(1);
    const totalExtras = Object.values(latest.measureFaultCounts).reduce((sum, m) => sum + m.extra, 0);
    expect(totalExtras).toBe(0);
  });

  it("auto-disables active-play B0 shortcut with notice when chunk legitimately uses B0, falling back to F / touch", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 22, 12, 0, 0) });

    const scoreDoc = parseMusicXml(B0_IN_SCORE_XML);
    const identity = getScoreIdentity(scoreDoc);
    const storage = createInMemoryStorage();
    const pieceId = "piece-b0-guard";
    await storage.commit({
      pieceProfiles: [
        {
          pieceId,
          title: "B0 Collision Guard",
          fingerprints: [identity.fingerprint],
          measureHashesByFingerprint: { [identity.fingerprint]: identity.measureHashes },
        },
      ],
      practiceEvents: [
        makeSeedEvent({
          eventId: "ev-b0-1",
          pieceId,
          scoreFingerprint: identity.fingerprint,
          timestampMs: Date.UTC(2026, 10, 20, 10, 0, 0),
          localDateKey: "2026-11-20",
          speedMultiplier: 0.8,
          wasColdFirstPass: false,
        }),
        makeSeedEvent({
          eventId: "ev-b0-2",
          pieceId,
          scoreFingerprint: identity.fingerprint,
          timestampMs: Date.UTC(2026, 10, 21, 10, 0, 0),
          localDateKey: "2026-11-21",
          speedMultiplier: 0.8,
          wasColdFirstPass: true,
        }),
      ],
    });

    const { audioDeps } = createFakeAudioDeps();
    const { midiDeps, sendNoteOn, sendNoteOff } = createSimulatedMidiDeps();
    const tracker = createTrackingScoreRendererFactory();

    const container = mountApp(
      createElement(App, {
        midiDeps,
        audioDeps,
        scoreRendererFactory: tracker.factory,
        solverClientFactory: inProcessSolverFactory(),
        practiceStorage: storage,
        clockDeps: { nowMs: () => Date.now(), getTimezoneOffsetMin: () => 0 },
      }),
    );

    await uploadXml(container, B0_IN_SCORE_XML, "b0-piece.musicxml");
    await act(async () => {
      (container.querySelector('[data-testid="enter-guided-session-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(40);
    });
    await act(async () => {
      (container.querySelector('[data-testid="guided-start-session-btn"]') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(40);
    });

    // B0 collision guard active
    expect(container.querySelector('[data-testid="guided-b0-conflict-notice"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="piano-command-badge-23"]')?.getAttribute("data-command-disabled"),
    ).toBe("true");

    // Pressing B0 on MIDI must NOT trigger peekActive
    await act(async () => {
      sendNoteOn(23, 88, performance.now());
      sendNoteOff(23, performance.now() + 50);
    });
    expect(tracker.latestVisual()?.peekActive).toBe(false);

    // Pressing keyboard 'f' DOES trigger 1.5s peek
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", bubbles: true }));
    });
    expect(tracker.latestVisual()?.peekActive).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1550);
    });
    expect(tracker.latestVisual()?.peekActive).toBe(false);

    // Touch fallback button also triggers 1.5s peek
    await act(async () => {
      (container.querySelector('[data-testid="guided-peek-fingerings-btn"]') as HTMLButtonElement).click();
    });
    expect(tracker.latestVisual()?.peekActive).toBe(true);
  });
});

