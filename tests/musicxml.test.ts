import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
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
    expect(doc.noteEvents).toHaveLength(18);
    expect(doc.onsetSlices).toHaveLength(18);

    // Measure 1: C4..C5 ascending eighth notes
    const m1Midis = doc.noteEvents.slice(0, 8).map((n) => n.midi);
    expect(m1Midis).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
    expect(doc.noteEvents.every((n) => n.hand === "RH")).toBe(true);

    // Measure 2: C5, Bb4, A4, F#4, F#5
    const m2Midis = doc.noteEvents.slice(8, 13).map((n) => n.midi);
    expect(m2Midis).toEqual([72, 70, 69, 66, 78]);

    // Measure 3 rest creates a phrase boundary before G5
    const m1Phrase = doc.onsetSlices[0].phraseId;
    const m3FirstNoteSlice = doc.onsetSlices[13];
    expect(m3FirstNoteSlice.measureIndex).toBe(2);
    expect(m3FirstNoteSlice.notes[0].midi).toBe(79); // G5
    expect(m3FirstNoteSlice.phraseId).toBeGreaterThan(m1Phrase);
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
});
