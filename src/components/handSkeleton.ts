import type { Finger } from "../domain/types";
import { SPAN_PRESET_SCALE } from "../solver/keyboard";
import {
  BASE_FINGER_LENGTH_PX,
  BLACK_TIP_Y,
  IDLE_CURVE_FACTOR,
  METACARPAL_1_LENGTH_MM,
  PIANO_BLACK_KEY_H,
  PIANO_KEYBED_BOTTOM_Y,
  PIANO_KEYS_Y,
  PIANO_MM_TO_PX,
  PIANO_WHITE_KEY_W,
  SLEEVE_HALF_WIDTH_MM,
  WHITE_TIP_Y,
  getAbductRatio,
  getFingerOriginLocalPx,
  getKnuckleBaseY,
  type Point2D,
} from "../solver/handKinematics";
import type { FingerPosture, HandPosture } from "./handPostureModel";

function mm(valMm: number): number {
  return valMm * PIANO_MM_TO_PX;
}

const FINGERS: Finger[] = [1, 2, 3, 4, 5];

/** Bone radii [headRadius, waistRadius] in mm for phalanges. */
const PHALANX_RADII_MM: Record<Finger, [number, number]> = {
  1: [2.2, 1.35],
  2: [1.85, 1.1],
  3: [1.95, 1.15],
  4: [1.8, 1.08],
  5: [1.55, 0.92],
};

export interface BoneSegment {
  from: Point2D;
  to: Point2D;
  headRadius: number;
  waistRadius: number;
  path: string;
}

export interface JointNode {
  x: number;
  y: number;
  radius: number;
  kind: "cmc" | "mcp" | "ip" | "pip" | "dip";
  creasePath: string;
}

export interface FingerSkeleton {
  finger: Finger;
  carpalRoot: Point2D;
  mcp: Point2D;
  tip: Point2D;
  joints: JointNode[];
  metacarpal: BoneSegment;
  phalanges: BoneSegment[];
  sleevePath: string;
  metacarpalLength: number;
  phalanxSpanLength: number;
  totalPhalanxLength: number;
}

export interface HandSkeleton {
  handScale: number;
  palmCenter: Point2D;
  wristCenter: Point2D;
  palmPath: string;
  unifiedHandPath: string;
  carpalArchPath: string;
  thenarCreasePath: string;
  dorsalTendonPaths: string[];
  labelPos: Point2D;
  fingers: Record<Finger, FingerSkeleton>;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpPt(a: Point2D, b: Point2D, t: number): Point2D {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function normalize(vx: number, vy: number): Point2D {
  const len = Math.hypot(vx, vy);
  if (len < 1e-5) return { x: 0, y: -1 };
  return { x: vx / len, y: vy / len };
}

function fmt(n: number): string {
  return n.toFixed(1);
}

function evalThreePointWidth(widths: [number, number, number], t: number): number {
  const clamped = clamp(t, 0, 1);
  if (clamped <= 0.5) {
    return lerp(widths[0], widths[1], clamped * 2);
  }
  return lerp(widths[1], widths[2], (clamped - 0.5) * 2);
}

/**
 * Builds an anatomical bone-shaft SVG path with flared articular ends and a slim waist.
 */
function buildBonePath(from: Point2D, to: Point2D, headR: number, waistR: number): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) {
    return `M ${fmt(from.x - headR)} ${fmt(from.y)} a ${fmt(headR)} ${fmt(headR)} 0 1 0 ${fmt(headR * 2)} 0 a ${fmt(headR)} ${fmt(headR)} 0 1 0 ${fmt(-headR * 2)} 0 Z`;
  }

  const tx = dx / len;
  const ty = dy / len;
  const nx = -ty;
  const ny = tx;

  const r0 = Math.min(headR, len * 0.28);
  const r1 = Math.min(headR * 0.9, len * 0.28);
  const rw = Math.min(waistR, r1 * 0.85);

  const p0L = { x: from.x - nx * r0, y: from.y - ny * r0 };
  const p0R = { x: from.x + nx * r0, y: from.y + ny * r0 };
  const p1L = { x: to.x - nx * r1, y: to.y - ny * r1 };
  const p1R = { x: to.x + nx * r1, y: to.y + ny * r1 };

  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const cL = { x: midX - nx * rw, y: midY - ny * rw };
  const cR = { x: midX + nx * rw, y: midY + ny * rw };

  return [
    `M ${fmt(p0L.x)} ${fmt(p0L.y)}`,
    `Q ${fmt(cL.x)} ${fmt(cL.y)} ${fmt(p1L.x)} ${fmt(p1L.y)}`,
    `A ${fmt(r1)} ${fmt(r1)} 0 1 1 ${fmt(p1R.x)} ${fmt(p1R.y)}`,
    `Q ${fmt(cR.x)} ${fmt(cR.y)} ${fmt(p0R.x)} ${fmt(p0R.y)}`,
    `A ${fmt(r0)} ${fmt(r0)} 0 1 1 ${fmt(p0L.x)} ${fmt(p0L.y)}`,
    "Z",
  ].join(" ");
}

function makeBone(from: Point2D, to: Point2D, headRadius: number, waistRadius: number): BoneSegment {
  return {
    from,
    to,
    headRadius,
    waistRadius,
    path: buildBonePath(from, to, headRadius, waistRadius),
  };
}

/**
 * Builds a subtle organic joint skin-crease or knuckle dome arc.
 */
function buildJointCreasePath(
  joint: Point2D,
  tangent: Point2D,
  halfSpan: number,
  archOffset: number
): string {
  const nx = -tangent.y;
  const ny = tangent.x;
  const pL = { x: joint.x - nx * halfSpan, y: joint.y - ny * halfSpan };
  const pR = { x: joint.x + nx * halfSpan, y: joint.y + ny * halfSpan };
  const ctrl = { x: joint.x + tangent.x * archOffset, y: joint.y + tangent.y * archOffset };
  return `M ${fmt(pL.x)} ${fmt(pL.y)} Q ${fmt(ctrl.x)} ${fmt(ctrl.y)} ${fmt(pR.x)} ${fmt(pR.y)}`;
}

/**
 * Builds a smooth tapered organic finger sleeve following the articulated joint chain.
 */
function buildFingerSleevePath(
  chain: Point2D[],
  widths: [number, number, number]
): string {
  const n = chain.length;
  const leftPts: Point2D[] = [];
  const rightPts: Point2D[] = [];

  for (let i = 0; i < n; i++) {
    const prev = chain[Math.max(0, i - 1)];
    const next = chain[Math.min(n - 1, i + 1)];
    const tVec = normalize(next.x - prev.x, next.y - prev.y);
    const nx = -tVec.y;
    const ny = tVec.x;
    const t = i / Math.max(1, n - 1);
    const hw = evalThreePointWidth(widths, t);

    leftPts.push({ x: chain[i].x - nx * hw, y: chain[i].y - ny * hw });
    rightPts.push({ x: chain[i].x + nx * hw, y: chain[i].y + ny * hw });
  }

  const tipTan = normalize(chain[n - 1].x - chain[n - 2].x, chain[n - 1].y - chain[n - 2].y);
  const tipAngleDeg = (Math.atan2(tipTan.y, tipTan.x) * 180) / Math.PI + 90;
  const hwEnd = widths[2];
  const hwStart = widths[0];

  const cmds: string[] = [`M ${fmt(leftPts[0].x)} ${fmt(leftPts[0].y)}`];
  for (let i = 1; i < n - 1; i++) {
    if (i < n - 2) {
      const mx = (leftPts[i].x + leftPts[i + 1].x) / 2;
      const my = (leftPts[i].y + leftPts[i + 1].y) / 2;
      cmds.push(`Q ${fmt(leftPts[i].x)} ${fmt(leftPts[i].y)} ${fmt(mx)} ${fmt(my)}`);
    } else {
      cmds.push(`Q ${fmt(leftPts[i].x)} ${fmt(leftPts[i].y)} ${fmt(leftPts[n - 1].x)} ${fmt(leftPts[n - 1].y)}`);
    }
  }
  if (n === 2) {
    cmds.push(`L ${fmt(leftPts[1].x)} ${fmt(leftPts[1].y)}`);
  }

  cmds.push(
    `A ${fmt(hwEnd)} ${fmt(hwEnd * 1.16)} ${fmt(tipAngleDeg)} 0 1 ${fmt(rightPts[n - 1].x)} ${fmt(rightPts[n - 1].y)}`
  );

  for (let i = n - 2; i >= 1; i--) {
    if (i > 1) {
      const mx = (rightPts[i].x + rightPts[i - 1].x) / 2;
      const my = (rightPts[i].y + rightPts[i - 1].y) / 2;
      cmds.push(`Q ${fmt(rightPts[i].x)} ${fmt(rightPts[i].y)} ${fmt(mx)} ${fmt(my)}`);
    } else {
      cmds.push(`Q ${fmt(rightPts[i].x)} ${fmt(rightPts[i].y)} ${fmt(rightPts[0].x)} ${fmt(rightPts[0].y)}`);
    }
  }
  if (n === 2) {
    cmds.push(`L ${fmt(rightPts[0].x)} ${fmt(rightPts[0].y)}`);
  }

  cmds.push(
    `A ${fmt(hwStart)} ${fmt(hwStart * 0.72)} ${fmt(tipAngleDeg)} 0 1 ${fmt(leftPts[0].x)} ${fmt(leftPts[0].y)}`,
    "Z"
  );

  return cmds.join(" ");
}

function projectToRadiusWithinY(
  mcp: Point2D,
  targetX: number,
  targetY: number,
  radius: number,
  minY: number,
  maxY: number,
  exactRadius: boolean
): Point2D {
  const clampedTargetY = clamp(targetY, minY, maxY);
  const dx = targetX - mcp.x;
  const dy = clampedTargetY - mcp.y;
  const distToMcp = Math.hypot(dx, dy);

  if (!exactRadius && distToMcp <= radius) {
    return { x: targetX, y: clampedTargetY };
  }

  const len = distToMcp > 1e-4 ? distToMcp : 1;
  const ux = distToMcp > 1e-4 ? dx / len : 0;
  const uy = distToMcp > 1e-4 ? dy / len : -1;

  const y = clamp(mcp.y + uy * radius, minY, maxY);
  const finalDy = y - mcp.y;
  if (Math.abs(finalDy) >= radius) {
    return { x: mcp.x, y };
  }
  const maxDx = Math.sqrt(Math.max(0, radius * radius - finalDy * finalDy));
  const dxSign = ux === 0 ? (exactRadius ? 1 : 0) : Math.sign(ux);
  const finalDx = dxSign * maxDx;
  return { x: mcp.x + finalDx, y };
}

const IDLE_WHITE_MIN_Y: Record<Finger, number> = {
  1: 140,
  2: 124,
  3: 121,
  4: 123,
  5: 132,
};

function computeFingerTargetXY(
  fp: FingerPosture,
  palmLiftY: number,
  hasActiveBlackKey: boolean
): { x: number; rawY: number; minY: number; maxY: number } {
  const x = fp.xUnit * PIANO_WHITE_KEY_W;
  const isPlayingBlack = fp.isBlack && (fp.pressDepth > 0 || fp.targetMidi !== null);
  let rawY: number;

  if (isPlayingBlack) {
    rawY = BLACK_TIP_Y[fp.finger] + fp.pressDepth * 2;
  } else if (fp.targetMidi !== null && fp.pressDepth > 0) {
    rawY = WHITE_TIP_Y[fp.finger] + palmLiftY * 0.45 + fp.pressDepth * 2.5;
  } else {
    rawY = WHITE_TIP_Y[fp.finger] - 2 + palmLiftY * 0.78;
  }

  const isForwardPalm = hasActiveBlackKey || palmLiftY < -25;
  const minY =
    fp.targetMidi === null && !isForwardPalm
      ? IDLE_WHITE_MIN_Y[fp.finger]
      : PIANO_KEYS_Y + 4;
  const maxY = isPlayingBlack ? PIANO_KEYS_Y + PIANO_BLACK_KEY_H - 6 : PIANO_KEYBED_BOTTOM_Y - 8;

  return { x, rawY, minY, maxY };
}

function computeFingerTipXY(
  fp: FingerPosture,
  mcp: Point2D,
  palmLiftY: number,
  handScale: number,
  hasActiveBlackKey: boolean
): Point2D {
  const fixedLen = BASE_FINGER_LENGTH_PX[fp.finger] * handScale;
  const { x, rawY, minY, maxY } = computeFingerTargetXY(fp, palmLiftY, hasActiveBlackKey);

  if (fp.targetMidi === null) {
    // Idle fingers curve at IDLE_CURVE_FACTOR, or curl deeper if needed to stay clear of black keys.
    const idleRadius = fixedLen * IDLE_CURVE_FACTOR;
    const exactRadius = mcp.y - minY >= idleRadius - 0.5;
    return projectToRadiusWithinY(mcp, x, rawY, idleRadius, minY, maxY, exactRadius);
  }

  // Active fingers never stretch past their fixed anatomical length `fixedLen`.
  return projectToRadiusWithinY(mcp, x, rawY, fixedLen, minY, maxY, false);
}

interface FingerPerimeterInfo {
  finger: Finger;
  layerOffset: -1 | 0 | 1;
  chain: Point2D[];
  widths: [number, number, number];
  radPts: Point2D[];
  ulnPts: Point2D[];
  baseTangent: Point2D;
  tipAngleDeg: number;
}

function buildFingerPerimeterInfo(
  finger: Finger,
  layerOffset: -1 | 0 | 1,
  chain: Point2D[],
  widths: [number, number, number],
  dir: 1 | -1,
  radStartFrac: number,
  ulnEndFrac: number
): FingerPerimeterInfo {
  const n = chain.length;
  const radPts: Point2D[] = [];
  const ulnPts: Point2D[] = [];
  const radN: Point2D[] = [];
  const ulnN: Point2D[] = [];
  const tangents: Point2D[] = [];

  for (let i = 0; i < n; i++) {
    const prev = chain[Math.max(0, i - 1)];
    const next = chain[Math.min(n - 1, i + 1)];
    const tVec = normalize(next.x - prev.x, next.y - prev.y);
    tangents.push(tVec);
    const rn = { x: tVec.y * dir, y: -tVec.x * dir };
    radN.push(rn);
    ulnN.push({ x: -rn.x, y: -rn.y });
  }

  const baseSegLen = dist(chain[0], chain[1]);
  const hw0Rad = evalThreePointWidth(widths, clamp((radStartFrac * baseSegLen) / Math.max(1, dist(chain[0], chain[n - 1])), 0, 0.35));
  const hw0Uln = evalThreePointWidth(widths, clamp((ulnEndFrac * baseSegLen) / Math.max(1, dist(chain[0], chain[n - 1])), 0, 0.35));

  const radAnchor = {
    x: chain[0].x + tangents[0].x * (radStartFrac * baseSegLen),
    y: chain[0].y + tangents[0].y * (radStartFrac * baseSegLen),
  };
  const ulnAnchor = {
    x: chain[0].x + tangents[0].x * (ulnEndFrac * baseSegLen),
    y: chain[0].y + tangents[0].y * (ulnEndFrac * baseSegLen),
  };

  radPts.push({ x: radAnchor.x + radN[0].x * hw0Rad, y: radAnchor.y + radN[0].y * hw0Rad });
  ulnPts.push({ x: ulnAnchor.x + ulnN[0].x * hw0Uln, y: ulnAnchor.y + ulnN[0].y * hw0Uln });

  for (let i = 1; i < n; i++) {
    const t = i / Math.max(1, n - 1);
    const hw = evalThreePointWidth(widths, t);
    radPts.push({ x: chain[i].x + radN[i].x * hw, y: chain[i].y + radN[i].y * hw });
    ulnPts.push({ x: chain[i].x + ulnN[i].x * hw, y: chain[i].y + ulnN[i].y * hw });
  }

  const tipTan = normalize(chain[n - 1].x - chain[n - 2].x, chain[n - 1].y - chain[n - 2].y);
  const tipAngleDeg = (Math.atan2(tipTan.y, tipTan.x) * 180) / Math.PI + 90;

  return {
    finger,
    layerOffset,
    chain,
    widths,
    radPts,
    ulnPts,
    baseTangent: tangents[0],
    tipAngleDeg,
  };
}

function appendFingerUpCmds(cmds: string[], info: FingerPerimeterInfo): void {
  const pts = info.radPts;
  const n = pts.length;
  for (let i = 1; i < n - 1; i++) {
    if (i < n - 2) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      cmds.push(`Q ${fmt(pts[i].x)} ${fmt(pts[i].y)} ${fmt(mx)} ${fmt(my)}`);
    } else {
      cmds.push(`Q ${fmt(pts[i].x)} ${fmt(pts[i].y)} ${fmt(pts[n - 1].x)} ${fmt(pts[n - 1].y)}`);
    }
  }
  if (n === 2) {
    cmds.push(`L ${fmt(pts[1].x)} ${fmt(pts[1].y)}`);
  }
}

function appendFingerDownCmds(cmds: string[], info: FingerPerimeterInfo): void {
  const pts = info.ulnPts;
  const n = pts.length;
  for (let i = n - 2; i >= 1; i--) {
    if (i > 1) {
      const mx = (pts[i].x + pts[i - 1].x) / 2;
      const my = (pts[i].y + pts[i - 1].y) / 2;
      cmds.push(`Q ${fmt(pts[i].x)} ${fmt(pts[i].y)} ${fmt(mx)} ${fmt(my)}`);
    } else {
      cmds.push(`Q ${fmt(pts[i].x)} ${fmt(pts[i].y)} ${fmt(pts[0].x)} ${fmt(pts[0].y)}`);
    }
  }
  if (n === 2) {
    cmds.push(`L ${fmt(pts[0].x)} ${fmt(pts[0].y)}`);
  }
}

function buildUnifiedHandPath(
  perimeters: Record<Finger, FingerPerimeterInfo>,
  mcps: Record<Finger, Point2D>,
  carpalRoots: Record<Finger, Point2D>,
  landmarks: {
    wristThumb: Point2D;
    wristMid: Point2D;
    wristPinky: Point2D;
    thenarOuter: Point2D;
    thumbSaddle: Point2D;
    ulnarMcp5: Point2D;
    hypothenarOuter: Point2D;
  },
  dir: 1 | -1,
  handScale: number
): string {
  const normalFingers = FINGERS.filter((f) => perimeters[f].layerOffset === 0);
  const tipArcSweep = dir === 1 ? 1 : 0;

  // Prevent adjacent interdigital web bases from ever crossing if fingers pinch close
  for (let i = 0; i < normalFingers.length - 1; i++) {
    const fA = normalFingers[i];
    const fB = normalFingers[i + 1];
    if (fA === 1 || fB !== fA + 1) continue;
    const pA = perimeters[fA].ulnPts[0];
    const pB = perimeters[fB].radPts[0];
    const gap = (pB.x - pA.x) * dir;
    const minGap = 2.5 * handScale;
    if (gap < minGap) {
      const midX = (pA.x + pB.x) / 2;
      pA.x = midX - (minGap / 2) * dir;
      pB.x = midX + (minGap / 2) * dir;
    }
  }

  const cmds: string[] = [`M ${fmt(landmarks.wristThumb.x)} ${fmt(landmarks.wristThumb.y)}`];

  if (normalFingers.length === 0) {
    cmds.push(
      `Q ${fmt(landmarks.thenarOuter.x)} ${fmt(landmarks.thenarOuter.y)} ${fmt(landmarks.thumbSaddle.x)} ${fmt(landmarks.thumbSaddle.y)}`,
      `Q ${fmt(mcps[3].x)} ${fmt(mcps[3].y)} ${fmt(landmarks.ulnarMcp5.x)} ${fmt(landmarks.ulnarMcp5.y)}`,
      `Q ${fmt(landmarks.hypothenarOuter.x)} ${fmt(landmarks.hypothenarOuter.y)} ${fmt(landmarks.wristPinky.x)} ${fmt(landmarks.wristPinky.y)}`,
      `Q ${fmt(landmarks.wristMid.x)} ${fmt(landmarks.wristMid.y)} ${fmt(landmarks.wristThumb.x)} ${fmt(landmarks.wristThumb.y)}`,
      "Z"
    );
    return cmds.join(" ");
  }

  const firstF = normalFingers[0];
  const firstRadStart = perimeters[firstF].radPts[0];
  if (firstF === 1) {
    const v = {
      x: firstRadStart.x - landmarks.wristThumb.x,
      y: firstRadStart.y - landmarks.wristThumb.y,
    };
    const outwardN = normalize(v.y * dir, -v.x * dir);
    const midThenar = lerpPt(landmarks.wristThumb, firstRadStart, 0.52);
    const dynamicThenar = {
      x: midThenar.x + outwardN.x * mm(6.5) * handScale,
      y: midThenar.y + outwardN.y * mm(6.5) * handScale,
    };
    cmds.push(
      `Q ${fmt(dynamicThenar.x)} ${fmt(dynamicThenar.y)} ${fmt(firstRadStart.x)} ${fmt(firstRadStart.y)}`
    );
  } else {
    const saddleEntry = lerpPt(landmarks.thenarOuter, landmarks.thumbSaddle, 0.55);
    cmds.push(
      `Q ${fmt(landmarks.thenarOuter.x)} ${fmt(landmarks.thenarOuter.y)} ${fmt(saddleEntry.x)} ${fmt(saddleEntry.y)}`,
      `Q ${fmt(landmarks.thumbSaddle.x)} ${fmt(landmarks.thumbSaddle.y)} ${fmt(firstRadStart.x)} ${fmt(firstRadStart.y)}`
    );
  }

  for (let idx = 0; idx < normalFingers.length; idx++) {
    const f = normalFingers[idx];
    const info = perimeters[f];
    appendFingerUpCmds(cmds, info);

    const hwEnd = info.widths[2];
    const ulnTip = info.ulnPts[info.ulnPts.length - 1];
    cmds.push(
      `A ${fmt(hwEnd)} ${fmt(hwEnd * 1.16)} ${fmt(info.tipAngleDeg)} 0 ${tipArcSweep} ${fmt(ulnTip.x)} ${fmt(ulnTip.y)}`
    );

    appendFingerDownCmds(cmds, info);

    if (idx < normalFingers.length - 1) {
      const nextF = normalFingers[idx + 1];
      const nextInfo = perimeters[nextF];
      const uWeb = info.ulnPts[0];
      const rWeb = nextInfo.radPts[0];

      if (nextF === f + 1) {
        if (f === 1 && nextF === 2) {
          // Deep concave purlicue curve between thumb (1) and index (2)
          const proxVec = normalize(carpalRoots[2].x - mcps[2].x, carpalRoots[2].y - mcps[2].y);
          const mid12 = lerpPt(uWeb, rWeb, 0.45);
          const purlicueDeep = {
            x: mid12.x + proxVec.x * mm(10) * handScale,
            y: mid12.y + proxVec.y * mm(10) * handScale,
          };
          const c1 = lerpPt(uWeb, purlicueDeep, 0.72);
          const c2 = lerpPt(rWeb, purlicueDeep, 0.72);
          cmds.push(
            `C ${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(rWeb.x)} ${fmt(rWeb.y)}`
          );
        } else {
          // Smooth U-shaped interdigital web (2-3, 3-4, 4-5) with C1 entry/exit tangents
          const gap = Math.abs(rWeb.x - uWeb.x);
          const webDepth = clamp(gap * 0.68, 4 * handScale, 9.5 * handScale);
          const c1 = {
            x: uWeb.x - info.baseTangent.x * webDepth,
            y: uWeb.y - info.baseTangent.y * webDepth,
          };
          const c2 = {
            x: rWeb.x - nextInfo.baseTangent.x * webDepth,
            y: rWeb.y - nextInfo.baseTangent.y * webDepth,
          };
          cmds.push(
            `C ${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(rWeb.x)} ${fmt(rWeb.y)}`
          );
        }
      } else {
        // Bridge cleanly across skipped crossing fingers (layerOffset !== 0) at natural web height
        if (f === 1) {
          const proxVec = normalize(carpalRoots[2].x - mcps[2].x, carpalRoots[2].y - mcps[2].y);
          const midCrest = lerpPt(uWeb, rWeb, 0.45);
          const archPeak = {
            x: midCrest.x + proxVec.x * mm(5) * handScale,
            y: midCrest.y + proxVec.y * mm(5) * handScale,
          };
          const c1 = lerpPt(uWeb, archPeak, 0.65);
          const c2 = lerpPt(rWeb, archPeak, 0.65);
          cmds.push(
            `C ${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(rWeb.x)} ${fmt(rWeb.y)}`
          );
        } else {
          const midMcp = lerpPt(uWeb, rWeb, 0.5);
          cmds.push(
            `Q ${fmt(midMcp.x)} ${fmt(midMcp.y + 3 * handScale)} ${fmt(rWeb.x)} ${fmt(rWeb.y)}`
          );
        }
      }
    }
  }

  const ulnMid = lerpPt(landmarks.ulnarMcp5, landmarks.hypothenarOuter, 0.5);
  cmds.push(
    `Q ${fmt(landmarks.ulnarMcp5.x)} ${fmt(landmarks.ulnarMcp5.y)} ${fmt(ulnMid.x)} ${fmt(ulnMid.y)}`,
    `Q ${fmt(landmarks.hypothenarOuter.x)} ${fmt(landmarks.hypothenarOuter.y)} ${fmt(landmarks.wristPinky.x)} ${fmt(landmarks.wristPinky.y)}`
  );

  cmds.push(
    `Q ${fmt(landmarks.wristMid.x)} ${fmt(landmarks.wristMid.y)} ${fmt(landmarks.wristThumb.x)} ${fmt(landmarks.wristThumb.y)}`,
    "Z"
  );

  return cmds.join(" ");
}

/**
 * Computes an articulated anatomical hand skeleton with real-world physical scaling
 * relative to `PIANO_WHITE_KEY_W` (`23.5 mm` key pitch) and a unified organic silhouette.
 */
export function computeHandSkeleton(posture: HandPosture): HandSkeleton {
  const handScale = SPAN_PRESET_SCALE[posture.spanPreset ?? "M"];
  const dir = posture.hand === "RH" ? 1 : -1;
  const hasActiveBlackKey = FINGERS.some(
    (f) => posture.fingers[f].targetMidi !== null && posture.fingers[f].isBlack
  );
  const palmCenterX = posture.palmCenterXUnit * PIANO_WHITE_KEY_W;
  const knuckleBaseY = getKnuckleBaseY(handScale, posture.palmLiftY);

  const fingerSpanPx = Math.abs(posture.fingers[5].xUnit - posture.fingers[1].xUnit) * PIANO_WHITE_KEY_W;
  const abductRatio = getAbductRatio(fingerSpanPx, handScale);

  const angleRad = (posture.palmAngleDeg * Math.PI) / 180;
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);

  const toWorldPx = (lx: number, ly: number): Point2D => ({
    x: palmCenterX + lx * cosA - ly * sinA,
    y: knuckleBaseY + lx * sinA + ly * cosA,
  });

  const toWorldMm = (dxMm: number, dyMm: number): Point2D =>
    toWorldPx(mm(dxMm) * handScale, mm(dyMm) * handScale);

  // Carpal roots at wrist arch (metacarpal proximal bases, mm scaled by handScale)
  const carpalRoots: Record<Finger, Point2D> = {
    1: toWorldMm(-18 * dir, 49),
    2: toWorldMm(-12 * dir, 52),
    3: toWorldMm(0, 54),
    4: toWorldMm(11 * dir, 52),
    5: toWorldMm(19 * dir, 52),
  };

  // Fixed knuckle anchors for fingers 2..5 (MCP)
  const mcps: Record<Finger, Point2D> = {
    1: { x: 0, y: 0 }, // Solved below via biomechanical CMC1 abduction
    2: toWorldPx(
      getFingerOriginLocalPx(2, abductRatio, handScale, dir).x,
      getFingerOriginLocalPx(2, abductRatio, handScale, dir).y
    ),
    3: toWorldPx(
      getFingerOriginLocalPx(3, abductRatio, handScale, dir).x,
      getFingerOriginLocalPx(3, abductRatio, handScale, dir).y
    ),
    4: toWorldPx(
      getFingerOriginLocalPx(4, abductRatio, handScale, dir).x,
      getFingerOriginLocalPx(4, abductRatio, handScale, dir).y
    ),
    5: toWorldPx(
      getFingerOriginLocalPx(5, abductRatio, handScale, dir).x,
      getFingerOriginLocalPx(5, abductRatio, handScale, dir).y
    ),
  };

  // Biomechanical 2-link thumb abduction around CMC1 (carpalRoots[1] -> mcps[1] -> tip)
  const thumbFp = posture.fingers[1];
  const thumbTarget = computeFingerTargetXY(thumbFp, posture.palmLiftY, hasActiveBlackKey);
  const clampedThumbTargetY = clamp(thumbTarget.rawY, thumbTarget.minY, thumbTarget.maxY);
  const targetRelX = thumbTarget.x - carpalRoots[1].x;
  const targetRelY = clampedThumbTargetY - carpalRoots[1].y;
  // Transform target displacement into palm-local coordinates
  const localDx = targetRelX * cosA + targetRelY * sinA;
  const localDy = -targetRelX * sinA + targetRelY * cosA;
  const radialX = -localDx * dir;
  const forwardY = -localDy;
  const targetAngle = Math.atan2(radialX, Math.max(mm(12) * handScale, forwardY));
  const mc1Len = mm(METACARPAL_1_LENGTH_MM) * handScale;
  const fixedThumbLen = BASE_FINGER_LENGTH_PX[1] * handScale;
  const distFromCmc = Math.hypot(localDx, localDy);

  let cmcAngle: number;
  if (thumbFp.layerOffset === -1) {
    cmcAngle = clamp(targetAngle, -0.38, 0.35);
  } else {
    const naturalCmcAngle = clamp(targetAngle * 0.92 + 0.16, 0.42, 1.32);
    const stretchBlend = clamp((distFromCmc / (mc1Len + fixedThumbLen) - 0.78) / 0.2, 0, 1);
    cmcAngle = lerp(naturalCmcAngle, clamp(targetAngle, 0.25, 1.52), stretchBlend);
  }

  const cmc1Local = getFingerOriginLocalPx(1, abductRatio, handScale, dir);
  mcps[1] = toWorldPx(
    cmc1Local.x - Math.sin(cmcAngle) * mc1Len * dir,
    cmc1Local.y - Math.cos(cmcAngle) * mc1Len
  );

  // Organic palm silhouette landmarks (mm scaled by handScale)
  const wristThumb = toWorldMm(-22 * dir, 53);
  const wristMid = toWorldMm(0, 54.5);
  const wristPinky = toWorldMm(22 * dir, 52);
  const thenarOuter = toWorldMm((-33 - abductRatio * 8) * dir, 31);
  const thumbSaddle = toWorldMm((-23 - abductRatio * 5) * dir, 12);
  const radialMcp1 = toWorldPx(
    cmc1Local.x - Math.sin(cmcAngle) * mc1Len * dir - 4 * handScale * dir,
    cmc1Local.y - Math.cos(cmcAngle) * mc1Len + 1 * handScale
  );
  const radialMcp2 = toWorldMm((-24 - abductRatio * 4.5) * dir, 2.5);
  const ulnarMcp5 = toWorldMm((42 + abductRatio * 11) * dir, 17);
  const hypothenarOuter = toWorldMm((33 + abductRatio * 7) * dir, 35);

  const knuckleCrest23 = toWorldMm((-10 - abductRatio * 2) * dir, -2);
  const knuckleCrest34 = toWorldMm((10 + abductRatio * 2) * dir, -1.5);
  const knuckleCrest45 = toWorldMm((28 + abductRatio * 7) * dir, 5);

  const palmPath = [
    `M ${fmt(wristThumb.x)} ${fmt(wristThumb.y)}`,
    `Q ${fmt(thenarOuter.x)} ${fmt(thenarOuter.y)} ${fmt(radialMcp1.x)} ${fmt(radialMcp1.y)}`,
    `Q ${fmt(thumbSaddle.x)} ${fmt(thumbSaddle.y)} ${fmt(radialMcp2.x)} ${fmt(radialMcp2.y)}`,
    `Q ${fmt(knuckleCrest23.x)} ${fmt(knuckleCrest23.y)} ${fmt(mcps[3].x)} ${fmt(mcps[3].y - 3 * handScale)}`,
    `Q ${fmt(knuckleCrest34.x)} ${fmt(knuckleCrest34.y)} ${fmt(mcps[4].x)} ${fmt(mcps[4].y - 2 * handScale)}`,
    `Q ${fmt(knuckleCrest45.x)} ${fmt(knuckleCrest45.y)} ${fmt(ulnarMcp5.x)} ${fmt(ulnarMcp5.y)}`,
    `Q ${fmt(hypothenarOuter.x)} ${fmt(hypothenarOuter.y)} ${fmt(wristPinky.x)} ${fmt(wristPinky.y)}`,
    `Q ${fmt(wristMid.x)} ${fmt(wristMid.y)} ${fmt(wristThumb.x)} ${fmt(wristThumb.y)}`,
    "Z",
  ].join(" ");

  const carpalArchPath = [
    `M ${fmt(carpalRoots[1].x)} ${fmt(carpalRoots[1].y)}`,
    `Q ${fmt(carpalRoots[2].x)} ${fmt(carpalRoots[2].y + 2 * handScale)} ${fmt(carpalRoots[3].x)} ${fmt(carpalRoots[3].y + 2 * handScale)}`,
    `Q ${fmt(carpalRoots[4].x)} ${fmt(carpalRoots[4].y + 2 * handScale)} ${fmt(carpalRoots[5].x)} ${fmt(carpalRoots[5].y)}`,
  ].join(" ");

  const thenarStart = toWorldMm((-21 - abductRatio * 3) * dir, 15);
  const thenarCtrl = toWorldMm((-14 - abductRatio * 2) * dir, 31);
  const thenarEnd = toWorldMm(-8 * dir, 47);
  const thenarCreasePath = `M ${fmt(thenarStart.x)} ${fmt(thenarStart.y)} Q ${fmt(thenarCtrl.x)} ${fmt(thenarCtrl.y)} ${fmt(thenarEnd.x)} ${fmt(thenarEnd.y)}`;

  const dorsalTendonPaths = ([2, 3, 4, 5] as const).map((f) => {
    const start = lerpPt(carpalRoots[f], mcps[f], 0.18);
    const end = lerpPt(carpalRoots[f], mcps[f], 0.88);
    return `M ${fmt(start.x)} ${fmt(start.y)} L ${fmt(end.x)} ${fmt(end.y)}`;
  });

  const fingers = {} as Record<Finger, FingerSkeleton>;
  const perimeters = {} as Record<Finger, FingerPerimeterInfo>;

  for (const f of FINGERS) {
    const fp = posture.fingers[f];
    const carpalRoot = carpalRoots[f];
    const mcp = mcps[f];
    const tip = computeFingerTipXY(fp, mcp, posture.palmLiftY, handScale, hasActiveBlackKey);

    const dx = tip.x - mcp.x;
    const dy = tip.y - mcp.y;
    const spanLen = Math.hypot(dx, dy) || 1;
    const tangent = { x: dx / spanLen, y: dy / spanLen };
    // Ulnar-oriented unit perpendicular (points toward pinky side for both RH and LH)
    const ux = -tangent.y * dir;
    const uy = tangent.x * dir;

    const fixedLen = BASE_FINGER_LENGTH_PX[f] * handScale;
    const stretchRatio = clamp(spanLen / Math.max(1, fixedLen), 0.45, 1.0);
    const relaxScale = 1 - stretchRatio * 0.75;

    let bendPx = 0;
    if (fp.layerOffset === -1) {
      bendPx = mm(10) * handScale;
    } else if (fp.layerOffset === 1) {
      bendPx = -mm(9) * handScale;
    } else if (f === 1) {
      bendPx = mm(3.4) * handScale * relaxScale;
    } else if (f === 2) {
      bendPx = mm(1.4) * handScale * relaxScale;
    } else if (f === 4) {
      bendPx = -mm(1.4) * handScale * relaxScale;
    } else if (f === 5) {
      bendPx = -mm(2.2) * handScale * relaxScale;
    }

    const [rawHeadR, rawWaistR] = PHALANX_RADII_MM[f];
    const headR = mm(rawHeadR) * handScale;
    const waistR = mm(rawWaistR) * handScale;
    const metacarpal = makeBone(carpalRoot, mcp, headR * 1.05, waistR * 1.05);
    const metacarpalLength = dist(carpalRoot, mcp);

    const [w0, w1, w2] = SLEEVE_HALF_WIDTH_MM[f];
    const widths: [number, number, number] = [
      mm(w0) * handScale,
      mm(w1) * handScale,
      mm(w2) * handScale,
    ];

    const joints: JointNode[] = [];
    const phalanges: BoneSegment[] = [];
    let chain: Point2D[];

    if (f === 1) {
      const ip: Point2D = {
        x: lerp(mcp.x, tip.x, 0.52) + ux * bendPx,
        y: lerp(mcp.y, tip.y, 0.52) + uy * bendPx,
      };
      const cmcTan = normalize(mcp.x - carpalRoot.x, mcp.y - carpalRoot.y);
      const mcpTan = normalize(ip.x - carpalRoot.x, ip.y - carpalRoot.y);
      const ipTan = normalize(tip.x - mcp.x, tip.y - mcp.y);
      joints.push(
        {
          x: carpalRoot.x,
          y: carpalRoot.y,
          radius: 2.4 * handScale,
          kind: "cmc",
          creasePath: buildJointCreasePath(carpalRoot, cmcTan, 3.6 * handScale, 1.2 * handScale),
        },
        {
          x: mcp.x,
          y: mcp.y,
          radius: 3.1 * handScale,
          kind: "mcp",
          creasePath: buildJointCreasePath(mcp, mcpTan, widths[0] * 0.48, -1.3 * handScale),
        },
        {
          x: ip.x,
          y: ip.y,
          radius: 2.5 * handScale,
          kind: "ip",
          creasePath: buildJointCreasePath(ip, ipTan, widths[1] * 0.56, 1.5 * handScale),
        }
      );
      phalanges.push(
        makeBone(mcp, ip, headR, waistR),
        makeBone(ip, tip, headR * 0.88, waistR * 0.88)
      );
      chain = [mcp, ip, tip];
    } else {
      const pip: Point2D = {
        x: lerp(mcp.x, tip.x, 0.46) + ux * (bendPx * 0.85),
        y: lerp(mcp.y, tip.y, 0.46) + uy * (bendPx * 0.85),
      };
      const dip: Point2D = {
        x: lerp(mcp.x, tip.x, 0.76) + ux * (bendPx * 0.55),
        y: lerp(mcp.y, tip.y, 0.76) + uy * (bendPx * 0.55),
      };
      const mcpTan = normalize(pip.x - carpalRoot.x, pip.y - carpalRoot.y);
      const pipTan = normalize(dip.x - mcp.x, dip.y - mcp.y);
      const dipTan = normalize(tip.x - pip.x, tip.y - pip.y);
      const mcpR = (f === 3 ? 3.1 : f === 5 ? 2.5 : 2.9) * handScale;
      joints.push(
        {
          x: mcp.x,
          y: mcp.y,
          radius: mcpR,
          kind: "mcp",
          creasePath: buildJointCreasePath(mcp, mcpTan, widths[0] * 0.48, -1.4 * handScale),
        },
        {
          x: pip.x,
          y: pip.y,
          radius: mcpR * 0.78,
          kind: "pip",
          creasePath: buildJointCreasePath(pip, pipTan, widths[1] * 0.58, 1.5 * handScale),
        },
        {
          x: dip.x,
          y: dip.y,
          radius: mcpR * 0.62,
          kind: "dip",
          creasePath: buildJointCreasePath(dip, dipTan, widths[2] * 0.58, 1.2 * handScale),
        }
      );
      phalanges.push(
        makeBone(mcp, pip, headR, waistR),
        makeBone(pip, dip, headR * 0.88, waistR * 0.88),
        makeBone(dip, tip, headR * 0.76, waistR * 0.76)
      );
      chain = [mcp, pip, dip, tip];
    }

    const totalPhalanxLength = phalanges.reduce((acc, b) => acc + dist(b.from, b.to), 0);
    const sleevePath = buildFingerSleevePath(chain, widths);

    const radStartFrac =
      f === 1
        ? 0
        : f === 2 && posture.fingers[1].layerOffset !== 0
          ? 0.08
          : 0.24;
    const ulnEndFrac = f === 1 ? 0.14 : f === 5 ? 0.12 : 0.24;
    perimeters[f] = buildFingerPerimeterInfo(
      f,
      fp.layerOffset,
      chain,
      widths,
      dir,
      radStartFrac,
      ulnEndFrac
    );

    fingers[f] = {
      finger: f,
      carpalRoot,
      mcp,
      tip,
      joints,
      metacarpal,
      phalanges,
      sleevePath,
      metacarpalLength,
      phalanxSpanLength: spanLen,
      totalPhalanxLength,
    };
  }

  const unifiedHandPath = buildUnifiedHandPath(
    perimeters,
    mcps,
    carpalRoots,
    {
      wristThumb,
      wristMid,
      wristPinky,
      thenarOuter,
      thumbSaddle,
      ulnarMcp5,
      hypothenarOuter,
    },
    dir,
    handScale
  );

  return {
    handScale,
    palmCenter: toWorldMm(0, 23),
    wristCenter: wristMid,
    palmPath,
    unifiedHandPath,
    carpalArchPath,
    thenarCreasePath,
    dorsalTendonPaths,
    labelPos: toWorldMm(0, 29),
    fingers,
  };
}
