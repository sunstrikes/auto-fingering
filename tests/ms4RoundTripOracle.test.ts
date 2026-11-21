import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { svgsAndMidiToMusicXml } from "../src/musescore";
import { readMxlContainer } from "../src/musicxml/mxl";
import { parseMusicXml } from "../src/musicxml/parser";

const CORPUS_DIR = resolve(__dirname, "../test-corpus");
const FIXTURE_DIR = resolve(CORPUS_DIR, "ms4-fixtures");

const dom = new JSDOM();
const domDeps = {
  DOMParser: dom.window.DOMParser,
  XMLSerializer: dom.window.XMLSerializer,
};

function normalizeNotes(xml: string) {
  const score = parseMusicXml(xml, domDeps);
  const ppq = score.ticksPerQuarter;
  return {
    measureCount: score.measureCount,
    notes: score.noteEvents
      .map((n) => ({
        midi: n.midi,
        staff: n.staff,
        onsetQuarter: Math.round((n.onsetTick / ppq) * 1000) / 1000,
      }))
      .sort((a, b) => a.onsetQuarter - b.onsetQuarter || a.staff - b.staff || a.midi - b.midi),
  };
}

describe("MS4 Round-Trip Oracle corpus verification", () => {
  it("round-trips 01-single-staff-melody.musicxml via MuseScore 4 SVG + MIDI", () => {
    const truthXml = readFileSync(resolve(CORPUS_DIR, "01-single-staff-melody.musicxml"), "utf8");
    const svg = readFileSync(resolve(FIXTURE_DIR, "07-oracle-single-staff-p1.svg"), "utf8");
    const mid = readFileSync(resolve(FIXTURE_DIR, "07-oracle-single-staff.mid"));

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg], mid);
    expect(diagnostics.some((d) => d.level === "error")).toBe(false);
    expect(diagnostics.svgPagesParsed).toBe(1);

    const truth = normalizeNotes(truthXml);
    const converted = normalizeNotes(xml);
    expect(converted.measureCount).toBe(truth.measureCount);
    expect(converted.notes).toEqual(truth.notes);
  });

  it("round-trips 04-tie-cross-staff-compressed.mxl via MuseScore 4 SVG + MIDI", async () => {
    const mxlBuf = readFileSync(resolve(CORPUS_DIR, "04-tie-cross-staff-compressed.mxl"));
    const { xmlText: truthXml } = await readMxlContainer(mxlBuf, domDeps);
    const svg = readFileSync(resolve(FIXTURE_DIR, "08-oracle-tie-cross-staff-p1.svg"), "utf8");
    const mid = readFileSync(resolve(FIXTURE_DIR, "08-oracle-tie-cross-staff.mid"));

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg], mid);
    expect(diagnostics.some((d) => d.level === "error")).toBe(false);
    expect(diagnostics.svgPagesParsed).toBe(1);

    const truth = normalizeNotes(truthXml);
    const converted = normalizeNotes(xml);
    expect(converted.measureCount).toBe(truth.measureCount);
    expect(converted.notes.length).toBeGreaterThanOrEqual(8);
    // Core non-grace pitches from both staves are preserved
    const convertedMidis = new Set(converted.notes.map((n) => n.midi));
    for (const midi of [76, 72, 64, 60, 55, 48, 43]) {
      expect(convertedMidis.has(midi)).toBe(true);
    }
  });

  it("round-trips multi-page 05-realworld-wuchang.musicxml (4 SVG pages + MIDI)", () => {
    const truthXml = readFileSync(resolve(CORPUS_DIR, "05-realworld-wuchang.musicxml"), "utf8");
    const svgs = [1, 2, 3, 4].map((p) =>
      readFileSync(resolve(FIXTURE_DIR, `09-oracle-wuchang-p${p}.svg`), "utf8")
    );
    const mid = readFileSync(resolve(FIXTURE_DIR, "09-oracle-wuchang.mid"));

    const { xml, diagnostics } = svgsAndMidiToMusicXml(svgs, mid);
    expect(diagnostics.some((d) => d.level === "error")).toBe(false);
    expect(diagnostics.totalPages).toBe(4);
    expect(diagnostics.svgPagesParsed).toBe(4);
    expect(diagnostics.measuresAligned).toBeGreaterThan(0);

    const truth = normalizeNotes(truthXml);
    const converted = parseMusicXml(xml, domDeps);
    expect(converted.measureCount).toBe(truth.measureCount);
    expect(converted.noteEvents.length).toBeGreaterThan(0);
  });
});
