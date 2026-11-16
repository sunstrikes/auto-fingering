import type { Finger } from "../domain/types";
import rawWeights from "./weights.json";

export type FingerWeightMap = Record<Finger, number>;

export interface VerticalWeights {
  doubleStopBase: number;
  overSpanBase: number;
  overSpanSlope: number;
  overSpanCap: number;
  overSpanTiebreaker: number;
  wideStretchThreshold: number;
  wideStretchNonThumbThreshold: number;
  wideStretchBase: number;
  wideStretchNonThumbBias: number;
  octave14SmallPenalty: number;
  octave14MediumPenalty: number;
  chordStretch: number;
  chordCramp: number;
  chordStretchAdj: number;
  chordAdjThreshold: number;
  chordNaturalThreshold: number;
  chordCrampThreshold: number;
  heldStealPenalty: number;
  heldShapeWeight: number;
  heldInversionThumb: number;
  heldInversionNonThumb: number;
  finger4: number;
  finger5: number;
  thumbBlackLearned: number;
  thumbBlackAvoid: number;
  pinkyBlack: number;
}

export interface HorizontalWeights {
  crossBase: number;
  cross2Extra: number;
  cross4Extra: number;
  crossWideThreshold: number;
  crossWideSlope: number;
  crossMax: number;
  crossThumbBlackLearned: number;
  crossThumbBlackAvoid: number;
  awkwardCrossingBase: number;
  awkwardCrossingDist: number;
  awkward34Extra: number;
  sameFingerBase: number;
  sameFingerDist: number;
  sameFingerVelocity: number;
  sameKeyRepeatFast: number;
  sameKeyRepeatFastThreshold: number;
  sameKeyNewFingerReward: number;
  sameKeyNewFingerSlowPenalty: number;
  stretchLinear: number;
  crampLinear: number;
  stretchDeviation: number;
  stretchDeviationThreshold: number;
  fastOverSpanBase: number;
  fastOverSpanSlope: number;
  fastWideStretch: number;
  chordSameFingerThumbBase: number;
  chordSameFingerThumbDist: number;
  chordSameFingerOtherBase: number;
  chordSameFingerOtherDist: number;
  chordOuterTransitionWeight: number;
  parallelChordShapeShift: number;
  parallelChordSameShape: number;
  shiftFreeBase: number;
  shiftFreeCross: number;
  shiftCost: number;
  shiftCostStableMultiplier: number;
  velocityThreshold: number;
  velocitySlope: number;
  ergonomicVelocityWeight: number;
}

export interface CostWeights {
  fingerStrength: FingerWeightMap;
  blackEase: FingerWeightMap;
  relaxedOffset: FingerWeightMap;
  vertical: VerticalWeights;
  horizontal: HorizontalWeights;
}

function toFingerMap(record: Record<string, number>): FingerWeightMap {
  return {
    1: record["1"],
    2: record["2"],
    3: record["3"],
    4: record["4"],
    5: record["5"],
  };
}

/**
 * Externalized SOTA ergonomic weights calibrated from:
 * - `shafranek-js/pianomotion-studio` (`W_TEXTBOOK` + `LEARNED_W`, tuned on PIG 031-150; MIT w/ attribution)
 * - `marcomusy/pianoplayer` per-finger strength and black-key comfort factors (MIT)
 * - Nakamura, Saito & Yoshii (2020) PIG-trained FHMM1 transition priors (e.g. `3<->4` IFR guard)
 */
export const DEFAULT_COST_WEIGHTS: CostWeights = {
  fingerStrength: toFingerMap(rawWeights.fingerStrength),
  blackEase: toFingerMap(rawWeights.blackEase),
  relaxedOffset: toFingerMap(rawWeights.relaxedOffset),
  vertical: { ...rawWeights.vertical },
  horizontal: { ...rawWeights.horizontal },
};
