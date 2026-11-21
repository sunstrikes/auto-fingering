import { computeBBox, parseSvgPathSubpaths, type Matrix2D } from "./svgPath";

export type { Matrix2D } from "./svgPath";

const GRID_W = 8;
const GRID_H = 12;

const DIGIT_TEMPLATES: Record<string, string> = {
  "1": "000111001110010000110100000100000001010000000000000101000000000000010100000101000011010011110111",
  "2": "011111100110010111100101101001011110010101000111000111100001110000110001011000111111111111010101",
  "3": "011111101110010110100101111001010000011100111110001111011100010110100011111001011100010101111110",
  "4": "000001100000001000001010000000100011101000101010010010100000000011111011111110110000101000111111",
  "5": "011111110110011001111100010000001111111011111101110001011100010011100011111001111100010111111110",
};

function classifyPointsAsDigit(pts: Array<[number, number]>): string | null {
  const b = computeBBox(pts);
  if (!b || b.height <= 0) return null;

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
  const subpaths = parseSvgPathSubpaths(d, matrix, { interpolate: true });
  if (subpaths.length === 0) return null;

  const allPts = subpaths.flat();
  const totalBounds = computeBBox(allPts);
  if (!totalBounds) return null;

  // Check for hyphenated substitution inside a single multi-subpath <path>
  if (subpaths.length >= 3 && totalBounds.width > totalBounds.height * 0.9) {
    const withBounds = subpaths
      .map((pts) => ({ pts, b: computeBBox(pts) }))
      .filter((sp): sp is { pts: Array<[number, number]>; b: NonNullable<ReturnType<typeof computeBBox>> } => sp.b !== null);
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
