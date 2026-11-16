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
});
