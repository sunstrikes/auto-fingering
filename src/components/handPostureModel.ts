import { computeTieChainEndByRoot } from "../domain/tieUtils";
import type {
  Finger,
  Hand,
  HandPosition,
  NoteEvent,
  OnsetSlice,
  ScoreDocument,
  SolveResult,
} from "../domain/types";
import { isBlackKey, keyPos, whiteKeyIndex } from "../solver/keyboard";
import {
  buildTransitionCueArcs,
  findHandPositionForSlice,
  whiteKeyIndexToMidi,
  type TransitionCueArc,
} from "./dualTrackModel";

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
  isResting: boolean;
  activeSliceId: string | null;
  palmCenterXUnit: number;
  palmLiftY: number;
  palmAngleDeg: number;
  crossingStyle: "none" | "thumb-under" | "cross-over";
  fingers: Record<Finger, FingerPosture>;
  handPosition: HandPosition | null;
  transitionCues: TransitionCueArc[];
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

function buildHandIndex(
  hand: Hand,
  scoreDoc: ScoreDocument,
  chainEndSecByRoot: Map<string, number>
): HandIndexData {
  const slices = scoreDoc.onsetSlices.filter((s) => s.hand === hand);
  const sliceStartSec = slices.map((s) => s.onsetSec);
  const windows: SoundingWindow[] = [];

  for (const slice of slices) {
    for (const ev of slice.notes) {
      if (ev.isTieStop) continue;
      const rawEnd = ev.isGrace
        ? ev.onsetSec + GRACE_VISUAL_SEC
        : chainEndSecByRoot.get(ev.noteUid) ?? ev.onsetSec + Math.max(0.08, ev.durationSec);
      const endSec = Math.max(ev.onsetSec + 0.08, rawEnd);
      windows.push({
        ev,
        sliceId: slice.sliceId,
        onsetSec: ev.onsetSec,
        endSec,
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
  solveResult: SolveResult
): HandPostureIndex {
  const sliceIndexById = new Map<string, number>();
  scoreDoc.onsetSlices.forEach((s, i) => sliceIndexById.set(s.sliceId, i));
  const chainEndSecByRoot = computeTieChainEndByRoot(scoreDoc.noteEvents, "sec");

  return {
    scoreDoc,
    solveResult,
    sliceIndexById,
    repairedSet: new Set(solveResult.repairedAnchorUids),
    rh: buildHandIndex("RH", scoreDoc, chainEndSecByRoot),
    lh: buildHandIndex("LH", scoreDoc, chainEndSecByRoot),
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
  1: -28,
  2: -19,
  3: -16,
  4: -19,
  5: -25,
};

function defaultRestSlots(hand: Hand): Record<Finger, number> {
  // RH rests near C4..G4 (white units ~23.5..27.3); LH rests near C3..G3 (units ~16.7..20.5)
  const center = hand === "RH" ? 25.5 : 18.5;
  const dir = hand === "RH" ? 1 : -1;
  return {
    1: center + RELAXED_OFFSET_FROM_3[1] * dir,
    2: center + RELAXED_OFFSET_FROM_3[2] * dir,
    3: center,
    4: center + RELAXED_OFFSET_FROM_3[4] * dir,
    5: center + RELAXED_OFFSET_FROM_3[5] * dir,
  };
}

function computeBaseSlotsForSlice(
  hand: Hand,
  slice: OnsetSlice | null,
  handPosition: HandPosition | null,
  fingerByNoteUid: Record<string, Finger>
): Record<Finger, number> {
  if (!slice) return defaultRestSlots(hand);

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
  if (thumbUnit !== null && pinkyUnit !== null && Math.abs(pinkyUnit - thumbUnit) >= 1) {
    const step = (pinkyUnit - thumbUnit) / 4;
    for (const f of FINGERS) {
      slots[f] = thumbUnit + (f - 1) * step;
    }
  } else {
    for (const f of FINGERS) {
      slots[f] = anchorUnit + (f - anchorFinger) * dir;
    }
  }

  // Pin active slice note fingers cleanly onto their target keys
  const pinnedByFinger = new Map<Finger, number>();
  for (const pair of assignedPairs) {
    slots[pair.finger] = pair.xUnit;
    pinnedByFinger.set(pair.finger, pair.xUnit);
  }

  // Keep non-pinned fingers anatomically ordered unless intentional cross/pin says otherwise
  for (const f of FINGERS) {
    if (pinnedByFinger.has(f)) continue;
    if (assignedPairs.length === 1) {
      const rel = RELAXED_OFFSET_FROM_3[f] - RELAXED_OFFSET_FROM_3[anchorFinger];
      slots[f] = clamp(anchorUnit + rel * dir, 0.4, PIANO_WHITE_KEY_COUNT - 0.4);
    } else {
      slots[f] = clamp(slots[f]!, 0.4, PIANO_WHITE_KEY_COUNT - 0.4);
    }
  }

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
  const { scoreDoc, solveResult, sliceIndexById, repairedSet } = postureIndex;
  const dir = hand === "RH" ? 1 : -1;

  if (slices.length === 0) {
    const restSlots = defaultRestSlots(hand);
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

  let latestWindowEnd = -Infinity;
  for (const w of windows) {
    if (w.endSec > latestWindowEnd && w.onsetSec <= scoreSec + 1e-4) {
      latestWindowEnd = w.endSec;
    }
    if (w.onsetSec <= scoreSec + 1e-4 && w.endSec >= scoreSec - 1e-4) {
      const f = solveResult.fingerByNoteUid[w.ev.noteUid];
      if (!f) continue;
      const isPriorBeat = w.onsetSec < globalLatestOnsetSec - 1e-4;
      const pastStrikeWindow = scoreSec - w.onsetSec > 0.16;
      const isHeld = isPriorBeat || pastStrikeWindow;
      const isStruck = !isHeld && currSlice !== null && w.sliceId === currSlice.sliceId;
      const depth = computePressDepth(scoreSec, w.onsetSec, w.endSec);
      const prev = activeByFinger.get(f);
      if (!prev || w.onsetSec > prev.w.onsetSec) {
        activeByFinger.set(f, { w, pressDepth: depth, isHeld, isStruck });
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
    solveResult.fingerByNoteUid
  );
  const nextSlots = nextSlice
    ? computeBaseSlotsForSlice(hand, nextSlice, nextHandPos, solveResult.fingerByNoteUid)
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
  let palmWeightSum = 0;
  let palmWeightedX = 0;

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

    const w = sounding ? 2.2 : f === 3 ? 1.4 : 0.9;
    palmWeightSum += w;
    palmWeightedX += fingers[f].xUnit * w;
  }

  // Offset palm slightly behind fingers toward middle knuckle so palm spans naturally
  const rawPalmX = palmWeightSum > 0 ? palmWeightedX / palmWeightSum : fingers[3].xUnit;
  const thumbCenterGap = (fingers[3].xUnit - fingers[1].xUnit) * 0.12 * dir;
  const palmCenterXUnit = clamp(rawPalmX + thumbCenterGap * 0.25, 0.8, PIANO_WHITE_KEY_COUNT - 0.8);

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
  } else if (shiftBlend > 0.05 && shiftBlend < 0.95) {
    palmLiftY += -Math.sin(shiftBlend * Math.PI) * 5;
  }
  palmLiftY = clamp(palmLiftY, -32, 0);

  return {
    hand,
    isResting,
    activeSliceId: currSlice?.sliceId ?? null,
    palmCenterXUnit,
    palmLiftY,
    palmAngleDeg,
    crossingStyle,
    fingers,
    handPosition: currHandPos ?? baseHandPos,
    transitionCues: cuesCurr,
  };
}

/**
 * Evaluates a smooth continuous `DualHandPostureFrame` at any score timestamp `scoreSec`.
 */
export function computeDualHandPostureFrameAtTime(
  postureIndex: HandPostureIndex | null,
  scoreSec: number
): DualHandPostureFrame {
  if (!postureIndex) {
    const empty = buildEmptyHandPosture("RH");
    const emptyLh = buildEmptyHandPosture("LH");
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
  selectedSliceId: string | null
): DualHandPostureFrame {
  if (!scoreDoc || !solveResult || scoreDoc.onsetSlices.length === 0) {
    return computeDualHandPostureFrameAtTime(null, 0);
  }
  const idx = buildHandPostureIndex(scoreDoc, solveResult);
  const slice =
    (selectedSliceId
      ? scoreDoc.onsetSlices.find((s) => s.sliceId === selectedSliceId)
      : undefined) ?? scoreDoc.onsetSlices[0];
  return computeDualHandPostureFrameAtTime(idx, slice.onsetSec + ATTACK_SEC + 0.005);
}

function buildEmptyHandPosture(hand: Hand): HandPosture {
  const slots = defaultRestSlots(hand);
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
