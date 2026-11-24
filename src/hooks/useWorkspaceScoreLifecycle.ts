import { useEffect, useRef, useState } from "react";
import type { HandSpanProfile, ScoreDocument, SolveResult } from "../domain/types";
import { parseMusicXml } from "../musicxml/parser";
import type { LoadedScoreSession } from "../musicxml/scoreSession";
import { applyDraft, type AnchorState } from "../persistence/anchorDrafts";
import { getScoreIdentity } from "../persistence/fingerprint";
import { newPieceProfile, readCachedScore, readRepairAlternate, resolvePieceOpen,
  type CurrentWorkspace, type OpenChoice } from "../persistence/studioPersistence";
import { GLOBAL_WORKSPACE, type WorkspacePrefs } from "../persistence/storagePort";
import { useStudioStore, type StudioSnapshot, type StudioState } from "../store/useStudioStore";
import { SolverCancelledError } from "../workers/solverClient";
import type { usePracticePersistence } from "./usePracticePersistence";

interface WorkspaceScoreLifecycleOptions {
  persistence: Pick<ReturnType<typeof usePracticePersistence>, "storage" | "getActive" | "activate" | "persistCurrent">;
  durablePrefs: CurrentWorkspace["prefs"];
  solveScore(score: ScoreDocument, profile: HandSpanProfile, ignoreAnchors: boolean, state: AnchorState): Promise<SolveResult>;
  restorePreferences(score: ScoreDocument, saved: WorkspacePrefs | undefined): void;
  beforeArchive(): void;
  resetPracticeProgress(): void;
}

/** Resolve and restore score identity, the adjacent repair edge, and archive bindings. */
export function useWorkspaceScoreLifecycle({
  persistence, durablePrefs, solveScore, restorePreferences, beforeArchive, resetPracticeProgress,
}: WorkspaceScoreLifecycleOptions) {
  const openSequence = useRef(0);
  const [openChoice, setOpenChoice] = useState<OpenChoice | null>(null);
  const decision = useRef<((answer: boolean) => void) | null>(null);
  const answerOpenChoice = (answer: boolean) => {
    decision.current?.(answer);
    decision.current = null;
    setOpenChoice(null);
  };
  const chooseScoreOpen = (choice: OpenChoice) => new Promise<boolean>((resolve) => {
    decision.current = resolve;
    setOpenChoice(choice);
  });

  const beginScoreOpen = () => {
    answerOpenChoice(false);
    return ++openSequence.current;
  };
  const isCurrent = (generation: number) => generation === openSequence.current;

  const openScoreSession = async (
    session: LoadedScoreSession, name: string, generation: number, cachedPrefs?: WorkspacePrefs,
  ) => {
    const { storage } = persistence;
    const store = useStudioStore.getState();
    const current = () => {
      if (openSequence.current !== generation) throw new SolverCancelledError();
    };
    current();
    let identity: Awaited<ReturnType<typeof resolvePieceOpen>> | undefined;
    if (storage) {
      // A file should still open if browser storage is unavailable or blocked.
      try {
        await persistence.persistCurrent();
        current();
        identity = await resolvePieceOpen(storage, session.scoreDoc, (choice) => {
          current();
          return chooseScoreOpen(choice);
        }, cachedPrefs);
      } catch (error) {
        if (cachedPrefs || error instanceof SolverCancelledError) throw error;
      }
    }
    current();
    const saved = identity?.prefs;
    const profile = saved?.handSpanProfile ?? store.handSpanProfile;
    const ignore = saved?.ignoreExistingFingerings ?? store.ignoreExistingFingerings;
    const score = session.scoreDoc.isSingleStaff && saved?.singleStaffHand &&
      session.scoreDoc.defaultSingleStaffHand !== saved.singleStaffHand
      ? parseMusicXml(session.rawXmlText, { singleStaffHandOverride: saved.singleStaffHand }) : session.scoreDoc;
    const state = applyDraft(score, identity?.draft);
    const result = await solveScore(score, profile, ignore, state);
    const repair = cachedPrefs?.repairEdge;
    let restoredHistory: StudioState["history"] | undefined;
    if (storage && repair) {
      try {
        const other = await readRepairAlternate(storage, cachedPrefs);
        current();
        if (other) {
          const otherScore = other.session.scoreDoc;
          const anchors = applyDraft(otherScore, repair.otherDraft);
          const solved = await solveScore(otherScore, profile, ignore, anchors);
          const snapshot: StudioSnapshot = { rawXmlText: other.session.rawXmlText, scoreDoc: otherScore, ...anchors,
            solveResult: solved, fingerByNoteUid: solved.fingerByNoteUid, lastDiff: [] };
          restoredHistory = repair.direction === "undo" ? { past: [snapshot], future: [] } : { past: [], future: [snapshot] };
        }
      } catch (error) {
        if (error instanceof SolverCancelledError) throw error;
        // Missing or damaged alternate must not prevent reopening the active score.
      }
    }
    current();
    store.setHandSpanProfile(profile);
    store.setIgnoreExistingFingerings(ignore);
    restorePreferences(score, saved);
    if (storage) persistence.activate(identity?.profile ?? newPieceProfile(score), saved?.freePracticeMinutes);
    store.setSolvedScore({ scoreDoc: score, rawXmlText: session.rawXmlText, mxlContainer: session.mxlContainer,
      fileName: name, exportFormat: session.sourceFormat, solveResult: result, resetHistory: true,
      restored: { ...state, history: restoredHistory } });
  };

  const restoreLastScore = async (generation: number) => {
    const { storage } = persistence;
    if (!storage) return;
    const last = await storage.get("workspacePrefs", GLOBAL_WORKSPACE);
    if (!last?.lastOpenedPieceId || generation !== openSequence.current) return;
    const prefs = await storage.get("workspacePrefs", last.lastOpenedPieceId);
    if (!prefs?.scoreFingerprint || generation !== openSequence.current) return;
    const cached = await readCachedScore(storage, prefs.scoreFingerprint, prefs);
    if (!cached || generation !== openSequence.current) return;
    await openScoreSession(cached.session, cached.fileName, generation, prefs);
  };
  const restoreRef = useRef(restoreLastScore);
  restoreRef.current = restoreLastScore;
  useEffect(() => {
    if (!persistence.storage) return;
    const generation = ++openSequence.current;
    void restoreRef.current(generation).catch((error) => {
      if (generation === openSequence.current && !(error instanceof SolverCancelledError)) {
        useStudioStore.getState().setStatus("暂时无法恢复缓存乐谱，请重新上传乐谱");
      }
    });
    return () => {
      ++openSequence.current;
      decision.current?.(false);
      decision.current = null;
    };
  }, [persistence.storage]);

  const handleBackupImported = async () => {
    if (!useStudioStore.getState().scoreDoc) {
      const generation = ++openSequence.current;
      try { await restoreLastScore(generation); } catch (error) {
        if (!(error instanceof SolverCancelledError)) {
          useStudioStore.getState().setStatus("练习数据已导入，请重新上传乐谱");
        }
      }
    }
  };

  const handleArchivePiece = async () => {
    const { storage } = persistence;
    const active = persistence.getActive();
    const state = useStudioStore.getState();
    if (!storage || !active || !state.rawXmlText || !state.scoreDoc) return;
    beforeArchive();
    await persistence.persistCurrent();
    const score = parseMusicXml(state.rawXmlText, { singleStaffHandOverride: state.singleStaffHand });
    const identity = getScoreIdentity(score);
    const restarted = newPieceProfile(score, identity);
    const result = await solveScore(score, state.handSpanProfile, state.ignoreExistingFingerings, applyDraft(score));
    const now = Date.now();
    await storage.commit({
      pieceProfiles: [{ ...active.profile, archivedAtMs: now }, restarted],
      workspacePrefs: [
        { ...durablePrefs, scopeKey: restarted.pieceId, scoreFingerprint: identity.fingerprint, freePracticeMinutes: 0, updatedAtMs: now },
        { scopeKey: GLOBAL_WORKSPACE, lastOpenedPieceId: restarted.pieceId, updatedAtMs: now },
      ],
    });
    resetPracticeProgress();
    persistence.activate(restarted);
    state.setSolvedScore({ scoreDoc: score, rawXmlText: state.rawXmlText, mxlContainer: state.mxlContainer,
      fileName: state.fileName, exportFormat: state.exportFormat, solveResult: result, resetHistory: true });
  };

  return { beginScoreOpen, isCurrent, openScoreSession, openChoice, answerOpenChoice, handleBackupImported, handleArchivePiece };
}
