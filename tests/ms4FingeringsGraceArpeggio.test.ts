import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { svgsAndMidiToMusicXml } from "../src/musescore";
import { parseMs4Svg } from "../src/musescore/svgParser";
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

describe("MS4 Finger Anchors, Grace Notes & Arpeggios (#5)", () => {
  it("extracts <fingering> (1-5 and 5-4) while strictly excluding TimeSig, Tuplet, MeasureNumber, VoltaSegment, and PageNumber", () => {
    const ppq = 480;
    const staffLines = [100, 120, 140, 160, 180]
      .map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`)
      .join("\n");

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 1000 400" xmlns="http://www.w3.org/2000/svg">
  ${staffLines}
  <polyline class="BarLine" points="50,100 50,180" />
  <polyline class="BarLine" points="950,100 950,180" />
  <!-- Non-fingering digits that must be strictly excluded -->
  <text class="TimeSig" x="100" y="130">4</text>
  <text class="TimeSig" x="100" y="170">4</text>
  <text class="Tuplet" x="350" y="90">3</text>
  <text class="MeasureNumber" x="55" y="80">1</text>
  <text class="VoltaSegment" x="200" y="70">1.</text>
  <text class="PageNumber" x="920" y="30">2</text>

  <!-- Two notes: C4 (y=200, x=220) with text fingering "5-4", D4 (y=190, x=420) with text fingering "2" -->
  <path class="Note" d="M210,192 L230,192 L230,208 L210,208 Z" />
  <text class="Fingering" x="212" y="170">5-4</text>

  <path class="Note" d="M410,182 L430,182 L430,198 L410,198 Z" />
  <text class="Fingering" x="415" y="160">2</text>
</svg>`;

    const track = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
      ...encodeVlq(0), 0x90, 60, 80,
      ...encodeVlq(960), 0x80, 60, 0,
      ...encodeVlq(0), 0x90, 62, 80,
      ...encodeVlq(960), 0x80, 62, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const parsed = parseMs4Svg(svg, 0);
    expect(parsed.fingerings.map((f) => f.value)).toEqual(["5-4", "2"]);

    const { xml } = svgsAndMidiToMusicXml([svg], buildSmf(ppq, [track]));
    const score = parseMusicXml(xml, domDeps);
    expect(score.noteEvents).toHaveLength(2);
    expect(score.noteEvents[0].anchorFinger).toBe(5);
    expect(score.noteEvents[0].anchorExitFinger).toBe(4);
    expect(score.noteEvents[1].anchorFinger).toBe(2);
    expect(score.noteEvents[1].anchorExitFinger).toBeUndefined();
  });

  it("preserves all original <fingering> Finger Anchors in 02-fingerings vs 03-partial-fingering-hanon.musicxml Round-Trip Oracle", () => {
    const svg = readFileSync(resolve(FIXTURE_DIR, "02-fingerings-p1.svg"), "utf8");
    const midi = readFileSync(resolve(FIXTURE_DIR, "02-fingerings.mid"));
    const oracleXml = readFileSync(resolve(CORPUS_DIR, "03-partial-fingering-hanon.musicxml"), "utf8");

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg], midi, {
      title: "02-fingerings",
    });
    expect(diagnostics.some((d) => d.level === "error")).toBe(false);

    const converted = parseMusicXml(xml, domDeps);
    const oracle = parseMusicXml(oracleXml, domDeps);

    const normalizeWithFingerings = (notes: typeof oracle.noteEvents) =>
      notes
        .map((n) => `${n.measureIndex}:${n.hand}:${n.staff}:${n.midi}:${n.anchorFinger ?? ""}`)
        .sort();
    expect(normalizeWithFingerings(converted.noteEvents)).toEqual(
      normalizeWithFingerings(oracle.noteEvents)
    );
  });

  it("maps vertically stacked chord fingerings in top-to-bottom pitch order onto each chord Note Event", () => {
    const ppq = 480;
    const staffLines = [100, 120, 140, 160, 180]
      .map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`)
      .join("\n");

    // 3-note chord C4 (y=200), E4 (y=180), G4 (y=160) at x=300
    // Stacked fingerings above chord: "5" at y=100 (top), "3" at y=120 (mid), "1" at y=140 (bot)
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 1000 400" xmlns="http://www.w3.org/2000/svg">
  ${staffLines}
  <polyline class="BarLine" points="50,100 50,180" />
  <polyline class="BarLine" points="950,100 950,180" />
  <path class="Note" d="M290,152 L310,152 L310,168 L290,168 Z" />
  <path class="Note" d="M290,172 L310,172 L310,188 L290,188 Z" />
  <path class="Note" d="M290,192 L310,192 L310,208 L290,208 Z" />
  <text class="Fingering" x="295" y="100">5</text>
  <text class="Fingering" x="295" y="120">3</text>
  <text class="Fingering" x="295" y="140">1</text>
</svg>`;

    const track = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
      ...encodeVlq(0), 0x90, 60, 80, // C4
      ...encodeVlq(0), 0x90, 64, 80, // E4
      ...encodeVlq(0), 0x90, 67, 80, // G4
      ...encodeVlq(1920), 0x80, 60, 0,
      ...encodeVlq(0), 0x80, 64, 0,
      ...encodeVlq(0), 0x80, 67, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const { xml } = svgsAndMidiToMusicXml([svg], buildSmf(ppq, [track]));
    const score = parseMusicXml(xml, domDeps);
    expect(score.noteEvents).toHaveLength(3);
    const byMidi = new Map(score.noteEvents.map((n) => [n.midi, n.anchorFinger]));
    expect(byMidi.get(67)).toBe(5); // G4 (top) -> 5
    expect(byMidi.get(64)).toBe(3); // E4 (mid) -> 3
    expect(byMidi.get(60)).toBe(1); // C4 (bot) -> 1
  });

  it("recognizes small-scale ornamental noteheads as zero-duration <grace/> Grace Note elements", () => {
    const ppq = 480;
    const staffLines = [100, 120, 140, 160, 180]
      .map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`)
      .join("\n");

    // Normal noteheads are 22x16; grace notehead D4 (y=190, x=220) is 13x10 (~0.6x scale) with Stem + StemSlash
    // Principal notehead C4 (y=200, x=260) is 22x16, plus two more normal notes E4 (x=450), G4 (x=650)
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 1000 400" xmlns="http://www.w3.org/2000/svg">
  ${staffLines}
  <polyline class="BarLine" points="50,100 50,180" />
  <polyline class="BarLine" points="950,100 950,180" />
  <path class="Note" d="M213.5,185 L226.5,185 L226.5,195 L213.5,195 Z" />
  <polyline class="Stem" points="226.5,190 226.5,140" />
  <polyline class="StemSlash" points="218,165 234,150" />
  <path class="Note" d="M249,192 L271,192 L271,208 L249,208 Z" />
  <path class="Note" d="M439,172 L461,172 L461,188 L439,188 Z" />
  <path class="Note" d="M639,152 L661,152 L661,168 L639,168 Z" />
</svg>`;

    const track = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
      ...encodeVlq(0), 0x90, 62, 70,    // D4 grace (0..60)
      ...encodeVlq(60), 0x80, 62, 0,
      ...encodeVlq(0), 0x90, 60, 80,    // C4 principal (60..960)
      ...encodeVlq(900), 0x80, 60, 0,
      ...encodeVlq(0), 0x90, 64, 80,    // E4 (960..1440)
      ...encodeVlq(480), 0x80, 64, 0,
      ...encodeVlq(0), 0x90, 67, 80,    // G4 (1440..1920)
      ...encodeVlq(480), 0x80, 67, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const parsed = parseMs4Svg(svg, 0);
    expect(parsed.noteheads.map((n) => n.isGrace)).toEqual([true, false, false, false]);

    const { xml } = svgsAndMidiToMusicXml([svg], buildSmf(ppq, [track]));
    expect(xml).toContain("<grace/>");

    const score = parseMusicXml(xml, domDeps);
    expect(score.noteEvents).toHaveLength(4);
    expect(score.noteEvents[0]).toMatchObject({
      midi: 62,
      isGrace: true,
      durationTick: 0,
      onsetTick: 0,
    });
    expect(score.noteEvents[1]).toMatchObject({
      midi: 60,
      isGrace: false,
      onsetTick: 0,
      durationTick: 960,
    });
  });

  it("preserves <arpeggiate/> roll symbols and collapses staggered MIDI onset ticks into a single chord Onset Slice", () => {
    const ppq = 480;
    const staff1Lines = [100, 120, 140, 160, 180]
      .map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`)
      .join("\n");
    const staff2Lines = [260, 280, 300, 320, 340]
      .map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`)
      .join("\n");

    // Grand-staff 4-note rolled chord at x=300: C5(y=130,s1), E4(y=180,s1), G3(y=270,s2), C3(y=310,s2)
    // Arpeggio wave at x=275 spanning y=125..315
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 1000 450" xmlns="http://www.w3.org/2000/svg">
  ${staff1Lines}
  ${staff2Lines}
  <polyline class="BarLine" points="50,100 50,340" />
  <polyline class="BarLine" points="950,100 950,340" />
  <path class="Clef" d="M70,80 L90,80 L90,200 L70,200 Z" />
  <path class="Clef" d="M70,260 L90,260 L90,320 L70,320 Z" />
  <path class="Arpeggio" d="M270,125 L280,150 L270,175 L280,200 L270,225 L280,250 L270,275 L280,315" />
  <path class="Note" d="M290,122 L310,122 L310,138 L290,138 Z" />
  <path class="Note" d="M290,172 L310,172 L310,188 L290,188 Z" />
  <path class="Note" d="M290,262 L310,262 L310,278 L290,278 Z" />
  <path class="Note" d="M290,302 L310,302 L310,318 L290,318 Z" />
</svg>`;

    // Staggered MIDI onset ticks: C3@0, G3@45, E4@90, C5@135, all released at 1920
    const track = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
      ...encodeVlq(0), 0x90, 48, 80,   // C3 @ 0
      ...encodeVlq(45), 0x90, 55, 80,  // G3 @ 45
      ...encodeVlq(45), 0x90, 64, 80,  // E4 @ 90
      ...encodeVlq(45), 0x90, 72, 80,  // C5 @ 135
      ...encodeVlq(1785), 0x80, 48, 0, // @ 1920
      ...encodeVlq(0), 0x80, 55, 0,
      ...encodeVlq(0), 0x80, 64, 0,
      ...encodeVlq(0), 0x80, 72, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const parsed = parseMs4Svg(svg, 0);
    expect(parsed.arpeggios).toHaveLength(1);

    const { xml } = svgsAndMidiToMusicXml([svg], buildSmf(ppq, [track]));
    expect(xml).toContain("<arpeggiate/>");

    const score = parseMusicXml(xml, domDeps);
    expect(score.noteEvents).toHaveLength(4);
    expect(score.noteEvents.every((n) => n.onsetTick === 0)).toBe(true);
    expect(score.noteEvents.every((n) => n.isArpeggiated === true)).toBe(true);
    expect(score.onsetSlices).toHaveLength(2); // 1 RH slice + 1 LH slice, both at onsetTick=0
    expect(score.onsetSlices.map((s) => s.notes.length).sort()).toEqual([2, 2]);
  });

  it("extracts all 5 real MS4 Fingering digits (1-5) and Arpeggio symbols from 03-repeats-span-p1.svg", () => {
    const svg = readFileSync(resolve(FIXTURE_DIR, "03-repeats-span-p1.svg"), "utf8");
    const parsed = parseMs4Svg(svg, 0);

    expect(parsed.fingerings.map((f) => f.value)).toEqual(["3", "1", "4", "2", "5"]);
    expect(parsed.arpeggios).toHaveLength(2);
    const lastMeasureIdx = parsed.systems[0].measures.length - 1;
    expect(parsed.arpeggios.every((a) => a.measureIndex === lastMeasureIdx)).toBe(true);
  });
});
