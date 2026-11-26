import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PianoAudioEngine } from "../audio/pianoAudio";
import type { PlaybackClockAnchor, PlaybackEngine } from "../audio/playbackEngine";
import type { MacroSection, MotorChunk } from "../chunking/types";
import type {
  PracticeMode,
  PracticeStep,
  ScoreCoord,
  ScoreDocument,
  SolveResult,
} from "../domain/types";
import { analyzeContinuousPerformanceWindow } from "../guided/acousticProfile";
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
import {
  completeAudiationPreview,
  createMicroRestState,
  deriveAudiationCue,
  evaluateAudiationImageryTick,
  evaluateMicroRestTick,
  interruptAudiationPreview,
  markAudiationPreviewPlaying,
  shouldAutoTriggerAudiationPreview,
  type AudiationInterruptReason,
  type AudiationPreviewMode,
} from "../guided/transitionFlow";
import type { MidiInputEvent } from "../midi/webMidi";
import { useGuidedSessionStore } from "../store/useGuidedSessionStore";
import type { PianoCommandBadge } from "../components/UnifiedPiano88";

export interface UseGuidedSessionControllerOptions {
  scoreDoc: ScoreDocument | null;
  solveResult: SolveResult | null;
  practiceSteps: PracticeStep[];
  motorChunks: MotorChunk[];
  macroSections: MacroSection[];
  effectivePracticeMode: PracticeMode;
  playbackSpeed: number;
  playbackEngineRef: React.RefObject<PlaybackEngine | null>;
  audioEngineRef: React.RefObject<PianoAudioEngine | null>;
  countInEnabled: boolean;
  setMidiCaptureMode: (mode: "waiting" | "continuous") => void;
  resetMidiCapture: () => void;
  sliceContinuousMidiWindow?: (fromMs: number, toMs: number) => MidiInputEvent[];
  deviceNames?: readonly string[];
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
  solveResult,
  practiceSteps,
  motorChunks,
  effectivePracticeMode,
  playbackSpeed,
  playbackEngineRef,
  audioEngineRef,
  countInEnabled,
  setMidiCaptureMode,
  resetMidiCapture,
  sliceContinuousMidiWindow,
  deviceNames,
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
  const microRestDurationSec = useGuidedSessionStore((s) => s.microRestDurationSec);
  const audiationPreviewMode = useGuidedSessionStore((s) => s.audiationPreviewMode);
  const audiationImageryTimerEnabled = useGuidedSessionStore((s) => s.audiationImageryTimerEnabled);
  const sessionStartedAtMs = useGuidedSessionStore((s) => s.sessionStartedAtMs);
  const microRestStartedAtMs = useGuidedSessionStore((s) => s.microRestStartedAtMs);
  const microRestDurationMs = useGuidedSessionStore((s) => s.microRestDurationMs);
  const microRestReminder = useGuidedSessionStore((s) => s.microRestReminder);
  const microRestState = useGuidedSessionStore((s) => s.microRestState);
  const audiationState = useGuidedSessionStore((s) => s.audiationState);
  const chunkPassCountsById = useGuidedSessionStore((s) => s.chunkPassCountsById);
  const commandNotice = useGuidedSessionStore((s) => s.commandNotice);
  const lastBoutSummary = useGuidedSessionStore((s) => s.lastBoutSummary);
  const suspendedSnapshot = useGuidedSessionStore((s) => s.suspendedSnapshot);

  const routerRef = useRef(createPianoCommandRouter());
  const previewTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const previewTokenRef = useRef(0);
  const autoPreviewFiredKeyRef = useRef<string | null>(null);
  const [, setTransitionTickMs] = useState<number>(() => nowMs());

  const clearPreviewTimer = useCallback(() => {
    if (previewTimerRef.current !== null) {
      globalThis.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  }, []);

  // Reset Guided Session store & audio preview timers on unmount to avoid leaking across test renders
  useEffect(() => {
    return () => {
      previewTokenRef.current += 1;
      clearPreviewTimer();
      useGuidedSessionStore.getState().reset();
    };
  }, [clearPreviewTimer]);

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

  const stopAudiationPreview = useCallback(
    (reason: AudiationInterruptReason = "manual-stop") => {
      previewTokenRef.current += 1;
      clearPreviewTimer();
      audioEngineRef.current?.stopAll();
      const store = useGuidedSessionStore.getState();
      if (store.audiationState) {
        const next = interruptAudiationPreview(store.audiationState, reason);
        if (next !== store.audiationState) {
          store.setAudiationState(next);
        }
      }
    },
    [audioEngineRef, clearPreviewTimer],
  );

  const triggerAudiationPreview = useCallback(
    (targetChunk: MotorChunk | null = nextChunk) => {
      const engine = audioEngineRef.current;
      if (!scoreDoc || !targetChunk || !engine) return;
      clearPreviewTimer();
      engine.stopAll();

      const { startTick, endTick, startScoreSec } = resolveChunkBounds(scoreDoc, targetChunk);
      const previewNotes = scoreDoc.noteEvents.filter(
        (ev) =>
          !ev.isTieStop &&
          ev.onsetTick >= startTick - 1e-6 &&
          ev.onsetTick < endTick - 1e-6,
      );
      if (previewNotes.length === 0) return;

      const token = ++previewTokenRef.current;
      const store = useGuidedSessionStore.getState();
      if (store.audiationState) {
        store.setAudiationState(markAudiationPreviewPlaying(store.audiationState));
      }

      const chunkStartSec = Math.min(startScoreSec, previewNotes[0].onsetSec);
      const scheduleNotes = () => {
        if (previewTokenRef.current !== token) return;
        const activeEngine = audioEngineRef.current;
        if (!activeEngine) return;
        const ctx = activeEngine.getAudioContext();
        const baseTime = ctx.currentTime + 0.02;
        const safeSpeed = Number.isFinite(playbackSpeed) && playbackSpeed > 0 ? playbackSpeed : 1;
        let maxRelEndSec = 0.2;

        for (const note of previewNotes) {
          const relStartSec = Math.max(0, (note.onsetSec - chunkStartSec) / safeSpeed);
          const durSec = Math.max(0.08, Math.min(1.5, note.durationSec / safeSpeed));
          maxRelEndSec = Math.max(maxRelEndSec, relStartSec + durSec);
          const isTargetHand =
            effectivePracticeMode === "both" ||
            (effectivePracticeMode === "rh-only" && note.hand === "RH") ||
            (effectivePracticeMode === "lh-only" && note.hand === "LH");
          activeEngine.triggerNote({
            midi: note.midi,
            time: baseTime + relStartSec,
            duration: durSec,
            velocity: isTargetHand ? 50 : 36,
          });
        }

        previewTimerRef.current = globalThis.setTimeout(() => {
          if (previewTokenRef.current !== token) return;
          previewTimerRef.current = null;
          const curStore = useGuidedSessionStore.getState();
          if (curStore.audiationState) {
            curStore.setAudiationState(completeAudiationPreview(curStore.audiationState));
          }
        }, Math.ceil(maxRelEndSec * 1000) + 60);
      };

      const status = engine.getStatus();
      if (status === "samples" || status === "synth") {
        scheduleNotes();
      } else {
        void engine.prepare().then(scheduleNotes);
      }
    },
    [scoreDoc, nextChunk, audioEngineRef, clearPreviewTimer, playbackSpeed, effectivePracticeMode],
  );

  useEffect(() => {
    if (studioMode !== "guided" || sessionPhase !== "audiation" || !audiationState) {
      autoPreviewFiredKeyRef.current = null;
      return;
    }
    const key = `${audiationState.enteredAtMs}:${audiationState.chunkId ?? ""}`;
    if (autoPreviewFiredKeyRef.current === key) return;
    if (shouldAutoTriggerAudiationPreview(audiationState)) {
      autoPreviewFiredKeyRef.current = key;
      triggerAudiationPreview(nextChunk);
    }
  }, [studioMode, sessionPhase, audiationState, nextChunk, triggerAudiationPreview]);

  const startContinuousChunkPlay = useCallback(
    (chunk: MotorChunk) => {
      if (!scoreDoc || !playbackEngineRef.current) return;
      const { startScoreSec, endScoreSec } = resolveChunkBounds(scoreDoc, chunk);
      const firstStep = getStepsForChunk(scoreDoc, practiceSteps, chunk)[0] ?? null;
      const playStartSec = firstStep ? Math.min(startScoreSec, firstStep.onsetSec) : startScoreSec;
      const safeEndSec = Math.max(playStartSec + 0.05, endScoreSec);
      setMidiCaptureMode("continuous");
      let activeAnchor: PlaybackClockAnchor | null = null;
      void playbackEngineRef.current.playSegment(scoreDoc, {
        startScoreSec: playStartSec,
        endScoreSec: safeEndSec,
        countInBeats: countInEnabled ? undefined : 0,
        muteTargetHand: false,
        practiceMode: effectivePracticeMode,
        metronomeMode: "full",
        onClockAnchor: (anchor) => {
          activeAnchor = anchor;
        },
        onSegmentComplete: () => {
          const cur = useGuidedSessionStore.getState();
          if (cur.studioMode === "guided" && cur.sessionPhase === "playing") {
            const chunkSteps = getStepsForChunk(scoreDoc, practiceSteps, chunk);
            const analyzed =
              activeAnchor && sliceContinuousMidiWindow
                ? analyzeContinuousPerformanceWindow({
                    clockAnchor: activeAnchor,
                    expectedSteps: chunkSteps,
                    scoreDoc,
                    practiceMode: effectivePracticeMode,
                    sliceContinuousMidiWindow,
                    endClockMs: Math.max(performance.now(), nowMs()),
                    deviceNames,
                  })
                : null;
            if (analyzed) {
              cur.completePlayingBout(nowMs(), {
                accuracy: analyzed.attribution.fluency.pitchAccuracy,
                acousticProfile: analyzed.acousticProfile,
              });
              return;
            }
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
      sliceContinuousMidiWindow,
      deviceNames,
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
        store.recordMicroRestAccidentalKey(nowMs());
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
        if (store.sessionPhase === "audiation") {
          stopAudiationPreview("a0");
        }
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
          store.skipMicroRest(nowMs());
          return;
        }
        if (store.sessionPhase === "audiation" || store.sessionPhase === "summary") {
          if (store.sessionPhase === "audiation") {
            stopAudiationPreview(action === "start-first-note" ? "first-note" : "c8");
          }
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
      stopAudiationPreview,
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

  // Periodic Stage 0 2-minute cap, Micro-Rest countdown, and optional Audiation imagery timer watcher
  useEffect(() => {
    if (studioMode !== "guided") return;
    const watchAudiationTimer = sessionPhase === "audiation" && audiationImageryTimerEnabled;
    if (sessionPhase !== "stage0" && sessionPhase !== "micro-rest" && !watchAudiationTimer) return;

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
      } else if (store.sessionPhase === "micro-rest") {
        const mrState =
          store.microRestState ??
          createMicroRestState({
            startedAtMs: store.microRestStartedAtMs ?? t,
            durationSec: store.microRestDurationSec,
          });
        const tick = evaluateMicroRestTick(mrState, t);
        if (tick.completed) {
          store.finishMicroRest(t);
        } else {
          setTransitionTickMs(t);
        }
      } else if (store.sessionPhase === "audiation" && store.audiationImageryTimerEnabled) {
        setTransitionTickMs(t);
      }
    }, 250);

    return () => {
      globalThis.clearInterval(timer);
    };
  }, [studioMode, sessionPhase, audiationImageryTimerEnabled, nowMs, graduateToPlaying]);

  const handleSuspendForFingering = useCallback(() => {
    stopAudiationPreview("manual-stop");
    playbackEngineRef.current?.stop();
    resetMidiCapture();
    syncWaitingToStep(null, "stopped");
    useGuidedSessionStore.getState().suspendForFingering(nowMs());
  }, [stopAudiationPreview, playbackEngineRef, resetMidiCapture, syncWaitingToStep, nowMs]);

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
    stopAudiationPreview("manual-stop");
    playbackEngineRef.current?.stop();
    resetMidiCapture();
    syncWaitingToStep(null, "stopped");
    useGuidedSessionStore.getState().endSession();
  }, [stopAudiationPreview, playbackEngineRef, resetMidiCapture, syncWaitingToStep]);

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

  const microRestTick = evaluateMicroRestTick(
    microRestState ??
      createMicroRestState({
        startedAtMs: microRestStartedAtMs ?? nowMs(),
        durationSec: microRestDurationSec,
      }),
    nowMs(),
  );

  const audiationCue = useMemo(
    () =>
      deriveAudiationCue({
        nextChunk: sessionPhase === "audiation" ? nextChunk : null,
        nextChunkSteps: readyChunkSteps,
        solveResult,
        practiceMode: effectivePracticeMode,
        onsetSlices: scoreDoc?.onsetSlices,
        historicalPassCount: nextChunk ? (chunkPassCountsById[nextChunk.chunkId] ?? 0) : 0,
        previewMode: audiationPreviewMode,
      }),
    [
      sessionPhase,
      nextChunk,
      readyChunkSteps,
      solveResult,
      effectivePracticeMode,
      scoreDoc?.onsetSlices,
      chunkPassCountsById,
      audiationPreviewMode,
    ],
  );

  const audiationImageryTick = audiationState
    ? evaluateAudiationImageryTick(audiationState, nowMs())
    : { active: false, remainingMs: 0, remainingSec: 0, completed: false };

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
    microRestDurationSec,
    audiationPreviewMode,
    audiationImageryTimerEnabled,
    microRestStartedAtMs,
    microRestDurationMs,
    microRestReminder,
    microRestState,
    microRestTick,
    audiationState,
    audiationCue,
    audiationImageryTick,
    commandNotice,
    lastBoutSummary,
    suspendedSnapshot,
    commandKeyBadges,
    spotlightChunk,
    remainingMinutes,

    enterGuidedLaunch: () => useGuidedSessionStore.getState().enterGuidedLaunch(),
    returnToFreeStudio: () => {
      stopAudiationPreview("manual-stop");
      useGuidedSessionStore.getState().returnToFreeStudio();
    },
    setTimeBoxMinutes: (m: 15 | 25 | 40) =>
      useGuidedSessionStore.getState().setTimeBoxMinutes(m),
    setSelectedMacroSectionId: (id: string | null) =>
      useGuidedSessionStore.getState().setSelectedMacroSectionId(id),
    setCc64CommandEnabled: (enabled: boolean) =>
      useGuidedSessionStore.getState().setCc64CommandEnabled(enabled),
    setMicroRestDurationSec: (sec: number) =>
      useGuidedSessionStore.getState().setMicroRestDurationSec(sec),
    setAudiationPreviewMode: (mode: AudiationPreviewMode) =>
      useGuidedSessionStore.getState().setAudiationPreviewMode(mode),
    setAudiationImageryTimerEnabled: (enabled: boolean) =>
      useGuidedSessionStore.getState().setAudiationImageryTimerEnabled(enabled),
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
    triggerAudiationPreview: () => triggerAudiationPreview(nextChunk),
    stopAudiationPreview,
  };
}
