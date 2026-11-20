// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { DEFAULT_HAND_SPAN_PROFILE } from "../src/domain/types";
import { parseMusicXml } from "../src/musicxml/parser";
import {
  applyAllScoreRepairsToXml,
  applyScoreRepairToXml,
} from "../src/musicxml/repairWriter";
import { analyzeScoreRepairSuggestions } from "../src/solver/scoreRepair";
import { solveFingering } from "../src/solver/solveFingering";
import { createStudioStore, useStudioStore } from "../src/store/useStudioStore";
import { ScoreRepairPanel } from "../src/components/ScoreRepairPanel";
import App from "../src/App";
import { createSolverClient, type WorkerLike } from "../src/workers/solverClient";
import { handleWorkerRequest } from "../src/workers/fingering.worker";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";
import type { ScoreRendererHandle } from "../src/components/ScoreViewer";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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
  useStudioStore.getState().reset();
});

function createJsdomDom() {
  const dom = new JSDOM("");
  return {
    DOMParser: dom.window.DOMParser,
    XMLSerializer: dom.window.XMLSerializer,
  };
}

describe("Score playability diagnosis & lossless MusicXML repair", () => {
  it("diagnoses chord-over-octave (Measure 69 E2+E3+Ab3), chord-exceeds-5, and held-over-octave with fidelity-ranked options", () => {
    const { DOMParser } = createJsdomDom();

    // 1. Measure 69 scenario: LH E2+E3+Ab3 (16 semitones) while RH already spans Ab4+Db5+Ab5 (full octave)
    const m69Xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="69">
      <attributes>
        <divisions>4</divisions>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>A</step><alter>-1</alter><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <note><chord/><pitch><step>D</step><alter>-1</alter><octave>5</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <note><chord/><pitch><step>A</step><alter>-1</alter><octave>5</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>E</step><octave>2</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>E</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>A</step><alter>-1</alter><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const doc69 = parseMusicXml(m69Xml, { DOMParser });
    const suggestions69 = analyzeScoreRepairSuggestions(doc69.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(suggestions69).toHaveLength(1);
    expect(suggestions69[0].issueKind).toBe("chord-over-octave");
    expect(suggestions69[0].maxSemitones).toBe(16);

    const strategies69 = suggestions69[0].options.map((o) => o.strategy);
    expect(strategies69).toContain("octave-fold-thin");
    expect(strategies69).toContain("arpeggiate");
    expect(strategies69).not.toContain("hand-redistribution"); // RH already spans an octave
    // Top recommendation folds Ab3 -> Ab2 yielding E2+Ab2+E3
    expect(suggestions69[0].options[0].strategy).toBe("octave-fold-thin");
    expect(suggestions69[0].options[0].previewSummary).toBe("E2+Ab2+E3");
    // Alternative duplicate thinning drops redundant E2 yielding E3+Ab3
    expect(suggestions69[0].options.some((o) => o.previewSummary === "E3+Ab3")).toBe(true);

    // 2. Dual-staff hand-redistribution priority when opposite hand can absorb note within 1 octave
    const redistXml = `<?xml version="1.0" encoding="UTF-8"?>
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
      <backup><duration>1</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>G</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const docRedist = parseMusicXml(redistXml, { DOMParser });
    const sugRedist = analyzeScoreRepairSuggestions(docRedist.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(sugRedist).toHaveLength(1);
    expect(sugRedist[0].options[0].strategy).toBe("hand-redistribution");
    expect(sugRedist[0].options[0].previewSummary).toBe("LH C3+G3 | RH E4+C5");

    // 3. chord-exceeds-5 (6 notes within 1 octave without adjacent 2nd on outer ends)
    const sixNoteXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const doc6 = parseMusicXml(sixNoteXml, { DOMParser });
    const sug6 = analyzeScoreRepairSuggestions(doc6.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(sug6).toHaveLength(1);
    expect(sug6[0].issueKind).toBe("chord-exceeds-5");
    expect(sug6[0].options.some((o) => o.strategy === "octave-fold-thin")).toBe(true);
    expect(sug6[0].options.some((o) => o.strategy === "arpeggiate")).toBe(true);

    // 4. held-over-octave (non-pedal held note collides over octave with later beat)
    const heldConflictXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><clef><sign>F</sign><line>4</line></clef></attributes>
      <note><pitch><step>E</step><octave>2</octave></pitch><duration>4</duration><voice>2</voice></note>
      <backup><duration>4</duration></backup>
      <note><rest/><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>A</step><alter>-1</alter><octave>3</octave></pitch><duration>2</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const docHeld = parseMusicXml(heldConflictXml, { DOMParser });
    const sugHeld = analyzeScoreRepairSuggestions(docHeld.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(sugHeld).toHaveLength(1);
    expect(sugHeld[0].issueKind).toBe("held-over-octave");
    expect(sugHeld[0].options[0].strategy).toBe("clip-duration");
    expect(sugHeld[0].options[0].edits[0]).toEqual({
      kind: "clip-duration",
      noteUid: docHeld.noteEvents[0].noteUid,
      newDurationTick: 2,
    });
  });

  it("applies all 5 DOM edits losslessly in repairWriter (conserving ticks, zero xmlns='', resolving warnings)", () => {
    const { DOMParser, XMLSerializer } = createJsdomDom();

    // A. add-arpeggiate + change-pitch + chord-head remove-note on E2+E3+Ab3
    const chordXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>F</sign><line>4</line></clef></attributes>
      <note><pitch><step>E</step><octave>2</octave></pitch><duration>2</duration><voice>1</voice><lyric><text>bass</text></lyric></note>
      <note><chord/><pitch><step>E</step><octave>3</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><chord/><pitch><step>A</step><alter>-1</alter><octave>3</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>B</step><octave>2</octave></pitch><duration>2</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const chordDoc = parseMusicXml(chordXml, { DOMParser });
    const chordSug = analyzeScoreRepairSuggestions(chordDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE)[0];

    // A1: Fold Ab3 -> Ab2 (change-pitch)
    const foldOpt = chordSug.options.find((o) => o.previewSummary === "E2+Ab2+E3")!;
    const foldedXml = applyScoreRepairToXml(chordXml, chordDoc, foldOpt, {
      DOMParser,
      XMLSerializer,
    });
    expect(foldedXml).not.toContain('xmlns=""');
    const foldedDoc = parseMusicXml(foldedXml, { DOMParser });
    expect(foldedDoc.onsetSlices[0].notes.map((n) => n.midi)).toEqual([40, 44, 52]);
    expect(foldedDoc.onsetSlices[1].onsetTick).toBe(2); // Cursor conserved
    const foldedSolve = solveFingering(foldedDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(foldedSolve.warnings.filter((w) => w.type === "unreachable-span")).toHaveLength(0);
    expect(foldedSolve.repairSuggestions).toEqual([]);

    // A2: Thin chord head E2 (remove-note promotes <chord/> sibling E3!)
    const thinOpt = chordSug.options.find((o) => o.previewSummary === "E3+Ab3")!;
    const thinnedXml = applyScoreRepairToXml(chordXml, chordDoc, thinOpt, {
      DOMParser,
      XMLSerializer,
    });
    const thinnedDoc = parseMusicXml(thinnedXml, { DOMParser });
    expect(thinnedDoc.onsetSlices[0].notes.map((n) => n.midi)).toEqual([52, 56]);
    expect(thinnedDoc.onsetSlices[1].onsetTick).toBe(2); // Next note B2 still at tick 2!
    const thinnedSolve = solveFingering(thinnedDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(thinnedSolve.warnings.filter((w) => w.type === "unreachable-span")).toHaveLength(0);

    // A3: add-arpeggiate keeps XSD order before <lyric>
    const arpOpt = chordSug.options.find((o) => o.strategy === "arpeggiate")!;
    const arpXml = applyScoreRepairToXml(chordXml, chordDoc, arpOpt, {
      DOMParser,
      XMLSerializer,
    });
    const arpDoc = parseMusicXml(arpXml, { DOMParser });
    expect(arpDoc.onsetSlices[0].notes.every((n) => n.isArpeggiated)).toBe(true);
    const firstNoteChildren = Array.from(
      arpDoc.noteElementsByUid.get(arpDoc.noteEvents[0].noteUid)!.children
    ).map((c) => c.localName);
    expect(firstNoteChildren.indexOf("notations")).toBeLessThan(firstNoteChildren.indexOf("lyric"));
    const arpSolve = solveFingering(arpDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(arpSolve.warnings.filter((w) => w.type === "unreachable-span")).toHaveLength(0);
    expect(arpSolve.repairSuggestions).toEqual([]);

    // B. reassign-hand Path A (same-beat note on target hand) & Path B (<backup> when target hand rests)
    const dualXml = `<?xml version="1.0" encoding="UTF-8"?>
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
      <!-- Beat 1: RH has C5 (Path A) -->
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <!-- Beat 2: RH rests (Path B) -->
      <note><rest/><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>2</duration></backup>
      <!-- Beat 1: LH C3+G3+E4 -->
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>G</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <!-- Beat 2: LH D3+A3+F4 -->
      <note><pitch><step>D</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>A</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>2</duration><voice>2</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const dualDoc = parseMusicXml(dualXml, { DOMParser });
    const dualSugs = analyzeScoreRepairSuggestions(dualDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(dualSugs).toHaveLength(2);
    const beat1Redist = dualSugs[0].options[0];
    expect(beat1Redist.strategy).toBe("hand-redistribution");
    const afterBeat1Xml = applyScoreRepairToXml(dualXml, dualDoc, beat1Redist, {
      DOMParser,
      XMLSerializer,
    });
    const afterBeat1Doc = parseMusicXml(afterBeat1Xml, { DOMParser });
    // Beat 1 now has LH [C3, G3] and RH [E4, C5]
    const rhBeat1 = afterBeat1Doc.onsetSlices.find(
      (s) => s.hand === "RH" && s.onsetTick === 0
    )!;
    const lhBeat1 = afterBeat1Doc.onsetSlices.find(
      (s) => s.hand === "LH" && s.onsetTick === 0
    )!;
    expect(rhBeat1.notes.map((n) => n.midi)).toEqual([64, 72]); // RH
    expect(lhBeat1.notes.map((n) => n.midi)).toEqual([48, 55]); // LH

    // Apply Path B on Beat 2 (RH was resting!)
    const beat2Sugs = analyzeScoreRepairSuggestions(
      afterBeat1Doc.onsetSlices,
      DEFAULT_HAND_SPAN_PROFILE
    );
    expect(beat2Sugs).toHaveLength(1);
    const beat2Redist = beat2Sugs[0].options[0];
    expect(beat2Redist.strategy).toBe("hand-redistribution");
    const afterBeat2Xml = applyScoreRepairToXml(afterBeat1Xml, afterBeat1Doc, beat2Redist, {
      DOMParser,
      XMLSerializer,
    });
    expect(afterBeat2Xml).not.toContain('xmlns=""');
    const afterBeat2Doc = parseMusicXml(afterBeat2Xml, { DOMParser });
    // Beat 2 moved F4 (65) to RH cleanly without >=70% reversal; Measure 2 still starts at tick 2!
    const rhBeat2 = afterBeat2Doc.onsetSlices.find(
      (s) => s.hand === "RH" && s.onsetTick === 1
    )!;
    const lhBeat2 = afterBeat2Doc.onsetSlices.find(
      (s) => s.hand === "LH" && s.onsetTick === 1
    )!;
    expect(rhBeat2.notes.map((n) => n.midi)).toEqual([65]);
    expect(lhBeat2.notes.map((n) => n.midi)).toEqual([50, 57]);
    expect(afterBeat2Doc.measureTimelines[1].startTick).toBe(2);
    const finalDualSolve = solveFingering(afterBeat2Doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(finalDualSolve.repairSuggestions).toEqual([]);

    // C. clip-duration across a multi-measure tie chain
    const tieClipXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><clef><sign>F</sign><line>4</line></clef></attributes>
      <note>
        <pitch><step>E</step><octave>2</octave></pitch><duration>4</duration><tie type="start"/><voice>2</voice>
        <notations><tied type="start"/></notations>
      </note>
      <backup><duration>4</duration></backup>
      <note><rest/><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>A</step><alter>-1</alter><octave>3</octave></pitch><duration>2</duration><voice>1</voice></note>
    </measure>
    <measure number="2">
      <note>
        <pitch><step>E</step><octave>2</octave></pitch><duration>4</duration><tie type="stop"/><voice>2</voice>
        <notations><tied type="stop"/></notations>
      </note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>B</step><octave>2</octave></pitch><duration>4</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const tieDoc = parseMusicXml(tieClipXml, { DOMParser });
    const tieSug = analyzeScoreRepairSuggestions(tieDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(tieSug).toHaveLength(1);
    expect(tieSug[0].issueKind).toBe("held-over-octave");

    const clippedXml = applyScoreRepairToXml(tieClipXml, tieDoc, tieSug[0].options[0], {
      DOMParser,
      XMLSerializer,
    });
    expect(clippedXml).not.toContain('xmlns=""');
    const clippedDoc = parseMusicXml(clippedXml, { DOMParser });
    // E2 clipped to durationTick=2, measure 1 & 2 timelines stay exact, orphan TieContinuation in m2 removed/rested
    expect(clippedDoc.measureTimelines[0].endTick).toBe(4);
    expect(clippedDoc.measureTimelines[1].startTick).toBe(4);
    expect(clippedDoc.measureTimelines[1].endTick).toBe(8);
    expect(clippedDoc.noteEvents.some((n) => n.isTieStop)).toBe(false);
    const clippedSolve = solveFingering(clippedDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(clippedSolve.warnings.filter((w) => w.type === "unreachable-span")).toHaveLength(0);
    expect(clippedSolve.repairSuggestions).toEqual([]);
  });

  it("supports store applyScoreRepair + undo / redo and UI ScoreRepairPanel workflow", async () => {
    const { DOMParser, XMLSerializer } = createJsdomDom();
    const m69Xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><clef><sign>F</sign><line>4</line></clef></attributes>
      <note><pitch><step>E</step><octave>2</octave></pitch><duration>4</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>3</octave></pitch><duration>4</duration><voice>1</voice></note>
      <note><chord/><pitch><step>A</step><alter>-1</alter><octave>3</octave></pitch><duration>4</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

    // 1. Store applyScoreRepair + Undo / Redo roundtrip
    const doc0 = parseMusicXml(m69Xml, { DOMParser });
    const solve0 = solveFingering(doc0.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(solve0.repairSuggestions).toHaveLength(1);

    const store = createStudioStore();
    store.getState().setSolvedScore({
      scoreDoc: doc0,
      rawXmlText: m69Xml,
      fileName: "m69.musicxml",
      exportFormat: "musicxml",
      solveResult: solve0,
      resetHistory: true,
      xmlDeps: { XMLSerializer },
    });

    const opt = solve0.repairSuggestions![0].options[0];
    const xml1 = applyScoreRepairToXml(m69Xml, doc0, opt, { DOMParser, XMLSerializer });
    const doc1 = parseMusicXml(xml1, { DOMParser });
    const solve1 = solveFingering(doc1.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    store.getState().applyScoreRepair({
      rawXmlText: xml1,
      scoreDoc: doc1,
      solveResult: solve1,
      repairSummary: solve0.repairSuggestions![0].summary,
      xmlDeps: { XMLSerializer },
    });

    expect(store.getState().solveResult?.repairSuggestions).toEqual([]);
    expect(store.getState().scoreDoc?.noteEvents.map((n) => n.midi)).toEqual([40, 44, 52]);
    expect(store.getState().history.past).toHaveLength(1);

    store.getState().undo({ XMLSerializer });
    expect(store.getState().solveResult?.repairSuggestions).toHaveLength(1);
    expect(store.getState().scoreDoc?.noteEvents.map((n) => n.midi)).toEqual([40, 52, 56]);

    store.getState().redo({ XMLSerializer });
    expect(store.getState().solveResult?.repairSuggestions).toEqual([]);
    expect(store.getState().scoreDoc?.noteEvents.map((n) => n.midi)).toEqual([40, 44, 52]);

    // 2. ScoreRepairPanel component interactions
    const onLocate = vi.fn();
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    const onClose = vi.fn();

    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    const suggestion = solve0.repairSuggestions![0];
    act(() => {
      mountedRoot!.render(
        createElement(ScoreRepairPanel, {
          suggestions: [suggestion],
          onLocateSuggestion: onLocate,
          onApplyOption: onApply,
          onDismissSuggestion: onDismiss,
          onClose,
        })
      );
    });

    const locateBtn = mountedContainer.querySelector(
      `[data-testid="repair-locate-${suggestion.repairId}"]`
    ) as HTMLButtonElement;
    act(() => locateBtn.click());
    expect(onLocate).toHaveBeenCalledWith(suggestion);

    const secondOpt = suggestion.options[1];
    const optBtn = mountedContainer.querySelector(
      `[data-testid="repair-opt-${secondOpt.optionId}"]`
    ) as HTMLButtonElement;
    act(() => optBtn.click());

    const applyBtn = mountedContainer.querySelector(
      `[data-testid="repair-apply-${suggestion.repairId}"]`
    ) as HTMLButtonElement;
    act(() => applyBtn.click());
    expect(onApply).toHaveBeenCalledWith(suggestion, secondOpt);

    const dismissBtn = mountedContainer.querySelector(
      `[data-testid="repair-dismiss-${suggestion.repairId}"]`
    ) as HTMLButtonElement;
    act(() => dismissBtn.click());
    expect(onDismiss).toHaveBeenCalledWith(suggestion.repairId);

    // 3. Full App integration (upload -> badge -> apply repair -> re-solve clears repair -> undo restores)
    const inProcessWorkerFactory = (): WorkerLike => {
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(msg: unknown) {
          const req = msg as WorkerRequest;
          queueMicrotask(() => {
            const resp = handleWorkerRequest(req);
            worker.onmessage?.({ data: resp } as MessageEvent<WorkerResponse>);
          });
        },
        terminate() {},
      };
      return worker;
    };

    const fakeRenderer: ScoreRendererHandle = {
      render: vi.fn(async () => ({
        measureCount: 1,
        measureGeometry: [{ measureIndex: 0, top: 0, height: 100 }],
      })),
      highlightMeasure: vi.fn(),
      markAnchoredNotes: vi.fn(),
      markDiffNotes: vi.fn(),
      scrollToMeasure: vi.fn(),
      dispose: vi.fn(),
    };

    await act(async () => {
      mountedRoot!.render(
        createElement(App, {
          solverClientFactory: () => createSolverClient(inProcessWorkerFactory),
          scoreRendererFactory: () => fakeRenderer,
        })
      );
    });

    const fileInput = mountedContainer.querySelector('input[type="file"]') as HTMLInputElement;
    const fakeFile = {
      name: "m69.musicxml",
      text: async () => m69Xml,
      arrayBuffer: async () => new TextEncoder().encode(m69Xml).buffer,
    };
    Object.defineProperty(fileInput, "files", { value: [fakeFile], configurable: true });

    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });

    const toggleBtn = mountedContainer.querySelector(
      '[data-testid="score-repair-toggle-btn"]'
    ) as HTMLButtonElement;
    expect(toggleBtn).not.toBeNull();
    expect(toggleBtn.textContent).toContain("乐谱修复建议 1");

    act(() => toggleBtn.click());
    const appApplyBtn = mountedContainer.querySelector(
      `[data-testid="repair-apply-${suggestion.repairId}"]`
    ) as HTMLButtonElement;
    expect(appApplyBtn).not.toBeNull();

    await act(async () => {
      appApplyBtn.click();
      await new Promise((r) => setTimeout(r, 20));
    });

    // Repair panel & badge disappear after repair resolves all issues
    expect(mountedContainer.querySelector('[data-testid="score-repair-toggle-btn"]')).toBeNull();
    expect(useStudioStore.getState().scoreDoc?.noteEvents.map((n) => n.midi)).toEqual([40, 44, 52]);

    // Undo button restores original over-octave score and brings back the repair badge
    const undoBtn = mountedContainer.querySelector('[data-testid="undo-btn"]') as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(false);
    act(() => undoBtn.click());
    expect(useStudioStore.getState().scoreDoc?.noteEvents.map((n) => n.midi)).toEqual([40, 52, 56]);
    expect(mountedContainer.querySelector('[data-testid="score-repair-toggle-btn"]')).not.toBeNull();
  });

  it("supports one-click batch repair (applyAllScoreRepairsToXml, ScoreRepairPanel button, and single-step Undo in App)", async () => {
    const { DOMParser, XMLSerializer } = createJsdomDom();

    // Score with 2 over-octave chords in the same measure (Beat 1: Path A, Beat 2: Path B)
    const multiXml = `<?xml version="1.0" encoding="UTF-8"?>
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
      <note><rest/><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>G</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <note><pitch><step>D</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>A</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>2</duration><voice>2</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

    // 1. Unit test applyAllScoreRepairsToXml with custom option selection + dismissed item
    const doc0 = parseMusicXml(multiXml, { DOMParser });
    const sugs0 = analyzeScoreRepairSuggestions(doc0.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(sugs0).toHaveLength(2);

    // Select arpeggiate on the 2nd suggestion, keep default on 1st
    const arpOpt1 = sugs0[1].options.find((o) => o.strategy === "arpeggiate")!;
    const batchRes = applyAllScoreRepairsToXml(
      multiXml,
      doc0,
      [
        { suggestion: sugs0[0], option: sugs0[0].options[0] },
        { suggestion: sugs0[1], option: arpOpt1 },
      ],
      DEFAULT_HAND_SPAN_PROFILE,
      undefined,
      sugs0,
      { DOMParser, XMLSerializer }
    );
    expect(batchRes.appliedCount).toBe(2);
    expect(batchRes.scoreDoc.measureTimelines[1].startTick).toBe(2);
    const remainingAfterAll = analyzeScoreRepairSuggestions(
      batchRes.scoreDoc.onsetSlices,
      DEFAULT_HAND_SPAN_PROFILE
    );
    expect(remainingAfterAll).toEqual([]);
    const lhBeat2 = batchRes.scoreDoc.onsetSlices.find(
      (s) => s.hand === "LH" && s.onsetTick === 1
    )!;
    expect(lhBeat2.notes.every((n) => n.isArpeggiated)).toBe(true);

    // Dismissing 1st suggestion skips it during batch repair
    const dismissedSet = new Set([sugs0[0].repairId]);
    const partialRes = applyAllScoreRepairsToXml(
      multiXml,
      doc0,
      [{ suggestion: sugs0[1], option: sugs0[1].options[0] }],
      DEFAULT_HAND_SPAN_PROFILE,
      dismissedSet,
      sugs0,
      { DOMParser, XMLSerializer }
    );
    expect(partialRes.appliedCount).toBe(1);
    const remainingAfterPartial = analyzeScoreRepairSuggestions(
      partialRes.scoreDoc.onsetSlices,
      DEFAULT_HAND_SPAN_PROFILE
    );
    expect(remainingAfterPartial).toHaveLength(1);
    expect(remainingAfterPartial[0].onsetTick).toBe(0);

    // 2. ScoreRepairPanel "一键修复" button calls onApplyAll with active options
    const onApplyAll = vi.fn();
    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);
    act(() => {
      mountedRoot!.render(
        createElement(ScoreRepairPanel, {
          suggestions: sugs0,
          onLocateSuggestion: vi.fn(),
          onApplyOption: vi.fn(),
          onApplyAll,
          onDismissSuggestion: vi.fn(),
          onClose: vi.fn(),
        })
      );
    });

    const optBtn = mountedContainer.querySelector(
      `[data-testid="repair-opt-${arpOpt1.optionId}"]`
    ) as HTMLButtonElement;
    act(() => optBtn.click());

    const applyAllBtn = mountedContainer.querySelector(
      '[data-testid="score-repair-apply-all-btn"]'
    ) as HTMLButtonElement;
    expect(applyAllBtn).not.toBeNull();
    expect(applyAllBtn.textContent).toBe("一键修复");
    act(() => applyAllBtn.click());
    expect(onApplyAll).toHaveBeenCalledWith([
      { suggestion: sugs0[0], option: sugs0[0].options[0] },
      { suggestion: sugs0[1], option: arpOpt1 },
    ]);

    // 3. Full App integration: upload multiXml -> open panel -> click 一键修复 -> all resolved -> single Undo restores both
    const inProcessWorkerFactory = (): WorkerLike => {
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(msg: unknown) {
          const req = msg as WorkerRequest;
          queueMicrotask(() => {
            const resp = handleWorkerRequest(req);
            worker.onmessage?.({ data: resp } as MessageEvent<WorkerResponse>);
          });
        },
        terminate() {},
      };
      return worker;
    };

    const fakeRenderer: ScoreRendererHandle = {
      render: vi.fn(async () => ({
        measureCount: 2,
        measureGeometry: [
          { measureIndex: 0, top: 0, height: 100 },
          { measureIndex: 1, top: 100, height: 100 },
        ],
      })),
      highlightMeasure: vi.fn(),
      markAnchoredNotes: vi.fn(),
      markDiffNotes: vi.fn(),
      scrollToMeasure: vi.fn(),
      dispose: vi.fn(),
    };

    await act(async () => {
      mountedRoot!.render(
        createElement(App, {
          solverClientFactory: () => createSolverClient(inProcessWorkerFactory),
          scoreRendererFactory: () => fakeRenderer,
        })
      );
    });

    const fileInput = mountedContainer.querySelector('input[type="file"]') as HTMLInputElement;
    const fakeFile = {
      name: "multi.musicxml",
      text: async () => multiXml,
      arrayBuffer: async () => new TextEncoder().encode(multiXml).buffer,
    };
    Object.defineProperty(fileInput, "files", { value: [fakeFile], configurable: true });

    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });

    const toggleBtn = mountedContainer.querySelector(
      '[data-testid="score-repair-toggle-btn"]'
    ) as HTMLButtonElement;
    expect(toggleBtn.textContent).toContain("乐谱修复建议 2");

    act(() => toggleBtn.click());
    const appApplyAllBtn = mountedContainer.querySelector(
      '[data-testid="score-repair-apply-all-btn"]'
    ) as HTMLButtonElement;
    expect(appApplyAllBtn).not.toBeNull();

    await act(async () => {
      appApplyAllBtn.click();
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(mountedContainer.querySelector('[data-testid="score-repair-toggle-btn"]')).toBeNull();
    expect(useStudioStore.getState().solveResult?.repairSuggestions).toEqual([]);
    expect(useStudioStore.getState().status).toContain("一键修复 2 处");

    const undoBtn = mountedContainer.querySelector('[data-testid="undo-btn"]') as HTMLButtonElement;
    act(() => undoBtn.click());
    expect(useStudioStore.getState().solveResult?.repairSuggestions).toHaveLength(2);
    expect(mountedContainer.querySelector('[data-testid="score-repair-toggle-btn"]')?.textContent).toContain(
      "乐谱修复建议 2"
    );
  });
});
