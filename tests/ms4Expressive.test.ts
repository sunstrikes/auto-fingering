import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { svgsAndMidiToMusicXml } from "../src/musescore";
import { parseMs4Svg } from "../src/musescore/svgParser";
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

/**
 * Helper to build a single-staff MS4 SVG (treble clef, top line F5 at y=100, staffSpace=20).
 * C4=y200, D4=y190, E4=y180, F4=y170, G4=y160, A4=y150, B4=y140.
 */
function makeSingleStaffMultiMeasureSvg(
  measureCount: number,
  bodyElements: string[],
  width = 1000
): string {
  const lines = [100, 120, 140, 160, 180]
    .map((y) => `<polyline class="StaffLines" points="50,${y} ${width - 50},${y}" />`)
    .join("\n");
  const measureWidth = (width - 100) / measureCount;
  const barlines = Array.from({ length: measureCount + 1 }, (_, i) => {
    const x = 50 + i * measureWidth;
    return `<polyline class="BarLine" points="${x},100 ${x},180" />`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 ${width} 400" xmlns="http://www.w3.org/2000/svg">
  ${lines}
  ${barlines}
  ${bodyElements.join("\n  ")}
</svg>`;
}

function notePath(x: number, y: number): string {
  return `<path class="Note" d="M${x - 10},${y - 8} L${x + 10},${y - 8} L${x + 10},${y + 8} L${x - 10},${y + 8} Z" />`;
}

describe("MS4 expressive notation: Slurs, Articulations, Dynamics & Hairpins (#6)", () => {
  it("emits <slur> start/stop for arcs spanning differing pitches or two distinct MIDI NoteOn events, while preserving true ties", () => {
    const ppq = 480;
    // Measure 1 (4/4):
    //   - Beat 1: C4 (60) quarter @ 0..480
    //   - Beat 2: E4 (64) quarter @ 480..960  [SlurSegment from C4 to E4: differing pitches]
    //   - Beat 3: G4 (67) quarter @ 960..1440
    //   - Beat 4: G4 (67) quarter @ 1440..1920 [TieSegment-class arc from G4 to G4, but TWO distinct MIDI NoteOn events -> must emit <slur>, NOT Tie Continuation!]
    // Measure 2 (4/4):
    //   - Beat 1-2: A4 (69) half @ 1920..2880 [SlurSegment across G4@m1 to A4@m2]
    //   - Beat 3-4: C5 (72) half @ 2880..3840
    const svg = makeSingleStaffMultiMeasureSvg(2, [
      // Measure 1 (x: 50..500)
      notePath(120, 200), // C4
      notePath(210, 180), // E4
      notePath(300, 160), // G4 #1
      notePath(390, 160), // G4 #2
      // Slur 1: C4 -> E4
      `<path class="SlurSegment" d="M120,215 C150,235 180,235 210,195" />`,
      // Arc labeled TieSegment between two distinct NoteOns on G4 -> must still be <slur>, not <tie>!
      `<path class="TieSegment" d="M300,175 C330,190 360,190 390,175" />`,
      // Measure 2 (x: 500..950)
      notePath(580, 150), // A4
      notePath(750, 130), // C5
      // Cross-measure slur: G4 #2 (390, 160) -> A4 (580, 150)
      `<path class="SlurSegment" d="M390,145 C450,125 520,125 580,135" />`,
    ]);

    const track = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08, // 4/4
      ...encodeVlq(0), 0x90, 60, 80,
      ...encodeVlq(480), 0x80, 60, 0,
      ...encodeVlq(0), 0x90, 64, 80,
      ...encodeVlq(480), 0x80, 64, 0,
      ...encodeVlq(0), 0x90, 67, 80,
      ...encodeVlq(480), 0x80, 67, 0,
      ...encodeVlq(0), 0x90, 67, 80,
      ...encodeVlq(480), 0x80, 67, 0,
      ...encodeVlq(0), 0x90, 69, 80,
      ...encodeVlq(960), 0x80, 69, 0,
      ...encodeVlq(0), 0x90, 72, 80,
      ...encodeVlq(960), 0x80, 72, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg], buildSmf(ppq, [track]));
    expect(diagnostics.some((d) => d.level === "error")).toBe(false);

    const doc = new dom.window.DOMParser().parseFromString(xml, "application/xml");
    const noteEls = Array.from(doc.querySelectorAll("measure > note"));
    expect(noteEls).toHaveLength(6);

    // None of these should be Tie Continuations
    expect(doc.querySelectorAll("tie, tied")).toHaveLength(0);

    // Note 0 (C4): slur start
    expect(noteEls[0].querySelector('notations > slur[type="start"]')).not.toBeNull();
    // Note 1 (E4): slur stop
    expect(noteEls[1].querySelector('notations > slur[type="stop"]')).not.toBeNull();
    // Note 2 (G4 #1): slur start (from TieSegment spanning two distinct NoteOns)
    expect(noteEls[2].querySelector('notations > slur[type="start"]')).not.toBeNull();
    // Note 3 (G4 #2): slur stop AND cross-measure slur start
    expect(noteEls[3].querySelector('notations > slur[type="stop"]')).not.toBeNull();
    expect(noteEls[3].querySelector('notations > slur[type="start"]')).not.toBeNull();
    // Note 4 (A4 in measure 2): slur stop
    expect(noteEls[4].querySelector('notations > slur[type="stop"]')).not.toBeNull();

    // Downstream parseMusicXml must ingest cleanly with zero Tie Continuations
    const score = parseMusicXml(xml, domDeps);
    expect(score.measureCount).toBe(2);
    expect(score.noteEvents).toHaveLength(6);
    expect(score.noteEvents.every((n) => !n.isTieStop && !n.isTieStart)).toBe(true);
  });

  it("extracts staccato, accent, tenuto, staccatissimo, and marcato articulations from MS4 SVG and preserves MIDI staccato separation", () => {
    // 1. Verify real MS4 fixture 03-repeats-span-p1.svg extraction
    const svg3 = readFileSync(resolve(FIXTURE_DIR, "03-repeats-span-p1.svg"), "utf8");
    const page3 = parseMs4Svg(svg3, 0);
    expect(page3.articulations.map((a) => a.kind)).toEqual(["accent", "staccato"]);

    // 2. End-to-end conversion with staccato (120-tick MIDI separation), accent, tenuto, marcato
    const ppq = 480;
    // staffSpace = 20
    const svg = makeSingleStaffMultiMeasureSvg(1, [
      notePath(150, 200), // C4 + staccato (small dot ~6x6)
      `<path class="Articulation" d="M147,215 C149,215 153,215 153,218 C153,221 147,221 147,218 Z" />`,
      notePath(350, 180), // E4 + accent (> ~28x16)
      `<path class="Articulation" d="M336,192 L364,200 L336,208 L336,205 L356,200 L336,195 Z" />`,
      notePath(550, 160), // G4 + tenuto (- ~24x3)
      `<path class="Articulation" d="M538,175 L562,175 L562,178 L538,178 Z" />`,
      notePath(750, 150), // A4 + marcato (^ ~20x22)
      `<path class="Articulation" d="M740,130 L750,108 L760,130 L756,130 L750,115 L744,130 Z" />`,
    ]);

    const track = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08, // 4/4
      ...encodeVlq(0), 0x90, 60, 85,   // C4 staccato on @ 0
      ...encodeVlq(120), 0x80, 60, 0,  // C4 off @ 120 (360-tick staccato separation!)
      ...encodeVlq(360), 0x90, 64, 90, // E4 on @ 480
      ...encodeVlq(480), 0x80, 64, 0,  // E4 off @ 960
      ...encodeVlq(0), 0x90, 67, 80,   // G4 on @ 960
      ...encodeVlq(480), 0x80, 67, 0,  // G4 off @ 1440
      ...encodeVlq(0), 0x90, 69, 95,   // A4 on @ 1440
      ...encodeVlq(480), 0x80, 69, 0,  // A4 off @ 1920
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg], buildSmf(ppq, [track]));
    expect(diagnostics.some((d) => d.level === "error")).toBe(false);

    const doc = new dom.window.DOMParser().parseFromString(xml, "application/xml");
    const noteEls = Array.from(doc.querySelectorAll("measure > note"));
    expect(noteEls).toHaveLength(4);

    // Staccato duration preserved (120 ticks, NOT stretched to 480)
    expect(noteEls[0].querySelector("duration")?.textContent).toBe("120");
    expect(noteEls[0].querySelector("notations > articulations > staccato")).not.toBeNull();
    expect(noteEls[1].querySelector("notations > articulations > accent")).not.toBeNull();
    expect(noteEls[2].querySelector("notations > articulations > tenuto")).not.toBeNull();
    expect(noteEls[3].querySelector("notations > articulations > strong-accent")).not.toBeNull();

    const score = parseMusicXml(xml, domDeps);
    expect(score.noteEvents).toHaveLength(4);
    expect(score.noteEvents[0].durationTick).toBe(120);
  });

  it("extracts dynamic markings (p, mp, mf, f, etc.) from MS4 SVG and emits <direction><direction-type><dynamics>", () => {
    // 1. Verify real MS4 fixture 03-repeats-span-p1.svg extraction
    const svg3 = readFileSync(resolve(FIXTURE_DIR, "03-repeats-span-p1.svg"), "utf8");
    const page3 = parseMs4Svg(svg3, 0);
    expect(page3.dynamics.map((d) => d.kind)).toEqual(["mf", "f"]);

    // 2. End-to-end conversion with p, mp, mf, f across 2 measures
    const ppq = 480;
    // staffSpace = 20
    // Dynamic letter dimensions in staffSpace units:
    //   m: w~1.5*ss (30), h~1.0*ss (20), 1 outer path
    //   p: w~1.4*ss (28), h~1.7*ss (34), outer path + inner counter hole path
    //   f: w~1.8*ss (36), h~2.4*ss (48), 1 outer path
    const svg = makeSingleStaffMultiMeasureSvg(2, [
      // Measure 1 (x: 50..500): C4 (p) @ 150, E4 (mp) @ 320
      notePath(150, 200),
      // p: outer (136..164, 210..244) + inner counter hole (145..156, 216..228)
      `<path class="Dynamic" d="M136,210 L164,210 L164,244 L136,244 Z M145,216 L156,216 L156,228 L145,228 Z" />`,
      notePath(320, 180),
      // mp: m (295..325, 215..235) + p outer (327..355, 210..244) + p hole (336..347, 216..228)
      `<path class="Dynamic" d="M295,215 L325,215 L325,235 L295,235 Z M327,210 L355,210 L355,244 L327,244 Z M336,216 L347,216 L347,228 L336,228 Z" />`,
      // Measure 2 (x: 500..950): G4 (mf) @ 580, C5 (f) @ 750
      notePath(580, 160),
      // mf: m (550..580, 215..235) + f (582..618, 205..253)
      `<path class="Dynamic" d="M550,215 L580,215 L580,235 L550,235 Z M582,205 L618,205 L618,253 L582,253 Z" />`,
      notePath(750, 130),
      // f: (732..768, 205..253)
      `<path class="Dynamic" d="M732,205 L768,205 L768,253 L732,253 Z" />`,
    ]);

    const track = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08, // 4/4
      ...encodeVlq(0), 0x90, 60, 45,
      ...encodeVlq(960), 0x80, 60, 0,
      ...encodeVlq(0), 0x90, 64, 60,
      ...encodeVlq(960), 0x80, 64, 0,
      ...encodeVlq(0), 0x90, 67, 80,
      ...encodeVlq(960), 0x80, 67, 0,
      ...encodeVlq(0), 0x90, 72, 105,
      ...encodeVlq(960), 0x80, 72, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg], buildSmf(ppq, [track]));
    expect(diagnostics.some((d) => d.level === "error")).toBe(false);

    const doc = new dom.window.DOMParser().parseFromString(xml, "application/xml");
    const dynamicsEls = Array.from(doc.querySelectorAll("measure > direction > direction-type > dynamics"));
    expect(dynamicsEls).toHaveLength(4);
    expect(dynamicsEls.map((el) => el.firstElementChild?.tagName)).toEqual(["p", "mp", "mf", "f"]);

    // Verify <direction> has <direction-type><dynamics>...</dynamics></direction-type> and <staff>
    for (const dynEl of dynamicsEls) {
      const dirEl = dynEl.parentElement!.parentElement!;
      expect(dirEl.getAttribute("placement")).toBe("below");
      expect(dirEl.querySelector("staff")?.textContent).toBe("1");
    }

    const score = parseMusicXml(xml, domDeps);
    expect(score.measureCount).toBe(2);
    expect(score.noteEvents).toHaveLength(4);
  });

  it("extracts crescendo/diminuendo hairpins from MS4 SVG and emits properly paired <wedge> elements", () => {
    // 1. Verify real MS4 fixture 03-repeats-span-p1.svg extraction
    const svg3 = readFileSync(resolve(FIXTURE_DIR, "03-repeats-span-p1.svg"), "utf8");
    const page3 = parseMs4Svg(svg3, 0);
    expect(page3.hairpins).toHaveLength(1);
    expect(page3.hairpins[0].kind).toBe("crescendo");

    // 2. End-to-end conversion with crescendo in m1 and cross-measure diminuendo from m1 to m2
    const ppq = 480;
    const svg = makeSingleStaffMultiMeasureSvg(2, [
      // Measure 1 (x: 50..500): C4 @ 120, E4 @ 300
      notePath(120, 200),
      notePath(300, 180),
      // Crescendo (<): apex at left (120, 220), open mouth at right (290, 210) & (290, 230)
      `<polyline class="HairpinSegment" points="290,230 120,220 290,210" />`,
      // Measure 2 (x: 500..950): G4 @ 580, C5 @ 780
      notePath(580, 160),
      notePath(780, 130),
      // Cross-measure Diminuendo (>): open mouth at left (320, 210) & (320, 230), apex at right (780, 220)
      `<polyline class="HairpinSegment" points="320,210 780,220 320,230" />`,
    ]);

    const track = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08, // 4/4
      ...encodeVlq(0), 0x90, 60, 60,
      ...encodeVlq(960), 0x80, 60, 0,
      ...encodeVlq(0), 0x90, 64, 80,
      ...encodeVlq(960), 0x80, 64, 0,
      ...encodeVlq(0), 0x90, 67, 90,
      ...encodeVlq(960), 0x80, 67, 0,
      ...encodeVlq(0), 0x90, 72, 50,
      ...encodeVlq(960), 0x80, 72, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg], buildSmf(ppq, [track]));
    expect(diagnostics.some((d) => d.level === "error")).toBe(false);

    const doc = new dom.window.DOMParser().parseFromString(xml, "application/xml");
    const wedges = Array.from(doc.querySelectorAll("measure > direction > direction-type > wedge"));
    expect(wedges).toHaveLength(4);

    expect(wedges[0].getAttribute("type")).toBe("crescendo");
    expect(wedges[1].getAttribute("type")).toBe("stop");
    expect(wedges[1].getAttribute("number")).toBe(wedges[0].getAttribute("number"));

    expect(wedges[2].getAttribute("type")).toBe("diminuendo");
    expect(wedges[3].getAttribute("type")).toBe("stop");
    expect(wedges[3].getAttribute("number")).toBe(wedges[2].getAttribute("number"));

    // Cross-measure diminuendo: start in measure 1, stop in measure 2
    const measures = Array.from(doc.querySelectorAll("measure"));
    expect(measures[0].querySelectorAll('wedge[type="crescendo"]')).toHaveLength(1);
    expect(measures[0].querySelectorAll('wedge[type="diminuendo"]')).toHaveLength(1);
    expect(measures[1].querySelectorAll('wedge[type="stop"]')).toHaveLength(1);

    const score = parseMusicXml(xml, domDeps);
    expect(score.measureCount).toBe(2);
    expect(score.noteEvents).toHaveLength(4);
  });
});
