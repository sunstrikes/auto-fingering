import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

interface Ms4FixtureEntry {
  id: string;
  title: string;
  totalPages: number;
  pages: Array<{
    path: string;
    format: "svg" | "png";
  }>;
  midiPath: string | null;
  expectedClasses?: string[];
}

interface Ms4FixtureManifest {
  generator: string;
  fixtures: Ms4FixtureEntry[];
}

const FIXTURE_DIR = resolve(__dirname, "../test-corpus/ms4-fixtures");

function loadManifest(): Ms4FixtureManifest {
  const raw = readFileSync(resolve(FIXTURE_DIR, "manifest.json"), "utf8");
  return JSON.parse(raw) as Ms4FixtureManifest;
}

describe("MS4 offline static fixture harness (no network access)", () => {
  it("loads manifest with all five required fixture categories", () => {
    const manifest = loadManifest();
    const ids = manifest.fixtures.map((f) => f.id);
    expect(ids).toEqual([
      "01-grand-staff",
      "02-fingerings",
      "03-repeats-span",
      "04-partial-preview",
      "05-png-asset",
    ]);
  });

  it("verifies SVG + MIDI pairs parse cleanly and preserve MS4 semantic classes", () => {
    const manifest = loadManifest();
    const dom = new JSDOM("");
    const parser = new dom.window.DOMParser();

    const svgFixtures = manifest.fixtures.filter((f) =>
      f.pages.some((p) => p.format === "svg")
    );
    expect(svgFixtures.length).toBeGreaterThanOrEqual(4);

    for (const fixture of svgFixtures) {
      expect(fixture.midiPath).toBeTruthy();
      const midiBuf = readFileSync(resolve(FIXTURE_DIR, fixture.midiPath!));
      // Standard MIDI File header: "MThd"
      expect(midiBuf.subarray(0, 4).toString("ascii")).toBe("MThd");
      expect(midiBuf.length).toBeGreaterThan(14);

      for (const page of fixture.pages) {
        expect(page.format).toBe("svg");
        const svgText = readFileSync(resolve(FIXTURE_DIR, page.path), "utf8");
        const doc = parser.parseFromString(svgText, "image/svg+xml");
        const svgEl = doc.querySelector("svg");
        expect(svgEl).not.toBeNull();
        expect(doc.querySelector("parsererror")).toBeNull();

        for (const cls of fixture.expectedClasses ?? []) {
          expect(
            doc.querySelectorAll(`.${cls}`).length,
            `fixture ${fixture.id} missing .${cls}`
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it("represents partial preview truncation where available SVG pages < totalPages", () => {
    const manifest = loadManifest();
    const partial = manifest.fixtures.find((f) => f.id === "04-partial-preview");
    expect(partial).toBeDefined();
    expect(partial!.totalPages).toBe(2);
    expect(partial!.pages.length).toBe(1);
  });

  it("loads the PNG-served page fixture with valid PNG signature", () => {
    const manifest = loadManifest();
    const pngFixture = manifest.fixtures.find((f) => f.id === "05-png-asset");
    expect(pngFixture).toBeDefined();
    expect(pngFixture!.pages).toHaveLength(1);
    expect(pngFixture!.pages[0].format).toBe("png");

    const pngBuf = readFileSync(resolve(FIXTURE_DIR, pngFixture!.pages[0].path));
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    expect(Array.from(pngBuf.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });
});
