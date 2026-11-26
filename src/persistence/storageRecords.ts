import type { PracticeStorageRecords, PracticeStore } from "./storagePort";

// Storage is deliberately not a generic application-settings store. Keep even
// JS callers and untrusted backup fields inside the durable record contract.
const fields: { [K in PracticeStore]: readonly (keyof PracticeStorageRecords[K])[] } = {
  meta: ["key", "value"],
  pieceProfiles: [
    "pieceId",
    "title",
    "fingerprints",
    "measureHashesByFingerprint",
    "lastPracticedAtMs",
    "archivedAtMs",
    "bestStableSpeed",
    "chunkOverrides",
    "performanceCueOverrides",
  ],
  practiceEvents: ["eventId", "pieceId", "scoreFingerprint", "timestampMs", "localDateKey", "timezoneOffsetMin",
    "sessionId", "boutKind", "startCoord", "endCoord", "junctionBoundaryCoord", "cueCoord", "practiceMode", "speedMultiplier",
    "durationSec", "passCount", "wasColdFirstPass", "scaffoldingLevel", "ehsLookaheadPreset", "autoGrade",
    "userGradeOverride", "fluency", "acoustic", "measureFaultCounts", "coachTakeaway"],
  derivedSnapshots: ["pieceId", "reducerVersion", "lastEventId", "state"],
  fingerAnchorDrafts: ["pieceId", "anchorsByCoord", "removedRawCoords", "sourceFingeringHash", "updatedAtMs"],
  workspacePrefs: ["scopeKey", "lastOpenedPieceId", "scoreFingerprint", "handSpanProfile", "speedMultiplier", "abLoop",
    "practiceMode", "singleStaffHand", "ignoreExistingFingerings", "absoluteStrictnessEnabled", "strictHoldDurationEnabled",
    "cc64CommandEnabled", "microRestDurationSec", "audiationPreviewMode", "audiationImageryTimerEnabled",
    "overspeedProbeEnabled", "freePracticeMinutes", "repairEdge", "updatedAtMs"],
  scoreBlobs: ["fingerprint", "bytes", "fileName", "byteLength", "lastAccessedAtMs", "sourceFormat", "repairAlternate"],
};

function canPersistField(key: string) {
  if (["__proto__", "constructor", "prototype"].includes(key)) return false;
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  return !/(?:apikey|byok|secret|credential|password|authorization|accesstoken|bearertoken)/.test(normalized);
}

function copyValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return value.slice();
  if (Array.isArray(value)) return value.map(copyValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => canPersistField(key)).map(([key, item]) => [key, copyValue(item)]));
  }
  return value;
}

export function copyStorageRecord<K extends PracticeStore>(store: K, record: PracticeStorageRecords[K]): PracticeStorageRecords[K] {
  if (store === "meta" && !["schemaVersion", "storagePersisted", "lastBackupReminderAtMs"].includes((record as PracticeStorageRecords["meta"]).key)) {
    throw new Error("Unsupported practice storage metadata key");
  }
  const input = record as unknown as Record<string, unknown>;
  const result = Object.fromEntries(fields[store].filter((key) => Object.hasOwn(record, key))
    .map((key) => [key, copyValue(input[String(key)])]));
  if (store === "scoreBlobs" && result.bytes instanceof Uint8Array) {
    result.byteLength = result.bytes.byteLength;
    const alternate = (result as Partial<PracticeStorageRecords["scoreBlobs"]>).repairAlternate;
    if (alternate) alternate.byteLength = alternate.bytes.byteLength;
  }
  return result as unknown as PracticeStorageRecords[K];
}
