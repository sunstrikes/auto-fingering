// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { parseMusicXml } from "../src/musicxml/parser";
import { solveFingering } from "../src/solver/solveFingering";
import { localResolveFingering } from "../src/solver/localResolve";
import { DEFAULT_HAND_SPAN_PROFILE } from "../src/domain/types";
import { createStudioStore } from "../src/store/useStudioStore";

const SAMPLE_WITH_ANCHOR_AND_TIE = `<?xml version="1.0" encoding="UTF-8"?>
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
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>1</duration><voice>1</voice><staff>1</staff>
        <notations><technical><fingering default-x="10">1</fingering></technical></notations>
      </note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note>
        <pitch><step>F</step><octave>4</octave></pitch>
        <duration>1</duration><voice>1</voice><staff>1</staff>
        <tie type="start"/>
      </note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note>
        <pitch><step>F</step><octave>4</octave></pitch>
        <duration>1</duration><voice>1</voice><staff>1</staff>
        <tie type="stop"/>
      </note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>2</duration><voice>2</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

describe("Seam 2: Zustand studio store (anchors, diff, undo/redo, selection)", () => {
  it("tracks anchors, computes Before -> After lastDiff, updates XML, and reverts/reapplies cleanly via Undo/Redo", () => {
    const { DOMParser, XMLSerializer } = new JSDOM("").window;
    const scoreDoc = parseMusicXml(SAMPLE_WITH_ANCHOR_AND_TIE, { DOMParser });
    const initial = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    const store = createStudioStore();
    store.getState().setSolvedScore({
      scoreDoc,
      rawXmlText: SAMPLE_WITH_ANCHOR_AND_TIE,
      fileName: "sample.musicxml",
      exportFormat: "musicxml",
      solveResult: initial,
      resetHistory: true,
      xmlDeps: { XMLSerializer },
    });

    const c4 = scoreDoc.noteEvents.find((n) => n.midi === 60)!;
    const d4 = scoreDoc.noteEvents.find((n) => n.midi === 62)!;
    const e4 = scoreDoc.noteEvents.find((n) => n.midi === 64)!;
    const tieF4 = scoreDoc.noteEvents.find((n) => n.midi === 65 && n.isTieStop)!;

    expect(store.getState().anchors).toEqual({});
    expect(store.getState().lastDiff).toEqual([]);
    expect(store.getState().history.past).toHaveLength(0);
    expect(store.getState().history.future).toHaveLength(0);
    expect(store.getState().fingerByNoteUid[d4.noteUid]).toBe(2);

    // 1. Select TieContinuation -> keeps measure/hand context and selects that noteUid
    store.getState().selectNote(tieF4.noteUid);
    expect(store.getState().selectedNoteUid).toBe(tieF4.noteUid);
    expect(store.getState().selectedMeasureIndex).toBe(1);

    // 2. Select D4 and override to finger 4 in phrase mode
    store.getState().selectNote(d4.noteUid);
    expect(store.getState().selectedNoteUid).toBe(d4.noteUid);

    const nextAnchors1 = { ...store.getState().anchors, [d4.noteUid]: { finger: 4 as const, mode: "phrase" as const } };
    const res1 = localResolveFingering({
      onsetSlices: scoreDoc.onsetSlices,
      priorFingerByNoteUid: store.getState().fingerByNoteUid,
      targetNoteUid: d4.noteUid,
      override: { finger: 4, mode: "phrase" },
      anchors: nextAnchors1,
      profile: DEFAULT_HAND_SPAN_PROFILE,
    });
    store.getState().commitAnchorResolution({
      targetNoteUid: d4.noteUid,
      override: { finger: 4, mode: "phrase" },
      result: res1,
      xmlDeps: { XMLSerializer },
    });

    const state1 = store.getState();
    expect(state1.anchors[d4.noteUid]).toEqual({ finger: 4, mode: "phrase" });
    expect(state1.fingerByNoteUid[d4.noteUid]).toBe(4);
    expect(state1.history.past).toHaveLength(1);
    expect(state1.history.future).toHaveLength(0);
    expect(state1.lastDiff.length).toBeGreaterThanOrEqual(1);
    const d4Diff = state1.lastDiff.find((d) => d.noteUid === d4.noteUid)!;
    expect(d4Diff).toMatchObject({
      noteUid: d4.noteUid,
      measureIndex: 0,
      pitchLabel: "D4",
      hand: "RH",
      before: 2,
      after: 4,
    });
    expect(state1.renderedXml).toContain(">4</fingering>");

    // 3. Override original XML anchor C4 -> 2 with pinOnly
    const nextAnchors2 = { ...state1.anchors, [c4.noteUid]: { finger: 2 as const, mode: "pinOnly" as const } };
    const res2 = localResolveFingering({
      onsetSlices: scoreDoc.onsetSlices,
      priorFingerByNoteUid: state1.fingerByNoteUid,
      targetNoteUid: c4.noteUid,
      override: { finger: 2, mode: "pinOnly" },
      anchors: nextAnchors2,
      profile: DEFAULT_HAND_SPAN_PROFILE,
    });
    store.getState().commitAnchorResolution({
      targetNoteUid: c4.noteUid,
      override: { finger: 2, mode: "pinOnly" },
      result: res2,
      xmlDeps: { XMLSerializer },
    });

    const state2 = store.getState();
    expect(state2.lastDiff).toEqual([
      {
        noteUid: c4.noteUid,
        measureIndex: 0,
        pitchLabel: "C4",
        hand: "RH",
        before: 1,
        after: 2,
      },
    ]);
    expect(state2.fingerByNoteUid[e4.noteUid]).toBe(state1.fingerByNoteUid[e4.noteUid]);
    expect(state2.history.past).toHaveLength(2);
    expect(state2.renderedXml).toMatch(/<fingering[^>]*default-x="10"[^>]*>2<\/fingering>/);

    // 4. Undo -> restores state1 (and C4 XML back to 1 with default-x="10")
    store.getState().undo({ XMLSerializer });
    const afterUndo1 = store.getState();
    expect(afterUndo1.fingerByNoteUid[c4.noteUid]).toBe(1);
    expect(afterUndo1.anchors[c4.noteUid]).toBeUndefined();
    expect(afterUndo1.anchors[d4.noteUid]).toEqual({ finger: 4, mode: "phrase" });
    expect(afterUndo1.history.past).toHaveLength(1);
    expect(afterUndo1.history.future).toHaveLength(1);
    expect(afterUndo1.renderedXml).toMatch(/<fingering[^>]*default-x="10"[^>]*>1<\/fingering>/);

    // 5. Redo -> reapplies state2
    store.getState().redo({ XMLSerializer });
    const afterRedo = store.getState();
    expect(afterRedo.fingerByNoteUid[c4.noteUid]).toBe(2);
    expect(afterRedo.anchors[c4.noteUid]).toEqual({ finger: 2, mode: "pinOnly" });
    expect(afterRedo.history.past).toHaveLength(2);
    expect(afterRedo.history.future).toHaveLength(0);
    expect(afterRedo.renderedXml).toMatch(/<fingering[^>]*default-x="10"[^>]*>2<\/fingering>/);

    // 6. Undo twice -> back to initial clean state
    store.getState().undo({ XMLSerializer });
    store.getState().undo({ XMLSerializer });
    const afterUndoAll = store.getState();
    expect(afterUndoAll.anchors).toEqual({});
    expect(afterUndoAll.lastDiff).toEqual([]);
    expect(afterUndoAll.fingerByNoteUid[d4.noteUid]).toBe(2);
    expect(afterUndoAll.history.past).toHaveLength(0);
    expect(afterUndoAll.history.future).toHaveLength(2);
  });
});
