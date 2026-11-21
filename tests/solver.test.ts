import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { parseMusicXml } from "../src/musicxml/parser";
import { readMxlContainer } from "../src/musicxml/mxl";
import { solveFingering } from "../src/solver/solveFingering";
import {
  IMPOSSIBLE_COST,
  computeHorizontalCost,
  computePairwiseSpanCost,
  computeVerticalCost,
  generateSliceCandidates,
} from "../src/solver/costModel";
import { analyzeHandHeldNotes } from "../src/solver/heldNotes";
import { getSpanScale, toHandFramePos } from "../src/solver/keyboard";
import { evaluateHandKinematics2D } from "../src/solver/handKinematics";
import { DEFAULT_COST_WEIGHTS } from "../src/solver/weights";
import { DEFAULT_HAND_SPAN_PROFILE, type Finger } from "../src/domain/types";
import { perfBudget } from "./perfBudget";

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
    expect(res05.solveTimeMs).toBeLessThanOrEqual(perfBudget(200));
    expect(res05.handPositions.some((p) => p.hand === "RH")).toBe(true);
    expect(res05.handPositions.some((p) => p.hand === "LH")).toBe(true);
  });

  it("parameterizes HandSpanProfile (S/M/L scaling, avoidThumbOnBlack, preferStablePosition) and changes fingering & warnings", () => {
    const { DOMParser } = new JSDOM("").window;

    // 1. Span scaling S (0.82) vs M (1.00) vs L (1.18) with hard pure-octave ceiling (7.0):
    // Octave (C4-C5 = 7.0), minor 9th (C4-Db5 = 7.416), 10th (C4-E5 = 9.0), and inner wide stretch (C4-D4-E4-C5)
    const spanXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>D</step><alter>-1</alter><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
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

    const octaveSliceId = spanDoc.onsetSlices[0].sliceId;
    const min9SliceId = spanDoc.onsetSlices[1].sliceId;
    const tenthSliceId = spanDoc.onsetSlices[2].sliceId;

    // Pure octave (7.0): unreachable under S (1-5 max = 6.806), 0 unreachable-span under M & L
    expect(
      resS.warnings.some((w) => w.sliceId === octaveSliceId && w.type === "unreachable-span")
    ).toBe(true);
    expect(
      resM.warnings.some((w) => w.sliceId === octaveSliceId && w.type === "unreachable-span")
    ).toBe(false);
    expect(
      resL.warnings.some((w) => w.sliceId === octaveSliceId && w.type === "unreachable-span")
    ).toBe(false);

    // Minor 9th (7.416) and 10th (9.0): hard-capped > octave so S / M / L all flag unreachable-span
    for (const res of [resS, resM, resL]) {
      expect(
        res.warnings.some((w) => w.sliceId === min9SliceId && w.type === "unreachable-span")
      ).toBe(true);
      expect(
        res.warnings.some((w) => w.sliceId === tenthSliceId && w.type === "unreachable-span")
      ).toBe(true);
    }

    // Total warning counts strictly decrease as hand preset grows (S >= M >= L)
    expect(resS.warnings.length).toBeGreaterThanOrEqual(resM.warnings.length);
    expect(resM.warnings.length).toBeGreaterThanOrEqual(resL.warnings.length);
    expect(resS.warnings.length).toBeGreaterThan(resL.warnings.length);

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

    // Chords 3 & 4 assign outer voices 1 & 5, distribute inner notes across 2..4 (no [1,2,3,4,5,5,5])
    expect(f3[0]).toBe(1);
    expect(f3[f3.length - 1]).toBe(5);
    expect(f3.slice(1, -1).every((f) => f >= 2 && f <= 4)).toBe(true);
    expect(new Set(f3.slice(1, -1))).toEqual(new Set([2, 3, 4]));

    expect(f4[0]).toBe(1);
    expect(f4[f4.length - 1]).toBe(5);
    expect(f4.slice(1, -1).every((f) => f >= 2 && f <= 4)).toBe(true);
    expect(new Set(f4.slice(1, -1))).toEqual(new Set([2, 3, 4]));

    // Chord 5 (2 octaves) assigns playable outer 1 & 5
    expect(f5).toEqual([1, 5]);

    // Chords 1 & 2 (valid adjacent-2nd double-press within 1-5 span) do NOT emit unreachable-span
    expect(res.warnings.some((w) => w.sliceId === s1.sliceId && w.type === "unreachable-span")).toBe(false);
    expect(res.warnings.some((w) => w.sliceId === s2.sliceId && w.type === "unreachable-span")).toBe(false);

    // Chords 3, 4, 5 MUST emit unreachable-span (danger) with clear arpeggiate / split cue for >5 chords
    expect(
      res.warnings.some(
        (w) =>
          w.sliceId === s3.sliceId &&
          w.type === "unreachable-span" &&
          w.severity === "danger" &&
          /arpeggiate\s*\/\s*split/i.test(w.label)
      )
    ).toBe(true);
    expect(
      res.warnings.some(
        (w) =>
          w.sliceId === s4.sliceId &&
          w.type === "unreachable-span" &&
          w.severity === "danger" &&
          /arpeggiate\s*\/\s*split/i.test(w.label)
      )
    ).toBe(true);
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
      <!-- Chord with wide-stretch within octave (C4 + D4 + C5 -> 2-5 span 6.0 / 6.0 >= 0.85 -> wide-stretch warn) -->
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
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

    expect(resS.solveTimeMs).toBeLessThanOrEqual(perfBudget(200));
    expect(resM.solveTimeMs).toBeLessThanOrEqual(perfBudget(200));
    expect(resL.solveTimeMs).toBeLessThanOrEqual(perfBudget(200));

    // Un-arpeggiated over-octave spans in measures 12, 26, 36, 41 (0-based 11, 25, 35, 40) are flagged across S/M/L
    for (const measureIdx of [11, 25, 35, 40]) {
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
      expect(
        resL.warnings.some(
          (w) => w.measureIndex === measureIdx && w.type === "unreachable-span"
        )
      ).toBe(true);
    }

    // Explicitly arpeggiated 10th chords in measures 23, 27, 66, 72 emit info cues instead of danger warnings
    for (const measureIdx of [22, 26, 65, 71]) {
      expect(
        resM.transitionCues.some(
          (c) =>
            c.measureIndex === measureIdx &&
            c.severity === "info" &&
            /Arpeggiated/i.test(c.label)
        )
      ).toBe(true);
    }

    const dangerS = resS.warnings.filter((w) => w.severity === "danger").length;
    const dangerM = resM.warnings.filter((w) => w.severity === "danger").length;
    const dangerL = resL.warnings.filter((w) => w.severity === "danger").length;

    expect(dangerS).toBeGreaterThan(dangerM);
    expect(dangerL).toBeLessThanOrEqual(dangerM);
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

  it("uses hyphenated anchorExitFinger as the effective departure finger for horizontal transition cost", () => {
    const { DOMParser } = new JSDOM("").window;
    const hyphenXml = `<?xml version="1.0" encoding="UTF-8"?>
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

    const doc = parseMusicXml(hyphenXml, { DOMParser });
    const [c4, d4, e4] = doc.noteEvents;
    expect(c4.anchorFinger).toBe(1);
    expect(c4.anchorExitFinger).toBe(3);

    const res = solveFingering(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    // Entry on C4 is 1, exit is 3 -> stepping up to D4 and E4 takes 4 and 5 rather than 2 and 3
    expect(res.fingerByNoteUid[c4.noteUid]).toBe(1);
    expect(res.fingerByNoteUid[d4.noteUid]).toBe(4);
    expect(res.fingerByNoteUid[e4.noteUid]).toBe(5);

    // Ignoring existing fingerings ignores anchorExitFinger too
    const ignored = solveFingering(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE, {
      ignoreExistingFingerings: true,
    });
    expect([
      ignored.fingerByNoteUid[c4.noteUid],
      ignored.fingerByNoteUid[d4.noteUid],
      ignored.fingerByNoteUid[e4.noteUid],
    ]).toEqual([1, 2, 3]);
  });

  it("uses externalized PIG-calibrated weights.json and enforces IFR 3<->4 awkward crossing guard", () => {
    const { DOMParser } = new JSDOM("").window;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const doc = parseMusicXml(xml, { DOMParser });
    const [s0, s1] = doc.onsetSlices;

    // 4->3 ascending reverse crossing (E4=4 -> F4=3) incurs awkwardCrossingBase + awkward34Extra
    const cost43 = computeHorizontalCost(s0, [4], s1, [3], DEFAULT_HAND_SPAN_PROFILE, false, DEFAULT_COST_WEIGHTS).cost;
    // 5->4 ascending reverse crossing (E4=5 -> F4=4) lacks awkward34Extra
    const cost54 = computeHorizontalCost(s0, [5], s1, [4], DEFAULT_HAND_SPAN_PROFILE, false, DEFAULT_COST_WEIGHTS).cost;
    expect(cost43 - cost54).toBeGreaterThanOrEqual(DEFAULT_COST_WEIGHTS.horizontal.awkward34Extra * 0.9);
    expect(DEFAULT_COST_WEIGHTS.vertical.heldStealPenalty).toBe(400);
  });

  it("uses A* admissible heuristic on unanchored held-note passages to avoid late-slice span traps", () => {
    const { DOMParser } = new JSDOM("").window;
    // Held C4 (unanchored!) sustains across 4 steps while upper voice climbs to C5 (octave above C4).
    // At slice 0, C4=1 is required so upper C5=5 reaches C4..C5 within MAX_SPAN(1,5)=7.0;
    // picking C4=2 would trigger unreachable-span (2-5 max=6.0 < 7.0) at the final slice.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>2</voice></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const doc = parseMusicXml(xml, { DOMParser });
    const res = solveFingering(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const c4 = doc.noteEvents.find((n) => n.midi === 60)!;
    const c5 = doc.noteEvents.find((n) => n.midi === 72)!;

    expect(res.fingerByNoteUid[c4.noteUid]).toBe(1);
    expect(res.fingerByNoteUid[c5.noteUid]).toBe(5);
    expect(res.warnings.some((w) => w.type === "unreachable-span")).toBe(false);
  });

  it("assigns fixed optimal chord fingerings directly without searching over alternative chord shapes", () => {
    const { DOMParser } = new JSDOM("").window;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <!-- Root triad C4-E4-G4 -->
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <!-- 1st inversion E4-G4-C5 -->
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <!-- 4-note octave triad C4-E4-G4-C5 -->
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const doc = parseMusicXml(xml, { DOMParser });
    expect(doc.onsetSlices).toHaveLength(3);

    // Each unanchored block chord yields exactly 1 fixed optimal candidate
    for (const slice of doc.onsetSlices) {
      const { candidates } = generateSliceCandidates(slice, false, DEFAULT_HAND_SPAN_PROFILE);
      expect(candidates).toHaveLength(1);
    }

    const res = solveFingering(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const s0Fingers = doc.onsetSlices[0].notes.map((n) => res.fingerByNoteUid[n.noteUid]);
    const s1Fingers = doc.onsetSlices[1].notes.map((n) => res.fingerByNoteUid[n.noteUid]);
    const s2Fingers = doc.onsetSlices[2].notes.map((n) => res.fingerByNoteUid[n.noteUid]);

    expect(s0Fingers).toEqual([1, 3, 5]);
    expect(s1Fingers).toEqual([1, 2, 5]);
    expect(s2Fingers).toEqual([1, 2, 3, 5]);
  });

  it("forbids anatomically impossible thumb-pinky or wide held-note inversions while keeping short thumb crossings soft", () => {
    const { DOMParser } = new JSDOM("").window;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>G</step><alter>-1</alter><octave>5</octave></pitch><duration>4</duration><tie type="start"/><voice>1</voice><notations><tied type="start"/></notations></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><alter>-1</alter><octave>5</octave></pitch><duration>1</duration><tie type="stop"/><voice>1</voice><notations><tied type="stop"/></notations></note>
      <note><pitch><step>E</step><alter>-1</alter><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>E</step><alter>-1</alter><octave>4</octave></pitch><duration>4</duration><voice>2</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const doc = parseMusicXml(xml, { DOMParser });
    const res = solveFingering(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    const gb5 = doc.noteEvents.find((n) => n.midi === 78 && !n.isTieStop)!;
    const eb4 = doc.noteEvents.find((n) => n.midi === 63)!;
    expect(res.fingerByNoteUid[eb4.noteUid]).toBeLessThan(res.fingerByNoteUid[gb5.noteUid]);

    // Verify short 1-2 held crossing remains soft while 1-5 held inversion hits IMPOSSIBLE_COST
    const eb4Slice = doc.onsetSlices.find((s) => s.notes.some((n) => n.noteUid === eb4.noteUid))!;
    const softCross = computeVerticalCost(
      eb4Slice,
      [2],
      new Map<Finger, number>([[1, 65]]), // F4 held on thumb (1.5 white keys above Eb4)
      DEFAULT_HAND_SPAN_PROFILE
    );
    expect(softCross.cost).toBeLessThan(DEFAULT_COST_WEIGHTS.vertical.overSpanBase);
    expect(softCross.hasUnreachableSpan).toBe(false);

    const impossibleInv = computeVerticalCost(
      eb4Slice,
      [5],
      new Map<Finger, number>([[1, 78]]), // Gb5 held on thumb while pinky plays Eb4
      DEFAULT_HAND_SPAN_PROFILE
    );
    expect(impossibleInv.cost).toBeGreaterThanOrEqual(IMPOSSIBLE_COST);
    expect(impossibleInv.hasUnreachableSpan).toBe(true);
  });

  it("releases unreachable held bass notes during ascending arpeggios (m.19/m.20 pattern) instead of forcing consecutive thumb jumps, and honors <pedal>", () => {
    const { DOMParser } = new JSDOM("").window;

    const buildMeasuresXml = (withPedal: boolean): string => `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="19">
      <attributes>
        <divisions>4</divisions>
        <clef><sign>F</sign><line>4</line></clef>
      </attributes>
      ${withPedal ? '<direction placement="below"><direction-type><pedal type="start" line="yes"/></direction-type></direction>' : ""}
      <note><pitch><step>B</step><alter>-1</alter><octave>2</octave></pitch><duration>16</duration><voice>2</voice></note>
      <backup><duration>16</duration></backup>
      <note><rest/><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>F</step><octave>3</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>B</step><alter>-1</alter><octave>3</octave></pitch><duration>6</duration><voice>1</voice></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>B</step><alter>-1</alter><octave>3</octave></pitch><duration>4</duration><voice>1</voice></note>
      ${withPedal ? '<direction placement="below"><direction-type><pedal type="stop" line="yes"/></direction-type></direction>' : ""}
    </measure>
    <measure number="20">
      ${withPedal ? '<direction placement="below"><direction-type><pedal type="start" line="yes"/></direction-type></direction>' : ""}
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>16</duration><voice>2</voice></note>
      <backup><duration>16</duration></backup>
      <note><rest/><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>6</duration><voice>1</voice></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
      ${withPedal ? '<direction placement="below"><direction-type><pedal type="stop" line="yes"/></direction-type></direction>' : ""}
    </measure>
  </part>
</score-partwise>`;

    // 1. Without <pedal> under profile M: Bb2 and C3 release monotonically when upper arpeggio exceeds span
    const docNoPedal = parseMusicXml(buildMeasuresXml(false), { DOMParser });
    const resNoPedal = solveFingering(docNoPedal.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    const m19Notes = docNoPedal.noteEvents.filter((n) => n.measureIndex === 0);
    const m19Bb2 = m19Notes.find((n) => n.midi === 46)!;
    const m19C4 = m19Notes.find((n) => n.midi === 60)!;
    const m19D4 = m19Notes.find((n) => n.midi === 62)!;
    const m19LastBb3 = m19Notes[m19Notes.length - 1];

    expect(resNoPedal.fingerByNoteUid[m19Bb2.noteUid]).toBe(5);
    expect(resNoPedal.fingerByNoteUid[m19C4.noteUid]).toBeGreaterThan(
      resNoPedal.fingerByNoteUid[m19D4.noteUid]
    ); // No consecutive 1->1 thumb jump on C4->D4

    const m20Notes = docNoPedal.noteEvents.filter((n) => n.measureIndex === 1);
    const m20D4 = m20Notes.find((n) => n.midi === 62)!;
    const m20E4 = m20Notes.find((n) => n.midi === 64)!;
    expect(resNoPedal.fingerByNoteUid[m20D4.noteUid]).toBeGreaterThan(
      resNoPedal.fingerByNoteUid[m20E4.noteUid]
    ); // C3 pre-released at D4 so D4->E4 flows without 9th stretch

    // C4 & D4 slices in m.19 emit unreachable-span with "use pedal" hint, whereas beat-4 Bb3 does not emit a spurious held warning
    const m19C4Slice = docNoPedal.onsetSlices.find((s) => s.notes.some((n) => n.noteUid === m19C4.noteUid))!;
    const m19D4Slice = docNoPedal.onsetSlices.find((s) => s.notes.some((n) => n.noteUid === m19D4.noteUid))!;
    const m19LastSlice = docNoPedal.onsetSlices.find((s) => s.notes.some((n) => n.noteUid === m19LastBb3.noteUid))!;

    expect(
      resNoPedal.warnings.some(
        (w) => w.sliceId === m19C4Slice.sliceId && w.type === "unreachable-span" && /use pedal/i.test(w.label)
      )
    ).toBe(true);
    expect(
      resNoPedal.warnings.some(
        (w) => w.sliceId === m19D4Slice.sliceId && w.type === "unreachable-span" && /use pedal/i.test(w.label)
      )
    ).toBe(true);
    expect(resNoPedal.warnings.some((w) => w.sliceId === m19LastSlice.sliceId)).toBe(false);

    // 2. With <pedal type="start"/>: zero unreachable-span warnings and clean arpeggio fingering
    const docPedal = parseMusicXml(buildMeasuresXml(true), { DOMParser });
    const resPedal = solveFingering(docPedal.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(resPedal.warnings.filter((w) => w.type === "unreachable-span")).toHaveLength(0);

    const m19PedalNotes = docPedal.noteEvents.filter((n) => n.measureIndex === 0);
    const m19PedalC4 = m19PedalNotes.find((n) => n.midi === 60)!;
    const m19PedalD4 = m19PedalNotes.find((n) => n.midi === 62)!;
    expect(resPedal.fingerByNoteUid[m19PedalC4.noteUid]).toBeGreaterThan(
      resPedal.fingerByNoteUid[m19PedalD4.noteUid]
    );
  });

  it("enforces hard octave ceiling across S/M/L on Measure 69 LH model (E2 held + E3 held + Ab3) and fast 5->2 octave transitions", () => {
    const { DOMParser } = new JSDOM("").window;
    const m69Xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="69">
      <attributes><divisions>4</divisions><clef><sign>F</sign><line>4</line></clef></attributes>
      <direction><sound tempo="120"/></direction>
      <note><pitch><step>E</step><octave>2</octave></pitch><duration>8</duration><voice>2</voice></note>
      <backup><duration>8</duration></backup>
      <note><rest/><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>4</duration><voice>1</voice></note>
      <note><pitch><step>A</step><alter>-1</alter><octave>3</octave></pitch><duration>3</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const doc = parseMusicXml(m69Xml, { DOMParser });
    const e2 = doc.noteEvents.find((n) => n.midi === 40)!;
    const e3 = doc.noteEvents.find((n) => n.midi === 52)!;
    const ab3 = doc.noteEvents.find((n) => n.midi === 56)!;
    const ab3Slice = doc.onsetSlices.find((s) => s.notes.some((n) => n.noteUid === ab3.noteUid))!;

    for (const preset of ["S", "M", "L"] as const) {
      const profile = { preset, avoidThumbOnBlack: true, preferStablePosition: false };
      const scale = getSpanScale(profile);

      // 1. Pairwise span > 7.0 (E2 -> Ab3 = 9.5) always incurs >= IMPOSSIBLE_COST
      const pairOverOctave = computePairwiseSpanCost(
        5,
        toHandFramePos(e2.midi, "LH"),
        1,
        toHandFramePos(ab3.midi, "LH"),
        scale,
        1.0,
        preset
      );
      expect(pairOverOctave.hasUnreachableSpan).toBe(true);
      expect(pairOverOctave.cost).toBeGreaterThanOrEqual(IMPOSSIBLE_COST);

      // 2. Vertical cost with forced held E2(5) + E3(2) + struck Ab3(1) incurs >= IMPOSSIBLE_COST
      const forcedHeld = new Map<Finger, number>([
        [5, e2.midi],
        [2, e3.midi],
      ]);
      const vertForced = computeVerticalCost(ab3Slice, [1], forcedHeld, profile);
      expect(vertForced.hasUnreachableSpan).toBe(true);
      expect(vertForced.cost).toBeGreaterThanOrEqual(IMPOSSIBLE_COST);

      // 3. Held-note analyzer releases E2 before/at Ab3 even under L preset
      const heldAnalysis = analyzeHandHeldNotes(doc.onsetSlices, profile);
      const ab3Idx = doc.onsetSlices.findIndex((s) => s.sliceId === ab3Slice.sliceId);
      expect(heldAnalysis.activeHeldBySlice[ab3Idx].some((h) => h.noteUid === e2.noteUid)).toBe(false);

      // 4. Full solve never uses 5->2 to hold E2-E3 octave, and flags unreachable-span on E2 held
      const res = solveFingering(doc.onsetSlices, profile);
      const fE2 = res.fingerByNoteUid[e2.noteUid];
      const fE3 = res.fingerByNoteUid[e3.noteUid];
      expect(!(fE2 === 5 && fE3 === 2)).toBe(true);
      expect(res.warnings.some((w) => w.type === "unreachable-span")).toBe(true);

      // 5. Fast E2(5) -> E3(2) octave transition (absD = 7.0 > 5.5, dt = 0.125s < 0.2s) hits fastOverSpan
      const fastTrans = computeHorizontalCost(
        doc.onsetSlices[0],
        [5],
        doc.onsetSlices[1],
        [2],
        profile
      );
      expect(fastTrans.hasUnreachableSpan).toBe(true);
      expect(fastTrans.cost).toBeGreaterThanOrEqual(DEFAULT_COST_WEIGHTS.horizontal.fastOverSpanBase);
    }
  });

  it("keeps 1,5 on white-key LH octaves before downward leaps while preserving legato 1,4 octaves and slow monophonic scales", () => {
    const { DOMParser } = new JSDOM("").window;

    // 1. Measure 49->50 LH octave leap regression (98 BPM half note and faster < 0.5s quarter note)
    const buildM49Xml = (tempo: number, g2g3Dur: number): string => `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="49">
      <attributes><divisions>2</divisions><clef><sign>F</sign><line>4</line></clef></attributes>
      <direction><sound tempo="${tempo}"/></direction>
      <note><pitch><step>G</step><octave>1</octave></pitch><duration>1</duration><voice>5</voice></note>
      <note><chord/><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><voice>5</voice></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><voice>5</voice></note>
      <note><pitch><step>F</step><octave>3</octave></pitch><duration>1</duration><voice>5</voice></note>
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>1</duration><voice>5</voice></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>${g2g3Dur}</duration><voice>5</voice></note>
      <note><chord/><pitch><step>G</step><octave>3</octave></pitch><duration>${g2g3Dur}</duration><voice>5</voice></note>
    </measure>
    <measure number="50">
      <note><pitch><step>F</step><octave>1</octave></pitch><duration>1</duration><voice>5</voice></note>
      <note><chord/><pitch><step>F</step><octave>2</octave></pitch><duration>1</duration><voice>5</voice></note>
    </measure>
  </part>
</score-partwise>`;

    for (const [tempo, dur] of [
      [98, 4],
      [150, 2],
    ]) {
      const m49Doc = parseMusicXml(buildM49Xml(tempo, dur), { DOMParser });
      const prevG3Slice = m49Doc.onsetSlices[3];
      const g2g3Slice = m49Doc.onsetSlices[4];
      const f1f2Slice = m49Doc.onsetSlices[5];

      for (const preset of ["S", "M", "L"] as const) {
        for (const preferStablePosition of [false, true]) {
          const profile = { preset, avoidThumbOnBlack: true, preferStablePosition };
          const res = solveFingering(m49Doc.onsetSlices, profile);
          expect(g2g3Slice.notes.map((n) => res.fingerByNoteUid[n.noteUid])).toEqual([5, 1]);
        }
      }

      // 2. Direct computeHorizontalCost + computeVerticalCost sanity for M and L
      for (const preset of ["M", "L"] as const) {
        const profile = { preset, avoidThumbOnBlack: true, preferStablePosition: false };
        const emptyHeld = new Map<Finger, number>();
        const vert15 = computeVerticalCost(g2g3Slice, [5, 1], emptyHeld, profile).cost;
        const vert14 = computeVerticalCost(g2g3Slice, [4, 1], emptyHeld, profile).cost;
        const horiz15 = computeHorizontalCost(g2g3Slice, [5, 1], f1f2Slice, [5, 1], profile).cost;
        const horiz14 = computeHorizontalCost(g2g3Slice, [4, 1], f1f2Slice, [5, 1], profile).cost;
        expect(horiz15 - horiz14).toBeLessThan(2.0);

        const local15 =
          computeHorizontalCost(prevG3Slice, [1], g2g3Slice, [5, 1], profile).cost +
          vert15 +
          horiz15;
        const local14 =
          computeHorizontalCost(prevG3Slice, [1], g2g3Slice, [4, 1], profile).cost +
          vert14 +
          horiz14;
        expect(local15).toBeLessThan(local14);

        if (tempo === 98) {
          expect(vert15 + horiz15).toBeLessThan(vert14 + horiz14);
        }
      }
    }

    // 3a. Legato chromatic RH octaves (C4-C5, Db4-Db5, D4-D5, Eb4-Eb5, E4-E5, dt = 0.25s) under L
    const chromXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <direction><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>D</step><alter>-1</alter><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>D</step><alter>-1</alter><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>E</step><alter>-1</alter><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><alter>-1</alter><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const chromDoc = parseMusicXml(chromXml, { DOMParser });
    const chromRes = solveFingering(chromDoc.onsetSlices, {
      preset: "L",
      avoidThumbOnBlack: true,
      preferStablePosition: false,
    });
    expect(
      chromDoc.onsetSlices.map((s) => s.notes.map((n) => chromRes.fingerByNoteUid[n.noteUid]))
    ).toEqual([
      [1, 5],
      [1, 4],
      [1, 5],
      [1, 4],
      [1, 5],
    ]);

    // 3b. Stepwise Romantic LH octaves (Bb2-Bb3, B2-B3, Bb2-Bb3) under M and L
    const romanticXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><clef><sign>F</sign><line>4</line></clef></attributes>
      <direction><sound tempo="110"/></direction>
      <note><pitch><step>B</step><alter>-1</alter><octave>2</octave></pitch><duration>1</duration><voice>5</voice></note>
      <note><chord/><pitch><step>B</step><alter>-1</alter><octave>3</octave></pitch><duration>1</duration><voice>5</voice></note>
      <note><pitch><step>B</step><octave>2</octave></pitch><duration>1</duration><voice>5</voice></note>
      <note><chord/><pitch><step>B</step><octave>3</octave></pitch><duration>1</duration><voice>5</voice></note>
      <note><pitch><step>B</step><alter>-1</alter><octave>2</octave></pitch><duration>1</duration><voice>5</voice></note>
      <note><chord/><pitch><step>B</step><alter>-1</alter><octave>3</octave></pitch><duration>1</duration><voice>5</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const romanticDoc = parseMusicXml(romanticXml, { DOMParser });
    for (const preset of ["M", "L"] as const) {
      const res = solveFingering(romanticDoc.onsetSlices, {
        preset,
        avoidThumbOnBlack: true,
        preferStablePosition: false,
      });
      expect(
        romanticDoc.onsetSlices.map((s) => s.notes.map((n) => res.fingerByNoteUid[n.noteUid]))
      ).toEqual([
        [5, 1],
        [4, 1],
        [5, 1],
      ]);
    }

    // 4. Slow monophonic half-note scale (C4..G4, dt >= 1.0s) preserves 1-2-3-4-5
    const slowScaleXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <direction><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const slowDoc = parseMusicXml(slowScaleXml, { DOMParser });
    const slowRes = solveFingering(slowDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(slowDoc.noteEvents.map((n) => slowRes.fingerByNoteUid[n.noteUid])).toEqual([1, 2, 3, 4, 5]);
  });

  it("forbids non-thumb held-note finger inversions across S/M/L (m.32 held E5 pattern) while preserving short thumb crossings", () => {
    const { DOMParser } = new JSDOM("").window;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="32">
      <attributes><divisions>4</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><tie type="start"/><voice>1</voice><notations><tied type="start"/></notations></note>
      <note><chord/><pitch><step>B</step><octave>5</octave></pitch><duration>1</duration><tie type="start"/><voice>1</voice><notations><tied type="start"/></notations></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><tie type="stop"/><tie type="start"/><voice>1</voice><notations><tied type="stop"/><tied type="start"/></notations></note>
      <note><chord/><pitch><step>B</step><octave>5</octave></pitch><duration>1</duration><tie type="stop"/><tie type="start"/><voice>1</voice><notations><tied type="stop"/><tied type="start"/></notations></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><tie type="stop"/><voice>1</voice><notations><tied type="stop"/></notations></note>
      <note><chord/><pitch><step>B</step><octave>5</octave></pitch><duration>2</duration><tie type="stop"/><voice>1</voice><notations><tied type="stop"/></notations></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>A</step><alter>-1</alter><octave>4</octave></pitch><duration>4</duration><voice>2</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const doc = parseMusicXml(xml, { DOMParser });
    const a4Slice = doc.onsetSlices[1];
    const b4Slice = doc.onsetSlices[2];
    const profileL = { preset: "L" as const, avoidThumbOnBlack: true, preferStablePosition: false };

    // Non-thumb held inversion under L: E5 held on 3 while A4 or B4 uses 5 -> IMPOSSIBLE_COST
    const invA4 = computeVerticalCost(a4Slice, [5], new Map<Finger, number>([[3, 76]]), profileL);
    expect(invA4.cost).toBeGreaterThanOrEqual(IMPOSSIBLE_COST);
    expect(invA4.hasUnreachableSpan).toBe(true);

    const invB4 = computeVerticalCost(b4Slice, [5], new Map<Finger, number>([[3, 76]]), profileL);
    expect(invB4.cost).toBeGreaterThanOrEqual(IMPOSSIBLE_COST);
    expect(invB4.hasUnreachableSpan).toBe(true);

    // Thumb crossing with held non-thumb finger (E4 held on 2 while thumb 1 passes to F4) stays soft
    const thumbUnder = computeVerticalCost(
      b4Slice,
      [1],
      new Map<Finger, number>([[2, 64]]),
      profileL
    );
    expect(thumbUnder.hasUnreachableSpan).toBe(false);
    expect(thumbUnder.cost).toBeLessThan(DEFAULT_COST_WEIGHTS.vertical.overSpanBase);

    for (const preset of ["S", "M", "L"] as const) {
      const res = solveFingering(doc.onsetSlices, {
        preset,
        avoidThumbOnBlack: true,
        preferStablePosition: false,
      });
      const e5 = doc.noteEvents.find((n) => n.midi === 76 && !n.isTieStop)!;
      const a4 = doc.noteEvents.find((n) => n.midi === 69)!;
      const b4Beat2 = b4Slice.notes[0];
      const fE5 = res.fingerByNoteUid[e5.noteUid];
      const e5ReleaseTick = res.earlyReleasesByNoteUid?.[e5.noteUid]?.releaseTick;
      for (const low of [a4, b4Beat2]) {
        const isE5StillHeld = e5ReleaseTick === undefined || e5ReleaseTick > low.onsetTick;
        const fLow = res.fingerByNoteUid[low.noteUid];
        if (isE5StillHeld && fLow > 1 && fE5 > 1) {
          expect(fLow).toBeLessThan(fE5);
        }
      }
    }
  });

  it("rejects static multi-finger crossed chords across S/M/L", () => {
    // Static multi-finger crossed chord: G4=2 held while B4=1 and D5=5 are struck (m.83 pattern)
    const { DOMParser } = new JSDOM("").window;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="83">
      <attributes><divisions>4</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>2</voice></note>
      <backup><duration>2</duration></backup>
      <note><rest/><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const doc = parseMusicXml(xml, { DOMParser });
    const slice2 = doc.onsetSlices[1]; // B4 + D5 with G4 held

    for (const preset of ["S", "M", "L"] as const) {
      const profile = { preset, avoidThumbOnBlack: true, preferStablePosition: false };

      // Static 3-finger crossed posture: G4=2 held, B4=1, D5=5 -> IMPOSSIBLE_COST
      const crossed3 = computeVerticalCost(
        slice2,
        [1, 5],
        new Map<Finger, number>([[2, 67]]),
        profile
      );
      expect(crossed3.cost).toBeGreaterThanOrEqual(IMPOSSIBLE_COST);
      expect(crossed3.hasUnreachableSpan).toBe(true);

      // Legitimate 2-finger transitional thumb crossing: G4=2 held, B4=1 alone -> feasible
      const singleThumbUnder = computeVerticalCost(
        { ...slice2, notes: [slice2.notes[0]] },
        [1],
        new Map<Finger, number>([[2, 67]]),
        profile
      );
      expect(singleThumbUnder.cost).toBeLessThan(IMPOSSIBLE_COST);
      expect(singleThumbUnder.hasUnreachableSpan).toBe(false);
    }

    // 3. 2D reach ceiling & hard 7.0 pure-octave cap via evaluateHandKinematics2D
    const overOctave = evaluateHandKinematics2D(
      [
        { finger: 1, handFramePos: toHandFramePos(60, "RH"), isBlack: false, isHeld: false },
        { finger: 5, handFramePos: toHandFramePos(74, "RH"), isBlack: false, isHeld: false }, // 9th = 8.0 white keys > 7.0
      ],
      1.18 // even L profile is hard-capped at 7.0
    );
    expect(overOctave.feasible).toBe(false);

    // Adjacent 3-4 stretched beyond S-scale 2D Euclidean reach ceiling (while <= 7.0 white keys)
    const over2DReachS = evaluateHandKinematics2D(
      [
        { finger: 3, handFramePos: toHandFramePos(60, "RH"), isBlack: false, isHeld: false },
        { finger: 4, handFramePos: toHandFramePos(71, "RH"), isBlack: false, isHeld: false }, // 6.0 white keys on 3-4 under S
      ],
      0.82
    );
    expect(over2DReachS.feasible).toBe(false);
  });

  it("rejects extreme finger-packing cramps on narrow intervals (m.30 G3+B3 third) across S/M/L", () => {
    const { DOMParser } = new JSDOM("").window;
    // Measure 30 LH pattern: G3+B3 major third (2 white keys) between higher-root chords (B3+E4 / C4+G4)
    // Previously, linear chordCramp (0.4) was outweighed by root-shift preference, collapsing G3+B3 to 5-1.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="30">
      <attributes><divisions>4</divisions><clef><sign>F</sign><line>4</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note>
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice></note>
      <note><chord/><pitch><step>B</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const doc = parseMusicXml(xml, { DOMParser });
    const g3 = doc.noteEvents.find((n) => n.midi === 55)!;
    const b3 = doc.noteEvents.find((n) => n.midi === 59)!;

    for (const preset of ["S", "M", "L"] as const) {
      const profile = { preset, avoidThumbOnBlack: true, preferStablePosition: false };
      const scale = preset === "S" ? 0.82 : preset === "L" ? 1.18 : 1.0;

      // 2D crowding repulsion must steeply penalize 5-1 on G3+B3 compared to 3-1 / 4-2
      const kin51 = evaluateHandKinematics2D(
        [
          { finger: 5, handFramePos: toHandFramePos(55, "LH"), isBlack: false, isHeld: false },
          { finger: 1, handFramePos: toHandFramePos(59, "LH"), isBlack: false, isHeld: false },
        ],
        scale
      );
      const kin31 = evaluateHandKinematics2D(
        [
          { finger: 3, handFramePos: toHandFramePos(55, "LH"), isBlack: false, isHeld: false },
          { finger: 1, handFramePos: toHandFramePos(59, "LH"), isBlack: false, isHeld: false },
        ],
        scale
      );
      expect(kin51.comfortEnergy - kin31.comfortEnergy).toBeGreaterThan(5.0);

      // Vertical cost must penalize cramped 5-1 enough to outweigh horizontal root-shift pulls
      const g3b3Slice = doc.onsetSlices[1];
      const vc51 = computeVerticalCost(g3b3Slice, [5, 1], new Map(), profile);
      const vc31 = computeVerticalCost(g3b3Slice, [3, 1], new Map(), profile);
      const vc42 = computeVerticalCost(g3b3Slice, [4, 2], new Map(), profile);
      expect(vc51.cost - vc31.cost).toBeGreaterThan(5.0);
      expect(vc51.cost - vc42.cost).toBeGreaterThan(4.0);

      const res = solveFingering(doc.onsetSlices, profile);
      const fG3 = res.fingerByNoteUid[g3.noteUid];
      const fB3 = res.fingerByNoteUid[b3.noteUid];
      // Must NOT collapse into cramped 5-1; should select natural third fingering (e.g. 3-1 or 4-2)
      expect([fG3, fB3]).not.toEqual([5, 1]);
      expect(fG3 - fB3).toBeLessThanOrEqual(3);
      expect(fG3).toBeGreaterThan(fB3);
    }
  });

  it("recognizes short rolls (< 80 ms) and resolves Measure 83 (D4+G4 -> 39 ms -> B4+D5) across S/M/L without static 2-1-5 crossings, exporting earlyReleasesByNoteUid", () => {
    const { DOMParser } = new JSDOM("").window;
    // Measure 83 pattern: D4+G4 (held quarter) followed 39 ms later (32nd at 192 BPM) by B4+D5
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="83">
      <attributes>
        <divisions>8</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction><sound tempo="192"/></direction>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>8</duration><voice>2</voice></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>8</duration><voice>2</voice></note>
      <backup><duration>8</duration></backup>
      <note><rest/><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>7</duration><voice>1</voice></note>
      <note><chord/><pitch><step>D</step><octave>5</octave></pitch><duration>7</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const doc = parseMusicXml(xml, { DOMParser });
    expect(doc.onsetSlices.length).toBe(2);
    const dtMs = (doc.onsetSlices[1].onsetSec - doc.onsetSlices[0].onsetSec) * 1000;
    expect(dtMs).toBeGreaterThan(35);
    expect(dtMs).toBeLessThan(45);

    const d4 = doc.noteEvents.find((n) => n.midi === 62)!;
    const g4 = doc.noteEvents.find((n) => n.midi === 67)!;
    const b4 = doc.noteEvents.find((n) => n.midi === 71)!;
    const d5 = doc.noteEvents.find((n) => n.midi === 74)!;

    for (const preset of ["S", "M", "L"] as const) {
      const profile = { preset, avoidThumbOnBlack: true, preferStablePosition: false };
      const res = solveFingering(doc.onsetSlices, profile);

      const fD4 = res.fingerByNoteUid[d4.noteUid];
      const fG4 = res.fingerByNoteUid[g4.noteUid];
      const fB4 = res.fingerByNoteUid[b4.noteUid];
      const fD5 = res.fingerByNoteUid[d5.noteUid];

      // Must never form static 3-finger crossed posture G4=2, B4=1, D5=5
      expect([fG4, fB4, fD5]).not.toEqual([2, 1, 5]);
      // B4 and D5 must be ordered monotonically
      expect(fD5).toBeGreaterThan(fB4);
      // D4+G4 must be ordered monotonically
      expect(fG4).toBeGreaterThan(fD4);

      // Pure-JSON earlyReleasesByNoteUid must be present and serializable
      expect(res.earlyReleasesByNoteUid).toBeDefined();
      const roundTripped = JSON.parse(JSON.stringify(res.earlyReleasesByNoteUid));
      expect(roundTripped).toEqual(res.earlyReleasesByNoteUid);

      // Under S profile (D5 - D4 = 7.0 > 6.806), D4 must be released by slice 2
      if (preset === "S") {
        expect(res.earlyReleasesByNoteUid![d4.noteUid]).toBeDefined();
        expect(res.earlyReleasesByNoteUid![d4.noteUid].releaseSec).toBeCloseTo(
          doc.onsetSlices[1].onsetSec,
          4
        );
      }
    }
  });

  const STEP_NAMES: Array<{ step: string; alter?: number }> = [
    { step: "C" },
    { step: "D", alter: -1 },
    { step: "D" },
    { step: "E", alter: -1 },
    { step: "E" },
    { step: "F" },
    { step: "F", alter: 1 },
    { step: "G" },
    { step: "A", alter: -1 },
    { step: "A" },
    { step: "B", alter: -1 },
    { step: "B" },
  ];

  const solveSyntheticNotes = (
    midis: number[],
    hand: "RH" | "LH",
    asChord: boolean,
    dur = 1,
    tempo = 120
  ): Finger[] => {
    const { DOMParser } = new JSDOM("").window;
    const clef =
      hand === "RH"
        ? `<clef><sign>G</sign><line>2</line></clef>`
        : `<clef><sign>F</sign><line>4</line></clef>`;
    const voice = hand === "RH" ? 1 : 5;
    const notesXml = midis
      .map((midi, idx) => {
        const oct = Math.floor(midi / 12) - 1;
        const { step, alter } = STEP_NAMES[((midi % 12) + 12) % 12];
        const alterTag = alter !== undefined ? `<alter>${alter}</alter>` : "";
        const chordTag = asChord && idx > 0 ? "<chord/>" : "";
        return `<note>${chordTag}<pitch><step>${step}</step>${alterTag}<octave>${oct}</octave></pitch><duration>${dur}</duration><voice>${voice}</voice></note>`;
      })
      .join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions>${clef}</attributes>
      <direction><sound tempo="${tempo}"/></direction>
      ${notesXml}
    </measure>
  </part>
</score-partwise>`;
    const doc = parseMusicXml(xml, { DOMParser });
    const res = solveFingering(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    return asChord
      ? doc.onsetSlices[0].notes.map((n) => res.fingerByNoteUid[n.noteUid])
      : doc.noteEvents.map((n) => res.fingerByNoteUid[n.noteUid]);
  };

  it("solves 12-key major/minor triads (root, 1st, 2nd inv) and 4-note octave/7th chords with idiomatic outer frames and voicing geometry", () => {
    const solveChord = (midis: number[], hand: "RH" | "LH"): Finger[] =>
      solveSyntheticNotes(midis, hand, true, 4);

    // 1. All 12 major and minor triads (root, 1st inv, 2nd inv) for RH & LH
    for (let pc = 0; pc < 12; pc++) {
      const rhRoot = 60 + pc; // C4..B4
      const lhRoot = 48 + pc; // C3..B3

      for (const third of [4, 3]) {
        // Root position: RH [1, 3, 5], LH [5, 3, 1]
        expect({ pc, third, f: solveChord([rhRoot, rhRoot + third, rhRoot + 7], "RH") }).toEqual({
          pc,
          third,
          f: [1, 3, 5],
        });
        expect({ pc, third, f: solveChord([lhRoot, lhRoot + third, lhRoot + 7], "LH") }).toEqual({
          pc,
          third,
          f: [5, 3, 1],
        });

        // 1st inversion: RH [1, 2, 5], LH [5, 3, 1] (or [5, 2, 1] when bottom is black & upper two are white)
        expect({ pc, third, f: solveChord([rhRoot + third, rhRoot + 7, rhRoot + 12], "RH") }).toEqual({
          pc,
          third,
          f: [1, 2, 5],
        });
        const lh1st = solveChord([lhRoot + third, lhRoot + 7, lhRoot + 12], "LH");
        expect([[5, 3, 1], [5, 2, 1]]).toContainEqual(lh1st);

        // 2nd inversion: RH [1, 3, 5], LH [5, 2, 1]
        expect({ pc, third, f: solveChord([rhRoot + 7, rhRoot + 12, rhRoot + 12 + third], "RH") }).toEqual({
          pc,
          third,
          f: [1, 3, 5],
        });
        expect({ pc, third, f: solveChord([lhRoot + 7, lhRoot + 12, lhRoot + 12 + third], "LH") }).toEqual({
          pc,
          third,
          f: [5, 2, 1],
        });
      }
    }

    // 2. 4-note octave triads (root, 1st inv, 2nd inv) & dominant 7th chords
    expect(solveChord([60, 64, 67, 72], "RH")).toEqual([1, 2, 3, 5]);
    expect(solveChord([64, 67, 72, 76], "RH")).toEqual([1, 2, 4, 5]);
    expect(solveChord([67, 72, 76, 79], "RH")).toEqual([1, 2, 4, 5]);
    expect([[5, 3, 2, 1], [5, 4, 2, 1]]).toContainEqual(solveChord([48, 52, 55, 60], "LH"));
    expect(solveChord([52, 55, 60, 64], "LH")).toEqual([5, 4, 2, 1]);
    expect(solveChord([55, 60, 64, 67], "LH")).toEqual([5, 3, 2, 1]);

    // Db major 2nd inv with black 2nd note (Ab4-Db5-F5-Ab5)
    expect([[1, 2, 4, 5], [1, 3, 4, 5]]).toContainEqual(solveChord([68, 73, 77, 80], "RH"));
    // Ab major root octave LH (black-key voicing prefers [5, 3, 2, 1])
    expect(solveChord([44, 48, 51, 56], "LH")).toEqual([5, 3, 2, 1]);

    // Dominant 7th root position (G7: G-B-D-F, C7: C-E-G-Bb) keeps 1..5 outer frame
    const g7Rh = solveChord([67, 71, 74, 77], "RH");
    expect([g7Rh[0], g7Rh[3]]).toEqual([1, 5]);
    const c7Rh = solveChord([60, 64, 67, 70], "RH");
    expect([c7Rh[0], c7Rh[3]]).toEqual([1, 5]);
    const c7Lh = solveChord([48, 52, 55, 58], "LH");
    expect([c7Lh[0], c7Lh[3]]).toEqual([5, 1]);
  });

  it("retains Top-3 candidates for block chords with active held notes so outer voices yield without stealing held fingers", () => {
    const { DOMParser } = new JSDOM("").window;

    // 1. Held thumb A3 (1) while striking C4-E4-G4 -> switches from [1, 3, 5] to [2, 3, 5]
    const heldThumbXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>A</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice></note>
      <backup><duration>2</duration></backup>
      <note><rest/><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const thumbDoc = parseMusicXml(heldThumbXml, { DOMParser });
    const thumbChordSlice = thumbDoc.onsetSlices[1];
    expect(thumbChordSlice.heldNotes).toHaveLength(1);
    const { candidates: thumbCands } = generateSliceCandidates(
      thumbChordSlice,
      false,
      DEFAULT_HAND_SPAN_PROFILE
    );
    expect(thumbCands).toHaveLength(3);

    const thumbRes = solveFingering(thumbDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const a3 = thumbDoc.noteEvents.find((n) => n.midi === 57)!;
    expect(thumbRes.fingerByNoteUid[a3.noteUid]).toBe(1);
    expect(thumbChordSlice.notes.map((n) => thumbRes.fingerByNoteUid[n.noteUid])).toEqual([2, 3, 5]);
    expect(thumbRes.earlyReleasesByNoteUid?.[a3.noteUid]).toBeUndefined();

    // 2. Held pinky B4 (5) while striking C4-E4-G4 -> switches to pinky-free shape ([1, 2, 4] or [1, 3, 4])
    const heldPinkyXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note>
        <pitch><step>B</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice>
        <notations><technical><fingering>5</fingering></technical></notations>
      </note>
      <backup><duration>2</duration></backup>
      <note><rest/><duration>1</duration><voice>2</voice></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const pinkyDoc = parseMusicXml(heldPinkyXml, { DOMParser });
    const pinkyChordSlice = pinkyDoc.onsetSlices[1];
    expect(pinkyChordSlice.heldNotes).toHaveLength(1);
    const { candidates: pinkyCands } = generateSliceCandidates(
      pinkyChordSlice,
      false,
      DEFAULT_HAND_SPAN_PROFILE
    );
    expect(pinkyCands).toHaveLength(3);

    const pinkyRes = solveFingering(pinkyDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const b4 = pinkyDoc.noteEvents.find((n) => n.midi === 71)!;
    const pinkyChordFingers = pinkyChordSlice.notes.map((n) => pinkyRes.fingerByNoteUid[n.noteUid]);
    expect(pinkyRes.fingerByNoteUid[b4.noteUid]).toBe(5);
    expect(pinkyChordFingers).not.toContain(5);
    expect([[1, 2, 4], [1, 3, 4]]).toContainEqual(pinkyChordFingers);
    expect(pinkyRes.earlyReleasesByNoteUid?.[b4.noteUid]).toBeUndefined();
  });

  it("solves 12-key major scales with 3+4 periodic crossings and black-key arpeggios with thumb-on-white anchors", () => {
    const MAJOR_INTERVALS = [0, 2, 4, 5, 7, 9, 11, 12];
    const solveMonophonicLine = (
      midis: number[],
      hand: "RH" | "LH",
      dur = 1,
      tempo = 120
    ): Finger[] => solveSyntheticNotes(midis, hand, false, dur, tempo);

    // 1. White-key starting scales: C, G, D, A, E major (plus B major RH)
    for (const root of [60, 67, 62, 69, 64]) {
      const rhScale = MAJOR_INTERVALS.map((iv) => root + iv);
      const lhScale = MAJOR_INTERVALS.map((iv) => root - 12 + iv);
      expect(solveMonophonicLine(rhScale, "RH")).toEqual([1, 2, 3, 1, 2, 3, 4, 5]);
      expect(solveMonophonicLine(lhScale, "LH")).toEqual([5, 4, 3, 2, 1, 3, 2, 1]);
    }
    expect(solveMonophonicLine(MAJOR_INTERVALS.map((iv) => 71 + iv), "RH")).toEqual([
      1, 2, 3, 1, 2, 3, 4, 5,
    ]);
    // B major LH lands thumb cleanly on white E4 and B4 ([4, 3, 2, 1, 4, 3, 2, 1])
    const bLh = solveMonophonicLine(MAJOR_INTERVALS.map((iv) => 59 + iv), "LH");
    expect(bLh[3]).toBe(1);
    expect(bLh[7]).toBe(1);
    expect(bLh).toEqual([4, 3, 2, 1, 4, 3, 2, 1]);

    // 2. F major (1-2-3-4-1-2-3-4 in RH, 5-4-3-2-1-3-2-1 in LH)
    const fRh = MAJOR_INTERVALS.map((iv) => 65 + iv);
    const fLh = MAJOR_INTERVALS.map((iv) => 53 + iv);
    expect(solveMonophonicLine(fRh, "RH")).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
    expect(solveMonophonicLine(fLh, "LH")).toEqual([5, 4, 3, 2, 1, 3, 2, 1]);

    // 3. Db & F# major RH/LH (no 5->5 slide, thumb strictly on white keys)
    const dbRh = MAJOR_INTERVALS.map((iv) => 61 + iv);
    expect(solveMonophonicLine(dbRh, "RH", 1, 120)).toEqual([2, 3, 1, 2, 3, 4, 1, 2]);
    expect(solveMonophonicLine(dbRh, "RH", 2, 120)).toEqual([2, 3, 1, 2, 3, 4, 1, 2]);
    const dbLh = solveMonophonicLine(MAJOR_INTERVALS.map((iv) => 49 + iv), "LH");
    expect(dbLh[2]).toBe(1);
    expect(dbLh[6]).toBe(1);
    const fsRh = solveMonophonicLine(MAJOR_INTERVALS.map((iv) => 66 + iv), "RH");
    expect([
      [2, 3, 4, 1, 2, 3, 4, 5],
      [2, 3, 4, 1, 2, 3, 1, 2],
    ]).toContainEqual(fsRh);

    // 4. Eb, Ab, Bb major LH use 3+4 period [3, 2, 1, 4, 3, 2, 1, 3] (1->4 crossing onto black key)
    for (const root of [51, 56, 58]) {
      const lhScale = MAJOR_INTERVALS.map((iv) => root + iv);
      expect(solveMonophonicLine(lhScale, "LH")).toEqual([3, 2, 1, 4, 3, 2, 1, 3]);
    }

    // 5. Eb, Ab, Bb major RH place thumb strictly on white scale degrees (never on black keys)
    const ebRh = solveMonophonicLine(MAJOR_INTERVALS.map((iv) => 63 + iv), "RH");
    expect(ebRh[1] === 1 || ebRh[2] === 1).toBe(true);
    expect(ebRh[5]).toBe(1);
    expect(ebRh[0]).not.toBe(1);
    expect(ebRh[3]).not.toBe(1);
    expect(ebRh[4]).not.toBe(1);
    expect(ebRh[7]).not.toBe(1);
    const abRh = solveMonophonicLine(MAJOR_INTERVALS.map((iv) => 68 + iv), "RH");
    expect(abRh[2]).toBe(1);
    expect(abRh[5]).toBe(1);
    const bbRhFingers = solveMonophonicLine(MAJOR_INTERVALS.map((iv) => 70 + iv), "RH");
    expect([
      [2, 1, 2, 3, 1, 2, 3, 4],
      [3, 1, 2, 3, 1, 2, 3, 4],
      [4, 1, 2, 3, 1, 2, 3, 4],
    ]).toContainEqual(bbRhFingers);

    // 6. Black-key broken chord / long arpeggio (Eb4-G4-Bb4-Eb5 & 2-octave) anchors thumb on white G4 / G5
    expect([[2, 1, 2, 4], [2, 1, 2, 5]]).toContainEqual(
      solveMonophonicLine([63, 67, 70, 75], "RH")
    );
    const ebArp2Oct = solveMonophonicLine([63, 67, 70, 75, 79, 82, 87], "RH");
    expect(ebArp2Oct[1]).toBe(1);
    expect(ebArp2Oct[4]).toBe(1);
    expect(ebArp2Oct.slice(0, 5)).toEqual([2, 1, 2, 4, 1]);
  });
});
