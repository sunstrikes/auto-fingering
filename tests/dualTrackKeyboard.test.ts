import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_HAND_SPAN_PROFILE } from "../src/domain/types";
import { parseMusicXml } from "../src/musicxml/parser";
import { solveFingering } from "../src/solver/solveFingering";
import { createSolverClient, type WorkerLike } from "../src/workers/solverClient";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";
import App from "../src/App";
import { projectDualTrackState } from "../src/components/dualTrackModel";
import { DualTrackKeyboard } from "../src/components/DualTrackKeyboard";

const { DOMParser } = new JSDOM("").window;

describe("dualTrackModel", () => {
  it("falls back to first slice when selectedSliceId is null and projects simultaneous RH/LH active keys and HandPositions", () => {
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
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(xml, { DOMParser });
    const solveResult = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    const state = projectDualTrackState(scoreDoc, solveResult, null);
    expect(state.totalSlices).toBe(3);
    expect(state.selectedIndex).toBe(0);
    expect(state.selectedSlice?.sliceId).toBe("slice-0");

    // At onsetTick=0, noteEvents sort by midi ascending so LH (C3) is slice-0 and RH (C4) is slice-1
    expect(state.rh.activeSliceId).toBe("slice-1");
    expect(state.rh.activeKeys).toHaveLength(1);
    expect(state.rh.activeKeys[0].midi).toBe(60);
    expect(state.rh.activeKeys[0].finger).toBe(solveResult.fingerByNoteUid[state.rh.activeKeys[0].noteUid]);
    expect(state.rh.handPosition).not.toBeNull();
    expect(state.rh.handPosition?.hand).toBe("RH");

    expect(state.lh.activeSliceId).toBe("slice-0");
    expect(state.lh.activeKeys).toHaveLength(1);
    expect(state.lh.activeKeys[0].midi).toBe(48);
    expect(state.lh.activeKeys[0].finger).toBe(solveResult.fingerByNoteUid[state.lh.activeKeys[0].noteUid]);
    expect(state.lh.handPosition).not.toBeNull();
    expect(state.lh.handPosition?.hand).toBe("LH");
  });

  it("projects HeldFinger sustain badges (both same-hand heldNotes and cross-hand tie-extended sustain) with their assigned fingers", () => {
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
      <!-- RH voice 1 holds G5 for 2 beats; voice 2 plays C5 on beat 1 and D5 on beat 2 -->
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>2</voice><staff>1</staff></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><voice>2</voice><staff>1</staff></note>
      <backup><duration>2</duration></backup>
      <!-- LH C3 tied across beat 1 + beat 2 (total 2 beats) -->
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><tie type="start"/><voice>3</voice><staff>2</staff></note>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><tie type="stop"/><voice>3</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(xml, { DOMParser });
    const solveResult = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    // Beat 2 is RH D5 (slice-2)
    const beat2RhSlice = scoreDoc.onsetSlices.find(
      (s) => s.hand === "RH" && s.notes.some((n) => n.midi === 74)
    )!;
    const rhG5Note = scoreDoc.noteEvents.find((n) => n.midi === 79)!;
    const lhC3Root = scoreDoc.noteEvents.find((n) => n.midi === 48 && !n.isTieStop)!;

    const state = projectDualTrackState(scoreDoc, solveResult, beat2RhSlice.sliceId);

    // RH: D5 active, G5 held
    expect(state.rh.activeKeys.map((k) => k.midi)).toEqual([74]);
    expect(state.rh.heldFingers).toHaveLength(1);
    expect(state.rh.heldFingers[0].midi).toBe(79);
    expect(state.rh.heldFingers[0].finger).toBe(solveResult.fingerByNoteUid[rhG5Note.noteUid]);

    // LH: no new onset on beat 2, but C3 tie-continuation sustains across beat 2
    expect(state.lh.activeSliceId).toBeNull();
    expect(state.lh.activeKeys).toEqual([]);
    expect(state.lh.heldFingers).toHaveLength(1);
    expect(state.lh.heldFingers[0].midi).toBe(48);
    expect(state.lh.heldFingers[0].noteUid).toBe(lhC3Root.noteUid);
    expect(state.lh.heldFingers[0].finger).toBe(solveResult.fingerByNoteUid[lhC3Root.noteUid]);
    expect(state.lh.handPosition).not.toBeNull();
    expect(state.lh.handPosition?.hand).toBe("LH");
  });

  it("projects incoming TransitionCue arcs and labels (thumb-under, cross-over, position-shift, wide-stretch, unreachable-span, anchor-conflict)", () => {
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
      <!-- RH ascending C4 D4 E4 F4 (thumb-under 3->1 on F4) then jump to G5 (position-shift) -->
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>5</duration></backup>
      <!-- LH 16-semitone chord C3+E4 (unreachable-span) on beat 1, anchor-conflict C3(5)+E3(5) on beat 2 -->
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <note>
        <pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff>
        <notations><technical><fingering>5</fingering></technical></notations>
      </note>
      <note>
        <chord/><pitch><step>E</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff>
        <notations><technical><fingering>5</fingering></technical></notations>
      </note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(xml, { DOMParser });
    const solveResult = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    // 1. Thumb-under on RH F4 (midi 65) from E4 (midi 64)
    const f4Slice = scoreDoc.onsetSlices.find(
      (s) => s.hand === "RH" && s.notes.some((n) => n.midi === 65)
    )!;
    const f4State = projectDualTrackState(scoreDoc, solveResult, f4Slice.sliceId);
    expect(f4State.rh.transitionCues.some((c) => c.cue.type === "thumb-under")).toBe(true);
    const thumbUnderArc = f4State.rh.transitionCues.find((c) => c.cue.type === "thumb-under")!;
    expect(thumbUnderArc.fromMidi).toBe(64);
    expect(thumbUnderArc.toMidi).toBe(65);
    expect(thumbUnderArc.isSequential).toBe(true);

    // 2. Position shift on RH G5 (midi 79) from F4 (midi 65)
    const g5Slice = scoreDoc.onsetSlices.find(
      (s) => s.hand === "RH" && s.notes.some((n) => n.midi === 79)
    )!;
    const g5State = projectDualTrackState(scoreDoc, solveResult, g5Slice.sliceId);
    const shiftArc = g5State.rh.transitionCues.find((c) => c.cue.type === "position-shift")!;
    expect(shiftArc).toBeDefined();
    expect(shiftArc.fromMidi).toBe(65);
    expect(shiftArc.toMidi).toBe(79);

    // 3. Unreachable span on LH C3+E4 chord (beat 1)
    const lhBeat1 = scoreDoc.onsetSlices.find((s) => s.hand === "LH" && s.onsetTick === 0)!;
    const lh1State = projectDualTrackState(scoreDoc, solveResult, lhBeat1.sliceId);
    const spanArc = lh1State.lh.transitionCues.find((c) => c.cue.type === "unreachable-span")!;
    expect(spanArc).toBeDefined();
    expect(spanArc.fromMidi).toBe(48);
    expect(spanArc.toMidi).toBe(64);
    expect(lh1State.lh.startMidi).toBeLessThanOrEqual(48);
    expect(lh1State.lh.endMidi).toBeGreaterThanOrEqual(64);

    // 4. Anchor conflict on LH beat 2
    const lhBeat2 = scoreDoc.onsetSlices.find((s) => s.hand === "LH" && s.onsetTick === 1)!;
    const lh2State = projectDualTrackState(scoreDoc, solveResult, lhBeat2.sliceId);
    const conflictArc = lh2State.lh.transitionCues.find((c) => c.cue.type === "anchor-conflict")!;
    expect(conflictArc).toBeDefined();
    expect(conflictArc.fromMidi).toBe(48);
    expect(conflictArc.toMidi).toBe(52);
  });
});

describe("DualTrackKeyboard component", () => {
  it("renders separate Right Hand above Left Hand tracks with non-overlapping 3-layer SVG (TransitionCue, HandPosition, active & held badges)", () => {
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
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>8</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>8</duration><voice>2</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const scoreDoc = parseMusicXml(xml, { DOMParser });
    const solveResult = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const f4Slice = scoreDoc.onsetSlices.find(
      (s) => s.hand === "RH" && s.notes.some((n) => n.midi === 65)
    )!;

    const html = renderToStaticMarkup(
      createElement(DualTrackKeyboard, {
        scoreDoc,
        solveResult,
        selectedSliceId: f4Slice.sliceId,
      })
    );

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const rhTrack = doc.querySelector('[data-testid="keyboard-track-RH"]');
    const lhTrack = doc.querySelector('[data-testid="keyboard-track-LH"]');
    expect(rhTrack).not.toBeNull();
    expect(lhTrack).not.toBeNull();

    // Right Hand appears before Left Hand in vertical DOM order
    const allTracks = Array.from(doc.querySelectorAll('[data-testid^="keyboard-track-"]'));
    expect(allTracks.map((el) => el.getAttribute("data-testid"))).toEqual([
      "keyboard-track-RH",
      "keyboard-track-LH",
    ]);

    // RH track has all 3 non-overlapping layers + Thumb-under cue + active finger 1
    const rhCueLayer = rhTrack!.querySelector('[data-layer="transition-cue"]');
    const rhPosLayer = rhTrack!.querySelector('[data-layer="hand-position"]');
    const rhKeysLayer = rhTrack!.querySelector('[data-layer="keyboard-keys"]');
    expect(rhCueLayer?.textContent).toContain("Thumb-under");
    expect(rhPosLayer?.querySelector("rect")).not.toBeNull();
    expect(rhKeysLayer?.querySelectorAll('[data-key-state="active"]')).toHaveLength(1);

    // Check strictly disjoint Y-coordinates across the 3 layers on RH
    const cueTextY = Number(rhCueLayer!.querySelector("text")!.getAttribute("y"));
    const posRectY = Number(rhPosLayer!.querySelector("rect")!.getAttribute("y"));
    const posTextY = Number(rhPosLayer!.querySelector("text")!.getAttribute("y"));
    const firstKeyY = Number(rhKeysLayer!.querySelector("rect")!.getAttribute("y"));
    expect(cueTextY).toBeLessThan(posRectY);
    expect(posTextY).toBeLessThan(firstKeyY);

    // LH track shows dimmed HeldFinger sustain badge for C3 across beat 4
    const lhKeysLayer = lhTrack!.querySelector('[data-layer="keyboard-keys"]');
    const lhHeldKeys = lhKeysLayer!.querySelectorAll('[data-key-state="held"]');
    expect(lhHeldKeys).toHaveLength(1);
    expect(lhHeldKeys[0].textContent).toContain(
      String(solveResult.fingerByNoteUid[scoreDoc.onsetSlices[0].notes[0].noteUid])
    );
  });

  it("steps between OnsetSlices via Prev/Next controls with boundary disabling and immediate track updates", async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
      url: "http://localhost/",
    });
    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    const prevActEnv = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
    // @ts-expect-error test jsdom globals for React mount
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      const { act, useState } = await import("react");
      const { createRoot } = await import("react-dom/client");

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
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>8</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>8</duration><voice>2</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

      const scoreDoc = parseMusicXml(xml, { DOMParser });
      const solveResult = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

      function Harness() {
        const [sliceId, setSliceId] = useState<string | null>(scoreDoc.onsetSlices[0].sliceId);
        return createElement(DualTrackKeyboard, {
          scoreDoc,
          solveResult,
          selectedSliceId: sliceId,
          onSelectSlice: setSliceId,
        });
      }

      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(Harness));
      });

      const getPrevBtn = () =>
        Array.from(container.querySelectorAll("button")).find((b) =>
          b.textContent?.includes("Prev slice")
        )!;
      const getNextBtn = () =>
        Array.from(container.querySelectorAll("button")).find((b) =>
          b.textContent?.includes("Next slice")
        )!;

      // Initially at slice 0 (LH G2 + simultaneous RH C5): Prev disabled, Next enabled
      expect(getPrevBtn().disabled).toBe(true);
      expect(getNextBtn().disabled).toBe(false);
      expect(container.textContent).toContain(`Slice 1 / ${scoreDoc.onsetSlices.length}`);

      // Step forward through all remaining slices and confirm cross-over cue appears when descending
      let sawCrossOver = false;
      for (let i = 1; i < scoreDoc.onsetSlices.length; i++) {
        await act(async () => {
          getNextBtn().click();
        });
        expect(container.textContent).toContain(`Slice ${i + 1} / ${scoreDoc.onsetSlices.length}`);
        expect(getPrevBtn().disabled).toBe(false);
        const rhCue = container.querySelector('[data-testid="keyboard-track-RH"] [data-layer="transition-cue"]')?.textContent ?? "";
        if (rhCue.includes("Cross-over")) {
          sawCrossOver = true;
        }
      }

      expect(sawCrossOver).toBe(true);
      expect(getNextBtn().disabled).toBe(true);

      // Step backward once
      await act(async () => {
        getPrevBtn().click();
      });
      expect(container.textContent).toContain(
        `Slice ${scoreDoc.onsetSlices.length - 1} / ${scoreDoc.onsetSlices.length}`
      );
      expect(getNextBtn().disabled).toBe(false);

      await act(async () => {
        root.unmount();
      });
    } finally {
      globalThis.window = prevWindow;
      globalThis.document = prevDocument;
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    }
  });
});

describe("App DualTrackKeyboard integration", () => {
  it("mounts DualTrackKeyboard in bottom dock defaulting to slice 1 and steps slices interactively", async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
      url: "http://localhost/",
    });
    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    const prevDOMParser = globalThis.DOMParser;
    const prevXMLSerializer = globalThis.XMLSerializer;
    const prevActEnv = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
    // @ts-expect-error test jsdom globals for React mount
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.DOMParser = dom.window.DOMParser;
    globalThis.XMLSerializer = dom.window.XMLSerializer;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      const { act } = await import("react");
      const { createRoot } = await import("react-dom/client");

      const inProcessWorkerFactory = (): WorkerLike => {
        const w: WorkerLike = {
          onmessage: null,
          onerror: null,
          postMessage(msg: unknown) {
            const req = msg as WorkerRequest;
            queueMicrotask(() => {
              const result = solveFingering(req.onsetSlices, req.profile, {
                ignoreExistingFingerings: req.ignoreExistingFingerings,
              });
              const resp: WorkerResponse = { requestId: req.requestId, ok: true, result };
              w.onmessage?.({ data: resp } as MessageEvent<WorkerResponse>);
            });
          },
          terminate() {},
        };
        return w;
      };

      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(App, {
            solverClientFactory: () => createSolverClient(inProcessWorkerFactory),
          })
        );
      });

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
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const fakeFile = {
        name: "duet.musicxml",
        text: async () => xml,
        arrayBuffer: async () => new TextEncoder().encode(xml).buffer,
      };
      Object.defineProperty(fileInput, "files", { value: [fakeFile], configurable: true });

      await act(async () => {
        fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 10));
      });

      const dock = container.querySelector('[data-testid="dual-track-keyboard"]');
      expect(dock).not.toBeNull();
      expect(dock!.textContent).toContain("Slice 1 / 3");
      expect(dock!.querySelector('[data-testid="keyboard-track-RH"]')).not.toBeNull();
      expect(dock!.querySelector('[data-testid="keyboard-track-LH"]')).not.toBeNull();

      // Beat 1 (slice-0 LH C3 + slice-1 RH C4): RH C4 active, LH C3 active
      expect(
        dock!.querySelector('[data-testid="keyboard-track-RH"] [data-midi="60"]')?.getAttribute(
          "data-key-state"
        )
      ).toBe("active");

      const nextBtn = Array.from(dock!.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Next slice")
      )!;
      // Step to slice-2 (RH E4 at beat 2; LH C3 held)
      await act(async () => {
        nextBtn.click();
      });
      await act(async () => {
        nextBtn.click();
      });

      expect(dock!.textContent).toContain("Slice 3 / 3");
      expect(
        dock!.querySelector('[data-testid="keyboard-track-RH"] [data-midi="64"]')?.getAttribute(
          "data-key-state"
        )
      ).toBe("active");
      expect(
        dock!.querySelector('[data-testid="keyboard-track-LH"] [data-midi="48"]')?.getAttribute(
          "data-key-state"
        )
      ).toBe("held");

      await act(async () => {
        root.unmount();
      });
    } finally {
      globalThis.window = prevWindow;
      globalThis.document = prevDocument;
      globalThis.DOMParser = prevDOMParser;
      globalThis.XMLSerializer = prevXMLSerializer;
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    }
  });
});
