// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { analyzeScoreStatic } from "../src/chunking/staticAnalyzer";
import {
  createOsmdScoreRenderer,
  type ScoreRendererHandle,
} from "../src/components/ScoreViewer";
import { createEhsController, type EhsConfig, type EhsFrameSnapshot } from "../src/guided/ehsController";
import { PIANO_COMMAND_MIDI } from "../src/guided/pianoCommandKeys";
import type { MIDIAccessLike, MIDIInputLike, MIDIMessageEventLike } from "../src/midi/webMidi";
import { parseMusicXml } from "../src/musicxml/parser";
import { getScoreIdentity } from "../src/persistence/fingerprint";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import type { PieceProfile, PracticeEvent } from "../src/persistence/storagePort";
import { buildPracticeSteps } from "../src/practice/waitingMode";
import { localResolveFingering } from "../src/solver/localResolve";
import { solveFingering } from "../src/solver/solveFingering";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";
import { createSolverClient, type WorkerLike } from "../src/workers/solverClient";
import { perfBudget } from "./perfBudget";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const BEAMED_MULTI_SYSTEM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>2</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type><sound tempo="120"/></direction>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch>
        <duration>2</duration><voice>1</voice><type>eighth</type><staff>1</staff>
        <beam number="1">begin</beam>
        <notations><technical><fingering>1</fingering></technical></notations>
      </note>
      <note>
        <pitch><step>D</step><octave>5</octave></pitch>
        <duration>2</duration><voice>1</voice><type>eighth</type><staff>1</staff>
        <beam number="1">end</beam>
        <notations><technical><fingering>2</fingering></technical></notations>
      </note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
    ${Array.from({ length: 11 }, (_, idx) => {
      const m = idx + 2;
      const newSystem = m === 5 || m === 9 ? `<print new-system="yes"/>` : "";
      return `<measure number="${m}">
      ${newSystem}
      <note><pitch><step>A</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>`;
    }).join("\n")}
  </part>
</score-partwise>`;

describe("OSMD Hybrid B+C Eye-Hand Span Overlay renderer", () => {
  let container: HTMLDivElement | null = null;
  let scrollContainer: HTMLDivElement | null = null;

  afterEach(() => {
    scrollContainer?.remove();
    scrollContainer = null;
    container?.remove();
    container = null;
  });

  function setupOsmdContainer() {
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => ({
      font: "",
      measureText: (t: string) => ({ width: (t?.length || 1) * 8 }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    scrollContainer = document.createElement("div");
    Object.defineProperty(scrollContainer, "clientWidth", { value: 900, configurable: true });
    Object.defineProperty(scrollContainer, "clientHeight", { value: 260, configurable: true });
    const scrollToSpy = vi.fn((opts?: ScrollToOptions | number, y?: number) => {
      if (typeof opts === "object" && opts && typeof opts.top === "number") {
        scrollContainer!.scrollTop = opts.top;
      } else if (typeof y === "number") {
        scrollContainer!.scrollTop = y;
      }
    });
    scrollContainer.scrollTo = scrollToSpy as unknown as typeof scrollContainer.scrollTo;

    container = document.createElement("div");
    Object.defineProperty(container, "offsetWidth", { value: 900, configurable: true });
    Object.defineProperty(container, "clientWidth", { value: 900, configurable: true });
    scrollContainer.appendChild(container);
    document.body.appendChild(scrollContainer);

    return {
      container,
      scrollContainer,
      scrollToSpy,
      restoreCanvas: () => {
        HTMLCanvasElement.prototype.getContext = origGetContext;
      },
    };
  }

  it("dissolves passed notes to 0%/6%, pools shared beam max-opacity, keeps staves/clefs 100% sharp, protects clef zone, pre-scrolls in page mode, and runs < 1ms/frame in both page & horizontal layouts", async () => {
    const env = setupOsmdContainer();
    try {
      const scoreDoc = parseMusicXml(BEAMED_MULTI_SYSTEM_XML);
      const steps = buildPracticeSteps(scoreDoc, "both");
      const renderer = createOsmdScoreRenderer(env.container);
      await renderer.render(BEAMED_MULTI_SYSTEM_XML, { layoutMode: "page", zoom: 0.85 });
      renderer.setNoteEvents?.(scoreDoc.noteEvents);
      renderer.setScoreDoc?.(scoreDoc);

      // Verify FadingScaffolding L3 hides fingerings and EHS never unhides them
      renderer.setFadingScaffoldingVisual?.({
        level: 3,
        peekActive: false,
        preservedNoteUids: [],
        preservedMeasureIndices: [],
      });
      const fingeringEls = Array.from(env.container.querySelectorAll<SVGElement>(".osmd-fingering"));
      expect(fingeringEls.length).toBeGreaterThanOrEqual(2);
      expect(fingeringEls.every((el) => el.style.opacity === "0")).toBe(true);

      const ctrl = createEhsController();
      ctrl.resetForBout({ startScoreSec: 0 });
      const config6: EhsConfig = {
        enabled: true,
        preset: "1-beat",
        ghostOpacity: 0.06,
        autoStallFlashEnabled: true,
      };

      // Choose a time when frontierBeat is strictly between C5 (beat 0) and D5 (beat 0.5):
      // Wait: with 1-beat lookahead, frontierBeat = handBeat + 1.
      // Instead, strike C5 (beat 0) via MIDI while handBeat = 0.05 (scoreSec = 0.025)
      // so C5 is MIDI-struck (ghost 0.06) while D5 (beat 0.5, frontierBeat 1.05 -> ahead < 0) —
      // OR better: use scoreSec = 0.025 -> frontierBeat = 1.05, wait D5 is at beat 0.5 (< 1.05).
      // Let's test beam pooling cleanly:
      // At handBeat = 0, if we test direct snapshot with frontierBeat = 0.25:
      // C5 (scoreBeat = 0) <= frontierBeat (0.25) -> opacity = 0.06
      // D5 (scoreBeat = 0.5) > frontierBeat (0.25) -> opacity > 0.06 (specifically ~0.52!)
      const inspectionBeam = renderer.applyEhsFrame?.(
        {
          active: true,
          isMasked: true,
          isCountIn: false,
          handBeat: 0,
          handMeasureIndex: 0,
          handBeatInMeasure: 0,
          lookaheadBeats: 0.25,
          frontierBeat: 0.25,
          frontierMeasureIndex: 0,
          spotlightEndBeat: 1.75,
          preset: "1-beat",
          ghostOpacity: 0.06,
          manualPeekActive: false,
          autoStallMeasureIndex: null,
          autoStallRemainingMs: 0,
          consecutiveMissedSteps: 0,
          stallFlashCount: 0,
          struckNoteUids: new Set(),
        },
        { layoutMode: "page", scrollContainer: env.scrollContainer },
      );

      expect(inspectionBeam).toBeDefined();
      expect(inspectionBeam!.sharedBeamGroupCount).toBeGreaterThanOrEqual(1);
      const beamedNotes = inspectionBeam!.notes.filter((n) => n.measureIndex === 0 && n.beamGroupId !== null);
      expect(beamedNotes.length).toBe(2);
      const [c5, d5] = beamedNotes;
      expect(c5.opacity).toBeCloseTo(0.06, 2);
      expect(d5.opacity).toBeGreaterThan(0.3);
      // Shared beam MUST take max(c5.opacity, d5.opacity) so it never fractures!
      expect(c5.beamOpacity).toBe(d5.beamOpacity);
      expect(c5.beamOpacity).toBeCloseTo(d5.opacity, 2);
      const beamEl = env.container.querySelector(".vf-beam") as SVGElement | null;
      expect(beamEl).not.toBeNull();
      expect(Number(beamEl!.style.opacity)).toBeCloseTo(d5.opacity, 2);

      // L3 fingerings MUST remain hidden ("0")!
      expect(fingeringEls.every((el) => el.style.opacity === "0")).toBe(true);

      // Staves, barlines, clefs, key/time signatures MUST remain 100% sharp (untouched opacity)
      const structuralEls = Array.from(
        env.container.querySelectorAll<SVGElement>(
          ".vf-stave, .vf-stavebarline, .vf-clef, .vf-keysignature, .vf-timesignature",
        ),
      );
      expect(structuralEls.length).toBeGreaterThan(0);
      expect(structuralEls.every((el) => el.style.opacity === "")).toBe(true);

      // Clef zone protection + Hybrid C spotlight geometry
      const m0 = inspectionBeam!.measures[0];
      expect(m0.contentLeft).toBeGreaterThan(m0.left);
      expect(inspectionBeam!.clefZonesProtected).toBe(true);
      expect(inspectionBeam!.spotlightRect).not.toBeNull();
      expect(inspectionBeam!.spotlightRect!.x).toBeGreaterThanOrEqual(m0.contentLeft);
      expect(env.container.querySelector('[data-testid="ehs-spotlight-rect"]')).not.toBeNull();

      // 0% ghost ink mode works cleanly
      const snapZero = ctrl.tick({
        nowMs: 2000,
        scoreDoc,
        scoreSec: 1.0, // handBeat = 2.0, frontierBeat = 3.0
        isPlaying: true,
        speedMultiplier: 1,
        practiceSteps: steps,
        config: { ...config6, ghostOpacity: 0 },
        scaffoldingLevel: 3,
        manualPeekActive: false,
      });
      const inspZero = renderer.applyEhsFrame?.(snapZero, {
        layoutMode: "page",
        scrollContainer: env.scrollContainer,
      });
      expect(inspZero!.notes.find((n) => n.measureIndex === 0 && n.scoreBeat === 0)?.opacity).toBe(0);

      // Page-mode next-system smooth auto pre-scroll near end of system 0 (measures 0..3 -> system 1 starts at measure 4)
      expect(inspZero!.systemCount).toBeGreaterThanOrEqual(2);
      const endOfSys0Beat = inspZero!.measures.find((m) => m.systemIndex === 1)!.left >= 0
        ? scoreDoc.measureTimelines[3].endSec - 0.1
        : 7.5;
      const snapNearSysEnd = ctrl.tick({
        nowMs: 4000,
        scoreDoc,
        scoreSec: endOfSys0Beat,
        isPlaying: true,
        speedMultiplier: 1,
        practiceSteps: steps,
        config: config6,
        scaffoldingLevel: 2,
        manualPeekActive: false,
      });
      const inspPreScroll = renderer.applyEhsFrame?.(snapNearSysEnd, {
        layoutMode: "page",
        scrollContainer: env.scrollContainer,
      });
      expect(inspPreScroll!.preScrollTargetTop).not.toBeNull();
      expect(env.scrollToSpy).toHaveBeenCalled();

      // Measure median frame update budget (< 1 ms/frame) in page layout across 15 warm frames
      const pageFrameTimes: number[] = [];
      for (let i = 0; i < 15; i++) {
        const s = ctrl.tick({
          nowMs: 5000 + i * 16,
          scoreDoc,
          scoreSec: 0.2 + i * 0.05,
          isPlaying: true,
          speedMultiplier: 1,
          practiceSteps: steps,
          config: config6,
          scaffoldingLevel: 2,
          manualPeekActive: false,
        });
        const res = renderer.applyEhsFrame?.(s, {
          layoutMode: "page",
          scrollContainer: env.scrollContainer,
        });
        pageFrameTimes.push(res!.lastFrameMs);
      }
      pageFrameTimes.sort((a, b) => a - b);
      const medianPageFrameMs = pageFrameTimes[Math.floor(pageFrameTimes.length / 2)];
      expect(medianPageFrameMs).toBeLessThan(perfBudget(1));

      // Horizontal layout: single system, < 1 ms/frame
      await renderer.render(BEAMED_MULTI_SYSTEM_XML, { layoutMode: "horizontal", zoom: 0.85 });
      renderer.setNoteEvents?.(scoreDoc.noteEvents);
      renderer.setScoreDoc?.(scoreDoc);
      // Warm 1st frame (extraction happens once)
      const hWarm = ctrl.tick({
        nowMs: 6000,
        scoreDoc,
        scoreSec: 0.5,
        isPlaying: true,
        speedMultiplier: 1,
        practiceSteps: steps,
        config: config6,
        scaffoldingLevel: 1,
        manualPeekActive: false,
      });
      const hInsp0 = renderer.applyEhsFrame?.(hWarm, {
        layoutMode: "horizontal",
        scrollContainer: env.scrollContainer,
      });
      expect(hInsp0!.systemCount).toBe(1);

      const horizFrameTimes: number[] = [];
      for (let i = 0; i < 15; i++) {
        const s = ctrl.tick({
          nowMs: 6100 + i * 16,
          scoreDoc,
          scoreSec: 0.6 + i * 0.05,
          isPlaying: true,
          speedMultiplier: 1,
          practiceSteps: steps,
          config: config6,
          scaffoldingLevel: 1,
          manualPeekActive: false,
        });
        const res = renderer.applyEhsFrame?.(s, {
          layoutMode: "horizontal",
          scrollContainer: env.scrollContainer,
        });
        horizFrameTimes.push(res!.lastFrameMs);
      }
      horizFrameTimes.sort((a, b) => a - b);
      const medianHorizFrameMs = horizFrameTimes[Math.floor(horizFrameTimes.length / 2)];
      expect(medianHorizFrameMs).toBeLessThan(perfBudget(1));
    } finally {
      env.restoreCanvas();
    }
  });
});

function createSyncSolverClientFactory() {
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
        queueMicrotask(() => {
          const result =
            msg.type === "local-resolve"
              ? localResolveFingering(msg)
              : solveFingering(msg.onsetSlices, msg.profile, {
                  ignoreExistingFingerings: msg.ignoreExistingFingerings,
                });
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
  let perfNow = 10_000;
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
    nowMs: () => perfNow,
    advanceAudio(sec: number) {
      audioTime += sec;
      perfNow += sec * 1000;
      const batch = rafQueue.splice(0, rafQueue.length);
      for (const cb of batch) cb(perfNow);
    },
    flushRaf() {
      const batch = rafQueue.splice(0, rafQueue.length);
      for (const cb of batch) cb(perfNow);
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

function createEhsTrackingRendererFactory() {
  const ehsFrames: Array<EhsFrameSnapshot | null> = [];
  const factory = (): ScoreRendererHandle => ({
    async render(xmlString) {
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
    applyEhsFrame(snapshot) {
      ehsFrames.push(snapshot ? { ...snapshot, struckNoteUids: new Set(snapshot.struckNoteUids) } : null);
      return {
        active: Boolean(snapshot?.active),
        isMasked: Boolean(snapshot?.isMasked),
        extractMs: 0.1,
        lastFrameMs: 0.1,
        frameCount: ehsFrames.length,
        noteCount: 0,
        sharedBeamGroupCount: 0,
        measureCount: 0,
        systemCount: 1,
        measures: [],
        spotlightRect: null,
        nextSystemSpotlightRect: null,
        rescueMeasureRect: null,
        clefZonesProtected: true,
        preScrollTargetTop: null,
        notes: [],
      };
    },
    highlightMeasure() {},
    scrollToMeasure() {},
    markAnchoredNotes() {},
    dispose() {},
  });
  return { factory, ehsFrames };
}

const SIMPLE_TWO_MEASURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
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
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

const MULTI_CHUNK_SIX_MEASURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    ${Array.from({ length: 6 }, (_, i) => {
      const m = i + 1;
      const attrs =
        m === 1
          ? `<attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type><sound tempo="120"/></direction>`
          : "";
      return `<measure number="${m}">
      ${attrs}
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>`;
    }).join("\n")}
  </part>
</score-partwise>`;

async function uploadXml(container: HTMLElement, xml: string, fileName = "ehs-test.musicxml") {
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

describe("App Eye-Hand Span Overlay end-to-end integration", () => {
  let root: Root | null = null;
  let appContainer: HTMLDivElement | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    appContainer?.remove();
    appContainer = null;
  });

  it("is OFF by default, hidden/disabled in L0 Stage 0, works on L1+ (including L3 without replacing L3), supports B0/F 1.5s peek with attribution exemption, auto-stall >=2 missed steps + opt-out, and bout-to-bout progression", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 22, 12, 0, 0) });
    const audio = createFakeAudioDeps();
    const midi = createSimulatedMidiDeps();
    const tracker = createEhsTrackingRendererFactory();
    const storage = createInMemoryStorage();

    appContainer = document.createElement("div");
    document.body.appendChild(appContainer);
    root = createRoot(appContainer);

    await act(async () => {
      root!.render(
        createElement(App, {
          solverClientFactory: createSyncSolverClientFactory(),
          scoreRendererFactory: tracker.factory,
          audioDeps: audio.audioDeps,
          midiDeps: midi.midiDeps,
          practiceStorage: storage,
          clockDeps: { nowMs: () => Date.now(), getTimezoneOffsetMin: () => 0 },
        }),
      );
    });

    await uploadXml(appContainer, SIMPLE_TWO_MEASURE_XML);

    // Enter Guided Session Launch -> Start Session -> lands in L0 Stage 0
    await act(async () => {
      (appContainer!.querySelector('[data-testid="enter-guided-session-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (appContainer!.querySelector('[data-testid="guided-start-session-btn"]') as HTMLButtonElement).click();
    });

    expect(appContainer.querySelector('[data-testid="guided-scaffolding-badge"]')?.textContent).toContain("L0");
    // In L0 Stage 0, EHS toggle is hidden from control strip and disabled in Settings
    expect(appContainer.querySelector('[data-testid="guided-ehs-toggle"]')).toBeNull();
    await act(async () => {
      (appContainer!.querySelector('[data-testid="header-midi-status-btn"]') as HTMLButtonElement).click();
    });
    const settingsEhsInL0 = appContainer.querySelector('[data-testid="settings-ehs-enabled-toggle"]') as HTMLInputElement | null;
    expect(settingsEhsInL0).not.toBeNull();
    expect(settingsEhsInL0!.checked).toBe(false);
    expect(settingsEhsInL0!.disabled).toBe(true);
    await act(async () => {
      (appContainer!.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement).click();
    });

    // Graduate Stage 0 -> enters L1 continuous play!
    const scoreDoc = parseMusicXml(SIMPLE_TWO_MEASURE_XML);
    const steps = buildPracticeSteps(scoreDoc, "both");
    for (let i = 0; i < steps.length; i++) {
      await act(async () => {
        for (const m of steps[i].expectedMidis) {
          midi.sendNoteOn(m, 80, performance.now() + i * 50);
        }
        for (const m of steps[i].expectedMidis) {
          midi.sendNoteOff(m, performance.now() + i * 50 + 20);
        }
      });
    }

    // Now in L1 playing! EHS is still OFF by default
    expect(appContainer.querySelector('[data-testid="guided-scaffolding-badge"]')?.textContent).toContain("L1");
    const ehsToggle = appContainer.querySelector('[data-testid="guided-ehs-toggle"]') as HTMLInputElement | null;
    expect(ehsToggle).not.toBeNull();
    expect(ehsToggle!.checked).toBe(false);

    // Enable EHS and select 1-beat preset + 0% ghost ink via Settings
    await act(async () => {
      (appContainer!.querySelector('[data-testid="header-midi-status-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      const toggle = appContainer!.querySelector('[data-testid="settings-ehs-enabled-toggle"]') as HTMLInputElement;
      expect(toggle.disabled).toBe(false);
      toggle.click();
    });
    await act(async () => {
      (appContainer!.querySelector('[data-testid="settings-ehs-preset-1-beat"]') as HTMLButtonElement).click();
      (appContainer!.querySelector('[data-testid="settings-ehs-ghost-0"]') as HTMLButtonElement).click();
      (appContainer!.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement).click();
    });

    // Advance past Count-In (2.0s at 120 BPM) -> EHS rAF frames become active & masked!
    await act(async () => {
      audio.advanceAudio(2.05);
      await vi.advanceTimersByTimeAsync(50);
      audio.flushRaf();
    });
    const activeEhsFrames = tracker.ehsFrames.filter((f) => f && f.active && f.isMasked);
    expect(activeEhsFrames.length).toBeGreaterThan(0);
    expect(activeEhsFrames[activeEhsFrames.length - 1]!.preset).toBe("1-beat");
    expect(activeEhsFrames[activeEhsFrames.length - 1]!.ghostOpacity).toBe(0);
    expect(activeEhsFrames[activeEhsFrames.length - 1]!.lookaheadBeats).toBe(1);

    // Play step 0 (C5 + C3) at t=0.05s, then press B0 peek!
    const tAnchorPerf = performance.now();
    await act(async () => {
      midi.sendNoteOn(72, 82, tAnchorPerf);
      midi.sendNoteOn(48, 78, tAnchorPerf);
      midi.sendNoteOn(PIANO_COMMAND_MIDI.B0, 65, tAnchorPerf + 100);
      audio.flushRaf();
    });
    expect(appContainer.querySelector('[data-testid="score-viewer"]')?.getAttribute("data-scaffolding-peek")).toBe("true");
    const peekFrame = tracker.ehsFrames[tracker.ehsFrames.length - 1];
    expect(peekFrame?.manualPeekActive).toBe(true);
    expect(peekFrame?.isMasked).toBe(false);

    // After 1.5s peek expires, masking restores smoothly
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1550);
      audio.flushRaf();
    });
    expect(appContainer.querySelector('[data-testid="score-viewer"]')?.getAttribute("data-scaffolding-peek")).toBeNull();
    const restoredFrame = tracker.ehsFrames[tracker.ehsFrames.length - 1];
    expect(restoredFrame?.manualPeekActive).toBe(false);
    expect(restoredFrame?.isMasked).toBe(true);

    // Verify F key and touch peek button also trigger 1.5s peek during L1+ EHS play
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", bubbles: true }));
      audio.flushRaf();
    });
    expect(appContainer.querySelector('[data-testid="score-viewer"]')?.getAttribute("data-scaffolding-peek")).toBe("true");
    expect(tracker.ehsFrames[tracker.ehsFrames.length - 1]?.manualPeekActive).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1550);
      audio.flushRaf();
    });
    expect(appContainer.querySelector('[data-testid="score-viewer"]')?.getAttribute("data-scaffolding-peek")).toBeNull();

    const touchPeekBtn = appContainer.querySelector('[data-testid="guided-peek-fingerings-btn"]') as HTMLButtonElement | null;
    expect(touchPeekBtn).not.toBeNull();
    await act(async () => {
      touchPeekBtn!.click();
      audio.flushRaf();
    });
    expect(tracker.ehsFrames[tracker.ehsFrames.length - 1]?.manualPeekActive).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1550);
      audio.flushRaf();
    });

    // Let missed steps (>= 2) trigger auto-stall local measure 1.5s flash!
    await act(async () => {
      audio.advanceAudio(0.4);
      await vi.advanceTimersByTimeAsync(50);
      audio.flushRaf();
    });
    expect(tracker.ehsFrames.some((f) => f?.autoStallMeasureIndex === 0)).toBe(true);

    // Finish bout -> verify PracticeEvent stamped ehsLookaheadPreset: "1-beat" and B0 was exempted
    await act(async () => {
      audio.advanceAudio(3.0);
      await vi.advanceTimersByTimeAsync(100);
    });
    const events = await storage.all("practiceEvents");
    expect(events.length).toBeGreaterThanOrEqual(1);
    const lastEv = events[events.length - 1];
    expect(lastEv.ehsLookaheadPreset).toBe("1-beat");
    expect(lastEv.measureFaultCounts[0]?.extra ?? 0).toBe(0);

    // Verify auto-stall opt-out toggle in Settings works
    await act(async () => {
      (appContainer!.querySelector('[data-testid="header-midi-status-btn"]') as HTMLButtonElement).click();
    });
    const autoStallToggle = appContainer.querySelector('[data-testid="settings-ehs-autostall-toggle"]') as HTMLInputElement;
    expect(autoStallToggle.checked).toBe(true);
    await act(async () => {
      autoStallToggle.click();
    });
    expect(autoStallToggle.checked).toBe(false);
  });

  it("never replaces L3 and displays bout-to-bout preset progression prompt after 2 consecutive smooth passes", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 20, 10, 0, 0) });
    const audio = createFakeAudioDeps();
    const midi = createSimulatedMidiDeps();
    const tracker = createEhsTrackingRendererFactory();
    const storage = createInMemoryStorage();

    const doc = parseMusicXml(MULTI_CHUNK_SIX_MEASURE_XML);
    const staticChunks = analyzeScoreStatic(doc).motorChunks;
    expect(staticChunks.length).toBeGreaterThanOrEqual(2);
    const identity = getScoreIdentity(doc);
    const pieceId = "piece-l3-ehs";
    const profile: PieceProfile = {
      pieceId,
      title: "EHS L3 Test",
      fingerprints: [identity.fingerprint],
      measureHashesByFingerprint: { [identity.fingerprint]: identity.measureHashes },
      bestStableSpeed: 0.95,
    };
    const makeSeed = (
      id: string,
      ts: number,
      dateKey: string,
      wasColdFirstPass: boolean,
      startCoord: PracticeEvent["startCoord"],
      endCoord: PracticeEvent["endCoord"],
    ): PracticeEvent => ({
      eventId: id,
      pieceId,
      scoreFingerprint: identity.fingerprint,
      timestampMs: ts,
      localDateKey: dateKey,
      timezoneOffsetMin: 0,
      sessionId: "seed-l3",
      boutKind: "chunk",
      startCoord,
      endCoord,
      practiceMode: "both",
      speedMultiplier: 0.95,
      durationSec: 4,
      passCount: 1,
      wasColdFirstPass,
      scaffoldingLevel: 2,
      ehsLookaheadPreset: "off",
      autoGrade: 3,
      fluency: {
        pitchAccuracy: 1,
        interiorHesitationCount: 0,
        junctionHesitationRatio: 1,
        timingCv: 0.05,
        stallDetected: false,
        dominantHandFaultRatio: { rh: 0.5, lh: 0.5 },
        switchBranchMismatch: false,
        reanchorCount: 0,
      },
      measureFaultCounts: {},
    });

    const seedEvents: PracticeEvent[] = [];
    for (let ci = 0; ci < staticChunks.length; ci++) {
      const ch = staticChunks[ci];
      seedEvents.push(
        makeSeed(`s1-${ci}`, Date.UTC(2026, 10, 17, 10, ci), "2026-11-17", false, ch.startCoord, ch.endCoord),
        makeSeed(`s2-${ci}`, Date.UTC(2026, 10, 18, 10, ci), "2026-11-18", true, ch.startCoord, ch.endCoord),
        makeSeed(`s3-${ci}`, Date.UTC(2026, 10, 19, 10, ci), "2026-11-19", true, ch.startCoord, ch.endCoord),
      );
    }

    await storage.commit({
      pieceProfiles: [profile],
      practiceEvents: seedEvents,
    });

    appContainer = document.createElement("div");
    document.body.appendChild(appContainer);
    root = createRoot(appContainer);

    await act(async () => {
      root!.render(
        createElement(App, {
          solverClientFactory: createSyncSolverClientFactory(),
          scoreRendererFactory: tracker.factory,
          audioDeps: audio.audioDeps,
          midiDeps: midi.midiDeps,
          practiceStorage: storage,
          clockDeps: { nowMs: () => Date.now(), getTimezoneOffsetMin: () => 0 },
        }),
      );
    });

    await uploadXml(appContainer, MULTI_CHUNK_SIX_MEASURE_XML);

    // Enter Guided Session launch -> opt into EHS at 1-beat via Settings BEFORE starting Bout 1
    await act(async () => {
      (appContainer!.querySelector('[data-testid="enter-guided-session-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (appContainer!.querySelector('[data-testid="header-midi-status-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (appContainer!.querySelector('[data-testid="settings-ehs-enabled-toggle"]') as HTMLInputElement).click();
      (appContainer!.querySelector('[data-testid="settings-ehs-preset-1-beat"]') as HTMLButtonElement).click();
      (appContainer!.querySelector('[data-testid="practice-settings-close-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (appContainer!.querySelector('[data-testid="guided-start-session-btn"]') as HTMLButtonElement).click();
    });

    // L3 badge & L3 silent beat remain intact even with EHS enabled (EHS never replaces L3)
    expect(appContainer.querySelector('[data-testid="guided-scaffolding-badge"]')?.textContent).toContain("L3");
    expect(appContainer.querySelector('[data-testid="guided-l3-silent-beat-toggle"]')).not.toBeNull();
    expect(
      appContainer.querySelector('[data-testid="guided-ehs-preset-1-beat"]')?.getAttribute("aria-pressed"),
    ).toBe("true");

    const allSteps = buildPracticeSteps(doc, "both");
    const runSmoothActiveChunk = async () => {
      const label = appContainer!.querySelector('[data-testid="guided-active-chunk-label"]')?.textContent ?? "";
      const match = /m\.(\d+)(?:[–-](\d+))?/.exec(label);
      const startM = match ? Number(match[1]) - 1 : 0;
      const endM = match && match[2] ? Number(match[2]) - 1 : startM;
      const boutSteps = allSteps.filter(
        (s) => s.measureIndex >= startM && s.measureIndex <= endM,
      );
      const baseSec = doc.measureTimelines[startM].startSec;
      // Advance past 1-bar Count-In (~2.11s at 0.95x)
      await act(async () => {
        audio.advanceAudio(2.15);
        await vi.advanceTimersByTimeAsync(50);
        audio.flushRaf();
      });
      const anchorPerf = performance.now();
      for (const st of boutSteps) {
        const targetPerf = anchorPerf + ((st.onsetSec - baseSec) / 0.95) * 1000;
        await act(async () => {
          for (const m of st.expectedMidis) {
            midi.sendNoteOn(m, 80, targetPerf);
          }
          for (const m of st.expectedMidis) {
            midi.sendNoteOff(m, targetPerf + 60);
          }
        });
      }
      await act(async () => {
        audio.advanceAudio(9.0);
        await vi.advanceTimersByTimeAsync(100);
      });
    };

    // Bout 1 -> micro-rest -> skip micro-rest -> audiation -> C8 continue to Bout 2
    await runSmoothActiveChunk();
    await act(async () => {
      (appContainer!.querySelector('[data-testid="guided-cmd-continue-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (appContainer!.querySelector('[data-testid="guided-cmd-continue-btn"]') as HTMLButtonElement).click();
    });

    // Bout 2 -> micro-rest -> skip micro-rest -> progression banner!
    await runSmoothActiveChunk();
    await act(async () => {
      (appContainer!.querySelector('[data-testid="guided-cmd-continue-btn"]') as HTMLButtonElement).click();
    });

    const banner = appContainer.querySelector('[data-testid="guided-ehs-progression-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("1 拍 → 2 拍");

    await act(async () => {
      (appContainer!.querySelector('[data-testid="guided-ehs-progression-accept-btn"]') as HTMLButtonElement).click();
    });
    expect(appContainer.querySelector('[data-testid="guided-ehs-progression-banner"]')).toBeNull();
    expect(
      appContainer.querySelector('[data-testid="guided-ehs-preset-2-beats"]')?.getAttribute("aria-pressed"),
    ).toBe("true");

    // Disable EHS and run a bout -> persisted PracticeEvent stamps ehsLookaheadPreset: "off"
    await act(async () => {
      (appContainer!.querySelector('[data-testid="guided-ehs-toggle"]') as HTMLInputElement).click();
    });
    await act(async () => {
      (appContainer!.querySelector('[data-testid="guided-cmd-continue-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      audio.advanceAudio(12.0);
      await vi.advanceTimersByTimeAsync(100);
    });
    const finalEvents = await storage.all("practiceEvents");
    expect(finalEvents[finalEvents.length - 1].ehsLookaheadPreset).toBe("off");
  });
});

