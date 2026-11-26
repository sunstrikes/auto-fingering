import type { MidiInputEvent } from "../midi/webMidi";

export const PIANO_COMMAND_MIDI = {
  A0: 21,
  A_SHARP_0: 22,
  B0: 23,
  C8: 108,
} as const;

export const DEFAULT_EMERGENCY_CHORD_WINDOW_MS = 150;

export type GuidedSessionPhase =
  | "idle"
  | "launch"
  | "stage0"
  | "playing"
  | "micro-rest"
  | "audiation"
  | "macro-rest"
  | "paused"
  | "suspended"
  | "summary";

export type PianoCommandAction =
  | "none"
  | "replay-chunk"
  | "toggle-view"
  | "continue-next"
  | "start-first-note"
  | "emergency-pause"
  | "micro-rest-reminder";

export interface PianoCommandRouteContext {
  phase: GuidedSessionPhase;
  firstTargetMidis: readonly number[];
  chunkMidis: Iterable<number>;
  cc64CommandEnabled: boolean;
}

export interface PianoCommandRouteResult {
  action: PianoCommandAction;
  emergencyPauseDisabled?: boolean;
}

export interface KeyboardCommandEventLike {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

const ACTIVE_PLAY_PHASES: ReadonlySet<GuidedSessionPhase> = new Set(["stage0", "playing"]);
const NON_PLAYING_COMMAND_PHASES: ReadonlySet<GuidedSessionPhase> = new Set([
  "launch",
  "paused",
  "micro-rest",
  "audiation",
  "macro-rest",
  "summary",
]);

/**
 * Returns true when the active MotorChunk legitimately uses both A0 (21) and A#0 (22),
 * requiring the A0+A#0 emergency pause chord to be auto-disabled to avoid false pauses.
 */
export function hasDualPitchConflict(chunkMidis: Iterable<number>): boolean {
  let hasA0 = false;
  let hasASharp0 = false;
  for (const midi of chunkMidis) {
    if (midi === PIANO_COMMAND_MIDI.A0) hasA0 = true;
    else if (midi === PIANO_COMMAND_MIDI.A_SHARP_0) hasASharp0 = true;
    if (hasA0 && hasASharp0) return true;
  }
  return false;
}

/**
 * Stateful router for 88-key PianoCommandKeys that handles dual-key A0+A#0 chord timing
 * during active play and single-key A0/B0/C8 + first-target-note shortcuts in ready windows.
 */
export function createPianoCommandRouter(options?: { chordWindowMs?: number }) {
  const chordWindowMs = options?.chordWindowMs ?? DEFAULT_EMERGENCY_CHORD_WINDOW_MS;
  let a0DownAtMs: number | null = null;
  let aSharp0DownAtMs: number | null = null;

  const resetChordState = () => {
    a0DownAtMs = null;
    aSharp0DownAtMs = null;
  };

  const routeMidi = (
    event: MidiInputEvent,
    context: PianoCommandRouteContext,
  ): PianoCommandRouteResult => {
    const dualPitchDisabled = hasDualPitchConflict(context.chunkMidis);

    if (event.type === "sustain") {
      if (
        context.cc64CommandEnabled &&
        event.pressed &&
        NON_PLAYING_COMMAND_PHASES.has(context.phase)
      ) {
        return { action: "continue-next" };
      }
      return { action: "none" };
    }

    if (event.type === "noteoff") {
      if (event.midi === PIANO_COMMAND_MIDI.A0) a0DownAtMs = null;
      if (event.midi === PIANO_COMMAND_MIDI.A_SHARP_0) aSharp0DownAtMs = null;
      return { action: "none" };
    }

    // Active play: single-key A0/B0/C8 ignored; A0+A#0 within chordWindowMs triggers pause
    if (ACTIVE_PLAY_PHASES.has(context.phase)) {
      if (event.midi === PIANO_COMMAND_MIDI.A0) {
        a0DownAtMs = event.timeStampMs;
        if (
          !dualPitchDisabled &&
          aSharp0DownAtMs !== null &&
          Math.abs(event.timeStampMs - aSharp0DownAtMs) <= chordWindowMs
        ) {
          resetChordState();
          return { action: "emergency-pause" };
        }
      } else if (event.midi === PIANO_COMMAND_MIDI.A_SHARP_0) {
        aSharp0DownAtMs = event.timeStampMs;
        if (
          !dualPitchDisabled &&
          a0DownAtMs !== null &&
          Math.abs(event.timeStampMs - a0DownAtMs) <= chordWindowMs
        ) {
          resetChordState();
          return { action: "emergency-pause" };
        }
      }
      return dualPitchDisabled ? { action: "none", emergencyPauseDisabled: true } : { action: "none" };
    }

    resetChordState();

    if (!NON_PLAYING_COMMAND_PHASES.has(context.phase)) {
      return { action: "none" };
    }

    if (event.midi === PIANO_COMMAND_MIDI.A0) {
      return { action: "replay-chunk" };
    }
    if (event.midi === PIANO_COMMAND_MIDI.B0) {
      return { action: "toggle-view" };
    }
    if (event.midi === PIANO_COMMAND_MIDI.C8) {
      return { action: "continue-next" };
    }

    if (context.phase === "micro-rest") {
      return { action: "micro-rest-reminder" };
    }

    if (
      context.phase !== "macro-rest" &&
      context.firstTargetMidis.includes(event.midi)
    ) {
      return { action: "start-first-note" };
    }

    return { action: "none" };
  };

  return {
    routeMidi,
    reset: resetChordState,
  };
}

/**
 * Parallel computer-keyboard / Bluetooth page-turner command router for Guided Session.
 */
export function routeKeyboardCommand(
  event: KeyboardCommandEventLike,
  phase: GuidedSessionPhase,
): PianoCommandAction {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) {
    return "none";
  }

  const isSpace = event.code === "Space" || event.key === " ";
  if (ACTIVE_PLAY_PHASES.has(phase)) {
    return isSpace ? "emergency-pause" : "none";
  }

  if (!NON_PLAYING_COMMAND_PHASES.has(phase)) {
    return "none";
  }

  if (isSpace || event.key === "ArrowRight") {
    return "continue-next";
  }
  if (event.key === "ArrowLeft") {
    return "replay-chunk";
  }
  if (event.key.toLowerCase() === "f") {
    return "toggle-view";
  }

  return "none";
}
