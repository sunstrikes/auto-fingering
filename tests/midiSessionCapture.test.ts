import { describe, expect, it } from "vitest";
import { createMidiSessionCapture } from "../src/midi/midiSessionCapture";
import { createWebMidiController, type MIDIInputLike, type MidiInputEvent } from "../src/midi/webMidi";

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

it("clocks virtual and QWERTY input without changing its source or inventing a hardware timestamp", () => {
  const capture = createMidiSessionCapture(() => 4.25);
  capture.setTransport("playing", true);
  const { timeStampMs: _timestamp, ...unclocked } = strike;
  capture.record(unclocked);
  capture.record({ ...unclocked, source: "virtual", portId: "screen" });
  capture.record({ ...unclocked, source: "qwerty", portId: "keyboard" });
  expect(capture.sliceWindow(0, 10, { mode: "continuous" })).toEqual([
    { ...unclocked, source: "virtual", portId: "screen", timeStampMs: 4.25 },
    { ...unclocked, source: "qwerty", portId: "keyboard", timeStampMs: 4.25 },
  ]);
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
    expect(events[5]).not.toHaveProperty("timeStampMs");
  });
});
