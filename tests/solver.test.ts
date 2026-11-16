import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { parseMusicXml } from "../src/musicxml/parser";
import { readMxlContainer } from "../src/musicxml/mxl";
import { solveFingering } from "../src/solver/solveFingering";
import { DEFAULT_HAND_SPAN_PROFILE } from "../src/domain/types";

describe("solver seam: solveFingering", () => {
  it("produces valid 1-5 assignments for every pitched note and idiomatic thumb-under 1-2-3-1-2-3-4-5 on C-major ascending scale", () => {
    const xmlText = readFileSync(
      resolve(__dirname, "../test-corpus/01-single-staff-melody.musicxml"),
      "utf-8"
    );
    const { DOMParser } = new JSDOM("").window;
    const scoreDoc = parseMusicXml(xmlText, { DOMParser });

    const result = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    // Every pitched note gets a valid 1-5 finger assignment
    expect(Object.keys(result.fingerByNoteUid)).toHaveLength(18);
    for (const note of scoreDoc.noteEvents) {
      const f = result.fingerByNoteUid[note.noteUid];
      expect(f).toBeGreaterThanOrEqual(1);
      expect(f).toBeLessThanOrEqual(5);
    }

    // Measure 1 C-major ascending scale (C4..C5) uses standard thumb-under fingering
    const m1Fingers = scoreDoc.noteEvents
      .slice(0, 8)
      .map((n) => result.fingerByNoteUid[n.noteUid]);
    expect(m1Fingers).toEqual([1, 2, 3, 1, 2, 3, 4, 5]);

    // Emits thumb-under transition cue in measure 1
    expect(
      result.transitionCues.some(
        (c) => c.measureIndex === 0 && c.type === "thumb-under"
      )
    ).toBe(true);

    // Measure 2 black keys F#4 / Bb4 / F#5 avoid thumb when avoidThumbOnBlack is enabled
    const m2Notes = scoreDoc.noteEvents.slice(8, 13);
    const fSharp4 = m2Notes[3];
    const fSharp5 = m2Notes[4];
    expect(result.fingerByNoteUid[fSharp4.noteUid]).not.toBe(1);
    expect(result.fingerByNoteUid[fSharp5.noteUid]).not.toBe(1);
  });

  it("enforces HeldFinger steal avoidance and combined held+struck span ergonomics across slices", () => {
    const { DOMParser } = new JSDOM("").window;

    // C4 (anchored to finger 1) held across two beats while voice 1 plays E4 then F5 (11th above C4)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>2</duration><voice>2</voice>
        <notations><technical><fingering>1</fingering></technical></notations>
      </note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const doc = parseMusicXml(xml, { DOMParser });
    const result = solveFingering(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    const c4 = doc.noteEvents.find((n) => n.midi === 60)!;
    const e4 = doc.noteEvents.find((n) => n.midi === 64)!;
    const f5 = doc.noteEvents.find((n) => n.midi === 77)!;

    expect(result.fingerByNoteUid[c4.noteUid]).toBe(1);
    expect(result.fingerByNoteUid[e4.noteUid]).toBeGreaterThan(1);
    expect(result.fingerByNoteUid[f5.noteUid]).toBe(5); // best outer reach while 1 is held on C4
    // C4 (1) held + F5 (5) struck = 10 white keys > MAX_SPAN(1,5)=8.3 -> triggers unreachable-span
    expect(result.warnings.some((w) => w.type === "unreachable-span")).toBe(true);
  });

  it("solves two-handed corpus fixtures (02 Alberti/chords, 04 cross-staff/ties/grace, 05 wuchang <= 200ms)", async () => {
    const { DOMParser } = new JSDOM("").window;

    // 1. 02-grand-staff-arpeggio-chord.musicxml
    const xml02 = readFileSync(
      resolve(__dirname, "../test-corpus/02-grand-staff-arpeggio-chord.musicxml"),
      "utf-8"
    );
    const doc02 = parseMusicXml(xml02, { DOMParser });
    const res02 = solveFingering(doc02.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    expect(Object.keys(res02.fingerByNoteUid)).toHaveLength(doc02.noteEvents.length);

    // RH m1 block chord C4-E4-G4 strictly ascending
    const rhChord = doc02.onsetSlices.find((s) => s.hand === "RH" && s.notes.length === 3)!;
    const rhChordFingers = rhChord.notes.map((n) => res02.fingerByNoteUid[n.noteUid]);
    expect(rhChordFingers[0]).toBeLessThan(rhChordFingers[1]);
    expect(rhChordFingers[1]).toBeLessThan(rhChordFingers[2]);

    // LH m1 Alberti bass C3-G3-E3-G3: C3 > G3 and E3 > G3 (no inverted joints)
    const lhM1 = doc02.noteEvents.filter((n) => n.hand === "LH" && n.measureIndex === 0);
    expect(res02.fingerByNoteUid[lhM1[0].noteUid]).toBeGreaterThan(
      res02.fingerByNoteUid[lhM1[1].noteUid]
    ); // C3 > G3
    expect(res02.fingerByNoteUid[lhM1[2].noteUid]).toBeGreaterThan(
      res02.fingerByNoteUid[lhM1[1].noteUid]
    ); // E3 > G3

    // LH m2 block chord C3-E3-G3-C4: mirrored (5 on lowest C3, 1 on highest C4, strictly descending)
    const lhChord = doc02.onsetSlices.find((s) => s.hand === "LH" && s.notes.length === 4)!;
    const lhChordFingers = lhChord.notes.map((n) => res02.fingerByNoteUid[n.noteUid]);
    expect(lhChordFingers[0]).toBe(5);
    expect(lhChordFingers[3]).toBe(1);
    expect(lhChordFingers[0]).toBeGreaterThan(lhChordFingers[1]);
    expect(lhChordFingers[1]).toBeGreaterThan(lhChordFingers[2]);
    expect(lhChordFingers[2]).toBeGreaterThan(lhChordFingers[3]);

    // RH m2 held D4 does not get stolen on A4
    const rhM2D4 = doc02.noteEvents.find(
      (n) => n.hand === "RH" && n.measureIndex === 1 && n.midi === 62
    )!;
    const rhM2A4 = doc02.noteEvents.find(
      (n) => n.hand === "RH" && n.measureIndex === 1 && n.midi === 69
    )!;
    expect(res02.fingerByNoteUid[rhM2A4.noteUid]).not.toBe(
      res02.fingerByNoteUid[rhM2D4.noteUid]
    );

    // 2. 04-tie-cross-staff-compressed.mxl
    const mxl04 = readFileSync(
      resolve(__dirname, "../test-corpus/04-tie-cross-staff-compressed.mxl")
    );
    const { xmlText: xml04 } = await readMxlContainer(mxl04, { DOMParser });
    const doc04 = parseMusicXml(xml04, { DOMParser });
    const res04 = solveFingering(doc04.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    for (const ev of doc04.noteEvents) {
      if (ev.isTieStop) {
        expect(res04.fingerByNoteUid[ev.noteUid]).toBeUndefined();
      } else {
        const f = res04.fingerByNoteUid[ev.noteUid];
        expect(f).toBeGreaterThanOrEqual(1);
        expect(f).toBeLessThanOrEqual(5);
      }
    }
    const grace04 = doc04.noteEvents.find((n) => n.isGrace)!;
    expect(res04.fingerByNoteUid[grace04.noteUid]).toBeDefined();

    // 3. 05-realworld-wuchang.musicxml (73 measures, 1321 <note>, <= 200ms)
    const xml05 = readFileSync(
      resolve(__dirname, "../test-corpus/05-realworld-wuchang.musicxml"),
      "utf-8"
    );
    const doc05 = parseMusicXml(xml05, { DOMParser });
    const res05 = solveFingering(doc05.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    const struck05 = doc05.noteEvents.filter((n) => !n.isTieStop);
    const tied05 = doc05.noteEvents.filter((n) => n.isTieStop);
    expect(Object.keys(res05.fingerByNoteUid)).toHaveLength(struck05.length);
    for (const tied of tied05) {
      expect(res05.fingerByNoteUid[tied.noteUid]).toBeUndefined();
    }
    expect(res05.solveTimeMs).toBeLessThanOrEqual(200);
    expect(res05.handPositions.some((p) => p.hand === "RH")).toBe(true);
    expect(res05.handPositions.some((p) => p.hand === "LH")).toBe(true);
  });

  it("enforces 100% anchor fidelity on 03-partial-fingering-hanon and uses phrase-level lookahead so far-ahead anchors are never pruned by beam search", () => {
    const { DOMParser } = new JSDOM("").window;

    // 1. 03-partial-fingering-hanon.musicxml: 100% anchor fidelity, zero repaired anchors or anchor-conflict
    const xml03 = readFileSync(
      resolve(__dirname, "../test-corpus/03-partial-fingering-hanon.musicxml"),
      "utf-8"
    );
    const doc03 = parseMusicXml(xml03, { DOMParser });
    const res03 = solveFingering(doc03.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    expect(res03.repairedAnchorUids).toEqual([]);
    expect(res03.transitionCues.some((c) => c.type === "anchor-conflict")).toBe(false);
    for (const note of doc03.noteEvents) {
      if (note.anchorFinger !== undefined) {
        expect(res03.fingerByNoteUid[note.noteUid]).toBe(note.anchorFinger);
      } else {
        expect(res03.fingerByNoteUid[note.noteUid]).toBeGreaterThanOrEqual(1);
        expect(res03.fingerByNoteUid[note.noteUid]).toBeLessThanOrEqual(5);
      }
    }

    // 2. Far-ahead FingerAnchor lookahead with held note across 15 intermediate slices:
    // C4 (unanchored, held for 16 sixteenth-note steps) + 15 intervals (F4, A4) / (G4, B4)
    // followed at slice 15 by D4 anchored to finger 1 while C4 is still held.
    // Without lookahead + state dedup, beam=28 fills up with C4=1 paths and steals finger 1 at slice 15.
    const intermediateNotes = Array.from({ length: 15 }, (_, idx) => {
      const low = idx % 2 === 0 ? "F" : "G";
      const high = idx % 2 === 0 ? "A" : "B";
      return `
      <note><pitch><step>${low}</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>${high}</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>`;
    }).join("");

    const farAheadXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>16</duration><voice>2</voice>
      </note>
      <backup><duration>16</duration></backup>
      ${intermediateNotes}
      <note>
        <pitch><step>D</step><octave>4</octave></pitch>
        <duration>1</duration><voice>1</voice>
        <notations><technical><fingering>1</fingering></technical></notations>
      </note>
    </measure>
  </part>
</score-partwise>`;

    const farDoc = parseMusicXml(farAheadXml, { DOMParser });
    const farRes = solveFingering(farDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    const heldC4 = farDoc.noteEvents.find((n) => n.midi === 60)!;
    const anchoredD4 = farDoc.noteEvents.find((n) => n.midi === 62)!;

    expect(farRes.fingerByNoteUid[anchoredD4.noteUid]).toBe(1);
    // C4 must NOT be assigned finger 1 (which would cause a held-finger steal at D4=1)
    expect(farRes.fingerByNoteUid[heldC4.noteUid]).not.toBe(1);
    expect(farRes.repairedAnchorUids).toEqual([]);
  });

  it("detects physical anchor conflicts (duplicate chord finger, ordering inversion, impossible span, held-finger collision) with anchor-conflict cues and minimal repair", () => {
    const { DOMParser } = new JSDOM("").window;

    // 1. Simultaneous duplicate fingers in 3-note chord: C4=1, E4=1, G4=5 -> keeps C4=1 and G4=5, repairs only E4
    const dupChordXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><technical><fingering>1</fingering></technical></notations></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><technical><fingering>1</fingering></technical></notations></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><technical><fingering>5</fingering></technical></notations></note>
    </measure>
  </part>
</score-partwise>`;
    const dupDoc = parseMusicXml(dupChordXml, { DOMParser });
    const dupRes = solveFingering(dupDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const [c4Dup, e4Dup, g4Dup] = dupDoc.noteEvents;
    expect(dupRes.fingerByNoteUid[c4Dup.noteUid]).toBe(1);
    expect(dupRes.fingerByNoteUid[g4Dup.noteUid]).toBe(5);
    expect(dupRes.fingerByNoteUid[e4Dup.noteUid]).toBeGreaterThan(1);
    expect(dupRes.fingerByNoteUid[e4Dup.noteUid]).toBeLessThan(5);
    expect(dupRes.repairedAnchorUids).toEqual([e4Dup.noteUid]);
    expect(dupRes.warnings.some((w) => w.type === "anchor-conflict" && w.severity === "danger")).toBe(true);

    // 2. Ordering inversion in chord: RH C4=3, E4=2
    const invXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><technical><fingering>3</fingering></technical></notations></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><technical><fingering>2</fingering></technical></notations></note>
    </measure>
  </part>
</score-partwise>`;
    const invDoc = parseMusicXml(invXml, { DOMParser });
    const invRes = solveFingering(invDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const [c4Inv, e4Inv] = invDoc.noteEvents;
    expect(invRes.fingerByNoteUid[c4Inv.noteUid]).toBeLessThan(invRes.fingerByNoteUid[e4Inv.noteUid]);
    expect(invRes.repairedAnchorUids.length).toBe(1);
    expect(invRes.warnings.some((w) => w.type === "anchor-conflict" && w.severity === "danger")).toBe(true);

    // 3. Impossible span between anchored chord notes: C4=1, C5=2 (dist 7 > MAX_SPAN(1,2)=5.5) -> repairs to reachable
    //    Whereas C4=1, F5=5 (outer 1-5 on 11th) is unreachable-span, NOT anchor-conflict
    const spanConflictXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><technical><fingering>1</fingering></technical></notations></note>
      <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><notations><technical><fingering>2</fingering></technical></notations></note>
    </measure>
  </part>
</score-partwise>`;
    const spanDoc = parseMusicXml(spanConflictXml, { DOMParser });
    const spanRes = solveFingering(spanDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const [c4Span, c5Span] = spanDoc.noteEvents;
    expect(spanRes.fingerByNoteUid[c4Span.noteUid]).toBe(1);
    expect(spanRes.fingerByNoteUid[c5Span.noteUid]).toBeGreaterThanOrEqual(4);
    expect(spanRes.repairedAnchorUids).toEqual([c5Span.noteUid]);
    expect(spanRes.warnings.some((w) => w.type === "anchor-conflict" && w.severity === "danger")).toBe(true);

    const outerEleventhXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><technical><fingering>1</fingering></technical></notations></note>
      <note><chord/><pitch><step>F</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><notations><technical><fingering>5</fingering></technical></notations></note>
    </measure>
  </part>
</score-partwise>`;
    const eleventhDoc = parseMusicXml(outerEleventhXml, { DOMParser });
    const eleventhRes = solveFingering(eleventhDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(eleventhRes.repairedAnchorUids).toEqual([]);
    expect(eleventhRes.warnings.some((w) => w.type === "anchor-conflict")).toBe(false);
    expect(eleventhRes.warnings.some((w) => w.type === "unreachable-span")).toBe(true);

    // 4. Held-finger anchor conflict across slices: C4 held (anchor=1) while E4 struck (anchor=1)
    const heldConflictXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>2</voice><notations><technical><fingering>1</fingering></technical></notations></note>
      <backup><duration>2</duration></backup>
      <note><rest/><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><technical><fingering>1</fingering></technical></notations></note>
    </measure>
  </part>
</score-partwise>`;
    const heldDoc = parseMusicXml(heldConflictXml, { DOMParser });
    const heldRes = solveFingering(heldDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const c4Held = heldDoc.noteEvents.find((n) => n.midi === 60)!;
    const e4Held = heldDoc.noteEvents.find((n) => n.midi === 64)!;
    expect(heldRes.fingerByNoteUid[c4Held.noteUid]).not.toBe(heldRes.fingerByNoteUid[e4Held.noteUid]);
    expect(heldRes.repairedAnchorUids).toHaveLength(1);
    expect(heldRes.warnings.some((w) => w.type === "anchor-conflict" && w.severity === "danger")).toBe(true);
  });
});
