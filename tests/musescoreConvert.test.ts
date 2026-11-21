import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { svgsAndMidiToMusicXml } from "../src/musescore";
import { parseMusicXml } from "../src/musicxml/parser";

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

function buildSmf(ppq: number, tracks: number[][], format = 1): Uint8Array {
  const header = [
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    (format >> 8) & 0xff, format & 0xff,
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

describe("svgsAndMidiToMusicXml (MIDI-only fallback seam)", () => {
  it("converts complex piano MIDI with empty svgPages into valid MusicXML 4.0 and parses cleanly via parseMusicXml", () => {
    const ppq = 480;
    // Pickup (480 ticks = 1 beat in 4/4, signaled by timeSig at tick 480)
    // Measure 1 (4/4, ticks 480..2400):
    //   - Tempo 120 BPM at 0, Tempo 90 BPM at 1440 (mid-measure 1!)
    //   - Key sig G major (1 sharp) at 0, D major (2 sharps) at 2400 (measure 2)
    //   - Time sig 3/4 at 2400 (measure 2: ticks 2400..3840)
    const metaTrack = [
      ...encodeVlq(0), 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,       // 120 BPM @ 0
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08, // 4/4 @ 0
      ...encodeVlq(0), 0xff, 0x59, 0x02, 0x01, 0x00,             // G major @ 0
      ...encodeVlq(480), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08, // 4/4 @ 480 (ends 1-beat pickup)
      ...encodeVlq(960), 0xff, 0x51, 0x03, 0x0a, 0x2c, 0x2b,     // ~90 BPM @ 1440
      ...encodeVlq(960), 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08, // 3/4 @ 2400
      ...encodeVlq(0), 0xff, 0x59, 0x02, 0x02, 0x00,             // D major @ 2400
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    // RH Track:
    // - Pickup D5 at tick 0..480
    // - Staccato G4 at 480..580 (100 ticks), 20-tick rest (<= 30 ticks!), A4 at 600..960
    // - Simultaneous unison overlap: B4 at 960..1440 and B4 at 1200..1920
    // - Cross-measure tie: F#5 at 2160..2880 (crosses 2400 boundary into 3/4 measure 2)
    const rhTrack = [
      ...encodeVlq(0), 0x90, 74, 80,    // D5 on @ 0
      ...encodeVlq(480), 0x80, 74, 0,   // D5 off @ 480
      ...encodeVlq(0), 0x90, 67, 85,    // G4 on @ 480
      ...encodeVlq(100), 0x80, 67, 0,   // G4 off @ 580
      ...encodeVlq(20), 0x90, 69, 85,   // A4 on @ 600 (20-tick gap preserved!)
      ...encodeVlq(360), 0x80, 69, 0,   // A4 off @ 960
      ...encodeVlq(0), 0x90, 71, 75,    // B4 #1 on @ 960
      ...encodeVlq(240), 0x90, 71, 90,  // B4 #2 on @ 1200
      ...encodeVlq(240), 0x80, 71, 0,   // B4 #1 off @ 1440
      ...encodeVlq(480), 0x80, 71, 0,   // B4 #2 off @ 1920
      ...encodeVlq(240), 0x90, 78, 88,  // F#5 on @ 2160
      ...encodeVlq(720), 0x80, 78, 0,   // F#5 off @ 2880
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    // LH Track + CC64 sustain pedal:
    // - G2 at 480..2400
    // - Pedal start @ 480, change @ 1440, stop @ 2880
    const lhTrack = [
      ...encodeVlq(480), 0xb0, 64, 127, // pedal start @ 480
      ...encodeVlq(0), 0x90, 43, 70,    // G2 on @ 480
      ...encodeVlq(960), 0xb0, 64, 110, // pedal change @ 1440
      ...encodeVlq(960), 0x80, 43, 0,   // G2 off @ 2400
      ...encodeVlq(480), 0xb0, 64, 0,   // pedal stop @ 2880
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const midiBuffer = buildSmf(ppq, [metaTrack, rhTrack, lhTrack]);
    const { xml, diagnostics } = svgsAndMidiToMusicXml([], midiBuffer, {
      title: "Test Sonata",
    });

    expect(diagnostics.some((d) => d.level === "error")).toBe(false);
    expect(diagnostics.some((d) => d.code === "MIDI_ONLY_FALLBACK")).toBe(true);

    const score = parseMusicXml(xml, domDeps);
    expect(score.title).toBe("Test Sonata");
    expect(score.measureCount).toBe(3);

    // Pickup measure + 4/4 + 3/4
    expect(score.measureTimelines[0]).toMatchObject({
      measureIndex: 0,
      startTick: 0,
      endTick: 480,
      isPickup: true,
      timeBeats: 4,
      timeBeatType: 4,
    });
    expect(score.measureTimelines[1]).toMatchObject({
      measureIndex: 1,
      startTick: 480,
      endTick: 2400,
      isPickup: false,
      timeBeats: 4,
      timeBeatType: 4,
    });
    expect(score.measureTimelines[2]).toMatchObject({
      measureIndex: 2,
      startTick: 2400,
      endTick: 3840,
      isPickup: false,
      timeBeats: 3,
      timeBeatType: 4,
    });

    // Mid-piece tempo change
    expect(score.tempoPoints.length).toBeGreaterThanOrEqual(2);
    expect(score.tempoPoints[0].bpm).toBeCloseTo(120, 1);
    expect(score.tempoPoints[1].tick).toBe(1440);
    expect(score.tempoPoints[1].bpm).toBeCloseTo(90, 0);

    // Preserved short staccato G4 (100 ticks) and 20-tick rest before A4 (600)
    const g4 = score.noteEvents.find((n) => n.midi === 67);
    const a4 = score.noteEvents.find((n) => n.midi === 69);
    expect(g4).toBeDefined();
    expect(g4!.onsetTick).toBe(480);
    expect(g4!.durationTick).toBe(100);
    expect(a4).toBeDefined();
    expect(a4!.onsetTick).toBe(600);

    // Simultaneous unison B4s preserved as 2 separate notes
    const b4s = score.noteEvents.filter((n) => n.midi === 71);
    expect(b4s).toHaveLength(2);
    expect(b4s.map((n) => [n.onsetTick, n.durationTick])).toEqual([
      [960, 480],
      [1200, 720],
    ]);

    // Cross-measure tie on F#5
    const fSharp5 = score.noteEvents.filter((n) => n.midi === 78);
    expect(fSharp5).toHaveLength(2);
    expect(fSharp5[0].isTieStart).toBe(true);
    expect(fSharp5[1].isTieStop).toBe(true);

    // CC64 sustain pedal intervals (start @ 480, change @ 1440 -> freshPress: false, stop @ 2880)
    expect(score.pedalIntervals).toEqual([
      { startTick: 480, endTick: 1440, freshPress: true },
      { startTick: 1440, endTick: 2880, freshPress: false },
    ]);
  });

  it("handles single-track piano MIDI split by pitch and explicit pickupTicks option", () => {
    const ppq = 480;
    // Single track using running status, 1-beat pickup via options.pickupTicks = 480
    const track = [
      ...encodeVlq(0), 0x90, 64, 80,    // E4 (RH) @ 0..480
      ...encodeVlq(480), 64, 0,         // running status NoteOn vel=0 @ 480
      ...encodeVlq(0), 48, 75,          // C3 (LH) @ 480..1440
      ...encodeVlq(0), 72, 85,          // C5 (RH) @ 480..1440
      ...encodeVlq(960), 48, 0,         // C3 off @ 1440
      ...encodeVlq(0), 72, 0,           // C5 off @ 1440
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const { xml, diagnostics } = svgsAndMidiToMusicXml([], buildSmf(ppq, [track], 0), {
      pickupTicks: 480,
    });
    expect(diagnostics.some((d) => d.level === "error")).toBe(false);

    const score = parseMusicXml(xml, domDeps);
    expect(score.measureTimelines[0].isPickup).toBe(true);
    expect(score.measureTimelines[0].endTick).toBe(480);
    expect(score.noteEvents.find((n) => n.midi === 48)?.hand).toBe("LH");
    expect(score.noteEvents.find((n) => n.midi === 72)?.hand).toBe("RH");
  });
});
