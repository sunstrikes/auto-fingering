import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSimulatedMidiHarness } from "../src/midi/simulatedMidiHarness";
import { createWebMidiController, type MidiInputEvent } from "../src/midi/webMidi";

async function connectHarness() {
  const harness = createSimulatedMidiHarness();
  const events: MidiInputEvent[] = [];
  const controller = createWebMidiController({
    requestMIDIAccess: harness.requestMIDIAccess,
    onStateChange: () => {},
    onMidiEvent: (event) => events.push(event),
  });
  await controller.connect();
  return { harness, events, controller };
}

describe("simulated performance through the Web MIDI controller", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("produces timed MIDI strikes with a stable velocity spread and quieter accompaniment", async () => {
    const { harness, events, controller } = await connectHarness();
    vi.advanceTimersByTime(10);
    harness.play(
      Array.from({ length: 12 }, (_, stepIndex) => ({
        stepIndex,
        onsetMs: stepIndex * 100,
        notes: [{ midi: 60, hand: "RH" }, { midi: 48, hand: "LH" }],
      })),
      { speedMultiplier: 2, entryLatencyMs: 21.25 }
    );
    vi.advanceTimersByTime(1_000);
    controller.dispose();

    const strikes = events.filter((event) => event.type === "noteon");
    const melody = strikes.filter((event) => event.midi === 60);
    const accompaniment = strikes.filter((event) => event.midi === 48);
    const sorted = melody.map((event) => event.velocity).sort((a, b) => a - b);
    expect(strikes).toHaveLength(24);
    expect(strikes.every((event) => event.source === "midi")).toBe(true);
    expect(melody.slice(0, 2).map((event) => event.timeStampMs)).toEqual([31.25, 81.25]);
    expect(sorted[8] - sorted[2]).toBeGreaterThanOrEqual(3);
    expect(Math.max(...accompaniment.map((event) => event.velocity))).toBeLessThan(sorted[0]);
    expect(events.filter((event) => event.type === "noteoff")).toHaveLength(24);
  });

  it("replays a deterministic fault script with microtiming, a missed step, a branch error and half-pedal values", async () => {
    const { harness, events, controller } = await connectHarness();
    harness.play([
      { stepIndex: 0, onsetMs: 0, notes: [{ midi: 60, hand: "RH" }, { midi: 48, hand: "LH" }] },
      { stepIndex: 1, onsetMs: 100, notes: [{ midi: 62, hand: "RH" }] },
      { stepIndex: 2, onsetMs: 200, notes: [{ midi: 64, hand: "RH" }] },
      { stepIndex: 3, onsetMs: 300, notes: [{ midi: 67, hand: "RH" }] },
    ], {
      speedMultiplier: 1,
      timingJitterMs: 4,
      entryLatencyMs: 20,
      wrongNoteAtSteps: { 2: 61 },
      missedStepIndices: [1],
      hesitationAtSteps: { 2: 37 },
      switchBranchOverrideMidis: [{ stepIndex: 2, midis: [72] }],
      sustainEvents: [{ offsetMs: 70.5, value: 23 }, { offsetMs: 72.25, value: 51 }, { offsetMs: 74, value: 127 }, { offsetMs: 450, value: 0 }],
    });
    vi.advanceTimersByTime(600);
    controller.dispose();

    const strikes = events.filter((event) => event.type === "noteon");
    expect(strikes.map(({ midi }) => midi)).toEqual([60, 48, 61, 72, 67]);
    expect(strikes[0].timeStampMs).toBe(20);
    expect(Math.abs(strikes[1].timeStampMs! - 20)).toBeGreaterThan(0);
    expect(Math.abs(strikes[3].timeStampMs! - 257)).toBeLessThanOrEqual(4);
    expect(Math.abs(strikes[4].timeStampMs! - 357)).toBeLessThanOrEqual(4);
    expect(events.filter((event) => event.type === "sustain")).toMatchObject([
      { value: 23, pressed: false, timeStampMs: 90.5 },
      { value: 51, pressed: false, timeStampMs: 92.25 },
      { value: 127, pressed: true, timeStampMs: 94 },
      { value: 0, pressed: false, timeStampMs: 470 },
    ]);
  });


  it("delivers notes in BLE bursts after the fixed input delay, with monotonic packet timestamps", async () => {
    const { harness, events, controller } = await connectHarness();
    harness.play([1.25, 4.5, 15.125, 19.25].map((onsetMs, stepIndex) => ({
      stepIndex, onsetMs, notes: [{ midi: 60 + stepIndex, hand: "RH" }],
    })), { speedMultiplier: 1, entryLatencyMs: 30.25, bleBurstIntervalMs: 10 });
    vi.advanceTimersByTime(200);
    controller.dispose();

    expect(events.filter((event) => event.type === "noteon").map((event) => event.timeStampMs))
      .toEqual([40.25, 40.25, 50.25, 50.25]);
    expect(events.map((event) => event.timeStampMs)).toEqual(
      events.map((event) => event.timeStampMs!).sort((a, b) => a - b)
    );
  });


  it("sends Piano Command Keys as hardware strikes and releases, including the simultaneous pause chord", async () => {
    const { harness, events, controller } = await connectHarness();
    for (const command of ["a0", "b0", "c8", "pause"] as const) {
      harness.sendCommand(command);
      vi.advanceTimersByTime(110);
    }
    controller.dispose();

    const strikes = events.filter((event) => event.type === "noteon");
    expect(strikes.map(({ midi, source }) => [midi, source])).toEqual(
      [21, 23, 108, 21, 22].map((midi) => [midi, "midi"])
    );
    expect(strikes[3].timeStampMs).toBe(strikes[4].timeStampMs);
    expect(events.filter((event) => event.type === "noteoff").map(({ midi }) => midi))
      .toEqual([21, 23, 108, 21, 22]);
  });


  it("releases active keys and half-pedal and cancels pending packets when stopped", async () => {
    const { harness, events, controller } = await connectHarness();
    harness.play([
      { stepIndex: 0, onsetMs: 0, notes: [{ midi: 60, hand: "RH", durationMs: 200 }] },
      { stepIndex: 1, onsetMs: 200, notes: [{ midi: 62, hand: "RH" }] },
    ], { speedMultiplier: 1, sustainEvents: [{ offsetMs: 0, value: 40 }] });
    vi.advanceTimersByTime(25);
    harness.stop();
    vi.advanceTimersByTime(500);
    controller.dispose();

    expect(events).toMatchObject([
      { type: "noteon", midi: 60, timeStampMs: 0 },
      { type: "sustain", value: 40, timeStampMs: 0 },
      { type: "noteoff", midi: 60, timeStampMs: 25 },
      { type: "sustain", value: 0, timeStampMs: 25 },
    ]);
  });

});
