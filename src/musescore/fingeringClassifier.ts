export type Matrix2D = [number, number, number, number, number, number];

const GRID_W = 8;
const GRID_H = 12;

const DIGIT_TEMPLATES: Record<string, string> = {
  "1": "000111001110010000110100000100000001010000000000000101000000000000010100000101000011010011110111",
  "2": "011111100110010111100101101001011110010101000111000111100001110000110001011000111111111111010101",
  "3": "011111101110010110100101111001010000011100111110001111011100010110100011111001011100010101111110",
  "4": "000001100000001000001010000000100011101000101010010010100000000011111011111110110000101000111111",
  "5": "011111110110011001111100010000001111111011111101110001011100010011100011111001111100010111111110",
};

function applyMatrix(m: Matrix2D, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function sampleSubpaths(d: string, matrix: Matrix2D): Array<Array<[number, number]>> {
  const cmds = d.match(/[a-zA-Z][^a-zA-Z]*/g);
  if (!cmds) return [];

  const subpaths: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;

  const push = (x: number, y: number) => {
    current.push(applyMatrix(matrix, x, y));
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
            sx = cx;
            sy = cy;
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
            sx = cx;
            sy = cy;
          }
          push(cx, cy);
        }
        break;
      case "L":
        for (let i = 0; i + 1 < args.length; i += 2) {
          const nx = args[i];
          const ny = args[i + 1];
          for (let t = 0.25; t <= 1; t += 0.25) push(cx + (nx - cx) * t, cy + (ny - cy) * t);
          cx = nx;
          cy = ny;
        }
        break;
      case "l":
        for (let i = 0; i + 1 < args.length; i += 2) {
          const nx = cx + args[i];
          const ny = cy + args[i + 1];
          for (let t = 0.25; t <= 1; t += 0.25) push(cx + (nx - cx) * t, cy + (ny - cy) * t);
          cx = nx;
          cy = ny;
        }
        break;
      case "H":
        for (const nx of args) {
          for (let t = 0.25; t <= 1; t += 0.25) push(cx + (nx - cx) * t, cy);
          cx = nx;
        }
        break;
      case "h":
        for (const dx of args) {
          const nx = cx + dx;
          for (let t = 0.25; t <= 1; t += 0.25) push(cx + (nx - cx) * t, cy);
          cx = nx;
        }
        break;
      case "V":
        for (const ny of args) {
          for (let t = 0.25; t <= 1; t += 0.25) push(cx, cy + (ny - cy) * t);
          cy = ny;
        }
        break;
      case "v":
        for (const dy of args) {
          const ny = cy + dy;
          for (let t = 0.25; t <= 1; t += 0.25) push(cx, cy + (ny - cy) * t);
          cy = ny;
        }
        break;
      case "C":
        for (let i = 0; i + 5 < args.length; i += 6) {
          const [x1, y1, x2, y2, x3, y3] = args.slice(i, i + 6);
          for (let t = 0.2; t <= 1; t += 0.2) {
            const mt = 1 - t;
            push(
              mt * mt * mt * cx + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3,
              mt * mt * mt * cy + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3
            );
          }
          cx = x3;
          cy = y3;
        }
        break;
      case "c":
        for (let i = 0; i + 5 < args.length; i += 6) {
          const [x1, y1, x2, y2, x3, y3] = [
            cx + args[i],
            cy + args[i + 1],
            cx + args[i + 2],
            cy + args[i + 3],
            cx + args[i + 4],
            cy + args[i + 5],
          ];
          for (let t = 0.2; t <= 1; t += 0.2) {
            const mt = 1 - t;
            push(
              mt * mt * mt * cx + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3,
              mt * mt * mt * cy + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3
            );
          }
          cx = x3;
          cy = y3;
        }
        break;
      case "Q":
        for (let i = 0; i + 3 < args.length; i += 4) {
          const [x1, y1, x2, y2] = args.slice(i, i + 4);
          for (let t = 0.25; t <= 1; t += 0.25) {
            const mt = 1 - t;
            push(
              mt * mt * cx + 2 * mt * t * x1 + t * t * x2,
              mt * mt * cy + 2 * mt * t * y1 + t * t * y2
            );
          }
          cx = x2;
          cy = y2;
        }
        break;
      case "q":
        for (let i = 0; i + 3 < args.length; i += 4) {
          const [x1, y1, x2, y2] = [cx + args[i], cy + args[i + 1], cx + args[i + 2], cy + args[i + 3]];
          for (let t = 0.25; t <= 1; t += 0.25) {
            const mt = 1 - t;
            push(
              mt * mt * cx + 2 * mt * t * x1 + t * t * x2,
              mt * mt * cy + 2 * mt * t * y1 + t * t * y2
            );
          }
          cx = x2;
          cy = y2;
        }
        break;
      case "Z":
      case "z":
        for (let t = 0.25; t <= 1; t += 0.25) push(cx + (sx - cx) * t, cy + (sy - cy) * t);
        cx = sx;
        cy = sy;
        break;
    }
  }
  if (current.length > 0) subpaths.push(current);
  return subpaths;
}

function pointsBounds(pts: Array<[number, number]>) {
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
    width: maxX - minX,
    height: maxY - minY,
  };
}

function classifyPointsAsDigit(pts: Array<[number, number]>): string | null {
  if (pts.length === 0) return null;
  const b = pointsBounds(pts);
  if (b.height <= 0) return null;

  const grid = new Float64Array(GRID_W * GRID_H);
  for (const [x, y] of pts) {
    const gx = Math.min(GRID_W - 1, Math.max(0, Math.floor(((x - b.minX) / (b.width || 1)) * (GRID_W - 0.01))));
    const gy = Math.min(GRID_H - 1, Math.max(0, Math.floor(((y - b.minY) / (b.height || 1)) * (GRID_H - 0.01))));
    grid[gy * GRID_W + gx] = 1;
  }

  let bestDigit: string | null = null;
  let bestScore = 0;
  for (const [digit, tpl] of Object.entries(DIGIT_TEMPLATES)) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < grid.length; i++) {
      const a = grid[i];
      const t = tpl.charCodeAt(i) === 49 ? 1 : 0;
      dot += a * t;
      na += a * a;
      nb += t * t;
    }
    const score = dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
    if (score > bestScore) {
      bestScore = score;
      bestDigit = digit;
    }
  }

  return bestScore >= 0.45 ? bestDigit : null;
}

/**
 * Validates and normalizes `<text class="Fingering">` content (`1`–`5` or `5-4`).
 * Rejects non-fingering text such as volta endings (`1.`), time signatures, or page numbers.
 */
export function parseFingeringText(raw: string): string | null {
  const m = raw.trim().match(/^([1-5])(?:\s*-\s*([1-5]))?$/);
  if (!m) return null;
  return m[2] ? `${m[1]}-${m[2]}` : m[1];
}

/**
 * Classifies an outlined MS4 `<path class="Fingering">` into `1`–`5` or hyphenated `5-4`.
 */
export function classifyFingeringPath(d: string, matrix: Matrix2D): string | null {
  const subpaths = sampleSubpaths(d, matrix);
  if (subpaths.length === 0) return null;

  const allPts = subpaths.flat();
  const totalBounds = pointsBounds(allPts);

  // Check for hyphenated substitution inside a single multi-subpath <path>
  if (subpaths.length >= 3 && totalBounds.width > totalBounds.height * 0.9) {
    const withBounds = subpaths.map((pts) => ({ pts, b: pointsBounds(pts) }));
    const dash = withBounds.find(
      (sp) =>
        sp.b.height < totalBounds.height * 0.35 &&
        sp.b.cx > totalBounds.minX + totalBounds.width * 0.25 &&
        sp.b.cx < totalBounds.maxX - totalBounds.width * 0.25
    );
    if (dash) {
      const leftPts = withBounds.filter((sp) => sp.b.cx < dash.b.cx).flatMap((sp) => sp.pts);
      const rightPts = withBounds.filter((sp) => sp.b.cx > dash.b.cx).flatMap((sp) => sp.pts);
      const d1 = classifyPointsAsDigit(leftPts);
      const d2 = classifyPointsAsDigit(rightPts);
      if (d1 && d2) return `${d1}-${d2}`;
    }
  }

  return classifyPointsAsDigit(allPts);
}
