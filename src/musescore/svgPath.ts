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

export type Matrix2D = [number, number, number, number, number, number];

export function applyMatrix(m: Matrix2D, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function computeBBox(pts: Array<[number, number]>): BBox | null {
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

export function parseSvgPathSubpaths(
  d: string,
  matrix: Matrix2D,
  options?: { interpolate?: boolean }
): Array<Array<[number, number]>> {
  const cmds = d.match(/[a-zA-Z][^a-zA-Z]*/g);
  if (!cmds) return [];

  const interpolate = options?.interpolate ?? false;
  const subpaths: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;

  const push = (x: number, y: number) => {
    current.push(applyMatrix(matrix, x, y));
  };

  const sampleLine = (nx: number, ny: number) => {
    if (interpolate) {
      for (let t = 0.25; t <= 1; t += 0.25) {
        push(cx + (nx - cx) * t, cy + (ny - cy) * t);
      }
    } else {
      push(nx, ny);
    }
    cx = nx;
    cy = ny;
  };

  const sampleCubic = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    if (interpolate) {
      for (let t = 0.2; t <= 1; t += 0.2) {
        const mt = 1 - t;
        push(
          mt * mt * mt * cx + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3,
          mt * mt * mt * cy + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3
        );
      }
    } else {
      push(x1, y1);
      push(x2, y2);
      push(x3, y3);
    }
    cx = x3;
    cy = y3;
  };

  const sampleQuad = (x1: number, y1: number, x2: number, y2: number) => {
    if (interpolate) {
      for (let t = 0.25; t <= 1; t += 0.25) {
        const mt = 1 - t;
        push(
          mt * mt * cx + 2 * mt * t * x1 + t * t * x2,
          mt * mt * cy + 2 * mt * t * y1 + t * t * y2
        );
      }
    } else {
      push(x1, y1);
      push(x2, y2);
    }
    cx = x2;
    cy = y2;
  };

  for (const cmd of cmds) {
    const op = cmd[0];
    const args = (cmd.slice(1).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);

    switch (op) {
      case "M":
        if (current.length > 0) {
          subpaths.push(current);
          current = [];
        }
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
        if (current.length > 0) {
          subpaths.push(current);
          current = [];
        }
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
        for (let i = 0; i + 1 < args.length; i += 2) sampleLine(args[i], args[i + 1]);
        break;
      case "l":
        for (let i = 0; i + 1 < args.length; i += 2) sampleLine(cx + args[i], cy + args[i + 1]);
        break;
      case "H":
        for (const nx of args) sampleLine(nx, cy);
        break;
      case "h":
        for (const dx of args) sampleLine(cx + dx, cy);
        break;
      case "V":
        for (const ny of args) sampleLine(cx, ny);
        break;
      case "v":
        for (const dy of args) sampleLine(cx, cy + dy);
        break;
      case "C":
        for (let i = 0; i + 5 < args.length; i += 6) {
          sampleCubic(args[i], args[i + 1], args[i + 2], args[i + 3], args[i + 4], args[i + 5]);
        }
        break;
      case "c":
        for (let i = 0; i + 5 < args.length; i += 6) {
          sampleCubic(
            cx + args[i],
            cy + args[i + 1],
            cx + args[i + 2],
            cy + args[i + 3],
            cx + args[i + 4],
            cy + args[i + 5]
          );
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
          sampleQuad(args[i], args[i + 1], args[i + 2], args[i + 3]);
        }
        break;
      case "q":
        for (let i = 0; i + 3 < args.length; i += 4) {
          sampleQuad(cx + args[i], cy + args[i + 1], cx + args[i + 2], cy + args[i + 3]);
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
        if (interpolate) {
          for (let t = 0.25; t <= 1; t += 0.25) {
            push(cx + (startX - cx) * t, cy + (startY - cy) * t);
          }
        }
        cx = startX;
        cy = startY;
        break;
    }
  }
  if (current.length > 0) subpaths.push(current);
  return subpaths;
}

export function extractPathPoints(d: string, matrix: Matrix2D): Array<[number, number]> {
  return parseSvgPathSubpaths(d, matrix, { interpolate: false }).flat();
}
