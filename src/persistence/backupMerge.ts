import { buildDerivedSnapshot } from "../guided/replayInvalidation";
import { reducePiecePracticeState, sortPracticeEventsChronologically } from "../guided/motorFsrs";
import { isSimilarScore } from "./fingerprint";
import { GLOBAL_WORKSPACE, SCHEMA_VERSION, storeKeyPaths, type FingerAnchorDraft, type PieceProfile,
  type PracticeEvent, type PracticeStoragePort, type PracticeStorageRecords, type ScoreBlob, type ScoreBlobSource, type WorkspacePrefs } from "./storagePort";
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
  scoreBlobs?: Record<string, BackupBlobSource & {
    lastAccessedAtMs: number;
    repairAlternate?: BackupBlobSource & { cacheKey: string };
  }>;
}

type BackupBlobSource = Omit<ScoreBlobSource, "bytes"> & { base64: string };

export interface PracticeBackupExport {
  fullJson: string;
  metadataOnlyJson: string;
  fullBytes: number;
  metadataOnlyBytes: number;
  skippedScores: number;
}

export type BackupConflictKind = "finger-anchor-draft" | "workspace-prefs" | "chunk-overrides";
export type BackupConflictChoice = "keep-local" | "adopt-imported";

export interface BackupConflictItem {
  conflictId: string;
  kind: BackupConflictKind;
  pieceId: string;
  pieceTitle: string;
  scopeKey: string;
  localUpdatedAtMs: number;
  importedUpdatedAtMs: number;
  defaultChoice: BackupConflictChoice;
  localSummary: string;
  importedSummary: string;
}

export interface BackupSimilarityLinkPreview {
  importedPieceId: string;
  importedTitle: string;
  localPieceId: string;
  localTitle: string;
  similarityRatio: number;
}

export interface BackupImportPreview {
  schemaVersion: number;
  importedProfileCount: number;
  newEventCount: number;
  totalEventCountAfterMerge: number;
  conflicts: BackupConflictItem[];
  similarityLinks: BackupSimilarityLinkPreview[];
}

export interface BackupImportResolutions {
  choicesByConflictId?: Record<string, BackupConflictChoice>;
  linkByImportedPieceId?: Record<string, string | null>;
}

function toBase64(bytes: Uint8Array) {
  let value = "";
  for (let i = 0; i < bytes.length; i += 0x2000) {
    value += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  }
  return btoa(value);
}

function encodeBlob({ bytes, fileName, sourceFormat }: ScoreBlobSource): BackupBlobSource {
  return { fileName, sourceFormat, byteLength: bytes.byteLength, base64: toBase64(bytes) };
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
    .map((blob) => [blob.fingerprint, {
      ...encodeBlob(blob), lastAccessedAtMs: blob.lastAccessedAtMs,
      ...(blob.repairAlternate && blob.repairAlternate.bytes.byteLength <= MAX_BACKUP_SCORE_BYTES
        ? { repairAlternate: { ...encodeBlob(blob.repairAlternate), cacheKey: blob.repairAlternate.cacheKey } } : {}),
    }]));
  const metadataOnlyJson = JSON.stringify(body);
  const fullJson = JSON.stringify({ ...body, scoreBlobs });
  const encoder = new TextEncoder();
  return { metadataOnlyJson, fullJson, metadataOnlyBytes: encoder.encode(metadataOnlyJson).byteLength,
    fullBytes: encoder.encode(fullJson).byteLength,
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
const isBoolean = (value: unknown) => typeof value === "boolean";
const isInteger = (value: unknown) => isNumber(value) && Number.isSafeInteger(value);
const isCount = (value: unknown) => isNumber(value) && Number.isSafeInteger(value) && value >= 0;
const isNonnegative = (value: unknown) => isNumber(value) && value >= 0;
const isRatio = (value: unknown) => isNumber(value) && value >= 0 && value <= 1;
const isPracticeMode = (mode: unknown) => mode === "both" || mode === "rh-only" || mode === "lh-only";
const isStatus = (value: unknown) => value === "green" || value === "amber" || value === "red";
const optional = (value: unknown, validate: (value: unknown) => boolean) => value === undefined || validate(value);

function isScoreCoord(value: unknown) {
  const { measureIndex, beatNum, beatDen, graceOrder } = asObject(value);
  return isCount(measureIndex) && isInteger(beatNum) && isNumber(beatDen) &&
    Number.isSafeInteger(beatDen) && beatDen > 0 && optional(graceOrder, isCount);
}

function isChunkOverrides(value: unknown) {
  const row = asObject(value);
  return Array.isArray(row.addedBoundaries) && row.addedBoundaries.every(isScoreCoord) &&
    Array.isArray(row.removedBoundaries) && row.removedBoundaries.every(isScoreCoord) &&
    isNumber(row.updatedAtMs);
}

function isFluency(value: unknown) {
  const row = asObject(value);
  const { rh, lh } = asObject(row.dominantHandFaultRatio);
  return isRatio(row.pitchAccuracy) && isCount(row.interiorHesitationCount) &&
    isNonnegative(row.junctionHesitationRatio) && isNonnegative(row.timingCv) && isBoolean(row.stallDetected) &&
    isRatio(rh) && isRatio(lh) && isBoolean(row.switchBranchMismatch) && isCount(row.reanchorCount);
}

function isAcoustic(value: unknown) {
  const row = asObject(value);
  return isStatus(row.timingEvennessStatus) && isNonnegative(row.timingNormNpvi) &&
    optional(row.worstTimingMeasure, isCount) &&
    (row.secondaryDimension === "voicing" || row.secondaryDimension === "articulation" || row.secondaryDimension === "hidden") &&
    optional(row.voicingDeltaDb, isNumber) && optional(row.melodyRankDominance, isRatio) &&
    optional(row.articulationKor, isNonnegative) &&
    (row.tertiaryDimension === "pedal" || row.tertiaryDimension === "hand-sync" || row.tertiaryDimension === "hidden") &&
    optional(row.pedalClarityRate, isRatio) && optional(row.handSyncStatus, isStatus) &&
    optional(row.bleQuantizationRelaxed, isBoolean);
}

function isPracticeEvent(row: ObjectRecord) {
  return isString(row.pieceId) && isString(row.scoreFingerprint) && isNonnegative(row.timestampMs) &&
    isString(row.localDateKey) && /^\d{4}-\d{2}-\d{2}$/.test(row.localDateKey) && isInteger(row.timezoneOffsetMin) &&
    isString(row.sessionId) && (row.boutKind === "chunk" || row.boutKind === "bridge" || row.boutKind === "cold-probe") &&
    isScoreCoord(row.startCoord) && isScoreCoord(row.endCoord) && optional(row.junctionBoundaryCoord, isScoreCoord) &&
    optional(row.cueCoord, isScoreCoord) && isPracticeMode(row.practiceMode) &&
    isNumber(row.speedMultiplier) && row.speedMultiplier > 0 && isNonnegative(row.durationSec) && isCount(row.passCount) &&
    isBoolean(row.wasColdFirstPass) && (row.scaffoldingLevel === 0 || row.scaffoldingLevel === 1 ||
      row.scaffoldingLevel === 2 || row.scaffoldingLevel === 3) &&
    optional(row.ehsLookaheadPreset, (preset) => preset === "off" || preset === "1-beat" || preset === "2-beats" || preset === "1-bar") &&
    (row.autoGrade === 1 || row.autoGrade === 2 || row.autoGrade === 3 || row.autoGrade === 4) &&
    optional(row.userGradeOverride, (grade) => grade === 2) && isFluency(row.fluency) && optional(row.acoustic, isAcoustic) &&
    Object.entries(asObject(row.measureFaultCounts)).every(([index, value]) => {
      const { missed, extra, hesitations } = asObject(value);
      return /^(0|[1-9]\d*)$/.test(index) && isCount(Number(index)) && isCount(missed) && isCount(extra) && isCount(hesitations);
    }) && optional(row.coachTakeaway, (value) => typeof value === "string");
}

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
    validOptional("practiceMode", isPracticeMode) &&
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
      const { direction, otherFingerprint, alternateCacheKey, otherDraft } = asObject(value);
      return (direction === "undo" || direction === "redo") && isString(otherFingerprint) &&
        optional(alternateCacheKey, (key) => isString(key) && otherFingerprint === row.scoreFingerprint) && isDraft(asObject(otherDraft));
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
        optional(row.lastPracticedAtMs, isNumber) &&
        optional(row.archivedAtMs, isNumber) &&
        optional(row.bestStableSpeed, isNonnegative) &&
        optional(row.chunkOverrides, isChunkOverrides) :
      store === "practiceEvents" ? isPracticeEvent(row) :
      store === "fingerAnchorDrafts" ? isDraft(row) : hasValidPrefs(row)
    );
    if (!valid) throw new Error("备份格式无效");
    return copyStorageRecord(store, row as unknown as PracticeStorageRecords[K]);
  });
}

function decodeBlob(row: ObjectRecord): ScoreBlobSource {
  if (!isString(row.fileName) || !isString(row.base64) || row.base64.length > Math.ceil(MAX_BACKUP_SCORE_BYTES / 3) * 4) {
    throw new Error("备份内的乐谱格式无效");
  }
  const bytes = Uint8Array.from(atob(row.base64), (char) => char.charCodeAt(0));
  if (bytes.length > MAX_BACKUP_SCORE_BYTES || bytes.byteLength !== row.byteLength || bytes[0] !== 0x50 || bytes[1] !== 0x4b ||
      bytes[2] !== 0x03 || bytes[3] !== 0x04) throw new Error("备份内的乐谱格式无效");
  return {
    bytes, byteLength: bytes.byteLength, fileName: row.fileName,
    ...(row.sourceFormat === "mxl" || row.sourceFormat === "musicxml" ? { sourceFormat: row.sourceFormat } : {}),
  };
}

function parseBlobs(rawBlobs: unknown): ScoreBlob[] {
  if (rawBlobs === undefined) return [];
  return Object.entries(asObject(rawBlobs)).map(([fingerprint, value]) => {
    const row = asObject(value);
    if (!isNumber(row.lastAccessedAtMs)) throw new Error("备份内的乐谱格式无效");
    const blob = { ...decodeBlob(row), fingerprint, lastAccessedAtMs: row.lastAccessedAtMs };
    if (row.repairAlternate === undefined) return blob;
    const alternate = asObject(row.repairAlternate);
    if (!isString(alternate.cacheKey)) throw new Error("备份内的乐谱格式无效");
    return { ...blob, repairAlternate: { ...decodeBlob(alternate), cacheKey: alternate.cacheKey } };
  });
}

function parseBackupPayload(json: string) {
  if (json.length > MAX_BACKUP_JSON_LENGTH) throw new Error("备份文件过大");
  let data = asObject(JSON.parse(json));
  const version = data.schemaVersion;
  if (!isNumber(version) || !Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION) {
    throw new Error("不支持此备份版本");
  }
  for (let from = version; from < SCHEMA_VERSION; from++) data = migrations[from](data);
  return {
    version,
    profiles: parseRecords(data, "pieceProfiles"),
    events: parseRecords(data, "practiceEvents"),
    drafts: parseRecords(data, "fingerAnchorDrafts"),
    prefs: parseRecords(data, "workspacePrefs"),
    blobs: parseBlobs(data.scoreBlobs),
  };
}

function measureSimilarityRatio(a: readonly string[], b: readonly string[]): number {
  if (!isSimilarScore(a, b)) return 0;
  const counts = new Map<string, number>();
  for (const hash of a) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  let overlap = 0;
  for (const hash of b) {
    const rem = counts.get(hash) ?? 0;
    if (rem > 0) {
      overlap += 1;
      counts.set(hash, rem - 1);
    }
  }
  const union = a.length + b.length - overlap;
  return union > 0 ? overlap / union : 0;
}

interface ProfileNode {
  key: string;
  source: "local" | "imported";
  profile: PieceProfile;
}

function computeProfileMapping(
  localProfiles: readonly PieceProfile[],
  importedProfiles: readonly PieceProfile[],
  linkByImportedPieceId?: Record<string, string | null>,
) {
  const localById = new Map(localProfiles.map((p) => [p.pieceId, p]));
  const activeLocals = localProfiles.filter((p) => p.archivedAtMs === undefined);
  const activeImported = importedProfiles.filter((p) => p.archivedAtMs === undefined);

  const nodes: ProfileNode[] = [
    ...activeLocals.map((p) => ({ key: `L:${p.pieceId}`, source: "local" as const, profile: p })),
    ...activeImported.map((p) => ({ key: `I:${p.pieceId}`, source: "imported" as const, profile: p })),
  ];
  const parent = new Map(nodes.map((n) => [n.key, n.key]));
  const find = (k: string): string => {
    let cur = k;
    while (parent.get(cur) !== cur) cur = parent.get(cur)!;
    let walker = k;
    while (walker !== cur) {
      const nxt = parent.get(walker)!;
      parent.set(walker, cur);
      walker = nxt;
    }
    return cur;
  };
  const unite = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  // Union by shared pieceId, shared ScoreFingerprint, or explicit similarity link opt-in
  const byPieceId = new Map<string, string>();
  const byFingerprint = new Map<string, string>();
  for (const node of nodes) {
    const idOwner = byPieceId.get(node.profile.pieceId);
    if (idOwner) unite(idOwner, node.key);
    else byPieceId.set(node.profile.pieceId, node.key);

    for (const fp of node.profile.fingerprints) {
      const fpOwner = byFingerprint.get(fp);
      if (fpOwner) unite(fpOwner, node.key);
      else byFingerprint.set(fp, node.key);
    }
  }

  if (linkByImportedPieceId) {
    for (const [impId, locId] of Object.entries(linkByImportedPieceId)) {
      if (!locId) continue;
      const impKey = `I:${impId}`;
      const locKey = `L:${locId}`;
      if (parent.has(impKey) && parent.has(locKey)) {
        unite(locKey, impKey);
      }
    }
  }

  // Group into components
  const groups = new Map<string, ProfileNode[]>();
  for (const node of nodes) {
    const root = find(node.key);
    const arr = groups.get(root);
    if (arr) arr.push(node);
    else groups.set(root, [node]);
  }

  const importedIdToCanonical = new Map<string, string>();
  const localIdToCanonical = new Map<string, string>();
  const componentMap = new Map<string, {
    canonicalPieceId: string;
    locals: PieceProfile[];
    imported: PieceProfile[];
  }>();

  for (const members of groups.values()) {
    const locals = members.filter((m) => m.source === "local").map((m) => m.profile);
    const imported = members.filter((m) => m.source === "imported").map((m) => m.profile);
    const pickBest = (list: PieceProfile[]) =>
      [...list].sort(
        (a, b) =>
          (b.lastPracticedAtMs ?? 0) - (a.lastPracticedAtMs ?? 0) ||
          a.pieceId.localeCompare(b.pieceId),
      )[0];
    const canonicalPieceId = locals.length > 0 ? pickBest(locals).pieceId : pickBest(imported).pieceId;
    for (const l of locals) localIdToCanonical.set(l.pieceId, canonicalPieceId);
    for (const imp of imported) importedIdToCanonical.set(imp.pieceId, canonicalPieceId);
    componentMap.set(canonicalPieceId, { canonicalPieceId, locals, imported });
  }

  // Also map archived imported profiles directly by exact pieceId
  for (const imp of importedProfiles) {
    if (imp.archivedAtMs !== undefined) {
      const exactLocal = localById.get(imp.pieceId);
      const canonicalPieceId = exactLocal ? exactLocal.pieceId : imp.pieceId;
      importedIdToCanonical.set(imp.pieceId, canonicalPieceId);
    }
  }

  // Detect >= 85% measure-similarity candidates for unlinked active imported profiles
  const similarityLinks: BackupSimilarityLinkPreview[] = [];
  for (const imp of activeImported) {
    const canonicalId = importedIdToCanonical.get(imp.pieceId)!;
    const comp = componentMap.get(canonicalId);
    if (comp && comp.locals.length > 0) continue; // Already linked by pieceId or overlapping fingerprint

    let bestMatch: { local: PieceProfile; ratio: number } | undefined;
    const impHashesList = Object.values(imp.measureHashesByFingerprint);
    for (const loc of activeLocals) {
      for (const locHashes of Object.values(loc.measureHashesByFingerprint)) {
        for (const impHashes of impHashesList) {
          const ratio = measureSimilarityRatio(locHashes, impHashes);
          if (ratio >= 0.85 && (!bestMatch || ratio > bestMatch.ratio)) {
            bestMatch = { local: loc, ratio };
          }
        }
      }
    }
    if (bestMatch) {
      similarityLinks.push({
        importedPieceId: imp.pieceId,
        importedTitle: imp.title,
        localPieceId: bestMatch.local.pieceId,
        localTitle: bestMatch.local.title,
        similarityRatio: bestMatch.ratio,
      });
    }
  }

  return { importedIdToCanonical, localIdToCanonical, componentMap, similarityLinks };
}

function summarizeDraft(draft: FingerAnchorDraft): string {
  const anchorCount = Object.keys(draft.anchorsByCoord).length;
  const removedCount = draft.removedRawCoords.length;
  return `${anchorCount} 个指法锚点${removedCount > 0 ? `，${removedCount} 处删除` : ""}`;
}

function draftPayloadKey(draft: FingerAnchorDraft): string {
  const sortedAnchors = Object.keys(draft.anchorsByCoord)
    .sort()
    .map((k) => [k, draft.anchorsByCoord[k]]);
  return JSON.stringify({
    anchors: sortedAnchors,
    removed: [...draft.removedRawCoords].sort(),
    hash: draft.sourceFingeringHash,
  });
}

function summarizePrefs(prefs: WorkspacePrefs): string {
  const parts: string[] = [];
  if (prefs.handSpanProfile) parts.push(`手型 ${prefs.handSpanProfile.preset}`);
  if (prefs.speedMultiplier !== undefined) parts.push(`速度 ${prefs.speedMultiplier}x`);
  if (prefs.practiceMode) parts.push(`模式 ${prefs.practiceMode}`);
  if (prefs.singleStaffHand) parts.push(`单手 ${prefs.singleStaffHand}`);
  return parts.length > 0 ? parts.join(" · ") : "默认偏好";
}

function prefsPayloadKey(prefs: WorkspacePrefs): string {
  return JSON.stringify({
    handSpanProfile: prefs.handSpanProfile ?? null,
    speedMultiplier: prefs.speedMultiplier ?? null,
    abLoop: prefs.abLoop ?? null,
    practiceMode: prefs.practiceMode ?? null,
    singleStaffHand: prefs.singleStaffHand ?? null,
    ignoreExistingFingerings: prefs.ignoreExistingFingerings ?? null,
    absoluteStrictnessEnabled: prefs.absoluteStrictnessEnabled ?? null,
    strictHoldDurationEnabled: prefs.strictHoldDurationEnabled ?? null,
  });
}

function summarizeChunkOverrides(overrides: NonNullable<PieceProfile["chunkOverrides"]>): string {
  return `拆分 ${overrides.addedBoundaries.length} 处 · 合并 ${overrides.removedBoundaries.length} 处`;
}

function chunkOverridesKey(overrides: NonNullable<PieceProfile["chunkOverrides"]>): string {
  return JSON.stringify({
    added: overrides.addedBoundaries,
    removed: overrides.removedBoundaries,
  });
}

function collectConflicts(params: {
  componentMap: ReturnType<typeof computeProfileMapping>["componentMap"];
  importedIdToCanonical: Map<string, string>;
  localDrafts: readonly FingerAnchorDraft[];
  importedDrafts: readonly FingerAnchorDraft[];
  localPrefs: readonly WorkspacePrefs[];
  importedPrefs: readonly WorkspacePrefs[];
}): BackupConflictItem[] {
  const {
    componentMap,
    importedIdToCanonical,
    localDrafts,
    importedDrafts,
    localPrefs,
    importedPrefs,
  } = params;
  const conflicts: BackupConflictItem[] = [];
  const mapImp = (id: string) => importedIdToCanonical.get(id) ?? id;

  const titleByPieceId = new Map<string, string>();
  for (const [pieceId, comp] of componentMap.entries()) {
    const title = comp.locals[0]?.title ?? comp.imported[0]?.title ?? pieceId;
    titleByPieceId.set(pieceId, title);

    // 1. chunkOverrides conflicts
    const latestLocalOv = comp.locals
      .map((l) => l.chunkOverrides)
      .filter((o): o is NonNullable<PieceProfile["chunkOverrides"]> => Boolean(o))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
    const latestImpOv = comp.imported
      .map((i) => i.chunkOverrides)
      .filter((o): o is NonNullable<PieceProfile["chunkOverrides"]> => Boolean(o))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
    if (latestLocalOv && latestImpOv && chunkOverridesKey(latestLocalOv) !== chunkOverridesKey(latestImpOv)) {
      conflicts.push({
        conflictId: `chunks:${pieceId}`,
        kind: "chunk-overrides",
        pieceId,
        pieceTitle: title,
        scopeKey: pieceId,
        localUpdatedAtMs: latestLocalOv.updatedAtMs,
        importedUpdatedAtMs: latestImpOv.updatedAtMs,
        defaultChoice: latestImpOv.updatedAtMs > latestLocalOv.updatedAtMs ? "adopt-imported" : "keep-local",
        localSummary: summarizeChunkOverrides(latestLocalOv),
        importedSummary: summarizeChunkOverrides(latestImpOv),
      });
    }
  }

  // 2. FingerAnchorDraft conflicts
  const localDraftByPiece = new Map(localDrafts.map((d) => [d.pieceId, d]));
  const importedDraftByPiece = new Map<string, FingerAnchorDraft>();
  for (const d of importedDrafts) {
    const pid = mapImp(d.pieceId);
    const prev = importedDraftByPiece.get(pid);
    if (!prev || d.updatedAtMs > prev.updatedAtMs) {
      importedDraftByPiece.set(pid, { ...d, pieceId: pid });
    }
  }
  for (const [pieceId, impDraft] of importedDraftByPiece.entries()) {
    const locDraft = localDraftByPiece.get(pieceId);
    if (locDraft && draftPayloadKey(locDraft) !== draftPayloadKey(impDraft)) {
      conflicts.push({
        conflictId: `draft:${pieceId}`,
        kind: "finger-anchor-draft",
        pieceId,
        pieceTitle: titleByPieceId.get(pieceId) ?? pieceId,
        scopeKey: pieceId,
        localUpdatedAtMs: locDraft.updatedAtMs,
        importedUpdatedAtMs: impDraft.updatedAtMs,
        defaultChoice: impDraft.updatedAtMs > locDraft.updatedAtMs ? "adopt-imported" : "keep-local",
        localSummary: summarizeDraft(locDraft),
        importedSummary: summarizeDraft(impDraft),
      });
    }
  }

  // 3. WorkspacePrefs (including HandSpanProfile) conflicts
  const localPrefsByScope = new Map(localPrefs.map((p) => [p.scopeKey, p]));
  const importedPrefsByScope = new Map<string, WorkspacePrefs>();
  for (const p of importedPrefs) {
    const scopeKey = p.scopeKey === GLOBAL_WORKSPACE ? GLOBAL_WORKSPACE : mapImp(p.scopeKey);
    const prev = importedPrefsByScope.get(scopeKey);
    if (!prev || (p.updatedAtMs ?? 0) > (prev.updatedAtMs ?? 0)) {
      importedPrefsByScope.set(scopeKey, { ...p, scopeKey });
    }
  }
  for (const [scopeKey, impPref] of importedPrefsByScope.entries()) {
    const locPref = localPrefsByScope.get(scopeKey);
    if (locPref && prefsPayloadKey(locPref) !== prefsPayloadKey(impPref)) {
      const localTs = locPref.updatedAtMs ?? 0;
      const impTs = impPref.updatedAtMs ?? 0;
      conflicts.push({
        conflictId: `prefs:${scopeKey}`,
        kind: "workspace-prefs",
        pieceId: scopeKey,
        pieceTitle: scopeKey === GLOBAL_WORKSPACE ? "全局工作区偏好" : (titleByPieceId.get(scopeKey) ?? scopeKey),
        scopeKey,
        localUpdatedAtMs: localTs,
        importedUpdatedAtMs: impTs,
        defaultChoice: impTs > localTs ? "adopt-imported" : "keep-local",
        localSummary: summarizePrefs(locPref),
        importedSummary: summarizePrefs(impPref),
      });
    }
  }

  return conflicts;
}

/**
 * Computes a non-mutating pre-import preview detailing event union counts,
 * `>= 85%` measure-similarity linking candidates, and per-item LWW conflicts.
 */
export async function previewPracticeBackupImport(
  storage: PracticeStoragePort,
  json: string,
): Promise<BackupImportPreview> {
  const parsed = parseBackupPayload(json);
  const [localProfiles, localEvents, localDrafts, localPrefs] = await Promise.all([
    storage.all("pieceProfiles"),
    storage.all("practiceEvents"),
    storage.all("fingerAnchorDrafts"),
    storage.all("workspacePrefs"),
  ]);

  const { importedIdToCanonical, componentMap, similarityLinks } = computeProfileMapping(
    localProfiles,
    parsed.profiles,
  );

  const localEventIds = new Set(localEvents.map((e) => e.eventId));
  let newEventCount = 0;
  const seenNew = new Set<string>();
  for (const ev of parsed.events) {
    if (!localEventIds.has(ev.eventId) && !seenNew.has(ev.eventId)) {
      seenNew.add(ev.eventId);
      newEventCount += 1;
    }
  }

  const conflicts = collectConflicts({
    componentMap,
    importedIdToCanonical,
    localDrafts,
    importedDrafts: parsed.drafts,
    localPrefs,
    importedPrefs: parsed.prefs,
  });

  return {
    schemaVersion: parsed.version,
    importedProfileCount: parsed.profiles.length,
    newEventCount,
    totalEventCountAfterMerge: localEvents.length + newEventCount,
    conflicts,
    similarityLinks,
  };
}

/**
 * Unifies PieceProfiles across overlapping ScoreFingerprints, takes the `eventId`-deduplicated
 * union of PracticeEvents, deterministically replays Motor-FSRS to rebuild `derivedSnapshots`
 * and `bestStableSpeed`, and resolves mutable settings via LWW or explicit user `resolutions`.
 */
export async function importPracticeBackup(
  storage: PracticeStoragePort,
  json: string,
  resolutions?: BackupImportResolutions,
): Promise<void> {
  const parsed = parseBackupPayload(json);
  const { profiles, events, drafts, prefs, blobs } = parsed;

  const [localProfiles, localEvents, localDrafts, localPrefs, localBlobs] = await Promise.all([
    storage.all("pieceProfiles"),
    storage.all("practiceEvents"),
    storage.all("fingerAnchorDrafts"),
    storage.all("workspacePrefs"),
    storage.all("scoreBlobs"),
  ]);

  const { importedIdToCanonical, localIdToCanonical, componentMap } = computeProfileMapping(
    localProfiles,
    profiles,
    resolutions?.linkByImportedPieceId,
  );

  const conflicts = collectConflicts({
    componentMap,
    importedIdToCanonical,
    localDrafts,
    importedDrafts: drafts,
    localPrefs,
    importedPrefs: prefs,
  });
  const choiceByConflictId = new Map<string, BackupConflictChoice>();
  for (const c of conflicts) {
    choiceByConflictId.set(c.conflictId, resolutions?.choicesByConflictId?.[c.conflictId] ?? c.defaultChoice);
  }

  const mapImp = (id: string) => importedIdToCanonical.get(id) ?? id;
  const mapLoc = (id: string) => localIdToCanonical.get(id) ?? id;

  // Deduplicate PracticeEvent union by eventId and remap pieceIds to unified canonical pieceId
  const unionEventsById = new Map<string, PracticeEvent>();
  for (const ev of localEvents) {
    unionEventsById.set(ev.eventId, { ...ev, pieceId: mapLoc(ev.pieceId) });
  }
  for (const ev of events) {
    if (!unionEventsById.has(ev.eventId)) {
      unionEventsById.set(ev.eventId, { ...ev, pieceId: mapImp(ev.pieceId) });
    }
  }
  const eventsByPiece = new Map<string, PracticeEvent[]>();
  for (const ev of unionEventsById.values()) {
    const list = eventsByPiece.get(ev.pieceId);
    if (list) list.push(ev);
    else eventsByPiece.set(ev.pieceId, [ev]);
  }

  // Merge active unified PieceProfiles & archived profiles, then replay Motor-FSRS per piece
  const changedProfiles: PieceProfile[] = [];
  const rebuiltSnapshots: ReturnType<typeof buildDerivedSnapshot>[] = [];

  for (const [canonicalPieceId, comp] of componentMap.entries()) {
    if (comp.imported.length === 0 && comp.locals.length <= 1) {
      continue; // Unchanged local profile not touched by this import
    }

    const allMembers = [...comp.locals, ...comp.imported];
    const primary = comp.locals.find((l) => l.pieceId === canonicalPieceId) ?? allMembers[0];
    const fingerprints = [...new Set(allMembers.flatMap((m) => m.fingerprints))];
    const measureHashesByFingerprint: Record<string, string[]> = {};
    for (const m of allMembers) {
      Object.assign(measureHashesByFingerprint, m.measureHashesByFingerprint);
    }

    let lastPracticedAtMs: number | undefined = primary.lastPracticedAtMs;
    for (const m of allMembers) {
      if (m.lastPracticedAtMs !== undefined) {
        lastPracticedAtMs = Math.max(m.lastPracticedAtMs, lastPracticedAtMs ?? 0);
      }
    }

    const latestLocalOv = comp.locals
      .map((l) => l.chunkOverrides)
      .filter((o): o is NonNullable<PieceProfile["chunkOverrides"]> => Boolean(o))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
    const latestImpOv = comp.imported
      .map((i) => i.chunkOverrides)
      .filter((o): o is NonNullable<PieceProfile["chunkOverrides"]> => Boolean(o))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];

    let resolvedOverrides: PieceProfile["chunkOverrides"] | undefined;
    if (latestLocalOv && latestImpOv) {
      const choice = choiceByConflictId.get(`chunks:${canonicalPieceId}`);
      resolvedOverrides =
        choice === "keep-local"
          ? latestLocalOv
          : choice === "adopt-imported"
            ? latestImpOv
            : latestImpOv.updatedAtMs > latestLocalOv.updatedAtMs
              ? latestImpOv
              : latestLocalOv;
    } else {
      resolvedOverrides = latestLocalOv ?? latestImpOv;
    }

    const pieceEvents = sortPracticeEventsChronologically(eventsByPiece.get(canonicalPieceId) ?? []);
    let bestStableSpeed = primary.bestStableSpeed;
    if (pieceEvents.length > 0) {
      const replayed = reducePiecePracticeState(pieceEvents, {
        pieceId: canonicalPieceId,
        chunkOverrides: resolvedOverrides,
      });
      rebuiltSnapshots.push(buildDerivedSnapshot(canonicalPieceId, replayed));
      if (replayed.bestStableSpeed > 0) {
        bestStableSpeed = replayed.bestStableSpeed;
      }
      if (replayed.lastPracticedAtMs !== undefined) {
        lastPracticedAtMs = Math.max(replayed.lastPracticedAtMs, lastPracticedAtMs ?? 0);
      }
    }

    changedProfiles.push({
      pieceId: canonicalPieceId,
      title: primary.title,
      fingerprints,
      measureHashesByFingerprint,
      ...(lastPracticedAtMs !== undefined ? { lastPracticedAtMs } : {}),
      ...(bestStableSpeed !== undefined ? { bestStableSpeed } : {}),
      ...(resolvedOverrides ? { chunkOverrides: resolvedOverrides } : {}),
    });

    // Archive any absorbed duplicate local profiles so queries return only canonicalPieceId
    for (const loc of comp.locals) {
      if (loc.pieceId !== canonicalPieceId) {
        changedProfiles.push({ ...loc, archivedAtMs: Date.now() });
      }
    }
  }

  // Include archived imported profiles directly
  const localProfileById = new Map(localProfiles.map((p) => [p.pieceId, p]));
  for (const imp of profiles) {
    if (imp.archivedAtMs !== undefined) {
      const existing = localProfileById.get(imp.pieceId);
      changedProfiles.push(existing ? { ...existing, ...imp } : imp);
    }
  }

  // Resolve FingerAnchorDrafts
  const localDraftById = new Map(localDrafts.map((row) => [row.pieceId, row]));
  const importedDraftById = new Map<string, FingerAnchorDraft>();
  for (const row of drafts) {
    const pid = mapImp(row.pieceId);
    const prev = importedDraftById.get(pid);
    if (!prev || row.updatedAtMs > prev.updatedAtMs) {
      importedDraftById.set(pid, { ...row, pieceId: pid });
    }
  }
  const mergedDrafts: FingerAnchorDraft[] = [];
  for (const [pid, impDraft] of importedDraftById.entries()) {
    const locDraft = localDraftById.get(pid);
    if (!locDraft) {
      mergedDrafts.push(impDraft);
      continue;
    }
    const explicit = choiceByConflictId.get(`draft:${pid}`);
    const adopt =
      explicit !== undefined
        ? explicit === "adopt-imported"
        : impDraft.updatedAtMs > locDraft.updatedAtMs;
    if (adopt) mergedDrafts.push(impDraft);
  }

  // Resolve WorkspacePrefs
  const localPrefsById = new Map(localPrefs.map((row) => [row.scopeKey, row]));
  const importedPrefsById = new Map<string, WorkspacePrefs>();
  for (const row of prefs) {
    const scopeKey = row.scopeKey === GLOBAL_WORKSPACE ? GLOBAL_WORKSPACE : mapImp(row.scopeKey);
    const normalized: WorkspacePrefs = {
      ...row,
      scopeKey,
      ...(row.lastOpenedPieceId ? { lastOpenedPieceId: mapImp(row.lastOpenedPieceId) } : {}),
      ...(row.repairEdge
        ? {
            repairEdge: {
              ...row.repairEdge,
              otherDraft: {
                ...row.repairEdge.otherDraft,
                pieceId: mapImp(row.repairEdge.otherDraft.pieceId),
              },
            },
          }
        : {}),
    };
    const prev = importedPrefsById.get(scopeKey);
    if (!prev || (normalized.updatedAtMs ?? 0) > (prev.updatedAtMs ?? 0)) {
      importedPrefsById.set(scopeKey, normalized);
    }
  }
  const mergedPrefs: WorkspacePrefs[] = [];
  for (const [scopeKey, impPref] of importedPrefsById.entries()) {
    const locPref = localPrefsById.get(scopeKey);
    if (!locPref) {
      mergedPrefs.push(impPref);
      continue;
    }
    const explicit = choiceByConflictId.get(`prefs:${scopeKey}`);
    const adopt =
      explicit !== undefined
        ? explicit === "adopt-imported"
        : (impPref.updatedAtMs ?? 0) > (locPref.updatedAtMs ?? -1);
    if (adopt) mergedPrefs.push(impPref);
  }

  // Write unified events (note: storage.commit skips existing eventIds; if a local event's pieceId was absorbed into another local profile, commit the remapped copy under new IDs? Only newly imported events need committing unless absorbed)
  const existingEventIds = new Set(localEvents.map((e) => e.eventId));
  const eventsToWrite: PracticeEvent[] = [];
  for (const ev of unionEventsById.values()) {
    if (!existingEventIds.has(ev.eventId)) {
      eventsToWrite.push(ev);
    }
  }

  const localBlobById = new Map(localBlobs.map((row) => [row.fingerprint, row]));

  await storage.commit({
    pieceProfiles: changedProfiles,
    practiceEvents: eventsToWrite,
    derivedSnapshots: rebuiltSnapshots,
    fingerAnchorDrafts: mergedDrafts,
    workspacePrefs: mergedPrefs,
    scoreBlobs: blobs.filter(
      (row) => row.lastAccessedAtMs > (localBlobById.get(row.fingerprint)?.lastAccessedAtMs ?? -1),
    ),
  });
}
