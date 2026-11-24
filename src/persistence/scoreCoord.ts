import type { NoteEvent, ScoreCoord, ScoreDocument } from "../domain/types";

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
