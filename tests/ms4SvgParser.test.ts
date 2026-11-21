import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseMs4Svg } from "../src/musescore/svgParser";

const FIXTURE_DIR = resolve(__dirname, "../test-corpus/ms4-fixtures");

describe("parseMs4Svg (MS4 semantic-first SVG parser)", () => {
  it("extracts systems, calibrated staffSpace, barlines, clefs, and diatonic noteheads from 01-grand-staff-p1.svg", () => {
    const svg = readFileSync(resolve(FIXTURE_DIR, "01-grand-staff-p1.svg"), "utf8");
    const page = parseMs4Svg(svg, 0);

    expect(page.systems).toHaveLength(1);
    const sys = page.systems[0];
    expect(sys.staves).toHaveLength(2);
    expect(sys.staves[0].staffNumber).toBe(1);
    expect(sys.staves[1].staffNumber).toBe(2);
    expect(sys.staves[0].staffSpace).toBeCloseTo(82.68, 1);
    expect(sys.staves[1].staffSpace).toBeCloseTo(82.68, 1);

    expect(sys.clefs[0].sign).toBe("G");
    expect(sys.clefs[1].sign).toBe("F");

    // 2 measures in 01-grand-staff-p1.svg
    expect(sys.measures).toHaveLength(2);

    // 27 noteheads total
    expect(page.noteheads).toHaveLength(27);

    // Measure 1, Staff 1: C4-E4-G4 chord, A4, G4, F4, E4
    const m1Staff1 = page.noteheads
      .filter((n) => n.measureIndex === 0 && n.staff === 1)
      .sort((a, b) => a.cx - b.cx || a.cy - b.cy);
    expect(m1Staff1.map((n) => `${n.step}${n.octave}`)).toEqual([
      "G4",
      "E4",
      "C4",
      "A4",
      "G4",
      "F4",
      "E4",
    ]);

    // Measure 1, Staff 2: C3, G3, E3, G3, F3, A3, C3
    const m1Staff2 = page.noteheads
      .filter((n) => n.measureIndex === 0 && n.staff === 2)
      .sort((a, b) => a.cx - b.cx || a.cy - b.cy);
    expect(m1Staff2.map((n) => `${n.step}${n.octave}`)).toEqual([
      "C3",
      "G3",
      "E3",
      "G3",
      "F3",
      "A3",
      "C3",
    ]);
  });

  it("flattens nested group and element transform matrices into absolute page coordinates", () => {
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 1000 1000" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(100, 200)">
    <g transform="scale(2, 2)">
      <polyline class="StaffLines" points="0,0 300,0" />
      <polyline class="StaffLines" points="0,10 300,10" />
      <polyline class="StaffLines" points="0,20 300,20" />
      <polyline class="StaffLines" points="0,30 300,30" />
      <polyline class="StaffLines" points="0,40 300,40" />
      <polyline class="BarLine" points="0,0 0,40" />
      <polyline class="BarLine" points="300,0 300,40" />
      <path class="Note" transform="translate(50, 20)" d="M-6,-5 L6,-5 L6,5 L-6,5 Z" />
    </g>
  </g>
</svg>`;

    const page = parseMs4Svg(svg, 0);
    expect(page.systems).toHaveLength(1);
    const staff = page.systems[0].staves[0];
    // 10 * 2 = 20 staffSpace; topY = 200 + 0 = 200; bottomY = 200 + 80 = 280
    expect(staff.staffSpace).toBeCloseTo(20, 4);
    expect(staff.topY).toBeCloseTo(200, 4);
    expect(staff.bottomY).toBeCloseTo(280, 4);

    expect(page.noteheads).toHaveLength(1);
    // (50 * 2 + 100, 20 * 2 + 200) = (200, 240) -> middle line (B4 in treble clef)
    expect(page.noteheads[0].cx).toBeCloseTo(200, 4);
    expect(page.noteheads[0].cy).toBeCloseTo(240, 4);
    expect(`${page.noteheads[0].step}${page.noteheads[0].octave}`).toBe("B4");
  });

  it("recovers staves, barlines, noteheads, stems, and beams via MS4 geometric fallback when semantic classes are stripped", () => {
    const svg = readFileSync(resolve(FIXTURE_DIR, "01-grand-staff-p1.svg"), "utf8");
    const stripped = svg.replace(/\sclass="[^"]*"/g, "");
    const page = parseMs4Svg(stripped, 0);

    expect(page.systems).toHaveLength(1);
    expect(page.systems[0].staves).toHaveLength(2);
    expect(page.systems[0].staves[0].staffSpace).toBeCloseTo(82.68, 1);
    expect(page.systems[0].measures).toHaveLength(2);
    expect(page.noteheads).toHaveLength(27);
    expect(page.stems.length).toBeGreaterThanOrEqual(22);
    expect(page.beams.length).toBeGreaterThanOrEqual(3);
  });

  it("extracts rests, ties, slurs, stems, and beams from 03-repeats-span-p1.svg and 04-partial-preview-p1.svg", () => {
    const svg3 = readFileSync(resolve(FIXTURE_DIR, "03-repeats-span-p1.svg"), "utf8");
    const page3 = parseMs4Svg(svg3, 0);
    expect(page3.rests).toHaveLength(1);
    expect(page3.arcs.filter((a) => a.kind === "tie")).toHaveLength(1);
    expect(page3.arcs.filter((a) => a.kind === "slur")).toHaveLength(1);
    expect(page3.keySigCount).toBeGreaterThan(0);
    expect(page3.timeSigCount).toBeGreaterThan(0);

    const svg4 = readFileSync(resolve(FIXTURE_DIR, "04-partial-preview-p1.svg"), "utf8");
    const page4 = parseMs4Svg(svg4, 0);
    expect(page4.systems).toHaveLength(6);
    expect(page4.noteheads).toHaveLength(175);
  });
});
