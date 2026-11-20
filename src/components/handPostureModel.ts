import { computeTieChainEndByRoot } from "../domain/tieUtils";
import {
  DEFAULT_HAND_SPAN_PROFILE,
  type Finger,
  type Hand,
  type HandPosition,
  type HandSpanProfile,
  type NoteEvent,
  type OnsetSlice,
  type ScoreDocument,
  type SolveResult,
  type SpanPreset,
} from "../domain/types";
import { analyzeHandHeldNotes } from "../solver/heldNotes";
import {
  MAX_OCTAVE_SPAN,
  SPAN_PRESET_SCALE,
  getMaxSpan,
  isBlackKey,
  keyPos,
  toHandFramePos,
  whiteKeyIndex,
} from "../solver/keyboard";
import { DEFAULT_COST_WEIGHTS } from "../solver/weights";
import {
  buildTransitionCueArcs,
  findHandPositionForSlice,
  whiteKeyIndexToMidi,
  type TransitionCueArc,
} from "./dualTrackModel";
import {
  BLACK_TIP_Y,
  PIANO_WHITE_KEY_W,
  WHITE_TIP_Y,
  getAbductRatio,
  getFingerOriginLocalPx,
  getFingerReachPx,
  getKnuckleBaseY,
} from "./handSkeleton";

export const PIANO_MIN_MIDI = 21; // A0
export const PIANO_MAX_MIDI = 108; // C8
export const PIANO_WHITE_KEY_COUNT = 52;
const A0_WHITE_INDEX = whiteKeyIndex(PIANO_MIN_MIDI); // 5

const FINGERS: Finger[] = [1, 2, 3, 4, 5];
const GRACE_VISUAL_SEC = 0.09;
const ATTACK_SEC = 0.035;
const RELEASE_SEC = 0.045;
const MAX_SHIFT_WINDOW_SEC = 0.15;
const MIN_SHIFT_WINDOW_SEC = 0.055;
const REST_GAP_SEC = 1.1;

export interface KeyHighlightState {
  rh?: "active" | "held";
  lh?: "active" | "held";
  rhFinger?: Finger;
  lhFinger?: Finger;
  rhPedalSustained?: boolean;
  lhPedalSustained?: boolean;
  isRepairedAnchor?: boolean;
}

export interface FingerPosture {
  finger: Finger;
  xUnit: number;
  isBlack: boolean;
  pressDepth: number;
  isHeld: boolean;
  isStruck: boolean;
  targetMidi: number | null;
  noteUid?: string;
  isAnchor?: boolean;
  isRepairedAnchor?: boolean;
  layerOffset: -1 | 0 | 1;
}

export interface HandPosture {
  hand: Hand;
  spanPreset?: SpanPreset;
  isResting: boolean;
  activeSliceId: string | null;
  palmCenterXUnit: number;
  palmLiftY: number;
  palmAngleDeg: number;
  crossingStyle: "none" | "thumb-under" | "cross-over";
  fingers: Record<Finger, FingerPosture>;
  handPosition: HandPosition | null;
  transitionCues: TransitionCueArc[];
  pedalSustainedKeys?: Array<{ midi: number; finger?: Finger; isRepairedAnchor?: boolean }>;
}

export interface DualHandPostureFrame {
  scoreSec: number;
  activeKeyHighlights: Map<number, KeyHighlightState>;
  rh: HandPosture;
  lh: HandPosture;
}

interface SoundingWindow {
  ev: NoteEvent;
  sliceId: string;
  onsetSec: number;
  endSec: number;
  fingerEndSec: number;
}

interface HandIndexData {
  hand: Hand;
  slices: OnsetSlice[];
  sliceStartSec: number[];
  windows: SoundingWindow[];
}

export interface HandPostureIndex {
  scoreDoc: ScoreDocument;
  solveResult: SolveResult;
  spanPreset: SpanPreset;
  sliceIndexById: Map<string, number>;
  repairedSet: Set<string>;
  rh: HandIndexData;
  lh: HandIndexData;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Converts a MIDI pitch (21..108) to continuous 88-key white-key horizontal units [0..52].
 */
export function midiToWhiteUnitX(midi: number): number {
  return clamp(keyPos(midi) - A0_WHITE_INDEX, 0.35, PIANO_WHITE_KEY_COUNT - 0.35);
}

function whiteIdxToUnit(whiteIdx: number): number {
  return midiToWhiteUnitX(whiteKeyIndexToMidi(whiteIdx));
}

/**
 * Checks whether two simultaneously held/struck fingers violate physical reuse,
 * anatomical span ceiling, or prohibited held-note inversion (preserving thumb
 * crossings within `crossMax * handScale`, excluding thumb-pinky).
 */
function hasHeldFingerConflict(
  fA: Finger,
  midiA: number,
  fB: Finger,
  midiB: number,
  hand: Hand,
  handScale: number
): boolean {
  if (fA === fB) {
    return midiA !== midiB;
  }
  const maxAllowed = Math.min(getMaxSpan(fA, fB, handScale), MAX_OCTAVE_SPAN);
  if (Math.abs(keyPos(midiA) - keyPos(midiB)) > maxAllowed + 1e-4) {
    return true;
  }
  const posA = toHandFramePos(midiA, hand);
  const posB = toHandFramePos(midiB, hand);
  const isInverted = (fA > fB && posA < posB - 0.5) || (fA < fB && posA > posB + 0.5);
  if (!isInverted) {
    return false;
  }
  const invDist = Math.abs(posA - posB);
  const involvesThumb = fA === 1 || fB === 1;
  const involvesPinky = fA === 5 || fB === 5;
  return (
    !involvesThumb ||
    involvesPinky ||
    invDist > DEFAULT_COST_WEIGHTS.horizontal.crossMax * handScale
  );
}

function buildHandIndex(
  hand: Hand,
  scoreDoc: ScoreDocument,
  solveResult: SolveResult,
  profile: HandSpanProfile,
  chainEndSecByRoot: Map<string, number>
): HandIndexData {
  const slices = scoreDoc.onsetSlices.filter((s) => s.hand === hand);
  const sliceStartSec = slices.map((s) => s.onsetSec);
  const { activeHeldBySlice, releasedHeldBySlice } = analyzeHandHeldNotes(slices, profile);
  const handScale = SPAN_PRESET_SCALE[profile.preset];

  const fingerReleaseSecByUid = new Map<string, number>();
  const recordRelease = (uid: string, releaseSec: number) => {
    const existing = fingerReleaseSecByUid.get(uid);
    if (existing === undefined || releaseSec < existing) {
      fingerReleaseSecByUid.set(uid, releaseSec);
    }
  };

  for (let t = 0; t < slices.length; t++) {
    const slice = slices[t];
    for (const rel of releasedHeldBySlice[t]) {
      recordRelease(rel.noteUid, slice.onsetSec);
    }

    // Defensive guard for manual pinOnly overrides or residual finger collisions/over-spans
    const activeNewestFirst = [...activeHeldBySlice[t]].sort(
      (a, b) => (b.onsetTick ?? 0) - (a.onsetTick ?? 0)
    );
    const acceptedActive: typeof activeNewestFirst = [];
    for (const h of activeNewestFirst) {
      const fH = solveResult.fingerByNoteUid[h.noteUid];
      if (!fH) continue;
      let released = false;
      for (const n of slice.notes) {
        const fN = solveResult.fingerByNoteUid[n.noteUid];
        if (!fN) continue;
        if (hasHeldFingerConflict(fH, h.midi, fN, n.midi, hand, handScale)) {
          recordRelease(h.noteUid, slice.onsetSec);
          released = true;
          break;
        }
      }
      if (!released) {
        for (const newer of acceptedActive) {
          const fNewer = solveResult.fingerByNoteUid[newer.noteUid];
          if (!fNewer) continue;
          if (hasHeldFingerConflict(fH, h.midi, fNewer, newer.midi, hand, handScale)) {
            recordRelease(h.noteUid, slice.onsetSec);
            released = true;
            break;
          }
        }
      }
      if (!released) {
        acceptedActive.push(h);
      }
    }
  }

  // Clip artificial 0.08s/0.09s visual minimum tails that bleed across a subsequent slice
  // when the note has already logically ended and conflicts with the next slice's fingering/span.
  for (let t = 0; t < slices.length; t++) {
    const slice = slices[t];
    for (const ev of slice.notes) {
      if (ev.isTieStop) continue;
      const fEv = solveResult.fingerByNoteUid[ev.noteUid];
      if (!fEv) continue;
      const logicalEndSec = ev.isGrace
        ? ev.onsetSec
        : (chainEndSecByRoot.get(ev.noteUid) ?? ev.onsetSec + ev.durationSec);
      const rawEnd = ev.isGrace
        ? ev.onsetSec + GRACE_VISUAL_SEC
        : chainEndSecByRoot.get(ev.noteUid) ?? ev.onsetSec + Math.max(0.08, ev.durationSec);
      const endSec = Math.max(ev.onsetSec + 0.08, rawEnd);
      if (endSec <= logicalEndSec + 1e-4) continue;

      for (let k = t + 1; k < slices.length; k++) {
        const nextSlice = slices[k];
        if (nextSlice.onsetSec >= endSec + 1e-4) break;
        if (nextSlice.onsetSec <= ev.onsetSec + 1e-4) continue;
        if (nextSlice.onsetSec < logicalEndSec - 1e-4) continue;
        if (nextSlice.heldNotes.some((h) => h.noteUid === ev.noteUid)) continue;

        let conflicts = false;
        for (const n of nextSlice.notes) {
          const fN = solveResult.fingerByNoteUid[n.noteUid];
          if (!fN) continue;
          if (hasHeldFingerConflict(fEv, ev.midi, fN, n.midi, hand, handScale)) {
            conflicts = true;
            break;
          }
        }
        if (!conflicts) {
          for (const h of activeHeldBySlice[k]) {
            const fH = solveResult.fingerByNoteUid[h.noteUid];
            if (!fH) continue;
            if (hasHeldFingerConflict(fEv, ev.midi, fH, h.midi, hand, handScale)) {
              conflicts = true;
              break;
            }
          }
        }
        if (conflicts) {
          recordRelease(ev.noteUid, nextSlice.onsetSec);
          break;
        }
      }
    }
  }

  const windows: SoundingWindow[] = [];

  for (const slice of slices) {
    for (const ev of slice.notes) {
      if (ev.isTieStop) continue;
      const rawEnd = ev.isGrace
        ? ev.onsetSec + GRACE_VISUAL_SEC
        : chainEndSecByRoot.get(ev.noteUid) ?? ev.onsetSec + Math.max(0.08, ev.durationSec);
      const endSec = Math.max(ev.onsetSec + 0.08, rawEnd);
      const releaseAtSec = fingerReleaseSecByUid.get(ev.noteUid);
      const fingerEndSec =
        releaseAtSec !== undefined && releaseAtSec < endSec
          ? Math.max(
              ev.onsetSec + Math.min(0.02, Math.max(0, (releaseAtSec - ev.onsetSec) * 0.5)),
              releaseAtSec - 0.005
            )
          : endSec;
      windows.push({
        ev,
        sliceId: slice.sliceId,
        onsetSec: ev.onsetSec,
        endSec,
        fingerEndSec,
      });
    }
  }

  return { hand, slices, sliceStartSec, windows };
}

/**
 * Precomputes fast per-hand lookup tables for 60fps `Hand Posture` evaluation.
 */
export function buildHandPostureIndex(
  scoreDoc: ScoreDocument,
  solveResult: SolveResult,
  profile: HandSpanProfile = DEFAULT_HAND_SPAN_PROFILE
): HandPostureIndex {
  const sliceIndexById = new Map<string, number>();
  scoreDoc.onsetSlices.forEach((s, i) => sliceIndexById.set(s.sliceId, i));
  const chainEndSecByRoot = computeTieChainEndByRoot(scoreDoc.noteEvents, "sec");

  return {
    scoreDoc,
    solveResult,
    spanPreset: profile.preset,
    sliceIndexById,
    repairedSet: new Set(solveResult.repairedAnchorUids),
    rh: buildHandIndex("RH", scoreDoc, solveResult, profile, chainEndSecByRoot),
    lh: buildHandIndex("LH", scoreDoc, solveResult, profile, chainEndSecByRoot),
  };
}

function findLatestSliceIndexAt(sliceStartSec: number[], scoreSec: number): number {
  let lo = 0;
  let hi = sliceStartSec.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sliceStartSec[mid] <= scoreSec + 1e-4) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

const RELAXED_OFFSET_FROM_3: Record<Finger, number> = {
  1: -1.95,
  2: -0.92,
  3: 0,
  4: 0.9,
  5: 1.78,
};

const BLACK_KEY_PALM_SHIFT: Record<Finger, number> = {
  1: -36,
  2: -26,
  3: -22,
  4: -26,
  5: -34,
};

function defaultRestSlots(hand: Hand, handScale = 1): Record<Finger, number> {
  // RH rests near C4..G4 (white units ~23.5..27.3); LH rests near C3..G3 (units ~16.7..20.5)
  const center = hand === "RH" ? 25.5 : 18.5;
  const dir = hand === "RH" ? 1 : -1;
  return {
    1: center + RELAXED_OFFSET_FROM_3[1] * handScale * dir,
    2: center + RELAXED_OFFSET_FROM_3[2] * handScale * dir,
    3: center,
    4: center + RELAXED_OFFSET_FROM_3[4] * handScale * dir,
    5: center + RELAXED_OFFSET_FROM_3[5] * handScale * dir,
  };
}

const INTER_FINGER_STRETCH_WEIGHT: Record<1 | 2 | 3 | 4, number> = {
  1: 2.3,
  2: 1.15,
  3: 0.9,
  4: 1.15,
};

const MAX_IDLE_ADJ_GAP: Record<1 | 2 | 3 | 4, number> = {
  1: 4.2,
  2: 2.1,
  3: 1.75,
  4: 2.0,
};

/**
 * Keeps non-pinned fingers anatomically ordered between pinned/sounding neighbors
 * and prevents unnaturally wide gaps or bunching between idle adjacent fingers.
 */
function enforceAnatomicalFingerOrder(
  slots: Record<Finger, number>,
  pinnedFingers: Set<Finger>,
  dir: 1 | -1,
  allowThumbCross: boolean,
  handScale = 1
): void {
  const startFinger: Finger = allowThumbCross ? 2 : 1;
  const orderedPinned: Finger[] = [];
  for (let f = startFinger; f <= 5; f++) {
    const finger = f as Finger;
    if (pinnedFingers.has(finger)) {
      orderedPinned.push(finger);
    }
  }
  if (orderedPinned.length === 0) return;

  // Map to hand-frame coordinates (increasing with finger 1..5)
  const u: Record<number, number> = {};
  for (const f of FINGERS) {
    u[f] = slots[f] * dir;
  }

  // Clamp fingers before the first pinned finger so u[f] <= u[firstP] (non-decreasing)
  const firstP = orderedPinned[0];
  for (let f = firstP - 1; f >= startFinger; f--) {
    if (u[f] > u[f + 1]) {
      const rel = (RELAXED_OFFSET_FROM_3[f as Finger] - RELAXED_OFFSET_FROM_3[(f + 1) as Finger]) * handScale;
      u[f] = u[f + 1] + rel;
    }
  }

  // Clamp/interpolate unpinned fingers between consecutive pinned fingers when out of order or gapped
  for (let i = 0; i < orderedPinned.length - 1; i++) {
    const fA = orderedPinned[i];
    const fB = orderedPinned[i + 1];
    if (fB - fA <= 1) continue;
    const lo = Math.min(u[fA], u[fB]);
    const hi = Math.max(u[fA], u[fB]);
    const span = hi - lo;
    const checkCramp = span >= (fB - fA) * 0.5 * handScale;

    let needsRedistribution = false;
    for (let f = fA; f < fB; f++) {
      const gap = u[f + 1] - u[f];
      if (gap < -1e-4 || u[f] < lo - 1e-4 || u[f + 1] > hi + 1e-4) {
        needsRedistribution = true;
        break;
      }
      const maxAdjGap = MAX_IDLE_ADJ_GAP[f as 1 | 2 | 3 | 4] * handScale;
      if (span > 0 && gap > maxAdjGap) {
        needsRedistribution = true;
        break;
      }
      if (checkCramp && gap < 0.35 * handScale) {
        needsRedistribution = true;
        break;
      }
    }

    if (needsRedistribution) {
      let totalW = 0;
      for (let f = fA; f < fB; f++) {
        totalW += INTER_FINGER_STRETCH_WEIGHT[f as 1 | 2 | 3 | 4];
      }
      let cumW = 0;
      for (let f = fA + 1; f < fB; f++) {
        cumW += INTER_FINGER_STRETCH_WEIGHT[(f - 1) as 1 | 2 | 3 | 4];
        u[f] = lerp(u[fA], u[fB], cumW / totalW);
      }
    }
  }

  // Clamp fingers after the last pinned finger so u[f] >= u[lastP] (non-decreasing)
  const lastP = orderedPinned[orderedPinned.length - 1];
  for (let f = lastP + 1; f <= 5; f++) {
    if (u[f] < u[f - 1]) {
      const rel = (RELAXED_OFFSET_FROM_3[f as Finger] - RELAXED_OFFSET_FROM_3[(f - 1) as Finger]) * handScale;
      u[f] = u[f - 1] + rel;
    }
  }

  for (let f = startFinger; f <= 5; f++) {
    const finger = f as Finger;
    if (!pinnedFingers.has(finger)) {
      slots[finger] = clamp(u[f] * dir, 0.4, PIANO_WHITE_KEY_COUNT - 0.4);
    }
  }
}

function computeBaseSlotsForSlice(
  hand: Hand,
  slice: OnsetSlice | null,
  handPosition: HandPosition | null,
  fingerByNoteUid: Record<string, Finger>,
  handScale = 1
): Record<Finger, number> {
  if (!slice) return defaultRestSlots(hand, handScale);

  const dir = hand === "RH" ? 1 : -1;
  let thumbUnit: number | null = null;
  let pinkyUnit: number | null = null;

  if (handPosition) {
    thumbUnit = whiteIdxToUnit(handPosition.thumbKey);
    pinkyUnit = whiteIdxToUnit(handPosition.pinkyKey);
  }

  // Fit fallback span from slice's assigned notes if no HandPosition exists
  let anchorFinger: Finger = 3;
  let anchorUnit = hand === "RH" ? 25.5 : 18.5;
  const assignedPairs: Array<{ finger: Finger; xUnit: number }> = [];

  for (const n of slice.notes) {
    const f = fingerByNoteUid[n.noteUid];
    if (f) {
      assignedPairs.push({ finger: f, xUnit: midiToWhiteUnitX(n.midi) });
    }
  }
  if (assignedPairs.length > 0) {
    anchorFinger = assignedPairs[0].finger;
    anchorUnit = assignedPairs[0].xUnit;
  } else if (slice.notes.length > 0) {
    anchorUnit = midiToWhiteUnitX(slice.notes[0].midi);
  }

  const slots: Partial<Record<Finger, number>> = {};
  if (assignedPairs.length === 1) {
    // Single active note: relax idle fingers naturally around the struck key instead of
    // splaying across a wide phrase-level HandPosition span.
    for (const f of FINGERS) {
      const rel = (RELAXED_OFFSET_FROM_3[f] - RELAXED_OFFSET_FROM_3[anchorFinger]) * handScale;
      slots[f] = clamp(anchorUnit + rel * dir, 0.4, PIANO_WHITE_KEY_COUNT - 0.4);
    }
  } else if (thumbUnit !== null && pinkyUnit !== null && Math.abs(pinkyUnit - thumbUnit) >= 1) {
    const rawSpan = pinkyUnit - thumbUnit;
    const clampedSpan = Math.sign(rawSpan) * Math.min(Math.abs(rawSpan), 5.0 * handScale);
    const midUnit = (thumbUnit + pinkyUnit) / 2;
    const effThumb = midUnit - clampedSpan / 2;
    const step = clampedSpan / 4;
    for (const f of FINGERS) {
      slots[f] = effThumb + (f - 1) * step;
    }
  } else {
    for (const f of FINGERS) {
      const rel = (RELAXED_OFFSET_FROM_3[f] - RELAXED_OFFSET_FROM_3[anchorFinger]) * handScale;
      slots[f] = clamp(anchorUnit + rel * dir, 0.4, PIANO_WHITE_KEY_COUNT - 0.4);
    }
  }

  // Pin active slice note fingers cleanly onto their target keys
  const pinnedByFinger = new Map<Finger, number>();
  for (const pair of assignedPairs) {
    slots[pair.finger] = pair.xUnit;
    pinnedByFinger.set(pair.finger, pair.xUnit);
  }

  // Keep non-pinned fingers anatomically ordered between pinned neighbors
  const pinnedSet = new Set(pinnedByFinger.keys());
  enforceAnatomicalFingerOrder(slots as Record<Finger, number>, pinnedSet, dir, false, handScale);

  return slots as Record<Finger, number>;
}

function computePressDepth(scoreSec: number, onsetSec: number, endSec: number): number {
  if (scoreSec < onsetSec - 1e-4 || scoreSec > endSec + 1e-4) return 0;
  const elapsed = scoreSec - onsetSec;
  const remaining = endSec - scoreSec;
  const attack = clamp(elapsed / ATTACK_SEC, 0.18, 1);
  const dur = endSec - onsetSec;
  if (dur > ATTACK_SEC + RELEASE_SEC && remaining < RELEASE_SEC) {
    return Math.min(attack, clamp(remaining / RELEASE_SEC, 0, 1));
  }
  return attack;
}

function projectSingleHandPosture(
  handIndex: HandIndexData,
  postureIndex: HandPostureIndex,
  scoreSec: number,
  globalLatestOnsetSec: number
): HandPosture {
  const { hand, slices, sliceStartSec, windows } = handIndex;
  const { scoreDoc, solveResult, spanPreset, sliceIndexById, repairedSet } = postureIndex;
  const handScale = SPAN_PRESET_SCALE[spanPreset];
  const dir = hand === "RH" ? 1 : -1;

  if (slices.length === 0) {
    const restSlots = defaultRestSlots(hand, handScale);
    const fingers = {} as Record<Finger, FingerPosture>;
    for (const f of FINGERS) {
      fingers[f] = {
        finger: f,
        xUnit: restSlots[f],
        isBlack: false,
        pressDepth: 0,
        isHeld: false,
        isStruck: false,
        targetMidi: null,
        layerOffset: 0,
      };
    }
    return {
      hand,
      spanPreset,
      isResting: true,
      activeSliceId: null,
      palmCenterXUnit: restSlots[3],
      palmLiftY: 0,
      palmAngleDeg: 0,
      crossingStyle: "none",
      fingers,
      handPosition: null,
      transitionCues: [],
    };
  }

  const currIdx = findLatestSliceIndexAt(sliceStartSec, scoreSec);
  const currSlice = currIdx >= 0 ? slices[currIdx] : null;
  const nextSlice = currIdx + 1 < slices.length ? slices[currIdx + 1] : null;

  // Gather active sounding notes at scoreSec for this hand
  const activeByFinger = new Map<
    Finger,
    {
      w: SoundingWindow;
      pressDepth: number;
      isHeld: boolean;
      isStruck: boolean;
    }
  >();

  const pedalSustainedMap = new Map<
    number,
    { midi: number; finger?: Finger; isRepairedAnchor?: boolean }
  >();

  let latestWindowEnd = -Infinity;
  for (const w of windows) {
    if (w.endSec > latestWindowEnd && w.onsetSec <= scoreSec + 1e-4) {
      latestWindowEnd = w.endSec;
    }
    if (w.onsetSec <= scoreSec + 1e-4 && w.endSec >= scoreSec - 1e-4) {
      const f = solveResult.fingerByNoteUid[w.ev.noteUid];
      if (!f) continue;
      if (w.fingerEndSec >= scoreSec - 1e-4) {
        const isPriorBeat = w.onsetSec < globalLatestOnsetSec - 1e-4;
        const pastStrikeWindow = scoreSec - w.onsetSec > 0.16;
        const isHeld = isPriorBeat || pastStrikeWindow;
        const isStruck = !isHeld && currSlice !== null && w.sliceId === currSlice.sliceId;
        const depth = computePressDepth(scoreSec, w.onsetSec, w.fingerEndSec);
        const prev = activeByFinger.get(f);
        if (!prev || w.onsetSec > prev.w.onsetSec) {
          activeByFinger.set(f, { w, pressDepth: depth, isHeld, isStruck });
        }
      } else if (!pedalSustainedMap.has(w.ev.midi)) {
        pedalSustainedMap.set(w.ev.midi, {
          midi: w.ev.midi,
          finger: f,
          isRepairedAnchor: repairedSet.has(w.ev.noteUid),
        });
      }
    }
  }

  // Runtime physical span & anatomical inversion invariant guard over activeByFinger
  if (activeByFinger.size >= 2) {
    type ActiveEntry = NonNullable<ReturnType<typeof activeByFinger.get>>;
    const entries = Array.from(activeByFinger.entries());
    const hasStruck = entries.some(([, entry]) => entry.isStruck);
    let maxActiveOnset = -Infinity;
    if (!hasStruck) {
      for (const [, entry] of entries) {
        if (entry.w.onsetSec > maxActiveOnset) maxActiveOnset = entry.w.onsetSec;
      }
    }
    const rawKept: Array<[Finger, ActiveEntry]> = [];
    const heldCandidates: Array<[Finger, ActiveEntry]> = [];
    for (const pair of entries) {
      const isPrimary = hasStruck
        ? pair[1].isStruck
        : Math.abs(pair[1].w.onsetSec - maxActiveOnset) <= 1e-4;
      if (isPrimary) {
        rawKept.push(pair);
      } else {
        heldCandidates.push(pair);
      }
    }

    // Ensure cross-slice same-onset primary entries cannot bypass held-conflict checks
    rawKept.sort(
      (a, b) =>
        Number(b[1].isStruck) - Number(a[1].isStruck) ||
        b[1].w.onsetSec - a[1].w.onsetSec ||
        Number(a[1].w.ev.isGrace) - Number(b[1].w.ev.isGrace)
    );
    const kept: Array<[Finger, ActiveEntry]> = [];
    for (const pair of rawKept) {
      const [fCand, candEntry] = pair;
      const crossSliceConflict = kept.some(
        ([fKept, keptEntry]) =>
          keptEntry.w.sliceId !== candEntry.w.sliceId &&
          hasHeldFingerConflict(
            fKept,
            keptEntry.w.ev.midi,
            fCand,
            candEntry.w.ev.midi,
            hand,
            handScale
          )
      );
      if (crossSliceConflict) {
        heldCandidates.push(pair);
      } else {
        kept.push(pair);
      }
    }

    heldCandidates.sort((a, b) => b[1].w.onsetSec - a[1].w.onsetSec);

    for (const [fCand, candEntry] of heldCandidates) {
      const candMidi = candEntry.w.ev.midi;
      let conflict = false;

      for (const [fKept, keptEntry] of kept) {
        if (hasHeldFingerConflict(fKept, keptEntry.w.ev.midi, fCand, candMidi, hand, handScale)) {
          conflict = true;
          break;
        }
      }

      if (conflict) {
        activeByFinger.delete(fCand);
        if (!pedalSustainedMap.has(candMidi)) {
          pedalSustainedMap.set(candMidi, {
            midi: candMidi,
            finger: fCand,
            isRepairedAnchor: repairedSet.has(candEntry.w.ev.noteUid),
          });
        }
      } else {
        kept.push([fCand, candEntry]);
      }
    }
  }

  const currHandPos = currSlice
    ? findHandPositionForSlice(hand, currSlice.sliceId, solveResult.handPositions, sliceIndexById)
    : null;
  const nextHandPos = nextSlice
    ? findHandPositionForSlice(hand, nextSlice.sliceId, solveResult.handPositions, sliceIndexById)
    : null;

  const baseSlice = currSlice ?? slices[0];
  const baseHandPos = currSlice
    ? currHandPos
    : findHandPositionForSlice(hand, slices[0].sliceId, solveResult.handPositions, sliceIndexById);

  const currSlots = computeBaseSlotsForSlice(
    hand,
    baseSlice,
    baseHandPos,
    solveResult.fingerByNoteUid,
    handScale
  );
  const nextSlots = nextSlice
    ? computeBaseSlotsForSlice(hand, nextSlice, nextHandPos, solveResult.fingerByNoteUid, handScale)
    : currSlots;

  // Compute anticipatory shift blend before next slice (last ~150ms)
  let shiftBlend = 0;
  if (nextSlice) {
    const dtToNext = nextSlice.onsetSec - scoreSec;
    const prevOnset = currSlice ? currSlice.onsetSec : 0;
    const spanSec = Math.max(0.05, nextSlice.onsetSec - prevOnset);
    const shiftWindow = clamp(spanSec * 0.45, MIN_SHIFT_WINDOW_SEC, MAX_SHIFT_WINDOW_SEC);
    if (dtToNext >= 0 && dtToNext <= shiftWindow) {
      shiftBlend = smoothstep(1 - dtToNext / shiftWindow);
    }
  }

  const cuesCurr = buildTransitionCueArcs(
    hand,
    currSlice,
    scoreDoc.onsetSlices,
    solveResult.transitionCues,
    sliceIndexById
  );
  const cuesNext =
    shiftBlend > 0.25 && nextSlice
      ? buildTransitionCueArcs(
          hand,
          nextSlice,
          scoreDoc.onsetSlices,
          solveResult.transitionCues,
          sliceIndexById
        )
      : [];

  const relevantCues = cuesNext.length > 0 ? cuesNext : cuesCurr;
  let crossingStyle: HandPosture["crossingStyle"] = "none";
  if (relevantCues.some((c) => c.cue.type === "thumb-under")) {
    crossingStyle = "thumb-under";
  } else if (relevantCues.some((c) => c.cue.type === "cross-over")) {
    crossingStyle = "cross-over";
  }

  const fingers = {} as Record<Finger, FingerPosture>;

  for (const f of FINGERS) {
    const sounding = activeByFinger.get(f);
    let xUnit: number;
    let isBlack = false;
    let pressDepth = 0;
    let isHeld = false;
    let isStruck = false;
    let targetMidi: number | null = null;
    let noteUid: string | undefined;
    let isAnchor = false;
    let isRepairedAnchor = false;

    if (sounding) {
      targetMidi = sounding.w.ev.midi;
      noteUid = sounding.w.ev.noteUid;
      isAnchor = sounding.w.ev.anchorFinger !== undefined;
      isRepairedAnchor = repairedSet.has(noteUid);
      isBlack = isBlackKey(targetMidi);
      pressDepth = sounding.pressDepth;
      isHeld = sounding.isHeld;
      isStruck = sounding.isStruck;
      xUnit = midiToWhiteUnitX(targetMidi);
    } else {
      xUnit = lerp(currSlots[f], nextSlots[f], shiftBlend);
    }

    let layerOffset: -1 | 0 | 1 = 0;
    if (crossingStyle === "thumb-under" && f === 1) {
      layerOffset = -1;
    } else if (crossingStyle === "cross-over" && (f === 2 || f === 3 || f === 4)) {
      layerOffset = 1;
    }

    fingers[f] = {
      finger: f,
      xUnit: clamp(xUnit, 0.35, PIANO_WHITE_KEY_COUNT - 0.35),
      isBlack,
      pressDepth,
      isHeld,
      isStruck,
      targetMidi,
      noteUid,
      isAnchor,
      isRepairedAnchor,
      layerOffset,
    };
  }

  // Enforce anatomical ordering across all fingers (accounting for both struck & held active fingers)
  if (activeByFinger.size > 0) {
    const orderedSlots: Record<Finger, number> = {
      1: fingers[1].xUnit,
      2: fingers[2].xUnit,
      3: fingers[3].xUnit,
      4: fingers[4].xUnit,
      5: fingers[5].xUnit,
    };
    enforceAnatomicalFingerOrder(
      orderedSlots,
      new Set(activeByFinger.keys()),
      dir,
      crossingStyle !== "none",
      handScale
    );
    for (const f of FINGERS) {
      if (!activeByFinger.has(f)) {
        fingers[f].xUnit = clamp(orderedSlots[f], 0.35, PIANO_WHITE_KEY_COUNT - 0.35);
      }
    }
  }

  let totalWeight = 0;
  let weightedCenterU = 0;
  for (const f of FINGERS) {
    const isActive = activeByFinger.has(f);
    const w = isActive ? 3.0 : 0.55;
    const idealCenterU = fingers[f].xUnit * dir - RELAXED_OFFSET_FROM_3[f] * handScale;
    totalWeight += w;
    weightedCenterU += idealCenterU * w;
  }

  let palmU = totalWeight > 0 ? weightedCenterU / totalWeight : fingers[3].xUnit * dir;
  if (activeByFinger.size > 0) {
    let lo = -Infinity;
    let hi = Infinity;
    for (const f of activeByFinger.keys()) {
      const keyU = fingers[f].xUnit * dir;
      let minRel: number;
      let maxRel: number;
      switch (f) {
        case 1:
          minRel = -4.35;
          maxRel = crossingStyle === "thumb-under" ? 1.8 : 0.35;
          break;
        case 2:
          minRel = crossingStyle === "cross-over" ? -3.4 : -2.3;
          maxRel = 1.5;
          break;
        case 3:
          minRel = crossingStyle === "cross-over" ? -3.4 : -1.8;
          maxRel = 1.8;
          break;
        case 4:
          minRel = crossingStyle === "cross-over" ? -3.4 : -1.5;
          maxRel = 2.3;
          break;
        case 5:
          minRel = -0.35;
          maxRel = 4.35;
          break;
      }
      lo = Math.max(lo, keyU - maxRel * handScale);
      hi = Math.min(hi, keyU - minRel * handScale);
    }
    if (lo <= hi) {
      palmU = clamp(palmU, lo, hi);
    } else {
      palmU = (lo + hi) / 2;
    }
  }
  const palmCenterXUnit = clamp(palmU * dir, 0.8, PIANO_WHITE_KEY_COUNT - 0.8);

  const isBeforeStart = currIdx === -1 && shiftBlend === 0;
  const isLongRest =
    activeByFinger.size === 0 &&
    (currSlice === null || scoreSec - latestWindowEnd > REST_GAP_SEC) &&
    shiftBlend === 0;
  const isResting = isBeforeStart || isLongRest;

  // Slide palm forward when active or upcoming notes sit on black keys so short fingers stay ergonomic
  let currBlackShift = 0;
  for (const [f, sounding] of activeByFinger.entries()) {
    if (isBlackKey(sounding.w.ev.midi)) {
      const shift = BLACK_KEY_PALM_SHIFT[f] * clamp(sounding.pressDepth, 0.4, 1);
      currBlackShift = Math.min(currBlackShift, shift);
    }
  }

  let nextBlackShift = 0;
  if (nextSlice && shiftBlend > 0) {
    for (const n of nextSlice.notes) {
      const f = solveResult.fingerByNoteUid[n.noteUid];
      if (f && isBlackKey(n.midi)) {
        nextBlackShift = Math.min(nextBlackShift, BLACK_KEY_PALM_SHIFT[f]);
      }
    }
  }
  const blackKeyForwardShift = lerp(currBlackShift, nextBlackShift, shiftBlend);

  let palmAngleDeg = 0;
  let palmLiftY = blackKeyForwardShift;
  if (crossingStyle === "thumb-under") {
    palmAngleDeg = dir * 10;
    palmLiftY += -4;
  } else if (crossingStyle === "cross-over") {
    palmAngleDeg = dir * -11;
    palmLiftY += -6;
  } else {
    if (activeByFinger.size >= 2) {
      let leftFp: FingerPosture | null = null;
      let rightFp: FingerPosture | null = null;
      for (const f of activeByFinger.keys()) {
        const fp = fingers[f];
        if (!leftFp || fp.xUnit < leftFp.xUnit) leftFp = fp;
        if (!rightFp || fp.xUnit > rightFp.xUnit) rightFp = fp;
      }
      if (leftFp && rightFp) {
        const dx = (rightFp.xUnit - leftFp.xUnit) * PIANO_WHITE_KEY_W;
        const leftTipY = leftFp.isBlack ? BLACK_TIP_Y[leftFp.finger] : WHITE_TIP_Y[leftFp.finger];
        const rightTipY = rightFp.isBlack ? BLACK_TIP_Y[rightFp.finger] : WHITE_TIP_Y[rightFp.finger];
        const dy = rightTipY - leftTipY;
        if (dx > 36 && Math.abs(dy) > 6) {
          palmAngleDeg = clamp((Math.atan2(dy, dx) * (180 / Math.PI)) * 0.75, -11, 11);
        }
      }
    }
    if (shiftBlend > 0.05 && shiftBlend < 0.95) {
      palmLiftY += -Math.sin(shiftBlend * Math.PI) * 5;
    }
  }

  // Advance palm forward when wide spans or short fingers need closer origin-to-key reach
  const fingerSpanPx = Math.abs(fingers[5].xUnit - fingers[1].xUnit) * PIANO_WHITE_KEY_W;
  const abductRatio = getAbductRatio(fingerSpanPx, handScale);
  const baseKnuckleY = getKnuckleBaseY(handScale, 0);
  const angleRad = (palmAngleDeg * Math.PI) / 180;
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);

  for (const [f, sounding] of activeByFinger.entries()) {
    const fp = fingers[f];
    const reach = getFingerReachPx(f, spanPreset);
    const keyX = fp.xUnit * PIANO_WHITE_KEY_W;
    const originLocal = getFingerOriginLocalPx(f, abductRatio, handScale, dir);
    const originX =
      palmCenterXUnit * PIANO_WHITE_KEY_W + originLocal.x * cosA - originLocal.y * sinA;
    const originYAtZeroLift = baseKnuckleY + originLocal.x * sinA + originLocal.y * cosA;
    const dx = keyX - originX;
    const targetY = fp.isBlack
      ? BLACK_TIP_Y[f] + sounding.pressDepth * 2
      : WHITE_TIP_Y[f] + sounding.pressDepth * 2.5;
    if (Math.abs(dx) < reach * 0.96) {
      const maxDy = Math.sqrt(reach * reach - dx * dx);
      const neededOriginY = targetY + maxDy;
      palmLiftY = Math.min(palmLiftY, neededOriginY - originYAtZeroLift);
    } else {
      const neededOriginY = targetY + reach * 0.25;
      palmLiftY = Math.min(palmLiftY, neededOriginY - originYAtZeroLift);
    }
  }

  palmLiftY = clamp(palmLiftY, -56, 0);

  const pedalSustainedKeys = Array.from(pedalSustainedMap.values());

  return {
    hand,
    spanPreset,
    isResting,
    activeSliceId: currSlice?.sliceId ?? null,
    palmCenterXUnit,
    palmLiftY,
    palmAngleDeg,
    crossingStyle,
    fingers,
    handPosition: currHandPos ?? baseHandPos,
    transitionCues: cuesCurr,
    pedalSustainedKeys,
  };
}

/**
 * Evaluates a smooth continuous `DualHandPostureFrame` at any score timestamp `scoreSec`.
 */
export function computeDualHandPostureFrameAtTime(
  postureIndex: HandPostureIndex | null,
  scoreSec: number,
  fallbackPreset: SpanPreset = "M"
): DualHandPostureFrame {
  if (!postureIndex) {
    const empty = buildEmptyHandPosture("RH", fallbackPreset);
    const emptyLh = buildEmptyHandPosture("LH", fallbackPreset);
    return {
      scoreSec: 0,
      activeKeyHighlights: new Map(),
      rh: empty,
      lh: emptyLh,
    };
  }

  let globalLatestOnsetSec = -Infinity;
  for (const s of postureIndex.scoreDoc.onsetSlices) {
    if (s.onsetSec <= scoreSec + 1e-4) {
      if (s.onsetSec > globalLatestOnsetSec) globalLatestOnsetSec = s.onsetSec;
    } else {
      break;
    }
  }

  const rh = projectSingleHandPosture(postureIndex.rh, postureIndex, scoreSec, globalLatestOnsetSec);
  const lh = projectSingleHandPosture(postureIndex.lh, postureIndex, scoreSec, globalLatestOnsetSec);

  const activeKeyHighlights = new Map<number, KeyHighlightState>();
  const applyHandKeys = (posture: HandPosture) => {
    for (const f of FINGERS) {
      const fp = posture.fingers[f];
      if (fp.targetMidi === null || fp.pressDepth <= 0.02) continue;
      const existing = activeKeyHighlights.get(fp.targetMidi) ?? {};
      const state: "active" | "held" = fp.isHeld ? "held" : "active";
      if (posture.hand === "RH") {
        existing.rh = state;
        existing.rhFinger = fp.finger;
      } else {
        existing.lh = state;
        existing.lhFinger = fp.finger;
      }
      if (fp.isRepairedAnchor) {
        existing.isRepairedAnchor = true;
      }
      activeKeyHighlights.set(fp.targetMidi, existing);
    }

    if (posture.pedalSustainedKeys) {
      for (const ps of posture.pedalSustainedKeys) {
        const existing = activeKeyHighlights.get(ps.midi) ?? {};
        if (posture.hand === "RH") {
          if (existing.rh) continue;
          existing.rh = "held";
          existing.rhFinger = ps.finger;
          existing.rhPedalSustained = true;
        } else {
          if (existing.lh) continue;
          existing.lh = "held";
          existing.lhFinger = ps.finger;
          existing.lhPedalSustained = true;
        }
        if (ps.isRepairedAnchor) {
          existing.isRepairedAnchor = true;
        }
        activeKeyHighlights.set(ps.midi, existing);
      }
    }
  };

  applyHandKeys(rh);
  applyHandKeys(lh);

  return {
    scoreSec,
    activeKeyHighlights,
    rh,
    lh,
  };
}

/**
 * Projects a `DualHandPostureFrame` anchored at a discrete selected `OnsetSlice`.
 */
export function projectDualHandPostureAtSlice(
  scoreDoc: ScoreDocument | null,
  solveResult: SolveResult | null,
  selectedSliceId: string | null,
  profile: HandSpanProfile = DEFAULT_HAND_SPAN_PROFILE
): DualHandPostureFrame {
  if (!scoreDoc || !solveResult || scoreDoc.onsetSlices.length === 0) {
    return computeDualHandPostureFrameAtTime(null, 0, profile.preset);
  }
  const idx = buildHandPostureIndex(scoreDoc, solveResult, profile);
  const slice =
    (selectedSliceId
      ? scoreDoc.onsetSlices.find((s) => s.sliceId === selectedSliceId)
      : undefined) ?? scoreDoc.onsetSlices[0];
  return computeDualHandPostureFrameAtTime(idx, slice.onsetSec + ATTACK_SEC + 0.005);
}

function buildEmptyHandPosture(hand: Hand, spanPreset: SpanPreset = "M"): HandPosture {
  const handScale = SPAN_PRESET_SCALE[spanPreset];
  const slots = defaultRestSlots(hand, handScale);
  const fingers = {} as Record<Finger, FingerPosture>;
  for (const f of FINGERS) {
    fingers[f] = {
      finger: f,
      xUnit: slots[f],
      isBlack: false,
      pressDepth: 0,
      isHeld: false,
      isStruck: false,
      targetMidi: null,
      layerOffset: 0,
    };
  }
  return {
    hand,
    spanPreset,
    isResting: true,
    activeSliceId: null,
    palmCenterXUnit: slots[3],
    palmLiftY: 0,
    palmAngleDeg: 0,
    crossingStyle: "none",
    fingers,
    handPosition: null,
    transitionCues: [],
  };
}
