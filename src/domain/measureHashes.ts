import type { ScoreCoord, ScoreDocument } from "./types";
import { getNoteScoreCoord } from "./scoreCoord";
import { sha256 } from "./sha256";

export type ScoreSkeleton = Pick<ScoreDocument, "measureCount" | "noteEvents" | "measureTimelines" | "ticksPerQuarter">;

interface Onset {
  coord: ScoreCoord;
  midis: Set<number>;
}

function compareOnsets(a: Onset, b: Onset): number {
  return a.coord.beatNum / a.coord.beatDen - b.coord.beatNum / b.coord.beatDen ||
    a.coord.beatDen - b.coord.beatDen ||
    (a.coord.graceOrder ?? Infinity) - (b.coord.graceOrder ?? Infinity);
}

/** Positional within a measure but deliberately independent of its ordinal. */
export function computeMeasureHashes(score: ScoreSkeleton): string[] {
  const measures = Array.from({ length: score.measureCount }, () => new Map<string, Onset>());
  for (const note of score.noteEvents) {
    // Like the playback slices, a written tie stop is not a new strike.
    if (note.isTieStop) continue;
    const coord = getNoteScoreCoord(score, note);
    const measure = measures[coord.measureIndex];
    if (!measure) continue;
    const key = `${coord.beatNum}/${coord.beatDen}:${coord.graceOrder ?? "m"}`;
    let onset = measure.get(key);
    if (!onset) {
      onset = { coord, midis: new Set() };
      measure.set(key, onset);
    }
    onset.midis.add(note.midi);
  }

  return measures.map((measure) => sha256(JSON.stringify(
    [...measure.values()].sort(compareOnsets).map(({ coord, midis }) => [
      coord.beatNum,
      coord.beatDen,
      coord.graceOrder ?? null,
      [...midis].sort((a, b) => a - b),
    ]),
  )));
}
