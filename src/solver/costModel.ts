import {
  DEFAULT_HAND_SPAN_PROFILE,
  type Finger,
  type Hand,
  type HandSpanProfile,
  type NoteEvent,
  type OnsetSlice,
} from "../domain/types";
import { getMaxSpan, getSpanScale, isBlackKey, toHandFramePos } from "./keyboard";
import { DEFAULT_COST_WEIGHTS, type CostWeights } from "./weights";

export const IMPOSSIBLE_COST = 1e6;

const ALL_FINGERS: Finger[] = [1, 2, 3, 4, 5];
const EMPTY_HELD_FINGERS = new Map<Finger, number>();

function generateMonotonicTuples(
  count: number,
  startIdx: number,
  current: Finger[],
  out: Finger[][]
): void {
  if (current.length === count) {
    out.push([...current]);
    return;
  }
  for (let i = startIdx; i < ALL_FINGERS.length; i++) {
    current.push(ALL_FINGERS[i]);
    generateMonotonicTuples(count, i + 1, current, out);
    current.pop();
  }
}

const MONOTONIC_TUPLES_BY_K: Record<number, Finger[][]> = {
  1: [[1], [2], [3], [4], [5]],
  2: [],
  3: [],
  4: [],
  5: [],
};
for (let k = 2; k <= 5; k++) {
  generateMonotonicTuples(k, 0, [], MONOTONIC_TUPLES_BY_K[k]);
}

function hasAnchoredImpossibleSpan(
  notes: NoteEvent[],
  tuple: Finger[],
  hand: Hand,
  scale: number,
  allCandidates: Finger[][],
  keptAnchorSet: Set<number>
): boolean {
  const indices = Array.from(keptAnchorSet);
  for (let a = 0; a < indices.length; a++) {
    const i = indices[a];
    const posI = toHandFramePos(notes[i].midi, hand);
    for (let b = a + 1; b < indices.length; b++) {
      const j = indices[b];
      const dist = Math.abs(toHandFramePos(notes[j].midi, hand) - posI);
      const maxSpan = getMaxSpan(tuple[i], tuple[j], scale);
      if (dist <= maxSpan) continue;

      const canImprove = allCandidates.some((alt) => {
        const altSpan = getMaxSpan(alt[i], alt[j], scale);
        return altSpan >= dist || (notes.length === 2 && altSpan > maxSpan);
      });
      if (canImprove) {
        return true;
      }
    }
  }
  return false;
}

function collectAnchoredSubsets(
  anchoredIndices: number[],
  keepCount: number,
  startPos: number,
  current: number[],
  out: Set<number>[]
): void {
  if (current.length === keepCount) {
    out.push(new Set(current));
    return;
  }
  for (let i = startPos; i < anchoredIndices.length; i++) {
    current.push(anchoredIndices[i]);
    collectAnchoredSubsets(anchoredIndices, keepCount, i + 1, current, out);
    current.pop();
  }
}

function buildOuterPriorityChordTuple(count: number): Finger[] {
  const tuple = new Array<Finger>(count);
  tuple[0] = 1;
  tuple[count - 1] = 5;
  const innerCount = count - 2;
  for (let i = 0; i < innerCount; i++) {
    tuple[i + 1] = (2 + Math.floor((i * 3) / innerCount)) as Finger;
  }
  return tuple;
}

function isBlockChordSlice(slice: OnsetSlice): boolean {
  if (slice.notes.length < 3) return false;
  const firstDur = slice.notes[0].durationTick;
  return slice.notes.every((n) => n.durationTick === firstDur);
}

/**
 * Selects the single fixed optimal chord fingering (3+ notes) based on vertical chord
 * ergonomics, without searching over alternative chord shapes during horizontal DP.
 */
function selectFixedOptimalChordTuple(
  slice: OnsetSlice,
  candidates: Finger[][],
  profile: HandSpanProfile
): Finger[] {
  if (candidates.length <= 1) return candidates[0];
  let bestTuple = candidates[0];
  let bestCost = Infinity;

  for (const tuple of candidates) {
    const { cost } = computeVerticalCost(slice, tuple, EMPTY_HELD_FINGERS, profile);
    if (cost < bestCost - 1e-6) {
      bestCost = cost;
      bestTuple = tuple;
    }
  }
  return bestTuple;
}

/**
 * Returns candidate finger tuples aligned to `slice.notes` (which are sorted by
 * midi ascending). In LH frame, fingers run descending (thumb=1 on highest note).
 * Chords (3+ notes) use a fixed optimal fingering unless constrained by user anchors.
 * Minimally drops conflicting anchors when simultaneous anchors cannot be satisfied.
 */
export function generateSliceCandidates(
  slice: OnsetSlice,
  ignoreAnchors = false,
  profile: HandSpanProfile = DEFAULT_HAND_SPAN_PROFILE,
  ignoredNoteUids?: Set<string>
): { candidates: Finger[][]; hadAnchorConflict: boolean } {
  const notes = slice.notes;
  const k = notes.length;

  // Map notes into hand-frame ascending order (RH: low->high, LH: high->low)
  const orderedIndices = notes.map((_, idx) => idx);
  if (slice.hand === "LH") {
    orderedIndices.reverse();
  }

  let baseTuples: Finger[][];
  if (k <= 5) {
    baseTuples = MONOTONIC_TUPLES_BY_K[k] ?? [[1]];
  } else if (k === 6) {
    const lowPairAdjacent =
      Math.abs(notes[orderedIndices[1]].midi - notes[orderedIndices[0]].midi) <= 2;
    const highPairAdjacent =
      Math.abs(notes[orderedIndices[5]].midi - notes[orderedIndices[4]].midi) <= 2;
    baseTuples = [];
    if (lowPairAdjacent) {
      baseTuples.push([1, 1, 2, 3, 4, 5]);
    }
    if (highPairAdjacent) {
      baseTuples.push([1, 2, 3, 4, 5, 5]);
    }
    if (baseTuples.length === 0) {
      // >5-note chord without adjacent 2nds: prioritize outer 1/5 voices and distribute inner notes across 2..4
      baseTuples = [buildOuterPriorityChordTuple(k)];
    }
  } else {
    // 7+ note fallback: prioritize outer 1/5 voices and distribute inner notes across 2..4 for arpeggiation/splitting
    baseTuples = [buildOuterPriorityChordTuple(k)];
  }

  const toSliceOrder = (handFrameTuple: Finger[]): Finger[] => {
    const assigned = new Array<Finger>(k);
    for (let pos = 0; pos < k; pos++) {
      assigned[orderedIndices[pos]] = handFrameTuple[pos];
    }
    return assigned;
  };

  const allCandidates = baseTuples.map(toSliceOrder);
  const isChord = isBlockChordSlice(slice);
  if (ignoreAnchors) {
    return {
      candidates: isChord
        ? [selectFixedOptimalChordTuple(slice, allCandidates, profile)]
        : allCandidates,
      hadAnchorConflict: false,
    };
  }

  const anchoredIndices: number[] = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.anchorFinger !== undefined && !ignoredNoteUids?.has(n.noteUid)) {
      anchoredIndices.push(i);
    }
  }

  if (anchoredIndices.length === 0) {
    return {
      candidates: isChord
        ? [selectFixedOptimalChordTuple(slice, allCandidates, profile)]
        : allCandidates,
      hadAnchorConflict: false,
    };
  }

  const scale = getSpanScale(profile);

  // Try keeping all anchors first, then minimally drop 1, 2, ... anchors if physically conflicting
  for (let dropCount = 0; dropCount <= anchoredIndices.length; dropCount++) {
    const keepCount = anchoredIndices.length - dropCount;
    const subsets: Set<number>[] = [];
    collectAnchoredSubsets(anchoredIndices, keepCount, 0, [], subsets);

    const matched: Finger[][] = [];
    const seenTuples = new Set<string>();

    for (const keptSet of subsets) {
      for (const tuple of allCandidates) {
        let matchesKept = true;
        for (const idx of keptSet) {
          if (tuple[idx] !== notes[idx].anchorFinger) {
            matchesKept = false;
            break;
          }
        }
        if (!matchesKept) continue;
        if (hasAnchoredImpossibleSpan(notes, tuple, slice.hand, scale, allCandidates, keptSet)) {
          continue;
        }
        const key = tuple.join(",");
        if (!seenTuples.has(key)) {
          seenTuples.add(key);
          matched.push(tuple);
        }
      }
    }

    if (matched.length > 0) {
      return { candidates: matched, hadAnchorConflict: dropCount > 0 };
    }
  }

  return { candidates: allCandidates, hadAnchorConflict: true };
}

export function computeHandRoot(
  notes: NoteEvent[],
  fingers: Finger[],
  hand: Hand
): number {
  let sum = 0;
  for (let i = 0; i < notes.length; i++) {
    sum += toHandFramePos(notes[i].midi, hand) - (fingers[i] - 1);
  }
  return sum / Math.max(1, notes.length);
}

function computePairwiseSpanCost(
  fA: Finger,
  posA: number,
  fB: Finger,
  posB: number,
  scale: number,
  shapeWeight = 1.0,
  preset: HandSpanProfile["preset"] = "M",
  semitoneDiff = Infinity,
  weights: CostWeights = DEFAULT_COST_WEIGHTS
): { cost: number; hasUnreachableSpan: boolean; hasWideStretch: boolean } {
  const vw = weights.vertical;
  const dist = Math.abs(posB - posA);
  const maxSpan = getMaxSpan(fA, fB, scale);
  const stretchBias = preset === "L" ? 0.75 : preset === "S" ? 1.25 : 1.0;
  let cost = 0;
  let hasUnreachableSpan = false;
  let hasWideStretch = false;

  if (fA === fB) {
    if ((fA === 1 || fA === 5) && semitoneDiff <= 2 && dist <= 1.5) {
      cost += vw.doubleStopBase;
    } else {
      cost += IMPOSSIBLE_COST + dist;
      hasUnreachableSpan = true;
    }
    return { cost, hasUnreachableSpan, hasWideStretch };
  }

  if (dist > maxSpan) {
    const over = dist - maxSpan;
    cost +=
      vw.overSpanBase +
      Math.min(vw.overSpanCap, over * vw.overSpanSlope) +
      vw.overSpanTiebreaker * over;
    hasUnreachableSpan = true;
  } else if (dist >= maxSpan * vw.wideStretchThreshold) {
    const nonThumbBias =
      Math.min(fA, fB) >= 2 && dist >= maxSpan * vw.wideStretchNonThumbThreshold
        ? vw.wideStretchNonThumbBias
        : 1.0;
    cost +=
      vw.wideStretchBase * (dist / maxSpan) * shapeWeight * stretchBias * nonThumbBias;
    hasWideStretch = true;
  }

  const lowF = Math.min(fA, fB);
  const highF = Math.max(fA, fB);

  // Strongly penalize 1-4 octaves under S, calibrated under M, relaxed under L
  if (lowF === 1 && highF === 4 && dist >= 6.8) {
    if (preset === "S") {
      cost += vw.octave14SmallPenalty * shapeWeight;
    } else if (preset === "M") {
      cost += vw.octave14MediumPenalty * shapeWeight;
    }
  }

  // Adjacent non-thumb finger spread penalty (2-3, 3-4, 4-5) from PIG-calibrated chord_stretch_adj
  const spreadRatio = dist / scale;
  if (highF - lowF === 1 && lowF >= 2 && spreadRatio > vw.chordAdjThreshold) {
    cost += vw.chordStretchAdj * (spreadRatio - vw.chordAdjThreshold) * shapeWeight * stretchBias;
  }

  const natDist = Math.abs(fB - fA) * scale;
  const diff = dist - natDist;
  if (diff > vw.chordNaturalThreshold) {
    cost +=
      vw.chordStretch *
      (diff - vw.chordNaturalThreshold) *
      shapeWeight *
      stretchBias;
  } else if (diff < -vw.chordCrampThreshold) {
    cost += vw.chordCramp * (-vw.chordCrampThreshold - diff) * shapeWeight;
  }

  return { cost, hasUnreachableSpan, hasWideStretch };
}

export function computeVerticalCost(
  slice: OnsetSlice,
  fingers: Finger[],
  heldFingers: Map<Finger, number>,
  profile: HandSpanProfile,
  weights: CostWeights = DEFAULT_COST_WEIGHTS
): { cost: number; hasUnreachableSpan: boolean; hasWideStretch: boolean } {
  const vw = weights.vertical;
  const scale = getSpanScale(profile);
  const weakMultiplier = profile.preferStablePosition ? 0.6 : 1.0;
  const thumbBlackCost = profile.avoidThumbOnBlack
    ? vw.thumbBlackAvoid
    : vw.thumbBlackLearned;
  let cost = 0;
  let hasUnreachableSpan = false;
  let hasWideStretch = false;

  const notes = slice.notes;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const f = fingers[i];
    const posS = toHandFramePos(n.midi, slice.hand);

    // Held finger reuse ("steal") penalty & combined held+struck ergonomics
    const heldMidiSame = heldFingers.get(f);
    if (heldMidiSame !== undefined && heldMidiSame !== n.midi) {
      cost += vw.heldStealPenalty;
    }

    for (const [fH, heldMidi] of heldFingers.entries()) {
      if (fH === f) continue;
      const posH = toHandFramePos(heldMidi, slice.hand);
      const pair = computePairwiseSpanCost(
        fH,
        posH,
        f,
        posS,
        scale,
        vw.heldShapeWeight,
        profile.preset,
        Infinity,
        weights
      );
      cost += pair.cost;
      if (pair.hasUnreachableSpan) hasUnreachableSpan = true;
      if (pair.hasWideStretch) hasWideStretch = true;

      // Penalize finger inversion while another finger is physically held down;
      // wide or thumb-pinky inversions are anatomically impossible (hard constraint).
      if ((f > fH && posS < posH - 0.5) || (f < fH && posS > posH + 0.5)) {
        const invDist = Math.abs(posS - posH);
        const involvesThumb = f === 1 || fH === 1;
        const involvesPinky = f === 5 || fH === 5;
        if ((involvesThumb && involvesPinky) || invDist > weights.horizontal.crossMax * scale) {
          cost += IMPOSSIBLE_COST + invDist;
          hasUnreachableSpan = true;
        } else {
          cost += involvesThumb ? vw.heldInversionThumb : vw.heldInversionNonThumb;
        }
      }
    }

    // Weak fingers (4, 5) preference
    if (f === 4) cost += vw.finger4 * weakMultiplier;
    if (f === 5) cost += vw.finger5 * weakMultiplier;

    // Black key thumb / pinky penalties
    if (isBlackKey(n.midi)) {
      if (f === 1) cost += thumbBlackCost;
      if (f === 5) cost += vw.pinkyBlack;
    }

    // Pairwise chord ergonomics
    for (let j = i + 1; j < notes.length; j++) {
      const posB = toHandFramePos(notes[j].midi, slice.hand);
      const semitoneDiff = Math.abs(notes[j].midi - n.midi);
      const pair = computePairwiseSpanCost(
        f,
        posS,
        fingers[j],
        posB,
        scale,
        1.0,
        profile.preset,
        semitoneDiff,
        weights
      );
      cost += pair.cost;
      if (pair.hasUnreachableSpan) hasUnreachableSpan = true;
      if (pair.hasWideStretch) hasWideStretch = true;
    }
  }

  return { cost, hasUnreachableSpan, hasWideStretch };
}

/**
 * Resolve effective departure fingers when transitioning out of a slice,
 * honoring hyphenated `anchorExitFinger` unless anchors are ignored or overridden.
 */
export function resolveDepartureFingers(
  slice: OnsetSlice,
  fingers: Finger[],
  ignoreAnchors = false
): Finger[] {
  if (ignoreAnchors) return fingers;
  let changed = false;
  const resolved = fingers.map((f, idx) => {
    const note = slice.notes[idx];
    if (
      note.anchorExitFinger !== undefined &&
      (note.anchorFinger === undefined || f === note.anchorFinger)
    ) {
      changed = true;
      return note.anchorExitFinger;
    }
    return f;
  });
  return changed ? resolved : fingers;
}

function evaluateDirectedNoteTransition(
  prevMidi: number,
  prevFinger: Finger,
  currMidi: number,
  currFinger: Finger,
  hand: Hand,
  scale: number,
  dt: number,
  profile: HandSpanProfile,
  weights: CostWeights,
  allowSamePitchBonus: boolean
): {
  cost: number;
  isThumbUnder: boolean;
  isCrossOver: boolean;
  hasWideStretch: boolean;
  hasUnreachableSpan: boolean;
} {
  const hw = weights.horizontal;
  const posPrev = toHandFramePos(prevMidi, hand);
  const posCurr = toHandFramePos(currMidi, hand);
  const d = posCurr - posPrev;
  const absD = Math.abs(d);

  const isThumbUnder =
    d > 0.2 && absD <= hw.crossMax * scale && currFinger === 1 && prevFinger >= 2 && prevFinger <= 4;
  const isCrossOver =
    d < -0.2 && absD <= hw.crossMax * scale && prevFinger === 1 && currFinger >= 2 && currFinger <= 4;

  let cost = 0;
  let hasWideStretch = false;
  let hasUnreachableSpan = false;

  if (prevFinger === currFinger) {
    if (prevMidi !== currMidi) {
      cost += hw.sameFingerBase + hw.sameFingerDist * absD + (absD / dt) * hw.sameFingerVelocity;
    } else if (dt < hw.sameKeyRepeatFastThreshold) {
      // Fast same-key repetition favors finger alternation
      cost += hw.sameKeyRepeatFast;
    }
    return { cost, isThumbUnder, isCrossOver, hasWideStretch, hasUnreachableSpan };
  }

  if (allowSamePitchBonus && prevMidi === currMidi) {
    // Slow repeated note prefers staying on the same finger unless fast repeat calls for alternation
    if (dt >= hw.sameKeyRepeatFastThreshold) {
      cost += hw.sameKeyNewFingerSlowPenalty;
    }
  }

  if (isThumbUnder) {
    const extra = prevFinger === 2 ? hw.cross2Extra : prevFinger === 4 ? hw.cross4Extra : 0;
    cost += hw.crossBase + extra;
    if (absD > hw.crossWideThreshold * scale) {
      cost += (absD - hw.crossWideThreshold * scale) * hw.crossWideSlope;
    }
    if (isBlackKey(currMidi)) {
      cost += profile.avoidThumbOnBlack
        ? hw.crossThumbBlackAvoid
        : hw.crossThumbBlackLearned;
    }
  } else if (isCrossOver) {
    const extra = currFinger === 2 ? hw.cross2Extra : currFinger === 4 ? hw.cross4Extra : 0;
    cost += hw.crossBase + extra;
    if (absD > hw.crossWideThreshold * scale) {
      cost += (absD - hw.crossWideThreshold * scale) * hw.crossWideSlope;
    }
  } else if (
    absD <= hw.crossMax * scale &&
    ((d > 0.2 && currFinger < prevFinger) || (d < -0.2 && currFinger > prevFinger))
  ) {
    // Non-thumb crossing violation (IFR guard: 3<->4 reverse crossings carry extra prohibitive cost)
    const is34Crossing =
      (prevFinger === 3 && currFinger === 4) || (prevFinger === 4 && currFinger === 3);
    cost +=
      hw.awkwardCrossingBase +
      hw.awkwardCrossingDist * absD +
      (is34Crossing ? hw.awkward34Extra : 0);
  } else if (
    absD > 0.2 &&
    absD <= 5.5 * scale &&
    ((d > 0 && currFinger > prevFinger) || (d < 0 && currFinger < prevFinger))
  ) {
    // Same-direction stretch check within hand-shift range
    const maxSpan = getMaxSpan(prevFinger, currFinger, scale);
    if (absD > maxSpan && dt < 0.2) {
      cost += hw.fastOverSpanBase + (absD - maxSpan) * hw.fastOverSpanSlope;
      hasUnreachableSpan = true;
    } else if (absD >= maxSpan * weights.vertical.wideStretchThreshold && dt < 0.4) {
      cost += hw.fastWideStretch;
      hasWideStretch = true;
    }
    const expectedDist = Math.abs(currFinger - prevFinger) * scale;
    const rawDiff = absD - expectedDist;
    if (rawDiff > hw.stretchDeviationThreshold && absD <= 4.0 * scale) {
      cost += (hw.stretchDeviation + hw.stretchLinear) * (rawDiff - hw.stretchDeviationThreshold);
    } else if (-rawDiff > hw.stretchDeviationThreshold && absD <= 4.0 * scale) {
      cost += hw.crampLinear * (-rawDiff - hw.stretchDeviationThreshold);
    }
  }

  return { cost, isThumbUnder, isCrossOver, hasWideStretch, hasUnreachableSpan };
}

export function computeHorizontalCost(
  prevSlice: OnsetSlice,
  prevFingers: Finger[],
  currSlice: OnsetSlice,
  currFingers: Finger[],
  profile: HandSpanProfile,
  ignoreAnchors = false,
  weights: CostWeights = DEFAULT_COST_WEIGHTS
): { cost: number; hasWideStretch: boolean; hasUnreachableSpan: boolean } {
  const hw = weights.horizontal;
  const scale = getSpanScale(profile);
  const dt = Math.max(0.05, currSlice.onsetSec - prevSlice.onsetSec);
  const hand = currSlice.hand;
  const effectivePrevFingers = resolveDepartureFingers(prevSlice, prevFingers, ignoreAnchors);

  let cost = 0;
  let hasWideStretch = false;
  let hasUnreachableSpan = false;
  let hasCrossing = false;

  const isMonoPair = prevSlice.notes.length === 1 && currSlice.notes.length === 1;

  if (isMonoPair) {
    const res = evaluateDirectedNoteTransition(
      prevSlice.notes[0].midi,
      effectivePrevFingers[0],
      currSlice.notes[0].midi,
      currFingers[0],
      hand,
      scale,
      dt,
      profile,
      weights,
      true
    );
    cost += res.cost;
    hasCrossing = res.isThumbUnder || res.isCrossOver;
    if (res.hasWideStretch) hasWideStretch = true;
    if (res.hasUnreachableSpan) hasUnreachableSpan = true;
  } else {
    // Chord-involved transition: pair each current voice with its nearest pitch predecessor
    let pairedCostSum = 0;
    for (let j = 0; j < currSlice.notes.length; j++) {
      const currNote = currSlice.notes[j];
      const currF = currFingers[j];
      let bestIdx = 0;
      let bestPitchDiff = Math.abs(prevSlice.notes[0].midi - currNote.midi);
      for (let i = 1; i < prevSlice.notes.length; i++) {
        const diff = Math.abs(prevSlice.notes[i].midi - currNote.midi);
        if (diff < bestPitchDiff) {
          bestPitchDiff = diff;
          bestIdx = i;
        }
      }
      const res = evaluateDirectedNoteTransition(
        prevSlice.notes[bestIdx].midi,
        effectivePrevFingers[bestIdx],
        currNote.midi,
        currF,
        hand,
        scale,
        dt,
        profile,
        weights,
        false
      );
      pairedCostSum += res.cost;
      if (res.isThumbUnder || res.isCrossOver) hasCrossing = true;
      if (res.hasWideStretch) hasWideStretch = true;
      if (res.hasUnreachableSpan) hasUnreachableSpan = true;
    }
    cost += (pairedCostSum / Math.max(1, currSlice.notes.length)) * hw.chordOuterTransitionWeight;

    // Parallel chord shape transition preference (same finger shape on stepwise parallel chords)
    if (
      prevSlice.notes.length >= 2 &&
      prevSlice.notes.length === currSlice.notes.length
    ) {
      const firstShift = currSlice.notes[0].midi - prevSlice.notes[0].midi;
      let isParallel = firstShift !== 0;
      let sameShape = true;
      for (let i = 0; i < currSlice.notes.length; i++) {
        if (currSlice.notes[i].midi - prevSlice.notes[i].midi !== firstShift) {
          isParallel = false;
        }
        if (effectivePrevFingers[i] !== currFingers[i]) {
          sameShape = false;
        }
      }
      if (isParallel) {
        cost += hw.parallelChordShapeShift;
        const outerSpan = currSlice.notes[currSlice.notes.length - 1].midi - currSlice.notes[0].midi;
        if (!sameShape && outerSpan < 7 && Math.abs(firstShift) <= 2) {
          cost += hw.parallelChordSameShape;
        }
      }
    }

    // Discourage rapid reuse of same finger across different chord pitches
    if (dt < 0.5) {
      const bothChords = prevSlice.notes.length >= 2 && currSlice.notes.length >= 2;
      for (let i = 0; i < prevSlice.notes.length; i++) {
        for (let j = 0; j < currSlice.notes.length; j++) {
          if (
            effectivePrevFingers[i] === currFingers[j] &&
            prevSlice.notes[i].midi !== currSlice.notes[j].midi
          ) {
            const dist = Math.abs(
              toHandFramePos(currSlice.notes[j].midi, hand) -
                toHandFramePos(prevSlice.notes[i].midi, hand)
            );
            if (bothChords && effectivePrevFingers[i] === 1) {
              cost += hw.chordSameFingerThumbBase + hw.chordSameFingerThumbDist * dist;
            } else {
              cost += hw.chordSameFingerOtherBase + hw.chordSameFingerOtherDist * dist;
            }
          }
        }
      }
    }
  }

  // Hand root shift & travel velocity
  const prevRoot = computeHandRoot(prevSlice.notes, effectivePrevFingers, hand);
  const currRoot = computeHandRoot(currSlice.notes, currFingers, hand);
  const rootShift = Math.abs(currRoot - prevRoot);

  const freeShift = hasCrossing ? hw.shiftFreeCross : hw.shiftFreeBase;
  if (rootShift > freeShift) {
    const shiftWeight = profile.preferStablePosition
      ? hw.shiftCost * hw.shiftCostStableMultiplier
      : hw.shiftCost;
    cost += shiftWeight * (rootShift - freeShift);
  }

  // Ergonomic per-finger travel economy (weighted by finger strength & black-key ease)
  const prevAnchor =
    toHandFramePos(prevSlice.notes[0].midi, hand) -
    weights.relaxedOffset[effectivePrevFingers[0]];
  let fingerVelSum = 0;
  for (let i = 0; i < currSlice.notes.length; i++) {
    const note = currSlice.notes[i];
    const f = currFingers[i];
    const targetPos = prevAnchor + weights.relaxedOffset[f];
    const travel = Math.abs(toHandFramePos(note.midi, hand) - targetPos);
    let speed = travel / (dt + 0.1) / weights.fingerStrength[f];
    if (isBlackKey(note.midi)) {
      speed /= weights.blackEase[f];
    }
    fingerVelSum += speed;
  }
  cost += (hw.ergonomicVelocityWeight * fingerVelSum) / Math.max(1, currSlice.notes.length);

  // High-speed hand leap penalty
  const velocity = rootShift / (dt + 0.1);
  if (velocity > hw.velocityThreshold) {
    cost += hw.velocitySlope * (velocity - hw.velocityThreshold);
  }

  return { cost, hasWideStretch, hasUnreachableSpan };
}
