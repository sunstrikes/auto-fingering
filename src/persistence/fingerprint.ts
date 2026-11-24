import type { ScoreCoord, ScoreDocument } from "../domain/types";
import { getNoteScoreCoord } from "./scoreCoord";
import { sha256 } from "./sha256";

export interface ScoreIdentity {
  fingerprint: string;
  measureHashes: string[];
}

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
export function computeMeasureHashes(score: ScoreDocument): string[] {
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

/** Array order encodes measureIndex; per-measure hashes also work as a multiset. */
export function getScoreIdentity(score: ScoreDocument): ScoreIdentity {
  const cached = score.measureStructuralMeta?.map((meta) => meta.measureHash);
  const measureHashes = cached?.length === score.measureCount &&
      cached.every((hash): hash is string => hash !== undefined)
    ? cached
    : computeMeasureHashes(score);
  return { fingerprint: sha256(JSON.stringify(measureHashes)), measureHashes };
}

/** Repeated measures count with multiplicity; their positions do not matter. */
export function isSimilarScore(a: readonly string[], b: readonly string[]): boolean {
  if (Math.abs(a.length - b.length) > 2 || a.length === 0 || b.length === 0) return false;
  const counts = new Map<string, number>();
  for (const hash of a) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  let overlap = 0;
  for (const hash of b) {
    const remaining = counts.get(hash) ?? 0;
    if (remaining > 0) {
      overlap++;
      counts.set(hash, remaining - 1);
    }
  }
  const union = a.length + b.length - overlap;
  return overlap * 100 >= union * 85;
}

/** Positional diff for revisions: appending/removing trailing measures is a change. */
export function diffMeasureIndices(previous: readonly string[], next: readonly string[]): number[] {
  const changed: number[] = [];
  for (let index = 0; index < Math.max(previous.length, next.length); index++) {
    if (previous[index] !== next[index]) changed.push(index);
  }
  return changed;
}
