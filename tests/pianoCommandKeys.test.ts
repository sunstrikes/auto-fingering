import { describe, expect, it } from "vitest";
import {
  PIANO_COMMAND_MIDI,
  createPianoCommandRouter,
  hasDualPitchConflict,
  routeKeyboardCommand,
} from "../src/guided/pianoCommandKeys";
import type { MidiInputEvent } from "../src/midi/webMidi";

function noteOn(midi: number, timeStampMs: number, velocity = 90): MidiInputEvent {
  return {
    type: "noteon",
    midi,
    velocity,
    channel: 0,
    portId: "sim-1",
    source: "midi",
    timeStampMs,
  };
}

function noteOff(midi: number, timeStampMs: number): MidiInputEvent {
  return {
    type: "noteoff",
    midi,
    velocity: 0,
    channel: 0,
    portId: "sim-1",
    source: "midi",
    timeStampMs,
  };
}

function sustain(pressed: boolean, timeStampMs: number): MidiInputEvent {
  return {
    type: "sustain",
    value: pressed ? 127 : 0,
    pressed,
    channel: 0,
    portId: "sim-1",
    source: "midi",
    timeStampMs,
  };
}

describe("pianoCommandKeys", () => {
  it("detects A0 + A#0 dual-pitch conflict only when both midi 21 and 22 exist in chunk", () => {
    expect(hasDualPitchConflict([60, 64, 67])).toBe(false);
    expect(hasDualPitchConflict([21, 60, 64])).toBe(false);
    expect(hasDualPitchConflict([22, 60, 64])).toBe(false);
    expect(hasDualPitchConflict([21, 22, 60])).toBe(true);
  });

  it("routes A0, B0, C8 and first target note in non-playing windows", () => {
    const router = createPianoCommandRouter();

    for (const phase of ["launch", "paused", "audiation", "summary"] as const) {
      expect(
        router.routeMidi(noteOn(PIANO_COMMAND_MIDI.A0, 100), {
          phase,
          firstTargetMidis: [60, 64],
          chunkMidis: [60, 64, 67],
          cc64CommandEnabled: false,
        }).action,
      ).toBe("replay-chunk");

      expect(
        router.routeMidi(noteOn(PIANO_COMMAND_MIDI.B0, 200), {
          phase,
          firstTargetMidis: [60, 64],
          chunkMidis: [60, 64, 67],
          cc64CommandEnabled: false,
        }).action,
      ).toBe("toggle-view");

      expect(
        router.routeMidi(noteOn(PIANO_COMMAND_MIDI.C8, 300), {
          phase,
          firstTargetMidis: [60, 64],
          chunkMidis: [60, 64, 67],
          cc64CommandEnabled: false,
        }).action,
      ).toBe("continue-next");

      expect(
        router.routeMidi(noteOn(60, 400), {
          phase,
          firstTargetMidis: [60, 64],
          chunkMidis: [60, 64, 67],
          cc64CommandEnabled: false,
        }).action,
      ).toBe("start-first-note");

      expect(
        router.routeMidi(noteOn(62, 500), {
          phase,
          firstTargetMidis: [60, 64],
          chunkMidis: [60, 64, 67],
          cc64CommandEnabled: false,
        }).action,
      ).toBe("none");
    }
  });

  it("handles micro-rest window: allows A0/B0/C8 and pulses gentle reminder on accidental notes", () => {
    const router = createPianoCommandRouter();
    expect(
      router.routeMidi(noteOn(PIANO_COMMAND_MIDI.C8, 100), {
        phase: "micro-rest",
        firstTargetMidis: [60],
        chunkMidis: [60, 62],
        cc64CommandEnabled: false,
      }).action,
    ).toBe("continue-next");

    expect(
      router.routeMidi(noteOn(60, 150), {
        phase: "micro-rest",
        firstTargetMidis: [60],
        chunkMidis: [60, 62],
        cc64CommandEnabled: false,
      }).action,
    ).toBe("micro-rest-reminder");
  });

  it("ignores single-key A0/B0/C8 during active play (stage0 / playing)", () => {
    const router = createPianoCommandRouter();
    for (const phase of ["stage0", "playing"] as const) {
      expect(
        router.routeMidi(noteOn(PIANO_COMMAND_MIDI.A0, 100), {
          phase,
          firstTargetMidis: [60],
          chunkMidis: [60, 62],
          cc64CommandEnabled: false,
        }).action,
      ).toBe("none");
      router.routeMidi(noteOff(PIANO_COMMAND_MIDI.A0, 120), {
        phase,
        firstTargetMidis: [60],
        chunkMidis: [60, 62],
        cc64CommandEnabled: false,
      });

      expect(
        router.routeMidi(noteOn(PIANO_COMMAND_MIDI.B0, 200), {
          phase,
          firstTargetMidis: [60],
          chunkMidis: [60, 62],
          cc64CommandEnabled: false,
        }).action,
      ).toBe("none");

      expect(
        router.routeMidi(noteOn(PIANO_COMMAND_MIDI.C8, 300), {
          phase,
          firstTargetMidis: [60],
          chunkMidis: [60, 62],
          cc64CommandEnabled: false,
        }).action,
      ).toBe("none");
    }
  });

  it("triggers emergency-pause on A0 + A#0 within chord window during active play, unless disabled by dual-pitch conflict", () => {
    const router = createPianoCommandRouter({ chordWindowMs: 150 });
    const ctx = {
      phase: "playing" as const,
      firstTargetMidis: [60],
      chunkMidis: [60, 62, 64],
      cc64CommandEnabled: false,
    };

    expect(router.routeMidi(noteOn(PIANO_COMMAND_MIDI.A0, 1000), ctx).action).toBe("none");
    expect(router.routeMidi(noteOn(PIANO_COMMAND_MIDI.A_SHARP_0, 1060), ctx).action).toBe(
      "emergency-pause",
    );

    // Release both and test reverse order outside vs inside window
    router.routeMidi(noteOff(PIANO_COMMAND_MIDI.A0, 1100), ctx);
    router.routeMidi(noteOff(PIANO_COMMAND_MIDI.A_SHARP_0, 1100), ctx);

    // Outside chord window after release -> no emergency pause
    expect(router.routeMidi(noteOn(PIANO_COMMAND_MIDI.A_SHARP_0, 2000), ctx).action).toBe("none");
    router.routeMidi(noteOff(PIANO_COMMAND_MIDI.A_SHARP_0, 2020), ctx);
    expect(router.routeMidi(noteOn(PIANO_COMMAND_MIDI.A0, 2250), ctx).action).toBe("none");
    router.routeMidi(noteOff(PIANO_COMMAND_MIDI.A0, 2260), ctx);

    // Reverse order within chord window -> emergency pause
    expect(router.routeMidi(noteOn(PIANO_COMMAND_MIDI.A_SHARP_0, 3000), ctx).action).toBe("none");
    expect(router.routeMidi(noteOn(PIANO_COMMAND_MIDI.A0, 3080), ctx).action).toBe(
      "emergency-pause",
    );

    // Auto-disabled when active chunk contains both midi 21 and 22
    const conflictCtx = {
      phase: "stage0" as const,
      firstTargetMidis: [21, 22],
      chunkMidis: [21, 22, 60],
      cc64CommandEnabled: false,
    };
    const conflictRouter = createPianoCommandRouter({ chordWindowMs: 150 });
    expect(conflictRouter.routeMidi(noteOn(PIANO_COMMAND_MIDI.A0, 4000), conflictCtx)).toEqual({
      action: "none",
      emergencyPauseDisabled: true,
    });
    expect(
      conflictRouter.routeMidi(noteOn(PIANO_COMMAND_MIDI.A_SHARP_0, 4030), conflictCtx),
    ).toEqual({
      action: "none",
      emergencyPauseDisabled: true,
    });
  });

  it("ignores CC64 sustain pedal unless opt-in cc64CommandEnabled is true", () => {
    const router = createPianoCommandRouter();

    expect(
      router.routeMidi(sustain(true, 100), {
        phase: "paused",
        firstTargetMidis: [60],
        chunkMidis: [60, 62],
        cc64CommandEnabled: false,
      }).action,
    ).toBe("none");

    expect(
      router.routeMidi(sustain(true, 200), {
        phase: "paused",
        firstTargetMidis: [60],
        chunkMidis: [60, 62],
        cc64CommandEnabled: true,
      }).action,
    ).toBe("continue-next");

    // Still ignored during active play so pedaling in musical passages never aborts play
    expect(
      router.routeMidi(sustain(true, 300), {
        phase: "playing",
        firstTargetMidis: [60],
        chunkMidis: [60, 62],
        cc64CommandEnabled: true,
      }).action,
    ).toBe("none");
  });

  it("routes parallel keyboard shortcuts Space, ArrowLeft, ArrowRight, F", () => {
    expect(
      routeKeyboardCommand(
        { key: " ", code: "Space", metaKey: false, ctrlKey: false, altKey: false, repeat: false },
        "playing",
      ),
    ).toBe("emergency-pause");

    expect(
      routeKeyboardCommand(
        { key: " ", code: "Space", metaKey: false, ctrlKey: false, altKey: false, repeat: false },
        "paused",
      ),
    ).toBe("continue-next");

    expect(
      routeKeyboardCommand(
        {
          key: "ArrowLeft",
          code: "ArrowLeft",
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          repeat: false,
        },
        "audiation",
      ),
    ).toBe("replay-chunk");

    expect(
      routeKeyboardCommand(
        {
          key: "ArrowRight",
          code: "ArrowRight",
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          repeat: false,
        },
        "micro-rest",
      ),
    ).toBe("continue-next");

    expect(
      routeKeyboardCommand(
        { key: "f", code: "KeyF", metaKey: false, ctrlKey: false, altKey: false, repeat: false },
        "summary",
      ),
    ).toBe("toggle-view");

    // Ignored during active play (except Space)
    expect(
      routeKeyboardCommand(
        {
          key: "ArrowLeft",
          code: "ArrowLeft",
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          repeat: false,
        },
        "stage0",
      ),
    ).toBe("none");
  });
});
