import type { ScoreDocument } from "../domain/types";
import { computeMeasureHashes, type ScoreSkeleton } from "../domain/measureHashes";
import { sha256 } from "../domain/sha256";

export interface ScoreIdentity {
  fingerprint: string;
  measureHashes: string[];
}

/** Array order encodes measureIndex; per-measure hashes also work as a multiset. */
export function getScoreIdentity(score: ScoreSkeleton & Pick<ScoreDocument, "measureStructuralMeta">): ScoreIdentity {
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
