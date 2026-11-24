import { describe, expect, it } from "vitest";
import { createMidiRingBuffer } from "../src/midi/midiRingBuffer";

const input = { channel: 0, portId: "piano", source: "midi" } as const;

describe("session MIDI capture", () => {
  it("retains the newest events and slices an inclusive time window in capture order", () => {
    const buffer = createMidiRingBuffer(4);
    buffer.push({ ...input, type: "noteon", midi: 60, velocity: 127, timeStampMs: 0 });
    const strike = { ...input, type: "noteon", midi: 61, velocity: 1, timeStampMs: 4.25 } as const;
    const halfPedal = { ...input, type: "sustain", value: 38, pressed: false, timeStampMs: 4.125 } as const;
    const release = { ...input, type: "noteoff", midi: 61, velocity: 0, timeStampMs: 4.25 } as const;
    const pedalUp = { ...input, type: "sustain", value: 0, pressed: false, timeStampMs: 4.5 } as const;
    for (const event of [strike, halfPedal, release, pedalUp]) buffer.push(event);

    expect(buffer.size()).toBe(4);
    expect(buffer.sliceWindow(4.125, 4.25)).toEqual([strike, halfPedal, release]);
    expect(buffer.sliceWindow(0, 4.5)).toEqual([strike, halfPedal, release, pedalUp]);
  });
});
