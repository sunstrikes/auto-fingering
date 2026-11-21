import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { svgsAndMidiToMusicXml } from "../src/musescore";
import { parseMs4Svg } from "../src/musescore/svgParser";
import { parseRawMidi } from "../src/musescore/rawMidi";
import { alignSvgsAndMidi } from "../src/musescore/svgMidiAligner";
import { buildMusicXml } from "../src/musescore/musicxmlBuilder";
import { parseMusicXml } from "../src/musicxml/parser";

const FIXTURE_DIR = resolve(__dirname, "../test-corpus/ms4-fixtures");
const CORPUS_DIR = resolve(__dirname, "../test-corpus");

const dom = new JSDOM();
const domDeps = {
  DOMParser: dom.window.DOMParser,
  XMLSerializer: dom.window.XMLSerializer,
};

function encodeVlq(value: number): number[] {
  const bytes: number[] = [];
  let v = value >>> 0;
  bytes.unshift(v & 0x7f);
  while ((v >>>= 7) > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
  }
  return bytes;
}

function buildSmf(ppq: number, tracks: number[][]): Uint8Array {
  const header = [
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x01,
    (tracks.length >> 8) & 0xff, tracks.length & 0xff,
    (ppq >> 8) & 0xff, ppq & 0xff,
  ];
  const chunks: number[] = [...header];
  for (const trackData of tracks) {
    const len = trackData.length;
    chunks.push(
      0x4d, 0x54, 0x72, 0x6b,
      (len >>> 24) & 0xff,
      (len >>> 16) & 0xff,
      (len >>> 8) & 0xff,
      len & 0xff,
      ...trackData
    );
  }
  return new Uint8Array(chunks);
}

/**
 * Helper to build a minimal single-staff MS4 SVG with treble clef (top line F5 at y=100, staffSpace=20).
 * Diatonic steps from C4: C4=0 (y=200), D4=1 (y=190), E4=2 (y=180), F4=3 (y=170), G4=4 (y=160), A4=5 (y=150), B4=6 (y=140).
 */
function makeSingleStaffSvg(notePositions: Array<{ x: number; y: number; stemDir?: "up" | "down" }>): string {
  const lines = [100, 120, 140, 160, 180]
    .map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`)
    .join("\n");
  const notes = notePositions
    .map(
      (n) =>
        `<path class="Note" d="M${n.x - 10},${n.y - 8} L${n.x + 10},${n.y - 8} L${n.x + 10},${n.y + 8} L${n.x - 10},${n.y + 8} Z" />`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 1000 400" xmlns="http://www.w3.org/2000/svg">
  ${lines}
  <polyline class="BarLine" points="50,100 50,180" />
  <polyline class="BarLine" points="950,100 950,180" />
  ${notes}
</svg>`;
}

describe("alignSvgsAndMidi (linear alignment, enharmonic solver, hand assignment & tie disambiguation)", () => {
  it("solves exact enharmonic alter (sharps, flats, double sharps, double flats) and flags |alter| > 2", () => {
    const ppq = 480;
    // Measure 1 (4/4):
    // 1. C4 position (y=200) + MIDI 61 -> C#4 (alter=1)
    // 2. D4 position (y=190) + MIDI 61 -> Db4 (alter=-1)
    // 3. F4 position (y=170) + MIDI 67 -> F##4 (alter=2)
    // 4. B3 position (y=210) + MIDI 57 -> Bbb3 (alter=-2)
    const svg = makeSingleStaffSvg([
      { x: 200, y: 200 },
      { x: 350, y: 190 },
      { x: 500, y: 170 },
      { x: 650, y: 210 },
    ]);
    const track = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
      ...encodeVlq(0), 0x90, 61, 80,
      ...encodeVlq(480), 0x80, 61, 0,
      ...encodeVlq(0), 0x90, 61, 80,
      ...encodeVlq(480), 0x80, 61, 0,
      ...encodeVlq(0), 0x90, 67, 80,
      ...encodeVlq(480), 0x80, 67, 0,
      ...encodeVlq(0), 0x90, 57, 80,
      ...encodeVlq(480), 0x80, 57, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const page = parseMs4Svg(svg, 0);
    const rawMidi = parseRawMidi(buildSmf(ppq, [track]));
    const { model, diagnostics } = alignSvgsAndMidi([page], rawMidi);

    expect(diagnostics.some((d) => d.code === "ALIGNMENT_ALTER_OUT_OF_RANGE")).toBe(false);
    const notes = model.measures[0].notes.filter((n) => n.kind === "note");
    expect(notes.map((n) => n.pitch)).toEqual([
      { step: "C", alter: 1, octave: 4 },
      { step: "D", alter: -1, octave: 4 },
      { step: "F", alter: 2, octave: 4 },
      { step: "B", alter: -2, octave: 3 },
    ]);

    // Now test |alter| > 2 anomaly: C4 visual notehead paired with MIDI 64 (E4, alter=+4)
    const badSvg = makeSingleStaffSvg([{ x: 200, y: 200 }]);
    const badTrack = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
      ...encodeVlq(0), 0x90, 64, 80,
      ...encodeVlq(1920), 0x80, 64, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];
    const badRes = alignSvgsAndMidi([parseMs4Svg(badSvg, 0)], parseRawMidi(buildSmf(ppq, [badTrack])));
    expect(badRes.diagnostics.some((d) => d.code === "ALIGNMENT_ALTER_OUT_OF_RANGE" && d.level === "warning")).toBe(
      true
    );
  });

  it("preserves coherent Hand Assignment across cross-staff beamed passages via stem/beam connectivity", () => {
    const ppq = 480;
    // Grand staff (Staff 1: y=100..180, Staff 2: y=260..340, staffSpace=20)
    // Beam group of 4 eighth notes: E4 (staff 1), G4 (staff 1), A3 (staff 2), C4 (staff 1)
    // Majority on staff 1 -> entire beam group gets voice="1" (RH), even the A3 on staff 2!
    const staff1Lines = [100, 120, 140, 160, 180]
      .map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`)
      .join("\n");
    const staff2Lines = [260, 280, 300, 320, 340]
      .map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`)
      .join("\n");

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 1000 500" xmlns="http://www.w3.org/2000/svg">
  ${staff1Lines}
  ${staff2Lines}
  <polyline class="BarLine" points="50,100 50,340" />
  <polyline class="BarLine" points="950,100 950,340" />
  <path class="Clef" d="M70,80 L90,80 L90,200 L70,200 Z" />
  <path class="Clef" d="M70,260 L90,260 L90,320 L70,320 Z" />
  <!-- 4 noteheads: E4(s1,y=180), G4(s1,y=160), A3(s2,y=260), C4(s1,y=200) -->
  <path class="Note" d="M200,172 L220,172 L220,188 L200,188 Z" />
  <path class="Note" d="M320,152 L340,152 L340,168 L320,168 Z" />
  <path class="Note" d="M440,252 L460,252 L460,268 L440,268 Z" />
  <path class="Note" d="M560,192 L580,192 L580,208 L560,208 Z" />
  <!-- Stems up to shared beam at y=220 (between staves!) -->
  <polyline class="Stem" points="220,180 220,220" />
  <polyline class="Stem" points="340,160 340,220" />
  <polyline class="Stem" points="440,260 440,220" />
  <polyline class="Stem" points="580,200 580,220" />
  <path class="Beam" d="M220,216 L580,216 L580,224 L220,224 Z" />
</svg>`;

    const track = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
      ...encodeVlq(0), 0x90, 64, 80,   // E4
      ...encodeVlq(240), 0x80, 64, 0,
      ...encodeVlq(0), 0x90, 67, 80,   // G4
      ...encodeVlq(240), 0x80, 67, 0,
      ...encodeVlq(0), 0x90, 57, 80,   // A3 (on staff 2!)
      ...encodeVlq(240), 0x80, 57, 0,
      ...encodeVlq(0), 0x90, 60, 80,   // C4
      ...encodeVlq(240), 0x80, 60, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const page = parseMs4Svg(svg, 0);
    const rawMidi = parseRawMidi(buildSmf(ppq, [track]));
    const { model } = alignSvgsAndMidi([page], rawMidi);

    const notes = model.measures[0].notes.filter((n) => n.kind === "note");
    expect(notes).toHaveLength(4);
    // All 4 share voice "1", while A3 preserves visual staff 2
    expect(notes.map((n) => n.voice)).toEqual(["1", "1", "1", "1"]);
    expect(notes.map((n) => n.staff)).toEqual([1, 1, 2, 1]);

    // Verify parseMusicXml assigns hand="RH" to all 4 notes (including A3 on staff 2)
    const xml = buildMusicXml(model);
    const score = parseMusicXml(xml, domDeps);
    expect(score.noteEvents).toHaveLength(4);
    expect(score.noteEvents.every((n) => n.hand === "RH")).toBe(true);
    expect(score.noteEvents[2].staff).toBe(2);
  });

  it("disambiguates same-pitch visual arcs via MIDI NoteOn continuity (Tie Continuation vs re-struck notes)", () => {
    const ppq = 480;
    // Two pairs of same-pitch C4 noteheads with visual TieSegment arcs:
    // Pair 1 (x=200 -> x=350): ONE continuous MIDI NoteOn (tick 0..960) -> Tie Continuation!
    // Pair 2 (x=500 -> x=650): TWO separate MIDI NoteOns (tick 960..1440, tick 1440..1920) -> re-struck notes!
    const lines = [100, 120, 140, 160, 180]
      .map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`)
      .join("\n");
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 1000 400" xmlns="http://www.w3.org/2000/svg">
  ${lines}
  <polyline class="BarLine" points="50,100 50,180" />
  <polyline class="BarLine" points="950,100 950,180" />
  <path class="Note" d="M190,192 L210,192 L210,208 L190,208 Z" />
  <path class="Note" d="M340,192 L360,192 L360,208 L340,208 Z" />
  <path class="TieSegment" d="M200,210 C250,230 300,230 350,210" />
  <path class="Note" d="M490,192 L510,192 L510,208 L490,208 Z" />
  <path class="Note" d="M640,192 L660,192 L660,208 L640,208 Z" />
  <path class="SlurSegment" d="M500,210 C550,230 600,230 650,210" />
</svg>`;

    const track = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
      ...encodeVlq(0), 0x90, 60, 80,    // C4 #1 sustained 0..960
      ...encodeVlq(960), 0x80, 60, 0,
      ...encodeVlq(0), 0x90, 60, 80,    // C4 #2 re-struck 960..1440
      ...encodeVlq(480), 0x80, 60, 0,
      ...encodeVlq(0), 0x90, 60, 80,    // C4 #3 re-struck 1440..1920
      ...encodeVlq(480), 0x80, 60, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const page = parseMs4Svg(svg, 0);
    const rawMidi = parseRawMidi(buildSmf(ppq, [track]));
    const { model } = alignSvgsAndMidi([page], rawMidi);
    const xml = buildMusicXml(model);
    const score = parseMusicXml(xml, domDeps);

    expect(score.noteEvents).toHaveLength(4);
    // Pair 1: tied
    expect(score.noteEvents[0].isTieStart).toBe(true);
    expect(score.noteEvents[0].isTieStop).toBe(false);
    expect(score.noteEvents[1].isTieStop).toBe(true);
    // Pair 2: re-struck (not tied)
    expect(score.noteEvents[2].isTieStart).toBe(false);
    expect(score.noteEvents[2].isTieStop).toBe(false);
    expect(score.noteEvents[3].isTieStart).toBe(false);
    expect(score.noteEvents[3].isTieStop).toBe(false);
  });

  it("passes Round-Trip Oracle for 01-grand-staff vs 02-grand-staff-arpeggio-chord.musicxml", () => {
    const svg = readFileSync(resolve(FIXTURE_DIR, "01-grand-staff-p1.svg"), "utf8");
    const midi = readFileSync(resolve(FIXTURE_DIR, "01-grand-staff.mid"));
    const oracleXml = readFileSync(resolve(CORPUS_DIR, "02-grand-staff-arpeggio-chord.musicxml"), "utf8");

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg], midi, {
      title: "01-grand-staff",
    });
    expect(diagnostics.some((d) => d.level === "error")).toBe(false);

    const converted = parseMusicXml(xml, domDeps);
    const oracle = parseMusicXml(oracleXml, domDeps);

    expect(converted.measureCount).toBe(oracle.measureCount);
    expect(converted.noteEvents).toHaveLength(oracle.noteEvents.length);

    const normalizeNotes = (notes: typeof oracle.noteEvents) =>
      notes
        .map((n) => `${n.measureIndex}:${n.hand}:${n.staff}:${n.midi}`)
        .sort();
    expect(normalizeNotes(converted.noteEvents)).toEqual(normalizeNotes(oracle.noteEvents));
  });

  it("passes Round-Trip Oracle for 02-fingerings vs 03-partial-fingering-hanon.musicxml", () => {
    const svg = readFileSync(resolve(FIXTURE_DIR, "02-fingerings-p1.svg"), "utf8");
    const midi = readFileSync(resolve(FIXTURE_DIR, "02-fingerings.mid"));
    const oracleXml = readFileSync(resolve(CORPUS_DIR, "03-partial-fingering-hanon.musicxml"), "utf8");

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg], midi, {
      title: "02-fingerings",
    });
    expect(diagnostics.some((d) => d.level === "error")).toBe(false);

    const converted = parseMusicXml(xml, domDeps);
    const oracle = parseMusicXml(oracleXml, domDeps);

    expect(converted.measureCount).toBe(oracle.measureCount);
    expect(converted.noteEvents).toHaveLength(oracle.noteEvents.length);

    const normalizeNotes = (notes: typeof oracle.noteEvents) =>
      notes
        .map((n) => `${n.measureIndex}:${n.hand}:${n.staff}:${n.midi}`)
        .sort();
    expect(normalizeNotes(converted.noteEvents)).toEqual(normalizeNotes(oracle.noteEvents));
  });
});
