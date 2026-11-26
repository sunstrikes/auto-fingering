import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PlaybackEngine } from "../audio/playbackEngine";
import type { MacroSection, MotorChunk } from "../chunking/types";
import type { PracticeMode, PracticeStep, ScoreCoord, ScoreDocument } from "../domain/types";
import {
  createPianoCommandRouter,
  hasDualPitchConflict,
  routeKeyboardCommand,
  type KeyboardCommandEventLike,
  type PianoCommandAction,
} from "../guided/pianoCommandKeys";
import {
  evaluateStage0Tick,
  recordStage0StepCompleted,
  recordStage0WrongNote,
} from "../guided/stage0Controller";
import type { MidiInputEvent } from "../midi/webMidi";
import { useGuidedSessionStore } from "../store/useGuidedSessionStore";
import type { PianoCommandBadge } from "../components/UnifiedPiano88";

export interface UseGuidedSessionControllerOptions {
  scoreDoc: ScoreDocument | null;
  practiceSteps: PracticeStep[];
  motorChunks: MotorChunk[];
  macroSections: MacroSection[];
  effectivePracticeMode: PracticeMode;
  playbackSpeed: number;
  playbackEngineRef: React.RefObject<PlaybackEngine | null>;
  countInEnabled: boolean;
  setMidiCaptureMode: (mode: "waiting" | "continuous") => void;
  resetMidiCapture: () => void;
  syncWaitingToStep: (step: PracticeStep | null, state: "playing" | "paused" | "stopped") => void;
  resetWaitingCursor: (stepIndex?: number) => void;
  nowMs: () => number;
}

function coordToTick(scoreDoc: ScoreDocument, coord: ScoreCoord): number {
  const tl = scoreDoc.measureTimelines[coord.measureIndex];
  if (!tl) {
    if (coord.measureIndex >= scoreDoc.measureCount) {
      return Number.POSITIVE_INFINITY;
    }
    return 0;
  }
  return tl.startTick + (coord.beatNum / Math.max(1, coord.beatDen)) * scoreDoc.ticksPerQuarter;
}

function resolveChunkBounds(scoreDoc: ScoreDocument, chunk: MotorChunk) {
  const startTick = coordToTick(scoreDoc, chunk.startCoord);
  const endTick = coordToTick(scoreDoc, chunk.endCoord);
  const startTl = scoreDoc.measureTimelines[chunk.startMeasureIndex];
  const endTl = scoreDoc.measureTimelines[chunk.endMeasureIndex];
  const startScoreSec = startTl
    ? startTl.startSec +
      ((chunk.startCoord.beatNum / Math.max(1, chunk.startCoord.beatDen)) *
        (startTl.endSec - startTl.startSec)) /
        Math.max(1, startTl.timeBeats)
    : 0;
  const endScoreSec = endTl ? endTl.endSec : startScoreSec + 1;
  return { startTick, endTick, startScoreSec, endScoreSec };
}

export function getStepsForChunk(
  scoreDoc: ScoreDocument | null,
  practiceSteps: PracticeStep[],
  chunk: MotorChunk | null,
): PracticeStep[] {
  if (!scoreDoc || !chunk) return [];
  const { startTick, endTick } = resolveChunkBounds(scoreDoc, chunk);
  const byTick = practiceSteps.filter(
    (s) => s.onsetTick >= startTick - 1e-6 && s.onsetTick < endTick - 1e-6,
  );
  if (byTick.length > 0) return byTick;
  return practiceSteps.filter(
    (s) => s.measureIndex >= chunk.startMeasureIndex && s.measureIndex <= chunk.endMeasureIndex,
  );
}

export function getMidisForChunk(
  scoreDoc: ScoreDocument | null,
  chunk: MotorChunk | null,
): number[] {
  if (!scoreDoc || !chunk) return [];
  const { startTick, endTick } = resolveChunkBounds(scoreDoc, chunk);
  const midis: number[] = [];
  for (const ev of scoreDoc.noteEvents) {
    if (ev.onsetTick >= startTick - 1e-6 && ev.onsetTick < endTick - 1e-6) {
      midis.push(ev.midi);
    }
  }
  if (midis.length > 0) return midis;
  return scoreDoc.noteEvents
    .filter(
      (ev) => ev.measureIndex >= chunk.startMeasureIndex && ev.measureIndex <= chunk.endMeasureIndex,
    )
    .map((ev) => ev.midi);
}

/**
 * Coordinates Guided Session lifecycle, Piano Command Keys routing, Stage 0 Waiting Mode
 * auto-graduation, continuous chunk segment playback, Micro-Rest timers, and Suspend/Resume.
 */
export function useGuidedSessionController({
  scoreDoc,
  practiceSteps,
  motorChunks,
  effectivePracticeMode,
  playbackSpeed,
  playbackEngineRef,
  countInEnabled,
  setMidiCaptureMode,
  resetMidiCapture,
  syncWaitingToStep,
  resetWaitingCursor,
  nowMs,
}: UseGuidedSessionControllerOptions) {
  const studioMode = useGuidedSessionStore((s) => s.studioMode);
  const sessionPhase = useGuidedSessionStore((s) => s.sessionPhase);
  const timeBoxMinutes = useGuidedSessionStore((s) => s.timeBoxMinutes);
  const selectedMacroSectionId = useGuidedSessionStore((s) => s.selectedMacroSectionId);
  const chunkQueue = useGuidedSessionStore((s) => s.chunkQueue);
  const currentQueueIndex = useGuidedSessionStore((s) => s.currentQueueIndex);
  const stage0State = useGuidedSessionStore((s) => s.stage0State);
  const bottomSlotView = useGuidedSessionStore((s) => s.bottomSlotView);
  const cc64CommandEnabled = useGuidedSessionStore((s) => s.cc64CommandEnabled);
  const sessionStartedAtMs = useGuidedSessionStore((s) => s.sessionStartedAtMs);
  const microRestStartedAtMs = useGuidedSessionStore((s) => s.microRestStartedAtMs);
  const microRestDurationMs = useGuidedSessionStore((s) => s.microRestDurationMs);
  const microRestReminder = useGuidedSessionStore((s) => s.microRestReminder);
  const commandNotice = useGuidedSessionStore((s) => s.commandNotice);
  const lastBoutSummary = useGuidedSessionStore((s) => s.lastBoutSummary);
  const suspendedSnapshot = useGuidedSessionStore((s) => s.suspendedSnapshot);

  const routerRef = useRef(createPianoCommandRouter());

  // Reset Guided Session store on unmount to avoid leaking across test renders
  useEffect(() => {
    return () => {
      useGuidedSessionStore.getState().reset();
    };
  }, []);

  const launchFilteredChunks = useMemo(() => {
    if (selectedMacroSectionId === null) return motorChunks;
    const filtered = motorChunks.filter((c) => c.sectionId === selectedMacroSectionId);
    return filtered.length > 0 ? filtered : motorChunks;
  }, [motorChunks, selectedMacroSectionId]);

  const activeChunk = useMemo(() => {
    if (sessionPhase === "launch") {
      return launchFilteredChunks[0] ?? null;
    }
    return chunkQueue[currentQueueIndex] ?? null;
  }, [sessionPhase, launchFilteredChunks, chunkQueue, currentQueueIndex]);

  const nextChunk = useMemo(() => {
    if (sessionPhase === "audiation") {
      return chunkQueue[currentQueueIndex + 1] ?? activeChunk;
    }
    return activeChunk;
  }, [sessionPhase, chunkQueue, currentQueueIndex, activeChunk]);

  const activeChunkSteps = useMemo(
    () => getStepsForChunk(scoreDoc, practiceSteps, activeChunk),
    [scoreDoc, practiceSteps, activeChunk],
  );

  const readyChunkSteps = useMemo(
    () => getStepsForChunk(scoreDoc, practiceSteps, nextChunk),
    [scoreDoc, practiceSteps, nextChunk],
  );

  const activeChunkMidis = useMemo(
    () => getMidisForChunk(scoreDoc, activeChunk),
    [scoreDoc, activeChunk],
  );

  const dualPitchDisabled = useMemo(
    () => hasDualPitchConflict(activeChunkMidis),
    [activeChunkMidis],
  );

  const startContinuousChunkPlay = useCallback(
    (chunk: MotorChunk) => {
      if (!scoreDoc || !playbackEngineRef.current) return;
      const { startScoreSec, endScoreSec } = resolveChunkBounds(scoreDoc, chunk);
      const firstStep = getStepsForChunk(scoreDoc, practiceSteps, chunk)[0] ?? null;
      const playStartSec = firstStep ? Math.min(startScoreSec, firstStep.onsetSec) : startScoreSec;
      const safeEndSec = Math.max(playStartSec + 0.05, endScoreSec);
      setMidiCaptureMode("continuous");
      void playbackEngineRef.current.playSegment(scoreDoc, {
        startScoreSec: playStartSec,
        endScoreSec: safeEndSec,
        countInBeats: countInEnabled ? undefined : 0,
        muteTargetHand: false,
        practiceMode: effectivePracticeMode,
        metronomeMode: "full",
        onSegmentComplete: () => {
          const cur = useGuidedSessionStore.getState();
          if (cur.studioMode === "guided" && cur.sessionPhase === "playing") {
            cur.completePlayingBout(nowMs());
          }
        },
      });
    },
    [
      scoreDoc,
      playbackEngineRef,
      practiceSteps,
      countInEnabled,
      effectivePracticeMode,
      setMidiCaptureMode,
      nowMs,
    ],
  );

  const beginChunkStage0 = useCallback(
    (chunk: MotorChunk, steps: PracticeStep[]) => {
      playbackEngineRef.current?.stop();
      setMidiCaptureMode("waiting");
      resetWaitingCursor(0);
      syncWaitingToStep(steps[0] ?? null, "playing");
      if (steps.length === 0) {
        useGuidedSessionStore.getState().graduateStage0ToPlaying(nowMs());
        startContinuousChunkPlay(chunk);
      }
    },
    [
      playbackEngineRef,
      setMidiCaptureMode,
      resetWaitingCursor,
      syncWaitingToStep,
      nowMs,
      startContinuousChunkPlay,
    ],
  );

  const handleStartSession = useCallback(() => {
    if (launchFilteredChunks.length === 0) return;
    const firstChunk = launchFilteredChunks[0];
    const firstSteps = getStepsForChunk(scoreDoc, practiceSteps, firstChunk);
    playbackEngineRef.current?.stop();
    useGuidedSessionStore.getState().startSession({
      chunks: launchFilteredChunks,
      firstChunkSteps: firstSteps,
      speedMultiplier: playbackSpeed,
      nowMs: nowMs(),
      startInStage0: true,
    });
    if (firstSteps.length > 0) {
      setMidiCaptureMode("waiting");
      resetWaitingCursor(0);
      syncWaitingToStep(firstSteps[0] ?? null, "playing");
    } else {
      startContinuousChunkPlay(firstChunk);
    }
  }, [
    launchFilteredChunks,
    scoreDoc,
    practiceSteps,
    playbackEngineRef,
    playbackSpeed,
    nowMs,
    setMidiCaptureMode,
    resetWaitingCursor,
    syncWaitingToStep,
    startContinuousChunkPlay,
  ]);

  const executeCommandAction = useCallback(
    (action: PianoCommandAction) => {
      const store = useGuidedSessionStore.getState();
      if (action === "none") return;

      if (action === "micro-rest-reminder") {
        const started = store.microRestStartedAtMs ?? nowMs();
        const remainingSec = Math.max(
          1,
          Math.ceil((store.microRestDurationMs - Math.max(0, nowMs() - started)) / 1000),
        );
        store.setMicroRestReminder(
          `请再静放双手 ${remainingSec} 秒巩固记忆（按 C8 可跳过）`,
        );
        return;
      }

      if (action === "toggle-view") {
        store.toggleBottomSlotView();
        return;
      }

      if (action === "emergency-pause") {
        if (store.sessionPhase === "playing") {
          playbackEngineRef.current?.pause();
        }
        store.pauseActivePlay(nowMs());
        return;
      }

      if (action === "replay-chunk") {
        const chunk = store.chunkQueue[store.currentQueueIndex];
        if (!chunk) return;
        const steps = getStepsForChunk(scoreDoc, practiceSteps, chunk);
        store.replayCurrentChunk(steps, playbackSpeed, nowMs(), true);
        beginChunkStage0(chunk, steps);
        return;
      }

      if (action === "continue-next" || action === "start-first-note") {
        if (store.sessionPhase === "launch") {
          handleStartSession();
          return;
        }
        if (store.sessionPhase === "paused") {
          const resumeTarget = store.pausedFromPhase ?? "playing";
          store.resumePausedPlay(nowMs());
          const chunk = store.chunkQueue[store.currentQueueIndex];
          if (resumeTarget === "stage0") {
            const steps = getStepsForChunk(scoreDoc, practiceSteps, chunk ?? null);
            const curIdx = store.stage0State?.currentStepIndex ?? 0;
            setMidiCaptureMode("waiting");
            syncWaitingToStep(steps[curIdx] ?? steps[0] ?? null, "playing");
          } else if (chunk) {
            startContinuousChunkPlay(chunk);
          }
          return;
        }
        if (store.sessionPhase === "micro-rest") {
          store.skipMicroRest();
          return;
        }
        if (store.sessionPhase === "audiation" || store.sessionPhase === "summary") {
          const nextIdx = store.currentQueueIndex + 1;
          if (nextIdx >= store.chunkQueue.length) {
            // Loop back or stay at summary; C8 on summary restarts from chunk 0
            if (store.sessionPhase === "summary") {
              handleStartSession();
            }
            return;
          }
          const next = store.chunkQueue[nextIdx];
          const nextSteps = getStepsForChunk(scoreDoc, practiceSteps, next);
          store.advanceToNextChunk(nextSteps, playbackSpeed, nowMs());
          beginChunkStage0(next, nextSteps);
        }
      }
    },
    [
      nowMs,
      playbackEngineRef,
      scoreDoc,
      practiceSteps,
      playbackSpeed,
      beginChunkStage0,
      handleStartSession,
      setMidiCaptureMode,
      syncWaitingToStep,
      startContinuousChunkPlay,
    ],
  );

  const routeGuidedMidiEvent = useCallback(
    (event: MidiInputEvent): { intercepted: boolean } => {
      const store = useGuidedSessionStore.getState();
      if (store.studioMode !== "guided" || store.sessionPhase === "idle" || store.sessionPhase === "suspended") {
        return { intercepted: false };
      }

      const targetSteps =
        store.sessionPhase === "audiation" ? readyChunkSteps : activeChunkSteps;
      const firstTargetMidis = targetSteps[0]?.expectedMidis ?? [];

      const res = routerRef.current.routeMidi(event, {
        phase: store.sessionPhase,
        firstTargetMidis,
        chunkMidis: activeChunkMidis,
        cc64CommandEnabled: store.cc64CommandEnabled,
      });

      if (res.action !== "none") {
        executeCommandAction(res.action);
        return { intercepted: true };
      }

      return { intercepted: false };
    },
    [readyChunkSteps, activeChunkSteps, activeChunkMidis, executeCommandAction],
  );

  const routeGuidedKeyboardEvent = useCallback(
    (event: KeyboardCommandEventLike): boolean => {
      const store = useGuidedSessionStore.getState();
      if (store.studioMode !== "guided" || store.sessionPhase === "idle" || store.sessionPhase === "suspended") {
        return false;
      }
      const action = routeKeyboardCommand(event, store.sessionPhase);
      if (action === "none") return false;
      executeCommandAction(action);
      return true;
    },
    [executeCommandAction],
  );

  // Stage 0 graduation helpers
  const graduateToPlaying = useCallback(
    (graduatedState: NonNullable<typeof stage0State>) => {
      const store = useGuidedSessionStore.getState();
      store.setStage0State(graduatedState);
      store.graduateStage0ToPlaying(nowMs());
      resetWaitingCursor(0);
      syncWaitingToStep(null, "stopped");
      const chunk = store.chunkQueue[store.currentQueueIndex];
      if (chunk) {
        startContinuousChunkPlay(chunk);
      }
    },
    [nowMs, resetWaitingCursor, syncWaitingToStep, startContinuousChunkPlay],
  );

  const handleStage0WrongNote = useCallback(
    (midi: number) => {
      const store = useGuidedSessionStore.getState();
      if (store.studioMode !== "guided" || store.sessionPhase !== "stage0" || !store.stage0State) {
        return;
      }
      const next = recordStage0WrongNote(store.stage0State, midi, nowMs());
      if (next.graduated) {
        graduateToPlaying(next);
      } else {
        store.setStage0State(next);
      }
    },
    [nowMs, graduateToPlaying],
  );

  const handleStage0StepCompleted = useCallback(
    (completedRelativeStepIndex: number) => {
      const store = useGuidedSessionStore.getState();
      if (store.studioMode !== "guided" || store.sessionPhase !== "stage0" || !store.stage0State) {
        return;
      }
      const next = recordStage0StepCompleted(
        store.stage0State,
        completedRelativeStepIndex,
        nowMs(),
      );
      if (next.graduated) {
        graduateToPlaying(next);
      } else {
        store.setStage0State(next);
      }
    },
    [nowMs, graduateToPlaying],
  );

  // Periodic Stage 0 2-minute cap & Micro-Rest timer watcher
  useEffect(() => {
    if (studioMode !== "guided") return;
    if (sessionPhase !== "stage0" && sessionPhase !== "micro-rest") return;

    const timer = globalThis.setInterval(() => {
      const store = useGuidedSessionStore.getState();
      if (store.studioMode !== "guided") return;
      const t = nowMs();
      if (store.sessionPhase === "stage0" && store.stage0State) {
        const next = evaluateStage0Tick(store.stage0State, t);
        if (next.graduated) {
          graduateToPlaying(next);
        } else if (next !== store.stage0State) {
          store.setStage0State(next);
        }
      } else if (store.sessionPhase === "micro-rest" && store.microRestStartedAtMs !== null) {
        if (t - store.microRestStartedAtMs >= store.microRestDurationMs) {
          store.finishMicroRest();
        }
      }
    }, 250);

    return () => {
      globalThis.clearInterval(timer);
    };
  }, [studioMode, sessionPhase, nowMs, graduateToPlaying]);

  const handleSuspendForFingering = useCallback(() => {
    playbackEngineRef.current?.stop();
    resetMidiCapture();
    syncWaitingToStep(null, "stopped");
    useGuidedSessionStore.getState().suspendForFingering(nowMs());
  }, [playbackEngineRef, resetMidiCapture, syncWaitingToStep, nowMs]);

  const handleResumeSuspendedSession = useCallback(() => {
    const store = useGuidedSessionStore.getState();
    if (!store.suspendedSnapshot) return;
    store.resumeSuspendedSession(motorChunks, nowMs());
    const after = useGuidedSessionStore.getState();
    const chunk = after.chunkQueue[after.currentQueueIndex] ?? null;
    if (after.sessionPhase === "stage0" && chunk) {
      const steps = getStepsForChunk(scoreDoc, practiceSteps, chunk);
      const curIdx = after.stage0State?.currentStepIndex ?? 0;
      setMidiCaptureMode("waiting");
      resetWaitingCursor(curIdx);
      syncWaitingToStep(steps[curIdx] ?? steps[0] ?? null, "playing");
    }
  }, [
    motorChunks,
    nowMs,
    scoreDoc,
    practiceSteps,
    setMidiCaptureMode,
    resetWaitingCursor,
    syncWaitingToStep,
  ]);

  const handleEndSession = useCallback(() => {
    playbackEngineRef.current?.stop();
    resetMidiCapture();
    syncWaitingToStep(null, "stopped");
    useGuidedSessionStore.getState().endSession();
  }, [playbackEngineRef, resetMidiCapture, syncWaitingToStep]);

  const commandKeyBadges = useMemo<
    Partial<Record<21 | 22 | 23 | 108, PianoCommandBadge>> | undefined
  >(() => {
    if (studioMode !== "guided" || sessionPhase === "idle" || sessionPhase === "suspended") {
      return undefined;
    }
    if (sessionPhase === "stage0" || sessionPhase === "playing") {
      return {
        21: {
          label: dualPitchDisabled ? "禁用" : "A0+",
          disabled: dualPitchDisabled,
          title: dualPitchDisabled
            ? "当前块包含 A0+A#0，已自动禁用双键紧急暂停"
            : "同时按下 A0+A#0 触发紧急暂停",
        },
        22: {
          label: dualPitchDisabled ? "禁用" : "暂停",
          disabled: dualPitchDisabled,
          title: dualPitchDisabled
            ? "当前块包含 A0+A#0，已自动禁用双键紧急暂停"
            : "同时按下 A0+A#0 触发紧急暂停",
        },
      };
    }
    return {
      21: { label: "重练", title: "A0: 重练当前块" },
      23: {
        label: bottomSlotView === "piano" ? "反馈" : "指法",
        title: "B0: 切换指法与 88 键 / 延迟反馈",
      },
      108: {
        label: sessionPhase === "micro-rest" ? "跳过" : "继续",
        title: "C8: 继续 / 下一块",
      },
    };
  }, [studioMode, sessionPhase, dualPitchDisabled, bottomSlotView]);

  const spotlightChunk = useMemo(() => {
    if (
      studioMode !== "guided" ||
      sessionPhase === "idle" ||
      sessionPhase === "launch" ||
      sessionPhase === "suspended"
    ) {
      return null;
    }
    const target = sessionPhase === "audiation" ? nextChunk : activeChunk;
    if (!target) return null;
    return {
      chunkId: target.chunkId,
      startMeasureIndex: target.startMeasureIndex,
      endMeasureIndex: target.endMeasureIndex,
    };
  }, [studioMode, sessionPhase, activeChunk, nextChunk]);

  const remainingMinutes = useMemo(() => {
    if (sessionStartedAtMs === null) return timeBoxMinutes;
    const elapsedMin = Math.floor(Math.max(0, nowMs() - sessionStartedAtMs) / 60_000);
    return Math.max(0, timeBoxMinutes - elapsedMin);
  }, [sessionStartedAtMs, timeBoxMinutes, nowMs, sessionPhase, currentQueueIndex]);

  return {
    studioMode,
    sessionPhase,
    timeBoxMinutes,
    selectedMacroSectionId,
    chunkQueue,
    currentQueueIndex,
    activeChunk,
    nextChunk,
    activeChunkSteps,
    activeChunkMidis,
    dualPitchDisabled,
    stage0State,
    bottomSlotView,
    cc64CommandEnabled,
    microRestStartedAtMs,
    microRestDurationMs,
    microRestReminder,
    commandNotice,
    lastBoutSummary,
    suspendedSnapshot,
    commandKeyBadges,
    spotlightChunk,
    remainingMinutes,

    enterGuidedLaunch: () => useGuidedSessionStore.getState().enterGuidedLaunch(),
    returnToFreeStudio: () => useGuidedSessionStore.getState().returnToFreeStudio(),
    setTimeBoxMinutes: (m: 15 | 25 | 40) =>
      useGuidedSessionStore.getState().setTimeBoxMinutes(m),
    setSelectedMacroSectionId: (id: string | null) =>
      useGuidedSessionStore.getState().setSelectedMacroSectionId(id),
    setCc64CommandEnabled: (enabled: boolean) =>
      useGuidedSessionStore.getState().setCc64CommandEnabled(enabled),
    setBottomSlotView: (v: "piano" | "feedback") =>
      useGuidedSessionStore.getState().setBottomSlotView(v),

    handleStartSession,
    executeCommandAction,
    routeGuidedMidiEvent,
    routeGuidedKeyboardEvent,
    handleStage0WrongNote,
    handleStage0StepCompleted,
    handleSuspendForFingering,
    handleResumeSuspendedSession,
    handleEndSession,
  };
}
