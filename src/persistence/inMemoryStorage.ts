import {
  SCHEMA_VERSION, scoreCacheLimits, storeKeyPaths, fitScoreBlob, scoreBlobCacheBytes, type PracticeStoragePort, type PracticeStorageRecords,
  type PracticeStore, type ScoreBlob, type ScoreCacheOptions,
} from "./storagePort";
import { copyStorageRecord } from "./storageRecords";

export function createInMemoryStorage(options: ScoreCacheOptions = {}): PracticeStoragePort {
  const records = {
    meta: new Map([["schemaVersion", { key: "schemaVersion", value: SCHEMA_VERSION }]]),
    pieceProfiles: new Map(), practiceEvents: new Map(), derivedSnapshots: new Map(),
    fingerAnchorDrafts: new Map(), workspacePrefs: new Map(), scoreBlobs: new Map(),
  } as { [K in PracticeStore]: Map<string, PracticeStorageRecords[K]> };
  const now = options.now ?? Date.now;
  const { maxCount, maxBytes } = scoreCacheLimits(options);
  return {
    async get<K extends PracticeStore>(store: K, key: string) {
      const record = records[store].get(key);
      return record ? copyStorageRecord(store, record) : undefined;
    },
    async all<K extends PracticeStore>(store: K) {
      return [...records[store].values()].map((record) => copyStorageRecord(store, record));
    },
    async findPieceProfiles(fingerprint) {
      return (await this.all("pieceProfiles")).filter((profile) => profile.fingerprints.includes(fingerprint));
    },
    async listPracticeEvents(pieceId) {
      return (await this.all("practiceEvents")).filter((event) => event.pieceId === pieceId)
        .sort((a, b) => a.timestampMs - b.timestampMs || (a.eventId < b.eventId ? -1 : a.eventId === b.eventId ? 0 : 1));
    },
    async accessScoreBlob(fingerprint) {
      const record = records.scoreBlobs.get(fingerprint);
      if (!record) return undefined;
      const next = { ...record, lastAccessedAtMs: now() };
      records.scoreBlobs.set(fingerprint, next);
      return copyStorageRecord("scoreBlobs", next);
    },
    async commit(write) {
      const writes = (Object.keys(storeKeyPaths) as PracticeStore[]).flatMap((store) =>
        (write[store] ?? []).map((record) => ({ store, record: copyStorageRecord(store, record) })));
      for (const { store, record } of writes) {
        if (store === "scoreBlobs") {
          const blob = maxCount > 0 ? fitScoreBlob(record as ScoreBlob, maxBytes) : undefined;
          if (blob) records.scoreBlobs.set(blob.fingerprint, blob);
          continue;
        }
        const key = (record as unknown as Record<string, string>)[storeKeyPaths[store]];
        if (store === "practiceEvents" && records[store].has(key)) continue;
        (records[store] as Map<string, typeof record>).set(key, record);
      }
      if (!write.scoreBlobs?.length) return;
      const rows = [...records.scoreBlobs.values()].sort((a, b) => a.lastAccessedAtMs - b.lastAccessedAtMs ||
        (a.fingerprint < b.fingerprint ? -1 : 1));
      let bytes = rows.reduce((total, row) => total + scoreBlobCacheBytes(row), 0);
      for (const row of rows) {
        if (records.scoreBlobs.size <= maxCount && bytes <= maxBytes) break;
        records.scoreBlobs.delete(row.fingerprint);
        bytes -= scoreBlobCacheBytes(row);
      }
    },
  };
}
