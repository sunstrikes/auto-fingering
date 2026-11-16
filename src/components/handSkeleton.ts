import type { Finger } from "../domain/types";
import type { FingerPosture, HandPosture } from "./handPostureModel";

export const PIANO_WHITE_KEY_W = 24;
export const PIANO_WHITE_KEY_H = 112;
export const PIANO_BLACK_KEY_W = 14.5;
export const PIANO_BLACK_KEY_H = 70;
export const PIANO_KEYS_Y = 50;
export const PIANO_KEYBED_BOTTOM_Y = PIANO_KEYS_Y + PIANO_WHITE_KEY_H; // 162
export const PIANO_KNUCKLE_BASE_Y = PIANO_KEYBED_BOTTOM_Y + 13; // 175
export const PIANO_WRIST_Y = PIANO_KEYBED_BOTTOM_Y + 62; // 224
export const PIANO_SVG_H = 244;

const FINGERS: Finger[] = [1, 2, 3, 4, 5];

/** Natural white-key contact Y by finger (3 deepest, 2/4 mid, 5 shorter, 1 frontmost). */
const WHITE_TIP_Y: Record<Finger, number> = {
  1: 149,
  2: 127,
  3: 117,
  4: 125,
  5: 143,
};

/** Natural black-key contact Y by finger (black keys occupy y = 50..120). */
const BLACK_TIP_Y: Record<Finger, number> = {
  1: 108,
  2: 98,
  3: 93,
  4: 97,
  5: 106,
};

/** Max physical reach from MCP knuckle to fingertip to prevent rubber-band stretching. */
const MAX_FINGER_REACH_PX: Record<Finger, number> = {
  1: 52,
  2: 62,
  3: 68,
  4: 64,
  5: 54,
};

/** Outer sleeve half-width [base, tip] for each finger. */
const SLEEVE_HALF_WIDTH: Record<Finger, [number, number]> = {
  1: [5.4, 4.3],
  2: [4.5, 3.3],
  3: [4.7, 3.5],
  4: [4.4, 3.2],
  5: [3.9, 2.8],
};

/** Bone radii [headRadius, waistRadius] for phalanges. */
const PHALANX_RADII: Record<Finger, [number, number]> = {
  1: [2.2, 1.35],
  2: [1.85, 1.1],
  3: [1.95, 1.15],
  4: [1.8, 1.08],
  5: [1.55, 0.92],
};

export interface Point2D {
  x: number;
  y: number;
}

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
  palmCenter: Point2D;
  wristCenter: Point2D;
  palmPath: string;
  carpalArchPath: string;
  labelPos: Point2D;
  fingers: Record<Finger, FingerSkeleton>;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function fmt(n: number): string {
  return n.toFixed(1);
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
 * Builds a smooth tapered translucent finger sleeve following the articulated joint chain.
 */
function buildFingerSleevePath(chain: Point2D[], halfWidthStart: number, halfWidthEnd: number): string {
  const n = chain.length;
  const leftPts: Point2D[] = [];
  const rightPts: Point2D[] = [];

  for (let i = 0; i < n; i++) {
    const prev = chain[Math.max(0, i - 1)];
    const next = chain[Math.min(n - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const t = i / Math.max(1, n - 1);
    const hw = lerp(halfWidthStart, halfWidthEnd, t);

    leftPts.push({ x: chain[i].x - nx * hw, y: chain[i].y - ny * hw });
    rightPts.push({ x: chain[i].x + nx * hw, y: chain[i].y + ny * hw });
  }

  const cmds: string[] = [`M ${fmt(leftPts[0].x)} ${fmt(leftPts[0].y)}`];
  for (let i = 1; i < n; i++) {
    if (i < n - 1) {
      const mx = (leftPts[i].x + leftPts[i + 1].x) / 2;
      const my = (leftPts[i].y + leftPts[i + 1].y) / 2;
      cmds.push(`Q ${fmt(leftPts[i].x)} ${fmt(leftPts[i].y)} ${fmt(mx)} ${fmt(my)}`);
    } else {
      cmds.push(`L ${fmt(leftPts[i].x)} ${fmt(leftPts[i].y)}`);
    }
  }

  // Semicircular fingertip cap (clockwise sweep = 1 matches left->right across +tangent)
  cmds.push(
    `A ${fmt(halfWidthEnd)} ${fmt(halfWidthEnd)} 0 1 1 ${fmt(rightPts[n - 1].x)} ${fmt(rightPts[n - 1].y)}`
  );

  for (let i = n - 2; i >= 0; i--) {
    if (i > 0) {
      const mx = (rightPts[i].x + rightPts[i - 1].x) / 2;
      const my = (rightPts[i].y + rightPts[i - 1].y) / 2;
      cmds.push(`Q ${fmt(rightPts[i].x)} ${fmt(rightPts[i].y)} ${fmt(mx)} ${fmt(my)}`);
    } else {
      cmds.push(`L ${fmt(rightPts[0].x)} ${fmt(rightPts[0].y)}`);
    }
  }

  cmds.push(
    `A ${fmt(halfWidthStart)} ${fmt(halfWidthStart)} 0 1 1 ${fmt(leftPts[0].x)} ${fmt(leftPts[0].y)}`,
    "Z"
  );

  return cmds.join(" ");
}

function computeFingerTipXY(fp: FingerPosture, mcp: Point2D, palmLiftY: number): Point2D {
  const x = fp.xUnit * PIANO_WHITE_KEY_W;
  let rawY: number;

  if (fp.isBlack && (fp.pressDepth > 0 || fp.targetMidi !== null)) {
    rawY = BLACK_TIP_Y[fp.finger] + fp.pressDepth * 2;
  } else if (fp.targetMidi !== null && fp.pressDepth > 0) {
    rawY = WHITE_TIP_Y[fp.finger] + palmLiftY * 0.72 + fp.pressDepth * 2.5;
  } else {
    rawY = WHITE_TIP_Y[fp.finger] - 2 + palmLiftY * 0.85;
  }

  let y = clamp(rawY, PIANO_KEYS_Y + 14, PIANO_KEYBED_BOTTOM_Y - 8);

  // Enforce anatomical bone reach from MCP while keeping X locked to the target key center
  const maxReach = MAX_FINGER_REACH_PX[fp.finger];
  const dx = x - mcp.x;
  const dy = y - mcp.y;
  if (Math.hypot(dx, dy) > maxReach) {
    const maxDy = Math.sqrt(Math.max(144, maxReach * maxReach - dx * dx));
    y = clamp(mcp.y - maxDy, PIANO_KEYS_Y + 14, PIANO_KEYBED_BOTTOM_Y - 8);
  }

  return { x, y };
}

/**
 * Computes an articulated anatomical hand skeleton (carpal arch, metacarpals, MCP/PIP/DIP/IP joints,
 * phalanx bones, and organic palm/finger silhouette) from a `HandPosture`.
 */
export function computeHandSkeleton(posture: HandPosture): HandSkeleton {
  const dir = posture.hand === "RH" ? 1 : -1;
  const palmCenterX = posture.palmCenterXUnit * PIANO_WHITE_KEY_W;
  const knuckleBaseY = PIANO_KNUCKLE_BASE_Y + posture.palmLiftY;

  const fingerSpanPx = Math.abs(posture.fingers[5].xUnit - posture.fingers[1].xUnit) * PIANO_WHITE_KEY_W;
  const abductRatio = clamp((fingerSpanPx - 90) / 90, -0.12, 0.32);

  const angleRad = (posture.palmAngleDeg * Math.PI) / 180;
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);

  const toWorld = (dx: number, dy: number): Point2D => ({
    x: palmCenterX + dx * cosA - dy * sinA,
    y: knuckleBaseY + dx * sinA + dy * cosA,
  });

  // Carpal roots at wrist arch (metacarpal proximal bases)
  const carpalRoots: Record<Finger, Point2D> = {
    1: toWorld((-17 - abductRatio * 4) * dir, 39),
    2: toWorld(-10 * dir, 42),
    3: toWorld(0, 43),
    4: toWorld(9 * dir, 42),
    5: toWorld((17 + abductRatio * 3) * dir, 40),
  };

  // Anatomical MCP knuckle arch (3 highest, 2/4 slightly lower, 5 lower on ulnar slope, 1 lower on radial side)
  const mcps: Record<Finger, Point2D> = {
    1: toWorld((-28 - abductRatio * 12) * dir, 14),
    2: toWorld((-17 - abductRatio * 4) * dir, 3),
    3: toWorld(0, 0),
    4: toWorld((16 + abductRatio * 4) * dir, 4),
    5: toWorld((31 + abductRatio * 10) * dir, 12),
  };

  // Organic palm silhouette landmarks
  const wristThumb = toWorld(-22 * dir, 51);
  const wristMid = toWorld(0, 54);
  const wristPinky = toWorld(21 * dir, 50);
  const thenarOuter = toWorld((-33 - abductRatio * 10) * dir, 29);
  const thumbSaddle = toWorld((-23 - abductRatio * 6) * dir, 11);
  const radialMcp1 = toWorld((-32 - abductRatio * 12) * dir, 15);
  const radialMcp2 = toWorld((-22 - abductRatio * 4) * dir, 2);
  const ulnarMcp5 = toWorld((35 + abductRatio * 10) * dir, 13);
  const hypothenarOuter = toWorld((32 + abductRatio * 8) * dir, 31);

  const knuckleCrest23 = toWorld((-8.5 - abductRatio * 2) * dir, -2);
  const knuckleCrest34 = toWorld((8 + abductRatio * 2) * dir, -1.5);
  const knuckleCrest45 = toWorld((24 + abductRatio * 7) * dir, 5);

  const palmPath = [
    `M ${fmt(wristThumb.x)} ${fmt(wristThumb.y)}`,
    `Q ${fmt(thenarOuter.x)} ${fmt(thenarOuter.y)} ${fmt(radialMcp1.x)} ${fmt(radialMcp1.y)}`,
    `Q ${fmt(thumbSaddle.x)} ${fmt(thumbSaddle.y)} ${fmt(radialMcp2.x)} ${fmt(radialMcp2.y)}`,
    `Q ${fmt(knuckleCrest23.x)} ${fmt(knuckleCrest23.y)} ${fmt(mcps[3].x)} ${fmt(mcps[3].y - 3)}`,
    `Q ${fmt(knuckleCrest34.x)} ${fmt(knuckleCrest34.y)} ${fmt(mcps[4].x)} ${fmt(mcps[4].y - 2)}`,
    `Q ${fmt(knuckleCrest45.x)} ${fmt(knuckleCrest45.y)} ${fmt(ulnarMcp5.x)} ${fmt(ulnarMcp5.y)}`,
    `Q ${fmt(hypothenarOuter.x)} ${fmt(hypothenarOuter.y)} ${fmt(wristPinky.x)} ${fmt(wristPinky.y)}`,
    `Q ${fmt(wristMid.x)} ${fmt(wristMid.y)} ${fmt(wristThumb.x)} ${fmt(wristThumb.y)}`,
    "Z",
  ].join(" ");

  const carpalArchPath = [
    `M ${fmt(carpalRoots[1].x)} ${fmt(carpalRoots[1].y)}`,
    `Q ${fmt(carpalRoots[2].x)} ${fmt(carpalRoots[2].y + 2)} ${fmt(carpalRoots[3].x)} ${fmt(carpalRoots[3].y + 2)}`,
    `Q ${fmt(carpalRoots[4].x)} ${fmt(carpalRoots[4].y + 2)} ${fmt(carpalRoots[5].x)} ${fmt(carpalRoots[5].y)}`,
  ].join(" ");

  const fingers = {} as Record<Finger, FingerSkeleton>;

  for (const f of FINGERS) {
    const fp = posture.fingers[f];
    const carpalRoot = carpalRoots[f];
    const mcp = mcps[f];
    const tip = computeFingerTipXY(fp, mcp, posture.palmLiftY);

    const dx = tip.x - mcp.x;
    const dy = tip.y - mcp.y;
    const spanLen = Math.hypot(dx, dy) || 1;
    // Ulnar-oriented unit perpendicular (points toward pinky side for both RH and LH)
    const ux = (-dy / spanLen) * dir;
    const uy = (dx / spanLen) * dir;

    let bendPx = 0;
    if (fp.layerOffset === -1) {
      bendPx = 10;
    } else if (fp.layerOffset === 1) {
      bendPx = -9;
    } else if (f === 1) {
      bendPx = 3.2;
    } else if (f === 5) {
      bendPx = -1.2;
    }

    const [headR, waistR] = PHALANX_RADII[f];
    const metacarpal = makeBone(carpalRoot, mcp, headR * 1.05, waistR * 1.05);
    const metacarpalLength = dist(carpalRoot, mcp);

    const joints: JointNode[] = [];
    const phalanges: BoneSegment[] = [];
    let chain: Point2D[];

    if (f === 1) {
      const ip: Point2D = {
        x: lerp(mcp.x, tip.x, 0.52) + ux * bendPx,
        y: lerp(mcp.y, tip.y, 0.52) + uy * bendPx,
      };
      joints.push(
        { x: carpalRoot.x, y: carpalRoot.y, radius: 2.4, kind: "cmc" },
        { x: mcp.x, y: mcp.y, radius: 3.1, kind: "mcp" },
        { x: ip.x, y: ip.y, radius: 2.5, kind: "ip" }
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
      const mcpR = f === 3 ? 3.1 : f === 5 ? 2.5 : 2.9;
      joints.push(
        { x: mcp.x, y: mcp.y, radius: mcpR, kind: "mcp" },
        { x: pip.x, y: pip.y, radius: mcpR * 0.78, kind: "pip" },
        { x: dip.x, y: dip.y, radius: mcpR * 0.62, kind: "dip" }
      );
      phalanges.push(
        makeBone(mcp, pip, headR, waistR),
        makeBone(pip, dip, headR * 0.88, waistR * 0.88),
        makeBone(dip, tip, headR * 0.76, waistR * 0.76)
      );
      chain = [mcp, pip, dip, tip];
    }

    const totalPhalanxLength = phalanges.reduce((acc, b) => acc + dist(b.from, b.to), 0);
    const [hwStart, hwEnd] = SLEEVE_HALF_WIDTH[f];
    const sleevePath = buildFingerSleevePath(chain, hwStart, hwEnd);

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

  return {
    palmCenter: toWorld(0, 22),
    wristCenter: wristMid,
    palmPath,
    carpalArchPath,
    labelPos: toWorld(0, 28),
    fingers,
  };
}
