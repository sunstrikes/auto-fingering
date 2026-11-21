import {
  DEFAULT_HAND_SPAN_PROFILE,
  type Finger,
  type Hand,
  type HandSpanProfile,
  type NoteEvent,
  type OnsetSlice,
} from "../domain/types";
import {
  evaluateHandKinematics2D,
  type KinematicContact,
} from "./handKinematics";
import {
  MAX_OCTAVE_SPAN,
  getComfortSpan,
  getMaxSpan,
  getSpanScale,
  isBlackKey,
  toHandFramePos,
} from "./keyboard";
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
      if (dist <= maxSpan + 1e-6) continue;

      const canImprove = allCandidates.some((alt) => {
        const altSpan = getMaxSpan(alt[i], alt[j], scale);
        return altSpan + 1e-6 >= dist || (notes.length === 2 && altSpan > maxSpan);
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
 * Selects optimal chord fingering candidates (3+ notes) based on vertical chord
 * ergonomics. Returns a single fixed shape when no held notes are active, or
 * up to Top-3 diverse shapes (including best thumb-free and pinky-free alternatives)
 * when cross-slice held notes are present so DP/A* can avoid finger stealing.
 */
function selectOptimalChordTuples(
  slice: OnsetSlice,
  candidates: Finger[][],
  profile: HandSpanProfile
): Finger[][] {
  if (candidates.length <= 1) return candidates;
  const scored = candidates.map((tuple) => ({
    tuple,
    cost: computeVerticalCost(slice, tuple, EMPTY_HELD_FINGERS, profile).cost,
  }));
  scored.sort((a, b) => a.cost - b.cost);

  if (slice.heldNotes.length === 0) {
    return [scored[0].tuple];
  }

  const selected: Finger[][] = [scored[0].tuple];
  const addFirstMatching = (pred: (t: Finger[]) => boolean): void => {
    const found = scored.find(
      (item) => !selected.includes(item.tuple) && pred(item.tuple)
    );
    if (found) selected.push(found.tuple);
  };

  addFirstMatching((t) => !t.includes(1));
  addFirstMatching((t) => !t.includes(5));
  for (const item of scored) {
    if (selected.length >= 3) break;
    if (!selected.includes(item.tuple)) {
      selected.push(item.tuple);
    }
  }
  return selected;
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
        ? selectOptimalChordTuples(slice, allCandidates, profile)
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
        ? selectOptimalChordTuples(slice, allCandidates, profile)
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

export function computePairwiseSpanCost(
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
  const comfortSpan = getComfortSpan(fA, fB, scale);
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

  if (dist > MAX_OCTAVE_SPAN + 1e-6) {
    const over = dist - MAX_OCTAVE_SPAN;
    cost += IMPOSSIBLE_COST + over * 1000 + (5 - Math.abs(fB - fA)) * 100;
    hasUnreachableSpan = true;
    return { cost, hasUnreachableSpan, hasWideStretch };
  }

  if (dist > maxSpan + 1e-6) {
    const over = dist - maxSpan;
    cost +=
      Math.max(vw.overSpanBase, vw.heldStealPenalty * 2) +
      over * 120 +
      vw.overSpanTiebreaker * over;
    hasUnreachableSpan = true;
  } else if (dist >= comfortSpan * vw.wideStretchThreshold - 1e-6) {
    const nonThumbBias =
      Math.min(fA, fB) >= 2 && dist >= comfortSpan * vw.wideStretchNonThumbThreshold
        ? vw.wideStretchNonThumbBias
        : 1.0;
    cost +=
      vw.wideStretchBase * (dist / comfortSpan) * shapeWeight * stretchBias * nonThumbBias;
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

function evaluateHeldInversionCost(
  fA: Finger,
  posA: number,
  fB: Finger,
  posB: number,
  scale: number,
  weights: CostWeights
): { cost: number; hasUnreachableSpan: boolean } {
  if (!((fA > fB && posA < posB - 0.5) || (fA < fB && posA > posB + 0.5))) {
    return { cost: 0, hasUnreachableSpan: false };
  }
  const invDist = Math.abs(posA - posB);
  const involvesThumb = fA === 1 || fB === 1;
  const involvesPinky = fA === 5 || fB === 5;
  // Non-thumb held inversions and wide/thumb-pinky inversions are anatomically impossible;
  // preserve soft crossing cost only for thumb-involving crossings within crossMax * scale.
  if (!involvesThumb || involvesPinky || invDist > weights.horizontal.crossMax * scale) {
    return { cost: IMPOSSIBLE_COST + invDist, hasUnreachableSpan: true };
  }
  return { cost: weights.vertical.heldInversionThumb, hasUnreachableSpan: false };
}

function matchesFingerTuple(fingers: Finger[], target: readonly Finger[]): boolean {
  if (fingers.length !== target.length) return false;
  for (let i = 0; i < target.length; i++) {
    if (fingers[i] !== target[i]) return false;
  }
  return true;
}

/**
 * Soft voicing geometry prior for 3-note and 4-note chords based on root/inversion
 * interval gaps, complementing pure 2D kinematics on black-key and inner-finger choices.
 */
function computeChordVoicingPrior(
  slice: OnsetSlice,
  fingers: Finger[],
  _weights: CostWeights = DEFAULT_COST_WEIGHTS
): number {
  const notes = slice.notes;
  const k = notes.length;
  if (k !== 3 && k !== 4) return 0;
  const isRH = slice.hand === "RH";

  if (k === 3) {
    const m0 = notes[0].midi;
    const m1 = notes[1].midi;
    const m2 = notes[2].midi;
    const outerSemitones = m2 - m0;
    if (outerSemitones < 6 || outerSemitones > 9) return 0;

    const dLow = m1 - m0;
    const dHigh = m2 - m1;
    const outerOk = isRH
      ? fingers[0] === 1 && fingers[2] === 5
      : fingers[0] === 5 && fingers[2] === 1;

    // Root position triad (3rd + 3rd)
    if (dLow >= 3 && dLow <= 4 && dHigh >= 3 && dHigh <= 4) {
      if (!outerOk) return 2.6;
      return fingers[1] === 3 ? 0 : 1.8;
    }
    // 1st inversion triad (3rd + 4th)
    if (dLow >= 3 && dLow <= 4 && dHigh >= 5 && dHigh <= 6) {
      if (isRH) {
        if (matchesFingerTuple(fingers, [1, 2, 5])) return 0;
        return outerOk ? 1.8 : 1.8 + 1.5;
      }
      const blackBottomWhiteTop =
        isBlackKey(m0) && !isBlackKey(m1) && !isBlackKey(m2);
      if (
        matchesFingerTuple(fingers, [5, 3, 1]) ||
        (blackBottomWhiteTop && matchesFingerTuple(fingers, [5, 2, 1]))
      ) {
        return 0;
      }
      return 1.6;
    }
    // 2nd inversion triad (4th + 3rd)
    if (dLow >= 5 && dLow <= 6 && dHigh >= 3 && dHigh <= 4) {
      const target = isRH ? ([1, 3, 5] as const) : ([5, 2, 1] as const);
      return matchesFingerTuple(fingers, target) ? 0 : 1.8;
    }
    return 0;
  }

  // 4-note chord (octave triad inversions & 7th chords)
  const m0 = notes[0].midi;
  const m1 = notes[1].midi;
  const m2 = notes[2].midi;
  const m3 = notes[3].midi;
  const outerSemitones = m3 - m0;
  if (outerSemitones < 9 || outerSemitones > 12) return 0;

  const outerOk = isRH
    ? fingers[0] === 1 && fingers[3] === 5
    : fingers[0] === 5 && fingers[3] === 1;
  let prior = outerOk ? 0 : 2.8;

  const d0 = m1 - m0;
  const d1 = m2 - m1;
  const d2 = m3 - m2;
  if (Math.max(d0, d1, d2) >= 5) {
    if (d2 >= 5 && d2 > d1 && d2 > d0) {
      // Top 4th gap (e.g. root-position octave triad)
      if (isRH) {
        if (!matchesFingerTuple(fingers, [1, 2, 3, 5])) prior += 1.6;
      } else {
        const hasBlack = notes.some((n) => isBlackKey(n.midi));
        const ok =
          matchesFingerTuple(fingers, [5, 3, 2, 1]) ||
          (!hasBlack && matchesFingerTuple(fingers, [5, 4, 2, 1]));
        if (!ok) prior += 1.6;
      }
    } else if (d1 >= 5 && d1 > d0 && d1 > d2) {
      // Middle 4th gap (e.g. 1st-inversion octave triad)
      const target = isRH ? ([1, 2, 4, 5] as const) : ([5, 4, 2, 1] as const);
      if (!matchesFingerTuple(fingers, target)) prior += 1.6;
    } else if (d0 >= 5 && d0 > d1 && d0 > d2) {
      // Bottom 4th gap (e.g. 2nd-inversion octave triad)
      if (isRH) {
        const ok =
          matchesFingerTuple(fingers, [1, 2, 4, 5]) ||
          (isBlackKey(m1) && matchesFingerTuple(fingers, [1, 3, 4, 5]));
        if (!ok) prior += 1.6;
      } else {
        if (!matchesFingerTuple(fingers, [5, 3, 2, 1])) prior += 1.6;
      }
    }
  }

  return prior;
}

export function computeVerticalCost(
  slice: OnsetSlice,
  fingers: Finger[],
  heldFingers: Map<Finger, number>,
  profile: HandSpanProfile,
  weights: CostWeights = DEFAULT_COST_WEIGHTS,
  softPriorBias = 0
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
  const k = notes.length;
  const outerSemitones = k >= 2 ? notes[k - 1].midi - notes[0].midi : 0;
  const isOuterChordFrame = k >= 3 && outerSemitones >= 5;
  const thumbSideIdx = slice.hand === "RH" ? 0 : k - 1;
  const pinkySideIdx = slice.hand === "RH" ? k - 1 : 0;
  const contacts: KinematicContact[] = [];
  const activeNoteMidisByFinger = new Map<Finger, number>();
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const f = fingers[i];
    if (!f) continue;
    const posS = toHandFramePos(n.midi, slice.hand);
    contacts.push({
      finger: f,
      handFramePos: posS,
      isBlack: isBlackKey(n.midi),
      isHeld: false,
    });
    activeNoteMidisByFinger.set(f, n.midi);

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

      const inv = evaluateHeldInversionCost(f, posS, fH, posH, scale, weights);
      cost += inv.cost;
      if (inv.hasUnreachableSpan) hasUnreachableSpan = true;
    }

    // Weak fingers (4, 5) preference
    if (f === 4) cost += vw.finger4 * weakMultiplier;
    if (f === 5) cost += vw.finger5 * weakMultiplier;

    // Black key thumb / pinky penalties (exempt outer 1/5 frame on 3+ note chords)
    if (isBlackKey(n.midi)) {
      if (f === 1) {
        cost +=
          isOuterChordFrame && i === thumbSideIdx
            ? vw.thumbBlackLearned
            : thumbBlackCost;
      }
      if (f === 5) {
        cost +=
          isOuterChordFrame && i === pinkySideIdx
            ? vw.pinkyBlack * 0.15
            : vw.pinkyBlack;
      }
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

  if (heldFingers.size >= 2) {
    const heldEntries = Array.from(heldFingers.entries());
    for (let a = 0; a < heldEntries.length; a++) {
      const [fA, midiA] = heldEntries[a];
      const posA = toHandFramePos(midiA, slice.hand);
      for (let b = a + 1; b < heldEntries.length; b++) {
        const [fB, midiB] = heldEntries[b];
        const posB = toHandFramePos(midiB, slice.hand);
        const pair = computePairwiseSpanCost(
          fA,
          posA,
          fB,
          posB,
          scale,
          vw.heldShapeWeight,
          profile.preset,
          Infinity,
          weights
        );
        cost += pair.cost;
        if (pair.hasUnreachableSpan) hasUnreachableSpan = true;
        if (pair.hasWideStretch) hasWideStretch = true;

        const inv = evaluateHeldInversionCost(fA, posA, fB, posB, scale, weights);
        cost += inv.cost;
        if (inv.hasUnreachableSpan) hasUnreachableSpan = true;
      }
    }
  }

  if (heldFingers.size > 0) {
    for (const [fH, midiH] of heldFingers.entries()) {
      if (activeNoteMidisByFinger.get(fH) === midiH) continue;
      contacts.push({
        finger: fH,
        handFramePos: toHandFramePos(midiH, slice.hand),
        isBlack: isBlackKey(midiH),
        isHeld: true,
      });
    }
  }

  const kin2d = evaluateHandKinematics2D(contacts, scale, weights.horizontal.crossMax);
  if (!kin2d.feasible) {
    cost += IMPOSSIBLE_COST + kin2d.infeasibilityExcess;
    hasUnreachableSpan = true;
  } else {
    const poseComfort = Math.max(0, kin2d.comfortEnergy - kin2d.crowdingEnergy);
    cost += kin2d.crowdingEnergy + poseComfort * 0.15;
  }

  cost += computeChordVoicingPrior(slice, fingers, weights);
  cost += softPriorBias;

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

function computeCrossingExtra(
  isThumbUnder: boolean,
  nonThumbFinger: Finger,
  prevIsBlack: boolean,
  currIsBlack: boolean,
  absD: number,
  hw: CostWeights["horizontal"]
): number {
  if (isThumbUnder && prevIsBlack && !currIsBlack) {
    // Black-key pivot to white-key thumb: 4->1 and 3->1 feel natural; short <1.0 2->1 is discouraged
    return nonThumbFinger === 4
      ? 0.45
      : nonThumbFinger === 3
        ? -0.35
        : absD >= 1.0
          ? hw.cross2Extra
          : hw.cross2Extra + 1.4;
  }
  if (!isThumbUnder && !prevIsBlack && currIsBlack) {
    // White-key thumb crossing onto raised black key (e.g. LH 1->4, 1->3)
    return nonThumbFinger === 4
      ? -1.1
      : nonThumbFinger === 3
        ? -0.25
        : hw.cross2Extra;
  }
  if (!prevIsBlack && !currIsBlack && nonThumbFinger === 2 && absD <= 1.25) {
    // Suppress pure white-key stepwise 2<->1 chopping
    return hw.cross2Extra + 2.4;
  }
  return nonThumbFinger === 2 ? hw.cross2Extra : nonThumbFinger === 4 ? hw.cross4Extra : 0;
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
  allowSamePitchBonus: boolean,
  skipAirborneSameFinger = false
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
  const prevIsBlack = isBlackKey(prevMidi);
  const currIsBlack = isBlackKey(currMidi);

  const isThumbUnder =
    d > 0.2 && absD <= hw.crossMax * scale && currFinger === 1 && prevFinger >= 2 && prevFinger <= 4;
  const isCrossOver =
    d < -0.2 && absD <= hw.crossMax * scale && prevFinger === 1 && currFinger >= 2 && currFinger <= 4;

  let cost = 0;
  let hasWideStretch = false;
  let hasUnreachableSpan = false;

  if (prevFinger === currFinger) {
    if (prevMidi !== currMidi) {
      if (!(skipAirborneSameFinger && absD > hw.crossMax)) {
        cost += hw.sameFingerBase + hw.sameFingerDist * absD + (absD / dt) * hw.sameFingerVelocity;
      }
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

  if (isThumbUnder || isCrossOver) {
    const nonThumbFinger = isThumbUnder ? prevFinger : currFinger;
    const extra = computeCrossingExtra(
      isThumbUnder,
      nonThumbFinger,
      prevIsBlack,
      currIsBlack,
      absD,
      hw
    );
    cost += hw.crossBase + extra;
    if (absD > hw.crossWideThreshold * scale) {
      cost += (absD - hw.crossWideThreshold * scale) * hw.crossWideSlope;
    }
    if (isThumbUnder && currIsBlack) {
      cost += profile.avoidThumbOnBlack
        ? hw.crossThumbBlackAvoid
        : hw.crossThumbBlackLearned;
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
    ((d > 0 && currFinger > prevFinger) || (d < 0 && currFinger < prevFinger))
  ) {
    // Same-direction stretch check (covers octave-scale spans without a 5.5 blind spot)
    const maxSpan = getMaxSpan(prevFinger, currFinger, scale);
    const comfortSpan = getComfortSpan(prevFinger, currFinger, scale);
    if (absD > maxSpan + 1e-6 && dt < 0.2) {
      cost += hw.fastOverSpanBase + (absD - maxSpan) * hw.fastOverSpanSlope;
      hasUnreachableSpan = true;
    } else if (absD >= comfortSpan * weights.vertical.wideStretchThreshold - 1e-6 && dt < 0.4) {
      cost += hw.fastWideStretch;
      hasWideStretch = true;
    }
    if (absD <= 4.0 * scale) {
      const expectedDist = Math.abs(currFinger - prevFinger) * scale;
      const rawDiff = absD - expectedDist;
      if (rawDiff > hw.stretchDeviationThreshold) {
        cost += (hw.stretchDeviation + hw.stretchLinear) * (rawDiff - hw.stretchDeviationThreshold);
      } else if (-rawDiff > hw.stretchDeviationThreshold) {
        cost += hw.crampLinear * (-rawDiff - hw.stretchDeviationThreshold);
      }
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
  weights: CostWeights = DEFAULT_COST_WEIGHTS,
  softPriorBias = 0
): { cost: number; hasWideStretch: boolean; hasUnreachableSpan: boolean } {
  const hw = weights.horizontal;
  const scale = getSpanScale(profile);
  const dt = Math.max(0.05, currSlice.onsetSec - prevSlice.onsetSec);
  const hand = currSlice.hand;
  const effectivePrevFingers = resolveDepartureFingers(prevSlice, prevFingers, ignoreAnchors);

  let cost = softPriorBias;
  let hasWideStretch = false;
  let hasUnreachableSpan = false;
  let hasCrossing = false;

  const isMonoPair = prevSlice.notes.length === 1 && currSlice.notes.length === 1;

  if (isMonoPair) {
    const prevMidi = prevSlice.notes[0].midi;
    const currMidi = currSlice.notes[0].midi;
    const res = evaluateDirectedNoteTransition(
      prevMidi,
      effectivePrevFingers[0],
      currMidi,
      currFingers[0],
      hand,
      scale,
      dt,
      profile,
      weights,
      true
    );
    cost += res.cost;
    // Suppress same-finger stepwise slides (e.g. 5->5 / 1->1) in monophonic scale passages
    const semitoneDiff = Math.abs(currMidi - prevMidi);
    if (
      effectivePrevFingers[0] === currFingers[0] &&
      semitoneDiff >= 1 &&
      semitoneDiff <= 2 &&
      dt <= 0.35
    ) {
      cost += 2.5;
    }
    hasCrossing = res.isThumbUnder || res.isCrossOver;
    if (res.hasWideStretch) hasWideStretch = true;
    if (res.hasUnreachableSpan) hasUnreachableSpan = true;
  } else {
    // Chord-involved transition: align voices on equal-size or disjoint chords; nearest pitch otherwise
    const prevLen = prevSlice.notes.length;
    const currLen = currSlice.notes.length;
    const bothChords = prevLen >= 2 && currLen >= 2;
    const disjointChordLeap =
      bothChords &&
      (currSlice.notes[currLen - 1].midi <= prevSlice.notes[0].midi ||
        currSlice.notes[0].midi >= prevSlice.notes[prevLen - 1].midi);
    const skipAirborneSameFinger = bothChords || dt >= 0.4;

    let pairedCostSum = 0;
    for (let j = 0; j < currLen; j++) {
      const currNote = currSlice.notes[j];
      const currF = currFingers[j];
      let bestIdx = 0;
      if (bothChords && prevLen === currLen) {
        bestIdx = j;
      } else if (disjointChordLeap) {
        bestIdx = Math.round((j * (prevLen - 1)) / (currLen - 1));
      } else {
        let bestPitchDiff = Math.abs(prevSlice.notes[0].midi - currNote.midi);
        for (let i = 1; i < prevLen; i++) {
          const diff = Math.abs(prevSlice.notes[i].midi - currNote.midi);
          if (diff < bestPitchDiff) {
            bestPitchDiff = diff;
            bestIdx = i;
          }
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
        false,
        skipAirborneSameFinger
      );
      pairedCostSum += res.cost;
      if (!bothChords && (res.isThumbUnder || res.isCrossOver)) hasCrossing = true;
      if (res.hasWideStretch) hasWideStretch = true;
      if (res.hasUnreachableSpan) hasUnreachableSpan = true;
    }
    cost += (pairedCostSum / Math.max(1, currLen)) * hw.chordOuterTransitionWeight;

    // Parallel chord shape transition preference (same finger shape on stepwise parallel chords)
    if (bothChords && prevLen === currLen) {
      const firstShift = currSlice.notes[0].midi - prevSlice.notes[0].midi;
      let isParallel = firstShift !== 0;
      let sameShape = true;
      for (let i = 0; i < currLen; i++) {
        if (currSlice.notes[i].midi - prevSlice.notes[i].midi !== firstShift) {
          isParallel = false;
        }
        if (effectivePrevFingers[i] !== currFingers[i]) {
          sameShape = false;
        }
      }
      if (isParallel) {
        cost += hw.parallelChordShapeShift;
        const outerSpan = currSlice.notes[currLen - 1].midi - currSlice.notes[0].midi;
        if (!sameShape && outerSpan < 7 && Math.abs(firstShift) <= 2) {
          cost += hw.parallelChordSameShape;
        }
      }
    }

    // Discourage rapid reuse of same finger across different chord pitches
    if (dt < 0.5) {
      for (let i = 0; i < prevLen; i++) {
        for (let j = 0; j < currLen; j++) {
          if (
            effectivePrevFingers[i] === currFingers[j] &&
            prevSlice.notes[i].midi !== currSlice.notes[j].midi
          ) {
            const dist = Math.abs(
              toHandFramePos(currSlice.notes[j].midi, hand) -
                toHandFramePos(prevSlice.notes[i].midi, hand)
            );
            if (bothChords && dist > hw.crossMax) continue;
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

  const is41Crossing =
    isMonoPair &&
    hasCrossing &&
    ((effectivePrevFingers[0] === 4 && currFingers[0] === 1) ||
      (effectivePrevFingers[0] === 1 && currFingers[0] === 4));
  const freeShift = hasCrossing
    ? is41Crossing
      ? Math.max(hw.shiftFreeCross, 4.5)
      : hw.shiftFreeCross
    : hw.shiftFreeBase;
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

  // High-speed hand leap penalty (for crossings, only excess shift beyond freeShift counts as a leap)
  const leapShift = hasCrossing ? Math.max(0, rootShift - freeShift) : rootShift;
  const velocity = leapShift / (dt + 0.1);
  if (velocity > hw.velocityThreshold) {
    cost += hw.velocitySlope * (velocity - hw.velocityThreshold);
  }

  return { cost, hasWideStretch, hasUnreachableSpan };
}
