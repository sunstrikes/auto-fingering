import type { Finger, Hand, OnsetSlice } from "../domain/types";

export type PriorMode = "classic" | "model-assist";

/**
 * Default hyperparameters for the soft prior cost term:
 * `priorCost(slice, cand) = lambda * sum_note min(cap, -logProb[note][finger])`
 */
export const DEFAULT_PRIOR_LAMBDA = 0.85;
export const DEFAULT_PRIOR_PER_NOTE_CAP = 6.0;

/**
 * Normalized note representation consumed by a `FingeringPrior` implementation.
 * Matches `@lumikey/piano-fingering-model` semantics (milliseconds for time/duration,
 * chord notes ordered lowest-to-highest).
 */
export interface PriorNoteInput {
  noteUid: string;
  sliceId: string;
  hand: Hand;
  midi: number;
  /** Onset time in milliseconds (`onsetSec * 1000`). */
  timeMs: number;
  /** Duration in milliseconds (`max(100, durationSec * 1000)`). */
  durationMs: number;
  /** Fixed anchor finger (`1..5`) when pinned by user or preserved score `<fingering>`. */
  anchorFinger?: Finger;
}

/**
 * Precomputed additive prior cost table per `OnsetSlice` and candidate index.
 * Kept external to `generateSliceCandidates` so P0 physical constraints and anchors
 * retain absolute veto power.
 */
export interface PriorTable {
  /**
   * Maps `sliceId` -> per-note 5-element log-probability array (`index 0..4` => `Finger 1..5`),
   * or `noteUid` -> `Float32Array(5)` (`[-logP(f=1), ..., -logP(f=5)]` already capped and scaled, or raw logProbs).
   */
  noteLogProbsByUid: Record<string, Float32Array>;
  /** Multiplier `lambda >= 0` applied to capped negative log-probabilities. */
  lambda: number;
  /** Per-note cap on `-logProb` before multiplying by `lambda` (default `6.0`). */
  perNoteCap: number;
}

/**
 * Seam interface for pluggable fingering priors (e.g. Lumikey Transformer, fake test prior,
 * or future HMM / motif-consistency models).
 */
export interface FingeringPrior {
  /**
   * Compute log-probabilities `log P(finger = 1..5)` for an ordered single-hand note sequence.
   *
   * @param hand `"RH"` or `"LH"`
   * @param notes Single-hand notes sorted by `(timeMs, midi)`
   * @param history Optional fixed finger assignment per note (`fingerByNoteUid`) from round 1
   *                for teacher-forced round-2 evaluation. When omitted, the model performs
   *                a greedy autoregressive rollout (honoring any `note.anchorFinger`).
   * @returns Flat `Float32Array` of length `notes.length * 5`, where `out[i * 5 + (f - 1)]`
   *          is `log P(finger = f | context)` for `notes[i]`.
   */
  logProbs(
    hand: Hand,
    notes: readonly PriorNoteInput[],
    history?: Readonly<Record<string, Finger>>
  ): Float32Array;
}

/**
 * Helper to compute the additive prior cost for a single slice candidate `cand`
 * from a precomputed `PriorTable`.
 * Returns `0` when `prior` is undefined/null, `lambda <= 0`, or notes are missing.
 */
export function computeCandidatePriorCost(
  slice: OnsetSlice,
  cand: readonly Finger[],
  prior?: PriorTable | null
): number {
  if (!prior || prior.lambda <= 0) return 0;
  const { noteLogProbsByUid, lambda, perNoteCap } = prior;
  const cap = perNoteCap > 0 ? perNoteCap : DEFAULT_PRIOR_PER_NOTE_CAP;
  let sum = 0;
  for (let i = 0; i < slice.notes.length; i++) {
    const uid = slice.notes[i].noteUid;
    const logProbs = noteLogProbsByUid[uid];
    if (!logProbs || logProbs.length < 5) continue;
    const fIdx = cand[i] - 1;
    const lp = logProbs[fIdx];
    const nll = Number.isFinite(lp) ? Math.max(0, -lp) : cap;
    sum += Math.min(cap, nll);
  }
  return lambda * sum;
}
