import type { Finger, Hand, HandSpanProfile, SpanPreset } from "../domain/types";

const BLACK_SEMITONES = new Set([1, 3, 6, 8, 10]);

// Key positions within one octave of 7 white-key units (C = 0.5 .. B = 6.5)
const SEMITONE_TO_KEY_POS = [
  0.5,   // C
  0.928, // C# / Db
  1.5,   // D
  2.072, // D# / Eb
  2.5,   // E
  3.5,   // F
  3.916, // F# / Gb
  4.5,   // G
  5.0,   // G# / Ab
  5.5,   // A
  6.084, // A# / Bb
  6.5,   // B
];

const SEMITONE_TO_WHITE_INDEX = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const PITCH_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

/**
 * Format a MIDI note number as a concise pitch label (e.g. 60 -> "C4").
 */
export function midiToPitchLabel(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  return `${PITCH_NAMES[((midi % 12) + 12) % 12]}${octave}`;
}

export const MAX_OCTAVE_SPAN = 7.0;
export const MAX_OCTAVE_SEMITONES = 12;

export const SPAN_PRESET_SCALE: Record<SpanPreset, number> = {
  S: 0.82,
  M: 1.0,
  L: 1.18,
};

// Base maximum white-key span for profile "M" (from SPEC 4.2)
const BASE_MAX_SPAN: Record<string, number> = {
  "1,2": 5.5,
  "1,3": 6.5,
  "1,4": 7.2,
  "1,5": 8.3,
  "2,3": 2.7,
  "2,4": 4.6,
  "2,5": 6.0,
  "3,4": 2.4,
  "3,5": 4.3,
  "4,5": 2.6,
};

// Anatomical hard ceilings across all presets (hard-capped at pure octave = 7.0)
const MAX_SPAN_CEILING: Record<string, number> = {
  "1,2": 6.5,
  "1,3": 6.8,
  "1,4": 7.0,
  "1,5": 7.0,
  "2,3": 3.5,
  "2,4": 5.5,
  "2,5": 6.5,
  "3,4": 3.0,
  "3,5": 5.2,
  "4,5": 3.2,
};

export function isBlackKey(midi: number): boolean {
  return BLACK_SEMITONES.has(((midi % 12) + 12) % 12);
}

export function keyPos(midi: number): number {
  const octave = Math.floor(midi / 12) - 1;
  const semitone = ((midi % 12) + 12) % 12;
  return octave * 7 + SEMITONE_TO_KEY_POS[semitone];
}

export function whiteKeyIndex(midi: number): number {
  const octave = Math.floor(midi / 12) - 1;
  const semitone = ((midi % 12) + 12) % 12;
  return octave * 7 + SEMITONE_TO_WHITE_INDEX[semitone];
}

const D4_KEY_POS = keyPos(62);

/**
 * Map a MIDI pitch into a unified Right-Hand coordinate frame (ascending pitch
 * corresponds to ascending finger 1 -> 5). Left-hand pitches mirror around D4.
 */
export function toHandFramePos(midi: number, hand: Hand): number {
  const pos = keyPos(midi);
  return hand === "RH" ? pos : 2 * D4_KEY_POS - pos;
}

export function getSpanScale(profile: HandSpanProfile): number {
  return SPAN_PRESET_SCALE[profile.preset];
}

export function getMaxSpan(fLow: Finger, fHigh: Finger, scale: number): number {
  const a = Math.min(fLow, fHigh);
  const b = Math.max(fLow, fHigh);
  if (a === b) return 0;
  const key = `${a},${b}`;
  return Math.min((BASE_MAX_SPAN[key] ?? 8.3) * scale, MAX_SPAN_CEILING[key] ?? MAX_OCTAVE_SPAN);
}

export function getComfortSpan(fLow: Finger, fHigh: Finger, scale: number): number {
  const a = Math.min(fLow, fHigh);
  const b = Math.max(fLow, fHigh);
  if (a === b) return 0;
  return (BASE_MAX_SPAN[`${a},${b}`] ?? 8.3) * scale;
}
