import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PianoAudioEngine } from "../audio/pianoAudio";
import type { PlaybackClockAnchor, PlaybackEngine } from "../audio/playbackEngine";
import type {
  ChunkJunction,
  MacroSection,
  MotorChunk,
  PassageCluster,
  PerformanceCue,
} from "../chunking/types";
import type {
  PracticeMode,
  PracticeStep,
  ScoreCoord,
  ScoreDocument,
  SolveResult,
} from "../domain/types";
import {
  analyzeAcousticProfile,
  toPracticeEventAcoustic,
} from "../guided/acousticProfile";
import { attributeContinuousBout, type SwitchPointSpec } from "../guided/boundedAttribution";
import {
  buildLinkedVerificationSpan,
  completeBridgeLinkedVerification,
  createBridgeWindowState,
  createEmpiricalJunctionTracker,
  deriveBridgeHandPositionPreview,
  isEmpiricalJunctionFault,
  recordBridgeWindowPass,
  recordEmpiricalJunctionOutcome,
  resolveBridgeWindowSpan,
  skipBridgeWindow,
  type BridgeHandPositionPreview,
} from "../guided/bridgeWindow";
import {
  buildColdStartProbeItems,
  computeColdProbeIsCrossDay,
  computeColdProbeSpan,
  evaluateColdStartProbeOutcome,
  isColdProbeLocallyUnlocked,
} from "../guided/coldStartProbe";
import {
  computeAutoMidiGrade,
  reducePiecePracticeState,
  roundSpeed,
  spanContains,
  timestampToUtcDateKey,
} from "../guided/motorFsrs";
import {
  EARLY_MACRO_REST_DURATION_MS,
  advanceMotorScheduler,
  createMotorSchedulerState,
  recordSchedulerBoutOutcome,
  recordSchedulerStage0Graduated,
  shouldOfferEarlyMacroRest,
  skipCircuitBreaker,
} from "../guided/motorScheduler";
import {
  createPianoCommandRouter,
  hasDualPitchConflict,
  routeKeyboardCommand,
  type KeyboardCommandEventLike,
  type PianoCommandAction,
} from "../guided/pianoCommandKeys";
import { writeDerivedSnapshot, loadOrReducePiecePracticeState } from "../guided/replayInvalidation";
import {
  planGuidedSession,
  planQuickTriageSession,
  type PlannedQueueItem,
} from "../guided/sessionPlanner";
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
import { getScoreIdentity } from "../persistence/fingerprint";
import type {
  PieceProfile,
  PracticeEvent,
  PracticeStoragePort,
} from "../persistence/storagePort";
import { useGuidedSessionStore } from "../store/useGuidedSessionStore";
import type { PianoCommandBadge } from "../components/UnifiedPiano88";

export interface UseGuidedSessionControllerOptions {
  scoreDoc: ScoreDocument | null;
  solveResult: SolveResult | null;
  practiceSteps: PracticeStep[];
  motorChunks: MotorChunk[];
  macroSections: MacroSection[];
  chunkJunctions?: ChunkJunction[];
  passageClusters?: PassageCluster[];
  performanceCues?: PerformanceCue[];
  effectivePracticeMode: PracticeMode;
  playbackSpeed: number;
  playbackEngineRef: React.RefObject<PlaybackEngine | null>;
  audioEngineRef: React.RefObject<PianoAudioEngine | null>;
  countInEnabled: boolean;
  practiceStorage?: PracticeStoragePort | null;
  activePieceProfile?: PieceProfile | null;
  getTimezoneOffsetMin?: () => number;
  onChangePlaybackSpeed?: (speed: number) => void;
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
  macroSections,
  chunkJunctions = [],
  passageClusters = [],
  performanceCues = [],
  effectivePracticeMode,
  playbackSpeed,
  playbackEngineRef,
  audioEngineRef,
  countInEnabled,
  practiceStorage = null,
  activePieceProfile = null,
  getTimezoneOffsetMin,
  onChangePlaybackSpeed,
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
  const plannedQueue = useGuidedSessionStore((s) => s.plannedQueue);
  const currentQueueIndex = useGuidedSessionStore((s) => s.currentQueueIndex);
  const stage0State = useGuidedSessionStore((s) => s.stage0State);
  const piecePracticeState = useGuidedSessionStore((s) => s.piecePracticeState);
  const overspeedProbeEnabled = useGuidedSessionStore((s) => s.overspeedProbeEnabled);
  const blindColdProbeEnabled = useGuidedSessionStore((s) => s.blindColdProbeEnabled);
  const blindPeekUntilMs = useGuidedSessionStore((s) => s.blindPeekUntilMs);
  const bridgeWindowState = useGuidedSessionStore((s) => s.bridgeWindowState);
  const lastProbeResult = useGuidedSessionStore((s) => s.lastProbeResult);
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
  const macroRestStartedAtMs = useGuidedSessionStore((s) => s.macroRestStartedAtMs);
  const macroRestDurationMs = useGuidedSessionStore((s) => s.macroRestDurationMs);
  const audiationState = useGuidedSessionStore((s) => s.audiationState);
  const chunkPassCountsById = useGuidedSessionStore((s) => s.chunkPassCountsById);
  const commandNotice = useGuidedSessionStore((s) => s.commandNotice);
  const lastBoutSummary = useGuidedSessionStore((s) => s.lastBoutSummary);
  const suspendedSnapshot = useGuidedSessionStore((s) => s.suspendedSnapshot);

  const routerRef = useRef(createPianoCommandRouter());
  const previewTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const peekTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const peekExemptTimestampsRef = useRef<Set<number>>(new Set());
  const empiricalTrackerRef = useRef(createEmpiricalJunctionTracker());
  const previewTokenRef = useRef(0);
  const autoPreviewFiredKeyRef = useRef<string | null>(null);
  const seenChunksInSessionRef = useRef<Set<string>>(new Set());
  const eventSeqRef = useRef(0);
  const startContinuousChunkPlayRef = useRef<
    (chunk: MotorChunk, plannedItem?: PlannedQueueItem | null) => void
  >(() => {});
  const activeBoutCtxRef = useRef<{
    chunk: MotorChunk;
    plannedItem: PlannedQueueItem | null;
    expectedSteps: PracticeStep[];
    startScoreSec: number;
    endScoreSec: number;
    speedMultiplier: number;
    practiceMode: PracticeMode;
    startedAtMs: number;
    anchor: PlaybackClockAnchor | null;
    isLinkedVerify?: boolean;
    switchPointSpec?: SwitchPointSpec;
  } | null>(null);
  const [, setTransitionTickMs] = useState<number>(() => nowMs());

  const resolveTimezoneOffsetMin = useCallback(
    (tsMs: number) => getTimezoneOffsetMin?.() ?? new Date(tsMs).getTimezoneOffset(),
    [getTimezoneOffsetMin],
  );

  const scoreFingerprint = useMemo(
    () => (scoreDoc ? getScoreIdentity(scoreDoc).fingerprint : ""),
    [scoreDoc],
  );

  // Load persisted Motor-FSRS PiecePracticeState whenever piece or chunks refresh
  useEffect(() => {
    if (!practiceStorage || !activePieceProfile) return;
    let cancelled = false;
    const t = nowMs();
    const tz = resolveTimezoneOffsetMin(t);
    const localDateKey = timestampToUtcDateKey(t, tz);
    void loadOrReducePiecePracticeState(practiceStorage, activePieceProfile.pieceId, {
      pieceId: activePieceProfile.pieceId,
      chunks: motorChunks,
      junctions: chunkJunctions,
      chunkOverrides: activePieceProfile.chunkOverrides,
      nowTimestampMs: t,
      nowLocalDateKey: localDateKey,
    }).then(({ state }) => {
      if (cancelled) return;
      const store = useGuidedSessionStore.getState();
      store.setPiecePracticeState(state);
      const passCounts: Record<string, number> = {};
      for (const [id, unit] of Object.entries(state.chunkStates)) {
        if (unit.reviewCount > 0) passCounts[id] = unit.reviewCount;
      }
      store.seedChunkPassCounts(passCounts);
    });
    return () => {
      cancelled = true;
    };
  }, [
    practiceStorage,
    activePieceProfile?.pieceId,
    activePieceProfile?.chunkOverrides,
    motorChunks,
    chunkJunctions,
    nowMs,
    resolveTimezoneOffsetMin,
  ]);

  const sessionPlan = useMemo(() => {
    const t = nowMs();
    const tz = resolveTimezoneOffsetMin(t);
    const localDateKey = timestampToUtcDateKey(t, tz);
    return planGuidedSession({
      timeBoxMinutes,
      macroSections,
      motorChunks,
      chunkJunctions,
      passageClusters,
      performanceCues,
      piecePracticeState,
      selectedMacroSectionId,
      practiceMode: effectivePracticeMode,
      nowTimestampMs: t,
      nowLocalDateKey: localDateKey,
    });
  }, [
    timeBoxMinutes,
    macroSections,
    motorChunks,
    chunkJunctions,
    passageClusters,
    performanceCues,
    piecePracticeState,
    selectedMacroSectionId,
    effectivePracticeMode,
    nowMs,
    resolveTimezoneOffsetMin,
  ]);

  const clearPreviewTimer = useCallback(() => {
    if (previewTimerRef.current !== null) {
      globalThis.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  }, []);

  const clearPeekTimer = useCallback(() => {
    if (peekTimerRef.current !== null) {
      globalThis.clearTimeout(peekTimerRef.current);
      peekTimerRef.current = null;
    }
  }, []);

  // Reset Guided Session store & audio preview timers on unmount to avoid leaking across test renders
  useEffect(() => {
    return () => {
      previewTokenRef.current += 1;
      clearPreviewTimer();
      clearPeekTimer();
      useGuidedSessionStore.getState().reset();
    };
  }, [clearPreviewTimer, clearPeekTimer]);

  const launchFilteredChunks = useMemo(() => {
    if (selectedMacroSectionId === null) return motorChunks;
    const filtered = motorChunks.filter((c) => c.sectionId === selectedMacroSectionId);
    return filtered.length > 0 ? filtered : motorChunks;
  }, [motorChunks, selectedMacroSectionId]);

  const activeChunk = useMemo(() => {
    if (sessionPhase === "launch") {
      return sessionPlan.items[0]?.chunk ?? launchFilteredChunks[0] ?? null;
    }
    return chunkQueue[currentQueueIndex] ?? null;
  }, [sessionPhase, sessionPlan, launchFilteredChunks, chunkQueue, currentQueueIndex]);

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

  const resolveBoutSpanAndSteps = useCallback(
    (chunk: MotorChunk, plannedItem: PlannedQueueItem | null) => {
      if (!scoreDoc) {
        return {
          expectedSteps: [] as PracticeStep[],
          startScoreSec: 0,
          endScoreSec: 1,
          countInBeats: countInEnabled ? undefined : 0,
          switchPointSpec: undefined as SwitchPointSpec | undefined,
          isLinkedVerify: false,
        };
      }

      const curBridge = useGuidedSessionStore.getState().bridgeWindowState;
      if (
        plannedItem?.boutKind === "bridge" &&
        curBridge &&
        curBridge.phase === "linked-verify"
      ) {
        const linked = buildLinkedVerificationSpan(
          scoreDoc,
          practiceSteps,
          curBridge.leftChunk,
          curBridge.rightChunk,
        );
        return {
          expectedSteps: linked.steps,
          startScoreSec: linked.startScoreSec,
          endScoreSec: linked.endScoreSec,
          countInBeats: countInEnabled ? undefined : 0,
          switchPointSpec: undefined as SwitchPointSpec | undefined,
          isLinkedVerify: true,
        };
      }

      if (plannedItem?.boutKind === "bridge" && plannedItem.junction) {
        const leftChunk =
          motorChunks.find((c) => c.chunkId === plannedItem.junction!.leftChunkId) ?? chunk;
        const rightChunk =
          motorChunks.find((c) => c.chunkId === plannedItem.junction!.rightChunkId) ?? chunk;
        const span = resolveBridgeWindowSpan({
          scoreDoc,
          practiceSteps,
          junction: plannedItem.junction,
          leftChunk,
          rightChunk,
        });
        return {
          expectedSteps: span.steps.length > 0 ? span.steps : getStepsForChunk(scoreDoc, practiceSteps, chunk),
          startScoreSec: span.startScoreSec,
          endScoreSec: span.endScoreSec,
          countInBeats: span.countInBeats,
          switchPointSpec: undefined as SwitchPointSpec | undefined,
          isLinkedVerify: false,
        };
      }

      if (plannedItem?.boutKind === "cold-probe" && plannedItem.cue) {
        const probeSpan = computeColdProbeSpan({
          cue: plannedItem.cue,
          allCues: performanceCues,
          motorChunks,
          passageClusters,
          scoreDoc,
          practiceSteps,
        });
        const steps =
          probeSpan.expectedSteps.length > 0
            ? probeSpan.expectedSteps
            : getStepsForChunk(scoreDoc, practiceSteps, chunk);
        return {
          expectedSteps: steps,
          startScoreSec: probeSpan.startScoreSec,
          endScoreSec: probeSpan.endScoreSec,
          countInBeats: probeSpan.countInBeats,
          switchPointSpec: probeSpan.switchPointSpec,
          isLinkedVerify: false,
        };
      }

      const steps = getStepsForChunk(scoreDoc, practiceSteps, chunk);
      const { startScoreSec, endScoreSec } = resolveChunkBounds(scoreDoc, chunk);
      const firstStep = steps[0] ?? null;
      const playStartSec = firstStep ? Math.min(startScoreSec, firstStep.onsetSec) : startScoreSec;
      const safeEndSec = Math.max(playStartSec + 0.05, endScoreSec);
      return {
        expectedSteps: steps,
        startScoreSec: playStartSec,
        endScoreSec: safeEndSec,
        countInBeats: countInEnabled ? undefined : 0,
        switchPointSpec: undefined as SwitchPointSpec | undefined,
        isLinkedVerify: false,
      };
    },
    [scoreDoc, practiceSteps, countInEnabled, motorChunks, performanceCues, passageClusters],
  );

  const finalizeContinuousBout = useCallback(() => {
    const cur = useGuidedSessionStore.getState();
    const ctx = activeBoutCtxRef.current;
    if (!ctx || cur.studioMode !== "guided" || cur.sessionPhase !== "playing" || !scoreDoc) {
      return;
    }
    activeBoutCtxRef.current = null;

    const anchor: PlaybackClockAnchor = ctx.anchor ?? {
      t0PerfMs: globalThis.performance?.now?.() ?? Date.now(),
      audioStartTimeSec: 0,
      startScoreSec: ctx.startScoreSec,
      endScoreSec: ctx.endScoreSec,
      speedMultiplier: ctx.speedMultiplier,
    };

    const segDurationMs =
      ((ctx.endScoreSec - ctx.startScoreSec) / Math.max(0.25, ctx.speedMultiplier)) * 1000;
    const midiEvents = sliceContinuousMidiWindow
      ? sliceContinuousMidiWindow(anchor.t0PerfMs - 300, anchor.t0PerfMs + segDurationMs + 2000)
      : [];
    resetMidiCapture();

    let switchPoint: SwitchPointSpec | undefined = ctx.switchPointSpec;
    if (!switchPoint) {
      for (const cluster of passageClusters) {
        for (const inst of cluster.instances) {
          if (
            inst.switchPoint &&
            inst.switchPoint.alternateBranchMidis.length > 0 &&
            spanContains(inst.startCoord, inst.endCoord, ctx.chunk.startCoord, ctx.chunk.endCoord)
          ) {
            switchPoint = {
              startScoreSec:
                scoreDoc.measureTimelines[inst.switchPoint.measureIndex]?.startSec ?? ctx.startScoreSec,
              alternateBranches: [
                {
                  branchId: inst.switchPoint.alternateBranchLabels[0] ?? inst.switchPoint.switchId,
                  stepMidis: inst.switchPoint.alternateBranchMidis,
                },
              ],
            };
            break;
          }
        }
      }
    }

    const isExemptPeekKey = (ev: MidiInputEvent) =>
      ev.type !== "sustain" &&
      ev.midi === 23 &&
      peekExemptTimestampsRef.current.has(ev.timeStampMs);

    const attr = attributeContinuousBout({
      clockAnchor: anchor,
      expectedSteps: ctx.expectedSteps,
      midiEvents,
      measureTimelines: scoreDoc.measureTimelines,
      practiceMode: ctx.practiceMode,
      junctionBoundaryCoord: ctx.plannedItem?.junction?.boundaryCoord,
      junctionStepIndex: ctx.plannedItem?.junction?.bridgeWindowSteps.junctionStepIndex,
      isExemptPeekKey,
      switchPoint,
    });

    const autoGrade = computeAutoMidiGrade({
      practiceMode: ctx.practiceMode,
      speedMultiplier: ctx.speedMultiplier,
      fluency: attr.fluency,
      measureFaultCounts: attr.measureFaultCounts,
    });

    const hasAcousticKeystrokes =
      ctx.expectedSteps.length > 0 &&
      midiEvents.some((ev) => ev.type === "noteon" && ev.velocity > 1);
    const acousticProfile = hasAcousticKeystrokes
      ? analyzeAcousticProfile({
          attribution: attr,
          midiEvents,
          speedMultiplier: anchor.speedMultiplier,
          practiceMode: ctx.practiceMode,
          measureTimelines: scoreDoc.measureTimelines,
          pedalIntervals: scoreDoc.pedalIntervals,
          expectedSteps: ctx.expectedSteps,
          deviceNames,
        })
      : undefined;

    const t = nowMs();
    const tz = resolveTimezoneOffsetMin(t);
    const localDateKey = timestampToUtcDateKey(t, tz);
    const prevUnit = cur.piecePracticeState?.chunkStates[ctx.chunk.chunkId];
    const isFirstChunkVisitInSession = !seenChunksInSessionRef.current.has(ctx.chunk.chunkId);
    seenChunksInSessionRef.current.add(ctx.chunk.chunkId);
    const boutKind = ctx.plannedItem?.boutKind ?? "chunk";
    const crossedSleepGate =
      Boolean(prevUnit?.lastSleepGateDateKey && prevUnit.lastSleepGateDateKey < localDateKey);
    const wasColdFirstPass =
      boutKind === "cold-probe"
        ? computeColdProbeIsCrossDay(prevUnit, t, localDateKey)
        : Boolean(ctx.plannedItem?.isColdFirstPass) ||
          (crossedSleepGate && isFirstChunkVisitInSession);

    const activeBridgeState = cur.bridgeWindowState;
    const isLinkedVerifyBout = Boolean(ctx.isLinkedVerify && activeBridgeState?.phase === "linked-verify");
    const endCoord =
      boutKind === "cold-probe" && ctx.plannedItem?.probeEndCoord
        ? ctx.plannedItem.probeEndCoord
        : isLinkedVerifyBout && activeBridgeState
          ? activeBridgeState.rightChunk.endCoord
          : ctx.chunk.endCoord;
    const startCoord =
      boutKind === "cold-probe" && ctx.plannedItem?.cue
        ? ctx.plannedItem.cue.coord
        : isLinkedVerifyBout && activeBridgeState
          ? activeBridgeState.leftChunk.startCoord
          : ctx.chunk.startCoord;

    const scaffoldingLevel: 0 | 1 | 2 | 3 =
      prevUnit &&
      prevUnit.handStage === "both" &&
      prevUnit.stableSpeed >= 0.9 &&
      prevUnit.sleepConsolidatedNights >= 2
        ? 3
        : prevUnit &&
            prevUnit.handStage === "both" &&
            prevUnit.stableSpeed >= 0.75 &&
            prevUnit.sleepConsolidatedNights >= 1
          ? 2
          : 1;

    const seq = ++eventSeqRef.current;
    const pieceId = activePieceProfile?.pieceId ?? "ephemeral";
    const newEvent: PracticeEvent = {
      eventId: `ev-${cur.sessionId ?? "gs"}-${t}-${seq}`,
      pieceId,
      scoreFingerprint,
      timestampMs: t,
      localDateKey,
      timezoneOffsetMin: tz,
      sessionId: cur.sessionId ?? `gs-${t}`,
      boutKind,
      startCoord,
      endCoord,
      ...(ctx.plannedItem?.junction
        ? { junctionBoundaryCoord: ctx.plannedItem.junction.boundaryCoord }
        : {}),
      ...(ctx.plannedItem?.cue ? { cueCoord: ctx.plannedItem.cue.coord } : {}),
      practiceMode: ctx.practiceMode,
      speedMultiplier: roundSpeed(ctx.speedMultiplier),
      durationSec: Math.max(0.1, (t - ctx.startedAtMs) / 1000),
      passCount: 1,
      wasColdFirstPass,
      scaffoldingLevel,
      autoGrade,
      fluency: attr.fluency,
      ...(acousticProfile ? { acoustic: toPracticeEventAcoustic(acousticProfile) } : {}),
      measureFaultCounts: attr.measureFaultCounts,
    };

    // Persist PracticeEvent & update derivedSnapshots asynchronously, while projecting immediately
    const commitEvent = () => {
      if (practiceStorage && activePieceProfile) {
        const prevEventsPromise = practiceStorage.listPracticeEvents(activePieceProfile.pieceId);
        const updatedProfile: PieceProfile = {
          ...activePieceProfile,
          lastPracticedAtMs: t,
          bestStableSpeed: Math.max(
            activePieceProfile.bestStableSpeed ?? 0,
            autoGrade >= 3 ? roundSpeed(ctx.speedMultiplier) : 0,
          ),
        };
        void practiceStorage
          .commit({
            practiceEvents: [newEvent],
            pieceProfiles: [updatedProfile],
          })
          .then(async () => {
            const allEvents = await prevEventsPromise;
            const merged = allEvents.some((e) => e.eventId === newEvent.eventId)
              ? allEvents
              : [...allEvents, newEvent];
            const nextState = reducePiecePracticeState(merged, {
              pieceId: activePieceProfile.pieceId,
              chunks: motorChunks,
              junctions: chunkJunctions,
              chunkOverrides: activePieceProfile.chunkOverrides,
              nowTimestampMs: t,
              nowLocalDateKey: localDateKey,
            });
            await writeDerivedSnapshot(practiceStorage, activePieceProfile.pieceId, nextState);
            useGuidedSessionStore.getState().setPiecePracticeState(nextState);
          })
          .catch(() => undefined);
      }
    };

    // Bridge Window multi-pass loop -> automatic speed restoration & 1 linked verification pass
    if (boutKind === "bridge" && activeBridgeState) {
      if (activeBridgeState.phase === "bridging") {
        const nextBridge = recordBridgeWindowPass(activeBridgeState, {
          attribution: attr,
          nowMs: t,
        });
        commitEvent();
        cur.setLastPersistedEvent(newEvent);
        if (nextBridge.phase === "bridging") {
          cur.setBridgeWindowState(nextBridge);
          cur.setCommandNotice(
            nextBridge.lastSlipNotice ??
              `Bridge Window 顺畅通过 ${nextBridge.smoothPassesDone}/${nextBridge.requiredSmoothPasses}（2 拍 Count-In 继续）`,
          );
          startContinuousChunkPlayRef.current(ctx.chunk, ctx.plannedItem);
          return;
        }
        // Exited bridging -> restore originalSpeed & launch 1 full linked two-chunk verification pass
        if (playbackEngineRef.current) {
          playbackEngineRef.current.setSpeed(nextBridge.originalSpeed);
          onChangePlaybackSpeed?.(nextBridge.originalSpeed);
        }
        cur.setBridgeWindowState(nextBridge);
        cur.setCommandNotice("Bridge Window 达标退出 · 自动恢复原速进入双块联排检验");
        startContinuousChunkPlayRef.current(ctx.chunk, ctx.plannedItem);
        return;
      }

      if (activeBridgeState.phase === "linked-verify") {
        completeBridgeLinkedVerification(activeBridgeState);
        cur.setBridgeWindowState(null);
      }
    }

    // Update MotorScheduler
    let nextScheduler = cur.schedulerState;
    let insertRescueItem: PlannedQueueItem | null = null;
    let enterMacroRest = false;

    const hasPlayedNotes = midiEvents.some((e) => e.type === "noteon");
    const adjacentJunctions = chunkJunctions.filter(
      (j) => j.leftChunkId === ctx.chunk.chunkId || j.rightChunkId === ctx.chunk.chunkId,
    );
    const faultedAdjacentJunction = hasPlayedNotes
      ? adjacentJunctions.find((junc) =>
          isEmpiricalJunctionFault({
            attribution: attr,
            junction: junc,
            expectedSteps: ctx.expectedSteps,
          }),
        )
      : undefined;

    if (nextScheduler) {
      const faultedSteps: number[] = [];
      for (const missed of attr.missedNotes) faultedSteps.push(missed.stepIndex);
      for (const brk of attr.hesitationBreaks) faultedSteps.push(brk.stepIndex);
      const boundaryFault =
        Boolean(faultedAdjacentJunction) ||
        attr.fluency.junctionHesitationRatio > 1.6 ||
        attr.hesitationBreaks.some((b) => b.isJunction);

      nextScheduler = recordSchedulerBoutOutcome(nextScheduler, {
        chunkId: ctx.chunk.chunkId,
        boutKind,
        junction: ctx.plannedItem?.junction ?? faultedAdjacentJunction,
        practiceMode: ctx.practiceMode,
        speedMultiplier: ctx.speedMultiplier,
        grade: autoGrade,
        pitchAccuracy: attr.fluency.pitchAccuracy,
        stallDetected: attr.fluency.stallDetected,
        interiorHesitationCount: attr.fluency.interiorHesitationCount,
        junctionHesitationRatio: attr.fluency.junctionHesitationRatio,
        dominantHandFaultRatio: attr.fluency.dominantHandFaultRatio,
        faultedSteps,
        boundaryFault,
        isColdFirstPass: wasColdFirstPass,
        durationMs: Math.max(1000, t - ctx.startedAtMs),
        nowMs: t,
      });

      const updatedUnit = nextScheduler.units[ctx.chunk.chunkId];
      if (updatedUnit?.activeRescue) {
        const isBridgeRescue = updatedUnit.activeRescue.kind === "bridge";
        const bridgeBaseSpeed = isBridgeRescue
          ? Math.max(updatedUnit.activeRescue.preRescueSpeed, ctx.speedMultiplier)
          : updatedUnit.activeRescue.preRescueSpeed;
        const rescueTargetSpeed = isBridgeRescue
          ? Math.max(0.45, roundSpeed(bridgeBaseSpeed * 0.88))
          : updatedUnit.activeRescue.targetSpeed;
        insertRescueItem = {
          itemId: `rescue-${seq}-${ctx.chunk.chunkId}`,
          segment: "middle-build",
          boutKind: isBridgeRescue ? "bridge" : "chunk",
          chunk: ctx.chunk,
          ...(updatedUnit.activeRescue.junction
            ? { junction: updatedUnit.activeRescue.junction }
            : {}),
          skipStage0: updatedUnit.activeRescue.kind !== "waiting-rescue",
          isColdFirstPass: false,
          targetSpeed: rescueTargetSpeed,
          ...(isBridgeRescue ? { preBridgeOriginalSpeed: bridgeBaseSpeed } : {}),
          estimatedDurationSec: 25,
        };
      } else if (shouldOfferEarlyMacroRest(nextScheduler, t)) {
        nextScheduler = advanceMotorScheduler(nextScheduler, t);
        enterMacroRest = nextScheduler.currentDirective.kind === "macro-rest";
      }
    }

    // Empirical 2-consecutive junction fault / hesitation (>1.6x & >=0.45s) auto-narrowing
    if (boutKind === "chunk" && !insertRescueItem && hasPlayedNotes) {
      for (const junc of adjacentJunctions) {
        const empRes = recordEmpiricalJunctionOutcome(empiricalTrackerRef.current, {
          junction: junc,
          attribution: attr,
          expectedSteps: ctx.expectedSteps,
        });
        empiricalTrackerRef.current = empRes.tracker;
        if (empRes.triggered) {
          const leftChunk = motorChunks.find((c) => c.chunkId === junc.leftChunkId) ?? ctx.chunk;
          const activeSpeed = Math.max(0.45, roundSpeed(ctx.speedMultiplier * 0.88));
          insertRescueItem = {
            itemId: `emp-bridge-${seq}-${junc.junctionId}`,
            segment: "middle-build",
            boutKind: "bridge",
            chunk: leftChunk,
            junction: junc,
            skipStage0: true,
            isColdFirstPass: false,
            targetSpeed: activeSpeed,
            preBridgeOriginalSpeed: ctx.speedMultiplier,
            estimatedDurationSec: 25,
          };
          break;
        }
      }
    }

    // Chaffin Cold-Start Probe evaluation & SwitchPoint divergence -> Bridge Window queue
    let lastProbeResult = null as ReturnType<typeof evaluateColdStartProbeOutcome> | null;
    let pauseForProbeFailure = false;
    if (boutKind === "cold-probe" && ctx.plannedItem?.cue) {
      const retriesUsed = cur.probeRetriesByItemId[ctx.plannedItem.itemId] ?? 0;
      lastProbeResult = evaluateColdStartProbeOutcome({
        attribution: attr,
        clockAnchor: anchor,
        expectedSteps: ctx.expectedSteps,
        midiEvents,
        measureTimelines: scoreDoc.measureTimelines,
        cue: ctx.plannedItem.cue,
        chunkJunctions,
        retriesUsed,
        isExemptPeekKey,
      });

      if (!lastProbeResult.passed) {
        pauseForProbeFailure = true;
        if (lastProbeResult.queuedBridgeJunction) {
          const qJunc = lastProbeResult.queuedBridgeJunction;
          const qLeft = motorChunks.find((c) => c.chunkId === qJunc.leftChunkId) ?? ctx.chunk;
          insertRescueItem = {
            itemId: `switch-bridge-${seq}-${qJunc.junctionId}`,
            segment: "middle-build",
            boutKind: "bridge",
            chunk: qLeft,
            junction: qJunc,
            skipStage0: true,
            isColdFirstPass: false,
            targetSpeed: Math.max(0.5, roundSpeed(ctx.speedMultiplier * 0.88)),
            estimatedDurationSec: 25,
          };
        }
      }
    }

    // Dynamic cold-start probe unlock once >=1 MacroSection or >=3 contiguous MotorChunks finish Stage 0 + clean linking
    if (boutKind === "chunk" && !cur.coldProbeSessionMode && autoGrade >= 3) {
      cur.markChunkCompletedInSession(ctx.chunk.chunkId);
      const afterCur = useGuidedSessionStore.getState();
      const hasProbesAlready = afterCur.plannedQueue.some((i) => i.boutKind === "cold-probe");
      const hasEnoughSessionContext =
        afterCur.chunkQueue.length >= 3 || macroSections.length >= 2;
      if (!hasProbesAlready && hasEnoughSessionContext) {
        const completedSet = new Set(afterCur.inSessionCompletedChunkIds);
        if (
          isColdProbeLocallyUnlocked({
            macroSections,
            motorChunks,
            piecePracticeState: afterCur.piecePracticeState,
            inSessionCompletedChunkIds: completedSet,
          })
        ) {
          const unlockedProbes = buildColdStartProbeItems({
            macroSections,
            motorChunks,
            performanceCues,
            passageClusters,
            piecePracticeState: afterCur.piecePracticeState,
            selectedMacroSectionId: afterCur.selectedMacroSectionId,
            inSessionCompletedChunkIds: completedSet,
            nowTimestampMs: t,
            nowLocalDateKey: localDateKey,
            count: afterCur.timeBoxMinutes === 15 ? 2 : 3,
            seed: t & 0xffffffff,
            manualMode: false,
          });
          if (unlockedProbes.length >= 2) {
            cur.appendClosingProbes(unlockedProbes);
          }
        }
      }
    }

    commitEvent();

    const gradeLabel =
      autoGrade === 4
        ? "Easy"
        : autoGrade === 3
          ? "Good"
          : autoGrade === 2
            ? "Hard"
            : "Again";
    const pct = Math.round(attr.fluency.pitchAccuracy * 100);
    const headlinePrefix =
      boutKind === "cold-probe" && ctx.plannedItem?.cue
        ? `冷启动检索「${ctx.plannedItem.cue.customLabel || ctx.plannedItem.cue.label}」`
        : boutKind === "bridge"
          ? `接缝桥接联排（m.${ctx.chunk.startMeasureIndex + 1}–${ctx.chunk.endMeasureIndex + 1}）`
          : `块 ${ctx.chunk.index + 1}（m.${ctx.chunk.startMeasureIndex + 1}–${ctx.chunk.endMeasureIndex + 1}）`;

    cur.completePlayingBout(t, {
      persistedEvent: newEvent,
      schedulerState: nextScheduler,
      enterMacroRest,
      insertRescueItem,
      lastProbeResult,
      pauseForProbeFailure,
      summary: {
        boutKind,
        accuracy: attr.fluency.pitchAccuracy,
        speedMultiplier: roundSpeed(ctx.speedMultiplier),
        autoGrade,
        effectiveGrade: autoGrade,
        canMarkHard: autoGrade >= 3,
        markedHard: false,
        ...(acousticProfile ? { acousticProfile } : {}),
        headline: `${headlinePrefix}${hasPlayedNotes ? ` · 准确度 ${pct}% · ${gradeLabel}` : "回合结束"}`,
        detail: pauseForProbeFailure && lastProbeResult
          ? lastProbeResult.reasonSummary
          : enterMacroRest
            ? "已完成开场穿插轮次，进入前期离键大休息（Early Macro-Rest）"
            : "进入清醒微休息，静放双手以巩固动作记忆",
      },
    });
  }, [
    scoreDoc,
    sliceContinuousMidiWindow,
    resetMidiCapture,
    passageClusters,
    deviceNames,
    nowMs,
    resolveTimezoneOffsetMin,
    activePieceProfile,
    scoreFingerprint,
    practiceStorage,
    motorChunks,
    chunkJunctions,
    macroSections,
    performanceCues,
    practiceSteps,
    playbackEngineRef,
    onChangePlaybackSpeed,
  ]);

  const startContinuousChunkPlay = useCallback(
    (chunk: MotorChunk, plannedItem: PlannedQueueItem | null = null) => {
      if (!scoreDoc || !playbackEngineRef.current) return;
      const store = useGuidedSessionStore.getState();

      // Ensure BridgeWindowState is initialized when entering a bridge item
      let activeBridge = store.bridgeWindowState;
      if (plannedItem?.boutKind === "bridge" && plannedItem.junction) {
        if (!activeBridge || activeBridge.junction.junctionId !== plannedItem.junction.junctionId) {
          const leftChunk =
            motorChunks.find((c) => c.chunkId === plannedItem.junction!.leftChunkId) ?? chunk;
          const rightChunk =
            motorChunks.find((c) => c.chunkId === plannedItem.junction!.rightChunkId) ?? chunk;
          const bSpan = resolveBridgeWindowSpan({
            scoreDoc,
            practiceSteps,
            junction: plannedItem.junction,
            leftChunk,
            rightChunk,
          });
          const unitRt = store.schedulerState?.units[chunk.chunkId];
          const baseSpeed =
            plannedItem.preBridgeOriginalSpeed ??
            unitRt?.activeRescue?.preRescueSpeed ??
            unitRt?.workingSpeed ??
            playbackSpeed;
          const trigger = plannedItem.itemId.startsWith("switch-bridge-")
            ? "switch-mismatch"
            : plannedItem.itemId.startsWith("mid-bridge-")
              ? "static-prewarm"
              : "empirical-fault";
          activeBridge = createBridgeWindowState({
            trigger,
            junction: plannedItem.junction,
            leftChunk,
            rightChunk,
            span: bSpan,
            originalSpeed: baseSpeed,
            startedAtMs: nowMs(),
            ...(plannedItem.targetSpeed && trigger !== "static-prewarm"
              ? { speedFactor: plannedItem.targetSpeed / Math.max(0.25, baseSpeed) }
              : {}),
          });
          store.setBridgeWindowState(activeBridge);
        }
      } else if (activeBridge && plannedItem?.boutKind !== "bridge") {
        store.setBridgeWindowState(null);
        activeBridge = null;
      }

      const resolved = resolveBoutSpanAndSteps(chunk, plannedItem);
      const unitRuntime = store.schedulerState?.units[chunk.chunkId];
      const chunkPersistedState = store.piecePracticeState?.chunkStates[chunk.chunkId];
      const hasChunkHistory = Boolean(
        (chunkPersistedState &&
          chunkPersistedState.reviewCount > 0 &&
          (store.sessionStartedAtMs === null ||
            (chunkPersistedState.lastEventTimestampMs ?? 0) < store.sessionStartedAtMs)) ||
          plannedItem?.isClusterWarmStart,
      );
      const speedFromScheduler = activeBridge
        ? activeBridge.activeSpeed
        : unitRuntime?.activeRescue
          ? unitRuntime.activeRescue.targetSpeed
          : unitRuntime && (hasChunkHistory || unitRuntime.speedUpgradesThisSession > 0)
            ? unitRuntime.workingSpeed
            : plannedItem && (hasChunkHistory || plannedItem.boutKind !== "chunk")
              ? plannedItem.targetSpeed
              : playbackSpeed;

      if (Math.abs(speedFromScheduler - playbackEngineRef.current.getSpeed()) > 1e-4) {
        playbackEngineRef.current.setSpeed(speedFromScheduler);
        onChangePlaybackSpeed?.(speedFromScheduler);
      }

      const boutPracticeMode: PracticeMode =
        unitRuntime?.activeRescue?.kind === "single-hand-isolation" &&
        unitRuntime.activeRescue.isolatedHand
          ? unitRuntime.activeRescue.isolatedHand === "RH"
            ? "rh-only"
            : "lh-only"
          : effectivePracticeMode;

      activeBoutCtxRef.current = {
        chunk,
        plannedItem,
        expectedSteps: resolved.expectedSteps,
        startScoreSec: resolved.startScoreSec,
        endScoreSec: resolved.endScoreSec,
        speedMultiplier: speedFromScheduler,
        practiceMode: boutPracticeMode,
        startedAtMs: nowMs(),
        anchor: null,
        isLinkedVerify: resolved.isLinkedVerify,
        switchPointSpec: resolved.switchPointSpec,
      };

      setMidiCaptureMode("continuous");
      void playbackEngineRef.current.playSegment(scoreDoc, {
        startScoreSec: resolved.startScoreSec,
        endScoreSec: resolved.endScoreSec,
        countInBeats: resolved.countInBeats,
        muteTargetHand: false,
        practiceMode: boutPracticeMode,
        metronomeMode: "full",
        onClockAnchor: (anchor) => {
          if (activeBoutCtxRef.current) {
            activeBoutCtxRef.current.anchor = anchor;
          }
        },
        onSegmentComplete: () => {
          finalizeContinuousBout();
        },
      });
    },
    [
      scoreDoc,
      playbackEngineRef,
      resolveBoutSpanAndSteps,
      playbackSpeed,
      onChangePlaybackSpeed,
      effectivePracticeMode,
      nowMs,
      setMidiCaptureMode,
      finalizeContinuousBout,
      motorChunks,
      practiceSteps,
    ],
  );
  startContinuousChunkPlayRef.current = startContinuousChunkPlay;

  const beginChunkStage0 = useCallback(
    (chunk: MotorChunk, steps: PracticeStep[], plannedItem: PlannedQueueItem | null = null) => {
      playbackEngineRef.current?.stop();
      if (plannedItem?.skipStage0 || steps.length === 0) {
        if (steps.length === 0) {
          useGuidedSessionStore.getState().graduateStage0ToPlaying(nowMs());
        }
        startContinuousChunkPlay(chunk, plannedItem);
        return;
      }
      setMidiCaptureMode("waiting");
      resetWaitingCursor(0);
      syncWaitingToStep(steps[0] ?? null, "playing");
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

  const launchFromPlan = useCallback(
    (plan: ReturnType<typeof planGuidedSession>) => {
      if (plan.items.length === 0) return;
      const store = useGuidedSessionStore.getState();
      const t = nowMs();
      seenChunksInSessionRef.current = new Set();
      const scheduler = createMotorSchedulerState({
        plan,
        chunks: motorChunks,
        junctions: chunkJunctions,
        passageClusters,
        piecePracticeState: store.piecePracticeState,
        manualPracticeMode: effectivePracticeMode,
        overspeedProbeEnabled: store.overspeedProbeEnabled,
        startedAtMs: t,
      });

      const firstItem = plan.items[0];
      const firstChunk = firstItem.chunk;
      const firstSteps = getStepsForChunk(scoreDoc, practiceSteps, firstChunk);
      const chunks = plan.items.map((item) => item.chunk);

      playbackEngineRef.current?.stop();
      useGuidedSessionStore.getState().startSession({
        chunks,
        plannedItems: plan.items,
        schedulerState: scheduler,
        firstChunkSteps: firstSteps,
        speedMultiplier: playbackSpeed,
        nowMs: t,
        startInStage0: !firstItem.skipStage0,
      });

      if (!firstItem.skipStage0 && firstSteps.length > 0) {
        setMidiCaptureMode("waiting");
        resetWaitingCursor(0);
        syncWaitingToStep(firstSteps[0] ?? null, "playing");
      } else {
        startContinuousChunkPlay(firstChunk, firstItem);
      }
    },
    [
      nowMs,
      motorChunks,
      chunkJunctions,
      passageClusters,
      piecePracticeState,
      effectivePracticeMode,
      overspeedProbeEnabled,
      scoreDoc,
      practiceSteps,
      playbackEngineRef,
      playbackSpeed,
      setMidiCaptureMode,
      resetWaitingCursor,
      syncWaitingToStep,
      startContinuousChunkPlay,
    ],
  );

  const handleStartSession = useCallback(() => {
    const store = useGuidedSessionStore.getState();
    const t = nowMs();
    const tz = resolveTimezoneOffsetMin(t);
    const localDateKey = timestampToUtcDateKey(t, tz);
    const livePlan =
      sessionPlan.timeBoxMinutes === store.timeBoxMinutes &&
      sessionPlan.items.length > 0
        ? sessionPlan
        : planGuidedSession({
            timeBoxMinutes: store.timeBoxMinutes,
            macroSections,
            motorChunks,
            chunkJunctions,
            passageClusters,
            performanceCues,
            piecePracticeState: store.piecePracticeState,
            selectedMacroSectionId: store.selectedMacroSectionId,
            practiceMode: effectivePracticeMode,
            nowTimestampMs: t,
            nowLocalDateKey: localDateKey,
          });
    if (livePlan.items.length > 0) {
      launchFromPlan(livePlan);
      return;
    }
    if (launchFilteredChunks.length === 0) return;
    const firstChunk = launchFilteredChunks[0];
    const firstSteps = getStepsForChunk(scoreDoc, practiceSteps, firstChunk);
    playbackEngineRef.current?.stop();
    useGuidedSessionStore.getState().startSession({
      chunks: launchFilteredChunks,
      firstChunkSteps: firstSteps,
      speedMultiplier: playbackSpeed,
      nowMs: t,
      startInStage0: true,
    });
    if (firstSteps.length > 0) {
      setMidiCaptureMode("waiting");
      resetWaitingCursor(0);
      syncWaitingToStep(firstSteps[0] ?? null, "playing");
    } else {
      startContinuousChunkPlay(firstChunk, null);
    }
  }, [
    nowMs,
    resolveTimezoneOffsetMin,
    sessionPlan,
    macroSections,
    motorChunks,
    chunkJunctions,
    passageClusters,
    performanceCues,
    effectivePracticeMode,
    launchFromPlan,
    launchFilteredChunks,
    scoreDoc,
    practiceSteps,
    playbackEngineRef,
    playbackSpeed,
    setMidiCaptureMode,
    resetWaitingCursor,
    syncWaitingToStep,
    startContinuousChunkPlay,
  ]);

  const handleStartQuickTriage = useCallback(() => {
    const store = useGuidedSessionStore.getState();
    const t = nowMs();
    const tz = resolveTimezoneOffsetMin(t);
    const localDateKey = timestampToUtcDateKey(t, tz);
    const triagePlan = planQuickTriageSession({
      timeBoxMinutes: store.timeBoxMinutes,
      macroSections,
      motorChunks,
      chunkJunctions,
      passageClusters,
      performanceCues,
      piecePracticeState: store.piecePracticeState,
      selectedMacroSectionId: null,
      practiceMode: effectivePracticeMode,
      nowTimestampMs: t,
      nowLocalDateKey: localDateKey,
      quickTriage: true,
    });
    launchFromPlan(triagePlan);
  }, [
    nowMs,
    resolveTimezoneOffsetMin,
    macroSections,
    motorChunks,
    chunkJunctions,
    passageClusters,
    performanceCues,
    effectivePracticeMode,
    launchFromPlan,
  ]);

  const handleStartColdProbeDrill = useCallback(() => {
    const store = useGuidedSessionStore.getState();
    const t = nowMs();
    const tz = resolveTimezoneOffsetMin(t);
    const localDateKey = timestampToUtcDateKey(t, tz);
    const probeItems = buildColdStartProbeItems({
      macroSections,
      motorChunks,
      performanceCues,
      passageClusters,
      piecePracticeState: store.piecePracticeState,
      selectedMacroSectionId: store.selectedMacroSectionId,
      nowTimestampMs: t,
      nowLocalDateKey: localDateKey,
      count: 3,
      seed: t & 0xffffffff,
      manualMode: true,
    });
    if (probeItems.length === 0) return;

    seenChunksInSessionRef.current = new Set();
    const firstItem = probeItems[0];
    const firstChunk = firstItem.chunk;
    const firstSteps = getStepsForChunk(scoreDoc, practiceSteps, firstChunk);
    playbackEngineRef.current?.stop();
    store.startSession({
      chunks: probeItems.map((i) => i.chunk),
      plannedItems: probeItems,
      schedulerState: null,
      firstChunkSteps: firstSteps,
      speedMultiplier: firstItem.targetSpeed,
      nowMs: t,
      startInStage0: false,
      coldProbeSessionMode: true,
    });
    startContinuousChunkPlay(firstChunk, firstItem);
  }, [
    nowMs,
    resolveTimezoneOffsetMin,
    macroSections,
    motorChunks,
    performanceCues,
    passageClusters,
    scoreDoc,
    practiceSteps,
    playbackEngineRef,
    startContinuousChunkPlay,
  ]);

  const triggerBlindPeek = useCallback(() => {
    clearPeekTimer();
    const t = nowMs();
    useGuidedSessionStore.getState().setBlindPeekUntilMs(t + 1500);
    peekTimerRef.current = globalThis.setTimeout(() => {
      peekTimerRef.current = null;
      useGuidedSessionStore.getState().setBlindPeekUntilMs(null);
    }, 1500);
  }, [clearPeekTimer, nowMs]);

  const handleSkipBridgeWindow = useCallback(() => {
    const store = useGuidedSessionStore.getState();
    const bState = store.bridgeWindowState;
    if (!bState) return;
    const skipped = skipBridgeWindow(bState);
    playbackEngineRef.current?.stop();
    activeBoutCtxRef.current = null;
    resetMidiCapture();

    if (Math.abs(skipped.originalSpeed - (playbackEngineRef.current?.getSpeed() ?? skipped.originalSpeed)) > 1e-4) {
      playbackEngineRef.current?.setSpeed(skipped.originalSpeed);
      onChangePlaybackSpeed?.(skipped.originalSpeed);
    }

    if (store.schedulerState) {
      const nextSched = skipCircuitBreaker(
        store.schedulerState,
        bState.leftChunk.chunkId,
        nowMs(),
      );
      store.setSchedulerState(nextSched);
    }

    store.setBridgeWindowState(null);
    store.setCommandNotice("已跳过当前 Bridge Window 接缝桥接");

    const nextIdx = store.currentQueueIndex + 1;
    if (nextIdx >= store.chunkQueue.length) {
      store.advanceToNextChunk([], playbackSpeed, nowMs());
      return;
    }
    const next = store.chunkQueue[nextIdx];
    const nextPlanned = store.plannedQueue[nextIdx] ?? null;
    const nextSteps = getStepsForChunk(scoreDoc, practiceSteps, next);
    store.advanceToNextChunk(nextSteps, skipped.originalSpeed, nowMs());
    beginChunkStage0(next, nextSteps, nextPlanned);
  }, [
    playbackEngineRef,
    resetMidiCapture,
    onChangePlaybackSpeed,
    nowMs,
    playbackSpeed,
    scoreDoc,
    practiceSteps,
    beginChunkStage0,
  ]);

  const handleMarkLastBoutHard = useCallback(async () => {
    const store = useGuidedSessionStore.getState();
    const ev = store.lastPersistedEvent;
    if (!ev || store.lastBoutSummary?.markedHard) return;

    const updatedEvent: PracticeEvent = { ...ev, userGradeOverride: 2 };
    let nextPieceState = store.piecePracticeState;

    if (practiceStorage) {
      await practiceStorage.applyPracticeEventGradeOverride?.(ev.eventId, 2);
      const events = await practiceStorage.listPracticeEvents(ev.pieceId);
      const patchedEvents = events.map((row) =>
        row.eventId === ev.eventId ? { ...row, userGradeOverride: 2 as const } : row,
      );
      const t = nowMs();
      const tz = resolveTimezoneOffsetMin(t);
      nextPieceState = reducePiecePracticeState(patchedEvents, {
        pieceId: ev.pieceId,
        chunks: motorChunks,
        junctions: chunkJunctions,
        chunkOverrides: activePieceProfile?.chunkOverrides,
        nowTimestampMs: t,
        nowLocalDateKey: timestampToUtcDateKey(t, tz),
      });
      await writeDerivedSnapshot(practiceStorage, ev.pieceId, nextPieceState);
    }

    let nextScheduler = store.schedulerState;
    if (nextScheduler && nextScheduler.units[store.lastBoutSummary?.chunkId ?? ""]) {
      const cid = store.lastBoutSummary!.chunkId;
      const unit = nextScheduler.units[cid];
      const lockedSpeed = nextPieceState?.chunkStates[cid]?.stableSpeed ?? ev.speedMultiplier;
      nextScheduler = {
        ...nextScheduler,
        units: {
          ...nextScheduler.units,
          [cid]: {
            ...unit,
            workingSpeed: lockedSpeed,
            stableSpeed: lockedSpeed,
            easyEligible: false,
          },
        },
      };
    }

    store.markLastBoutHardUI(updatedEvent, nextPieceState, nextScheduler);
  }, [
    practiceStorage,
    nowMs,
    resolveTimezoneOffsetMin,
    motorChunks,
    chunkJunctions,
    activePieceProfile?.chunkOverrides,
  ]);

  const executeCommandAction = useCallback(
    (action: PianoCommandAction) => {
      const store = useGuidedSessionStore.getState();
      if (action === "none") return;

      if (action === "micro-rest-reminder") {
        store.recordMicroRestAccidentalKey(nowMs());
        return;
      }

      if (action === "peek-reveal") {
        triggerBlindPeek();
        return;
      }

      if (action === "toggle-view") {
        const activeItem = store.plannedQueue[store.currentQueueIndex] ?? null;
        if (
          activeItem?.boutKind === "cold-probe" &&
          store.blindColdProbeEnabled &&
          (store.sessionPhase === "playing" || store.sessionPhase === "paused")
        ) {
          triggerBlindPeek();
          return;
        }
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
        const plannedItem = store.plannedQueue[store.currentQueueIndex] ?? null;
        if (
          plannedItem?.boutKind === "cold-probe" &&
          store.lastProbeResult &&
          !store.lastProbeResult.passed
        ) {
          if (!store.lastProbeResult.canRetryA0) {
            store.setCommandNotice("冷启动即时重测已用完 1 次，请按 C8 记录薄弱点并继续");
            return;
          }
          store.incrementProbeRetry(plannedItem.itemId);
          store.setLastProbeResult(null);
          const steps = getStepsForChunk(scoreDoc, practiceSteps, chunk);
          store.replayCurrentChunk(steps, plannedItem.targetSpeed, nowMs(), false);
          startContinuousChunkPlay(chunk, plannedItem);
          return;
        }
        if (plannedItem?.boutKind === "bridge") {
          const steps = getStepsForChunk(scoreDoc, practiceSteps, chunk);
          store.replayCurrentChunk(steps, plannedItem.targetSpeed, nowMs(), false);
          startContinuousChunkPlay(chunk, plannedItem);
          return;
        }
        const steps = getStepsForChunk(scoreDoc, practiceSteps, chunk);
        store.replayCurrentChunk(steps, playbackSpeed, nowMs(), true);
        beginChunkStage0(chunk, steps, null);
        return;
      }

      if (action === "continue-next" || action === "start-first-note") {
        if (store.sessionPhase === "launch") {
          handleStartSession();
          return;
        }
        if (
          (store.sessionPhase === "playing" || store.sessionPhase === "paused") &&
          store.bridgeWindowState &&
          (store.bridgeWindowState.phase === "bridging" ||
            store.bridgeWindowState.phase === "linked-verify") &&
          action === "continue-next"
        ) {
          handleSkipBridgeWindow();
          return;
        }
        if (store.sessionPhase === "paused") {
          if (store.lastProbeResult && !store.lastProbeResult.passed) {
            // C8 log-and-continue on failed cold-start probe
            store.setLastProbeResult(null);
            const nextIdx = store.currentQueueIndex + 1;
            if (nextIdx >= store.chunkQueue.length) {
              store.advanceToNextChunk([], playbackSpeed, nowMs());
              return;
            }
            const next = store.chunkQueue[nextIdx];
            const nextPlanned = store.plannedQueue[nextIdx] ?? null;
            const nextSteps = getStepsForChunk(scoreDoc, practiceSteps, next);
            store.advanceToNextChunk(nextSteps, playbackSpeed, nowMs());
            beginChunkStage0(next, nextSteps, nextPlanned);
            return;
          }
          const resumeTarget = store.pausedFromPhase ?? "playing";
          store.resumePausedPlay(nowMs());
          const chunk = store.chunkQueue[store.currentQueueIndex];
          const plannedItem = store.plannedQueue[store.currentQueueIndex] ?? null;
          if (resumeTarget === "stage0") {
            const steps = getStepsForChunk(scoreDoc, practiceSteps, chunk ?? null);
            const curIdx = store.stage0State?.currentStepIndex ?? 0;
            setMidiCaptureMode("waiting");
            syncWaitingToStep(steps[curIdx] ?? steps[0] ?? null, "playing");
          } else if (chunk) {
            startContinuousChunkPlay(chunk, plannedItem);
          }
          return;
        }
        if (store.sessionPhase === "micro-rest") {
          store.skipMicroRest(nowMs());
          return;
        }
        if (store.sessionPhase === "macro-rest") {
          store.skipMacroRest(nowMs());
          return;
        }
        if (store.sessionPhase === "audiation" || store.sessionPhase === "summary") {
          if (store.sessionPhase === "audiation") {
            stopAudiationPreview(action === "start-first-note" ? "first-note" : "c8");
          }
          const nextIdx = store.currentQueueIndex + 1;
          if (nextIdx >= store.chunkQueue.length) {
            if (store.sessionPhase === "summary") {
              handleStartSession();
            }
            return;
          }
          const next = store.chunkQueue[nextIdx];
          const nextPlanned = store.plannedQueue[nextIdx] ?? null;
          const nextSteps = getStepsForChunk(scoreDoc, practiceSteps, next);
          store.advanceToNextChunk(nextSteps, playbackSpeed, nowMs());
          beginChunkStage0(next, nextSteps, nextPlanned);
        }
      }
    },
    [
      nowMs,
      playbackEngineRef,
      stopAudiationPreview,
      triggerBlindPeek,
      handleSkipBridgeWindow,
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
      const activeItem = store.plannedQueue[store.currentQueueIndex] ?? null;
      const allowActivePeek = Boolean(
        activeItem?.boutKind === "cold-probe" && store.blindColdProbeEnabled,
      );
      const allowActiveBridgeSkip = Boolean(
        store.bridgeWindowState &&
          (store.bridgeWindowState.phase === "bridging" ||
            store.bridgeWindowState.phase === "linked-verify"),
      );

      const res = routerRef.current.routeMidi(event, {
        phase: store.sessionPhase,
        firstTargetMidis,
        chunkMidis: activeChunkMidis,
        cc64CommandEnabled: store.cc64CommandEnabled,
        allowActivePeek,
        allowActiveBridgeSkip,
      });

      if (res.peekDisabled) {
        store.setCommandNotice("当前检索段落包含 B0，已自动禁用演奏态 B0 偷看（请用 F 键或屏幕按钮）");
      }

      if (res.action !== "none") {
        if (res.action === "peek-reveal" && event.type === "noteon") {
          peekExemptTimestampsRef.current.add(event.timeStampMs);
        }
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
      const activeItem = store.plannedQueue[store.currentQueueIndex] ?? null;
      const allowActivePeek = Boolean(
        activeItem?.boutKind === "cold-probe" && store.blindColdProbeEnabled,
      );
      const action = routeKeyboardCommand(event, store.sessionPhase, { allowActivePeek });
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
      const t = nowMs();
      store.setStage0State(graduatedState);
      if (store.schedulerState) {
        store.setSchedulerState(
          recordSchedulerStage0Graduated(store.schedulerState, graduatedState.chunkId, t),
        );
      }
      store.graduateStage0ToPlaying(t);
      resetWaitingCursor(0);
      syncWaitingToStep(null, "stopped");
      const chunk = store.chunkQueue[store.currentQueueIndex];
      const plannedItem = store.plannedQueue[store.currentQueueIndex] ?? null;
      if (chunk) {
        startContinuousChunkPlay(chunk, plannedItem);
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

  // Periodic Stage 0 2-minute cap, Micro-Rest / Macro-Rest countdown, and optional Audiation imagery timer watcher
  useEffect(() => {
    if (studioMode !== "guided") return;
    const watchAudiationTimer = sessionPhase === "audiation" && audiationImageryTimerEnabled;
    if (
      sessionPhase !== "stage0" &&
      sessionPhase !== "micro-rest" &&
      sessionPhase !== "macro-rest" &&
      !watchAudiationTimer
    ) {
      return;
    }

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
      } else if (store.sessionPhase === "macro-rest") {
        const startAt = store.macroRestStartedAtMs ?? t;
        const duration = store.macroRestDurationMs || EARLY_MACRO_REST_DURATION_MS;
        if (t - startAt >= duration) {
          store.finishMacroRest(t);
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
        label:
          sessionPhase === "micro-rest" || sessionPhase === "macro-rest" ? "跳过" : "继续",
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

  const macroRestRemainingSec =
    macroRestStartedAtMs === null
      ? Math.ceil(macroRestDurationMs / 1000)
      : Math.ceil(
          Math.max(0, macroRestDurationMs - Math.max(0, nowMs() - macroRestStartedAtMs)) / 1000,
        );

  const activePlannedItem = plannedQueue[currentQueueIndex] ?? null;

  const bridgeHandPreview = useMemo<BridgeHandPositionPreview | null>(() => {
    if (
      studioMode !== "guided" ||
      !scoreDoc ||
      (sessionPhase !== "playing" && sessionPhase !== "paused" && sessionPhase !== "audiation")
    ) {
      return null;
    }
    const targetBridge =
      bridgeWindowState &&
      (bridgeWindowState.phase === "bridging" || bridgeWindowState.phase === "linked-verify")
        ? bridgeWindowState
        : null;
    if (targetBridge) {
      return deriveBridgeHandPositionPreview({
        scoreDoc,
        solveResult,
        span: targetBridge.span,
        practiceMode: effectivePracticeMode,
      });
    }
    if (activePlannedItem?.boutKind === "bridge" && activePlannedItem.junction) {
      const j = activePlannedItem.junction;
      const leftChunk = motorChunks.find((c) => c.chunkId === j.leftChunkId) ?? activeChunk;
      const rightChunk = motorChunks.find((c) => c.chunkId === j.rightChunkId) ?? activeChunk;
      if (!leftChunk || !rightChunk) return null;
      const span = resolveBridgeWindowSpan({
        scoreDoc,
        practiceSteps,
        junction: j,
        leftChunk,
        rightChunk,
      });
      return deriveBridgeHandPositionPreview({
        scoreDoc,
        solveResult,
        span,
        practiceMode: effectivePracticeMode,
      });
    }
    return null;
  }, [
    studioMode,
    scoreDoc,
    sessionPhase,
    bridgeWindowState,
    solveResult,
    effectivePracticeMode,
    activePlannedItem,
    motorChunks,
    activeChunk,
    practiceSteps,
  ]);

  const blindCurtainActive = Boolean(
    studioMode === "guided" &&
      blindColdProbeEnabled &&
      activePlannedItem?.boutKind === "cold-probe" &&
      (sessionPhase === "playing" || sessionPhase === "paused" || sessionPhase === "audiation"),
  );
  const blindPeeking = Boolean(
    blindCurtainActive && blindPeekUntilMs !== null && nowMs() < blindPeekUntilMs,
  );
  const blindProbeLabel = activePlannedItem?.cue
    ? `锚点：${activePlannedItem.cue.customLabel || activePlannedItem.cue.label}（第 ${activePlannedItem.cue.measureIndex + 1} 小节起）`
    : null;

  const handleSkipCircuitBreaker = useCallback(() => {
    const store = useGuidedSessionStore.getState();
    if (!store.schedulerState || !activeChunk) return;
    const next = skipCircuitBreaker(store.schedulerState, activeChunk.chunkId, nowMs());
    store.setSchedulerState(next);
  }, [activeChunk, nowMs]);

  return {
    studioMode,
    sessionPhase,
    timeBoxMinutes,
    selectedMacroSectionId,
    chunkQueue,
    plannedQueue,
    currentQueueIndex,
    activeChunk,
    nextChunk,
    activeChunkSteps,
    activeChunkMidis,
    dualPitchDisabled,
    stage0State,
    piecePracticeState,
    sessionPlan,
    bottomSlotView,
    cc64CommandEnabled,
    microRestDurationSec,
    audiationPreviewMode,
    audiationImageryTimerEnabled,
    overspeedProbeEnabled,
    blindColdProbeEnabled,
    blindCurtainActive,
    blindPeeking,
    blindProbeLabel,
    bridgeWindowState,
    bridgeHandPreview,
    lastProbeResult,
    microRestStartedAtMs,
    microRestDurationMs,
    microRestReminder,
    microRestState,
    microRestTick,
    macroRestRemainingSec,
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
    setOverspeedProbeEnabled: (enabled: boolean) =>
      useGuidedSessionStore.getState().setOverspeedProbeEnabled(enabled),
    setBlindColdProbeEnabled: (enabled: boolean) =>
      useGuidedSessionStore.getState().setBlindColdProbeEnabled(enabled),
    setBottomSlotView: (v: "piano" | "feedback") =>
      useGuidedSessionStore.getState().setBottomSlotView(v),

    handleStartSession,
    handleStartQuickTriage,
    handleStartColdProbeDrill,
    triggerBlindPeek,
    handleSkipBridgeWindow,
    handleMarkLastBoutHard,
    handleSkipCircuitBreaker,
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
