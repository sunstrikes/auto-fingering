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
import { SPAN_PRESET_SCALE, isBlackKey, keyPos, whiteKeyIndex } from "../solver/keyboard";
import {
  buildTransitionCueArcs,
  findHandPositionForSlice,
  whiteKeyIndexToMidi,
  type TransitionCueArc,
} from "./dualTrackModel";
import {
  BASE_FINGER_LENGTH_PX,
  BLACK_TIP_Y,
  PIANO_KNUCKLE_BASE_Y,
  PIANO_WHITE_KEY_W,
  WHITE_TIP_Y,
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

/**
 * Keeps non-pinned fingers anatomically ordered between pinned/sounding neighbors
 * without disturbing fingers that are already in valid monotonic order (e.g. during anticipatory shift).
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

  // Clamp/interpolate unpinned fingers between consecutive pinned fingers only if out of order
  for (let i = 0; i < orderedPinned.length - 1; i++) {
    const fA = orderedPinned[i];
    const fB = orderedPinned[i + 1];
    if (fB - fA <= 1) continue;
    const lo = Math.min(u[fA], u[fB]);
    const hi = Math.max(u[fA], u[fB]);
    const hasOutOfOrder = (() => {
      for (let f = fA + 1; f < fB; f++) {
        if (u[f] < u[f - 1] - 1e-4 || u[f] > hi + 1e-4 || u[f] < lo - 1e-4) {
          return true;
        }
      }
      return false;
    })();
    if (hasOutOfOrder) {
      for (let f = fA + 1; f < fB; f++) {
        const t = (f - fA) / (fB - fA);
        u[f] = lerp(u[fA], u[fB], t);
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

  let minActiveX = Infinity;
  let maxActiveX = -Infinity;
  for (const f of FINGERS) {
    const isActive = activeByFinger.has(f);
    if (isActive) {
      if (fingers[f].xUnit < minActiveX) minActiveX = fingers[f].xUnit;
      if (fingers[f].xUnit > maxActiveX) maxActiveX = fingers[f].xUnit;
    }
    const w = isActive ? 3.5 : f === 3 ? 0.8 : 0.4;
    palmWeightSum += w;
    palmWeightedX += fingers[f].xUnit * w;
  }

  // Center palm cleanly behind active notes so fixed-length fingers reach without over-stretching
  const weightedPalmX = palmWeightSum > 0 ? palmWeightedX / palmWeightSum : fingers[3].xUnit;
  const rawPalmX =
    activeByFinger.size >= 2
      ? lerp(weightedPalmX, (minActiveX + maxActiveX) / 2, 0.55)
      : weightedPalmX;
  const thumbCenterGap = (fingers[3].xUnit - fingers[1].xUnit) * 0.12 * dir;
  const palmCenterXUnit = clamp(rawPalmX + thumbCenterGap * 0.2, 0.8, PIANO_WHITE_KEY_COUNT - 0.8);

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

  // Advance palm forward when wide spans or short fingers need closer knuckle-to-key reach
  const MCP_X_OFFSET: Record<Finger, number> = { 1: -31, 2: -18, 3: 0, 4: 17, 5: 33 };
  const MCP_Y_OFFSET: Record<Finger, number> = { 1: 14, 2: 3, 3: 0, 4: 4, 5: 12 };
  const baseKnuckleY = PIANO_KNUCKLE_BASE_Y - (1 - handScale) * 14;
  for (const [f, sounding] of activeByFinger.entries()) {
    const fp = fingers[f];
    const fixedLen = BASE_FINGER_LENGTH_PX[f] * handScale;
    const keyX = fp.xUnit * PIANO_WHITE_KEY_W;
    const mcpX = palmCenterXUnit * PIANO_WHITE_KEY_W + MCP_X_OFFSET[f] * handScale * dir;
    const dx = keyX - mcpX;
    if (Math.abs(dx) < fixedLen) {
      const targetY = fp.isBlack
        ? BLACK_TIP_Y[f] + sounding.pressDepth * 2
        : WHITE_TIP_Y[f] + sounding.pressDepth * 2.5;
      const maxDy = Math.sqrt(fixedLen * fixedLen - dx * dx);
      const neededKnuckleY = targetY + maxDy - MCP_Y_OFFSET[f] * handScale;
      palmLiftY = Math.min(palmLiftY, neededKnuckleY - baseKnuckleY);
    }
  }

  palmLiftY = clamp(palmLiftY, -48, 0);

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
  selectedSliceId: string | null,
  profile: HandSpanProfile = DEFAULT_HAND_SPAN_PROFILE
): DualHandPostureFrame {
  if (!scoreDoc || !solveResult || scoreDoc.onsetSlices.length === 0) {
    return computeDualHandPostureFrameAtTime(null, 0);
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
