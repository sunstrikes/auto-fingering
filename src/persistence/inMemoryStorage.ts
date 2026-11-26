import {
  SCHEMA_VERSION, storeKeyPaths, type PracticeStoragePort, type PracticeStorageRecords,
  type PracticeStore, type ScoreCacheOptions,
} from "./storagePort";
import { copyStorageRecord } from "./storageRecords";
import { createScoreCachePolicy } from "./scoreCache";

export function createInMemoryStorage(options: ScoreCacheOptions = {}): PracticeStoragePort {
  const records = {
    meta: new Map([["schemaVersion", { key: "schemaVersion", value: SCHEMA_VERSION }]]),
    pieceProfiles: new Map(), practiceEvents: new Map(), derivedSnapshots: new Map(),
    fingerAnchorDrafts: new Map(), workspacePrefs: new Map(), scoreBlobs: new Map(),
  } as { [K in PracticeStore]: Map<string, PracticeStorageRecords[K]> };
  const now = options.now ?? Date.now;
  const scoreCache = createScoreCachePolicy(options);
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
      const writes = (Object.keys(storeKeyPaths) as PracticeStore[]).flatMap((store) => store === "scoreBlobs" ? [] :
        (write[store] ?? []).map((record) => ({ store, record: copyStorageRecord(store, record) })));
      const blobs = (write.scoreBlobs ?? []).flatMap((record) => scoreCache.prepare(record) ?? []);
      for (const { store, record } of writes) {
        const key = (record as unknown as Record<string, string>)[storeKeyPaths[store]];
        if (store === "practiceEvents" && records[store].has(key)) continue;
        (records[store] as Map<string, typeof record>).set(key, record);
      }
      if (!blobs.length) return;
      for (const blob of blobs) records.scoreBlobs.set(blob.fingerprint, blob);
      for (const key of scoreCache.evictionKeys([...records.scoreBlobs.values()])) records.scoreBlobs.delete(key);
    },
    async applyPracticeEventGradeOverride(eventId, userGradeOverride) {
      if (userGradeOverride !== 2) return;
      const existing = records.practiceEvents.get(eventId);
      if (!existing || existing.userGradeOverride === 2) return;
      records.practiceEvents.set(eventId, copyStorageRecord("practiceEvents", { ...existing, userGradeOverride: 2 }));
    },
  };
}
