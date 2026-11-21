import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { parseMs4Svg } from "../src/musescore/svgParser";
import { svgsAndMidiToMusicXml } from "../src/musescore";
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

describe("MS4 mid-measure clefs, octave shifts (8va/8vb/15ma/15mb), and ornament expansions", () => {
  it("recognizes mid-measure clef changes, applies them to subsequent noteheads, and emits <clef> at exact musical offset", () => {
    // Staff 1: topY=100, bottomY=180, staffSpace=20 (lines at 100,120,140,160,180)
    // Initial G-clef at x=60 (height=130 -> 6.5 * ss)
    // Note 1: x=200, y=200 (C4 in G-clef)
    // Mid-measure F-clef at x=300 (height=50 -> 2.5 * ss, 0.8x scale)
    // Note 2: x=400, y=150 (C3 in F-clef; would be A4 in G-clef)
    // Note 3: x=550, y=110 (G3 in F-clef; would be E5 in G-clef)
    // Mid-measure G-clef at x=650 (height=104 -> 5.2 * ss, 0.8x scale)
    // Note 4: x=750, y=200 (C4 in G-clef)
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 1000 400" xmlns="http://www.w3.org/2000/svg">
  ${[100, 120, 140, 160, 180].map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`).join("\n  ")}
  <polyline class="BarLine" points="50,100 50,180" />
  <polyline class="BarLine" points="950,100 950,180" />
  <path class="Clef" d="M60,75 L90,75 L90,205 L60,205 Z"/>
  <path class="Note" d="M190,192 L210,192 L210,208 L190,208 Z"/>
  <path class="Clef" transform="matrix(0.8,0,0,0.8,300,100)" d="M0,0 L40,0 L40,62.5 L0,62.5 Z"/>
  <path class="Note" d="M390,142 L410,142 L410,158 L390,158 Z"/>
  <path class="Note" d="M540,102 L560,102 L560,118 L540,118 Z"/>
  <path class="Clef" transform="matrix(0.8,0,0,0.8,650,75)" d="M0,0 L35,0 L35,130 L0,130 Z"/>
  <path class="Note" d="M740,192 L760,192 L760,208 L740,208 Z"/>
</svg>`;

    const page = parseMs4Svg(svg, 0);
    const ordered = [...page.noteheads].sort((a, b) => a.cx - b.cx);
    expect(ordered.map((n) => `${n.step}${n.octave}`)).toEqual(["C4", "C3", "G3", "C4"]);

    const ppq = 480;
    const track = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
      ...encodeVlq(0), 0x90, 60, 80,
      ...encodeVlq(480), 0x80, 60, 0,
      ...encodeVlq(0), 0x90, 48, 80,
      ...encodeVlq(480), 0x80, 48, 0,
      ...encodeVlq(0), 0x90, 55, 80,
      ...encodeVlq(480), 0x80, 55, 0,
      ...encodeVlq(0), 0x90, 60, 80,
      ...encodeVlq(480), 0x80, 60, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg], buildSmf(ppq, [track]));
    expect(diagnostics.some((d) => d.code === "ALIGNMENT_ALTER_OUT_OF_RANGE")).toBe(false);

    // Mid-measure clef changes emitted at exact musical offset (after 1st quarter, and after 3rd quarter)
    expect(xml).toContain('<clef number="1">\n          <sign>F</sign>\n          <line>4</line>\n        </clef>');
    const docXml = new domDeps.DOMParser().parseFromString(xml, "application/xml");
    const m1Children = Array.from(docXml.querySelector("measure")?.children ?? []).map((el) => el.tagName);
    // Expected order: attributes (initial), note (C4), attributes (F-clef), note (C3), note (G3), attributes (G-clef), note (C4)
    expect(m1Children).toEqual([
      "attributes",
      "note",
      "attributes",
      "note",
      "note",
      "attributes",
      "note",
    ]);

    const scoreDoc = parseMusicXml(xml, domDeps);
    expect(scoreDoc.noteEvents.map((n) => n.midi)).toEqual([60, 48, 55, 60]);
  });

  it("extracts 8va, 8vb, 15ma, and 15mb octave-shift markings, emits <octave-shift>, and solves enharmonic pitches without |alter| > 2", () => {
    // Staff 1: topY=100, bottomY=180, ss=20. Written C5 (y=130), E5 (y=110), C5 (y=130), G4 (y=160)
    // Staff 2: topY=300, bottomY=380, ss=20. Written C3 (y=350), C3 (y=350)
    // Above Staff 1 (y ~ 55..80):
    //   8va at x=190..380: path '8' width=25 height=32 (w/h=0.78) + polyline x=220..380
    //   15ma at x=490..600: path '15' width=46 height=32 (w/h=1.44) + polyline x=540..600
    // Below Staff 2 (y ~ 405..430):
    //   8vb at x=190..380: path '8' width=25 height=32 + polyline x=220..380
    //   15mb at x=490..600: path '15' width=46 height=32 + polyline x=540..600
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 1000 500" xmlns="http://www.w3.org/2000/svg">
  ${[100, 120, 140, 160, 180].map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`).join("\n  ")}
  ${[300, 320, 340, 360, 380].map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`).join("\n  ")}
  <polyline class="BarLine" points="50,100 50,380" />
  <polyline class="BarLine" points="950,100 950,380" />
  <!-- 8va -->
  <path class="OttavaSegment" d="M190,48 L215,48 L215,80 L190,80 Z"/>
  <polyline class="OttavaSegment" points="220,52 380,52"/>
  <polyline class="OttavaSegment" points="380,52 380,72"/>
  <!-- 15ma -->
  <path class="OttavaSegment" d="M490,48 L536,48 L536,80 L490,80 Z"/>
  <polyline class="OttavaSegment" points="540,52 600,52"/>
  <polyline class="OttavaSegment" points="600,52 600,72"/>
  <!-- 8vb -->
  <path class="OttavaSegment" d="M190,400 L215,400 L215,432 L190,432 Z"/>
  <polyline class="OttavaSegment" points="220,428 380,428"/>
  <polyline class="OttavaSegment" points="380,428 380,408"/>
  <!-- 15mb -->
  <path class="OttavaSegment" d="M490,400 L536,400 L536,432 L490,432 Z"/>
  <polyline class="OttavaSegment" points="540,428 600,428"/>
  <polyline class="OttavaSegment" points="600,428 600,408"/>
  <!-- Staff 1 notes -->
  <path class="Note" d="M190,122 L210,122 L210,138 L190,138 Z"/>
  <path class="Note" d="M340,102 L360,102 L360,118 L340,118 Z"/>
  <path class="Note" d="M490,122 L510,122 L510,138 L490,138 Z"/>
  <path class="Note" d="M690,152 L710,152 L710,168 L690,168 Z"/>
  <!-- Staff 2 notes -->
  <path class="Note" d="M190,342 L210,342 L210,358 L190,358 Z"/>
  <path class="Note" d="M490,342 L510,342 L510,358 L490,358 Z"/>
</svg>`;

    const page = parseMs4Svg(svg, 0);
    expect(page.octaveShifts).toHaveLength(4);
    expect(page.octaveShifts.map((o) => ({ staff: o.staff, size: o.size, shift: o.shiftOctaves }))).toEqual([
      { staff: 1, size: 8, shift: 1 },
      { staff: 1, size: 15, shift: 2 },
      { staff: 2, size: 8, shift: -1 },
      { staff: 2, size: 15, shift: -2 },
    ]);

    const ppq = 480;
    // Track 0 (RH): C6 (84), E6 (88), C7 (96), G4 (67)
    const rhTrack = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
      ...encodeVlq(0), 0x90, 84, 80,
      ...encodeVlq(480), 0x80, 84, 0,
      ...encodeVlq(0), 0x90, 88, 80,
      ...encodeVlq(480), 0x80, 88, 0,
      ...encodeVlq(0), 0x90, 96, 80,
      ...encodeVlq(480), 0x80, 96, 0,
      ...encodeVlq(0), 0x90, 67, 80,
      ...encodeVlq(480), 0x80, 67, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];
    // Track 1 (LH): C2 (36) half, C1 (24) half
    const lhTrack = [
      ...encodeVlq(0), 0x91, 36, 80,
      ...encodeVlq(960), 0x81, 36, 0,
      ...encodeVlq(0), 0x91, 24, 80,
      ...encodeVlq(960), 0x81, 24, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg], buildSmf(ppq, [rhTrack, lhTrack]));
    expect(diagnostics.some((d) => d.code === "ALIGNMENT_ALTER_OUT_OF_RANGE")).toBe(false);

    expect(xml).toContain('<octave-shift type="down" size="8"/>');
    expect(xml).toContain('<octave-shift type="stop" size="8"/>');
    expect(xml).toContain('<octave-shift type="down" size="15"/>');
    expect(xml).toContain('<octave-shift type="stop" size="15"/>');
    expect(xml).toContain('<octave-shift type="up" size="8"/>');
    expect(xml).toContain('<octave-shift type="up" size="15"/>');

    const scoreDoc = parseMusicXml(xml, domDeps);
    const midis = scoreDoc.noteEvents.map((n) => n.midi).sort((a, b) => a - b);
    expect(midis).toEqual([24, 36, 67, 84, 88, 96]);
  });

  it("matches trill, tremolo, and turn MIDI note bursts as 1-to-N expansions onto their single printed SVG host note without breaking measure alignment", () => {
    // Staff 1: topY=100, bottomY=180, ss=20. C5 (y=130), D5 (y=120), E5 (y=110)
    // Staff 2: topY=300, bottomY=380, ss=20. C3 (y=350)
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 1000 500" xmlns="http://www.w3.org/2000/svg">
  ${[100, 120, 140, 160, 180].map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`).join("\n  ")}
  ${[300, 320, 340, 360, 380].map((y) => `<polyline class="StaffLines" points="50,${y} 950,${y}" />`).join("\n  ")}
  <polyline class="BarLine" points="50,100 50,380" />
  <polyline class="BarLine" points="950,100 950,380" />
  <!-- Trill above C5 (2 subpaths M, w=30 h=29, ratio=1.03) -->
  <path class="Ornament" d="M185,60 L200,60 L200,89 L185,89 Z M202,65 L215,65 L215,89 L202,89 Z"/>
  <!-- Turn above D5 (1 subpath M, w=36 h=18, ratio=2.0) -->
  <path class="Ornament" d="M382,70 L418,70 L418,88 L382,88 Z"/>
  <!-- Tremolo on E5 stem (2 subpaths M) -->
  <path class="TremoloSingleChord" d="M585,135 L610,125 L610,130 L585,140 Z M585,145 L610,135 L610,140 L585,150 Z"/>
  <!-- Notes -->
  <path class="Note" d="M190,122 L210,122 L210,138 L190,138 Z"/>
  <path class="Note" d="M390,112 L410,112 L410,128 L390,128 Z"/>
  <path class="Note" d="M590,102 L610,102 L610,118 L590,118 Z"/>
  <path class="Note" d="M190,342 L210,342 L210,358 L190,358 Z"/>
</svg>`;

    const page = parseMs4Svg(svg, 0);
    const s1Notes = page.noteheads.filter((n) => n.staff === 1).sort((a, b) => a.cx - b.cx);
    expect(s1Notes.map((n) => n.ornament)).toEqual([
      { kind: "trill" },
      { kind: "turn" },
      { kind: "tremolo", marks: 2 },
    ]);

    const ppq = 480;
    const rhTrack: number[] = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
    ];
    // Trill on C5 (72): 8 notes (72, 74, 72, 74, 72, 74, 72, 74), each 60 ticks (total 480)
    const trillPitches = [72, 74, 72, 74, 72, 74, 72, 74];
    let delta = 0;
    for (const p of trillPitches) {
      rhTrack.push(...encodeVlq(delta), 0x90, p, 80, ...encodeVlq(59), 0x80, p, 0);
      delta = 1;
    }
    // Turn on D5 (74): 4 notes (76, 74, 72, 74) -> 60, 60, 60, 300 (total 480)
    const turnSpec: Array<[number, number]> = [[76, 60], [74, 60], [72, 60], [74, 300]];
    for (const [p, d] of turnSpec) {
      rhTrack.push(...encodeVlq(delta), 0x90, p, 80, ...encodeVlq(d - 1), 0x80, p, 0);
      delta = 1;
    }
    // Tremolo on E5 (76): 8 notes of 76, each 120 ticks (total 960)
    for (let i = 0; i < 8; i++) {
      rhTrack.push(...encodeVlq(delta), 0x90, 76, 80, ...encodeVlq(119), 0x80, 76, 0);
      delta = 1;
    }
    rhTrack.push(...encodeVlq(0), 0xff, 0x2f, 0x00);

    const lhTrack = [
      ...encodeVlq(0), 0x91, 48, 80,
      ...encodeVlq(1919), 0x81, 48, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg], buildSmf(ppq, [rhTrack, lhTrack]));
    expect(diagnostics.some((d) => d.code === "ALIGNMENT_ALTER_OUT_OF_RANGE")).toBe(false);
    expect(xml).toContain("<trill-mark/>");
    expect(xml).toContain("<turn/>");
    expect(xml).toContain('<tremolo type="single">2</tremolo>');

    const scoreDoc = parseMusicXml(xml, domDeps);
    expect(scoreDoc.noteEvents).toHaveLength(4);
    expect(
      scoreDoc.noteEvents
        .filter((n) => n.staff === 1)
        .map((n) => ({ midi: n.midi, onsetTick: n.onsetTick, durationTick: n.durationTick }))
    ).toEqual([
      { midi: 72, onsetTick: 0, durationTick: 480 },
      { midi: 74, onsetTick: 480, durationTick: 480 },
      { midi: 76, onsetTick: 960, durationTick: 960 },
    ]);
  });

  it("verifies genuine MuseScore 4.7.6 fixture containing mid-measure clefs, 8va/8vb/15ma/15mb, and ornaments via svgsAndMidiToMusicXml and parseMusicXml", () => {
    const svg = readFileSync(resolve(FIXTURE_DIR, "06-clefs-octave-ornaments-p1.svg"), "utf8");
    const mid = readFileSync(resolve(FIXTURE_DIR, "06-clefs-octave-ornaments.mid"));

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg], mid);
    expect(diagnostics.some((d) => d.code === "ALIGNMENT_ALTER_OUT_OF_RANGE")).toBe(false);

    const scoreDoc = parseMusicXml(xml, domDeps);
    expect(scoreDoc.measureCount).toBe(3);
    expect(scoreDoc.noteEvents.filter((n) => n.staff === 1).map((n) => n.midi)).toEqual([
      // Measure 1: C4, C3, G3, C4
      60, 48, 55, 60,
      // Measure 2: C6 (8va), E6 (8va), C7 (15ma), G4
      84, 88, 96, 67,
      // Measure 3: C5 (trill), D5 (turn), E5 (tremolo)
      72, 74, 76,
    ]);
    expect(scoreDoc.noteEvents.filter((n) => n.staff === 2).map((n) => n.midi)).toEqual([
      // Measure 1: C3
      48,
      // Measure 2: C2 (8vb), C1 (15mb)
      36, 24,
      // Measure 3: C3
      48,
    ]);
  });

  it("emits sounding octave for grace notes under 8va octave shifts", () => {
    // Staff 1: topY=100, bottomY=180, ss=20. Written C5 (y=130) under 8va -> sounding C6 (MIDI 84).
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 600 300" xmlns="http://www.w3.org/2000/svg">
  ${[100, 120, 140, 160, 180].map((y) => `<polyline class="StaffLines" points="50,${y} 550,${y}" />`).join("\n  ")}
  <polyline class="BarLine" points="50,100 50,180" />
  <polyline class="BarLine" points="550,100 550,180" />
  <path class="Clef" d="M60,75 L90,75 L90,205 L60,205 Z"/>
  <path class="OttavaSegment" d="M180,48 L205,48 L205,80 L180,80 Z"/>
  <polyline class="OttavaSegment" points="210,52 350,52" />
  <path class="Note" d="M194,125 L206,125 L206,135 L194,135 Z"/>
  <path class="Note" d="M250,122 L270,122 L270,138 L250,138 Z"/>
</svg>`;

    const ppq = 480;
    const track = [
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
      ...encodeVlq(0), 0x90, 84, 80,
      ...encodeVlq(60), 0x80, 84, 0,
      ...encodeVlq(0), 0x90, 84, 80,
      ...encodeVlq(420), 0x80, 84, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const { xml, diagnostics } = svgsAndMidiToMusicXml([svg], buildSmf(ppq, [track]));
    expect(diagnostics.some((d) => d.code === "ALIGNMENT_ALTER_OUT_OF_RANGE")).toBe(false);

    const docXml = new domDeps.DOMParser().parseFromString(xml, "application/xml");
    const graceNotes = Array.from(docXml.querySelectorAll("note")).filter(
      (n) => n.querySelector("grace") !== null
    );
    expect(graceNotes).toHaveLength(1);
    expect(graceNotes[0].querySelector("pitch > step")?.textContent).toBe("C");
    expect(graceNotes[0].querySelector("pitch > octave")?.textContent).toBe("6");
  });
});
