/**
 * Adapter and 26x5 token builder for `@lumikey/piano-fingering-model`.
 *
 * Token encoding (`buildTokens`, `isBlackKey`, `midiToPitchClass`) is adapted from
 * `@lumikey/piano-fingering-model` (MIT License, https://github.com/lumikey/piano-fingering-model).
 */
import type { Finger, Hand, OnsetSlice } from "../domain/types";
import {
  DEFAULT_PRIOR_LAMBDA,
  DEFAULT_PRIOR_PER_NOTE_CAP,
  type FingeringPrior,
  type PriorNoteInput,
  type PriorTable,
} from "./types";

const BLACK_KEY_OFFSETS = new Set([1, 4, 6, 9, 11]); // A#, C#, D#, F#, G# relative to A0 (MIDI 21)
const MIN_GRACE_DURATION_MS = 80;
const MIN_REGULAR_DURATION_MS = 100;

export interface LookaheadTokenNote {
  midi: number;
  /** Milliseconds from current note onset to future note onset (`>= 0`). */
  timeUntil: number;
  /** 0-based finger hint (`0..4` for fingers `1..5`), or `null` if unknown. */
  finger: number | null;
}

export function isBlackKeyFeature(midi: number): number {
  if (midi < 0) return -1.0;
  const keyIndex = midi - 21;
  return BLACK_KEY_OFFSETS.has(((keyIndex % 12) + 12) % 12) ? 1.0 : 0.0;
}

export function midiToPitchClassFeature(midi: number): number {
  if (midi < 0) return -1.0;
  const pitchClass = (((midi - 21) % 12) + 12) % 12;
  return pitchClass / 11.0;
}

/**
 * Build 26x5 input tokens for a single note prediction.
 * Returns a flat `Float32Array(130)` in row-major order, matching upstream `buildTokens`.
 *
 * - Tokens `0..4`: last note played by each finger `1..5` (`[midiOffset, timeSinceReleaseNorm, blackKey, 0.0, -1.0]`)
 * - Token `5`: current note (`[pitchClassNorm, 0.0, blackKey, 0.5, -1.0]`)
 * - Tokens `6..25`: next 20 lookahead notes (`[midiOffset, timeUntilNorm, blackKey, 1.0, fingerHintNorm]`)
 */
export function buildLumikeyTokens(
  currentMidi: number,
  fingerLastMidi: readonly number[],
  fingerLastTimeSec: readonly number[],
  lookaheadNotes: readonly LookaheadTokenNote[]
): Float32Array {
  const tokens = new Float32Array(26 * 5);

  for (let i = 0; i < 26; i++) {
    tokens[i * 5 + 4] = -1.0;
  }

  const refMidiNorm = (currentMidi - 21) / 87.0;

  // Previous tokens (0..4): one per finger
  for (let f = 0; f < 5; f++) {
    const offset = f * 5;
    const midi = fingerLastMidi[f];
    if (midi >= 0) {
      const midiNorm = (midi - 21) / 87.0;
      tokens[offset + 0] = midiNorm - refMidiNorm;
    } else {
      tokens[offset + 0] = -1.0;
    }

    if (fingerLastTimeSec[f] === Infinity) {
      tokens[offset + 1] = 1.0;
    } else {
      tokens[offset + 1] = Math.max(0.0, Math.min(fingerLastTimeSec[f], 10.0)) / 10.0;
    }

    tokens[offset + 2] = midi >= 0 ? isBlackKeyFeature(midi) : -1.0;
    tokens[offset + 3] = 0.0;
  }

  // Current token (index 5)
  const curOffset = 5 * 5;
  tokens[curOffset + 0] = midiToPitchClassFeature(currentMidi);
  tokens[curOffset + 1] = 0.0;
  tokens[curOffset + 2] = isBlackKeyFeature(currentMidi);
  tokens[curOffset + 3] = 0.5;

  // Lookahead tokens (indices 6..25)
  for (let j = 0; j < 20; j++) {
    const tOffset = (6 + j) * 5;
    if (j < lookaheadNotes.length) {
      const ln = lookaheadNotes[j];
      const midi = ln.midi;
      if (midi >= 0) {
        const midiNorm = (midi - 21) / 87.0;
        tokens[tOffset + 0] = midiNorm - refMidiNorm;
      } else {
        tokens[tOffset + 0] = -1.0;
      }

      if (ln.timeUntil < 0) {
        tokens[tOffset + 1] = -1.0;
      } else {
        tokens[tOffset + 1] = Math.min(ln.timeUntil / 1000.0, 10.0) / 10.0;
      }

      tokens[tOffset + 2] = midi >= 0 ? isBlackKeyFeature(midi) : -1.0;
      tokens[tOffset + 3] = 1.0;

      if (ln.finger !== null && ln.finger >= 0 && ln.finger <= 4) {
        tokens[tOffset + 4] = ln.finger / 4.0;
      } else {
        tokens[tOffset + 4] = -1.0;
      }
    } else {
      tokens[tOffset + 0] = -1.0;
      tokens[tOffset + 1] = -1.0;
      tokens[tOffset + 2] = -1.0;
      tokens[tOffset + 3] = -1.0;
      tokens[tOffset + 4] = -1.0;
    }
  }

  return tokens;
}

/**
 * Converts `OnsetSlice[]` for a given `hand` into an ordered `PriorNoteInput[]`
 * sorted by `(timeMs, midi)` (chord notes lowest-to-highest).
 */
export function slicesToPriorNotes(
  onsetSlices: readonly OnsetSlice[],
  hand: Hand,
  ignoreExistingFingerings = false
): PriorNoteInput[] {
  const notes: PriorNoteInput[] = [];

  for (const slice of onsetSlices) {
    if (slice.hand !== hand) continue;
    const baseTimeMs = Math.max(0, slice.onsetSec * 1000);
    // Sort notes within the slice by ascending MIDI pitch
    const sortedSliceNotes = [...slice.notes].sort((a, b) => a.midi - b.midi);
    for (const note of sortedSliceNotes) {
      if (note.isTieStop) continue;
      const rawDurMs = note.durationSec * 1000;
      const minDur = slice.isGrace || note.isGrace ? MIN_GRACE_DURATION_MS : MIN_REGULAR_DURATION_MS;
      const durationMs = Number.isFinite(rawDurMs) && rawDurMs > minDur ? rawDurMs : minDur;
      const hasEffectiveAnchor =
        note.anchorFinger !== undefined &&
        !(ignoreExistingFingerings && note.anchorRawPreserved);
      notes.push({
        noteUid: note.noteUid,
        sliceId: slice.sliceId,
        hand,
        midi: note.midi,
        timeMs: baseTimeMs,
        durationMs,
        anchorFinger: hasEffectiveAnchor ? note.anchorFinger : undefined,
      });
    }
  }

  notes.sort((a, b) => a.timeMs - b.timeMs || a.midi - b.midi);
  return notes;
}

export function logitsToLogProbs(logits: ArrayLike<number>): Float32Array {
  let maxLogit = -Infinity;
  for (let i = 0; i < 5; i++) {
    if (logits[i] > maxLogit) maxLogit = logits[i];
  }
  let sumExp = 0;
  for (let i = 0; i < 5; i++) {
    sumExp += Math.exp(logits[i] - maxLogit);
  }
  const logZ = maxLogit + Math.log(sumExp);
  const out = new Float32Array(5);
  for (let i = 0; i < 5; i++) {
    out[i] = logits[i] - logZ;
  }
  return out;
}

export function argmax5(arr: ArrayLike<number>): Finger {
  let bestIdx = 0;
  let bestVal = arr[0];
  for (let i = 1; i < 5; i++) {
    if (arr[i] > bestVal) {
      bestVal = arr[i];
      bestIdx = i;
    }
  }
  return (bestIdx + 1) as Finger;
}

/**
 * Build a `PriorTable` across both hands using `prior.logProbs(...)`.
 * If `history` is provided, performs a teacher-forced pass using `history` as the
 * chosen finger trajectory; otherwise performs a greedy rollout.
 */
export function buildPriorTableForSlices(
  onsetSlices: readonly OnsetSlice[],
  prior: FingeringPrior,
  options?: {
    ignoreExistingFingerings?: boolean;
    history?: Readonly<Record<string, Finger>>;
    lambda?: number;
    perNoteCap?: number;
  }
): PriorTable {
  const ignoreExistingFingerings = Boolean(options?.ignoreExistingFingerings);
  const lambda = options?.lambda ?? DEFAULT_PRIOR_LAMBDA;
  const perNoteCap = options?.perNoteCap ?? DEFAULT_PRIOR_PER_NOTE_CAP;
  const noteLogProbsByUid: Record<string, Float32Array> = {};

  for (const hand of ["RH", "LH"] as const) {
    const notes = slicesToPriorNotes(onsetSlices, hand, ignoreExistingFingerings);
    if (notes.length === 0) continue;
    const flatLogProbs = prior.logProbs(hand, notes, options?.history);
    for (let i = 0; i < notes.length; i++) {
      const sliceProbs = new Float32Array(5);
      for (let f = 0; f < 5; f++) {
        sliceProbs[f] = flatLogProbs[i * 5 + f];
      }
      noteLogProbsByUid[notes[i].noteUid] = sliceProbs;
    }
  }

  return {
    noteLogProbsByUid,
    lambda,
    perNoteCap,
  };
}
