import type { ScoreBlob, ScoreCacheOptions } from "./storagePort";
import { copyStorageRecord } from "./storageRecords";

const cacheBytes = (blob: ScoreBlob) => blob.byteLength + (blob.repairAlternate?.byteLength ?? 0);

/** Both adapters apply the same admission and eviction rules inside a commit. */
export function createScoreCachePolicy(options: ScoreCacheOptions) {
  const maxCount = options.maxScoreCount ?? 100;
  const maxBytes = options.maxScoreBytes ?? 50 * 1024 * 1024;
  return {
    prepare(record: ScoreBlob): ScoreBlob | undefined {
      if (maxCount <= 0) return undefined;
      const blob = copyStorageRecord("scoreBlobs", record);
      if (blob.byteLength > maxBytes) return undefined;
      if (cacheBytes(blob) <= maxBytes) return blob;
      // Preserve the active revision if its optional alternate cannot also fit.
      const { repairAlternate: _alternate, ...current } = blob;
      return current;
    },
    evictionKeys(rows: readonly ScoreBlob[]): string[] {
      const candidates = [...rows].sort((a, b) => a.lastAccessedAtMs - b.lastAccessedAtMs ||
        (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
      let bytes = candidates.reduce((total, row) => total + cacheBytes(row), 0);
      const keys: string[] = [];
      for (const row of candidates) {
        if (candidates.length - keys.length <= maxCount && bytes <= maxBytes) break;
        keys.push(row.fingerprint);
        bytes -= cacheBytes(row);
      }
      return keys;
    },
  };
}
