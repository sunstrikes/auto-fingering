import { describe, expect, it } from "vitest";
import { parseRawMidi } from "../src/musescore/rawMidi";

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
    0x4d, 0x54, 0x68, 0x64, // MThd
    0x00, 0x00, 0x00, 0x06, // length 6
    (format >> 8) & 0xff, format & 0xff,
    (tracks.length >> 8) & 0xff, tracks.length & 0xff,
    (ppq >> 8) & 0xff, ppq & 0xff,
  ];
  const chunks: number[] = [...header];
  for (const trackData of tracks) {
    const len = trackData.length;
    chunks.push(
      0x4d, 0x54, 0x72, 0x6b, // MTrk
      (len >>> 24) & 0xff,
      (len >>> 16) & 0xff,
      (len >>> 8) & 0xff,
      len & 0xff,
      ...trackData
    );
  }
  return new Uint8Array(chunks);
}

describe("Raw MIDI truth layer (parseRawMidi)", () => {
  it("preserves raw onset ticks, durations, and <= 30 tick gaps without destructive merging", () => {
    const ppq = 480;
    // Note 1: tick 0..100 (short staccato)
    // Gap: 100..120 (20 ticks <= 30 ticks, must NOT be merged!)
    // Note 2: tick 120..240
    const track = [
      ...encodeVlq(0), 0x90, 60, 80,   // NoteOn C4 vel 80 at tick 0
      ...encodeVlq(100), 0x80, 60, 0,  // NoteOff C4 at tick 100
      ...encodeVlq(20), 0x90, 62, 95,  // NoteOn D4 vel 95 at tick 120
      ...encodeVlq(120), 0x90, 62, 0,  // NoteOn vel=0 (NoteOff) D4 at tick 240
      ...encodeVlq(0), 0xff, 0x2f, 0x00, // End of track
    ];

    const midi = parseRawMidi(buildSmf(ppq, [track]));

    expect(midi.ppq).toBe(480);
    expect(midi.notes).toHaveLength(2);
    expect(midi.notes[0]).toMatchObject({
      pitch: 60,
      startTick: 0,
      endTick: 100,
      durationTick: 100,
      velocity: 80,
      track: 0,
      channel: 0,
    });
    expect(midi.notes[1]).toMatchObject({
      pitch: 62,
      startTick: 120,
      endTick: 240,
      durationTick: 120,
      velocity: 95,
      track: 0,
      channel: 0,
    });
  });

  it("tracks simultaneous same-pitch NoteOn overlaps via per-(track, channel, pitch) FIFO queues", () => {
    const ppq = 480;
    // Channel 0: C4 at tick 0 (vel 70), second C4 at tick 120 (vel 90) before first ends!
    // First NoteOff C4 at tick 240 -> closes tick 0..240 (vel 70)
    // Second NoteOff C4 at tick 360 -> closes tick 120..360 (vel 90)
    // Channel 1: C4 at tick 60..300 (vel 64) -> separate channel queue!
    const track = [
      ...encodeVlq(0), 0x90, 60, 70,    // ch0 C4 on @ 0
      ...encodeVlq(60), 0x91, 60, 64,   // ch1 C4 on @ 60
      ...encodeVlq(60), 0x90, 60, 90,   // ch0 C4 on @ 120 (overlap!)
      ...encodeVlq(120), 0x80, 60, 0,   // ch0 C4 off @ 240 -> matches @ 0
      ...encodeVlq(60), 0x81, 60, 0,    // ch1 C4 off @ 300 -> matches @ 60
      ...encodeVlq(60), 0x80, 60, 0,    // ch0 C4 off @ 360 -> matches @ 120
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const midi = parseRawMidi(buildSmf(ppq, [track]));
    expect(midi.notes).toHaveLength(3);
    expect(midi.notes[0]).toMatchObject({
      pitch: 60,
      startTick: 0,
      endTick: 240,
      velocity: 70,
      channel: 0,
    });
    expect(midi.notes[1]).toMatchObject({
      pitch: 60,
      startTick: 60,
      endTick: 300,
      velocity: 64,
      channel: 1,
    });
    expect(midi.notes[2]).toMatchObject({
      pitch: 60,
      startTick: 120,
      endTick: 360,
      velocity: 90,
      channel: 0,
    });
  });

  it("extracts tempo, key signature, time signature, and CC64 sustain pedal start/change/stop events", () => {
    const ppq = 480;
    // Tempo 120 BPM = 500000 us/quarter = 0x07A120
    // Tempo 90 BPM = 666667 us/quarter = 0x0A2C2B
    // Time sig 3/4 at 0: 0x03 0x02 0x18 0x08
    // Time sig 4/4 at 1440: 0x04 0x02 0x18 0x08
    // Key sig D major (2 sharps) at 0: 0x02 0x00
    // Key sig Bb major (-2 flats) at 1440: 0xfe 0x00
    // CC64 pedal: 127 at 0 (start), 100 at 480 (change), 0 at 960 (stop)
    const metaTrack = [
      ...encodeVlq(0), 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08,
      ...encodeVlq(0), 0xff, 0x59, 0x02, 0x02, 0x00,
      ...encodeVlq(1440), 0xff, 0x51, 0x03, 0x0a, 0x2c, 0x2b,
      ...encodeVlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
      ...encodeVlq(0), 0xff, 0x59, 0x02, 0xfe, 0x00,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];
    const pianoTrack = [
      ...encodeVlq(0), 0xb0, 64, 127,
      ...encodeVlq(0), 0x90, 60, 80,
      ...encodeVlq(480), 0xb0, 64, 100,
      ...encodeVlq(480), 0xb0, 64, 0,
      ...encodeVlq(0), 0x80, 60, 0,
      ...encodeVlq(0), 0xff, 0x2f, 0x00,
    ];

    const midi = parseRawMidi(buildSmf(ppq, [metaTrack, pianoTrack]));

    expect(midi.tempos).toHaveLength(2);
    expect(midi.tempos[0].tick).toBe(0);
    expect(midi.tempos[0].bpm).toBeCloseTo(120, 4);
    expect(midi.tempos[1].tick).toBe(1440);
    expect(midi.tempos[1].bpm).toBeCloseTo(90, 2);

    expect(midi.timeSigs).toEqual([
      { tick: 0, numerator: 3, denominator: 4 },
      { tick: 1440, numerator: 4, denominator: 4 },
    ]);

    expect(midi.keySigs).toEqual([
      { tick: 0, fifths: 2, mode: "major" },
      { tick: 1440, fifths: -2, mode: "major" },
    ]);

    expect(midi.pedals).toEqual([
      { tick: 0, type: "start", value: 127, track: 1, channel: 0 },
      { tick: 480, type: "change", value: 100, track: 1, channel: 0 },
      { tick: 960, type: "stop", value: 0, track: 1, channel: 0 },
    ]);
  });
});
