import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { buildMusicXml, closeBoundarySpanners, svgsAndMidiToMusicXml } from "../src/musescore";
import type { ScoreBuildModel } from "../src/musescore";
import { parseMusicXml } from "../src/musicxml/parser";

const FIXTURE_DIR = resolve(__dirname, "../test-corpus/ms4-fixtures");

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

function makeTwoMeasureMidi(ppq = 480): Uint8Array {
  const track = [
    ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08, // 4/4
    // Measure 1: C4, D4, E4, F4
    ...encodeVlq(0), 0x90, 60, 80,
    ...encodeVlq(480), 0x80, 60, 0,
    ...encodeVlq(0), 0x90, 62, 80,
    ...encodeVlq(480), 0x80, 62, 0,
    ...encodeVlq(0), 0x90, 64, 80,
    ...encodeVlq(480), 0x80, 64, 0,
    ...encodeVlq(0), 0x90, 65, 80,
    ...encodeVlq(480), 0x80, 65, 0,
    // Measure 2: G4, A4, B4, C5
    ...encodeVlq(0), 0x90, 67, 80,
    ...encodeVlq(480), 0x80, 67, 0,
    ...encodeVlq(0), 0x90, 69, 80,
    ...encodeVlq(480), 0x80, 69, 0,
    ...encodeVlq(0), 0x90, 71, 80,
    ...encodeVlq(480), 0x80, 71, 0,
    ...encodeVlq(0), 0x90, 72, 80,
    ...encodeVlq(480), 0x80, 72, 0,
    ...encodeVlq(0), 0xff, 0x2f, 0x00,
  ];
  return buildSmf(ppq, [track]);
}

function makeSingleMeasureSvg(): string {
  const lines = [100, 120, 140, 160, 180]
    .map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`)
    .join("\n");
  const notes = [
    { x: 200, y: 200 }, // C4
    { x: 350, y: 190 }, // D4
    { x: 500, y: 180 }, // E4
    { x: 650, y: 170 }, // F4
  ]
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

describe("PNG Page Guard, Preview Truncation & Boundary-Safe Partial Fallback (#9)", () => {
  it("skips PNG-only binary asset cleanly via magic bytes without crashing, falls back to MIDI, and reports diagnostics", () => {
    const pngBuf = readFileSync(resolve(FIXTURE_DIR, "05-png-asset-p1.png"));
    const midiBuf = makeTwoMeasureMidi();

    const { xml, diagnostics } = svgsAndMidiToMusicXml([pngBuf], midiBuf, {
      title: "PNG Only Score",
    });

    expect(diagnostics.totalPages).toBe(1);
    expect(diagnostics.svgPagesParsed).toBe(0);
    expect(diagnostics.pngPagesSkipped).toBe(1);
    expect(diagnostics.measuresAligned).toBe(0);
    expect(diagnostics.fallbackMeasures).toBe(2);
    expect(diagnostics.alignmentConfidence).toBe(0);
    expect(diagnostics.some((d) => d.level === "warning" && d.code === "PNG_PAGE_SKIPPED")).toBe(true);
    expect(diagnostics.some((d) => d.level === "error")).toBe(false);

    const score = parseMusicXml(xml, domDeps);
    expect(score.measureCount).toBe(2);
    expect(score.noteEvents).toHaveLength(8);
  });

  it("reports structured diagnostics on empty SVG array fallback", () => {
    const midiBuf = makeTwoMeasureMidi();
    const { xml, diagnostics } = svgsAndMidiToMusicXml([], midiBuf);

    expect(diagnostics.totalPages).toBe(0);
    expect(diagnostics.svgPagesParsed).toBe(0);
    expect(diagnostics.pngPagesSkipped).toBe(0);
    expect(diagnostics.measuresAligned).toBe(0);
    expect(diagnostics.fallbackMeasures).toBe(2);
    expect(diagnostics.alignmentConfidence).toBe(0);
    expect(diagnostics.some((d) => d.code === "MIDI_ONLY_FALLBACK")).toBe(true);

    const score = parseMusicXml(xml, domDeps);
    expect(score.measureCount).toBe(2);
    expect(score.noteEvents).toHaveLength(8);
  });

  it("handles mixed SVG + PNG pages by skipping PNG and aligning SVG + falling back for uncovered measures", () => {
    const svg = makeSingleMeasureSvg();
    const pngBuf = readFileSync(resolve(FIXTURE_DIR, "05-png-asset-p1.png"));
    const midiBuf = makeTwoMeasureMidi();

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg, pngBuf], midiBuf);

    expect(diagnostics.totalPages).toBe(2);
    expect(diagnostics.svgPagesParsed).toBe(1);
    expect(diagnostics.pngPagesSkipped).toBe(1);
    expect(diagnostics.measuresAligned).toBe(1);
    expect(diagnostics.fallbackMeasures).toBe(1);
    expect(diagnostics.alignmentConfidence).toBeGreaterThan(0);
    expect(diagnostics.alignmentConfidence).toBeLessThan(1);
    expect(diagnostics.some((d) => d.code === "PNG_PAGE_SKIPPED" && d.pageIndex === 1)).toBe(true);

    const score = parseMusicXml(xml, domDeps);
    expect(score.measureCount).toBe(2);
    expect(score.noteEvents).toHaveLength(8);
  });

  it("handles real 04-partial-preview fixture (svgPages < totalPages), synthesizes uncovered measures, and parses cleanly via parseMusicXml", () => {
    const svgP1 = readFileSync(resolve(FIXTURE_DIR, "04-partial-preview-p1.svg"), "utf8");
    const midiBuf = readFileSync(resolve(FIXTURE_DIR, "04-partial-preview.mid"));

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svgP1], midiBuf, {
      title: "Partial Preview Fixture",
      totalPages: 2,
    });

    expect(diagnostics.totalPages).toBe(2);
    expect(diagnostics.svgPagesParsed).toBe(1);
    expect(diagnostics.pngPagesSkipped).toBe(0);
    expect(diagnostics.measuresAligned).toBeGreaterThan(0);
    expect(diagnostics.fallbackMeasures).toBeGreaterThan(0);
    expect(diagnostics.some((d) => d.code === "PREVIEW_TRUNCATED" && d.level === "warning")).toBe(true);
    expect(diagnostics.some((d) => d.level === "error")).toBe(false);

    const score = parseMusicXml(xml, domDeps);
    expect(score.measureCount).toBe(diagnostics.measuresAligned + diagnostics.fallbackMeasures);
    expect(score.noteEvents.length).toBeGreaterThan(0);
    // Verify continuous measure timelines with positive durations
    for (let i = 0; i < score.measureTimelines.length; i++) {
      const tl = score.measureTimelines[i];
      expect(tl.endTick).toBeGreaterThan(tl.startTick);
      if (i > 0) {
        expect(tl.startTick).toBe(score.measureTimelines[i - 1].endTick);
      }
    }
  });

  it("falls back cleanly when given an empty SVG document (no staves) or binary-string PNG", () => {
    const midiBuf = makeTwoMeasureMidi();
    const emptySvg = '<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"></svg>';
    const resEmpty = svgsAndMidiToMusicXml([emptySvg], midiBuf);

    expect(resEmpty.diagnostics.svgPagesParsed).toBe(1);
    expect(resEmpty.diagnostics.measuresAligned).toBe(0);
    expect(resEmpty.diagnostics.fallbackMeasures).toBe(2);
    expect(resEmpty.diagnostics.some((d) => d.code === "SVG_NO_SYSTEMS_FALLBACK")).toBe(true);
    expect(parseMusicXml(resEmpty.xml, domDeps).measureCount).toBe(2);

    const pngStr = "\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR";
    const resPngStr = svgsAndMidiToMusicXml([pngStr], midiBuf);
    expect(resPngStr.diagnostics.pngPagesSkipped).toBe(1);
    expect(resPngStr.diagnostics.svgPagesParsed).toBe(0);
    expect(resPngStr.diagnostics.some((d) => d.code === "PNG_PAGE_SKIPPED")).toBe(true);
    expect(parseMusicXml(resPngStr.xml, domDeps).measureCount).toBe(2);
  });

  it("falls back to raw MIDI for individual misaligned measures below alignmentConfidenceThreshold", () => {
    const lines = [100, 120, 140, 160, 180]
      .map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`)
      .join("\n");
    // Measure 1 (x: 50..500): 4 aligned notes C4, D4, E4, F4
    const m1Notes = [
      { x: 120, y: 200 },
      { x: 210, y: 190 },
      { x: 300, y: 180 },
      { x: 390, y: 170 },
    ];
    // Measure 2 (x: 500..950): severely misaligned (only 1 notehead at C4 while MIDI has G4, A4, B4, C5)
    const m2Notes = [{ x: 600, y: 200 }];
    const notesXml = [...m1Notes, ...m2Notes]
      .map(
        (n) =>
          `<path class="Note" d="M${n.x - 10},${n.y - 8} L${n.x + 10},${n.y - 8} L${n.x + 10},${n.y + 8} L${n.x - 10},${n.y + 8} Z" />`
      )
      .join("\n");

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 1000 400" xmlns="http://www.w3.org/2000/svg">
  ${lines}
  <polyline class="BarLine" points="50,100 50,180" />
  <polyline class="BarLine" points="500,100 500,180" />
  <polyline class="BarLine" points="950,100 950,180" />
  ${notesXml}
</svg>`;

    const midiBuf = makeTwoMeasureMidi();
    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg], midiBuf);

    expect(diagnostics.measuresAligned).toBe(1);
    expect(diagnostics.fallbackMeasures).toBe(1);
    expect(diagnostics.alignmentConfidence).toBeGreaterThan(0);
    expect(diagnostics.alignmentConfidence).toBeLessThan(1);
    expect(
      diagnostics.some(
        (d) => d.code === "LOW_CONFIDENCE_MEASURE_FALLBACK" && d.measureNumber === 2
      )
    ).toBe(true);

    const score = parseMusicXml(xml, domDeps);
    expect(score.measureCount).toBe(2);
    expect(score.noteEvents.map((n) => n.midi)).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
  });

  it("closes open cross-boundary <tie>, <slur>, <wedge>, and <pedal> spanners at SVG/fallback boundaries", () => {
    const ppq = 480;
    // Measure 1 (SVG): C4 (0..480), D4 (480..960), E4 (960..1440), F4 (1440..2400 -> ties into Measure 2!)
    // Pedal start at tick 480, no pedal stop in Measure 2 (so pedal is open at SVG/fallback boundary!)
    const track = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08, // 4/4
      ...encodeVlq(0), 0x90, 60, 80,
      ...encodeVlq(480), 0x80, 60, 0,
      ...encodeVlq(0), 0xb0, 64, 127, // pedal start @ 480
      ...encodeVlq(0), 0x90, 62, 80,
      ...encodeVlq(480), 0x80, 62, 0,
      ...encodeVlq(0), 0x90, 64, 80,
      ...encodeVlq(480), 0x80, 64, 0,
      ...encodeVlq(0), 0x90, 65, 80,  // F4 on @ 1440
      ...encodeVlq(960), 0x80, 65, 0, // F4 off @ 2400 (crosses 1920 boundary into Measure 2!)
      ...encodeVlq(0), 0x90, 67, 80,  // G4 @ 2400..2880
      ...encodeVlq(480), 0x80, 67, 0,
      ...encodeVlq(960), 0x80, 67, 0, // pad to 3840? Wait: use rest/note to reach 3840
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];
    const svg = makeSingleMeasureSvg();
    const midiBuf = buildSmf(ppq, [track]);

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg], midiBuf, { totalPages: 2 });
    expect(diagnostics.measuresAligned).toBe(1);
    expect(diagnostics.fallbackMeasures).toBe(1);

    // Measure 1 should explicitly close the open pedal at the SVG/fallback boundary
    const m1Match = xml.match(/<measure number="1">[\s\S]*?<\/measure>/);
    expect(m1Match).not.toBeNull();
    expect(m1Match![0]).toContain('<pedal type="start"');
    expect(m1Match![0]).toContain('<pedal type="stop"');

    // Cross-boundary tie F4 should be paired: start in M1, stop in M2
    const score = parseMusicXml(xml, domDeps);
    expect(score.measureCount).toBe(2);
    const f4Notes = score.noteEvents.filter((n) => n.midi === 65);
    expect(f4Notes).toHaveLength(2);
    expect(f4Notes[0].isTieStart).toBe(true);
    expect(f4Notes[1].isTieStop).toBe(true);
    expect(score.pedalIntervals).toBeDefined();
    expect(score.pedalIntervals!.length).toBeGreaterThanOrEqual(1);
    expect(score.pedalIntervals![0].endTick).toBeLessThanOrEqual(1920);
  });

  it("explicitly closes open <slur>, <wedge>, <pedal>, and unpaired <tie> across SVG/fallback boundary in unified MusicXML builder", () => {
    const model: ScoreBuildModel = {
      title: "Spanner Boundary Test",
      divisions: 480,
      staves: 1,
      measures: [
        {
          number: "1",
          duration: 1920,
          attributes: { divisions: 480, fifths: 0, mode: "major", beats: 4, beatType: 4, staves: 1 },
          pedals: [{ tickOffset: 0, type: "start", staff: 1 }],
          wedges: [{ tickOffset: 480, type: "crescendo", staff: 1 }],
          notes: [
            {
              kind: "note",
              onsetOffset: 0,
              pitch: { step: "C", octave: 4 },
              duration: 960,
              voice: "1",
              staff: 1,
              type: "half",
              slurStart: true,
              slurNumber: 1,
            },
            {
              kind: "note",
              onsetOffset: 960,
              pitch: { step: "D", octave: 4 },
              duration: 960,
              voice: "1",
              staff: 1,
              type: "half",
              tieStart: true, // unpaired at boundary (M2 has E4, not D4)
            },
          ],
        },
        {
          number: "2",
          duration: 1920,
          notes: [
            {
              kind: "note",
              onsetOffset: 0,
              pitch: { step: "E", octave: 4 },
              duration: 1920,
              voice: "1",
              staff: 1,
              type: "whole",
            },
          ],
        },
      ],
    };

    closeBoundarySpanners(model.measures, [false, true]);
    const xml = buildMusicXml(model);

    const m1Match = xml.match(/<measure number="1">[\s\S]*?<\/measure>/);
    expect(m1Match).not.toBeNull();
    expect(m1Match![0]).toContain('<slur type="start" number="1"/>');
    expect(m1Match![0]).toContain('<slur type="stop" number="1"/>');
    expect(m1Match![0]).toContain('<wedge type="crescendo"/>');
    expect(m1Match![0]).toContain('<wedge type="stop"/>');
    expect(m1Match![0]).toContain('<pedal type="start"');
    expect(m1Match![0]).toContain('<pedal type="stop"');
    expect(m1Match![0]).not.toContain('<tie type="start"/>');

    const score = parseMusicXml(xml, domDeps);
    expect(score.measureCount).toBe(2);
    expect(score.noteEvents).toHaveLength(3);
    expect(score.pedalIntervals).toHaveLength(1);
    expect(score.pedalIntervals![0]).toMatchObject({ startTick: 0, endTick: 1920 });
  });
});
