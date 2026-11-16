import {
  DEFAULT_HAND_SPAN_PROFILE,
  type Finger,
  type Hand,
  type HandSpanProfile,
  type NoteEvent,
  type OnsetSlice,
} from "../domain/types";
import { getMaxSpan, getSpanScale, isBlackKey, toHandFramePos } from "./keyboard";

export const IMPOSSIBLE_COST = 1e6;

const ALL_FINGERS: Finger[] = [1, 2, 3, 4, 5];

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

/**
 * Returns candidate finger tuples aligned to `slice.notes` (which are sorted by
 * midi ascending). In LH frame, fingers run descending (thumb=1 on highest note).
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
  if (ignoreAnchors) {
    return { candidates: allCandidates, hadAnchorConflict: false };
  }

  const anchoredIndices: number[] = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.anchorFinger !== undefined && !ignoredNoteUids?.has(n.noteUid)) {
      anchoredIndices.push(i);
    }
  }

  if (anchoredIndices.length === 0) {
    return { candidates: allCandidates, hadAnchorConflict: false };
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
  semitoneDiff = Infinity
): { cost: number; hasUnreachableSpan: boolean; hasWideStretch: boolean } {
  const dist = Math.abs(posB - posA);
  const maxSpan = getMaxSpan(fA, fB, scale);
  const stretchBias = preset === "L" ? 0.75 : preset === "S" ? 1.25 : 1.0;
  let cost = 0;
  let hasUnreachableSpan = false;
  let hasWideStretch = false;

  if (fA === fB) {
    if ((fA === 1 || fA === 5) && semitoneDiff <= 2 && dist <= 1.5) {
      cost += 6.0;
    } else {
      cost += IMPOSSIBLE_COST + dist;
      hasUnreachableSpan = true;
    }
    return { cost, hasUnreachableSpan, hasWideStretch };
  }

  if (dist > maxSpan) {
    const over = dist - maxSpan;
    cost += 250 + Math.min(120, over * 20) + 0.01 * over;
    hasUnreachableSpan = true;
  } else if (dist >= maxSpan * 0.85) {
    const nonThumbBias = Math.min(fA, fB) >= 2 && dist >= maxSpan * 0.9 ? 3.5 : 1.0;
    cost += 4.0 * (dist / maxSpan) * shapeWeight * stretchBias * nonThumbBias;
    hasWideStretch = true;
  }

  // Strongly penalize 1-4 octaves under S, relax under L
  const lowF = Math.min(fA, fB);
  const highF = Math.max(fA, fB);
  if (lowF === 1 && highF === 4 && dist >= 6.8) {
    if (preset === "S") {
      cost += 18.0 * shapeWeight;
    } else if (preset === "M") {
      cost += 2.5 * shapeWeight;
    }
  }

  const natDist = Math.abs(fB - fA) * scale;
  const diff = dist - natDist;
  if (diff > 0.6) {
    cost += 0.9 * (diff - 0.6) * (diff - 0.6) * shapeWeight * stretchBias;
  } else if (diff < -0.5) {
    cost += 1.4 * (-0.5 - diff) * shapeWeight;
  }

  return { cost, hasUnreachableSpan, hasWideStretch };
}

export function computeVerticalCost(
  slice: OnsetSlice,
  fingers: Finger[],
  heldFingers: Map<Finger, number>,
  profile: HandSpanProfile
): { cost: number; hasUnreachableSpan: boolean; hasWideStretch: boolean } {
  const scale = getSpanScale(profile);
  const weakMultiplier = profile.preferStablePosition ? 0.6 : 1.0;
  const thumbBlackCost = profile.avoidThumbOnBlack ? 4.5 : 0.2;
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
      cost += 400.0;
    }

    for (const [fH, heldMidi] of heldFingers.entries()) {
      if (fH === f) continue;
      const posH = toHandFramePos(heldMidi, slice.hand);
      const pair = computePairwiseSpanCost(fH, posH, f, posS, scale, 0.6, profile.preset);
      cost += pair.cost;
      if (pair.hasUnreachableSpan) hasUnreachableSpan = true;
      if (pair.hasWideStretch) hasWideStretch = true;

      // Penalize awkward finger inversion while another finger is physically held down
      if ((f > fH && posS < posH - 0.5) || (f < fH && posS > posH + 0.5)) {
        cost += f === 1 || fH === 1 ? 8.0 : 18.0;
      }
    }

    // Weak fingers (4, 5) subtle preference
    if (f === 4) cost += 0.35 * weakMultiplier;
    if (f === 5) cost += 0.55 * weakMultiplier;

    // Black key thumb / pinky penalties
    if (isBlackKey(n.midi)) {
      if (f === 1) cost += thumbBlackCost;
      if (f === 5) cost += 1.0;
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
        semitoneDiff
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

export function computeHorizontalCost(
  prevSlice: OnsetSlice,
  prevFingers: Finger[],
  currSlice: OnsetSlice,
  currFingers: Finger[],
  profile: HandSpanProfile,
  ignoreAnchors = false
): { cost: number; hasWideStretch: boolean; hasUnreachableSpan: boolean } {
  const scale = getSpanScale(profile);
  const dt = Math.max(0.05, currSlice.onsetSec - prevSlice.onsetSec);
  const hand = currSlice.hand;
  const effectivePrevFingers = resolveDepartureFingers(prevSlice, prevFingers, ignoreAnchors);

  let cost = 0;
  let hasWideStretch = false;
  let hasUnreachableSpan = false;

  // Use outer/primary note representatives for monophonic or chord-to-chord transition
  const prevNote = prevSlice.notes[0];
  const prevFinger = effectivePrevFingers[0];
  const currNote = currSlice.notes[0];
  const currFinger = currFingers[0];

  const posPrev = toHandFramePos(prevNote.midi, hand);
  const posCurr = toHandFramePos(currNote.midi, hand);
  const d = posCurr - posPrev;
  const absD = Math.abs(d);

  // Only single-note / anchor transition rules when monophonic or matching voice count
  const isMonoPair = prevSlice.notes.length === 1 && currSlice.notes.length === 1;
  const isThumbUnder =
    isMonoPair && d > 0.2 && absD <= 3.5 * scale && currFinger === 1 && prevFinger >= 2 && prevFinger <= 4;
  const isCrossOver =
    isMonoPair && d < -0.2 && absD <= 3.5 * scale && prevFinger === 1 && currFinger >= 2 && currFinger <= 4;

  // Same finger check
  if (isMonoPair && prevFinger === currFinger) {
    if (prevNote.midi !== currNote.midi) {
      // Strongly discourage using the same finger on different consecutive notes
      cost += 8.0 + 2.2 * absD + (absD / dt) * 0.4;
    } else if (dt < 0.2) {
      // Fast same-key repetition rewards alternating fingers
      cost += 2.5;
    }
  }

  // Crossing rules
  if (isThumbUnder) {
    // Crossing after 3 is most natural; after 2 slightly more; after 4 slightly higher; onto black key penalized
    const fingerCrossPenalty = prevFinger === 3 ? 1.4 : prevFinger === 2 ? 1.8 : 2.3;
    cost += fingerCrossPenalty;
    if (absD > 2.8 * scale) {
      cost += (absD - 2.8 * scale) * 4.0;
    }
    if (isBlackKey(currNote.midi)) {
      cost += profile.avoidThumbOnBlack ? 6.0 : 0.3;
    }
  } else if (isCrossOver) {
    const fingerCrossPenalty = currFinger === 3 ? 1.5 : currFinger === 2 ? 1.9 : 2.4;
    cost += fingerCrossPenalty;
    if (absD > 2.8 * scale) {
      cost += (absD - 2.8 * scale) * 4.0;
    }
  } else if (isMonoPair && prevFinger !== currFinger) {
    // Monotonic order violation on close steps without valid thumb crossing
    if (absD <= 3.5 * scale && ((d > 0.2 && currFinger < prevFinger) || (d < -0.2 && currFinger > prevFinger))) {
      cost += 25.0 + 3.0 * absD;
    } else if (absD > 0.2 && absD <= 5.5 * scale && ((d > 0 && currFinger > prevFinger) || (d < 0 && currFinger < prevFinger))) {
      // Same-direction stretch check within hand-shift range
      const maxSpan = getMaxSpan(prevFinger, currFinger, scale);
      if (absD > maxSpan && dt < 0.2) {
        cost += 25.0 + (absD - maxSpan) * 8.0;
        hasUnreachableSpan = true;
      } else if (absD >= maxSpan * 0.85 && dt < 0.4) {
        cost += 3.5;
        hasWideStretch = true;
      }
      // Deviation from natural finger spacing when not shifting hand
      const expectedDist = Math.abs(currFinger - prevFinger) * scale;
      const stretchDiff = Math.abs(absD - expectedDist);
      if (stretchDiff > 0.65 && absD <= 4.0 * scale) {
        cost += 1.2 * (stretchDiff - 0.65);
      }
    }
  }

  // Chord-involved transitions: discourage rapid reuse of same finger on a different pitch
  if (!isMonoPair && dt < 0.5) {
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
            cost += 1.2 + 0.3 * dist;
          } else {
            cost += 4.0 + 1.0 * dist;
          }
        }
      }
    }
  }

  // Hand root shift & travel velocity
  const prevRoot = computeHandRoot(prevSlice.notes, effectivePrevFingers, hand);
  const currRoot = computeHandRoot(currSlice.notes, currFingers, hand);
  const rootShift = Math.abs(currRoot - prevRoot);

  const freeShift = isThumbUnder || isCrossOver ? 3.5 : 0.75;
  if (rootShift > freeShift) {
    const shiftWeight = profile.preferStablePosition ? 3.2 : 1.5;
    cost += shiftWeight * (rootShift - freeShift);
  }

  // Velocity term
  const velocity = rootShift / (dt + 0.1);
  if (velocity > 6.0) {
    cost += 0.25 * (velocity - 6.0);
  }

  return { cost, hasWideStretch, hasUnreachableSpan };
}
