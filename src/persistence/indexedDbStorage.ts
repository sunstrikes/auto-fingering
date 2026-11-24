import { copyStorageRecord } from "./storageRecords";
import {
  DATABASE_NAME, SCHEMA_VERSION, storeKeyPaths, scoreCacheLimits, fitScoreBlob, scoreBlobCacheBytes,
  type PracticeStoragePort, type PracticeStorageRecords, type PracticeStore,
  type PracticeStorageWrite, type ScoreBlob, type ScoreCacheOptions,
} from "./storagePort";

export interface IndexedDbStorageOptions extends ScoreCacheOptions {
  indexedDB?: IDBFactory;
  keyRange?: typeof IDBKeyRange;
  name?: string;
}

const migrations: readonly ((db: IDBDatabase, tx: IDBTransaction) => void)[] = [
  (db) => {
    for (const store of Object.keys(storeKeyPaths) as PracticeStore[]) {
      const table = db.createObjectStore(store, { keyPath: storeKeyPaths[store] });
      if (store === "pieceProfiles") {
        table.createIndex("byFingerprint", "fingerprints", { multiEntry: true });
        table.createIndex("byLastPracticed", "lastPracticedAtMs");
      } else if (store === "practiceEvents") {
        table.createIndex("byPieceTime", ["pieceId", "timestampMs"]);
      } else if (store === "scoreBlobs") {
        table.createIndex("byLastAccessed", "lastAccessedAtMs");
      }
    }
  },
];

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, SCHEMA_VERSION);
    request.onupgradeneeded = ({ oldVersion }) => {
      const transaction = request.transaction!;
      for (let from = oldVersion; from < SCHEMA_VERSION; from++) {
        migrations[from](request.result, transaction);
      }
      transaction.objectStore("meta").put({ key: "schemaVersion", value: SCHEMA_VERSION });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

function resultOf<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Practice storage transaction aborted"));
  });
}

export function createIndexedDbStorage(options: IndexedDbStorageOptions = {}): PracticeStoragePort & {
  close(): Promise<void>;
} {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const now = options.now ?? Date.now;
  const { maxCount, maxBytes } = scoreCacheLimits(options);
  let opening: Promise<IDBDatabase> | undefined;
  const database = () => opening ??= openDatabase(factory, options.name ?? DATABASE_NAME);

  const commit = async (write: PracticeStorageWrite) => {
    const batches = (Object.keys(storeKeyPaths) as PracticeStore[]).flatMap((name) => {
      const records = name === "scoreBlobs" ? (maxCount > 0 ? write.scoreBlobs?.flatMap((record) => {
        const blob = fitScoreBlob(copyStorageRecord("scoreBlobs", record), maxBytes);
        return blob ? [blob] : [];
      }) : []) : write[name]?.map((record) => copyStorageRecord(name, record));
      return records?.length ? [{ name, records }] : [];
    });
    if (!batches.length) return;
    const db = await database();
    const tx = db.transaction(batches.map(({ name }) => name), "readwrite");
    const done = completed(tx);
    for (const { name, records } of batches) {
      const store = tx.objectStore(name);
      for (const record of records) {
        if (name === "practiceEvents") {
          // Duplicate imported IDs must never overwrite immutable events or abort the batch.
          const request = store.add(record);
          request.onerror = (event) => {
            if (request.error?.name === "ConstraintError") event.preventDefault();
          };
        } else {
          store.put(record);
        }
      }
      if (name === "scoreBlobs") {
        const request = store.index("byLastAccessed").getAll();
        request.onsuccess = () => {
          const rows = request.result as ScoreBlob[];
          let count = rows.length;
          let bytes = rows.reduce((total, row) => total + scoreBlobCacheBytes(row), 0);
          for (const row of rows) {
            if (count <= maxCount && bytes <= maxBytes) break;
            store.delete(row.fingerprint);
            bytes -= scoreBlobCacheBytes(row);
            count--;
          }
        };
      }
    }
    await done;
  };

  return {
    async get<K extends PracticeStore>(store: K, key: string) {
      const db = await database();
      return resultOf<PracticeStorageRecords[K] | undefined>(db.transaction(store).objectStore(store).get(key));
    },
    async all<K extends PracticeStore>(store: K) {
      const db = await database();
      return resultOf<PracticeStorageRecords[K][]>(db.transaction(store).objectStore(store).getAll());
    },
    async findPieceProfiles(fingerprint) {
      const db = await database();
      return resultOf(db.transaction("pieceProfiles").objectStore("pieceProfiles").index("byFingerprint").getAll(fingerprint));
    },
    async listPracticeEvents(pieceId) {
      const db = await database();
      return resultOf(db.transaction("practiceEvents").objectStore("practiceEvents").index("byPieceTime")
        .getAll((options.keyRange ?? globalThis.IDBKeyRange).bound([pieceId, -Infinity], [pieceId, Infinity])));
    },
    async accessScoreBlob(fingerprint) {
      const db = await database();
      const tx = db.transaction("scoreBlobs", "readwrite");
      const done = completed(tx);
      const store = tx.objectStore("scoreBlobs");
      let blob: ScoreBlob | undefined;
      const request = store.get(fingerprint);
      request.onsuccess = () => {
        const record = request.result as ScoreBlob | undefined;
        if (!record) return;
        blob = { ...record, lastAccessedAtMs: now() };
        store.put(blob);
      };
      await done;
      return blob;
    },
    commit,
    async close() {
      if (opening) (await opening).close();
      opening = undefined;
    },
  };
}
