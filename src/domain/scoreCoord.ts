import type { NoteEvent, ScoreCoord, ScoreDocument } from "./types";

/** Convert an offset in ticks to reduced quarter notes within its measure. */
export function makeScoreCoord(
  measureIndex: number,
  offsetTicks: number,
  ticksPerQuarter: number,
  graceOrder?: number,
): ScoreCoord {
  let a = Math.abs(offsetTicks);
  let b = ticksPerQuarter;
  while (b > 0) {
    [a, b] = [b, a % b];
  }
  const divisor = a || 1;
  return {
    measureIndex,
    beatNum: offsetTicks === 0 ? 0 : offsetTicks / divisor,
    beatDen: ticksPerQuarter / divisor,
    ...(graceOrder === undefined ? {} : { graceOrder }),
  };
}

export function getNoteScoreCoord(
  score: Pick<ScoreDocument, "measureTimelines" | "ticksPerQuarter">,
  note: NoteEvent,
): ScoreCoord {
  if (note.scoreCoord) return note.scoreCoord;
  const startTick = score.measureTimelines[note.measureIndex]?.startTick ?? 0;
  return makeScoreCoord(
    note.measureIndex,
    note.onsetTick - startTick,
    score.ticksPerQuarter,
    note.isGrace ? note.graceOrder ?? 0 : undefined,
  );
}

/**
 * Convert a `ScoreCoord` to an absolute score tick, clamping negative measures to `0`
 * and treating `measureIndex >= scoreDoc.measureCount` as an exclusive end boundary (`+Infinity`).
 */
export function scoreCoordToTick(
  scoreDoc: Pick<ScoreDocument, "measureTimelines" | "ticksPerQuarter" | "measureCount">,
  coord: ScoreCoord,
): number {
  if (coord.measureIndex < 0) return 0;
  if (coord.measureIndex >= scoreDoc.measureCount) {
    return Number.POSITIVE_INFINITY;
  }
  const tl = scoreDoc.measureTimelines[coord.measureIndex];
  if (!tl) return 0;
  return tl.startTick + (coord.beatNum / Math.max(1, coord.beatDen)) * scoreDoc.ticksPerQuarter;
}

/**
 * Convert a `ScoreCoord` to score seconds using `MeasureTimeline` bounds, clamping negative
 * measures to `0` and `measureIndex >= scoreDoc.measureCount` to the final measure's `endSec`.
 */
export function scoreCoordToSec(
  scoreDoc: Pick<ScoreDocument, "measureTimelines" | "measureCount">,
  coord: ScoreCoord,
): number {
  if (coord.measureIndex < 0) return 0;
  if (coord.measureIndex >= scoreDoc.measureCount) {
    const lastTl = scoreDoc.measureTimelines[scoreDoc.measureTimelines.length - 1];
    return lastTl?.endSec ?? 0;
  }
  const tl = scoreDoc.measureTimelines[coord.measureIndex];
  if (!tl) return 0;
  return (
    tl.startSec +
    ((coord.beatNum / Math.max(1, coord.beatDen)) * (tl.endSec - tl.startSec)) /
      Math.max(1, tl.timeBeats)
  );
}
