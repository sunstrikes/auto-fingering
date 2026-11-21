import type { BuildPitch } from "./types";
import { classifyFingeringPath, parseFingeringText } from "./fingeringClassifier";

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export interface SvgStaff {
  staffNumber: 1 | 2;
  lineYs: number[];
  topY: number;
  bottomY: number;
  staffSpace: number;
  minX: number;
  maxX: number;
}

export interface SvgClef {
  staff: 1 | 2;
  sign: "G" | "F";
  line: number;
  bbox: BBox;
}

export interface SvgVolta {
  numbers: number[];
  isStart: boolean;
  isStop: boolean;
}

export type SvgNavMarkerKind =
  | "segno"
  | "coda"
  | "fine"
  | "to-coda"
  | "dc"
  | "dc-al-fine"
  | "dc-al-coda"
  | "ds"
  | "ds-al-fine"
  | "ds-al-coda";

export interface SvgNavMarker {
  kind: SvgNavMarkerKind;
  text: string;
  x: number;
  y: number;
}

export interface SvgMeasureRegion {
  measureIndex: number;
  systemIndex: number;
  minX: number;
  maxX: number;
  repeatStart?: boolean;
  repeatStop?: boolean;
  volta?: SvgVolta;
  navMarkers?: SvgNavMarker[];
}

export interface SvgSystem {
  systemIndex: number;
  staves: SvgStaff[];
  clefs: SvgClef[];
  measures: SvgMeasureRegion[];
  minY: number;
  maxY: number;
}

export interface SvgNotehead {
  id: number;
  systemIndex: number;
  measureIndex: number;
  staff: 1 | 2;
  cx: number;
  cy: number;
  bbox: BBox;
  step: BuildPitch["step"];
  octave: number;
  stemId: number | null;
  stemDir: "up" | "down" | null;
  beamGroupId: number | null;
  isGrace: boolean;
}

export interface SvgStem {
  id: number;
  systemIndex: number;
  measureIndex: number;
  x: number;
  minY: number;
  maxY: number;
  direction: "up" | "down" | null;
  beamGroupId: number | null;
}

export interface SvgBeam {
  id: number;
  systemIndex: number;
  bbox: BBox;
  beamGroupId: number | null;
}

export interface SvgRest {
  id: number;
  systemIndex: number;
  measureIndex: number;
  staff: 1 | 2;
  cx: number;
  cy: number;
  bbox: BBox;
}

export interface SvgArc {
  id: number;
  kind: "tie" | "slur";
  systemIndex: number;
  staff: 1 | 2;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  bbox: BBox;
}

export interface SvgFingering {
  id: number;
  systemIndex: number;
  measureIndex: number;
  staff: 1 | 2;
  cx: number;
  cy: number;
  bbox: BBox;
  value: string;
}

export interface SvgArpeggio {
  id: number;
  systemIndex: number;
  measureIndex: number;
  cx: number;
  minY: number;
  maxY: number;
  bbox: BBox;
}

export interface ParsedSvgPage {
  pageIndex: number;
  viewBox: { x: number; y: number; width: number; height: number };
  systems: SvgSystem[];
  noteheads: SvgNotehead[];
  stems: SvgStem[];
  beams: SvgBeam[];
  rests: SvgRest[];
  arcs: SvgArc[];
  fingerings: SvgFingering[];
  arpeggios: SvgArpeggio[];
  keySigCount: number;
  timeSigCount: number;
}

type Matrix2D = [number, number, number, number, number, number];

const IDENTITY_MATRIX: Matrix2D = [1, 0, 0, 1, 0, 0];

function multiplyMatrix(m1: Matrix2D, m2: Matrix2D): Matrix2D {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function applyMatrix(m: Matrix2D, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function parseTransformAttr(attr: string | undefined): Matrix2D {
  if (!attr) return IDENTITY_MATRIX;
  let result: Matrix2D = IDENTITY_MATRIX;
  const fnRegex = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = fnRegex.exec(attr)) !== null) {
    const fn = match[1];
    const args = (match[2].match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    let m: Matrix2D = IDENTITY_MATRIX;
    if (fn === "matrix" && args.length >= 6) {
      m = [args[0], args[1], args[2], args[3], args[4], args[5]];
    } else if (fn === "translate" && args.length >= 1) {
      m = [1, 0, 0, 1, args[0], args[1] ?? 0];
    } else if (fn === "scale" && args.length >= 1) {
      const sx = args[0];
      const sy = args[1] ?? sx;
      m = [sx, 0, 0, sy, 0, 0];
    } else if (fn === "rotate" && args.length >= 1) {
      const rad = (args[0] * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      if (args.length >= 3) {
        const cx = args[1];
        const cy = args[2];
        m = multiplyMatrix(
          [1, 0, 0, 1, cx, cy],
          multiplyMatrix([cos, sin, -sin, cos, 0, 0], [1, 0, 0, 1, -cx, -cy])
        );
      } else {
        m = [cos, sin, -sin, cos, 0, 0];
      }
    } else if (fn === "skewX" && args.length >= 1) {
      m = [1, 0, Math.tan((args[0] * Math.PI) / 180), 1, 0, 0];
    } else if (fn === "skewY" && args.length >= 1) {
      m = [1, Math.tan((args[0] * Math.PI) / 180), 0, 1, 0, 0];
    }
    result = multiplyMatrix(result, m);
  }
  return result;
}

interface RawSvgShape {
  tag: string;
  classes: Set<string>;
  matrix: Matrix2D;
  attrs: Record<string, string>;
  points: Array<[number, number]>;
  bbox: BBox;
  textContent?: string;
}

function parseAttributes(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(attrStr)) !== null) {
    attrs[m[1]] = m[2] ?? m[3] ?? "";
  }
  return attrs;
}

function extractPathPoints(d: string, matrix: Matrix2D): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const cmds = d.match(/[a-zA-Z][^a-zA-Z]*/g);
  if (!cmds) return pts;

  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;

  const push = (x: number, y: number) => {
    pts.push(applyMatrix(matrix, x, y));
  };

  for (const cmd of cmds) {
    const op = cmd[0];
    const args = (cmd.slice(1).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);

    switch (op) {
      case "M":
        for (let i = 0; i + 1 < args.length; i += 2) {
          cx = args[i];
          cy = args[i + 1];
          if (i === 0) {
            startX = cx;
            startY = cy;
          }
          push(cx, cy);
        }
        break;
      case "m":
        for (let i = 0; i + 1 < args.length; i += 2) {
          cx += args[i];
          cy += args[i + 1];
          if (i === 0) {
            startX = cx;
            startY = cy;
          }
          push(cx, cy);
        }
        break;
      case "L":
        for (let i = 0; i + 1 < args.length; i += 2) {
          cx = args[i];
          cy = args[i + 1];
          push(cx, cy);
        }
        break;
      case "l":
        for (let i = 0; i + 1 < args.length; i += 2) {
          cx += args[i];
          cy += args[i + 1];
          push(cx, cy);
        }
        break;
      case "H":
        for (const x of args) {
          cx = x;
          push(cx, cy);
        }
        break;
      case "h":
        for (const dx of args) {
          cx += dx;
          push(cx, cy);
        }
        break;
      case "V":
        for (const y of args) {
          cy = y;
          push(cx, cy);
        }
        break;
      case "v":
        for (const dy of args) {
          cy += dy;
          push(cx, cy);
        }
        break;
      case "C":
        for (let i = 0; i + 5 < args.length; i += 6) {
          push(args[i], args[i + 1]);
          push(args[i + 2], args[i + 3]);
          cx = args[i + 4];
          cy = args[i + 5];
          push(cx, cy);
        }
        break;
      case "c":
        for (let i = 0; i + 5 < args.length; i += 6) {
          push(cx + args[i], cy + args[i + 1]);
          push(cx + args[i + 2], cy + args[i + 3]);
          cx += args[i + 4];
          cy += args[i + 5];
          push(cx, cy);
        }
        break;
      case "S":
        for (let i = 0; i + 3 < args.length; i += 4) {
          push(args[i], args[i + 1]);
          cx = args[i + 2];
          cy = args[i + 3];
          push(cx, cy);
        }
        break;
      case "s":
        for (let i = 0; i + 3 < args.length; i += 4) {
          push(cx + args[i], cy + args[i + 1]);
          cx += args[i + 2];
          cy += args[i + 3];
          push(cx, cy);
        }
        break;
      case "Q":
        for (let i = 0; i + 3 < args.length; i += 4) {
          push(args[i], args[i + 1]);
          cx = args[i + 2];
          cy = args[i + 3];
          push(cx, cy);
        }
        break;
      case "q":
        for (let i = 0; i + 3 < args.length; i += 4) {
          push(cx + args[i], cy + args[i + 1]);
          cx += args[i + 2];
          cy += args[i + 3];
          push(cx, cy);
        }
        break;
      case "T":
        for (let i = 0; i + 1 < args.length; i += 2) {
          cx = args[i];
          cy = args[i + 1];
          push(cx, cy);
        }
        break;
      case "t":
        for (let i = 0; i + 1 < args.length; i += 2) {
          cx += args[i];
          cy += args[i + 1];
          push(cx, cy);
        }
        break;
      case "A":
        for (let i = 0; i + 6 < args.length; i += 7) {
          cx = args[i + 5];
          cy = args[i + 6];
          push(cx, cy);
        }
        break;
      case "a":
        for (let i = 0; i + 6 < args.length; i += 7) {
          cx += args[i + 5];
          cy += args[i + 6];
          push(cx, cy);
        }
        break;
      case "Z":
      case "z":
        cx = startX;
        cy = startY;
        break;
    }
  }
  return pts;
}

function computeBBox(pts: Array<[number, number]>): BBox | null {
  if (pts.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function scanSvgShapes(svgText: string): {
  viewBox: { x: number; y: number; width: number; height: number };
  shapes: RawSvgShape[];
} {
  let viewBox = { x: 0, y: 0, width: 9924, height: 14028 };
  const shapes: RawSvgShape[] = [];
  const matrixStack: Matrix2D[] = [IDENTITY_MATRIX];

  // Strip comments and processing instructions
  const cleaned = svgText
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "");

  const tagRegex = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^>]*?)?)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(cleaned)) !== null) {
    const isClose = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrStr = m[3] ?? "";
    const isSelfClosing = m[4] === "/";

    if (isClose) {
      if (matrixStack.length > 1) {
        matrixStack.pop();
      }
      continue;
    }

    const attrs = parseAttributes(attrStr);
    const parentMatrix = matrixStack[matrixStack.length - 1];
    const localMatrix = parseTransformAttr(attrs.transform);
    const currentMatrix = multiplyMatrix(parentMatrix, localMatrix);

    if (tag === "svg" && attrs.viewBox) {
      const vb = (attrs.viewBox.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
      if (vb.length >= 4) {
        viewBox = { x: vb[0], y: vb[1], width: vb[2], height: vb[3] };
      }
    }

    if (!isSelfClosing) {
      matrixStack.push(currentMatrix);
    }

    if (tag === "text" && !isSelfClosing) {
      const closeIdx = cleaned.indexOf("</text>", tagRegex.lastIndex);
      const rawInner = closeIdx !== -1 ? cleaned.slice(tagRegex.lastIndex, closeIdx) : "";
      const textContent = rawInner.replace(/<[^>]*>/g, "").trim();
      const x = Number(attrs.x ?? 0);
      const y = Number(attrs.y ?? 0);
      const fontSize = Number(attrs["font-size"] ?? 14) || 14;
      const pts: Array<[number, number]> = [
        applyMatrix(currentMatrix, x, y - fontSize),
        applyMatrix(currentMatrix, x + fontSize * Math.max(0.6, textContent.length * 0.55), y),
      ];
      const bbox = computeBBox(pts);
      if (closeIdx !== -1 && bbox) {
        const classes = new Set(
          (attrs.class ?? "")
            .trim()
            .split(/\s+/)
            .filter(Boolean)
        );
        shapes.push({
          tag,
          classes,
          matrix: currentMatrix,
          attrs,
          points: pts,
          bbox,
          textContent: textContent || undefined,
        });
      }
      continue;
    }

    if (tag === "polyline" || tag === "polygon" || tag === "line" || tag === "rect" || tag === "path") {
      let pts: Array<[number, number]> = [];
      if (tag === "polyline" || tag === "polygon") {
        const nums = (attrs.points?.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
        for (let i = 0; i + 1 < nums.length; i += 2) {
          pts.push(applyMatrix(currentMatrix, nums[i], nums[i + 1]));
        }
      } else if (tag === "line") {
        const x1 = Number(attrs.x1 ?? 0);
        const y1 = Number(attrs.y1 ?? 0);
        const x2 = Number(attrs.x2 ?? 0);
        const y2 = Number(attrs.y2 ?? 0);
        pts = [applyMatrix(currentMatrix, x1, y1), applyMatrix(currentMatrix, x2, y2)];
      } else if (tag === "rect") {
        const x = Number(attrs.x ?? 0);
        const y = Number(attrs.y ?? 0);
        const w = Number(attrs.width ?? 0);
        const h = Number(attrs.height ?? 0);
        pts = [
          applyMatrix(currentMatrix, x, y),
          applyMatrix(currentMatrix, x + w, y),
          applyMatrix(currentMatrix, x + w, y + h),
          applyMatrix(currentMatrix, x, y + h),
        ];
      } else if (tag === "path" && attrs.d) {
        pts = extractPathPoints(attrs.d, currentMatrix);
      }

      const bbox = computeBBox(pts);
      if (!bbox) continue;

      const classes = new Set(
        (attrs.class ?? "")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
      );

      shapes.push({
        tag,
        classes,
        matrix: currentMatrix,
        attrs,
        points: pts,
        bbox,
      });
    }
  }

  return { viewBox, shapes };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const DIATONIC_STEPS: BuildPitch["step"][] = ["C", "D", "E", "F", "G", "A", "B"];

function topLineDiatonicIndex(clefSign: "G" | "F"): number {
  // Treble G-clef: top line is F5 (5 * 7 + 3 = 38)
  // Bass F-clef: top line is A3 (3 * 7 + 5 = 26)
  return clefSign === "G" ? 38 : 26;
}

function cyToDiatonicPitch(
  cy: number,
  staff: SvgStaff,
  clefSign: "G" | "F"
): { step: BuildPitch["step"]; octave: number } {
  const halfSpace = staff.staffSpace / 2;
  const stepsDown = Math.round((cy - staff.topY) / halfSpace);
  const idx = topLineDiatonicIndex(clefSign) - stepsDown;
  const octave = Math.floor(idx / 7);
  const step = DIATONIC_STEPS[((idx % 7) + 7) % 7];
  return { step, octave };
}

function buildStavesAndSystems(
  shapes: RawSvgShape[],
  viewBoxWidth: number
): {
  systems: SvgSystem[];
  staffLineShapes: Set<RawSvgShape>;
} {
  let lineShapes = shapes.filter((s) => s.classes.has("StaffLines"));
  if (lineShapes.length === 0) {
    // Geometric fallback: horizontal lines spanning >= 20% of page width
    lineShapes = shapes.filter(
      (s) =>
        (s.tag === "polyline" || s.tag === "line" || s.tag === "path") &&
        s.bbox.height <= 4 &&
        s.bbox.width >= viewBoxWidth * 0.2
    );
  }

  const staffLineShapes = new Set(lineShapes);
  const sortedLines = [...lineShapes].sort((a, b) => a.bbox.cy - b.bbox.cy);

  // Group consecutive 5 lines with consistent spacing and overlapping x-range
  const rawStaves: SvgStaff[] = [];
  for (let i = 0; i + 4 < sortedLines.length; ) {
    const group = sortedLines.slice(i, i + 5);
    const diffs = [
      group[1].bbox.cy - group[0].bbox.cy,
      group[2].bbox.cy - group[1].bbox.cy,
      group[3].bbox.cy - group[2].bbox.cy,
      group[4].bbox.cy - group[3].bbox.cy,
    ];
    const med = median(diffs);
    const consistent =
      med > 2 &&
      diffs.every((d) => Math.abs(d - med) <= Math.max(4, med * 0.25)) &&
      group.every((g) => Math.abs(g.bbox.minX - group[0].bbox.minX) <= med * 2);

    if (consistent) {
      const lineYs = group.map((g) => g.bbox.cy);
      rawStaves.push({
        staffNumber: 1,
        lineYs,
        topY: lineYs[0],
        bottomY: lineYs[4],
        staffSpace: med,
        minX: Math.min(...group.map((g) => g.bbox.minX)),
        maxX: Math.max(...group.map((g) => g.bbox.maxX)),
      });
      i += 5;
    } else {
      i += 1;
    }
  }

  // Group staves into systems (vertical gap < 12 * staffSpace)
  const systems: SvgSystem[] = [];
  let currentStaves: SvgStaff[] = [];
  for (const staff of rawStaves) {
    if (currentStaves.length === 0) {
      currentStaves.push(staff);
    } else {
      const prev = currentStaves[currentStaves.length - 1];
      const gap = staff.topY - prev.bottomY;
      if (gap < prev.staffSpace * 12 && currentStaves.length < 2) {
        staff.staffNumber = 2;
        currentStaves.push(staff);
      } else {
        systems.push({
          systemIndex: systems.length,
          staves: currentStaves,
          clefs: [],
          measures: [],
          minY: currentStaves[0].topY,
          maxY: currentStaves[currentStaves.length - 1].bottomY,
        });
        staff.staffNumber = 1;
        currentStaves = [staff];
      }
    }
  }
  if (currentStaves.length > 0) {
    systems.push({
      systemIndex: systems.length,
      staves: currentStaves,
      clefs: [],
      measures: [],
      minY: currentStaves[0].topY,
      maxY: currentStaves[currentStaves.length - 1].bottomY,
    });
  }

  return { systems, staffLineShapes };
}

function findNearestSystemIndex(cy: number, systems: SvgSystem[]): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < systems.length; i++) {
    const sys = systems[i];
    const dist = cy < sys.minY ? sys.minY - cy : cy > sys.maxY ? cy - sys.maxY : 0;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function findNearestStaff(cy: number, sys: SvgSystem): SvgStaff {
  let best = sys.staves[0];
  let bestDist = Infinity;
  for (const s of sys.staves) {
    const dist = cy < s.topY ? s.topY - cy : cy > s.bottomY ? cy - s.bottomY : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

interface BarlineCluster {
  minX: number;
  maxX: number;
  cx: number;
  hasForwardRepeat: boolean;
  hasBackwardRepeat: boolean;
}

function assignMeasuresFromBarlines(shapes: RawSvgShape[], systems: SvgSystem[]): Set<RawSvgShape> {
  const usedBarlines = new Set<RawSvgShape>();
  const semanticBars = shapes.filter((s) => s.classes.has("BarLine") && s.tag === "polyline");
  const semanticDots = shapes.filter((s) => s.classes.has("BarLine") && s.tag === "path");

  // Pre-collect note/rest shapes to detect empty clef/key/time header regions before a forward repeat
  const noteOrRestShapes = shapes.filter(
    (s) => s.classes.has("Note") || s.classes.has("Rest")
  );

  for (const sys of systems) {
    const ss = sys.staves[0]?.staffSpace ?? 80;
    const minStaffX = Math.min(...sys.staves.map((s) => s.minX));
    const maxStaffX = Math.max(...sys.staves.map((s) => s.maxX));

    let sysBars = semanticBars.filter(
      (b) => b.bbox.maxY >= sys.minY - ss && b.bbox.minY <= sys.maxY + ss
    );

    if (sysBars.length === 0) {
      // Geometric fallback: vertical lines spanning exact staff top-to-bottom (or system-spanning)
      sysBars = shapes.filter(
        (s) =>
          (s.tag === "polyline" || s.tag === "line") &&
          s.bbox.width <= ss * 0.25 &&
          s.bbox.height >= ss * 3.8 &&
          s.bbox.maxY >= sys.minY - ss &&
          s.bbox.minY <= sys.maxY + ss &&
          sys.staves.some(
            (st) =>
              Math.abs(s.bbox.minY - st.topY) <= ss * 0.2 &&
              (Math.abs(s.bbox.maxY - st.bottomY) <= ss * 0.2 ||
                Math.abs(s.bbox.maxY - sys.maxY) <= ss * 0.2 ||
                s.bbox.maxY >= sys.staves[sys.staves.length - 1].topY - ss * 0.2)
          )
      );
    }

    for (const b of sysBars) usedBarlines.add(b);

    // Repeat dots (semantic .BarLine path or small circular path inside staff)
    let sysDots = semanticDots.filter(
      (d) =>
        d.bbox.maxY >= sys.minY - ss &&
        d.bbox.minY <= sys.maxY + ss &&
        d.bbox.width <= ss * 0.75 &&
        d.bbox.height <= ss * 0.75
    );
    if (sysDots.length === 0 && semanticBars.length === 0) {
      sysDots = shapes.filter(
        (s) =>
          s.tag === "path" &&
          s.bbox.width >= ss * 0.2 &&
          s.bbox.width <= ss * 0.65 &&
          s.bbox.height >= ss * 0.2 &&
          s.bbox.height <= ss * 0.65 &&
          Math.abs(s.bbox.width - s.bbox.height) <= ss * 0.15 &&
          sys.staves.some((st) => s.bbox.cy >= st.topY + ss && s.bbox.cy <= st.bottomY - ss)
      );
    }
    for (const d of sysDots) usedBarlines.add(d);

    const sortedBars = [...sysBars].sort((a, b) => a.bbox.cx - b.bbox.cx);
    // Cluster double/repeat barline strokes within 0.85 * staffSpace
    const clusters: BarlineCluster[] = [];
    for (const b of sortedBars) {
      const last = clusters[clusters.length - 1];
      if (last && b.bbox.cx - last.maxX <= ss * 0.85) {
        last.minX = Math.min(last.minX, b.bbox.cx);
        last.maxX = Math.max(last.maxX, b.bbox.cx);
        last.cx = (last.minX + last.maxX) / 2;
      } else {
        clusters.push({
          minX: b.bbox.cx,
          maxX: b.bbox.cx,
          cx: b.bbox.cx,
          hasForwardRepeat: false,
          hasBackwardRepeat: false,
        });
      }
    }

    // Associate repeat dots with nearest barline cluster
    for (const dot of sysDots) {
      let nearest: BarlineCluster | null = null;
      let bestDist = Infinity;
      for (const cl of clusters) {
        const dist =
          dot.bbox.cx < cl.minX
            ? cl.minX - dot.bbox.cx
            : dot.bbox.cx > cl.maxX
              ? dot.bbox.cx - cl.maxX
              : 0;
        if (dist <= ss * 1.5 && dist < bestDist) {
          bestDist = dist;
          nearest = cl;
        }
      }
      if (nearest) {
        if (dot.bbox.cx > nearest.maxX) {
          nearest.hasForwardRepeat = true;
        } else if (dot.bbox.cx < nearest.minX) {
          nearest.hasBackwardRepeat = true;
        }
      }
    }

    const systemStartCluster = clusters.find((c) => c.cx - minStaffX <= ss * 0.6);
    const dividers = clusters.filter((c) => c.cx - minStaffX > ss * 0.6);

    if (dividers.length === 0) {
      sys.measures.push({
        measureIndex: 0,
        systemIndex: sys.systemIndex,
        minX: minStaffX,
        maxX: maxStaffX,
        ...(systemStartCluster?.hasForwardRepeat ? { repeatStart: true } : {}),
      });
      continue;
    }

    // Check if the first divider is a forward repeat after an empty clef/key/time header
    let startIdx = 0;
    let prevX = minStaffX;
    let prevCluster: BarlineCluster | undefined = systemStartCluster;

    if (dividers[0].hasForwardRepeat) {
      const hasNotesBeforeFirst = noteOrRestShapes.some(
        (s) =>
          s.bbox.cy >= sys.minY - ss * 3 &&
          s.bbox.cy <= sys.maxY + ss * 3 &&
          s.bbox.cx > minStaffX + ss * 0.5 &&
          s.bbox.cx < dividers[0].minX - ss * 0.2
      );
      if (!hasNotesBeforeFirst) {
        prevX = dividers[0].cx;
        prevCluster = dividers[0];
        startIdx = 1;
      }
    }

    for (let i = startIdx; i < dividers.length; i++) {
      const bar = dividers[i];
      sys.measures.push({
        measureIndex: sys.measures.length,
        systemIndex: sys.systemIndex,
        minX: prevX,
        maxX: bar.cx,
        ...(prevCluster?.hasForwardRepeat ? { repeatStart: true } : {}),
        ...(bar.hasBackwardRepeat ? { repeatStop: true } : {}),
      });
      prevX = bar.cx;
      prevCluster = bar;
    }

    if (maxStaffX - prevX > ss * 2) {
      sys.measures.push({
        measureIndex: sys.measures.length,
        systemIndex: sys.systemIndex,
        minX: prevX,
        maxX: maxStaffX,
        ...(prevCluster?.hasForwardRepeat ? { repeatStart: true } : {}),
      });
    }
  }

  return usedBarlines;
}

function parseVoltaNumbersFromText(text: string): number[] {
  const nums = (text.match(/\d+/g) ?? []).map(Number).filter((n) => n >= 1 && n <= 16);
  return Array.from(new Set(nums));
}

function classifyVoltaPathDigit(shape: RawSvgShape, fallbackIndex: number): number[] {
  const label = shape.textContent ?? shape.attrs["data-text"] ?? shape.attrs["aria-label"];
  if (label) {
    const parsed = parseVoltaNumbersFromText(label);
    if (parsed.length > 0) return parsed;
  }
  const aspect = shape.bbox.height > 0 ? shape.bbox.width / shape.bbox.height : 1;
  if (aspect <= 0.65) return [1];
  if (fallbackIndex === 1) return [2];
  return [fallbackIndex + 1];
}

function classifyNavText(text: string): SvgNavMarkerKind | null {
  const t = text.trim();
  if (!t) return null;
  if (/d\.?\s*c\.?\s*al\s*coda/i.test(t)) return "dc-al-coda";
  if (/d\.?\s*c\.?\s*al\s*fine/i.test(t)) return "dc-al-fine";
  if (/^d\.?\s*c\.?$/i.test(t) || /da\s+capo/i.test(t)) return "dc";
  if (/d\.?\s*s\.?\s*al\s*coda/i.test(t)) return "ds-al-coda";
  if (/d\.?\s*s\.?\s*al\s*fine/i.test(t)) return "ds-al-fine";
  if (/^d\.?\s*s\.?$/i.test(t) || /dal\s+segno/i.test(t)) return "ds";
  if (/to\s+coda/i.test(t)) return "to-coda";
  if (/^fine$/i.test(t)) return "fine";
  if (/^segno$/i.test(t)) return "segno";
  if (/^coda$/i.test(t)) return "coda";
  return null;
}

const DEFAULT_NAV_TEXT: Record<SvgNavMarkerKind, string> = {
  segno: "Segno",
  coda: "Coda",
  fine: "Fine",
  "to-coda": "To Coda",
  dc: "D.C.",
  "dc-al-fine": "D.C. al Fine",
  "dc-al-coda": "D.C. al Coda",
  ds: "D.S.",
  "ds-al-fine": "D.S. al Fine",
  "ds-al-coda": "D.S. al Coda",
};

function assignVoltasAndNavMarkers(shapes: RawSvgShape[], systems: SvgSystem[]): void {
  const voltaLines = shapes.filter(
    (s) => s.classes.has("VoltaSegment") && (s.tag === "polyline" || s.tag === "line")
  );
  const voltaLabels = shapes.filter(
    (s) => s.classes.has("VoltaSegment") && (s.tag === "path" || s.tag === "text")
  );

  for (const sys of systems) {
    const ss = sys.staves[0]?.staffSpace ?? 80;
    const sysBrackets = voltaLines
      .filter(
        (b) =>
          b.bbox.width >= ss * 2 &&
          b.bbox.cy >= sys.minY - ss * 6 &&
          b.bbox.cy <= sys.minY + ss
      )
      .sort((a, b) => a.bbox.minX - b.bbox.minX);

    sysBrackets.forEach((bracket, bIdx) => {
      const matchingLabels = voltaLabels.filter(
        (l) =>
          l.bbox.cx >= bracket.bbox.minX - ss &&
          l.bbox.cx <= bracket.bbox.maxX + ss &&
          Math.abs(l.bbox.cy - bracket.bbox.cy) <= ss * 3
      );

      let numbers: number[] = [];
      if (matchingLabels.length > 0) {
        for (const lbl of matchingLabels) {
          numbers.push(...classifyVoltaPathDigit(lbl, bIdx));
        }
        numbers = Array.from(new Set(numbers)).sort((a, b) => a - b);
      }
      if (numbers.length === 0) {
        numbers = [bIdx + 1];
      }

      const overlapping = sys.measures.filter(
        (m) => Math.min(m.maxX, bracket.bbox.maxX) - Math.max(m.minX, bracket.bbox.minX) > ss * 1.5
      );
      overlapping.forEach((m, idx) => {
        m.volta = {
          numbers,
          isStart: idx === 0,
          isStop: idx === overlapping.length - 1,
        };
      });
    });

    // Navigation markers: Jump, Marker, SystemText, StaffText, Text
    const navCandidates = shapes.filter(
      (s) =>
        (s.classes.has("Jump") ||
          s.classes.has("Marker") ||
          s.classes.has("SystemText") ||
          s.classes.has("StaffText") ||
          s.classes.has("Text")) &&
        s.bbox.cy >= sys.minY - ss * 8 &&
        s.bbox.cy <= sys.maxY + ss * 5
    );

    for (const cand of navCandidates) {
      const rawText =
        cand.textContent ?? cand.attrs["data-text"] ?? cand.attrs["aria-label"] ?? "";
      let kind = classifyNavText(rawText);

      if (!kind && cand.classes.has("Marker") && cand.tag === "path") {
        // Geometric Segno vs Coda fallback for outlined MS4 Marker path
        const aspect = cand.bbox.width > 0 ? cand.bbox.height / cand.bbox.width : 1;
        kind = aspect >= 1.25 ? "segno" : "coda";
      }

      if (!kind) continue;

      const mIdx = findMeasureIndex(cand.bbox.cx, sys);
      const targetMeasure = sys.measures[mIdx];
      if (!targetMeasure) continue;

      const marker: SvgNavMarker = {
        kind,
        text: rawText.trim() || DEFAULT_NAV_TEXT[kind],
        x: cand.bbox.cx,
        y: cand.bbox.cy,
      };
      if (!targetMeasure.navMarkers) {
        targetMeasure.navMarkers = [];
      }
      targetMeasure.navMarkers.push(marker);
    }
  }
}

function assignClefs(shapes: RawSvgShape[], systems: SvgSystem[]): void {
  const clefShapes = shapes.filter((s) => s.classes.has("Clef"));
  for (const sys of systems) {
    for (const staff of sys.staves) {
      const ss = staff.staffSpace;
      const candidates = clefShapes.filter(
        (c) =>
          c.bbox.cy >= staff.topY - ss * 2 &&
          c.bbox.cy <= staff.bottomY + ss * 2 &&
          c.bbox.minX <= staff.minX + ss * 6
      );
      if (candidates.length > 0) {
        const c = candidates[0];
        const heightRatio = c.bbox.height / ss;
        const sign: "G" | "F" = heightRatio >= 4.8 ? "G" : "F";
        sys.clefs.push({
          staff: staff.staffNumber,
          sign,
          line: sign === "G" ? 2 : 4,
          bbox: c.bbox,
        });
      } else {
        const sign: "G" | "F" = staff.staffNumber === 1 ? "G" : "F";
        sys.clefs.push({
          staff: staff.staffNumber,
          sign,
          line: sign === "G" ? 2 : 4,
          bbox: {
            minX: staff.minX,
            minY: staff.topY,
            maxX: staff.minX + ss * 2,
            maxY: staff.bottomY,
            cx: staff.minX + ss,
            cy: (staff.topY + staff.bottomY) / 2,
            width: ss * 2,
            height: staff.bottomY - staff.topY,
          },
        });
      }
    }
  }
}

function findMeasureIndex(cx: number, sys: SvgSystem): number {
  for (const m of sys.measures) {
    if (cx >= m.minX && cx <= m.maxX) return m.measureIndex;
  }
  let best = 0;
  let bestDist = Infinity;
  for (const m of sys.measures) {
    const dist = cx < m.minX ? m.minX - cx : cx - m.maxX;
    if (dist < bestDist) {
      bestDist = dist;
      best = m.measureIndex;
    }
  }
  return best;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/**
 * Semantic-first MuseScore 4 SVG parser with transform matrix flattening,
 * per-staff `staffSpace` calibration, and MS4 geometric fallback when semantic classes are absent.
 */
export function parseMs4Svg(svgText: string, pageIndex = 0): ParsedSvgPage {
  const { viewBox, shapes } = scanSvgShapes(svgText);
  const { systems, staffLineShapes } = buildStavesAndSystems(shapes, viewBox.width);

  if (systems.length === 0) {
    return {
      pageIndex,
      viewBox,
      systems: [],
      noteheads: [],
      stems: [],
      beams: [],
      rests: [],
      arcs: [],
      fingerings: [],
      arpeggios: [],
      keySigCount: 0,
      timeSigCount: 0,
    };
  }

  const usedBarlines = assignMeasuresFromBarlines(shapes, systems);
  assignClefs(shapes, systems);
  assignVoltasAndNavMarkers(shapes, systems);

  const keySigCount = shapes.filter((s) => s.classes.has("KeySig")).length;
  const timeSigCount = shapes.filter((s) => s.classes.has("TimeSig")).length;

  // Noteheads (semantic .Note or geometric fallback)
  let noteShapes = shapes.filter((s) => s.classes.has("Note"));
  if (noteShapes.length === 0) {
    noteShapes = shapes.filter((s) => {
      if (s.tag !== "path" || staffLineShapes.has(s) || usedBarlines.has(s)) return false;
      const sysIdx = findNearestSystemIndex(s.bbox.cy, systems);
      const sys = systems[sysIdx];
      const staff = findNearestStaff(s.bbox.cy, sys);
      const ss = staff.staffSpace;
      return (
        s.bbox.width >= ss * 0.55 &&
        s.bbox.width <= ss * 2.1 &&
        s.bbox.height >= ss * 0.45 &&
        s.bbox.height <= ss * 1.45 &&
        s.bbox.cx >= staff.minX + ss * 2 &&
        s.bbox.cx <= staff.maxX
      );
    });
  }

  // Stems (semantic .Stem or geometric fallback)
  let stemShapes = shapes.filter((s) => s.classes.has("Stem"));
  if (stemShapes.length === 0) {
    stemShapes = shapes.filter((s) => {
      if ((s.tag !== "polyline" && s.tag !== "line") || staffLineShapes.has(s) || usedBarlines.has(s)) {
        return false;
      }
      const sysIdx = findNearestSystemIndex(s.bbox.cy, systems);
      const ss = systems[sysIdx].staves[0]?.staffSpace ?? 80;
      return s.bbox.width <= ss * 0.25 && s.bbox.height >= ss * 1.5 && s.bbox.height <= ss * 14;
    });
  }

  // Beams (semantic .Beam or geometric fallback)
  let beamShapes = shapes.filter((s) => s.classes.has("Beam"));
  if (beamShapes.length === 0) {
    beamShapes = shapes.filter((s) => {
      if (s.tag !== "path" || staffLineShapes.has(s) || usedBarlines.has(s)) return false;
      const sysIdx = findNearestSystemIndex(s.bbox.cy, systems);
      const ss = systems[sysIdx].staves[0]?.staffSpace ?? 80;
      return (
        s.bbox.width >= ss * 1.2 &&
        s.bbox.height >= ss * 0.3 &&
        s.bbox.height <= ss * 2.5 &&
        s.points.length <= 10
      );
    });
  }

  // Rests (semantic .Rest)
  const restShapes = shapes.filter((s) => s.classes.has("Rest"));

  // Ties & Slurs (semantic .TieSegment / .SlurSegment)
  const tieShapes = shapes.filter((s) => s.classes.has("TieSegment"));
  const slurShapes = shapes.filter((s) => s.classes.has("SlurSegment"));

  const stems: SvgStem[] = stemShapes.map((s, id) => {
    const sysIdx = findNearestSystemIndex(s.bbox.cy, systems);
    const sys = systems[sysIdx];
    return {
      id,
      systemIndex: sysIdx,
      measureIndex: findMeasureIndex(s.bbox.cx, sys),
      x: s.bbox.cx,
      minY: s.bbox.minY,
      maxY: s.bbox.maxY,
      direction: null,
      beamGroupId: null,
    };
  });

  const beams: SvgBeam[] = beamShapes.map((s, id) => ({
    id,
    systemIndex: findNearestSystemIndex(s.bbox.cy, systems),
    bbox: s.bbox,
    beamGroupId: null,
  }));

  // Connect stems and beams via Union-Find
  const uf = new UnionFind(stems.length);
  const stemBeamAttached = new Array<boolean>(stems.length).fill(false);

  for (const beam of beams) {
    const ss = systems[beam.systemIndex].staves[0]?.staffSpace ?? 80;
    const attachedStems: number[] = [];
    for (const stem of stems) {
      if (stem.systemIndex !== beam.systemIndex) continue;
      const inX = stem.x >= beam.bbox.minX - ss * 0.35 && stem.x <= beam.bbox.maxX + ss * 0.35;
      if (!inX) continue;
      const topDist = Math.abs(stem.minY - beam.bbox.cy);
      const botDist = Math.abs(stem.maxY - beam.bbox.cy);
      const minDist = Math.min(topDist, botDist);
      const spansBeam = stem.minY <= beam.bbox.maxY + ss * 0.4 && stem.maxY >= beam.bbox.minY - ss * 0.4;
      if (spansBeam && minDist <= beam.bbox.height / 2 + ss * 0.9) {
        attachedStems.push(stem.id);
        stemBeamAttached[stem.id] = true;
      }
    }
    for (let i = 1; i < attachedStems.length; i++) {
      uf.union(attachedStems[0], attachedStems[i]);
    }
    if (attachedStems.length > 0) {
      beam.beamGroupId = uf.find(attachedStems[0]);
    }
  }

  for (const stem of stems) {
    if (stemBeamAttached[stem.id]) {
      stem.beamGroupId = uf.find(stem.id);
    }
  }

  // Build noteheads and associate with stems
  const stemSlashShapes = shapes.filter((s) => s.classes.has("StemSlash"));
  const sortedWidths = noteShapes.map((s) => s.bbox.width).sort((a, b) => a - b);
  const sortedHeights = noteShapes.map((s) => s.bbox.height).sort((a, b) => a - b);
  const refIdx = Math.min(sortedWidths.length - 1, Math.floor(sortedWidths.length * 0.75));
  const refWidth = sortedWidths.length > 0 ? sortedWidths[refIdx] : 0;
  const refHeight = sortedHeights.length > 0 ? sortedHeights[refIdx] : 0;

  const noteheads: SvgNotehead[] = noteShapes.map((s, id) => {
    const sysIdx = findNearestSystemIndex(s.bbox.cy, systems);
    const sys = systems[sysIdx];
    const staff = findNearestStaff(s.bbox.cy, sys);
    const ss = staff.staffSpace;
    const clef = sys.clefs.find((c) => c.staff === staff.staffNumber);
    const { step, octave } = cyToDiatonicPitch(s.bbox.cy, staff, clef?.sign ?? "G");

    // Find matching stem
    let matchedStem: SvgStem | null = null;
    let bestStemDist = Infinity;
    for (const stem of stems) {
      if (stem.systemIndex !== sysIdx) continue;
      const inY = s.bbox.cy >= stem.minY - ss * 0.6 && s.bbox.cy <= stem.maxY + ss * 0.6;
      if (!inY) continue;
      const dx = Math.abs(stem.x - s.bbox.cx);
      if (dx <= ss * 0.9 && dx < bestStemDist) {
        bestStemDist = dx;
        matchedStem = stem;
      }
    }

    let stemDir: "up" | "down" | null = null;
    if (matchedStem) {
      stemDir = matchedStem.x >= s.bbox.cx ? "up" : "down";
      matchedStem.direction = stemDir;
    }

    const hasStemSlash =
      matchedStem !== null &&
      stemSlashShapes.some(
        (sl) =>
          Math.abs(sl.bbox.cx - matchedStem!.x) <= ss * 0.8 &&
          sl.bbox.maxY >= matchedStem!.minY - ss * 0.4 &&
          sl.bbox.minY <= matchedStem!.maxY + ss * 0.4
      );
    const isSmallScale =
      refWidth > 0 &&
      refHeight > 0 &&
      s.bbox.width <= refWidth * 0.82 &&
      s.bbox.height <= refHeight * 0.85;

    return {
      id,
      systemIndex: sysIdx,
      measureIndex: findMeasureIndex(s.bbox.cx, sys),
      staff: staff.staffNumber,
      cx: s.bbox.cx,
      cy: s.bbox.cy,
      bbox: s.bbox,
      step,
      octave,
      stemId: matchedStem ? matchedStem.id : null,
      stemDir,
      beamGroupId: matchedStem ? matchedStem.beamGroupId : null,
      isGrace: isSmallScale || hasStemSlash,
    };
  });

  const rests: SvgRest[] = restShapes.map((s, id) => {
    const sysIdx = findNearestSystemIndex(s.bbox.cy, systems);
    const sys = systems[sysIdx];
    const staff = findNearestStaff(s.bbox.cy, sys);
    return {
      id,
      systemIndex: sysIdx,
      measureIndex: findMeasureIndex(s.bbox.cx, sys),
      staff: staff.staffNumber,
      cx: s.bbox.cx,
      cy: s.bbox.cy,
      bbox: s.bbox,
    };
  });

  const toArc = (s: RawSvgShape, id: number, kind: "tie" | "slur"): SvgArc => {
    const sysIdx = findNearestSystemIndex(s.bbox.cy, systems);
    const sys = systems[sysIdx];
    const staff = findNearestStaff(s.bbox.cy, sys);
    let leftPt = s.points[0] ?? [s.bbox.minX, s.bbox.cy];
    let rightPt = s.points[0] ?? [s.bbox.maxX, s.bbox.cy];
    for (const pt of s.points) {
      if (pt[0] < leftPt[0]) leftPt = pt;
      if (pt[0] > rightPt[0]) rightPt = pt;
    }
    return {
      id,
      kind,
      systemIndex: sysIdx,
      staff: staff.staffNumber,
      startX: leftPt[0],
      startY: leftPt[1],
      endX: rightPt[0],
      endY: rightPt[1],
      bbox: s.bbox,
    };
  };

  const arcs: SvgArc[] = [
    ...tieShapes.map((s, i) => toArc(s, i, "tie")),
    ...slurShapes.map((s, i) => toArc(s, tieShapes.length + i, "slur")),
  ];

  const EXCLUDED_FINGERING_CLASSES = [
    "TimeSig",
    "Tuplet",
    "TupletNumber",
    "MeasureNumber",
    "VoltaSegment",
    "PageNumber",
    "Header",
    "Footer",
    "Dynamic",
    "Lyrics",
  ];
  const fingerings: SvgFingering[] = [];
  for (const s of shapes) {
    if (!s.classes.has("Fingering")) continue;
    if (EXCLUDED_FINGERING_CLASSES.some((c) => s.classes.has(c))) continue;

    let value: string | null = null;
    if (s.tag === "text" && s.textContent !== undefined) {
      value = parseFingeringText(s.textContent);
    } else if (s.tag === "path" && s.attrs.d) {
      value = classifyFingeringPath(s.attrs.d, s.matrix);
    }
    if (!value) continue;

    const sysIdx = findNearestSystemIndex(s.bbox.cy, systems);
    const sys = systems[sysIdx];
    const staff = findNearestStaff(s.bbox.cy, sys);
    fingerings.push({
      id: fingerings.length,
      systemIndex: sysIdx,
      measureIndex: findMeasureIndex(s.bbox.cx, sys),
      staff: staff.staffNumber,
      cx: s.bbox.cx,
      cy: s.bbox.cy,
      bbox: s.bbox,
      value,
    });
  }

  const arpeggios: SvgArpeggio[] = shapes
    .filter((s) => s.classes.has("Arpeggio"))
    .map((s, id) => {
      const sysIdx = findNearestSystemIndex(s.bbox.cy, systems);
      const sys = systems[sysIdx];
      return {
        id,
        systemIndex: sysIdx,
        measureIndex: findMeasureIndex(s.bbox.cx, sys),
        cx: s.bbox.cx,
        minY: s.bbox.minY,
        maxY: s.bbox.maxY,
        bbox: s.bbox,
      };
    });

  return {
    pageIndex,
    viewBox,
    systems,
    noteheads,
    stems,
    beams,
    rests,
    arcs,
    fingerings,
    arpeggios,
    keySigCount,
    timeSigCount,
  };
}
