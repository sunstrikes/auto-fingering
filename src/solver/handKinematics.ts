import type { Finger, SpanPreset } from "../domain/types";
import { MAX_OCTAVE_SPAN, SPAN_PRESET_SCALE } from "./keyboard";

export const PIANO_WHITE_KEY_W = 24;
export const PIANO_WHITE_KEY_H = 112;
export const PIANO_BLACK_KEY_W = 14.5;
export const PIANO_BLACK_KEY_H = 70;
export const PIANO_KEYS_Y = 50;
export const PIANO_KEYBED_BOTTOM_Y = PIANO_KEYS_Y + PIANO_WHITE_KEY_H; // 162
export const PIANO_KNUCKLE_BASE_Y = PIANO_KEYBED_BOTTOM_Y + 11; // 173
export const PIANO_WRIST_Y = PIANO_KEYBED_BOTTOM_Y + 62; // 224
export const PIANO_SVG_H = 244;

/** Real-world grand piano white-key pitch & length (mm) for 1:1 physical hand scaling. */
export const REAL_WHITE_KEY_WIDTH_MM = 23.5;
export const REAL_WHITE_KEY_LENGTH_MM = 148;
export const PIANO_MM_TO_PX = PIANO_WHITE_KEY_W / REAL_WHITE_KEY_WIDTH_MM;
export const PIANO_PX_TO_MM = REAL_WHITE_KEY_WIDTH_MM / PIANO_WHITE_KEY_W;

function mmToPx(valMm: number): number {
  return valMm * PIANO_MM_TO_PX;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/** Natural white-key contact Y by finger (3 deepest, 2/4 mid, 5 shorter, 1 frontmost). */
export const WHITE_TIP_Y: Record<Finger, number> = {
  1: 148,
  2: 126,
  3: 116,
  4: 124,
  5: 141,
};

/** Natural black-key contact Y by finger (black keys occupy y = 50..120). */
export const BLACK_TIP_Y: Record<Finger, number> = {
  1: 108,
  2: 96,
  3: 90,
  4: 95,
  5: 105,
};

/**
 * Real-world anatomical MCP-to-tip finger lengths (mm) for Medium ("M") adult hand size.
 */
export const BASE_FINGER_LENGTH_MM: Record<Finger, number> = {
  1: 59,
  2: 75,
  3: 83,
  4: 78,
  5: 64,
};

/**
 * Calibrated MCP-to-tip finger lengths in SVG px tied to `PIANO_WHITE_KEY_W / REAL_WHITE_KEY_WIDTH_MM`.
 * Scaled by `SPAN_PRESET_SCALE` for S (0.82x) / M (1.00x) / L (1.18x) hand profiles.
 */
export const BASE_FINGER_LENGTH_PX: Record<Finger, number> = {
  1: mmToPx(BASE_FINGER_LENGTH_MM[1]),
  2: mmToPx(BASE_FINGER_LENGTH_MM[2]),
  3: mmToPx(BASE_FINGER_LENGTH_MM[3]),
  4: mmToPx(BASE_FINGER_LENGTH_MM[4]),
  5: mmToPx(BASE_FINGER_LENGTH_MM[5]),
};

/** First metacarpal (CMC1 -> MCP1) length in mm for Medium ("M") hand size. */
export const METACARPAL_1_LENGTH_MM = 41;

/** Idle fingers adopt a gently curved 2D top-down projection at 72% of full extended length. */
export const IDLE_CURVE_FACTOR = 0.72;

/** 3-point tapered half-width [base, mid, tip] in mm for each finger (M size). */
export const SLEEVE_HALF_WIDTH_MM: Record<Finger, [number, number, number]> = {
  1: [7.5, 6.2, 5.2],
  2: [5.9, 4.9, 4.0],
  3: [6.1, 5.1, 4.2],
  4: [5.7, 4.7, 3.8],
  5: [4.9, 4.0, 3.3],
};

export interface Point2D {
  x: number;
  y: number;
}

export function getFixedFingerLengthPx(finger: Finger, spanPreset: SpanPreset = "M"): number {
  return BASE_FINGER_LENGTH_PX[finger] * SPAN_PRESET_SCALE[spanPreset];
}

export function getThumbMetacarpalLengthPx(spanPreset: SpanPreset = "M"): number {
  return mmToPx(METACARPAL_1_LENGTH_MM) * SPAN_PRESET_SCALE[spanPreset];
}

export function getKnuckleBaseY(handScale: number, palmLiftY = 0): number {
  const sizeKnuckleOffsetY = (1 - handScale) * 10;
  return PIANO_KNUCKLE_BASE_Y - sizeKnuckleOffsetY + palmLiftY;
}

export function getAbductRatio(fingerSpanPx: number, handScale: number): number {
  return clamp((fingerSpanPx - mmToPx(92) * handScale) / (mmToPx(95) * handScale), -0.1, 0.85);
}

/**
 * Returns the palm-local anchor origin in SVG px (CMC1 for thumb, MCP for fingers 2..5)
 * relative to `(palmCenterX, knuckleBaseY)` before palm rotation.
 */
export function getFingerOriginLocalPx(
  finger: Finger,
  abductRatio: number,
  handScale: number,
  dir: 1 | -1
): Point2D {
  switch (finger) {
    case 1:
      return { x: -mmToPx(18) * dir * handScale, y: mmToPx(49) * handScale };
    case 2:
      return { x: -mmToPx(21 + abductRatio * 4.5) * dir * handScale, y: mmToPx(3.5) * handScale };
    case 3:
      return { x: 0, y: 0 };
    case 4:
      return { x: mmToPx(20 + abductRatio * 4.5) * dir * handScale, y: mmToPx(4.5) * handScale };
    case 5:
      return { x: mmToPx(38 + abductRatio * 11) * dir * handScale, y: mmToPx(12.5) * handScale };
  }
}

export function getFingerReachPx(finger: Finger, spanPreset: SpanPreset = "M"): number {
  const fixedLen = getFixedFingerLengthPx(finger, spanPreset);
  return finger === 1 ? getThumbMetacarpalLengthPx(spanPreset) + fixedLen : fixedLen;
}

// ---------------------------------------------------------------------------
// Pure-millimeter 2D kinematic helpers (unified Right-Hand frame, dir = +1)
// ---------------------------------------------------------------------------

export function getFingerLengthMm(finger: Finger, handScale: number): number {
  return BASE_FINGER_LENGTH_MM[finger] * handScale;
}

export function getThumbMetacarpalLengthMm(handScale: number): number {
  return METACARPAL_1_LENGTH_MM * handScale;
}

export function getFingerReachMm(finger: Finger, handScale: number): number {
  const fixedLen = getFingerLengthMm(finger, handScale);
  return finger === 1 ? getThumbMetacarpalLengthMm(handScale) + fixedLen : fixedLen;
}

export function getAbductRatioMm(fingerSpanMm: number, handScale: number): number {
  return clamp((fingerSpanMm - 92 * handScale) / (95 * handScale), -0.1, 0.85);
}

export function getFingerOriginLocalMm(
  finger: Finger,
  abductRatio: number,
  handScale: number,
  dir: 1 | -1 = 1
): Point2D {
  switch (finger) {
    case 1:
      return { x: -18 * dir * handScale, y: 49 * handScale };
    case 2:
      return { x: -(21 + abductRatio * 4.5) * dir * handScale, y: 3.5 * handScale };
    case 3:
      return { x: 0, y: 0 };
    case 4:
      return { x: (20 + abductRatio * 4.5) * dir * handScale, y: 4.5 * handScale };
    case 5:
      return { x: (38 + abductRatio * 11) * dir * handScale, y: 12.5 * handScale };
  }
}

/**
 * Converts a unified Right-Hand frame position (white-key units) and key color
 * into 2D millimeter coordinates relative to `PIANO_KNUCKLE_BASE_Y` (y = 0).
 */
export function getContactPoint2DMm(
  handFramePos: number,
  isBlack: boolean,
  finger: Finger
): Point2D {
  const tipYPx = isBlack ? BLACK_TIP_Y[finger] : WHITE_TIP_Y[finger];
  return {
    x: handFramePos * REAL_WHITE_KEY_WIDTH_MM,
    y: (tipYPx - PIANO_KNUCKLE_BASE_Y) * PIANO_PX_TO_MM,
  };
}

export interface KinematicContact {
  finger: Finger;
  handFramePos: number;
  isBlack: boolean;
  isHeld: boolean;
}

export interface PalmPose2D {
  palmXMm: number;
  palmYMm: number;
  palmAngleDeg: number;
  abductRatio: number;
}

export interface KinematicEvaluation2D {
  feasible: boolean;
  pose: PalmPose2D;
  maxReachRatio: number;
  infeasibilityExcess: number;
  crowdingEnergy: number;
  comfortEnergy: number;
}

/** Joint-angle ray bounds (radians relative to palm forward axis -Y) per finger. */
const FINGER_RAY_ANGLE_BOUNDS: Record<Finger, [number, number]> = {
  1: [-1.52, 0.72],
  2: [-0.95, 0.65],
  3: [-0.72, 0.72],
  4: [-0.62, 0.78],
  5: [-0.55, 1.15],
};

/** Resting splay angles (radians) for continuous comfort energy. */
const FINGER_REST_ANGLE_RAD: Record<Finger, number> = {
  1: -0.58,
  2: -0.14,
  3: 0.0,
  4: 0.14,
  5: 0.28,
};

const PALM_Y_MIN_MM = -38;
const PALM_Y_MAX_MM = 24;
const PALM_ANGLE_MAX_DEG = 30;
const REACH_TOLERANCE_RATIO = 1.02;
const MAX_KINEMATIC_CACHE_SIZE = 4096;

/** Ergonomic lateral corridor clearance margin (mm, M scale) per adjacent finger gap. */
const CORRIDOR_CLEARANCE_MARGIN_MM = 5.8;

interface CachedPoseResult {
  feasible: boolean;
  relPalmXMm: number;
  palmYMm: number;
  palmAngleDeg: number;
  abductRatio: number;
  maxReachRatio: number;
  infeasibilityExcess: number;
  crowdingEnergy: number;
  comfortEnergy: number;
}

const kinematicPoseCache = new Map<string, CachedPoseResult>();

interface PreparedContact {
  finger: Finger;
  xMm: number;
  yMm: number;
  ox: number;
  oy: number;
  reachMm: number;
}

function evaluatePoseObjective(
  prepared: PreparedContact[],
  palmXMm: number,
  palmYMm: number,
  palmAngleDeg: number,
  handScale: number
): number {
  const rad = (palmAngleDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);

  let obj = 0.02 * (palmAngleDeg / 10) ** 2 + 0.005 * (palmYMm / (10 * handScale)) ** 2;

  for (let i = 0; i < prepared.length; i++) {
    const c = prepared[i];
    const wx = palmXMm + c.ox * cosA - c.oy * sinA;
    const wy = palmYMm + c.ox * sinA + c.oy * cosA;
    const dx = c.xMm - wx;
    const dy = c.yMm - wy;
    const d = Math.hypot(dx, dy);
    const ratio = d / c.reachMm;

    if (ratio > 1.0) {
      obj += 1000 * (ratio - 1.0) ** 2;
    }
    obj += (ratio - 0.78) ** 2;

    const dxLocal = dx * cosA + dy * sinA;
    const dyLocal = -dx * sinA + dy * cosA;
    const forward = -dyLocal;
    if (forward < 4 * handScale) {
      obj += 200 * ((4 * handScale - forward) / (10 * handScale)) ** 2;
    }
    const rayAngle = Math.atan2(dxLocal, Math.max(1e-3, forward));
    const [minAng, maxAng] = FINGER_RAY_ANGLE_BOUNDS[c.finger];
    if (rayAngle < minAng) {
      obj += 400 * (minAng - rayAngle) ** 2;
    } else if (rayAngle > maxAng) {
      obj += 400 * (rayAngle - maxAng) ** 2;
    } else {
      const rest = FINGER_REST_ANGLE_RAD[c.finger];
      obj += 0.15 * (rayAngle - rest) ** 2;
    }
  }

  return obj;
}

function computeFingerWidthCrowdingEnergy(
  prepared: PreparedContact[],
  cosA: number,
  sinA: number,
  handScale: number
): number {
  if (prepared.length < 2) return 0;
  const byFinger = prepared.slice().sort((a, b) => a.finger - b.finger);
  let crowding = 0;

  for (let i = 0; i < byFinger.length - 1; i++) {
    const a = byFinger[i];
    const b = byFinger[i + 1];
    const gapCount = b.finger - a.finger;
    if (gapCount <= 0) continue;

    if (gapCount === 1) {
      // Adjacent fingers (no trapped idle fingers): check 2D tip clearance so Y-staggered
      // white+black minor seconds (e.g. C-C#) remain collision-free.
      const dist2d = Math.hypot(b.xMm - a.xMm, b.yMm - a.yMm);
      const minTipClearance =
        (SLEEVE_HALF_WIDTH_MM[a.finger][2] + SLEEVE_HALF_WIDTH_MM[b.finger][2]) * handScale;
      if (dist2d < minTipClearance) {
        const norm = (minTipClearance - dist2d) / (6 * handScale);
        crowding += 4.0 * norm + 12.0 * norm * norm;
      }
      continue;
    }

    // Trapped idle fingers (a.finger + 1 .. b.finger - 1) along the palm-to-tip corridor:
    // require scaled mid-phalanx widths + ergonomic corridor clearance for every spanned gap.
    let minCorridorClearance = 0;
    for (let f = a.finger; f < b.finger; f++) {
      const fCurr = f as Finger;
      const fNext = (f + 1) as Finger;
      minCorridorClearance +=
        (SLEEVE_HALF_WIDTH_MM[fCurr][1] +
          SLEEVE_HALF_WIDTH_MM[fNext][1] +
          CORRIDOR_CLEARANCE_MARGIN_MM) *
        handScale;
    }

    const lateralDist = (b.xMm - a.xMm) * cosA + (b.yMm - a.yMm) * sinA;
    const deficit = minCorridorClearance - Math.max(0, lateralDist);
    if (deficit > 0) {
      const norm = deficit / (8 * handScale);
      crowding += 4.5 * norm + 14.0 * norm * norm;
    }
  }

  return crowding;
}

function solveAndCachePose2D(
  contacts: KinematicContact[],
  handScale: number
): KinematicEvaluation2D {
  const pts = contacts.map((c) => {
    const pt = getContactPoint2DMm(c.handFramePos, c.isBlack, c.finger);
    return { finger: c.finger, xMm: pt.x, yMm: pt.y };
  });
  pts.sort((a, b) => a.xMm - b.xMm || a.finger - b.finger);

  const baseX = pts[0].xMm;
  const maxX = pts[pts.length - 1].xMm;
  const fingerSpanMm = maxX - baseX;
  const abductRatio = getAbductRatioMm(fingerSpanMm, handScale);

  const cacheKey = `${handScale.toFixed(3)}|${pts
    .map((p) => `${p.finger}:${Math.round((p.xMm - baseX) * 10)}:${Math.round(p.yMm * 10)}`)
    .join(",")}`;

  const cached = kinematicPoseCache.get(cacheKey);
  if (cached) {
    return {
      feasible: cached.feasible,
      pose: {
        palmXMm: baseX + cached.relPalmXMm,
        palmYMm: cached.palmYMm,
        palmAngleDeg: cached.palmAngleDeg,
        abductRatio: cached.abductRatio,
      },
      maxReachRatio: cached.maxReachRatio,
      infeasibilityExcess: cached.infeasibilityExcess,
      crowdingEnergy: cached.crowdingEnergy,
      comfortEnergy: cached.comfortEnergy,
    };
  }

  // Normalized coordinates (relative to baseX) so the solved pose is translation-invariant
  const prepared: PreparedContact[] = new Array(pts.length);
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const origin = getFingerOriginLocalMm(p.finger, abductRatio, handScale, 1);
    const reachMm = getFingerReachMm(p.finger, handScale);
    const relX = p.xMm - baseX;
    prepared[i] = {
      finger: p.finger,
      xMm: relX,
      yMm: p.yMm,
      ox: origin.x,
      oy: origin.y,
      reachMm,
    };
    sumX += relX - origin.x;
    sumY += p.yMm - origin.y + 0.65 * reachMm;
  }

  const minY = PALM_Y_MIN_MM * handScale;
  const maxY = PALM_Y_MAX_MM * handScale;
  let palmX = sumX / pts.length;
  let palmY = clamp(sumY / pts.length, minY, maxY);
  let palmAngleDeg = 0;
  let bestObj = evaluatePoseObjective(prepared, palmX, palmY, palmAngleDeg, handScale);

  // Bounded 3-DoF coordinate refinement (4 sweeps)
  const stepsX = [12, 5, 2, 0.7];
  const stepsY = [10, 4, 1.5, 0.5];
  const stepsA = [10, 4, 1.5, 0.5];

  for (let iter = 0; iter < 4; iter++) {
    const sx = stepsX[iter] * handScale;
    const sy = stepsY[iter] * handScale;
    const sa = stepsA[iter];

    for (const dir of [-1, 1]) {
      const candX = palmX + dir * sx;
      const obj = evaluatePoseObjective(prepared, candX, palmY, palmAngleDeg, handScale);
      if (obj < bestObj) {
        bestObj = obj;
        palmX = candX;
      }
    }
    for (const dir of [-1, 1]) {
      const candY = clamp(palmY + dir * sy, minY, maxY);
      const obj = evaluatePoseObjective(prepared, palmX, candY, palmAngleDeg, handScale);
      if (obj < bestObj) {
        bestObj = obj;
        palmY = candY;
      }
    }
    for (const dir of [-1, 1]) {
      const candA = clamp(palmAngleDeg + dir * sa, -PALM_ANGLE_MAX_DEG, PALM_ANGLE_MAX_DEG);
      const obj = evaluatePoseObjective(prepared, palmX, palmY, candA, handScale);
      if (obj < bestObj) {
        bestObj = obj;
        palmAngleDeg = candA;
      }
    }
  }

  // Final anatomical invariant verification at the solved pose
  const rad = (palmAngleDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  let feasible = true;
  let maxReachRatio = 0;
  let infeasibilityExcess = 0;

  for (let i = 0; i < prepared.length; i++) {
    const c = prepared[i];
    const wx = palmX + c.ox * cosA - c.oy * sinA;
    const wy = palmY + c.ox * sinA + c.oy * cosA;
    const dx = c.xMm - wx;
    const dy = c.yMm - wy;
    const d = Math.hypot(dx, dy);
    const ratio = d / c.reachMm;
    if (ratio > maxReachRatio) maxReachRatio = ratio;

    if (ratio > REACH_TOLERANCE_RATIO) {
      feasible = false;
      infeasibilityExcess += (ratio - REACH_TOLERANCE_RATIO) * 100;
    }

    const dxLocal = dx * cosA + dy * sinA;
    const dyLocal = -dx * sinA + dy * cosA;
    const forward = -dyLocal;
    if (forward < 4 * handScale) {
      feasible = false;
      infeasibilityExcess += (4 * handScale - forward) * 2;
    }
    const rayAngle = Math.atan2(dxLocal, Math.max(1e-3, forward));
    const [minAng, maxAng] = FINGER_RAY_ANGLE_BOUNDS[c.finger];
    if (rayAngle < minAng) {
      feasible = false;
      infeasibilityExcess += (minAng - rayAngle) * 50;
    } else if (rayAngle > maxAng) {
      feasible = false;
      infeasibilityExcess += (rayAngle - maxAng) * 50;
    }
  }

  const crowdingEnergy = computeFingerWidthCrowdingEnergy(prepared, cosA, sinA, handScale);
  // Ulnar (3-4-5) tendon-coupling splay effort when stretched beyond 1.1 white keys per gap
  let ulnarSplayEffort = 0;
  for (let i = 0; i < prepared.length; i++) {
    const a = prepared[i];
    if (a.finger < 3) continue;
    for (let j = i + 1; j < prepared.length; j++) {
      const b = prepared[j];
      if (b.finger < 3 || b.finger <= a.finger) continue;
      const gaps = b.finger - a.finger;
      const lateralPerGap = Math.abs((b.xMm - a.xMm) * cosA + (b.yMm - a.yMm) * sinA) / gaps;
      const freeUlnarGapMm = 26 * handScale;
      if (lateralPerGap > freeUlnarGapMm) {
        const excess = (lateralPerGap - freeUlnarGapMm) / (12 * handScale);
        ulnarSplayEffort += 0.35 * excess * excess;
      }
    }
  }
  const comfortEnergy = bestObj + crowdingEnergy + ulnarSplayEffort;

  if (kinematicPoseCache.size >= MAX_KINEMATIC_CACHE_SIZE) {
    kinematicPoseCache.clear();
  }
  kinematicPoseCache.set(cacheKey, {
    feasible,
    relPalmXMm: palmX,
    palmYMm: palmY,
    palmAngleDeg,
    abductRatio,
    maxReachRatio,
    infeasibilityExcess,
    crowdingEnergy,
    comfortEnergy,
  });

  return {
    feasible,
    pose: {
      palmXMm: baseX + palmX,
      palmYMm: palmY,
      palmAngleDeg,
      abductRatio,
    },
    maxReachRatio,
    infeasibilityExcess,
    crowdingEnergy,
    comfortEnergy,
  };
}

/**
 * Evaluates 2D whole-hand physical feasibility and optimal 3-DoF palm pose
 * for a simultaneous set of active contacts (newly struck + held fingers).
 */
export function evaluateHandKinematics2D(
  contacts: KinematicContact[],
  handScale: number,
  crossMaxWhiteKeys = 2.5
): KinematicEvaluation2D {
  if (contacts.length === 0) {
    return {
      feasible: true,
      pose: { palmXMm: 0, palmYMm: 0, palmAngleDeg: 0, abductRatio: 0 },
      maxReachRatio: 0,
      infeasibilityExcess: 0,
      crowdingEnergy: 0,
      comfortEnergy: 0,
    };
  }

  // 1. Pairwise hard invariants: pure-octave cap, non-thumb/pinky inversions,
  //    and static multi-finger crossed chords (any inversion with >= 3 active contacts).
  let hardInfeasible = false;
  let hardExcess = 0;

  for (let i = 0; i < contacts.length; i++) {
    const a = contacts[i];
    for (let j = i + 1; j < contacts.length; j++) {
      const b = contacts[j];
      const dist = Math.abs(a.handFramePos - b.handFramePos);
      if (dist > MAX_OCTAVE_SPAN + 1e-6) {
        hardInfeasible = true;
        hardExcess += (dist - MAX_OCTAVE_SPAN) * 1000;
      }

      const isInverted =
        (a.finger > b.finger && a.handFramePos < b.handFramePos - 0.5) ||
        (a.finger < b.finger && a.handFramePos > b.handFramePos + 0.5);

      if (isInverted) {
        const involvesThumb = a.finger === 1 || b.finger === 1;
        const involvesPinky = a.finger === 5 || b.finger === 5;
        if (
          contacts.length >= 3 ||
          !involvesThumb ||
          involvesPinky ||
          dist > crossMaxWhiteKeys * handScale
        ) {
          hardInfeasible = true;
          hardExcess += dist + 10;
        }
      }
    }
  }

  const poseEval = solveAndCachePose2D(contacts, handScale);
  if (hardInfeasible) {
    return {
      ...poseEval,
      feasible: false,
      infeasibilityExcess: poseEval.infeasibilityExcess + hardExcess,
    };
  }

  return poseEval;
}
