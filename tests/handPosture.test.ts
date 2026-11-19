// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  projectDualHandPostureAtSlice,
} from "../src/components/handPostureModel";
import {
  BASE_FINGER_LENGTH_MM,
  BASE_FINGER_LENGTH_PX,
  IDLE_CURVE_FACTOR,
  PIANO_MM_TO_PX,
  PIANO_SVG_H,
  PIANO_WHITE_KEY_W,
  REAL_WHITE_KEY_WIDTH_MM,
  computeHandSkeleton,
  getFixedFingerLengthPx,
} from "../src/components/handSkeleton";
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
        getTimbre: () => "ep-fluid-ep1",
        setTimbre: () => null,
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
    expect(blackSkeleton.fingers[3].totalPhalanxLength).toBeLessThanOrEqual(
      getFixedFingerLengthPx(3, "M") + 2
    );

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

  it("prevents idle finger crossing with held/struck fingers and keeps black-key fingertips on black keys", () => {
    // Reproduces LH holding C3 (5) while striking F#3 (3) + D4 (1), plus RH chord with black keys
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction><sound tempo="60"/></direction>
      <!-- RH: C#4 (1) + G#4 (3) + C#5 (5) black-key chord -->
      <note><pitch><step>C</step><alter>1</alter><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note>
      <note><chord/><pitch><step>G</step><alter>1</alter><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note>
      <note><chord/><pitch><step>C</step><alter>1</alter><octave>5</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>2</duration></backup>
      <!-- LH: C3 held for 2 beats (voice 3), while voice 4 plays E3 at t=0 then F#3+D4 at t=1 -->
      <note>
        <pitch><step>C</step><octave>3</octave></pitch><duration>2</duration><voice>3</voice><staff>2</staff>
        <notations><technical><fingering>5</fingering></technical></notations>
      </note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>1</duration><voice>4</voice><staff>2</staff></note>
      <note>
        <pitch><step>F</step><alter>1</alter><octave>3</octave></pitch><duration>1</duration><voice>4</voice><staff>2</staff>
        <notations><technical><fingering>3</fingering></technical></notations>
      </note>
      <note>
        <chord/><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>4</voice><staff>2</staff>
        <notations><technical><fingering>1</fingering></technical></notations>
      </note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(xml, { DOMParser });
    const solveResult = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const index = buildHandPostureIndex(scoreDoc, solveResult);

    // At t = 0.55s: LH holds C3 (5) and strikes F#3 (3) + D4 (1); idle finger 4 must sit between 5 and 3
    const frame = computeDualHandPostureFrameAtTime(index, 0.55);
    const lhFingers = frame.lh.fingers;
    expect(lhFingers[5].xUnit).toBeLessThan(lhFingers[4].xUnit);
    expect(lhFingers[4].xUnit).toBeLessThan(lhFingers[3].xUnit);
    expect(lhFingers[3].xUnit).toBeLessThan(lhFingers[2].xUnit);
    expect(lhFingers[2].xUnit).toBeLessThan(lhFingers[1].xUnit);

    const lhSkeleton = computeHandSkeleton(frame.lh);
    expect(lhSkeleton.fingers[4].tip.x).toBeGreaterThan(lhSkeleton.fingers[5].tip.x);
    expect(lhSkeleton.fingers[4].tip.x).toBeLessThan(lhSkeleton.fingers[3].tip.x);
    // F#3 (finger 3) must land squarely on the black key (y in [50, 116])
    expect(lhSkeleton.fingers[3].tip.y).toBeGreaterThanOrEqual(50);
    expect(lhSkeleton.fingers[3].tip.y).toBeLessThanOrEqual(116);

    // RH black-key chord: every active black-key finger must land on the black key (y <= 116)
    const frameStart = computeDualHandPostureFrameAtTime(index, 0.05);
    const rhSkeleton = computeHandSkeleton(frameStart.rh);
    for (const f of [1, 2, 3, 4, 5] as const) {
      if (frameStart.rh.fingers[f].isBlack) {
        expect(rhSkeleton.fingers[f].tip.y).toBeGreaterThanOrEqual(50);
        expect(rhSkeleton.fingers[f].tip.y).toBeLessThanOrEqual(116);
      }
    }
  });

  it("keeps single-note HandPosition spans bounded and prevents horizontal idle-finger splay on wuchang m.28", () => {
    const xml05 = readFileSync(
      resolve(__dirname, "../test-corpus/05-realworld-wuchang.musicxml"),
      "utf-8"
    );
    const scoreDoc = parseMusicXml(xml05, { DOMParser });
    const solveResult = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    const m28RhSlices = scoreDoc.onsetSlices.filter((s) => s.measureIndex === 27 && s.hand === "RH");
    expect(m28RhSlices.length).toBeGreaterThan(0);

    for (const slice of m28RhSlices) {
      const frame = projectDualHandPostureAtSlice(scoreDoc, solveResult, slice.sliceId);
      expect(frame.rh.handPosition).not.toBeNull();
      expect(
        Math.abs(frame.rh.handPosition!.pinkyKey - frame.rh.handPosition!.thumbKey)
      ).toBeLessThanOrEqual(7);

      const spanUnits = Math.abs(frame.rh.fingers[5].xUnit - frame.rh.fingers[1].xUnit);
      expect(spanUnits).toBeLessThanOrEqual(5.5);

      const sk = computeHandSkeleton(frame.rh);
      expect(sk.fingers[1].phalanxSpanLength).toBeLessThanOrEqual(
        getFixedFingerLengthPx(1, "M") + 1
      );
      expect(sk.fingers[5].phalanxSpanLength).toBeLessThanOrEqual(
        getFixedFingerLengthPx(5, "M") + 1
      );
    }
  });

  it("enforces fixed S/M/L finger lengths across resting, single-note, and wide-chord postures without stretching", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><staves>1</staves><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(xml, { DOMParser });
    const presets = ["S", "M", "L"] as const;
    const lengthsByPreset: Record<string, Record<number, number>> = {};

    for (const preset of presets) {
      const profile = { ...DEFAULT_HAND_SPAN_PROFILE, preset };
      const solveResult = solveFingering(scoreDoc.onsetSlices, profile);
      lengthsByPreset[preset] = {};

      for (const slice of scoreDoc.onsetSlices) {
        const frame = projectDualHandPostureAtSlice(scoreDoc, solveResult, slice.sliceId, profile);
        const sk = computeHandSkeleton(frame.rh);

        for (const f of [1, 2, 3, 4, 5] as const) {
          const fixedLen = getFixedFingerLengthPx(f, preset);
          const fp = frame.rh.fingers[f];
          if (fp.targetMidi === null) {
            expect(sk.fingers[f].phalanxSpanLength).toBeCloseTo(fixedLen * IDLE_CURVE_FACTOR, 1);
          } else {
            expect(sk.fingers[f].phalanxSpanLength).toBeLessThanOrEqual(fixedLen + 1e-4);
          }
          lengthsByPreset[preset][f] = fixedLen;
        }
      }
    }

    for (const f of [1, 2, 3, 4, 5] as const) {
      expect(lengthsByPreset.S[f]).toBeLessThan(lengthsByPreset.M[f]);
      expect(lengthsByPreset.M[f]).toBeLessThan(lengthsByPreset.L[f]);
    }
  });

  it("calibrates finger dimensions from real-world 23.5mm white-key pitch so M hands reach octaves accurately", () => {
    expect(PIANO_MM_TO_PX).toBeCloseTo(PIANO_WHITE_KEY_W / REAL_WHITE_KEY_WIDTH_MM, 6);
    for (const f of [1, 2, 3, 4, 5] as const) {
      expect(BASE_FINGER_LENGTH_PX[f]).toBeCloseTo(BASE_FINGER_LENGTH_MM[f] * PIANO_MM_TO_PX, 6);
    }

    const octaveXml = `<?xml version="1.0" encoding="UTF-8"?>
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
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>1</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(octaveXml, { DOMParser });
    const solveResult = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const frame = projectDualHandPostureAtSlice(
      scoreDoc,
      solveResult,
      scoreDoc.onsetSlices[0].sliceId,
      DEFAULT_HAND_SPAN_PROFILE
    );

    const rhSk = computeHandSkeleton(frame.rh);
    const lhSk = computeHandSkeleton(frame.lh);

    expect(Math.abs(rhSk.fingers[1].tip.x - midiToWhiteUnitX(60) * PIANO_WHITE_KEY_W)).toBeLessThan(1.5);
    expect(Math.abs(rhSk.fingers[5].tip.x - midiToWhiteUnitX(72) * PIANO_WHITE_KEY_W)).toBeLessThan(1.5);
    expect(Math.abs(lhSk.fingers[5].tip.x - midiToWhiteUnitX(48) * PIANO_WHITE_KEY_W)).toBeLessThan(1.5);
    expect(Math.abs(lhSk.fingers[1].tip.x - midiToWhiteUnitX(60) * PIANO_WHITE_KEY_W)).toBeLessThan(1.5);
  });

  it("allows an M hand to reach the wuchang m.73 RH Eb4+Bb4+F5 wide chord with accurate key alignment", () => {
    const xml05 = readFileSync(
      resolve(__dirname, "../test-corpus/05-realworld-wuchang.musicxml"),
      "utf-8"
    );
    const scoreDoc = parseMusicXml(xml05, { DOMParser });
    const solveResult = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    const m73RhSlice = scoreDoc.onsetSlices.find(
      (s) => s.measureIndex === 72 && s.hand === "RH"
    );
    expect(m73RhSlice).toBeDefined();

    const frame = projectDualHandPostureAtSlice(
      scoreDoc,
      solveResult,
      m73RhSlice!.sliceId,
      DEFAULT_HAND_SPAN_PROFILE
    );
    const sk = computeHandSkeleton(frame.rh);

    for (const note of m73RhSlice!.notes) {
      const f = solveResult.fingerByNoteUid[note.noteUid];
      expect(f).toBeDefined();
      const targetX = midiToWhiteUnitX(note.midi) * PIANO_WHITE_KEY_W;
      expect(Math.abs(sk.fingers[f].tip.x - targetX)).toBeLessThan(2.0);
      if (note.midi === 63 || note.midi === 70) {
        expect(sk.fingers[f].tip.y).toBeGreaterThanOrEqual(50);
        expect(sk.fingers[f].tip.y).toBeLessThanOrEqual(116);
      } else if (note.midi === 77) {
        expect(sk.fingers[f].tip.y).toBeGreaterThanOrEqual(110);
        expect(sk.fingers[f].tip.y).toBeLessThanOrEqual(158);
      }
    }
  });

  it("renders unified organic hand silhouettes with joint creases and keeps wrists within SVG bounds across S/M/L", () => {
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
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>1</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(xml, { DOMParser });

    for (const preset of ["S", "M", "L"] as const) {
      const profile = { ...DEFAULT_HAND_SPAN_PROFILE, preset };
      const solveResult = solveFingering(scoreDoc.onsetSlices, profile);
      const frame = projectDualHandPostureAtSlice(
        scoreDoc,
        solveResult,
        scoreDoc.onsetSlices[0].sliceId,
        profile
      );
      const empty = computeDualHandPostureFrameAtTime(null, 0, preset);

      for (const posture of [frame.rh, frame.lh, empty.rh, empty.lh]) {
        const sk = computeHandSkeleton(posture);
        expect(sk.unifiedHandPath).toContain("M ");
        expect(sk.unifiedHandPath).toContain("Z");
        expect(sk.unifiedHandPath).not.toContain("NaN");
        expect(sk.wristCenter.y).toBeLessThanOrEqual(PIANO_SVG_H);
      }
    }

    const solveResult = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const svgHtml = renderToStaticMarkup(
      createElement(UnifiedPiano88, {
        scoreDoc,
        solveResult,
        selectedSliceId: scoreDoc.onsetSlices[0].sliceId,
        showFullPalm: true,
      })
    );
    const dom = new JSDOM(svgHtml);
    for (const hand of ["RH", "LH"] as const) {
      const overlay = dom.window.document.querySelector(`[data-testid="hand-overlay-${hand}"]`)!;
      expect(overlay.querySelector(`[data-testid="hand-silhouette-${hand}"]`)).not.toBeNull();
      expect(overlay.querySelectorAll('[data-joint-kind="mcp"]')).toHaveLength(5);
      expect(overlay.querySelectorAll('[data-joint-kind="pip"]')).toHaveLength(4);
      expect(overlay.querySelectorAll('[data-joint-kind="dip"]')).toHaveLength(4);
      expect(overlay.querySelectorAll('[data-joint-kind="ip"]')).toHaveLength(1);
      expect(overlay.querySelectorAll('[data-joint-kind="cmc"]')).toHaveLength(1);
    }
  });

  it("lifts pinky off unreachable held bass Bb2 at m.19 C4/D4 while keeping Bb2 pedal-highlighted, and renders data-pedal-sustained", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="19">
      <attributes>
        <divisions>4</divisions>
        <clef><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>B</step><alter>-1</alter><octave>2</octave></pitch><duration>16</duration><voice>2</voice></note>
      <backup><duration>16</duration></backup>
      <note><rest/><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>F</step><octave>3</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>B</step><alter>-1</alter><octave>3</octave></pitch><duration>6</duration><voice>1</voice></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>B</step><alter>-1</alter><octave>3</octave></pitch><duration>4</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(xml, { DOMParser });
    const solveResult = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    const c4Slice = scoreDoc.onsetSlices.find((s) => s.notes.some((n) => n.midi === 60))!;
    const d4Slice = scoreDoc.onsetSlices.find((s) => s.notes.some((n) => n.midi === 62))!;

    for (const slice of [c4Slice, d4Slice]) {
      const frame = projectDualHandPostureAtSlice(
        scoreDoc,
        solveResult,
        slice.sliceId,
        DEFAULT_HAND_SPAN_PROFILE
      );
      expect(frame.lh.fingers[5].targetMidi).toBeNull();
      expect(frame.lh.fingers[5].isHeld).toBe(false);
      expect(frame.activeKeyHighlights.get(46)?.lh).toBe("held");
      expect(frame.activeKeyHighlights.get(46)?.lhPedalSustained).toBe(true);
      expect(Math.abs(frame.lh.fingers[5].xUnit - frame.lh.fingers[1].xUnit)).toBeLessThanOrEqual(6.0);
    }

    const svgHtml = renderToStaticMarkup(
      createElement(UnifiedPiano88, {
        scoreDoc,
        solveResult,
        selectedSliceId: c4Slice.sliceId,
      })
    );
    const dom = new JSDOM(svgHtml);
    const bb2Key = dom.window.document.querySelector('[data-midi="46"]');
    expect(bb2Key?.getAttribute("data-key-lh")).toBe("held");
    expect(bb2Key?.getAttribute("data-pedal-sustained")).toBe("true");
  });

  it("distributes idle fingers anatomically across playable held octaves instead of bunching near thumb", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <clef><sign>F</sign><line>4</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice>
        <notations><technical><fingering>5</fingering></technical></notations>
      </note>
      <backup><duration>4</duration></backup>
      <note><rest/><duration>2</duration><voice>1</voice></note>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice>
        <notations><technical><fingering>1</fingering></technical></notations>
      </note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(xml, { DOMParser });
    const solveResult = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const c4Slice = scoreDoc.onsetSlices.find((s) => s.notes.some((n) => n.midi === 60))!;
    const frame = projectDualHandPostureAtSlice(
      scoreDoc,
      solveResult,
      c4Slice.sliceId,
      DEFAULT_HAND_SPAN_PROFILE
    );
    const f = frame.lh.fingers;

    expect(Math.abs(f[4].xUnit - f[5].xUnit)).toBeLessThanOrEqual(2.1);
    expect(Math.abs(f[1].xUnit - f[2].xUnit)).toBeGreaterThan(Math.abs(f[3].xUnit - f[4].xUnit));
  });
});
