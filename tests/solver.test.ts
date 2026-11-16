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

  it("parameterizes HandSpanProfile (S/M/L scaling, avoidThumbOnBlack, preferStablePosition) and changes fingering & warnings", () => {
    const { DOMParser } = new JSDOM("").window;

    // 1. Span scaling S (0.82) vs M (1.00) vs L (1.18) on octave (C4-C5) and 10th (C4-E5)
    const spanXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const spanDoc = parseMusicXml(spanXml, { DOMParser });

    const resS = solveFingering(spanDoc.onsetSlices, {
      preset: "S",
      avoidThumbOnBlack: true,
      preferStablePosition: false,
    });
    const resM = solveFingering(spanDoc.onsetSlices, {
      preset: "M",
      avoidThumbOnBlack: true,
      preferStablePosition: false,
    });
    const resL = solveFingering(spanDoc.onsetSlices, {
      preset: "L",
      avoidThumbOnBlack: true,
      preferStablePosition: false,
    });

    // Under S (1-5 max = 6.806), both octave (7.0) and 10th (9.0) emit unreachable-span
    expect(resS.warnings.filter((w) => w.type === "unreachable-span")).toHaveLength(2);
    // Under M (1-5 max = 8.3), octave is playable without warning, 10th (9.0) emits unreachable-span
    expect(resM.warnings.filter((w) => w.type === "unreachable-span")).toHaveLength(1);
    // Under L (1-5 max = 9.794), 10th (9.0 >= 0.85 * 9.794 = 8.325) is wide-stretch, 0 unreachable-span
    expect(resL.warnings.filter((w) => w.type === "unreachable-span")).toHaveLength(0);
    expect(resL.warnings.filter((w) => w.type === "wide-stretch")).toHaveLength(1);

    // 2. avoidThumbOnBlack: F#4 -> G4 -> A4 -> B4 -> C5 -> D5 avoids thumb on F#4 when enabled
    const blackXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const blackDoc = parseMusicXml(blackXml, { DOMParser });
    const resAvoidBlack = solveFingering(blackDoc.onsetSlices, {
      preset: "M",
      avoidThumbOnBlack: true,
      preferStablePosition: false,
    });
    const resAllowBlack = solveFingering(blackDoc.onsetSlices, {
      preset: "M",
      avoidThumbOnBlack: false,
      preferStablePosition: false,
    });
    const fSharpUid = blackDoc.noteEvents[0].noteUid;
    expect(resAvoidBlack.fingerByNoteUid[fSharpUid]).not.toBe(1);
    expect(resAllowBlack.fingerByNoteUid[fSharpUid]).toBe(1);

    // 3. preferStablePosition: keeps 5-finger position on C4-E4-G4-A4-G4-E4-C4 instead of shifting
    const stableXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const stableDoc = parseMusicXml(stableXml, { DOMParser });
    const resMobile = solveFingering(stableDoc.onsetSlices, {
      preset: "M",
      avoidThumbOnBlack: true,
      preferStablePosition: false,
    });
    const resStable = solveFingering(stableDoc.onsetSlices, {
      preset: "M",
      avoidThumbOnBlack: true,
      preferStablePosition: true,
    });
    const stableFingers = stableDoc.noteEvents.map((n) => resStable.fingerByNoteUid[n.noteUid]);
    expect(stableFingers[4]).toBe(5);
    expect(resStable.handPositions.length).toBeLessThanOrEqual(resMobile.handPositions.length);
    // And on wuchang, preferStablePosition measurably changes fingering choices
    const xml05 = readFileSync(
      resolve(__dirname, "../test-corpus/05-realworld-wuchang.musicxml"),
      "utf-8"
    );
    const doc05 = parseMusicXml(xml05, { DOMParser });
    const wuchangMobile = solveFingering(doc05.onsetSlices, {
      preset: "M",
      avoidThumbOnBlack: true,
      preferStablePosition: false,
    });
    const wuchangStable = solveFingering(doc05.onsetSlices, {
      preset: "M",
      avoidThumbOnBlack: true,
      preferStablePosition: true,
    });
    const diffs = doc05.noteEvents.filter(
      (n) => !n.isTieStop && wuchangMobile.fingerByNoteUid[n.noteUid] !== wuchangStable.fingerByNoteUid[n.noteUid]
    );
    expect(diffs.length).toBeGreaterThan(0);
    expect(wuchangStable.handPositions.length).toBeLessThanOrEqual(wuchangMobile.handPositions.length);
  });

  it("handles extreme 6+ note chords (adjacent 2nd double-press vs outer-voice fallback) and extreme over-MAX_SPAN chords", () => {
    const { DOMParser } = new JSDOM("").window;

    // 1. 6-note RH chord with bottom adjacent 2nd (C4-D4-E4-G4-A4-C5): thumb double-press [1,1,2,3,4,5], no unreachable-span
    // 2. 6-note RH chord with top adjacent 2nd (C4-E4-G4-A4-B4-C5): pinky double-press [1,2,3,4,5,5], no unreachable-span
    // 3. 6-note RH chord WITHOUT adjacent 2nds (C4-E4-G4-B4-D5-F5): all notes assigned, outer voices 1 & 5, emits unreachable-span
    // 4. 7-note RH chord (C4-D4-E4-F4-G4-A4-B4): all notes assigned, outer voices 1 & 5, emits unreachable-span
    // 5. Extreme 2-octave RH chord (C3-C5, 14 white keys >> MAX_SPAN): outer voices 1 & 5, emits unreachable-span
    const extremeXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <!-- Chord 1: C4 D4 E4 G4 A4 C5 -->
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <!-- Chord 2: C4 E4 G4 A4 B4 C5 -->
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <!-- Chord 3: C4 E4 G4 B4 D5 F5 -->
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>F</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <!-- Chord 4: C4 D4 E4 F4 G4 A4 B4 -->
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <!-- Chord 5: C3 C5 -->
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const doc = parseMusicXml(extremeXml, { DOMParser });
    const res = solveFingering(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    // Every note must receive a valid 1..5 assignment (no blanks)
    expect(Object.keys(res.fingerByNoteUid)).toHaveLength(doc.noteEvents.length);

    const [s1, s2, s3, s4, s5] = doc.onsetSlices;
    const f1 = s1.notes.map((n) => res.fingerByNoteUid[n.noteUid]);
    const f2 = s2.notes.map((n) => res.fingerByNoteUid[n.noteUid]);
    const f3 = s3.notes.map((n) => res.fingerByNoteUid[n.noteUid]);
    const f4 = s4.notes.map((n) => res.fingerByNoteUid[n.noteUid]);
    const f5 = s5.notes.map((n) => res.fingerByNoteUid[n.noteUid]);

    expect(f1).toEqual([1, 1, 2, 3, 4, 5]);
    expect(f2).toEqual([1, 2, 3, 4, 5, 5]);

    // Chords 3 & 4 assign outer voices 1 & 5 and leave no note blank
    expect(f3[0]).toBe(1);
    expect(f3[f3.length - 1]).toBe(5);
    expect(f4[0]).toBe(1);
    expect(f4[f4.length - 1]).toBe(5);

    // Chord 5 (2 octaves) assigns playable outer 1 & 5
    expect(f5).toEqual([1, 5]);

    // Chords 1 & 2 (valid adjacent-2nd double-press within 1-5 span) do NOT emit unreachable-span
    expect(res.warnings.some((w) => w.sliceId === s1.sliceId && w.type === "unreachable-span")).toBe(false);
    expect(res.warnings.some((w) => w.sliceId === s2.sliceId && w.type === "unreachable-span")).toBe(false);

    // Chords 3, 4, 5 MUST emit unreachable-span (danger)
    expect(res.warnings.some((w) => w.sliceId === s3.sliceId && w.type === "unreachable-span" && w.severity === "danger")).toBe(true);
    expect(res.warnings.some((w) => w.sliceId === s4.sliceId && w.type === "unreachable-span" && w.severity === "danger")).toBe(true);
    expect(res.warnings.some((w) => w.sliceId === s5.sliceId && w.type === "unreachable-span" && w.severity === "danger")).toBe(true);
  });

  it("merges stable HandPosition intervals (<=1 thumbKey drift, no crossing/shift) and classifies all 6 TransitionCue categories with accurate severities", () => {
    const { DOMParser } = new JSDOM("").window;

    // 1. HandPosition merging + thumb-under (info) + cross-over (info)
    // C4-D4-E4-F4-G4 (1-2-3-4-5, all thumbKey=28 -> 1 HandPosition)
    // followed by descending G4-F4-E4-D4-C4-B3-A3 (5-4-3-2-1-3-2 -> cross-over 1->3 on B3 splits HandPosition)
    const posXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>B</step><octave>3</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>A</step><octave>3</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const posDoc = parseMusicXml(posXml, { DOMParser });
    const posRes = solveFingering(posDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    // First 9 slices (C4..G4..C4) merge into 1 stable HandPosition; cross-over on B3 starts second HandPosition
    expect(posRes.handPositions).toHaveLength(2);
    expect(posRes.handPositions[0].startSliceId).toBe(posDoc.onsetSlices[0].sliceId);
    expect(posRes.handPositions[0].endSliceId).toBe(posDoc.onsetSlices[8].sliceId);
    expect(
      posRes.transitionCues.some((c) => c.type === "cross-over" && c.severity === "info")
    ).toBe(true);

    // 2. Normal position-shift (info) vs extreme fast leap (danger) vs wide-stretch (>=85% MAX_SPAN, warn) vs anchor-conflict (danger)
    const cuesXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <direction><sound tempo="120"/></direction>
      <!-- Moderate quarter-note shift: C4 -> F4 (finger 1 -> 1 or 1 -> shift, slow dt=0.5s, rootShift=3 -> info) -->
      <note>
        <pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice>
        <notations><technical><fingering>1</fingering></technical></notations>
      </note>
      <note>
        <pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice>
        <notations><technical><fingering>1</fingering></technical></notations>
      </note>
      <!-- Extreme fast 16th-note leap: F4 -> C6 (11 white keys in 0.125s -> danger position-shift) -->
      <note>
        <pitch><step>C</step><octave>6</octave></pitch><duration>1</duration><voice>1</voice>
      </note>
      <!-- Chord with wide-stretch (E4 + F5 -> 1,5 span 8.0 / 8.3 = 96% -> wide-stretch warn) -->
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>F</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <!-- Chord with anchor-conflict: C4=3, E4=1 (inverted) -->
      <note>
        <pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice>
        <notations><technical><fingering>3</fingering></technical></notations>
      </note>
      <note>
        <chord/>
        <pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice>
        <notations><technical><fingering>1</fingering></technical></notations>
      </note>
    </measure>
  </part>
</score-partwise>`;
    const cuesDoc = parseMusicXml(cuesXml, { DOMParser });
    const cuesRes = solveFingering(cuesDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    expect(
      cuesRes.transitionCues.some(
        (c) => c.sliceId === cuesDoc.onsetSlices[1].sliceId && c.type === "position-shift" && c.severity === "info"
      )
    ).toBe(true);
    expect(
      cuesRes.transitionCues.some(
        (c) => c.sliceId === cuesDoc.onsetSlices[2].sliceId && c.type === "position-shift" && c.severity === "danger"
      )
    ).toBe(true);
    expect(
      cuesRes.transitionCues.some(
        (c) => c.sliceId === cuesDoc.onsetSlices[3].sliceId && c.type === "wide-stretch" && c.severity === "warn"
      )
    ).toBe(true);
    expect(
      cuesRes.transitionCues.some(
        (c) => c.sliceId === cuesDoc.onsetSlices[4].sliceId && c.type === "anchor-conflict" && c.severity === "danger"
      )
    ).toBe(true);
  });

  it("meets <= 200ms performance budget on 05-realworld-wuchang, flags 10ths under S/M, and substantially reduces warnings under L", () => {
    const { DOMParser } = new JSDOM("").window;
    const xml05 = readFileSync(
      resolve(__dirname, "../test-corpus/05-realworld-wuchang.musicxml"),
      "utf-8"
    );
    const doc05 = parseMusicXml(xml05, { DOMParser });

    const resS = solveFingering(doc05.onsetSlices, {
      preset: "S",
      avoidThumbOnBlack: true,
      preferStablePosition: false,
    });
    const resM = solveFingering(doc05.onsetSlices, {
      preset: "M",
      avoidThumbOnBlack: true,
      preferStablePosition: false,
    });
    const resL = solveFingering(doc05.onsetSlices, {
      preset: "L",
      avoidThumbOnBlack: true,
      preferStablePosition: false,
    });

    expect(resS.solveTimeMs).toBeLessThanOrEqual(200);
    expect(resM.solveTimeMs).toBeLessThanOrEqual(200);
    expect(resL.solveTimeMs).toBeLessThanOrEqual(200);

    // 15-16 semitone 10th chords in measures 23, 27, 66, 72 (0-based 22, 26, 65, 71) are flagged under S and M
    for (const measureIdx of [22, 26, 65, 71]) {
      expect(
        resS.warnings.some(
          (w) => w.measureIndex === measureIdx && w.type === "unreachable-span"
        )
      ).toBe(true);
      expect(
        resM.warnings.some(
          (w) => w.measureIndex === measureIdx && w.type === "unreachable-span"
        )
      ).toBe(true);
    }

    const dangerS = resS.warnings.filter((w) => w.severity === "danger").length;
    const dangerM = resM.warnings.filter((w) => w.severity === "danger").length;
    const dangerL = resL.warnings.filter((w) => w.severity === "danger").length;

    expect(dangerS).toBeGreaterThan(dangerM);
    expect(dangerL).toBeLessThan(dangerM);
    expect(resL.warnings.length).toBeLessThan(resM.warnings.length * 0.85);
    expect(resL.warnings.length).toBeLessThan(resS.warnings.length * 0.4);
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
