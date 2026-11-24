import type { ScoreDocument } from "../domain/types";
import { exportMxlContainer } from "../musicxml/mxl";
import { loadScoreInput, type LoadedScoreSession } from "../musicxml/scoreSession";
import type { StudioSnapshot, StudioState } from "../store/useStudioStore";
import { captureDraft, hashSourceFingerings } from "./anchorDrafts";
import { getScoreIdentity, isSimilarScore, type ScoreIdentity } from "./fingerprint";
import { sha256 } from "./sha256";
import { GLOBAL_WORKSPACE, type PieceProfile, type PracticeStoragePort,
  type PracticeStorageWrite, type ScoreBlob, type WorkspacePrefs } from "./storagePort";

export function addScoreAlias(profile: PieceProfile, identity: ScoreIdentity): PieceProfile {
  if (profile.fingerprints.includes(identity.fingerprint)) return profile;
  return { ...profile, fingerprints: [...profile.fingerprints, identity.fingerprint],
    measureHashesByFingerprint: { ...profile.measureHashesByFingerprint, [identity.fingerprint]: identity.measureHashes } };
}

export function newPieceProfile(score: ScoreDocument, identity = getScoreIdentity(score)): PieceProfile {
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

export async function resolvePieceOpen(storage: PracticeStoragePort, score: ScoreDocument,
  choose: (choice: OpenChoice) => Promise<boolean>, existing?: WorkspacePrefs) {
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
    if (similar && await choose({ kind: "link", title: similar.title })) profile = similar;
  }
  if (!profile) return { profile: newPieceProfile(score, identity), prefs: undefined, draft: undefined };
  const [prefs, draft] = await Promise.all([
    existing ?? storage.get("workspacePrefs", profile.pieceId), storage.get("fingerAnchorDrafts", profile.pieceId),
  ]);
  const sourceDraft = prefs?.repairEdge?.otherCacheKey === identity.fingerprint &&
      prefs.scoreFingerprint !== identity.fingerprint ? prefs.repairEdge.otherDraft : draft;
  const conflict = exact && !existing && sourceDraft && sourceDraft.sourceFingeringHash !== hashSourceFingerings(score);
  const keepDraft = !conflict || await choose({ kind: "fingering", title: profile.title });
  return { profile: addScoreAlias(profile, identity), prefs, draft: keepDraft ? sourceDraft : undefined };
}

export async function readCachedScore(storage: PracticeStoragePort, key: string, prefs: WorkspacePrefs):
Promise<{ session: LoadedScoreSession; blob: ScoreBlob } | undefined> {
  const blob = await storage.accessScoreBlob(key);
  if (!blob) return undefined;
  const session = await loadScoreInput({ fileName: blob.fileName, bytes: blob.bytes },
    { singleStaffHandOverride: prefs.singleStaffHand });
  session.sourceFormat = blob.sourceFormat ?? "mxl";
  return { session, blob };
}

export interface CurrentWorkspace {
  state: StudioState;
  prefs: Omit<WorkspacePrefs, "scopeKey" | "scoreFingerprint" | "repairEdge" | "updatedAtMs">;
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
  { state, prefs }: CurrentWorkspace, changes: WorkspaceChanges) {
  if (!state.rawXmlText || !state.scoreDoc) return profile;
  const now = Date.now();
  const identity = getScoreIdentity(state.scoreDoc);
  // An import may have added aliases while this score was already open.
  const known = profile.fingerprints.includes(identity.fingerprint) && !changes.profile && !changes.practiced
    ? profile : await storage.get("pieceProfiles", profile.pieceId) ?? profile;
  const withAlias = addScoreAlias(known, identity);
  const nextProfile = changes.practiced ? { ...withAlias, lastPracticedAtMs: now } : withAlias;
  let alternate: StudioSnapshot | undefined;
  let repairEdge: WorkspacePrefs["repairEdge"];
  if (changes.prefs || changes.cache) {
    const previous = [...state.history.past].reverse().find((snapshot) => snapshot.scoreDoc && snapshot.rawXmlText !== state.rawXmlText);
    const next = state.history.future.find((snapshot) => snapshot.scoreDoc && snapshot.rawXmlText !== state.rawXmlText);
    // Future takes precedence after an Undo, so the latest repair can be redone after refresh.
    alternate = next ?? previous;
    if (alternate?.scoreDoc && alternate.rawXmlText) {
      const other = getScoreIdentity(alternate.scoreDoc).fingerprint;
      const otherCacheKey = other === identity.fingerprint ? `${other}:${sha256(alternate.rawXmlText)}` : other;
      repairEdge = { direction: next ? "redo" : "undo", otherCacheKey,
        otherDraft: captureDraft(profile.pieceId, alternate.scoreDoc, alternate, now) };
    }
  }
  const write: PracticeStorageWrite = {
    ...(changes.profile || nextProfile !== profile ? { pieceProfiles: [nextProfile] } : {}),
    ...(changes.draft ? { fingerAnchorDrafts: [captureDraft(profile.pieceId, state.scoreDoc, state, now)] } : {}),
  };
  const workspacePrefs: WorkspacePrefs[] = [];
  if (changes.prefs || changes.cache) workspacePrefs.push({ ...prefs, scopeKey: profile.pieceId,
    scoreFingerprint: identity.fingerprint, repairEdge, updatedAtMs: now });
  if (changes.lastOpened) workspacePrefs.push({ scopeKey: GLOBAL_WORKSPACE, lastOpenedPieceId: profile.pieceId, updatedAtMs: now });
  if (workspacePrefs.length) write.workspacePrefs = workspacePrefs;
  if (changes.cache) {
    const blob = async (fingerprint: string, xml: string): Promise<ScoreBlob> => {
      const bytes = await exportMxlContainer(xml, state.mxlContainer);
      return { fingerprint, bytes, byteLength: bytes.byteLength, lastAccessedAtMs: now,
        fileName: state.fileName, sourceFormat: state.exportFormat };
    };
    // Core data must survive unavailable storage for the (evictable) score blobs.
    let scoreBlobs: ScoreBlob[];
    try {
      scoreBlobs = await Promise.all([
        blob(identity.fingerprint, state.rawXmlText),
        ...(repairEdge && alternate?.rawXmlText ? [blob(repairEdge.otherCacheKey, alternate.rawXmlText)] : []),
      ]);
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

export async function requestPracticeDurability(storage: PracticeStoragePort): Promise<boolean> {
  let persisted = false;
  try { persisted = (await globalThis.navigator?.storage?.persist?.()) === true; } catch { /* browser denied */ }
  await storage.commit({ meta: [{ key: "storagePersisted", value: persisted }] });
  return persisted;
}

export async function isBackupReminderDue(storage: PracticeStoragePort, now = Date.now()) {
  const reminder = await storage.get("meta", "lastBackupReminderAtMs");
  return !reminder || now - Number(reminder.value) >= 7 * 24 * 60 * 60 * 1000;
}
