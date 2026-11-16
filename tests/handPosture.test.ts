// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { DEFAULT_HAND_SPAN_PROFILE } from "../src/domain/types";
import { parseMusicXml } from "../src/musicxml/parser";
import { solveFingering } from "../src/solver/solveFingering";
import {
  PIANO_MAX_MIDI,
  PIANO_MIN_MIDI,
  buildHandPostureIndex,
  computeDualHandPostureFrameAtTime,
  midiToWhiteUnitX,
} from "../src/components/handPostureModel";
import { computeHandSkeleton } from "../src/components/handSkeleton";
import { UnifiedPiano88 } from "../src/components/UnifiedPiano88";
import { createPlaybackEngine, type PlaybackFrame } from "../src/audio/playbackEngine";
import { ScoreViewer, type ScoreRendererHandle } from "../src/components/ScoreViewer";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { DOMParser } = new JSDOM("").window;

let mountedRoot: Root | null = null;
let mountedContainer: HTMLElement | null = null;

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

describe("handPostureModel continuous 88-key kinematics", () => {
  it("maps A0..C8 across 52 white-key units and computes HeldFinger + anticipatory shift + shared-key overlap", () => {
    expect(midiToWhiteUnitX(PIANO_MIN_MIDI)).toBeCloseTo(0.5, 2);
    expect(midiToWhiteUnitX(60)).toBeCloseTo(23.5, 2);
    expect(midiToWhiteUnitX(PIANO_MAX_MIDI)).toBeCloseTo(51.5, 2);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction><sound tempo="60"/></direction>
      <!-- RH holds C4 (60) for 2s via voice 1 while voice 2 plays E4 (t=0) then G5 (t=1s jump) -->
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice><staff>1</staff></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>1</duration><voice>2</voice><staff>1</staff></note>
      <backup><duration>2</duration></backup>
      <!-- LH plays C4 simultaneously at t=0 -> tests dual-hand overlap on MIDI 60 -->
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>3</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(xml, { DOMParser });
    const solveResult = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const index = buildHandPostureIndex(scoreDoc, solveResult);

    // At t = 0.04s: both RH and LH occupy MIDI 60 simultaneously
    const frameStart = computeDualHandPostureFrameAtTime(index, 0.04);
    const overlapKey = frameStart.activeKeyHighlights.get(60);
    expect(overlapKey?.rh).toBe("active");
    expect(overlapKey?.lh).toBe("active");

    // During anticipatory shift window right before t = 1.0s (at t = 0.94s):
    // C4 (HeldFinger 1) remains pinned at C4 white unit ~23.5 while palm shifts toward G5!
    const frameBeforeJump = computeDualHandPostureFrameAtTime(index, 0.94);
    expect(frameBeforeJump.rh.fingers[1].isHeld).toBe(true);
    expect(frameBeforeJump.rh.fingers[1].targetMidi).toBe(60);
    expect(frameBeforeJump.rh.fingers[1].xUnit).toBeCloseTo(midiToWhiteUnitX(60), 2);
    expect(frameBeforeJump.rh.palmCenterXUnit).toBeGreaterThan(frameStart.rh.palmCenterXUnit);
  });

  it("emits continuous onFrame scoreSec updates from playbackEngine", async () => {
    const frames: Array<PlaybackFrame | null> = [];
    let now = 0;
    const fakeCtx = {
      get currentTime() {
        return now;
      },
      destination: {},
    } as unknown as AudioContext;

    const rafQueue = new Map<number, FrameRequestCallback>();
    let rafSeq = 1;

    const engine = createPlaybackEngine({
      audioEngine: {
        getStatus: () => "synth",
        getAudioContext: () => fakeCtx,
        prepare: async () => "synth",
        triggerNote: vi.fn(),
        stopAll: vi.fn(),
        dispose: vi.fn(),
      },
      requestAnimationFrame: (cb) => {
        const id = rafSeq++;
        rafQueue.set(id, cb);
        return id;
      },
      cancelAnimationFrame: (id) => {
        rafQueue.delete(id);
      },
      onFrame: (f) => frames.push(f),
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><staves>1</staves><clef><sign>G</sign><line>2</line></clef></attributes>
      <direction><sound tempo="60"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const doc = parseMusicXml(xml, { DOMParser });
    await engine.play(doc);
    expect(frames[0]?.state).toBe("playing");

    now = 0.42;
    const pending = Array.from(rafQueue.values());
    rafQueue.clear();
    for (const cb of pending) cb(420);

    expect(frames.at(-1)?.scoreSec).toBeCloseTo(0.42, 2);

    engine.stop();
    expect(frames.at(-1)).toBeNull();
  });

  it("pauses horizontal auto-scroll on manual user scroll during playback and resumes on Recenter click", async () => {
    const fakeRenderer: ScoreRendererHandle = {
      render: vi.fn(async () => ({
        measureCount: 2,
        measureGeometry: [
          { measureIndex: 0, top: 0, height: 100, left: 0, width: 500 },
          { measureIndex: 1, top: 0, height: 100, left: 500, width: 500 },
        ],
      })),
      highlightMeasure: vi.fn(),
      markAnchoredNotes: vi.fn(),
      scrollToMeasure: vi.fn(),
      getCursorOffsetX: () => 400,
      dispose: vi.fn(),
    };

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><staves>1</staves><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(xml, { DOMParser });
    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    await act(async () => {
      mountedRoot!.render(
        createElement(ScoreViewer, {
          xmlString: xml,
          scoreDoc,
          noteEvents: scoreDoc.noteEvents,
          layoutMode: "horizontal",
          playbackFrame: { scoreSec: 0.4, totalDurationSec: 2, state: "playing" },
          cursorTarget: { sliceId: "slice-0", measureIndex: 0, onsetTick: 0, isGrace: false, midis: [60] },
          rendererFactory: () => fakeRenderer,
        })
      );
      await Promise.resolve();
    });

    const scrollEl = mountedContainer.querySelector('[data-testid="score-scroll-container"]') as HTMLElement;
    expect(mountedContainer.querySelector('[data-testid="recenter-cursor-btn"]')).toBeNull();

    // User wheels horizontally while playing -> pauses auto-scroll and shows Recenter button
    act(() => {
      scrollEl.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaX: 80 }));
    });
    const recenterBtn = mountedContainer.querySelector('[data-testid="recenter-cursor-btn"]') as HTMLButtonElement;
    expect(recenterBtn).not.toBeNull();

    act(() => {
      recenterBtn.click();
    });
    expect(mountedContainer.querySelector('[data-testid="recenter-cursor-btn"]')).toBeNull();
  });

  it("models anatomical hand skeleton proportions (3 > 4 > 2 > 5 > 1), articulated joints, and black-key palm forward shift", () => {
    const emptyFrame = computeDualHandPostureFrameAtTime(null, 0);

    for (const handPosture of [emptyFrame.rh, emptyFrame.lh]) {
      const sk = computeHandSkeleton(handPosture);
      const f = sk.fingers;

      // Physical phalanx length ordering: Middle (3) > Ring (4) > Index (2) > Pinky (5) > Thumb (1)
      expect(f[3].totalPhalanxLength).toBeGreaterThan(f[4].totalPhalanxLength);
      expect(f[4].totalPhalanxLength).toBeGreaterThan(f[2].totalPhalanxLength);
      expect(f[2].totalPhalanxLength).toBeGreaterThan(f[5].totalPhalanxLength);
      expect(f[5].totalPhalanxLength).toBeGreaterThan(f[1].totalPhalanxLength);

      // Metacarpal length ordering: Middle (3) > Index/Ring (2,4) > Pinky (5) > Thumb (1)
      expect(f[3].metacarpalLength).toBeGreaterThan(f[2].metacarpalLength);
      expect(f[3].metacarpalLength).toBeGreaterThan(f[4].metacarpalLength);
      expect(f[2].metacarpalLength).toBeGreaterThan(f[5].metacarpalLength);
      expect(f[5].metacarpalLength).toBeGreaterThan(f[1].metacarpalLength);

      // Natural curved fingertip arch on white keys (3 highest / smallest Y, 1 lowest / largest Y)
      expect(f[3].tip.y).toBeLessThan(f[4].tip.y);
      expect(f[4].tip.y).toBeLessThanOrEqual(f[2].tip.y);
      expect(f[2].tip.y).toBeLessThan(f[5].tip.y);
      expect(f[5].tip.y).toBeLessThan(f[1].tip.y);

      // Articulated joint chains: thumb has CMC/MCP/IP (2 phalanges), fingers 2-5 have MCP/PIP/DIP (3 phalanges)
      expect(f[1].joints.map((j) => j.kind)).toEqual(["cmc", "mcp", "ip"]);
      expect(f[1].phalanges).toHaveLength(2);
      for (const idx of [2, 3, 4, 5] as const) {
        expect(f[idx].joints.map((j) => j.kind)).toEqual(["mcp", "pip", "dip"]);
        expect(f[idx].phalanges).toHaveLength(3);
      }
    }

    // Black key slice shifts palm forward (negative palmLiftY) while keeping thumb/pinky reach bounded
    const blackKeyXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <staves>1</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction><sound tempo="60"/></direction>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(blackKeyXml, { DOMParser });
    const solveResult = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const index = buildHandPostureIndex(scoreDoc, solveResult);
    const frameBlack = computeDualHandPostureFrameAtTime(index, 0.05);
    expect(frameBlack.rh.palmLiftY).toBeLessThan(-10);

    const blackSkeleton = computeHandSkeleton(frameBlack.rh);
    expect(blackSkeleton.fingers[3].totalPhalanxLength).toBeLessThanOrEqual(69);

    // Mounted SVG renders articulated joints inside hand overlays
    const svgHtml = renderToStaticMarkup(
      createElement(UnifiedPiano88, {
        scoreDoc,
        solveResult,
        selectedSliceId: scoreDoc.onsetSlices[0].sliceId,
      })
    );
    const dom = new JSDOM(svgHtml);
    const rhOverlay = dom.window.document.querySelector('[data-testid="hand-overlay-RH"]')!;
    expect(rhOverlay.querySelectorAll('[data-joint-kind="mcp"]')).toHaveLength(5);
    expect(rhOverlay.querySelectorAll('[data-joint-kind="pip"]')).toHaveLength(4);
    expect(rhOverlay.querySelectorAll('[data-joint-kind="dip"]')).toHaveLength(4);
    expect(rhOverlay.querySelectorAll('[data-joint-kind="ip"]')).toHaveLength(1);
    expect(rhOverlay.querySelectorAll('[data-joint-kind="cmc"]')).toHaveLength(1);
  });
});
