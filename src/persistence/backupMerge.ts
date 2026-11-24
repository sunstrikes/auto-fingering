import { GLOBAL_WORKSPACE, SCHEMA_VERSION, storeKeyPaths, type FingerAnchorDraft, type PieceProfile,
  type PracticeEvent, type PracticeStoragePort, type PracticeStorageRecords, type ScoreBlob, type WorkspacePrefs } from "./storagePort";
import { copyStorageRecord } from "./storageRecords";

const MAX_BACKUP_SCORE_BYTES = 2 * 1024 * 1024;
const MAX_BACKUP_JSON_LENGTH = 100 * 1024 * 1024;
const backedUpStores = ["pieceProfiles", "practiceEvents", "fingerAnchorDrafts", "workspacePrefs"] as const;
type BackupStore = typeof backedUpStores[number];

interface BackupData {
  schemaVersion: number;
  pieceProfiles: PieceProfile[];
  practiceEvents: PracticeEvent[];
  fingerAnchorDrafts: FingerAnchorDraft[];
  workspacePrefs: WorkspacePrefs[];
  scoreBlobs?: Record<string, Omit<ScoreBlob, "bytes" | "fingerprint"> & { base64: string }>;
}

export interface PracticeBackupExport {
  full: string;
  data: string;
  fullBytes: number;
  dataBytes: number;
  skippedScores: number;
}

function toBase64(bytes: Uint8Array) {
  let value = "";
  for (let i = 0; i < bytes.length; i += 0x2000) {
    value += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  }
  return btoa(value);
}

export async function createPracticeBackup(storage: PracticeStoragePort): Promise<PracticeBackupExport> {
  const [pieceProfiles, practiceEvents, fingerAnchorDrafts, workspacePrefs, blobs] = await Promise.all([
    storage.all("pieceProfiles"), storage.all("practiceEvents"), storage.all("fingerAnchorDrafts"),
    storage.all("workspacePrefs"), storage.all("scoreBlobs"),
  ]);
  const body: BackupData = {
    schemaVersion: SCHEMA_VERSION,
    pieceProfiles: pieceProfiles.map((row) => copyStorageRecord("pieceProfiles", row)),
    practiceEvents: practiceEvents.map((row) => copyStorageRecord("practiceEvents", row)),
    fingerAnchorDrafts: fingerAnchorDrafts.map((row) => copyStorageRecord("fingerAnchorDrafts", row)),
    workspacePrefs: workspacePrefs.map((row) => copyStorageRecord("workspacePrefs", row)),
  };
  const scoreBlobs = Object.fromEntries(blobs.filter((row) => row.bytes.byteLength <= MAX_BACKUP_SCORE_BYTES)
    .map(({ fingerprint, bytes, fileName, lastAccessedAtMs, sourceFormat }) => [fingerprint, {
      fileName, lastAccessedAtMs, sourceFormat, byteLength: bytes.byteLength, base64: toBase64(bytes),
    }]));
  const data = JSON.stringify(body);
  const full = JSON.stringify({ ...body, scoreBlobs });
  const encoder = new TextEncoder();
  return { data, full, dataBytes: encoder.encode(data).byteLength, fullBytes: encoder.encode(full).byteLength,
    skippedScores: blobs.length - Object.keys(scoreBlobs).length };
}

const migrations: readonly ((data: ObjectRecord) => ObjectRecord)[] = [
  (data) => ({ practiceEvents: [], fingerAnchorDrafts: [], workspacePrefs: [], ...data, schemaVersion: 1 }),
];
type ObjectRecord = Record<string, unknown>;
function asObject(value: unknown): ObjectRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("备份格式无效");
  return value as ObjectRecord;
}
function isString(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function isNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isStringList(value: unknown): value is string[] { return Array.isArray(value) && value.every(isString); }
function isAnchor(value: unknown) {
  const anchor = asObject(value);
  return [1, 2, 3, 4, 5].includes(anchor.finger as number) && ["phrase", "pinOnly"].includes(anchor.mode as string);
}
function isDraft(row: ObjectRecord) {
  return isString(row.pieceId) && isString(row.sourceFingeringHash) && isNumber(row.updatedAtMs) &&
    isStringList(row.removedRawCoords) && Object.values(asObject(row.anchorsByCoord)).every(isAnchor);
}
function hasValidPrefs(row: ObjectRecord) {
  const validOptional = (key: string, validate: (value: unknown) => boolean) =>
    row[key] === undefined || validate(row[key]);
  return validOptional("speedMultiplier", isNumber) && validOptional("freePracticeMinutes", isNumber) &&
    validOptional("updatedAtMs", isNumber) && validOptional("lastOpenedPieceId", isString) &&
    validOptional("scoreFingerprint", isString) && validOptional("singleStaffHand", (hand) => hand === "RH" || hand === "LH") &&
    validOptional("practiceMode", (mode) => mode === "both" || mode === "rh-only" || mode === "lh-only") &&
    ["ignoreExistingFingerings", "absoluteStrictnessEnabled", "strictHoldDurationEnabled"].every((key) =>
      validOptional(key, (value) => typeof value === "boolean")) &&
    validOptional("handSpanProfile", (value) => {
      const { preset, avoidThumbOnBlack, preferStablePosition } = asObject(value);
      return (preset === "S" || preset === "M" || preset === "L") &&
        typeof avoidThumbOnBlack === "boolean" && typeof preferStablePosition === "boolean";
    }) && validOptional("abLoop", (value) => {
      const { startMeasureIndex, endMeasureIndex, enabled, loopGap } = asObject(value);
      return isNumber(startMeasureIndex) && isNumber(endMeasureIndex) &&
        typeof enabled === "boolean" && typeof loopGap === "boolean";
    }) && validOptional("repairEdge", (value) => {
      const { direction, otherCacheKey, otherDraft } = asObject(value);
      return (direction === "undo" || direction === "redo") && isString(otherCacheKey) && isDraft(asObject(otherDraft));
    });
}
function parseRecords<K extends BackupStore>(data: ObjectRecord, store: K): PracticeStorageRecords[K][] {
  const records = data[store];
  if (!Array.isArray(records)) throw new Error("备份格式无效");
  return records.map((value) => {
    const row = asObject(value);
    const valid = isString(row[storeKeyPaths[store]]) && (
      store === "pieceProfiles" ? isString(row.title) && isStringList(row.fingerprints) && row.fingerprints.length > 0 &&
        row.fingerprints.every((fingerprint) => isStringList(asObject(row.measureHashesByFingerprint)[fingerprint])) &&
        (row.archivedAtMs === undefined || isNumber(row.archivedAtMs)) :
      store === "practiceEvents" ? isString(row.pieceId) && isString(row.scoreFingerprint) && isNumber(row.timestampMs) :
      store === "fingerAnchorDrafts" ? isDraft(row) : hasValidPrefs(row)
    );
    if (!valid) throw new Error("备份格式无效");
    return copyStorageRecord(store, row as unknown as PracticeStorageRecords[K]);
  });
}

function parseBlobs(rawBlobs: unknown): ScoreBlob[] {
  if (rawBlobs === undefined) return [];
  return Object.entries(asObject(rawBlobs)).map(([fingerprint, value]) => {
    const row = asObject(value);
    if (!isString(row.fileName) || !isString(row.base64) || row.base64.length > Math.ceil(MAX_BACKUP_SCORE_BYTES / 3) * 4 ||
        !isNumber(row.lastAccessedAtMs)) throw new Error("备份内的乐谱格式无效");
    const bytes = Uint8Array.from(atob(row.base64), (char) => char.charCodeAt(0));
    if (bytes.length > MAX_BACKUP_SCORE_BYTES || bytes.byteLength !== row.byteLength || bytes[0] !== 0x50 || bytes[1] !== 0x4b ||
        bytes[2] !== 0x03 || bytes[3] !== 0x04) throw new Error("备份内的乐谱格式无效");
    return {
      fingerprint, bytes, byteLength: bytes.byteLength, fileName: row.fileName, lastAccessedAtMs: row.lastAccessedAtMs,
      ...(row.sourceFormat === "mxl" || row.sourceFormat === "musicxml" ? { sourceFormat: row.sourceFormat } : {}),
    };
  });
}

export async function importPracticeBackup(storage: PracticeStoragePort, json: string): Promise<void> {
  if (json.length > MAX_BACKUP_JSON_LENGTH) throw new Error("备份文件过大");
  let data = asObject(JSON.parse(json));
  const version = data.schemaVersion;
  if (!isNumber(version) || !Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION) {
    throw new Error("不支持此备份版本");
  }
  for (let from = version; from < SCHEMA_VERSION; from++) data = migrations[from](data);
  const profiles = parseRecords(data, "pieceProfiles");
  const events = parseRecords(data, "practiceEvents");
  const drafts = parseRecords(data, "fingerAnchorDrafts");
  const prefs = parseRecords(data, "workspacePrefs");
  const blobs = parseBlobs(data.scoreBlobs);

  // M1 restore/union only. The chronological scheduling projection and its
  // cross-device conflict preview are built on top of this in M3.
  const [localProfiles, localDrafts, localPrefs, localBlobs] = await Promise.all([
    storage.all("pieceProfiles"), storage.all("fingerAnchorDrafts"), storage.all("workspacePrefs"), storage.all("scoreBlobs"),
  ]);
  const profileById = new Map(localProfiles.map((row) => [row.pieceId, row]));
  const localFingerprint = new Map(localProfiles.filter((row) => row.archivedAtMs === undefined)
    .flatMap((row) => row.fingerprints.map((fingerprint) => [fingerprint, row.pieceId] as const)));
  const importedId = new Map<string, string>();
  const changes = new Map<string, PieceProfile>();
  for (const profile of profiles) {
    const existingId = profileById.has(profile.pieceId) ? profile.pieceId : profile.archivedAtMs === undefined
      ? profile.fingerprints.map((fingerprint) => localFingerprint.get(fingerprint)).find(Boolean) : undefined;
    const pieceId = existingId ?? profile.pieceId;
    importedId.set(profile.pieceId, pieceId);
    const existing = changes.get(pieceId) ?? profileById.get(pieceId);
    changes.set(pieceId, existing ? {
      ...existing,
      fingerprints: [...new Set([...existing.fingerprints, ...profile.fingerprints])],
      measureHashesByFingerprint: { ...profile.measureHashesByFingerprint, ...existing.measureHashesByFingerprint },
      ...(profile.lastPracticedAtMs !== undefined ? { lastPracticedAtMs: Math.max(profile.lastPracticedAtMs, existing.lastPracticedAtMs ?? 0) } : {}),
      ...(profile.chunkOverrides && profile.chunkOverrides.updatedAtMs > (existing.chunkOverrides?.updatedAtMs ?? -1)
        ? { chunkOverrides: profile.chunkOverrides } : {}),
    } : { ...profile, pieceId });
  }
  const mapped = (id: string) => importedId.get(id) ?? id;
  const localDraftById = new Map(localDrafts.map((row) => [row.pieceId, row]));
  const localPrefsById = new Map(localPrefs.map((row) => [row.scopeKey, row]));
  const localBlobById = new Map(localBlobs.map((row) => [row.fingerprint, row]));
  const mergedPrefs = prefs.map((row) => ({
    ...row, scopeKey: row.scopeKey === GLOBAL_WORKSPACE ? GLOBAL_WORKSPACE : mapped(row.scopeKey),
    ...(row.lastOpenedPieceId ? { lastOpenedPieceId: mapped(row.lastOpenedPieceId) } : {}),
    ...(row.repairEdge ? { repairEdge: { ...row.repairEdge, otherDraft: {
      ...row.repairEdge.otherDraft, pieceId: mapped(row.repairEdge.otherDraft.pieceId),
    } } } : {}),
  })).filter((row) => (row.updatedAtMs ?? 0) > (localPrefsById.get(row.scopeKey)?.updatedAtMs ?? -1));
  await storage.commit({
    pieceProfiles: [...changes.values()],
    practiceEvents: events.map((row) => ({ ...row, pieceId: mapped(row.pieceId) })),
    fingerAnchorDrafts: drafts.map((row) => ({ ...row, pieceId: mapped(row.pieceId) }))
      .filter((row) => row.updatedAtMs > (localDraftById.get(row.pieceId)?.updatedAtMs ?? -1)),
    workspacePrefs: mergedPrefs,
    scoreBlobs: blobs.filter((row) => row.lastAccessedAtMs > (localBlobById.get(row.fingerprint)?.lastAccessedAtMs ?? -1)),
  });
}
