import { useEffect, useRef, useState } from "react";
import type { HandSpanProfile, ScoreDocument, SolveResult } from "../domain/types";
import { parseMusicXml } from "../musicxml/parser";
import { loadScoreInput, type LoadedScoreSession } from "../musicxml/scoreSession";
import { getScoreIdentity } from "../persistence/fingerprint";
import { applyDraft, type AnchorState } from "../persistence/anchorDrafts";
import { archivePieceAndRestart, newPieceProfile, readLastOpenedPrefs, readRepairAlternate, resolvePieceOpen,
  type CurrentWorkspace, type OpenChoice, type OpenDecision } from "../persistence/studioPersistence";
import type { ScoreBlobSource, WorkspacePrefs } from "../persistence/storagePort";
import { useStudioStore, type StudioSnapshot, type StudioState } from "../store/useStudioStore";
import { SolverCancelledError } from "../workers/solverClient";
import type { usePracticePersistence } from "./usePracticePersistence";

interface WorkspaceScoreLifecycleOptions {
  persistence: Pick<ReturnType<typeof usePracticePersistence>, "storage" | "getActive" | "activate" | "persistCurrent" | "importBackup">;
  durablePrefs: CurrentWorkspace["prefs"];
  solveScore(score: ScoreDocument, profile: HandSpanProfile, ignoreAnchors: boolean, state: AnchorState): Promise<SolveResult>;
  restorePreferences(score: ScoreDocument, saved: WorkspacePrefs | undefined): void;
  stopPlayback(): void;
  resetPracticeProgress(): void;
}

async function loadCachedSource(source: ScoreBlobSource, prefs: WorkspacePrefs): Promise<LoadedScoreSession> {
  const session = await loadScoreInput({ fileName: source.fileName, bytes: source.bytes },
    { singleStaffHandOverride: prefs.singleStaffHand });
  return { ...session, sourceFormat: source.sourceFormat ?? "mxl" };
}

/** Resolve and restore score identity, the adjacent repair edge, and archive bindings. */
export function useWorkspaceScoreLifecycle({
  persistence, durablePrefs, solveScore, restorePreferences, stopPlayback, resetPracticeProgress,
}: WorkspaceScoreLifecycleOptions) {
  const openSequence = useRef(0);
  const [openChoice, setOpenChoice] = useState<OpenChoice | null>(null);
  const decision = useRef<((answer: OpenDecision | undefined) => void) | null>(null);
  const answerOpenChoice = (answer: OpenDecision | undefined) => {
    decision.current?.(answer);
    decision.current = null;
    setOpenChoice(null);
  };
  const chooseScoreOpen = (choice: OpenChoice) => new Promise<OpenDecision | undefined>((resolve) => {
    decision.current = resolve;
    setOpenChoice(choice);
  });

  const beginScoreOpen = () => {
    answerOpenChoice(undefined);
    return ++openSequence.current;
  };
  const isCurrent = (generation: number) => generation === openSequence.current;

  const openScoreSession = async (
    session: LoadedScoreSession, name: string, generation: number, cachedPrefs?: WorkspacePrefs,
  ) => {
    const { storage } = persistence;
    const store = useStudioStore.getState();
    const assertCurrent = () => {
      if (openSequence.current !== generation) throw new SolverCancelledError();
    };
    assertCurrent();
    let identity: Awaited<ReturnType<typeof resolvePieceOpen>> | undefined;
    if (storage) {
      // A file should still open if browser storage is unavailable or blocked.
      try {
        if (!cachedPrefs) await persistence.persistCurrent();
        assertCurrent();
        identity = await resolvePieceOpen(storage, session.scoreDoc, async (choice) => {
          assertCurrent();
          const answer = await chooseScoreOpen(choice);
          if (answer === undefined) throw new SolverCancelledError();
          return answer;
        }, cachedPrefs);
      } catch (error) {
        if (cachedPrefs || error instanceof SolverCancelledError) throw error;
      }
    }
    assertCurrent();
    const saved = identity?.prefs;
    const profile = saved?.handSpanProfile ?? store.handSpanProfile;
    const ignore = identity?.fingeringDecision === "adopt-imported"
      ? false : saved?.ignoreExistingFingerings ?? store.ignoreExistingFingerings;
    const score = session.scoreDoc.isSingleStaff && saved?.singleStaffHand &&
      (session.scoreDoc.singleStaffHand ?? session.scoreDoc.defaultSingleStaffHand) !== saved.singleStaffHand
      ? parseMusicXml(session.rawXmlText, { singleStaffHandOverride: saved.singleStaffHand }) : session.scoreDoc;
    const state = applyDraft(score, identity?.draft);
    const result = await solveScore(score, profile, ignore, state);
    const repair = cachedPrefs?.repairEdge;
    let restoredHistory: StudioState["history"] | undefined;
    if (storage && repair) {
      try {
        const source = await readRepairAlternate(storage, repair);
        if (source) {
          const other = await loadCachedSource(source, cachedPrefs);
          assertCurrent();
          const otherScore = other.scoreDoc;
          const anchors = applyDraft(otherScore, repair.otherDraft);
          const solved = await solveScore(otherScore, profile, ignore, anchors);
          const snapshot: StudioSnapshot = { rawXmlText: other.rawXmlText, scoreDoc: otherScore, ...anchors,
            solveResult: solved, fingerByNoteUid: solved.fingerByNoteUid, lastDiff: [] };
          restoredHistory = repair.direction === "undo" ? { past: [snapshot], future: [] } : { past: [], future: [snapshot] };
        }
      } catch (error) {
        if (error instanceof SolverCancelledError) throw error;
        // Missing or damaged alternate must not prevent reopening the active score.
      }
    }
    assertCurrent();
    store.setHandSpanProfile(profile);
    store.setIgnoreExistingFingerings(ignore);
    restorePreferences(score, saved);
    if (storage) persistence.activate(identity?.profile ?? newPieceProfile(score), saved?.freePracticeMinutes, cachedPrefs ? "restore" : "open");
    store.setSolvedScore({ scoreDoc: score, rawXmlText: session.rawXmlText, mxlContainer: session.mxlContainer,
      fileName: name, exportFormat: session.sourceFormat, solveResult: result, resetHistory: true,
      restored: { ...state, history: restoredHistory } });
  };

  const restoreSavedScore = async (generation: number, prefs: WorkspacePrefs | undefined, opened?: StudioState) => {
    const { storage } = persistence;
    if (!storage || !prefs?.scoreFingerprint || !isCurrent(generation)) return false;
    const source = await storage.accessScoreBlob(prefs.scoreFingerprint);
    if (!isCurrent(generation)) return false;
    if (source) {
      await openScoreSession(await loadCachedSource(source, prefs), source.fileName, generation, prefs);
      return true;
    }
    if (opened?.scoreDoc && opened.rawXmlText && getScoreIdentity(opened.scoreDoc).fingerprint === prefs.scoreFingerprint) {
      const scoreDoc = parseMusicXml(opened.rawXmlText, { singleStaffHandOverride: prefs.singleStaffHand });
      await openScoreSession({ rawXmlText: opened.rawXmlText, scoreDoc, sourceFormat: opened.exportFormat,
        mxlContainer: opened.mxlContainer }, opened.fileName, generation, prefs);
      return true;
    }
    return false;
  };

  const restoreLastScore = async (generation: number) => {
    const { storage } = persistence;
    if (storage) await restoreSavedScore(generation, await readLastOpenedPrefs(storage));
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
      decision.current?.(undefined);
      decision.current = null;
    };
  }, [persistence.storage]);

  const handleBackupImport = async (json: string) => {
    const { storage } = persistence;
    if (!storage) return;
    const generation = beginScoreOpen();
    const opened = useStudioStore.getState();
    const activeId = persistence.getActive()?.profile.pieceId;
    stopPlayback();
    await persistence.importBackup(json, async () => {
      try {
        const lastOpened = await readLastOpenedPrefs(storage);
        if (await restoreSavedScore(generation, lastOpened, opened)) return;
        // Metadata-only backups can refer to an unavailable score. Keep working
        // on the open piece if its merged workspace can be restored instead.
        if (activeId && activeId !== lastOpened?.scopeKey && isCurrent(generation)) {
          const prefs = await storage.get("workspacePrefs", activeId);
          if (await restoreSavedScore(generation, prefs, opened)) return;
        }
      } catch (error) {
        if (error instanceof SolverCancelledError) return;
      }
      if (isCurrent(generation)) opened.setStatus("练习数据已导入，请重新上传乐谱");
    });
  };

  const handleArchivePiece = async () => {
    const { storage } = persistence;
    const active = persistence.getActive();
    const state = useStudioStore.getState();
    if (!storage || !active || !state.rawXmlText || !state.scoreDoc) return;
    stopPlayback();
    await persistence.persistCurrent();
    const score = parseMusicXml(state.rawXmlText, { singleStaffHandOverride: state.singleStaffHand });
    const result = await solveScore(score, state.handSpanProfile, state.ignoreExistingFingerings, applyDraft(score));
    const restarted = await archivePieceAndRestart(storage, active.profile, score, durablePrefs);
    resetPracticeProgress();
    persistence.activate(restarted);
    state.setSolvedScore({ scoreDoc: score, rawXmlText: state.rawXmlText, mxlContainer: state.mxlContainer,
      fileName: state.fileName, exportFormat: state.exportFormat, solveResult: result, resetHistory: true });
  };

  return { beginScoreOpen, isCurrent, openScoreSession, openChoice, answerOpenChoice, handleBackupImport, handleArchivePiece };
}
