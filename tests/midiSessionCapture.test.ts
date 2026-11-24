import { describe, expect, it, vi } from "vitest";
import { createMidiSessionCapture } from "../src/midi/midiSessionCapture";
import { createLocalMidiNoteEvent, createWebMidiController, type MIDIInputLike, type MidiInputEvent } from "../src/midi/webMidi";

const input = { channel: 0, portId: "piano", source: "midi" } as const;
const strike = { ...input, type: "noteon", midi: 60, velocity: 127, timeStampMs: 1 } as const;
const release = { ...input, type: "noteoff", midi: 60, velocity: 0, timeStampMs: 3 } as const;

it("isolates waiting and paused packets from continuous playback while retaining them within the bout", () => {
  const capture = createMidiSessionCapture();
  capture.record(strike);
  capture.setTransport("playing", false);
  capture.record(strike);
  expect(capture.sliceWindow(0, 10, { mode: "continuous" })).toEqual([]);

  capture.setTransport("playing", true);
  capture.record(strike);
  capture.setMode("waiting");
  capture.record({ ...strike, midi: 62, timeStampMs: 2 });
  capture.setTransport("paused", true);
  capture.record(release);
  capture.setTransport("playing", true);
  expect(capture.sliceWindow(0, 10, { mode: "continuous" })).toEqual([strike]);
  expect(capture.sliceWindow(0, 10, { mode: "waiting" })).toEqual([{ ...strike, midi: 62, timeStampMs: 2 }]);
  expect(capture.sliceWindow(0, 10, { mode: "waiting", transport: "paused" })).toEqual([release]);
  expect(capture.sliceWindow(0, 10, { mode: "continuous", transport: "paused" })).toEqual([]);

  capture.setTransport("stopped", true);
  capture.record(release);
  capture.setTransport("playing", true);
  expect(capture.sliceWindow(0, 10, { mode: "waiting", transport: "paused" })).toEqual([]);
  capture.record(strike);
  capture.setTransport("stopped", false);
  capture.record(release);
  expect(capture.sliceWindow(0, 10, { mode: "waiting" })).toEqual([]);
});

it("timestamps virtual and QWERTY strikes and releases before session capture", () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(4.25);
  try {
    expect(createLocalMidiNoteEvent("virtual", 60, 96)).toMatchObject({
      type: "noteon", source: "virtual", midi: 60, velocity: 96, timeStampMs: 4.25,
    });
    now.mockReturnValue(6.75);
    expect(createLocalMidiNoteEvent("qwerty", 60, 0)).toMatchObject({
      type: "noteoff", source: "qwerty", midi: 60, velocity: 0, timeStampMs: 6.75,
    });
  } finally { now.mockRestore(); }
});

describe("Web MIDI acquisition", () => {
  it("preserves hardware timestamps (including zero), strike velocity and every CC64 value", async () => {
    const piano: MIDIInputLike = { id: "piano", onmidimessage: null };
    const events: MidiInputEvent[] = [];
    const controller = createWebMidiController({
      requestMIDIAccess: async () => ({ inputs: new Map([[piano.id, piano]]), onstatechange: null }),
      onStateChange() {},
      onMidiEvent: (event) => events.push(event),
    });
    await controller.connect();
    piano.onmidimessage?.({ data: [0x93, 60, 127], timeStamp: 0 });
    piano.onmidimessage?.({ data: [0xb3, 64, 37], timeStamp: 1.125 });
    piano.onmidimessage?.({ data: [0xb3, 64, 63], timeStamp: 1.25 });
    piano.onmidimessage?.({ data: [0xb3, 64, 64], timeStamp: 1.375 });
    piano.onmidimessage?.({ data: [0x83, 60, 0], timeStamp: 2.0625 });
    piano.onmidimessage?.({ data: [0x93, 62, 1] });
    controller.dispose();

    expect(events).toMatchObject([
      { type: "noteon", midi: 60, velocity: 127, timeStampMs: 0, source: "midi", channel: 3 },
      { type: "sustain", value: 37, pressed: false, timeStampMs: 1.125 },
      { type: "sustain", value: 63, pressed: false, timeStampMs: 1.25 },
      { type: "sustain", value: 64, pressed: true, timeStampMs: 1.375 },
      { type: "noteoff", midi: 60, timeStampMs: 2.0625 },
      { type: "noteon", midi: 62, velocity: 1 },
    ]);
    expect(events[5]?.timeStampMs).toEqual(expect.any(Number));
  });
});
