import { describe, expect, it } from "vitest";
import { parseMidiMessage } from "../src/midi/webMidi";

describe("parseMidiMessage timestamps", () => {
  it.each([
    [[0x90, 60, 75], 0, { type: "noteon", velocity: 75 }],
    [[0x90, 60, 0], 1.25, { type: "noteoff", velocity: 0 }],
    [[0x80, 60, 12], 2.5, { type: "noteoff", velocity: 0 }],
    [[0xb0, 64, 42], 3.75, { type: "sustain", value: 42, pressed: false }],
  ] as const)("preserves the clock value in packet %j", (packet, timeStampMs, expected) => {
    expect(parseMidiMessage(new Uint8Array(packet), "test", "midi", timeStampMs))
      .toMatchObject({ ...expected, timeStampMs });
  });

  it("omits the optional field for legacy inputs and invalid timestamps", () => {
    const packet = [0x90, 60, 75];
    expect(parseMidiMessage(packet, "test", "qwerty")).not.toHaveProperty("timeStampMs");
    expect(parseMidiMessage(packet, "test", "midi", NaN)).not.toHaveProperty("timeStampMs");
  });
});
