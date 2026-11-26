import type { ExportFormat, ScoreDocument } from "../domain/types";
import { sha256 } from "../domain/sha256";
import { captureDraft, hashSourceFingerings, type AnchorState } from "./anchorDrafts";
import { getScoreIdentity, isSimilarScore, type ScoreIdentity } from "./fingerprint";
import { GLOBAL_WORKSPACE, type PieceProfile, type PracticeStoragePort,
  type PracticeStorageWrite, type ScoreBlob, type ScoreBlobSource, type WorkspacePrefs } from "./storagePort";

type ScoreProfileSource = Parameters<typeof getScoreIdentity>[0] & Pick<ScoreDocument, "title" | "sourceFingeringHash">;

export function addScoreAlias(profile: PieceProfile, identity: ScoreIdentity): PieceProfile {
  if (profile.fingerprints.includes(identity.fingerprint)) return profile;
  return { ...profile, fingerprints: [...profile.fingerprints, identity.fingerprint],
    measureHashesByFingerprint: { ...profile.measureHashesByFingerprint, [identity.fingerprint]: identity.measureHashes } };
}

export function newPieceProfile(score: ScoreProfileSource, identity = getScoreIdentity(score)): PieceProfile {
  // randomUUID is secure-context only; the fallback still uses cryptographic entropy on LAN origins.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const pieceId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { pieceId, title: score.title, fingerprints: [identity.fingerprint],
    measureHashesByFingerprint: { [identity.fingerprint]: identity.measureHashes } };
}

export type OpenChoice = { kind: "link"; title: string } | { kind: "fingering"; title: string };
export type OpenDecision = "link-existing" | "open-as-new" | "keep-local-draft" | "adopt-imported";

export async function resolvePieceOpen(storage: PracticeStoragePort, score: ScoreProfileSource,
  choose: (choice: OpenChoice) => Promise<OpenDecision>, existing?: WorkspacePrefs) {
  const identity = getScoreIdentity(score);
  const active = (p: PieceProfile) => p.archivedAtMs === undefined;
  const byRecent = (a: PieceProfile, b: PieceProfile) => (b.lastPracticedAtMs ?? 0) - (a.lastPracticedAtMs ?? 0);
  let profile = existing ? await storage.get("pieceProfiles", existing.scopeKey) :
    (await storage.findPieceProfiles(identity.fingerprint)).filter(active).sort(byRecent)[0];
  if (existing && (!profile || !active(profile) || !profile.fingerprints.includes(identity.fingerprint))) {
    throw new Error("找不到此缓存乐谱对应的练习曲目");
  }
  const exact = Boolean(profile);
  if (!profile) {
    const similar = (await storage.all("pieceProfiles")).filter(active).sort(byRecent)
      .find((candidate) => Object.values(candidate.measureHashesByFingerprint)
        .some((hashes) => isSimilarScore(hashes, identity.measureHashes)));
    if (similar && await choose({ kind: "link", title: similar.title }) === "link-existing") profile = similar;
  }
  if (!profile) return { profile: newPieceProfile(score, identity), prefs: undefined, draft: undefined };
  const [prefs, draft] = await Promise.all([
    existing ?? storage.get("workspacePrefs", profile.pieceId), storage.get("fingerAnchorDrafts", profile.pieceId),
  ]);
  const sourceDraft = prefs?.repairEdge?.otherFingerprint === identity.fingerprint &&
      prefs.scoreFingerprint !== identity.fingerprint ? prefs.repairEdge.otherDraft : draft;
  const conflict = exact && !existing && sourceDraft && sourceDraft.sourceFingeringHash !== hashSourceFingerings(score);
  const fingeringDecision = conflict ? await choose({ kind: "fingering", title: profile.title }) : undefined;
  return { profile: addScoreAlias(profile, identity), prefs, fingeringDecision,
    draft: fingeringDecision === "adopt-imported" ? undefined : sourceDraft };
}

export async function readLastOpenedPrefs(storage: PracticeStoragePort) {
  const global = await storage.get("workspacePrefs", GLOBAL_WORKSPACE);
  return global?.lastOpenedPieceId ? storage.get("workspacePrefs", global.lastOpenedPieceId) : undefined;
}

export async function readRepairAlternate(storage: PracticeStoragePort, repair: NonNullable<WorkspacePrefs["repairEdge"]>) {
  // Loading an Undo/Redo snapshot does not make it the currently opened score.
  const blob = await storage.get("scoreBlobs", repair.otherFingerprint);
  const source = repair.alternateCacheKey ? blob?.repairAlternate : blob;
  if (!source || (repair.alternateCacheKey && blob?.repairAlternate?.cacheKey !== repair.alternateCacheKey)) return undefined;
  return source;
}

export interface WorkspaceSource extends AnchorState {
  rawXmlText: string;
  scoreDoc: ScoreProfileSource;
}

export interface CurrentWorkspace extends WorkspaceSource {
  fileName: string;
  exportFormat: ExportFormat;
  prefs: Omit<WorkspacePrefs, "scopeKey" | "scoreFingerprint" | "repairEdge" | "updatedAtMs">;
  repair?: { direction: "undo" | "redo"; alternate: WorkspaceSource };
}

export interface WorkspaceChanges {
  profile?: boolean;
  prefs?: boolean;
  draft?: boolean;
  cache?: boolean;
  lastOpened?: boolean;
  practiced?: boolean;
}

/** Persist only changed parts. For a score edit keep a single adjacent score edge,
 * not volatile solver output or the ordinary anchor undo stack. */
export async function saveWorkspace(storage: PracticeStoragePort, profile: PieceProfile,
  workspace: CurrentWorkspace, changes: WorkspaceChanges, compressScore: (xml: string) => Promise<Uint8Array>) {
  const now = Date.now();
  const { scoreDoc, rawXmlText, fileName, exportFormat, prefs, repair } = workspace;
  const identity = getScoreIdentity(scoreDoc);
  // An import may have added aliases while this score was already open, and profile may carry newer chunk/cue overrides.
  const stored = !profile.fingerprints.includes(identity.fingerprint) || changes.profile || changes.practiced
    ? await storage.get("pieceProfiles", profile.pieceId)
    : undefined;
  const known: PieceProfile = stored
    ? {
        ...stored,
        ...profile,
        fingerprints: [...new Set([...stored.fingerprints, ...profile.fingerprints])],
        measureHashesByFingerprint: { ...stored.measureHashesByFingerprint, ...profile.measureHashesByFingerprint },
        ...(stored.lastPracticedAtMs !== undefined || profile.lastPracticedAtMs !== undefined
          ? { lastPracticedAtMs: Math.max(stored.lastPracticedAtMs ?? 0, profile.lastPracticedAtMs ?? 0) }
          : {}),
        ...(stored.chunkOverrides &&
        (!profile.chunkOverrides || stored.chunkOverrides.updatedAtMs > profile.chunkOverrides.updatedAtMs)
          ? { chunkOverrides: stored.chunkOverrides }
          : {}),
        ...(stored.performanceCueOverrides &&
        (!profile.performanceCueOverrides ||
          stored.performanceCueOverrides.updatedAtMs > profile.performanceCueOverrides.updatedAtMs)
          ? { performanceCueOverrides: stored.performanceCueOverrides }
          : {}),
      }
    : profile;
  const withAlias = addScoreAlias(known, identity);
  const nextProfile = changes.practiced ? { ...withAlias, lastPracticedAtMs: now } : withAlias;
  let repairEdge: WorkspacePrefs["repairEdge"];
  if (repair && (changes.prefs || changes.cache)) {
    const { direction, alternate } = repair;
    const otherFingerprint = getScoreIdentity(alternate.scoreDoc).fingerprint;
    repairEdge = { direction, otherFingerprint,
      ...(otherFingerprint === identity.fingerprint ? { alternateCacheKey: sha256(alternate.rawXmlText) } : {}),
      otherDraft: captureDraft(profile.pieceId, alternate.scoreDoc, alternate, now) };
  }
  const write: PracticeStorageWrite = {
    ...(changes.profile || nextProfile !== profile ? { pieceProfiles: [nextProfile] } : {}),
    ...(changes.draft ? { fingerAnchorDrafts: [captureDraft(profile.pieceId, scoreDoc, workspace, now)] } : {}),
  };
  const workspacePrefs: WorkspacePrefs[] = [];
  if (changes.prefs || changes.cache) workspacePrefs.push({ ...prefs, scopeKey: profile.pieceId,
    scoreFingerprint: identity.fingerprint, repairEdge, updatedAtMs: now });
  if (changes.lastOpened) workspacePrefs.push(lastOpenedRecord(profile.pieceId, now));
  if (workspacePrefs.length) write.workspacePrefs = workspacePrefs;
  if (changes.cache) {
    const pack = async (xml: string): Promise<ScoreBlobSource> => {
      const bytes = await compressScore(xml);
      return { bytes, byteLength: bytes.byteLength, fileName, sourceFormat: exportFormat };
    };
    // Core data must survive unavailable storage for the (evictable) score blobs.
    let scoreBlobs: ScoreBlob[];
    try {
      const [current, alternate] = await Promise.all([
        pack(rawXmlText), repairEdge && repair ? pack(repair.alternate.rawXmlText) : undefined,
      ]);
      const scoreBlob = { ...current, fingerprint: identity.fingerprint, lastAccessedAtMs: now };
      if (alternate && repairEdge?.alternateCacheKey) {
        scoreBlobs = [{ ...scoreBlob, repairAlternate: { ...alternate, cacheKey: repairEdge.alternateCacheKey } }];
      } else {
        scoreBlobs = [scoreBlob, ...(alternate && repairEdge ? [{ ...alternate, fingerprint: repairEdge.otherFingerprint,
          // An undo candidate must lose to the active score if only one revision fits.
          lastAccessedAtMs: now - 1 }] : [])];
      }
    } catch (error) {
      await storage.commit(write);
      throw error;
    }
    try {
      await storage.commit({ ...write, scoreBlobs });
    } catch (error) {
      if ((error as Error).name !== "QuotaExceededError") throw error;
      await storage.commit(write);
      throw error;
    }
  } else {
    await storage.commit(write);
  }
  return nextProfile;
}

function lastOpenedRecord(pieceId: string, now: number): WorkspacePrefs {
  return { scopeKey: GLOBAL_WORKSPACE, lastOpenedPieceId: pieceId, updatedAtMs: now };
}

export async function archivePieceAndRestart(storage: PracticeStoragePort, previous: PieceProfile,
  score: ScoreProfileSource, prefs: CurrentWorkspace["prefs"]) {
  const identity = getScoreIdentity(score);
  const restarted = newPieceProfile(score, identity);
  const now = Date.now();
  await storage.commit({
    pieceProfiles: [{ ...previous, archivedAtMs: now }, restarted],
    workspacePrefs: [
      { ...prefs, scopeKey: restarted.pieceId, scoreFingerprint: identity.fingerprint, freePracticeMinutes: 0, updatedAtMs: now },
      lastOpenedRecord(restarted.pieceId, now),
    ],
  });
  return restarted;
}

export async function requestPracticeDurability(storage: PracticeStoragePort): Promise<boolean> {
  let persisted = false;
  try { persisted = (await globalThis.navigator?.storage?.persist?.()) === true; } catch { /* browser denied */ }
  await storage.commit({ meta: [{ key: "storagePersisted", value: persisted }] });
  return persisted;
}

export async function claimBackupReminder(storage: PracticeStoragePort, now = Date.now()): Promise<boolean> {
  const reminder = await storage.get("meta", "lastBackupReminderAtMs");
  if (typeof reminder?.value === "number" && now - reminder.value < 7 * 24 * 60 * 60 * 1000) return false;
  await storage.commit({ meta: [{ key: "lastBackupReminderAtMs", value: now }] });
  return true;
}
