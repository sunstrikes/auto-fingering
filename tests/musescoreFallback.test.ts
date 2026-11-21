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

describe("Strict SVG + MIDI Guard & Spanner Closure (No Pure-MIDI Fallback)", () => {
  it("rejects PNG-only binary asset without falling back to pure MIDI", () => {
    const pngBuf = readFileSync(resolve(FIXTURE_DIR, "05-png-asset-p1.png"));
    const midiBuf = makeTwoMeasureMidi();

    expect(() =>
      svgsAndMidiToMusicXml([pngBuf], midiBuf, {
        title: "PNG Only Score",
      })
    ).toThrow(/pure-MIDI fallback is disabled/);
  });

  it("rejects empty SVG array without falling back to pure MIDI", () => {
    const midiBuf = makeTwoMeasureMidi();
    expect(() => svgsAndMidiToMusicXml([], midiBuf)).toThrow(/No SVG pages provided/);
  });

  it("rejects mixed SVG + PNG pages when uncovered MIDI measures have no SVG", () => {
    const svg = makeSingleMeasureSvg();
    const pngBuf = readFileSync(resolve(FIXTURE_DIR, "05-png-asset-p1.png"));
    const midiBuf = makeTwoMeasureMidi();

    expect(() => svgsAndMidiToMusicXml([svg, pngBuf], midiBuf)).toThrow(
      /has no matching SVG measure; pure-MIDI reconstruction is disabled/
    );
  });

  it("rejects real 04-partial-preview fixture when uncovered MIDI measures lack SVG", () => {
    const svgP1 = readFileSync(resolve(FIXTURE_DIR, "04-partial-preview-p1.svg"), "utf8");
    const midiBuf = readFileSync(resolve(FIXTURE_DIR, "04-partial-preview.mid"));

    expect(() =>
      svgsAndMidiToMusicXml([svgP1], midiBuf, {
        title: "Partial Preview Fixture",
        totalPages: 2,
      })
    ).toThrow(/has no matching SVG measure; pure-MIDI reconstruction is disabled/);
  });

  it("rejects an empty SVG document (no staves) or binary-string PNG without falling back to pure MIDI", () => {
    const midiBuf = makeTwoMeasureMidi();
    const emptySvg = '<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"></svg>';
    expect(() => svgsAndMidiToMusicXml([emptySvg], midiBuf)).toThrow(
      /No musical staves found in SVG pages/
    );

    const pngStr = "\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR";
    expect(() => svgsAndMidiToMusicXml([pngStr], midiBuf)).toThrow(
      /No valid SVG pages could be parsed/
    );
  });

  it("emits LOW_CONFIDENCE_MEASURE warning for misaligned measures without falling back to pure MIDI", () => {
    const lines = [100, 120, 140, 160, 180]
      .map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`)
      .join("\n");
    const m1Notes = [
      { x: 120, y: 200 },
      { x: 210, y: 190 },
      { x: 300, y: 180 },
      { x: 390, y: 170 },
    ];
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

    expect(diagnostics.measuresAligned).toBe(2);
    expect(diagnostics.alignmentConfidence).toBeGreaterThan(0);
    expect(diagnostics.alignmentConfidence).toBeLessThan(1);
    expect(
      diagnostics.some(
        (d) => d.code === "LOW_CONFIDENCE_MEASURE" && d.measureNumber === 2
      )
    ).toBe(true);

    const score = parseMusicXml(xml, domDeps);
    expect(score.measureCount).toBe(2);
  });

  it("explicitly closes open <slur>, <wedge>, <pedal>, and unpaired <tie> at end of score", () => {
    const model: ScoreBuildModel = {
      title: "Spanner Closure Test",
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
              slurStarts: [1],
            },
            {
              kind: "note",
              onsetOffset: 960,
              pitch: { step: "D", octave: 4 },
              duration: 960,
              voice: "1",
              staff: 1,
              type: "half",
              tieStart: true,
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

    closeBoundarySpanners(model.measures);
    const xml = buildMusicXml(model);

    const m2Match = xml.match(/<measure number="2">[\s\S]*?<\/measure>/);
    expect(m2Match).not.toBeNull();
    expect(m2Match![0]).toContain('<slur type="stop" number="1"/>');
    expect(m2Match![0]).toContain('<wedge type="stop"/>');
    expect(m2Match![0]).toContain('<pedal type="stop"');
    expect(xml).not.toContain('<tie type="start"/>');

    const score = parseMusicXml(xml, domDeps);
    expect(score.measureCount).toBe(2);
    expect(score.noteEvents).toHaveLength(3);
    expect(score.pedalIntervals).toHaveLength(1);
    expect(score.pedalIntervals![0]).toMatchObject({ startTick: 0, endTick: 3840 });
  });

  it("closes multiple slurStarts at end of score and strips unmatched slurStops", () => {
    const model: ScoreBuildModel = {
      title: "Test",
      divisions: 480,
      staves: 1,
      measures: [
        {
          number: "1",
          duration: 1920,
          attributes: { divisions: 480, fifths: 0, mode: "major", beats: 4, beatType: 4, staves: 1 },
          notes: [
            {
              kind: "note",
              onsetOffset: 0,
              pitch: { step: "C", octave: 4 },
              duration: 960,
              voice: "1",
              staff: 1,
              type: "half",
              slurStarts: [1, 2],
            },
            {
              kind: "note",
              onsetOffset: 960,
              pitch: { step: "D", octave: 4 },
              duration: 960,
              voice: "1",
              staff: 1,
              type: "half",
              slurStops: [2],
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
              slurStops: [1],
            },
          ],
        },
      ],
    };

    closeBoundarySpanners(model.measures);
    const xml = buildMusicXml(model);
    const m1Match = xml.match(/<measure number="1">[\s\S]*?<\/measure>/);
    const m2Match = xml.match(/<measure number="2">[\s\S]*?<\/measure>/);
    expect(m1Match![0]).toContain('<slur type="start" number="1"/>');
    expect(m1Match![0]).toContain('<slur type="start" number="2"/>');
    expect(m1Match![0]).toContain('<slur type="stop" number="2"/>');
    expect(m2Match![0]).toContain('<slur type="stop" number="1"/>');
  });
});
