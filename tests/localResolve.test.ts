import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { parseMusicXml } from "../src/musicxml/parser";
import { solveFingering } from "../src/solver/solveFingering";
import { localResolveFingering } from "../src/solver/localResolve";
import { DEFAULT_HAND_SPAN_PROFILE, type Finger } from "../src/domain/types";

function buildLongGrandStaffXml(measureCount: number): string {
  const measures: string[] = [];
  for (let m = 1; m <= measureCount; m++) {
    const isPhraseBreak = m === measureCount - 1;
    const attrs =
      m === 1
        ? `<attributes><divisions>1</divisions><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`
        : "";
    const rhContent = isPhraseBreak
      ? `<note><rest/><duration>4</duration><voice>1</voice><staff>1</staff></note>`
      : `
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
        <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
        <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
        <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</staff></note>`;
    measures.push(`
      <measure number="${m}">
        ${attrs}
        ${rhContent.replace("<staff>1</staff>", "<staff>1</staff>")}
        <backup><duration>4</duration></backup>
        <note><pitch><step>C</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><staff>2</staff></note>
        <note><pitch><step>G</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><staff>2</staff></note>
      </measure>
    `);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">${measures.join("\n")}</part>
</score-partwise>`;
}

describe("Seam 1: localResolveFingering", () => {
  it("phrase mode re-solves only the target (hand, phraseId) within +-16 measures with DP convergence truncation, leaving opposite hand & other phrases untouched", () => {
    const { DOMParser } = new JSDOM("").window;
    // Fix typo in measure builder helper cleanly
    const xml = buildLongGrandStaffXml(40).replaceAll("<voice>1</staff>", "<voice>1</voice><staff>1</staff>");
    const doc = parseMusicXml(xml, { DOMParser });
    const initial = solveFingering(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    // Target RH note in measure index 19 (measure 20), which is in phrase 0
    const targetNote = doc.noteEvents.find(
      (n) => n.hand === "RH" && n.measureIndex === 19 && n.midi === 62
    )!;
    expect(targetNote).toBeDefined();
    const priorFinger = initial.fingerByNoteUid[targetNote.noteUid];
    const nextFinger: Finger = priorFinger === 4 ? 3 : 4;

    const updated = localResolveFingering({
      onsetSlices: doc.onsetSlices,
      priorFingerByNoteUid: initial.fingerByNoteUid,
      targetNoteUid: targetNote.noteUid,
      override: { finger: nextFinger, mode: "phrase" },
      anchors: { [targetNote.noteUid]: { finger: nextFinger, mode: "phrase" } },
      profile: DEFAULT_HAND_SPAN_PROFILE,
    });

    // Target note honors the new anchor
    expect(updated.fingerByNoteUid[targetNote.noteUid]).toBe(nextFinger);

    // Opposite hand (LH) is 100% unchanged
    for (const note of doc.noteEvents) {
      if (note.hand === "LH") {
        expect(updated.fingerByNoteUid[note.noteUid]).toBe(initial.fingerByNoteUid[note.noteUid]);
      }
    }

    // Separate phrase (measure 40, index 39) is 100% unchanged
    for (const note of doc.noteEvents) {
      if (note.hand === "RH" && note.measureIndex === 39) {
        expect(updated.fingerByNoteUid[note.noteUid]).toBe(initial.fingerByNoteUid[note.noteUid]);
      }
    }

    // Notes outside +-16 measure cap (measures 0..2 and 36..37) are 100% unchanged
    for (const note of doc.noteEvents) {
      if (note.hand === "RH" && Math.abs(note.measureIndex - targetNote.measureIndex) > 16) {
        expect(updated.fingerByNoteUid[note.noteUid]).toBe(initial.fingerByNoteUid[note.noteUid]);
      }
    }
  });

  it("completes phrase-mode local anchor re-solve on test-corpus/05-realworld-wuchang.musicxml in <= 20 ms", () => {
    const { DOMParser } = new JSDOM("").window;
    const xml05 = readFileSync(
      resolve(__dirname, "../test-corpus/05-realworld-wuchang.musicxml"),
      "utf-8"
    );
    const doc = parseMusicXml(xml05, { DOMParser });
    const initial = solveFingering(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    const rhTarget = doc.noteEvents.find(
      (n) => !n.isTieStop && n.hand === "RH" && n.measureIndex >= 20 && n.measureIndex <= 30
    )!;
    const prevFinger = initial.fingerByNoteUid[rhTarget.noteUid];
    const overrideFinger: Finger = prevFinger === 5 ? 4 : 5;

    const t0 = performance.now();
    const updated = localResolveFingering({
      onsetSlices: doc.onsetSlices,
      priorFingerByNoteUid: initial.fingerByNoteUid,
      targetNoteUid: rhTarget.noteUid,
      override: { finger: overrideFinger, mode: "phrase" },
      anchors: { [rhTarget.noteUid]: { finger: overrideFinger, mode: "phrase" } },
      profile: DEFAULT_HAND_SPAN_PROFILE,
    });
    const elapsedMs = performance.now() - t0;

    expect(updated.fingerByNoteUid[rhTarget.noteUid]).toBe(overrideFinger);
    expect(elapsedMs).toBeLessThanOrEqual(20);
    expect(updated.solveTimeMs).toBeLessThanOrEqual(20);

    // Opposite hand unchanged
    for (const note of doc.noteEvents) {
      if (note.hand === "LH" && !note.isTieStop) {
        expect(updated.fingerByNoteUid[note.noteUid]).toBe(initial.fingerByNoteUid[note.noteUid]);
      }
    }
  });

  it("pinOnly mode updates only the target note without disturbing neighbors, and removing an anchor restores solver freedom", () => {
    const { DOMParser } = new JSDOM("").window;
    // Scale with an original XML anchor forcing D4 -> 5 (unusual)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note>
        <pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice>
        <notations><technical><fingering>5</fingering></technical></notations>
      </note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const doc = parseMusicXml(xml, { DOMParser });
    const initial = solveFingering(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const [c4, d4, e4, f4, g4] = doc.noteEvents;
    expect(initial.fingerByNoteUid[d4.noteUid]).toBe(5);

    // 1. pinOnly override on E4 -> 1 without disturbing any neighbor
    const pinned = localResolveFingering({
      onsetSlices: doc.onsetSlices,
      priorFingerByNoteUid: initial.fingerByNoteUid,
      targetNoteUid: e4.noteUid,
      override: { finger: 1, mode: "pinOnly" },
      anchors: { [e4.noteUid]: { finger: 1, mode: "pinOnly" } },
      profile: DEFAULT_HAND_SPAN_PROFILE,
    });

    expect(pinned.fingerByNoteUid[e4.noteUid]).toBe(1);
    expect(pinned.fingerByNoteUid[c4.noteUid]).toBe(initial.fingerByNoteUid[c4.noteUid]);
    expect(pinned.fingerByNoteUid[d4.noteUid]).toBe(initial.fingerByNoteUid[d4.noteUid]);
    expect(pinned.fingerByNoteUid[f4.noteUid]).toBe(initial.fingerByNoteUid[f4.noteUid]);
    expect(pinned.fingerByNoteUid[g4.noteUid]).toBe(initial.fingerByNoteUid[g4.noteUid]);

    // 2. Remove original XML anchor on D4 AND user pin on E4 -> restores natural 1-2-3-4-5 solver freedom
    const freedE4 = localResolveFingering({
      onsetSlices: doc.onsetSlices,
      priorFingerByNoteUid: pinned.fingerByNoteUid,
      targetNoteUid: e4.noteUid,
      override: null,
      anchors: {},
      removedRawAnchorUids: [d4.noteUid],
      profile: DEFAULT_HAND_SPAN_PROFILE,
    });
    expect([
      freedE4.fingerByNoteUid[c4.noteUid],
      freedE4.fingerByNoteUid[d4.noteUid],
      freedE4.fingerByNoteUid[e4.noteUid],
      freedE4.fingerByNoteUid[f4.noteUid],
      freedE4.fingerByNoteUid[g4.noteUid],
    ]).toEqual([1, 2, 3, 4, 5]);
  });

  it("respects anchorExitFinger during localResolveFingering and clears it when raw anchor is overridden or removed", () => {
    const { DOMParser } = new JSDOM("").window;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice>
        <notations><technical><fingering>1-3</fingering></technical></notations>
      </note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const doc = parseMusicXml(xml, { DOMParser });
    const [c4, d4, e4] = doc.noteEvents;
    const initial = solveFingering(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect([
      initial.fingerByNoteUid[c4.noteUid],
      initial.fingerByNoteUid[d4.noteUid],
      initial.fingerByNoteUid[e4.noteUid],
    ]).toEqual([1, 4, 5]);

    // Overriding C4 to 1 (plain phrase anchor) clears anchorExitFinger=3 so D4,E4 become 2,3
    const overridden = localResolveFingering({
      onsetSlices: doc.onsetSlices,
      priorFingerByNoteUid: initial.fingerByNoteUid,
      targetNoteUid: c4.noteUid,
      override: { finger: 1, mode: "phrase" },
      anchors: { [c4.noteUid]: { finger: 1, mode: "phrase" } },
      profile: DEFAULT_HAND_SPAN_PROFILE,
    });
    expect([
      overridden.fingerByNoteUid[c4.noteUid],
      overridden.fingerByNoteUid[d4.noteUid],
      overridden.fingerByNoteUid[e4.noteUid],
    ]).toEqual([1, 2, 3]);
  });

  it("flags anchor-conflict in pinOnly mode on chord/held collisions and handles unknown targetNoteUid gracefully", () => {
    const { DOMParser } = new JSDOM("").window;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>2</voice></note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const doc = parseMusicXml(xml, { DOMParser });
    const initial = solveFingering(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const c4 = doc.noteEvents.find((n) => n.midi === 60)!;
    const g4 = doc.noteEvents.find((n) => n.midi === 67)!;
    const a4 = doc.noteEvents.find((n) => n.midi === 69)!;

    // pinOnly G4 to same finger as sibling E4 -> anchor-conflict
    const chordConflict = localResolveFingering({
      onsetSlices: doc.onsetSlices,
      priorFingerByNoteUid: initial.fingerByNoteUid,
      targetNoteUid: g4.noteUid,
      override: { finger: initial.fingerByNoteUid[doc.noteEvents.find((n) => n.midi === 64)!.noteUid], mode: "pinOnly" },
      anchors: { [g4.noteUid]: { finger: initial.fingerByNoteUid[doc.noteEvents.find((n) => n.midi === 64)!.noteUid], mode: "pinOnly" } },
      profile: DEFAULT_HAND_SPAN_PROFILE,
    });
    expect(chordConflict.warnings.some((w) => w.type === "anchor-conflict")).toBe(true);

    // pinOnly A4 to same finger as held C4 -> anchor-conflict
    const heldConflict = localResolveFingering({
      onsetSlices: doc.onsetSlices,
      priorFingerByNoteUid: initial.fingerByNoteUid,
      targetNoteUid: a4.noteUid,
      override: { finger: initial.fingerByNoteUid[c4.noteUid], mode: "pinOnly" },
      anchors: { [a4.noteUid]: { finger: initial.fingerByNoteUid[c4.noteUid], mode: "pinOnly" } },
      profile: DEFAULT_HAND_SPAN_PROFILE,
    });
    expect(heldConflict.warnings.some((w) => w.type === "anchor-conflict")).toBe(true);

    // Unknown targetNoteUid returns prior fingerings intact
    const unknown = localResolveFingering({
      onsetSlices: doc.onsetSlices,
      priorFingerByNoteUid: initial.fingerByNoteUid,
      targetNoteUid: "non-existent",
      override: { finger: 3, mode: "phrase" },
      anchors: {},
      profile: DEFAULT_HAND_SPAN_PROFILE,
    });
    expect(unknown.fingerByNoteUid).toEqual(initial.fingerByNoteUid);
  });
});
