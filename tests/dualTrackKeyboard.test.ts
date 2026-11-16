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
import { UnifiedPiano88 } from "../src/components/UnifiedPiano88";

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

describe("UnifiedPiano88 component", () => {
  it("renders all 88 physical keys (A0..C8), dual overhead HandPosition/TransitionCue lanes, and translucent 2D LH/RH hands", () => {
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
      createElement(UnifiedPiano88, {
        scoreDoc,
        solveResult,
        selectedSliceId: f4Slice.sliceId,
      })
    );

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Physical 88 keys: 52 white + 36 black = 88
    const allKeys = doc.querySelectorAll('[data-testid^="piano-key-"]');
    expect(allKeys).toHaveLength(88);
    expect(doc.querySelector('[data-midi="21"]')).not.toBeNull();
    expect(doc.querySelector('[data-midi="108"]')).not.toBeNull();

    // Overhead RH and LH lanes + TransitionCue badge
    const rhLane = doc.querySelector('[data-testid="overhead-lane-RH"]');
    const lhLane = doc.querySelector('[data-testid="overhead-lane-LH"]');
    expect(rhLane?.textContent).toContain("Thumb-under");
    expect(lhLane).not.toBeNull();

    // Both 2D hand overlays present; RH shows thumb-under crossing style
    const rhOverlay = doc.querySelector('[data-testid="hand-overlay-RH"]')!;
    const lhOverlay = doc.querySelector('[data-testid="hand-overlay-LH"]')!;
    expect(rhOverlay.getAttribute("data-crossing-style")).toBe("thumb-under");
    expect(rhOverlay.querySelector('[data-testid="hand-RH-finger-1"]')?.getAttribute("data-layer-offset")).toBe("-1");
    expect(lhOverlay.querySelector('[data-midi="48"]')).toBeNull(); // key lives on physical key layer
    expect(doc.querySelector('[data-midi="48"]')?.getAttribute("data-key-lh")).toBe("held");
    expect(doc.querySelector('[data-midi="65"]')?.getAttribute("data-key-rh")).toBe("active");
  });

  it("steps between OnsetSlices via Prev/Next controls and auditions clicked keys", async () => {
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
      const auditioned: number[] = [];

      function Harness() {
        const [sliceId, setSliceId] = useState<string | null>(scoreDoc.onsetSlices[0].sliceId);
        return createElement(UnifiedPiano88, {
          scoreDoc,
          solveResult,
          selectedSliceId: sliceId,
          onSelectSlice: setSliceId,
          onAuditionMidi: (m) => auditioned.push(m),
        });
      }

      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(Harness));
      });

      const prevBtn = container.querySelector('[data-testid="slice-prev-btn"]') as HTMLButtonElement;
      const nextBtn = container.querySelector('[data-testid="slice-next-btn"]') as HTMLButtonElement;

      expect(prevBtn.disabled).toBe(true);
      expect(nextBtn.disabled).toBe(false);
      expect(container.textContent).toContain(`切片 1/${scoreDoc.onsetSlices.length}`);

      let sawCrossOver = false;
      for (let i = 1; i < scoreDoc.onsetSlices.length; i++) {
        await act(async () => {
          nextBtn.click();
        });
        expect(container.textContent).toContain(`切片 ${i + 1}/${scoreDoc.onsetSlices.length}`);
        expect(prevBtn.disabled).toBe(false);
        const rhOverlay = container.querySelector('[data-testid="hand-overlay-RH"]');
        if (rhOverlay?.getAttribute("data-crossing-style") === "cross-over") {
          sawCrossOver = true;
        }
      }

      expect(sawCrossOver).toBe(true);
      expect(nextBtn.disabled).toBe(true);

      // Click middle C (MIDI 60) -> triggers key audition
      await act(async () => {
        container.querySelector('[data-testid="piano-key-60"]')!.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true })
        );
      });
      expect(auditioned).toEqual([60]);

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

describe("App UnifiedPiano88 bottom-dock integration", () => {
  it("mounts UnifiedPiano88 in bottom dock defaulting to slice 1 and steps slices interactively", async () => {
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

      const dock = container.querySelector('[data-testid="unified-piano-88"]')!;
      expect(dock).not.toBeNull();
      expect(dock.textContent).toContain("切片 1/3");
      expect(dock.querySelector('[data-testid="hand-overlay-RH"]')).not.toBeNull();
      expect(dock.querySelector('[data-testid="hand-overlay-LH"]')).not.toBeNull();

      // Beat 1: RH C4 active, LH C3 active
      expect(dock.querySelector('[data-midi="60"]')?.getAttribute("data-key-rh")).toBe("active");
      expect(dock.querySelector('[data-midi="48"]')?.getAttribute("data-key-lh")).toBe("active");

      const nextBtn = dock.querySelector('[data-testid="slice-next-btn"]') as HTMLButtonElement;
      await act(async () => {
        nextBtn.click();
      });
      await act(async () => {
        nextBtn.click();
      });

      expect(dock.textContent).toContain("切片 3/3");
      expect(dock.querySelector('[data-midi="64"]')?.getAttribute("data-key-rh")).toBe("active");
      expect(dock.querySelector('[data-midi="48"]')?.getAttribute("data-key-lh")).toBe("held");

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
