import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import { createIndexedDbStorage } from "../src/persistence/indexedDbStorage";
import { createPracticeBackup, importPracticeBackup } from "../src/persistence/backupMerge";
import type { PracticeEvent } from "../src/persistence/storagePort";

const piece = {
  pieceId: "etude", title: "Étude", fingerprints: ["original", "revision"],
  measureHashesByFingerprint: { original: ["m1"], revision: ["m2"] },
  lastPracticedAtMs: 120,
};

function event(eventId: string, timestampMs: number): PracticeEvent {
  const coord = { measureIndex: 0, beatNum: 0, beatDen: 1 };
  return {
    eventId, timestampMs, pieceId: piece.pieceId, scoreFingerprint: "original", localDateKey: "2026-11-24",
    timezoneOffsetMin: 0, sessionId: "session", boutKind: "chunk", startCoord: coord, endCoord: coord,
    practiceMode: "both", speedMultiplier: 0.8, durationSec: 30, passCount: 1, wasColdFirstPass: false,
    scaffoldingLevel: 0, autoGrade: 3, fluency: { pitchAccuracy: 1, interiorHesitationCount: 0,
      junctionHesitationRatio: 1, timingCv: 0, stallDetected: false, dominantHandFaultRatio: { rh: 0, lh: 0 },
      switchBranchMismatch: false, reanchorCount: 0 }, measureFaultCounts: {},
  };
}

describe("IndexedDB practice storage", () => {
  it("creates the seven stores, migrates to schema 1 and finds an alias after restart", async () => {
    const indexedDB = new IDBFactory();
    const first = createIndexedDbStorage({ indexedDB });
    await first.commit({ pieceProfiles: [piece] });
    await first.close();
    const second = createIndexedDbStorage({ indexedDB });
    expect(await second.get("meta", "schemaVersion")).toEqual({ key: "schemaVersion", value: 1 });
    expect(await second.findPieceProfiles("revision")).toEqual([piece]);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("auto-fingering-studio");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect([...database.objectStoreNames]).toEqual([
      "derivedSnapshots", "fingerAnchorDrafts", "meta", "pieceProfiles", "practiceEvents",
      "scoreBlobs", "workspacePrefs",
    ]);
    const transaction = database.transaction(["pieceProfiles", "practiceEvents", "scoreBlobs"]);
    expect(transaction.objectStore("pieceProfiles").index("byFingerprint").multiEntry).toBe(true);
    expect(transaction.objectStore("pieceProfiles").index("byLastPracticed").keyPath).toBe("lastPracticedAtMs");
    expect(transaction.objectStore("practiceEvents").index("byPieceTime").keyPath).toEqual(["pieceId", "timestampMs"]);
    expect(transaction.objectStore("scoreBlobs").index("byLastAccessed").keyPath).toBe("lastAccessedAtMs");
    database.close();
    await second.close();
  });
});

it("uses compressed bytes for its LRU cap; reading a score protects it, not durable data", async () => {
  const indexedDB = new IDBFactory();
  const storage = createIndexedDbStorage({ indexedDB, maxScoreBytes: 6, now: () => 10 });
  const blob = (fingerprint: string, lastAccessedAtMs: number) => ({
    fingerprint, lastAccessedAtMs, fileName: `${fingerprint}.mxl`, bytes: new Uint8Array([0x50, 0x4b, 3]), byteLength: 3,
  });
  await storage.commit({ pieceProfiles: [piece], scoreBlobs: [blob("first", 1), blob("second", 2)] });
  await storage.accessScoreBlob("first");
  await storage.commit({ scoreBlobs: [blob("third", 11)] });
  expect((await storage.all("scoreBlobs")).map((row) => row.fingerprint)).toEqual(["first", "third"]);
  expect(await storage.get("pieceProfiles", piece.pieceId)).toEqual(piece);
  await storage.close();
});

it("merges practice events without modifying an existing event and orders them by piece and time", async () => {
  const storage = createIndexedDbStorage({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange });
  const a = event("a", 300);
  const b = event("b", 100);
  await storage.commit({ practiceEvents: [a] });
  await storage.commit({ practiceEvents: [b, { ...a, speedMultiplier: 1.4 }, { ...event("c", 250), pieceId: "another" }] });
  expect(await storage.listPracticeEvents(piece.pieceId)).toEqual([b, a]);
  await storage.close();
});

it("excludes BYOK secrets from storage and versioned backups, with or without the score", async () => {
  const storage = createIndexedDbStorage({ indexedDB: new IDBFactory() });
  const secret = "byok-should-never-be-saved";
  const bytes = new Uint8Array([0x50, 0x4b, 3, 4]);
  await storage.commit({
    pieceProfiles: [piece],
    scoreBlobs: [{ fingerprint: "original", fileName: "Etude.mxl", bytes, byteLength: 4, lastAccessedAtMs: 1 }],
    workspacePrefs: [{ scopeKey: piece.pieceId, speedMultiplier: 0.75, ...{ apiKey: secret } }],
    derivedSnapshots: [{ pieceId: piece.pieceId, reducerVersion: 1, state: { progress: 5, BYOK_API_KEY: secret } }],
  });
  expect(await storage.get("workspacePrefs", piece.pieceId)).toEqual({ scopeKey: piece.pieceId, speedMultiplier: 0.75 });
  expect(await storage.get("derivedSnapshots", piece.pieceId)).toMatchObject({ state: { progress: 5 } });
  expect(JSON.stringify(await storage.all("derivedSnapshots"))).not.toContain(secret);

  const backup = await createPracticeBackup(storage);
  expect(backup.fullBytes).toBeGreaterThan(backup.metadataOnlyBytes);
  expect(backup.fullJson).not.toContain(secret);
  expect(backup.metadataOnlyJson).not.toContain(secret);
  for (const [json, hasScore] of [[backup.fullJson, true], [backup.metadataOnlyJson, false]] as const) {
    const restored = createIndexedDbStorage({ indexedDB: new IDBFactory() });
    await importPracticeBackup(restored, json);
    expect(await restored.findPieceProfiles("original")).toEqual([piece]);
    expect(await restored.get("workspacePrefs", piece.pieceId)).toEqual({ scopeKey: piece.pieceId, speedMultiplier: 0.75 });
    expect((await restored.get("scoreBlobs", "original"))?.bytes).toEqual(hasScore ? bytes : undefined);
    await restored.close();
  }
  await storage.close();
});

it("does not discard resumable scores for a single blob that cannot fit the LRU budget", async () => {
  const storage = createIndexedDbStorage({ indexedDB: new IDBFactory(), maxScoreBytes: 4 });
  const blob = (fingerprint: string, byteLength: number, lastAccessedAtMs: number) => ({
    fingerprint, lastAccessedAtMs, fileName: `${fingerprint}.mxl`, bytes: new Uint8Array(byteLength), byteLength,
  });
  await storage.commit({ scoreBlobs: [blob("resume", 4, 1)] });
  await storage.commit({ scoreBlobs: [blob("oversized", 5, 2)] });
  expect((await storage.all("scoreBlobs")).map((row) => row.fingerprint)).toEqual(["resume"]);
  await storage.close();
});

it("migrates a version-0 data-only backup and rejects a newer backup without mutating data", async () => {
  const storage = createIndexedDbStorage({ indexedDB: new IDBFactory() });
  await importPracticeBackup(storage, JSON.stringify({ schemaVersion: 0, pieceProfiles: [piece] }));
  expect(await storage.findPieceProfiles("revision")).toEqual([piece]);
  await expect(importPracticeBackup(storage, JSON.stringify({ schemaVersion: 100, pieceProfiles: [] })))
    .rejects.toThrow("不支持此备份版本");
  expect(await storage.findPieceProfiles("revision")).toEqual([piece]);
  await storage.close();
});

it.each([
  ["missing aggregate", { fluency: undefined }],
  ["invalid coordinates", { endCoord: { measureIndex: 0, beatNum: 0, beatDen: 0 } }],
  ["invalid measure counts", { measureFaultCounts: { 0: { missed: -1, extra: 0, hesitations: 0 } } }],
])("rejects an immutable event with %s before it can reserve its ID", async (_case, malformed) => {
  const storage = createIndexedDbStorage({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange });
  const good = event("bout", 200);
  const data = (practiceEvents: unknown[]) => JSON.stringify({
    schemaVersion: 1, pieceProfiles: [piece], practiceEvents, fingerAnchorDrafts: [], workspacePrefs: [],
  });
  try {
    await expect(importPracticeBackup(storage, data([{ ...good, ...malformed }]))).rejects.toThrow("备份格式无效");
    expect(await storage.get("pieceProfiles", piece.pieceId)).toBeUndefined();
    await importPracticeBackup(storage, data([good]));
    expect(await storage.listPracticeEvents(piece.pieceId)).toEqual([good]);
  } finally {
    await storage.close();
  }
});


it.each([
  ["IndexedDB", (maxScoreBytes: number) => createIndexedDbStorage({ indexedDB: new IDBFactory(), maxScoreBytes })],
  ["memory", (maxScoreBytes: number) => createInMemoryStorage({ maxScoreBytes })],
])("charges compressed repair alternates to the %s score-cache budget", async (_adapter, createStorage) => {
  const storage = createStorage(6);
  const source = { fileName: "Etude.mxl", bytes: new Uint8Array(3), byteLength: 3 };
  const repairAlternate = { ...source, cacheKey: "old-xml" };
  try {
    await storage.commit({ scoreBlobs: [
      { ...source, fingerprint: "older", lastAccessedAtMs: 1 },
      { ...source, fingerprint: "current", lastAccessedAtMs: 2, repairAlternate },
    ] });
    expect(await storage.get("scoreBlobs", "older")).toBeUndefined();
    expect((await storage.get("scoreBlobs", "current"))?.repairAlternate).toEqual(repairAlternate);

    await storage.commit({ scoreBlobs: [{ ...source, fingerprint: "current", lastAccessedAtMs: 3,
      repairAlternate: { ...repairAlternate, bytes: new Uint8Array(4), byteLength: 4 } }] });
    expect(await storage.get("scoreBlobs", "current")).toEqual({ ...source, fingerprint: "current", lastAccessedAtMs: 3 });
  } finally {
    if ("close" in storage && typeof storage.close === "function") await storage.close();
  }
});
