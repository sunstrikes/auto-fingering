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
  PIANO_KNUCKLE_BASE_Y,
  PIANO_MM_TO_PX,
  PIANO_SVG_H,
  PIANO_WHITE_KEY_W,
  REAL_WHITE_KEY_WIDTH_MM,
  SLEEVE_HALF_WIDTH_MM,
  WHITE_TIP_Y,
  evaluateHandKinematics2D,
  getAbductRatio,
  getFingerOriginLocalPx,
  getFingerReachPx,
  getKnuckleBaseY,
  type KinematicContact,
} from "../solver/handKinematics";

export const PIANO_MIN_MIDI = 21; // A0
export const PIANO_MAX_MIDI = 108; // C8
export const PIANO_WHITE_KEY_COUNT = 52;
const A0_WHITE_INDEX = whiteKeyIndex(PIANO_MIN_MIDI); // 5
const D4_KEY_POS = keyPos(62);

function getMaxRestLiftY(handScale: number): number {
  return Math.max(
    0,
    PIANO_SVG_H - PIANO_KNUCKLE_BASE_Y - 55 * PIANO_MM_TO_PX * handScale + (1 - handScale) * 10
  );
}

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

  if (solveResult.earlyReleasesByNoteUid) {
    for (const [uid, rel] of Object.entries(solveResult.earlyReleasesByNoteUid)) {
      recordRelease(uid, rel.releaseSec);
    }
  }

  for (let t = 0; t < slices.length; t++) {
    const slice = slices[t];
    for (const rel of releasedHeldBySlice[t]) {
      recordRelease(rel.noteUid, slice.onsetSec);
    }

    // Defensive guard for manual pinOnly overrides or residual finger collisions/over-spans
    const activeNewestFirst = [...activeHeldBySlice[t]].sort(
      (a, b) => (b.onsetTick ?? 0) - (a.onsetTick ?? 0)
    );
    const acceptedContacts: KinematicContact[] = [];
    for (const n of slice.notes) {
      const fN = solveResult.fingerByNoteUid[n.noteUid];
      if (fN) {
        acceptedContacts.push({
          finger: fN,
          handFramePos: toHandFramePos(n.midi, hand),
          isBlack: isBlackKey(n.midi),
          isHeld: false,
        });
      }
    }
    const baseSliceFeasible =
      acceptedContacts.length === 0 ||
      evaluateHandKinematics2D(
        acceptedContacts,
        handScale,
        DEFAULT_COST_WEIGHTS.horizontal.crossMax
      ).feasible;
    const acceptedActive: typeof activeNewestFirst = [];
    for (const h of activeNewestFirst) {
      const solverReleaseSec = fingerReleaseSecByUid.get(h.noteUid);
      if (solverReleaseSec !== undefined && solverReleaseSec <= slice.onsetSec + 1e-6) {
        continue;
      }
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
      const hContact: KinematicContact = {
        finger: fH,
        handFramePos: toHandFramePos(h.midi, hand),
        isBlack: isBlackKey(h.midi),
        isHeld: true,
      };
      if (!released && baseSliceFeasible) {
        const evalWithHeld = evaluateHandKinematics2D(
          [...acceptedContacts, hContact],
          handScale,
          DEFAULT_COST_WEIGHTS.horizontal.crossMax
        );
        if (!evalWithHeld.feasible) {
          recordRelease(h.noteUid, slice.onsetSec);
          released = true;
        }
      }
      if (!released) {
        acceptedActive.push(h);
        acceptedContacts.push(hContact);
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

function minIdleFingerClearanceUnits(fLow: 1 | 2 | 3 | 4, handScale: number): number {
  const fHigh = (fLow + 1) as Finger;
  return (
    ((SLEEVE_HALF_WIDTH_MM[fLow][2] + SLEEVE_HALF_WIDTH_MM[fHigh][2]) /
      REAL_WHITE_KEY_WIDTH_MM) *
    handScale
  );
}

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

  // Ensure fingers before the first pinned finger stay ordered with physical width clearance
  // and never detach unreasonably far from their neighbor.
  const firstP = orderedPinned[0];
  for (let f = firstP - 1; f >= startFinger; f--) {
    const adj = f as 1 | 2 | 3 | 4;
    const minGap = minIdleFingerClearanceUnits(adj, handScale);
    const rel =
      (RELAXED_OFFSET_FROM_3[(f + 1) as Finger] - RELAXED_OFFSET_FROM_3[f as Finger]) *
      handScale;
    const maxGap = Math.max(minGap, (f === 1 ? 2.4 : MAX_IDLE_ADJ_GAP[adj]) * handScale);
    if (u[f] > u[f + 1] - minGap) {
      u[f] = u[f + 1] - Math.max(minGap, rel);
    } else if (u[f] < u[f + 1] - maxGap) {
      u[f] = u[f + 1] - Math.min(maxGap, Math.max(minGap, rel * 1.2));
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
    let minRequiredSpan = 0;
    for (let f = fA; f < fB; f++) {
      minRequiredSpan += minIdleFingerClearanceUnits(f as 1 | 2 | 3 | 4, handScale);
    }
    const checkCramp = span >= minRequiredSpan - 1e-4;

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
      const minGap = minIdleFingerClearanceUnits(f as 1 | 2 | 3 | 4, handScale);
      if (checkCramp && gap < minGap - 1e-4) {
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

  // Ensure fingers after the last pinned finger stay ordered with physical width clearance
  // and never detach unreasonably far from their neighbor.
  const lastP = orderedPinned[orderedPinned.length - 1];
  for (let f = lastP + 1; f <= 5; f++) {
    const adj = (f - 1) as 1 | 2 | 3 | 4;
    const minGap = minIdleFingerClearanceUnits(adj, handScale);
    const rel =
      (RELAXED_OFFSET_FROM_3[f as Finger] - RELAXED_OFFSET_FROM_3[adj as Finger]) *
      handScale;
    const maxGap = Math.max(minGap, (adj === 1 ? 2.4 : MAX_IDLE_ADJ_GAP[adj]) * handScale);
    if (u[f] < u[f - 1] + minGap) {
      u[f] = u[f - 1] + Math.max(minGap, rel);
    } else if (u[f] > u[f - 1] + maxGap) {
      u[f] = u[f - 1] + Math.min(maxGap, Math.max(minGap, rel * 1.2));
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

function computePalmCenterFromSlots(
  slots: Record<Finger, number>,
  dir: 1 | -1,
  handScale: number
): number {
  let weightedCenterU = 0;
  for (const f of FINGERS) {
    weightedCenterU += slots[f] * dir - RELAXED_OFFSET_FROM_3[f] * handScale;
  }
  return clamp((weightedCenterU / FINGERS.length) * dir, 0.8, PIANO_WHITE_KEY_COUNT - 0.8);
}

function areActiveFingersWithinReach(
  activeEntries: ReadonlyArray<{
    finger: Finger;
    midi: number;
    pressDepth: number;
  }>,
  palmCenterXUnit: number,
  palmAngleDeg: number,
  palmLiftY: number,
  abductRatio: number,
  handScale: number,
  dir: 1 | -1,
  spanPreset: SpanPreset,
  reachFraction: number
): boolean {
  const angleRad = (palmAngleDeg * Math.PI) / 180;
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  const clampedLift = clamp(palmLiftY, -56, getMaxRestLiftY(handScale));
  const knuckleY = getKnuckleBaseY(handScale, clampedLift);

  for (const entry of activeEntries) {
    const f = entry.finger;
    const reach = getFingerReachPx(f, spanPreset) * reachFraction;
    const keyX = midiToWhiteUnitX(entry.midi) * PIANO_WHITE_KEY_W;
    const originLocal = getFingerOriginLocalPx(f, abductRatio, handScale, dir);
    const originX = palmCenterXUnit * PIANO_WHITE_KEY_W + originLocal.x * cosA - originLocal.y * sinA;
    const originY = knuckleY + originLocal.x * sinA + originLocal.y * cosA;
    const targetY = isBlackKey(entry.midi)
      ? BLACK_TIP_Y[f] + entry.pressDepth * 2
      : WHITE_TIP_Y[f] + clampedLift * 0.45 + entry.pressDepth * 2.5;
    if (Math.hypot(keyX - originX, targetY - originY) > reach) {
      return false;
    }
  }
  return true;
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

    const keptContacts: KinematicContact[] = kept.map(([fKept, keptEntry]) => ({
      finger: fKept,
      handFramePos: toHandFramePos(keptEntry.w.ev.midi, hand),
      isBlack: isBlackKey(keptEntry.w.ev.midi),
      isHeld: keptEntry.isHeld,
    }));
    const keptFeasible =
      keptContacts.length === 0 ||
      evaluateHandKinematics2D(
        keptContacts,
        handScale,
        DEFAULT_COST_WEIGHTS.horizontal.crossMax
      ).feasible;

    for (const [fCand, candEntry] of heldCandidates) {
      const candMidi = candEntry.w.ev.midi;
      let conflict = false;

      for (const [fKept, keptEntry] of kept) {
        if (hasHeldFingerConflict(fKept, keptEntry.w.ev.midi, fCand, candMidi, hand, handScale)) {
          conflict = true;
          break;
        }
      }

      const candContact: KinematicContact = {
        finger: fCand,
        handFramePos: toHandFramePos(candMidi, hand),
        isBlack: isBlackKey(candMidi),
        isHeld: candEntry.isHeld,
      };
      if (!conflict && keptFeasible) {
        const evalWithCand = evaluateHandKinematics2D(
          [...keptContacts, candContact],
          handScale,
          DEFAULT_COST_WEIGHTS.horizontal.crossMax
        );
        if (!evalWithCand.feasible) {
          conflict = true;
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
        keptContacts.push(candContact);
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
  let shiftWindow = MIN_SHIFT_WINDOW_SEC;
  if (nextSlice) {
    const dtToNext = nextSlice.onsetSec - scoreSec;
    const prevOnset = currSlice ? currSlice.onsetSec : 0;
    const spanSec = Math.max(0.05, nextSlice.onsetSec - prevOnset);
    shiftWindow = clamp(spanSec * 0.45, MIN_SHIFT_WINDOW_SEC, MAX_SHIFT_WINDOW_SEC);
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

  const toPalmXUnit = (palmXMm: number): number => {
    const palmHandFramePos = palmXMm / REAL_WHITE_KEY_WIDTH_MM;
    const palmKeyPos = hand === "RH" ? palmHandFramePos : 2 * D4_KEY_POS - palmHandFramePos;
    return clamp(palmKeyPos - A0_WHITE_INDEX, 0.8, PIANO_WHITE_KEY_COUNT - 0.8);
  };

  const restLiftY = Math.min(10 * handScale, getMaxRestLiftY(handScale));

  const nextContacts: KinematicContact[] = [];
  if (nextSlice) {
    for (const n of nextSlice.notes) {
      const f = solveResult.fingerByNoteUid[n.noteUid];
      if (f) {
        nextContacts.push({
          finger: f,
          handFramePos: toHandFramePos(n.midi, hand),
          isBlack: isBlackKey(n.midi),
          isHeld: false,
        });
      }
    }
  }
  const nextEval =
    nextContacts.length > 0
      ? evaluateHandKinematics2D(nextContacts, handScale, DEFAULT_COST_WEIGHTS.horizontal.crossMax)
      : null;
  const nextPalmXUnit = nextEval
    ? toPalmXUnit(nextEval.pose.palmXMm)
    : computePalmCenterFromSlots(nextSlots, dir, handScale);
  const nextPalmAngleDeg = nextEval ? dir * nextEval.pose.palmAngleDeg : 0;
  const nextPalmLiftY = nextEval
    ? nextEval.pose.palmYMm * PIANO_MM_TO_PX + (1 - handScale) * 10
    : restLiftY;

  const evalActiveKinematics = () => {
    const contacts: KinematicContact[] = [];
    for (const [f, sounding] of activeByFinger.entries()) {
      contacts.push({
        finger: f,
        handFramePos: toHandFramePos(sounding.w.ev.midi, hand),
        isBlack: isBlackKey(sounding.w.ev.midi),
        isHeld: sounding.isHeld,
      });
    }
    return evaluateHandKinematics2D(
      contacts,
      handScale,
      DEFAULT_COST_WEIGHTS.horizontal.crossMax
    );
  };

  let kinEval = activeByFinger.size > 0 ? evalActiveKinematics() : null;
  let currPalmXUnit = kinEval
    ? toPalmXUnit(kinEval.pose.palmXMm)
    : computePalmCenterFromSlots(currSlots, dir, handScale);
  let currPalmAngleDeg = kinEval ? dir * kinEval.pose.palmAngleDeg : 0;
  let currPalmLiftY = kinEval
    ? kinEval.pose.palmYMm * PIANO_MM_TO_PX + (1 - handScale) * 10
    : restLiftY;

  const deltaPalmUnits = nextSlice ? Math.abs(nextPalmXUnit - currPalmXUnit) : 0;
  let isSameFingerJump = false;
  if (nextSlice && activeByFinger.size > 0) {
    for (const n of nextSlice.notes) {
      const f = solveResult.fingerByNoteUid[n.noteUid];
      const active = f ? activeByFinger.get(f) : undefined;
      if (
        active &&
        Math.abs(midiToWhiteUnitX(n.midi) - midiToWhiteUnitX(active.w.ev.midi)) > 1.2 * handScale
      ) {
        isSameFingerJump = true;
        break;
      }
    }
  }
  const hasNextCrossing = cuesNext.some(
    (c) => c.cue.type === "thumb-under" || c.cue.type === "cross-over"
  );
  const isWholeHandShift =
    nextSlice !== null &&
    ((hasNextCrossing ? deltaPalmUnits > 3.2 * handScale : deltaPalmUnits > 1.5 * handScale) ||
      isSameFingerJump);

  // Release non-continuing keys once a whole-hand shift begins so the hand translates cleanly
  // in normal anatomical shape instead of pinning one finger while flying others across keys.
  if (isWholeHandShift && shiftBlend > 0 && activeByFinger.size > 0) {
    let releasedAny = false;
    for (const [f, sounding] of Array.from(activeByFinger.entries())) {
      const isContinuingPastNext = sounding.w.endSec > nextSlice!.onsetSec + 1e-4;
      if (isContinuingPastNext) continue;
      if (shiftBlend > 0.08) {
        activeByFinger.delete(f);
        releasedAny = true;
      } else {
        sounding.pressDepth *= clamp(1 - shiftBlend / 0.08, 0, 1);
      }
    }
    if (releasedAny) {
      kinEval = activeByFinger.size > 0 ? evalActiveKinematics() : null;
      if (kinEval) {
        currPalmXUnit = toPalmXUnit(kinEval.pose.palmXMm);
        currPalmAngleDeg = dir * kinEval.pose.palmAngleDeg;
        currPalmLiftY = kinEval.pose.palmYMm * PIANO_MM_TO_PX + (1 - handScale) * 10;
      }
    }
  }

  // During a whole-hand jump without a crossing target, keep fingers uncrossed mid-flight
  if (isWholeHandShift && shiftBlend > 0.08 && !hasNextCrossing) {
    crossingStyle = "none";
  }

  const isBeforeStart = currIdx === -1 && shiftBlend === 0;
  const isLongRest =
    activeByFinger.size === 0 &&
    (currSlice === null || scoreSec - latestWindowEnd > REST_GAP_SEC) &&
    shiftBlend === 0;
  const isResting = isBeforeStart || isLongRest;

  let palmCenterXUnit: number;
  let palmAngleDeg = 0;
  let palmLiftY = 0;
  const fingers = {} as Record<Finger, FingerPosture>;

  if (activeByFinger.size > 0 && kinEval) {
    palmCenterXUnit = currPalmXUnit;
    palmAngleDeg = currPalmAngleDeg;
    palmLiftY = currPalmLiftY;

    let palmShiftFraction = 0;
    if (nextSlice && shiftBlend > 0 && nextEval && (!isWholeHandShift || shiftBlend > 0.08)) {
      const maxBlend = shiftBlend * 0.45;
      const activeEntries = Array.from(activeByFinger.entries()).map(([f, s]) => ({
        finger: f,
        midi: s.w.ev.midi,
        pressDepth: s.pressDepth,
      }));
      const activeSpanPx =
        Math.abs(currSlots[5] - currSlots[1]) * PIANO_WHITE_KEY_W;
      const activeAbduct = getAbductRatio(activeSpanPx, handScale);

      // Binary-search largest anticipatory palm blend that keeps held/struck fingers comfortably reachable
      let lo = 0;
      let hi = maxBlend;
      let bestBlend = 0;
      if (
        kinEval.feasible &&
        areActiveFingersWithinReach(
          activeEntries,
          palmCenterXUnit,
          palmAngleDeg,
          palmLiftY,
          activeAbduct,
          handScale,
          dir,
          spanPreset,
          0.92
        )
      ) {
        for (let iter = 0; iter < 6; iter++) {
          const mid = (lo + hi) * 0.5;
          const testX = lerp(currPalmXUnit, nextPalmXUnit, mid);
          const testAng = lerp(currPalmAngleDeg, nextPalmAngleDeg, mid);
          const testLift = lerp(currPalmLiftY, nextPalmLiftY, mid);
          if (
            areActiveFingersWithinReach(
              activeEntries,
              testX,
              testAng,
              testLift,
              activeAbduct,
              handScale,
              dir,
              spanPreset,
              0.92
            )
          ) {
            bestBlend = mid;
            lo = mid;
          } else {
            hi = mid;
          }
        }
      }

      palmCenterXUnit = lerp(currPalmXUnit, nextPalmXUnit, bestBlend);
      palmAngleDeg = lerp(currPalmAngleDeg, nextPalmAngleDeg, bestBlend);
      palmLiftY = lerp(currPalmLiftY, nextPalmLiftY, bestBlend);
      if (crossingStyle === "none" && bestBlend > 0.03) {
        palmLiftY += -Math.sin(shiftBlend * Math.PI) * 3.5;
      }
      const palmGap = nextPalmXUnit - currPalmXUnit;
      palmShiftFraction =
        Math.abs(palmGap) > 1e-4 ? clamp((palmCenterXUnit - currPalmXUnit) / palmGap, 0, 1) : 0;
    }

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
        // Keep idle fingers anchored in the palm frame so they never detach across the keyboard
        const currOff = currSlots[f] - currPalmXUnit;
        const nextOff = nextSlots[f] - nextPalmXUnit;
        xUnit = palmCenterXUnit + lerp(currOff, nextOff, palmShiftFraction);
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

    // Enforce anatomical ordering & max gap across all fingers around pinned active fingers
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

    // Ensure active fingertips remain within strict 1.0x reach (accounting for 2% kinematic tolerance)
    const fingerSpanPx = Math.abs(fingers[5].xUnit - fingers[1].xUnit) * PIANO_WHITE_KEY_W;
    const abductRatio = getAbductRatio(fingerSpanPx, handScale);
    const baseKnuckleY = getKnuckleBaseY(handScale, 0);
    const angleRad = (palmAngleDeg * Math.PI) / 180;
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);
    for (const [f, sounding] of activeByFinger.entries()) {
      const fp = fingers[f];
      const reach = getFingerReachPx(f, spanPreset) * 0.98;
      const keyX = fp.xUnit * PIANO_WHITE_KEY_W;
      const originLocal = getFingerOriginLocalPx(f, abductRatio, handScale, dir);
      const originX =
        palmCenterXUnit * PIANO_WHITE_KEY_W + originLocal.x * cosA - originLocal.y * sinA;
      const originYAtZeroLift = baseKnuckleY + originLocal.x * sinA + originLocal.y * cosA;
      const dx = keyX - originX;
      const targetY = fp.isBlack
        ? BLACK_TIP_Y[f] + sounding.pressDepth * 2
        : WHITE_TIP_Y[f] + sounding.pressDepth * 2.5;
      if (Math.abs(dx) < reach) {
        const maxDy = Math.sqrt(reach * reach - dx * dx);
        palmLiftY = Math.min(palmLiftY, targetY + maxDy - originYAtZeroLift);
      } else {
        palmLiftY = Math.min(palmLiftY, targetY + reach * 0.25 - originYAtZeroLift);
      }
    }
    if (!kinEval.feasible) {
      for (const [f, sounding] of activeByFinger.entries()) {
        const fp = fingers[f];
        const reach = getFingerReachPx(f, spanPreset) * 0.98;
        const keyX = fp.xUnit * PIANO_WHITE_KEY_W;
        const originLocal = getFingerOriginLocalPx(f, abductRatio, handScale, dir);
        const originX =
          palmCenterXUnit * PIANO_WHITE_KEY_W + originLocal.x * cosA - originLocal.y * sinA;
        const clampedLift = clamp(palmLiftY, -56, 26);
        const originY =
          getKnuckleBaseY(handScale, clampedLift) +
          originLocal.x * sinA +
          originLocal.y * cosA;
        const dx = keyX - originX;
        const targetY = fp.isBlack
          ? BLACK_TIP_Y[f] + sounding.pressDepth * 2
          : WHITE_TIP_Y[f] + clampedLift * 0.45 + sounding.pressDepth * 2.5;
        const dy = targetY - originY;
        const d = Math.hypot(dx, dy);
        if (d > reach && Math.abs(dx) > 1e-3) {
          const maxDx = Math.sqrt(Math.max(0, reach * reach - dy * dy));
          const excess = Math.abs(dx) - maxDx;
          if (excess > 0) {
            palmCenterXUnit += (Math.sign(dx) * excess) / PIANO_WHITE_KEY_W;
          }
        }
      }
    }
  } else {
    // Whole-hand translation / rest posture: palm and all 5 fingers move cohesively as a unit
    const hadActiveBeforeShift =
      isWholeHandShift &&
      nextSlice !== null &&
      currSlice !== null &&
      windows.some(
        (w) =>
          w.sliceId === currSlice.sliceId &&
          w.fingerEndSec > nextSlice.onsetSec - shiftWindow + 1e-4
      );
    const travelBlend = hadActiveBeforeShift
      ? smoothstep((shiftBlend - 0.08) / 0.92)
      : shiftBlend;

    palmCenterXUnit = clamp(
      lerp(currPalmXUnit, nextPalmXUnit, travelBlend),
      0.8,
      PIANO_WHITE_KEY_COUNT - 0.8
    );

    let nextBlackShift = 0;
    if (nextSlice && travelBlend > 0 && !nextEval) {
      for (const n of nextSlice.notes) {
        const f = solveResult.fingerByNoteUid[n.noteUid];
        if (f && isBlackKey(n.midi)) {
          nextBlackShift = Math.min(nextBlackShift, BLACK_KEY_PALM_SHIFT[f]);
        }
      }
    }
    const targetLift = nextEval ? nextPalmLiftY : nextBlackShift;
    const baseLift = hadActiveBeforeShift ? currPalmLiftY : restLiftY;
    palmLiftY = lerp(baseLift, targetLift, travelBlend);
    palmAngleDeg = lerp(hadActiveBeforeShift ? currPalmAngleDeg : 0, nextPalmAngleDeg, travelBlend);

    if (crossingStyle === "thumb-under") {
      palmAngleDeg = lerp(palmAngleDeg, dir * 10, 0.5);
      palmLiftY += -4;
    } else if (crossingStyle === "cross-over") {
      palmAngleDeg = lerp(palmAngleDeg, dir * -11, 0.5);
      palmLiftY += -6;
    } else if (travelBlend > 0.03 && travelBlend < 0.97) {
      const jumpArc = isWholeHandShift
        ? clamp(deltaPalmUnits * 1.1, 4, 11) * handScale
        : 5;
      palmLiftY += -Math.sin(travelBlend * Math.PI) * jumpArc;
    }

    const midRelax =
      deltaPalmUnits > 2.5 * handScale ? Math.sin(travelBlend * Math.PI) * 0.45 : 0;

    for (const f of FINGERS) {
      const currOff = currSlots[f] - currPalmXUnit;
      const nextOff = nextSlots[f] - nextPalmXUnit;
      const blendedOff = lerp(currOff, nextOff, travelBlend);
      const relaxedOff = RELAXED_OFFSET_FROM_3[f] * handScale * dir;
      const finalOff = lerp(blendedOff, relaxedOff, midRelax);

      let layerOffset: -1 | 0 | 1 = 0;
      if (crossingStyle === "thumb-under" && f === 1) {
        layerOffset = -1;
      } else if (crossingStyle === "cross-over" && (f === 2 || f === 3 || f === 4)) {
        layerOffset = 1;
      }

      fingers[f] = {
        finger: f,
        xUnit: clamp(palmCenterXUnit + finalOff, 0.35, PIANO_WHITE_KEY_COUNT - 0.35),
        isBlack: false,
        pressDepth: 0,
        isHeld: false,
        isStruck: false,
        targetMidi: null,
        layerOffset,
      };
    }
  }

  palmLiftY = clamp(palmLiftY, -56, getMaxRestLiftY(handScale));

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
    palmLiftY: Math.min(10 * handScale, getMaxRestLiftY(handScale)),
    palmAngleDeg: 0,
    crossingStyle: "none",
    fingers,
    handPosition: null,
    transitionCues: [],
  };
}

/**
 * Interpolates between two discrete `HandPosture` snapshots while keeping the hand
 * translating as a cohesive, anatomically normal shape across large keyboard jumps.
 */
export function tweenHandPosture(
  from: HandPosture,
  to: HandPosture,
  t: number
): HandPosture {
  if (t <= 0) return from;
  if (t >= 1) return to;

  const handScale = SPAN_PRESET_SCALE[to.spanPreset ?? from.spanPreset ?? "M"];
  const dir = to.hand === "RH" ? 1 : -1;
  const deltaPalm = Math.abs(to.palmCenterXUnit - from.palmCenterXUnit);
  const isLargeMove = deltaPalm > 1.8 * handScale;

  const palmCenterXUnit = clamp(
    lerp(from.palmCenterXUnit, to.palmCenterXUnit, t),
    0.8,
    PIANO_WHITE_KEY_COUNT - 0.8
  );
  const palmAngleDeg = lerp(from.palmAngleDeg, to.palmAngleDeg, t);
  const jumpArc = isLargeMove
    ? Math.sin(t * Math.PI) * clamp(deltaPalm * 0.9, 4, 12) * handScale
    : 0;
  const palmLiftY = clamp(
    lerp(from.palmLiftY, to.palmLiftY, t) - jumpArc,
    -56,
    getMaxRestLiftY(handScale)
  );
  const midRelax = isLargeMove ? Math.sin(t * Math.PI) * 0.45 : 0;
  const midFlightUncrossed = isLargeMove && t > 0.1 && t < 0.9;

  const fingers = {} as Record<Finger, FingerPosture>;
  for (const f of FINGERS) {
    const a = from.fingers[f];
    const b = to.fingers[f];
    const fromOff = a.xUnit - from.palmCenterXUnit;
    const toOff = b.xUnit - to.palmCenterXUnit;
    const relaxedOff = RELAXED_OFFSET_FROM_3[f] * handScale * dir;
    const off = lerp(lerp(fromOff, toOff, t), relaxedOff, midRelax);
    const xUnit = clamp(palmCenterXUnit + off, 0.35, PIANO_WHITE_KEY_COUNT - 0.35);

    const sameHeldKey = !isLargeMove && a.targetMidi !== null && a.targetMidi === b.targetMidi;
    const layerOffset = midFlightUncrossed ? 0 : t >= 0.5 ? b.layerOffset : a.layerOffset;

    if (!isLargeMove) {
      fingers[f] = {
        ...b,
        xUnit,
        pressDepth: sameHeldKey ? lerp(a.pressDepth, b.pressDepth, t) : b.pressDepth,
        layerOffset,
      };
    } else if (t < 0.78) {
      fingers[f] = {
        ...b,
        xUnit,
        isBlack: false,
        pressDepth: 0,
        isHeld: false,
        isStruck: false,
        targetMidi: null,
        layerOffset,
      };
    } else {
      const landBlend = smoothstep((t - 0.78) / 0.22);
      fingers[f] = {
        ...b,
        xUnit,
        pressDepth: b.pressDepth * landBlend,
        layerOffset,
      };
    }
  }

  if (midFlightUncrossed) {
    for (let f = 2; f <= 5; f++) {
      const prevF = (f - 1) as 1 | 2 | 3 | 4;
      const currF = f as Finger;
      const minGap = minIdleFingerClearanceUnits(prevF, handScale);
      const prevU = fingers[prevF].xUnit * dir;
      const currU = fingers[currF].xUnit * dir;
      if (currU < prevU + minGap) {
        fingers[currF].xUnit = clamp(
          (prevU + minGap) * dir,
          0.35,
          PIANO_WHITE_KEY_COUNT - 0.35
        );
      }
    }
  }

  return {
    ...to,
    crossingStyle: midFlightUncrossed ? "none" : to.crossingStyle,
    palmCenterXUnit,
    palmLiftY,
    palmAngleDeg,
    fingers,
  };
}
