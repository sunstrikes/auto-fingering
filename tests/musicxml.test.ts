import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { readMxlContainer } from "../src/musicxml/mxl";
import { parseMusicXml } from "../src/musicxml/parser";
import { writeFingeringsToScore, serializeScoreDocument } from "../src/musicxml/writer";

function createJsdomDom(): { DOMParser: typeof DOMParser; XMLSerializer: typeof XMLSerializer } {
  const dom = new JSDOM("");
  return {
    DOMParser: dom.window.DOMParser,
    XMLSerializer: dom.window.XMLSerializer,
  };
}

describe("musicxml pipeline seam: parseMusicXml", () => {
  it("parses test-corpus/01-single-staff-melody.musicxml into ScoreDocument with NoteEvents and OnsetSlices", () => {
    const xmlText = readFileSync(
      resolve(__dirname, "../test-corpus/01-single-staff-melody.musicxml"),
      "utf-8"
    );
    const { DOMParser } = createJsdomDom();

    const doc = parseMusicXml(xmlText, { DOMParser });

    expect(doc.xmlDeclaration).toBe('<?xml version="1.0" encoding="UTF-8"?>');
    expect(doc.measureCount).toBe(4);
    expect(doc.noteEvents).toHaveLength(18);
    expect(doc.onsetSlices).toHaveLength(18);

    // Measure 1: C4..C5 ascending eighth notes
    const m1Midis = doc.noteEvents.slice(0, 8).map((n) => n.midi);
    expect(m1Midis).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
    expect(doc.noteEvents.every((n) => n.hand === "RH")).toBe(true);

    // Measure 2: C5, Bb4, A4, F#4, F#5
    const m2Midis = doc.noteEvents.slice(8, 13).map((n) => n.midi);
    expect(m2Midis).toEqual([72, 70, 69, 66, 78]);

    // Measure 3 has a short quarter rest (0.6s < 1.5s, < 1 measure), so phraseId stays continuous
    const m1Phrase = doc.onsetSlices[0].phraseId;
    const m3FirstNoteSlice = doc.onsetSlices[13];
    expect(m3FirstNoteSlice.measureIndex).toBe(2);
    expect(m3FirstNoteSlice.notes[0].midi).toBe(79); // G5
    expect(m3FirstNoteSlice.phraseId).toBe(m1Phrase);
  });

  it("splits phrases only on whole-measure+ rests, repeat/ending barlines, or >=1.5s un-held gaps (not short sub-measure rests)", () => {
    const { DOMParser } = createJsdomDom();
    // Fast tempo (240 BPM = 0.25s/quarter) so 2/4 measure = 0.5s (< 1.5s), isolating whole-measure rest vs sub-measure rest
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <time><beats>2</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction><sound tempo="240"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><rest/><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
    <measure number="2">
      <note><rest measure="yes"/><duration>4</duration><voice>1</voice></note>
    </measure>
    <measure number="3">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
    </measure>
    <measure number="4">
      <note><rest/><duration>4</duration><voice>1</voice></note>
    </measure>
    <measure number="5">
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
    </measure>
    <measure number="6">
      <direction><sound tempo="60"/></direction>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><rest/><duration>2</duration><voice>1</voice></note>
    </measure>
    <measure number="7">
      <note><rest/><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const doc = parseMusicXml(xml, { DOMParser });
    const phrases = doc.onsetSlices.map((s) => s.phraseId);
    // C4 (0), after 1/8 rest (0.125s) D4 (0), after <rest measure="yes"/> (0.5s) E4 (1),
    // after full-measure duration rest (0.5s) F4 (2), G4 (2), after 2.0s un-held gap across barline A4 (3)
    expect(phrases).toEqual([0, 0, 1, 2, 2, 3]);
  });

  it("writes <notations><technical><fingering placement='above'> in XSD order without xmlns='', preserves header/DOCTYPE, and reloads cleanly", () => {
    const xmlText = readFileSync(
      resolve(__dirname, "../test-corpus/01-single-staff-melody.musicxml"),
      "utf-8"
    );
    const { DOMParser, XMLSerializer } = createJsdomDom();
    const doc = parseMusicXml(xmlText, { DOMParser });

    // Add a <lyric> to the first note and an existing <notations><slur/></notations> to the second note
    // to verify strict XSD insertion order and non-destructive <notations> update.
    const firstNoteEl = doc.noteElementsByUid.get(doc.noteEvents[0].noteUid)!;
    const lyricEl = doc.xmlDoc.createElementNS(doc.xmlDoc.documentElement.namespaceURI, "lyric");
    lyricEl.textContent = "la";
    firstNoteEl.appendChild(lyricEl);

    const secondNoteEl = doc.noteElementsByUid.get(doc.noteEvents[1].noteUid)!;
    const existingNotations = doc.xmlDoc.createElementNS(doc.xmlDoc.documentElement.namespaceURI, "notations");
    const slurEl = doc.xmlDoc.createElementNS(doc.xmlDoc.documentElement.namespaceURI, "slur");
    slurEl.setAttribute("type", "start");
    existingNotations.appendChild(slurEl);
    secondNoteEl.appendChild(existingNotations);

    const fingerByNoteUid: Record<string, 1 | 2 | 3 | 4 | 5> = {};
    doc.noteEvents.forEach((n, idx) => {
      fingerByNoteUid[n.noteUid] = ((idx % 5) + 1) as 1 | 2 | 3 | 4 | 5;
    });

    writeFingeringsToScore(doc, fingerByNoteUid);
    const exportedXml = serializeScoreDocument(doc, { XMLSerializer });

    expect(exportedXml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(exportedXml).toContain(
      '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">'
    );
    expect(exportedXml).not.toContain('xmlns=""');

    // Verify first note has <notations> BEFORE <lyric>
    const firstNoteChildren = Array.from(firstNoteEl.children).map((c) => c.localName);
    expect(firstNoteChildren.indexOf("notations")).toBeGreaterThan(-1);
    expect(firstNoteChildren.indexOf("notations")).toBeLessThan(firstNoteChildren.indexOf("lyric"));

    // Verify second note retained <slur> inside <notations> alongside <technical><fingering>
    const secondNotations = secondNoteEl.querySelector("notations");
    expect(secondNotations?.querySelector("slur")?.getAttribute("type")).toBe("start");
    const secondFingering = secondNotations?.querySelector("technical > fingering");
    expect(secondFingering?.textContent).toBe("2");
    expect(secondFingering?.getAttribute("placement")).toBe("above");

    // Reload cleanly via parseMusicXml
    const reloaded = parseMusicXml(exportedXml, { DOMParser });
    expect(reloaded.noteEvents).toHaveLength(18);
    expect(reloaded.noteEvents[0].anchorFinger).toBe(1);
    expect(reloaded.noteEvents[1].anchorFinger).toBe(2);
  });

  it("rejects <score-timewise> and > 2 total staves (3-staff part, 3 parts, or implicit <staff>3</staff>) with descriptive errors", () => {
    const { DOMParser } = createJsdomDom();

    const timewiseXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-timewise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><measure number="1"><part id="P1"/></measure></score-timewise>`;
    expect(() => parseMusicXml(timewiseXml, { DOMParser })).toThrow(/score-timewise|score-partwise/i);

    const threeStavesAttrXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Organ</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><attributes><divisions>1</divisions><staves>3</staves></attributes></measure></part>
</score-partwise>`;
    expect(() => parseMusicXml(threeStavesAttrXml, { DOMParser })).toThrow(/3.*staves|maximum 2 staves/i);

    const threePartsXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>A</part-name></score-part>
    <score-part id="P2"><part-name>B</part-name></score-part>
    <score-part id="P3"><part-name>C</part-name></score-part>
  </part-list>
  <part id="P1"><measure number="1"/></part>
  <part id="P2"><measure number="1"/></part>
  <part id="P3"><measure number="1"/></part>
</score-partwise>`;
    expect(() => parseMusicXml(threePartsXml, { DOMParser })).toThrow(/3.*staves|maximum 2 staves/i);

    const implicitThirdStaffXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><staff>3</staff></note></measure></part>
</score-partwise>`;
    expect(() => parseMusicXml(implicitThirdStaffXml, { DOMParser })).toThrow(/3.*staves|maximum 2 staves/i);
  });

  it("normalizes <divisions> changes, <forward>, dual-part <sound tempo>, linear repeat order, and <repeat>/<ending>/rest phrase boundaries", () => {
    const { DOMParser } = createJsdomDom();
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>RH</part-name></score-part>
    <score-part id="P2"><part-name>LH</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice></note>
      <forward><duration>2</duration></forward>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice></note>
      <barline location="right"><repeat direction="backward"/></barline>
    </measure>
    <measure number="2">
      <attributes><divisions>3</divisions></attributes>
      <barline location="left"><ending type="start" number="1"/></barline>
      <direction><sound tempo="60"/></direction>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>3</duration><voice>1</voice></note>
      <note><rest/><duration>6</duration><voice>1</voice></note>
      <barline location="right"><ending type="stop" number="1"/></barline>
    </measure>
    <measure number="3">
      <barline location="left"><ending type="start" number="2"/></barline>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>3</duration><voice>1</voice></note>
      <barline location="right"><ending type="discontinue" number="2"/></barline>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <clef><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>6</duration><voice>1</voice></note>
      <barline location="right"><repeat direction="backward"/></barline>
    </measure>
    <measure number="2">
      <attributes><divisions>3</divisions></attributes>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>9</duration><voice>1</voice></note>
    </measure>
    <measure number="3">
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>3</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

    const doc = parseMusicXml(xml, { DOMParser });
    const rhNotes = doc.noteEvents.filter((n) => n.hand === "RH");
    const lhNotes = doc.noteEvents.filter((n) => n.hand === "LH");

    // Linear measure order: exactly 4 physical RH notes, 3 physical LH notes (no repeat expansion)
    expect(rhNotes.map((n) => n.midi)).toEqual([72, 74, 76, 77]); // C5, D5, E5, F5
    expect(lhNotes.map((n) => n.midi)).toEqual([48, 43, 48]); // C3, G2, C3

    // Divisions LCM(2,3) = 6 -> m1 quarter=6, m1 total=18; m2 quarter=6, m2 total=18
    expect(rhNotes[0].onsetTick).toBe(0);
    expect(rhNotes[1].onsetTick).toBe(12); // after <forward> of 1 quarter
    expect(rhNotes[2].onsetTick).toBe(18);
    expect(rhNotes[3].onsetTick).toBe(36);

    // Tempo=120 in m1 (0.5s/quarter) -> D5 at 1.0s, E5 at 1.5s; Tempo=60 in m2 (1.0s/quarter) -> F5 at 4.5s
    expect(rhNotes[1].onsetSec).toBeCloseTo(1.0, 5);
    expect(rhNotes[2].onsetSec).toBeCloseTo(1.5, 5);
    expect(rhNotes[3].onsetSec).toBeCloseTo(4.5, 5);

    // P2 shares the exact same tempo map as P1: LH m2 starts at 1.5s, m3 starts at 4.5s
    expect(lhNotes[1].onsetSec).toBeCloseTo(1.5, 5);
    expect(lhNotes[2].onsetSec).toBeCloseTo(4.5, 5);

    // Phrase boundaries: repeat backward between m1->m2 AND ending/rest between m2->m3
    const rhSlices = doc.onsetSlices.filter((s) => s.hand === "RH");
    expect(rhSlices[0].phraseId).toBe(0); // C5 (m1)
    expect(rhSlices[1].phraseId).toBe(0); // D5 (m1, after short 0.5s forward without rest)
    expect(rhSlices[2].phraseId).toBe(1); // E5 (m2, after <repeat direction="backward"/>)
    expect(rhSlices[3].phraseId).toBe(2); // F5 (m3, after <ending> + 2s rest)

    const lhSlices = doc.onsetSlices.filter((s) => s.hand === "LH");
    expect(lhSlices[0].phraseId).toBe(0);
    expect(lhSlices[1].phraseId).toBe(1); // after <repeat direction="backward"/>
  });

  it("handles HandAssignment: dual-part F/G clef auto-swap, single-staff override without middle-C split, and >=70% cross-staff voice continuity", async () => {
    const { DOMParser } = createJsdomDom();

    // 1. Dual-part inverted clefs: P1 has F clef, P2 has G clef -> auto-swaps P1=LH, P2=RH
    const swappedDualPartXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Lower</part-name></score-part>
    <score-part id="P2"><part-name>Upper</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>F</sign><line>4</line></clef></attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const swappedDoc = parseMusicXml(swappedDualPartXml, { DOMParser });
    expect(swappedDoc.noteEvents.find((n) => n.midi === 48)?.hand).toBe("LH");
    expect(swappedDoc.noteEvents.find((n) => n.midi === 72)?.hand).toBe("RH");

    // 2. Single-staff override & no middle-C split (G2 + G5 stay on the selected single hand)
    const singleWideXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><voice>1</voice></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const defaultRh = parseMusicXml(singleWideXml, { DOMParser });
    expect(defaultRh.isSingleStaff).toBe(true);
    expect(defaultRh.defaultSingleStaffHand).toBe("RH");
    expect(defaultRh.noteEvents.every((n) => n.hand === "RH")).toBe(true);

    const overriddenLh = parseMusicXml(singleWideXml, { DOMParser, singleStaffHandOverride: "LH" });
    expect(overriddenLh.noteEvents.every((n) => n.hand === "LH")).toBe(true);

    // 3. Cross-staff >= 70% rule on 04-tie-cross-staff-compressed.mxl: voice 2 stays LH even on staff 1
    const mxlBytes = readFileSync(
      resolve(__dirname, "../test-corpus/04-tie-cross-staff-compressed.mxl")
    );
    const { xmlText: mxlXml } = await readMxlContainer(mxlBytes, { DOMParser });
    const doc04 = parseMusicXml(mxlXml, { DOMParser });
    const voice2Notes = doc04.noteEvents.filter((n) => n.voice === "2");
    expect(voice2Notes).toHaveLength(6);
    expect(voice2Notes.some((n) => n.staff === 1)).toBe(true);
    expect(voice2Notes.every((n) => n.hand === "LH")).toBe(true);

    // 4. Shared voice < 70% on either staff falls back strictly to note's own <staff>
    const sharedVoiceXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><staves>2</staves></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><voice>1</voice><staff>2</staff></note>
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>1</duration><voice>1</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;
    const sharedDoc = parseMusicXml(sharedVoiceXml, { DOMParser });
    expect(sharedDoc.noteEvents.filter((n) => n.staff === 1).every((n) => n.hand === "RH")).toBe(true);
    expect(sharedDoc.noteEvents.filter((n) => n.staff === 2).every((n) => n.hand === "LH")).toBe(true);
  });

  it("merges same-hand multi-voice OnsetSlices, links TieContinuation chains into heldNotes (with <tied> fallback), and preserves GraceNote slices", async () => {
    const { DOMParser } = createJsdomDom();

    // 1. 04-tie-cross-staff-compressed.mxl: grace note + tie chain (including semantic-only <tie type="stop"/>)
    const mxlBytes = readFileSync(
      resolve(__dirname, "../test-corpus/04-tie-cross-staff-compressed.mxl")
    );
    const { xmlText: xml04 } = await readMxlContainer(mxlBytes, { DOMParser });
    const doc04 = parseMusicXml(xml04, { DOMParser });
    const rhSlices04 = doc04.onsetSlices.filter((s) => s.hand === "RH");
    // RH strikes: Grace D5, E5, C5 (root), B4 -> 4 slices (both TieContinuations excluded)
    expect(rhSlices04.map((s) => s.notes.map((n) => n.midi))).toEqual([
      [74], // Grace D5
      [76], // E5
      [72], // C5
      [71], // B4
    ]);
    expect(rhSlices04[0].isGrace).toBe(true);
    expect(rhSlices04[0].notes[0].durationTick).toBe(0);
    expect(rhSlices04[1].isGrace).toBe(false);

    const c5Events = doc04.noteEvents.filter((n) => n.midi === 72);
    expect(c5Events).toHaveLength(3);
    expect(c5Events[0].isTieStop).toBe(false);
    expect(c5Events[1].isTieStop).toBe(true);
    expect(c5Events[1].tieChainRootUid).toBe(c5Events[0].noteUid);
    expect(c5Events[2].isTieStop).toBe(true);
    expect(c5Events[2].tieChainRootUid).toBe(c5Events[0].noteUid);

    // 2. 02-grand-staff-arpeggio-chord.musicxml: m2 same-hand multi-voice merge + heldNotes
    const xml02 = readFileSync(
      resolve(__dirname, "../test-corpus/02-grand-staff-arpeggio-chord.musicxml"),
      "utf-8"
    );
    const doc02 = parseMusicXml(xml02, { DOMParser });
    const m2RhSlices = doc02.onsetSlices.filter((s) => s.hand === "RH" && s.measureIndex === 1);
    // D4 (voice 3) + G4 (voice 1) merge ascending; next slice A4 sees D4 held
    expect(m2RhSlices[0].notes.map((n) => n.midi)).toEqual([62, 67]); // D4, G4
    expect(m2RhSlices[1].notes.map((n) => n.midi)).toEqual([69]); // A4
    expect(m2RhSlices[1].heldNotes.map((h) => h.midi)).toEqual([62]); // D4 still held

    // 3. Fallback <notations><tied type="stop"/>, TieContinuation extending heldNotes across beats, and chorded + sequential grace notes
    const tieAndGraceXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <!-- Voice 1: C4 tied across beat 2 using <notations><tied type="stop"/> fallback only -->
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>1</duration><tie type="start"/><voice>1</voice>
      </note>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>1</duration><voice>1</voice>
        <notations><tied type="stop"/></notations>
      </note>
      <backup><duration>2</duration></backup>
      <!-- Voice 2: rests beat 1, then chorded grace (E4+G4) + sequential grace (F4) before main A4 on beat 2 -->
      <note><rest/><duration>1</duration><voice>2</voice></note>
      <note><grace/><pitch><step>G</step><octave>4</octave></pitch><voice>2</voice></note>
      <note><grace/><chord/><pitch><step>E</step><octave>4</octave></pitch><voice>2</voice></note>
      <note><grace/><pitch><step>F</step><octave>4</octave></pitch><voice>2</voice></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const tgDoc = parseMusicXml(tieAndGraceXml, { DOMParser });
    // Strikes: C4 (tick 0), Grace chord [E4, G4] (tick 1), Grace F4 (tick 1), Main A4 (tick 1)
    expect(tgDoc.onsetSlices.map((s) => s.notes.map((n) => n.midi))).toEqual([
      [60],     // C4
      [64, 67], // Grace chord E4+G4
      [65],     // Grace F4
      [69],     // Main A4
    ]);
    // C4 (extended by <tied type="stop"/> fallback to endTick=2) is held during grace & main at tick 1
    expect(tgDoc.onsetSlices[1].heldNotes.map((h) => h.midi)).toEqual([60]);
    expect(tgDoc.onsetSlices[3].heldNotes.map((h) => h.midi)).toEqual([60]);
    expect(tgDoc.onsetSlices[3].heldNotes[0].endTick).toBe(2);
  });

  it("extracts non-auxiliary leading 1-5 FingerAnchors, ignores alternate/substitution/invalid digits, and preserves original <fingering> verbatim even when repaired", () => {
    const { DOMParser, XMLSerializer } = createJsdomDom();

    // 1. 03-partial-fingering-hanon.musicxml anchor extraction and <notations> before <lyric>
    const xml03 = readFileSync(
      resolve(__dirname, "../test-corpus/03-partial-fingering-hanon.musicxml"),
      "utf-8"
    );
    const doc03 = parseMusicXml(xml03, { DOMParser });
    const rhM1 = doc03.noteEvents.filter((n) => n.hand === "RH" && n.measureIndex === 0);
    expect(rhM1.map((n) => n.anchorFinger)).toEqual([1, 2, undefined, undefined, 5, undefined, undefined, undefined]);
    expect(rhM1.map((n) => n.anchorRawPreserved)).toEqual([true, true, false, false, true, false, false, false]);

    const lhM1 = doc03.noteEvents.filter((n) => n.hand === "LH" && n.measureIndex === 0);
    expect(lhM1.map((n) => n.anchorFinger)).toEqual([5, 4, undefined, undefined, 1, undefined, undefined, undefined]);

    const c5Ending = doc03.noteEvents.find((n) => n.measureIndex === 1 && n.midi === 72)!;
    expect(c5Ending.anchorFinger).toBe(5);
    expect(c5Ending.anchorRawPreserved).toBe(true);
    const c5El = doc03.noteElementsByUid.get(c5Ending.noteUid)!;
    const c5Tags = Array.from(c5El.children).map((c) => c.localName);
    expect(c5Tags.indexOf("notations")).toBeLessThan(c5Tags.indexOf("lyric"));

    // 2. Auxiliary tags ignored, hyphenated leading 1-5 extracted, invalid leading digit ignored,
    // and verbatim XML node + attributes preserved even when solver assigns a repaired finger
    const anchorXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice>
        <notations>
          <technical>
            <fingering alternate="yes">4</fingering>
            <fingering substitution="yes">5</fingering>
            <fingering placement="above" default-x="3" default-y="14">1-2</fingering>
          </technical>
        </notations>
      </note>
      <note>
        <pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice>
        <notations>
          <technical>
            <fingering alternate="yes">2</fingering>
          </technical>
        </notations>
      </note>
      <note>
        <pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice>
        <notations>
          <technical>
            <fingering>6-1</fingering>
          </technical>
        </notations>
      </note>
    </measure>
  </part>
</score-partwise>`;

    const doc = parseMusicXml(anchorXml, { DOMParser });
    const [n1, n2, n3] = doc.noteEvents;
    expect(n1.anchorFinger).toBe(1);
    expect(n1.anchorExitFinger).toBe(2);
    expect(n1.anchorRawPreserved).toBe(true);
    expect(n2.anchorFinger).toBeUndefined();
    expect(n2.anchorExitFinger).toBeUndefined();
    expect(n2.anchorRawPreserved).toBe(false);
    expect(n3.anchorFinger).toBeUndefined();
    expect(n3.anchorRawPreserved).toBe(false);

    // Simulate conflict repair proposing finger 3 for n1 (whose anchor was 1 / "1-2")
    writeFingeringsToScore(doc, {
      [n1.noteUid]: 3,
      [n2.noteUid]: 2,
      [n3.noteUid]: 4,
    });
    const out = serializeScoreDocument(doc, { XMLSerializer });

    // Original preserved <fingering> on n1 stays 100% verbatim with all attributes and "1-2" text
    expect(out).toContain('<fingering placement="above" default-x="3" default-y="14">1-2</fingering>');
    expect(out).toContain('<fingering alternate="yes">4</fingering>');
    expect(out).toContain('<fingering substitution="yes">5</fingering>');
    // n2 had only alternate="yes", so a new primary <fingering> is added alongside it
    expect(out).toContain('<fingering alternate="yes">2</fingering>');
    expect(out).toContain('<fingering placement="above">2</fingering>');
  });
});
