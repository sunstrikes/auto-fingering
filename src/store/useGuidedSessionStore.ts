import { create } from "zustand";
import type { MotorChunk } from "../chunking/types";
import type { PracticeMode, PracticeStep } from "../domain/types";
import type { AcousticProfileResult } from "../guided/acousticProfile";
import {
  EHS_DEFAULT_AUTO_STALL_FLASH_ENABLED,
  EHS_DEFAULT_ENABLED,
  EHS_DEFAULT_GHOST_OPACITY,
  EHS_DEFAULT_PRESET,
  type EhsActiveLookaheadPreset,
  type EhsGhostOpacity,
  type EhsProgressionPrompt,
  type EhsProgressionState,
} from "../guided/ehsController";
import type { BridgeWindowState } from "../guided/bridgeWindow";
import type { ColdStartProbeEvaluation } from "../guided/coldStartProbe";
import type { ScaffoldingPreference } from "../guided/fadingScaffolding";
import type { MotorGrade, PiecePracticeState } from "../guided/motorFsrs";
import {
  EARLY_MACRO_REST_DURATION_MS,
  skipEarlyMacroRest,
  type MotorSchedulerState,
} from "../guided/motorScheduler";
import type { GuidedSessionPhase } from "../guided/pianoCommandKeys";
import type { GuidedTimeBoxMinutes, PlannedQueueItem } from "../guided/sessionPlanner";
import {
  buildStage0TelemetrySummary,
  createStage0State,
  pauseStage0,
  resumeStage0,
  type Stage0GraduationReason,
  type Stage0State,
} from "../guided/stage0Controller";
import {
  DEFAULT_MICRO_REST_DURATION_SEC,
  clampMicroRestDurationSec,
  createAudiationPrimingState,
  createMicroRestState,
  recordMicroRestAccidentalKeystroke,
  type AudiationPreviewMode,
  type AudiationPrimingState,
  type MicroRestState,
} from "../guided/transitionFlow";
import type { PracticeEvent } from "../persistence/storagePort";

export type StudioMode = "free" | "guided";
export type { GuidedTimeBoxMinutes };
export type BottomSlotView = "piano" | "feedback";

export interface GuidedBoutSummary {
  chunkId: string;
  chunkIndex: number;
  startMeasureIndex: number;
  endMeasureIndex: number;
  stage: "stage0" | "continuous";
  boutKind?: "chunk" | "bridge" | "cold-probe";
  graduationReason?: Stage0GraduationReason;
  accuracy: number;
  passAttempts: number;
  telemetryIsolated: boolean;
  acousticProfile?: AcousticProfileResult;
  speedMultiplier?: number;
  autoGrade?: MotorGrade;
  effectiveGrade?: MotorGrade;
  canMarkHard?: boolean;
  markedHard?: boolean;
  headline: string;
  detail: string;
}

export interface ContinuousBoutCompletionPayload {
  accuracy?: number;
  acousticProfile?: AcousticProfileResult;
}

export interface SuspendedGuidedSessionSnapshot {
  timeBoxMinutes: GuidedTimeBoxMinutes;
  selectedMacroSectionId: string | null;
  chunkQueue: MotorChunk[];
  currentQueueIndex: number;
  resumePhase: GuidedSessionPhase;
  stage0State: Stage0State | null;
  sessionStartedAtMs: number;
  suspendedAtMs: number;
  lastBoutSummary: GuidedBoutSummary | null;
}

export interface StartGuidedSessionPayload {
  chunks: MotorChunk[];
  firstChunkSteps: PracticeStep[];
  speedMultiplier: number;
  nowMs: number;
  startInStage0?: boolean;
  coldProbeSessionMode?: boolean;
  plannedItems?: PlannedQueueItem[];
  schedulerState?: MotorSchedulerState | null;
  sessionId?: string;
}

export interface CompletePlayingBoutOptions {
  summary?: Partial<GuidedBoutSummary>;
  persistedEvent?: PracticeEvent | null;
  piecePracticeState?: PiecePracticeState | null;
  schedulerState?: MotorSchedulerState | null;
  enterMacroRest?: boolean;
  insertRescueItem?: PlannedQueueItem | null;
  lastProbeResult?: ColdStartProbeEvaluation | null;
  pauseForProbeFailure?: boolean;
}

export interface GuidedSessionState {
  studioMode: StudioMode;
  sessionPhase: GuidedSessionPhase;
  sessionId: string | null;
  timeBoxMinutes: GuidedTimeBoxMinutes;
  selectedMacroSectionId: string | null;
  chunkQueue: MotorChunk[];
  plannedQueue: PlannedQueueItem[];
  currentQueueIndex: number;
  stage0State: Stage0State | null;
  schedulerState: MotorSchedulerState | null;
  piecePracticeState: PiecePracticeState | null;
  activeBoutSpeedMultiplier: number | null;
  activeBoutPracticeMode: PracticeMode | null;
  bottomSlotView: BottomSlotView;
  cc64CommandEnabled: boolean;
  microRestDurationSec: number;
  audiationPreviewMode: AudiationPreviewMode;
  audiationImageryTimerEnabled: boolean;
  overspeedProbeEnabled: boolean;
  blindColdProbeEnabled: boolean;
  blindPeekUntilMs: number | null;
  coldProbeSessionMode: boolean;
  bridgeWindowState: BridgeWindowState | null;
  lastProbeResult: ColdStartProbeEvaluation | null;
  inSessionCompletedChunkIds: string[];
  probeRetriesByItemId: Record<string, number>;
  scaffoldingPreference: ScaffoldingPreference;
  l3SilentBeatEnabled: boolean;
  scaffoldingPeekUntilMs: number | null;
  ehsEnabled: boolean;
  ehsLookaheadPreset: EhsActiveLookaheadPreset;
  ehsGhostOpacity: EhsGhostOpacity;
  ehsAutoStallFlashEnabled: boolean;
  ehsProgressionState: EhsProgressionState;
  ehsProgressionPrompt: EhsProgressionPrompt | null;
  sessionStartedAtMs: number | null;
  pausedFromPhase: "stage0" | "playing" | null;
  microRestStartedAtMs: number | null;
  microRestDurationMs: number;
  microRestReminder: string | null;
  microRestState: MicroRestState | null;
  macroRestStartedAtMs: number | null;
  macroRestDurationMs: number;
  audiationState: AudiationPrimingState | null;
  chunkPassCountsById: Record<string, number>;
  commandNotice: string | null;
  lastBoutSummary: GuidedBoutSummary | null;
  lastPersistedEvent: PracticeEvent | null;
  suspendedSnapshot: SuspendedGuidedSessionSnapshot | null;

  enterGuidedLaunch: () => void;
  returnToFreeStudio: () => void;
  setTimeBoxMinutes: (minutes: GuidedTimeBoxMinutes) => void;
  setSelectedMacroSectionId: (sectionId: string | null) => void;
  setCc64CommandEnabled: (enabled: boolean) => void;
  setMicroRestDurationSec: (sec: number) => void;
  setAudiationPreviewMode: (mode: AudiationPreviewMode) => void;
  setAudiationImageryTimerEnabled: (enabled: boolean) => void;
  setOverspeedProbeEnabled: (enabled: boolean) => void;
  setBlindColdProbeEnabled: (enabled: boolean) => void;
  setBlindPeekUntilMs: (untilMs: number | null) => void;
  setBridgeWindowState: (next: BridgeWindowState | null) => void;
  setLastProbeResult: (next: ColdStartProbeEvaluation | null) => void;
  markChunkCompletedInSession: (chunkId: string) => void;
  incrementProbeRetry: (itemId: string) => void;
  appendClosingProbes: (probeItems: PlannedQueueItem[]) => void;
  setScaffoldingPreference: (preference: ScaffoldingPreference) => void;
  setL3SilentBeatEnabled: (enabled: boolean) => void;
  setScaffoldingPeekUntilMs: (untilMs: number | null) => void;
  setEhsEnabled: (enabled: boolean) => void;
  setEhsLookaheadPreset: (preset: EhsActiveLookaheadPreset) => void;
  setEhsGhostOpacity: (opacity: EhsGhostOpacity) => void;
  setEhsAutoStallFlashEnabled: (enabled: boolean) => void;
  setEhsProgression: (state: EhsProgressionState, prompt: EhsProgressionPrompt | null) => void;
  acceptEhsProgressionPrompt: () => void;
  dismissEhsProgressionPrompt: () => void;
  setPiecePracticeState: (next: PiecePracticeState | null) => void;
  setSchedulerState: (next: MotorSchedulerState | null) => void;
  setLastPersistedEvent: (ev: PracticeEvent | null) => void;
  setBottomSlotView: (view: BottomSlotView) => void;
  toggleBottomSlotView: () => void;
  setCommandNotice: (notice: string | null) => void;
  setMicroRestReminder: (reminder: string | null) => void;
  recordMicroRestAccidentalKey: (nowMs: number) => void;
  setAudiationState: (next: AudiationPrimingState | null) => void;
  seedChunkPassCounts: (counts: Record<string, number>) => void;

  startSession: (payload: StartGuidedSessionPayload) => void;
  setStage0State: (next: Stage0State | null) => void;
  graduateStage0ToPlaying: (nowMs: number) => void;
  completePlayingBout: (nowMs: number, options?: CompletePlayingBoutOptions) => void;
  skipMicroRest: (nowMs?: number) => void;
  finishMicroRest: (nowMs?: number) => void;
  skipMacroRest: (nowMs?: number) => void;
  finishMacroRest: (nowMs?: number) => void;
  markLastBoutHardUI: (
    updatedEvent: PracticeEvent,
    nextPieceState: PiecePracticeState | null,
    nextSchedulerState: MotorSchedulerState | null,
  ) => void;
  pauseActivePlay: (nowMs: number) => void;
  resumePausedPlay: (nowMs: number) => void;
  advanceToNextChunk: (stepsForNextChunk: PracticeStep[], speedMultiplier: number, nowMs: number) => void;
  replayCurrentChunk: (stepsForChunk: PracticeStep[], speedMultiplier: number, nowMs: number, useStage0?: boolean) => void;
  suspendForFingering: (nowMs: number) => void;
  resumeSuspendedSession: (refreshedChunks: MotorChunk[], nowMs: number) => void;
  endSession: () => void;
  reset: () => void;
}

export const DEFAULT_MICRO_REST_DURATION_MS = DEFAULT_MICRO_REST_DURATION_SEC * 1000;

const initialGuidedState = {
  studioMode: "free" as StudioMode,
  sessionPhase: "idle" as GuidedSessionPhase,
  sessionId: null as string | null,
  timeBoxMinutes: 25 as GuidedTimeBoxMinutes,
  selectedMacroSectionId: null as string | null,
  chunkQueue: [] as MotorChunk[],
  plannedQueue: [] as PlannedQueueItem[],
  currentQueueIndex: 0,
  stage0State: null as Stage0State | null,
  schedulerState: null as MotorSchedulerState | null,
  piecePracticeState: null as PiecePracticeState | null,
  activeBoutSpeedMultiplier: null as number | null,
  activeBoutPracticeMode: null as PracticeMode | null,
  bottomSlotView: "piano" as BottomSlotView,
  cc64CommandEnabled: false,
  microRestDurationSec: DEFAULT_MICRO_REST_DURATION_SEC,
  audiationPreviewMode: "auto-unfamiliar" as AudiationPreviewMode,
  audiationImageryTimerEnabled: false,
  overspeedProbeEnabled: false,
  blindColdProbeEnabled: false,
  blindPeekUntilMs: null as number | null,
  coldProbeSessionMode: false,
  bridgeWindowState: null as BridgeWindowState | null,
  lastProbeResult: null as ColdStartProbeEvaluation | null,
  inSessionCompletedChunkIds: [] as string[],
  probeRetriesByItemId: {} as Record<string, number>,
  scaffoldingPreference: "auto-fade" as ScaffoldingPreference,
  l3SilentBeatEnabled: true,
  scaffoldingPeekUntilMs: null as number | null,
  ehsEnabled: EHS_DEFAULT_ENABLED,
  ehsLookaheadPreset: EHS_DEFAULT_PRESET as EhsActiveLookaheadPreset,
  ehsGhostOpacity: EHS_DEFAULT_GHOST_OPACITY as EhsGhostOpacity,
  ehsAutoStallFlashEnabled: EHS_DEFAULT_AUTO_STALL_FLASH_ENABLED,
  ehsProgressionState: {
    preset: EHS_DEFAULT_PRESET as EhsActiveLookaheadPreset,
    consecutiveSmoothPasses: 0,
  } as EhsProgressionState,
  ehsProgressionPrompt: null as EhsProgressionPrompt | null,
  sessionStartedAtMs: null as number | null,
  pausedFromPhase: null as "stage0" | "playing" | null,
  microRestStartedAtMs: null as number | null,
  microRestDurationMs: DEFAULT_MICRO_REST_DURATION_MS,
  microRestReminder: null as string | null,
  microRestState: null as MicroRestState | null,
  macroRestStartedAtMs: null as number | null,
  macroRestDurationMs: EARLY_MACRO_REST_DURATION_MS,
  audiationState: null as AudiationPrimingState | null,
  chunkPassCountsById: {} as Record<string, number>,
  commandNotice: null as string | null,
  lastBoutSummary: null as GuidedBoutSummary | null,
  lastPersistedEvent: null as PracticeEvent | null,
  suspendedSnapshot: null as SuspendedGuidedSessionSnapshot | null,
};

function findBestQueueIndex(
  snapshot: SuspendedGuidedSessionSnapshot,
  refreshedChunks: MotorChunk[],
): number {
  if (refreshedChunks.length === 0) return 0;
  const oldChunk = snapshot.chunkQueue[snapshot.currentQueueIndex];
  if (!oldChunk) {
    return Math.min(snapshot.currentQueueIndex, refreshedChunks.length - 1);
  }
  const byId = refreshedChunks.findIndex((c) => c.chunkId === oldChunk.chunkId);
  if (byId >= 0) return byId;
  const byMeasure = refreshedChunks.findIndex(
    (c) =>
      c.startMeasureIndex <= oldChunk.startMeasureIndex &&
      c.endMeasureIndex >= oldChunk.startMeasureIndex,
  );
  if (byMeasure >= 0) return byMeasure;
  return Math.min(snapshot.currentQueueIndex, refreshedChunks.length - 1);
}

/**
 * Dedicated Zustand store for Guided Session orchestration, keeping `useStudioStore`
 * strictly scoped to Score Document, fingerings, Finger Anchors, repair, and Undo/Redo.
 */
export const useGuidedSessionStore = create<GuidedSessionState>((set, get) => ({
  ...initialGuidedState,

  enterGuidedLaunch: () =>
    set({
      studioMode: "guided",
      sessionPhase: "launch",
      commandNotice: null,
      microRestReminder: null,
      bottomSlotView: "piano",
    }),

  returnToFreeStudio: () =>
    set({
      studioMode: "free",
      sessionPhase: "idle",
      sessionId: null,
      chunkQueue: [],
      plannedQueue: [],
      currentQueueIndex: 0,
      stage0State: null,
      schedulerState: null,
      activeBoutSpeedMultiplier: null,
      activeBoutPracticeMode: null,
      pausedFromPhase: null,
      microRestStartedAtMs: null,
      microRestReminder: null,
      microRestState: null,
      macroRestStartedAtMs: null,
      audiationState: null,
      blindPeekUntilMs: null,
      coldProbeSessionMode: false,
      bridgeWindowState: null,
      lastProbeResult: null,
      inSessionCompletedChunkIds: [],
      probeRetriesByItemId: {},
      commandNotice: null,
      scaffoldingPeekUntilMs: null,
      bottomSlotView: "piano",
    }),

  setTimeBoxMinutes: (timeBoxMinutes) => set({ timeBoxMinutes }),

  setSelectedMacroSectionId: (selectedMacroSectionId) => set({ selectedMacroSectionId }),

  setCc64CommandEnabled: (cc64CommandEnabled) => set({ cc64CommandEnabled }),

  setMicroRestDurationSec: (sec) => {
    const clamped = clampMicroRestDurationSec(sec);
    set((state) => ({
      microRestDurationSec: clamped,
      microRestDurationMs: clamped * 1000,
      microRestState: state.microRestState
        ? { ...state.microRestState, durationMs: clamped * 1000 }
        : null,
    }));
  },

  setAudiationPreviewMode: (audiationPreviewMode) => set({ audiationPreviewMode }),

  setAudiationImageryTimerEnabled: (audiationImageryTimerEnabled) =>
    set({ audiationImageryTimerEnabled }),

  setOverspeedProbeEnabled: (overspeedProbeEnabled) => set({ overspeedProbeEnabled }),

  setBlindColdProbeEnabled: (blindColdProbeEnabled) => set({ blindColdProbeEnabled }),

  setBlindPeekUntilMs: (blindPeekUntilMs) => set({ blindPeekUntilMs }),

  setBridgeWindowState: (bridgeWindowState) => set({ bridgeWindowState }),

  setLastProbeResult: (lastProbeResult) => set({ lastProbeResult }),

  markChunkCompletedInSession: (chunkId) =>
    set((state) =>
      state.inSessionCompletedChunkIds.includes(chunkId)
        ? state
        : { inSessionCompletedChunkIds: [...state.inSessionCompletedChunkIds, chunkId] },
    ),

  incrementProbeRetry: (itemId) =>
    set((state) => ({
      probeRetriesByItemId: {
        ...state.probeRetriesByItemId,
        [itemId]: (state.probeRetriesByItemId[itemId] ?? 0) + 1,
      },
    })),

  appendClosingProbes: (probeItems) =>
    set((state) => {
      if (probeItems.length === 0) return state;
      return {
        chunkQueue: [...state.chunkQueue, ...probeItems.map((i) => i.chunk)],
        plannedQueue: [...state.plannedQueue, ...probeItems],
      };
    }),

  setScaffoldingPreference: (scaffoldingPreference) => set({ scaffoldingPreference }),

  setL3SilentBeatEnabled: (l3SilentBeatEnabled) => set({ l3SilentBeatEnabled }),

  setScaffoldingPeekUntilMs: (scaffoldingPeekUntilMs) => set({ scaffoldingPeekUntilMs }),

  setEhsEnabled: (ehsEnabled) => set({ ehsEnabled }),

  setEhsLookaheadPreset: (ehsLookaheadPreset) =>
    set({
      ehsLookaheadPreset,
      ehsProgressionState: { preset: ehsLookaheadPreset, consecutiveSmoothPasses: 0 },
      ehsProgressionPrompt: null,
    }),

  setEhsGhostOpacity: (ehsGhostOpacity) => set({ ehsGhostOpacity }),

  setEhsAutoStallFlashEnabled: (ehsAutoStallFlashEnabled) => set({ ehsAutoStallFlashEnabled }),

  setEhsProgression: (ehsProgressionState, ehsProgressionPrompt) =>
    set({ ehsProgressionState, ehsProgressionPrompt }),

  acceptEhsProgressionPrompt: () =>
    set((state) => {
      if (!state.ehsProgressionPrompt) return state;
      const nextPreset = state.ehsProgressionPrompt.toPreset;
      return {
        ehsLookaheadPreset: nextPreset,
        ehsProgressionState: { preset: nextPreset, consecutiveSmoothPasses: 0 },
        ehsProgressionPrompt: null,
      };
    }),

  dismissEhsProgressionPrompt: () => set({ ehsProgressionPrompt: null }),

  setPiecePracticeState: (piecePracticeState) => set({ piecePracticeState }),

  setSchedulerState: (schedulerState) => set({ schedulerState }),

  setLastPersistedEvent: (lastPersistedEvent) => set({ lastPersistedEvent }),

  setBottomSlotView: (bottomSlotView) => set({ bottomSlotView }),

  toggleBottomSlotView: () =>
    set((state) => ({
      bottomSlotView: state.bottomSlotView === "piano" ? "feedback" : "piano",
    })),

  setCommandNotice: (commandNotice) => set({ commandNotice }),

  setMicroRestReminder: (microRestReminder) => set({ microRestReminder }),

  recordMicroRestAccidentalKey: (nowMs) =>
    set((state) => {
      const base =
        state.microRestState ??
        createMicroRestState({
          startedAtMs: state.microRestStartedAtMs ?? nowMs,
          durationSec: state.microRestDurationSec,
        });
      const next = recordMicroRestAccidentalKeystroke(base, nowMs);
      return {
        microRestState: next,
        microRestReminder: next.reminderMessage,
      };
    }),

  setAudiationState: (audiationState) => set({ audiationState }),

  seedChunkPassCounts: (counts) => set({ chunkPassCountsById: { ...counts } }),

  startSession: ({
    chunks,
    firstChunkSteps,
    speedMultiplier,
    nowMs,
    startInStage0 = true,
    coldProbeSessionMode = false,
    plannedItems = [],
    schedulerState = null,
    sessionId,
  }) => {
    if (chunks.length === 0) return;
    const firstChunk = chunks[0];
    const firstPlanned = plannedItems[0] ?? null;
    const effectiveSpeed = firstPlanned ? firstPlanned.targetSpeed : speedMultiplier;
    const shouldStage0 =
      startInStage0 && !(firstPlanned?.skipStage0) && firstChunkSteps.length > 0;
    const stage0State = shouldStage0
      ? createStage0State({
          chunkId: firstChunk.chunkId,
          steps: firstChunkSteps,
          startedAtMs: nowMs,
          speedMultiplier: effectiveSpeed,
        })
      : null;

    set({
      studioMode: "guided",
      sessionPhase: shouldStage0 ? "stage0" : "playing",
      sessionId: sessionId ?? `gs-${nowMs}`,
      chunkQueue: chunks,
      plannedQueue: plannedItems,
      currentQueueIndex: 0,
      stage0State,
      schedulerState,
      activeBoutSpeedMultiplier: effectiveSpeed,
      activeBoutPracticeMode: null,
      bottomSlotView: "piano",
      sessionStartedAtMs: nowMs,
      pausedFromPhase: null,
      microRestStartedAtMs: null,
      microRestReminder: null,
      microRestState: null,
      macroRestStartedAtMs: null,
      audiationState: null,
      blindPeekUntilMs: null,
      coldProbeSessionMode,
      bridgeWindowState: null,
      lastProbeResult: null,
      inSessionCompletedChunkIds: [],
      probeRetriesByItemId: {},
      commandNotice: null,
      scaffoldingPeekUntilMs: null,
      lastBoutSummary: null,
      lastPersistedEvent: null,
      suspendedSnapshot: null,
      ehsProgressionState: {
        preset: get().ehsLookaheadPreset,
        consecutiveSmoothPasses: 0,
      },
      ehsProgressionPrompt: null,
    });
  },

  setStage0State: (stage0State) => set({ stage0State }),

  graduateStage0ToPlaying: (_nowMs) => {
    const state = get();
    const chunk = state.chunkQueue[state.currentQueueIndex];
    if (!chunk) return;
    const telemetry = state.stage0State ? buildStage0TelemetrySummary(state.stage0State) : null;
    const reasonText =
      telemetry?.graduationReason === "time-cap"
        ? "已达 2 分钟 Stage 0 上限，自动转入定速连贯弹奏"
        : "Stage 0 顺畅通过（准确率 ≥ 90% 且无长犹豫），进入定速连贯弹奏";

    set({
      sessionPhase: "playing",
      pausedFromPhase: null,
      bottomSlotView: "piano",
      commandNotice: reasonText,
      lastBoutSummary: {
        chunkId: chunk.chunkId,
        chunkIndex: state.currentQueueIndex,
        startMeasureIndex: chunk.startMeasureIndex,
        endMeasureIndex: chunk.endMeasureIndex,
        stage: "stage0",
        graduationReason: telemetry?.graduationReason ?? "smooth-pass",
        accuracy: telemetry?.lastPassAccuracy ?? 1,
        passAttempts: telemetry?.passAttempts ?? 1,
        telemetryIsolated: true,
        headline: `块 ${chunk.index + 1}（m.${chunk.startMeasureIndex + 1}–${chunk.endMeasureIndex + 1}）完成 Stage 0 落键`,
        detail: reasonText,
      },
    });
  },

  completePlayingBout: (nowMs, options) => {
    const state = get();
    const chunk = state.chunkQueue[state.currentQueueIndex];
    if (!chunk) return;
    const prevPasses = state.chunkPassCountsById[chunk.chunkId] ?? 0;

    let nextChunkQueue = state.chunkQueue;
    let nextPlannedQueue = state.plannedQueue;
    if (options?.insertRescueItem) {
      const insertAt = state.currentQueueIndex + 1;
      nextChunkQueue = [
        ...state.chunkQueue.slice(0, insertAt),
        options.insertRescueItem.chunk,
        ...state.chunkQueue.slice(insertAt),
      ];
      if (state.plannedQueue.length > 0) {
        nextPlannedQueue = [
          ...state.plannedQueue.slice(0, insertAt),
          options.insertRescueItem,
          ...state.plannedQueue.slice(insertAt),
        ];
      }
    }

    const enterMacroRest = Boolean(options?.enterMacroRest);
    const pauseForProbeFailure = Boolean(options?.pauseForProbeFailure);
    const microRestState =
      enterMacroRest || pauseForProbeFailure
        ? null
        : createMicroRestState({
            startedAtMs: nowMs,
            durationSec: state.microRestDurationSec,
          });

    const summaryPatch = options?.summary;
    const nextSummary: GuidedBoutSummary = {
      chunkId: chunk.chunkId,
      chunkIndex: state.currentQueueIndex,
      startMeasureIndex: chunk.startMeasureIndex,
      endMeasureIndex: chunk.endMeasureIndex,
      stage: "continuous",
      accuracy: summaryPatch?.accuracy ?? state.lastBoutSummary?.accuracy ?? 1,
      passAttempts: summaryPatch?.passAttempts ?? (state.lastBoutSummary?.passAttempts ?? 0) + 1,
      telemetryIsolated: false,
      ...(summaryPatch?.acousticProfile ? { acousticProfile: summaryPatch.acousticProfile } : {}),
      headline:
        summaryPatch?.headline ??
        `块 ${chunk.index + 1}（m.${chunk.startMeasureIndex + 1}–${chunk.endMeasureIndex + 1}）回合结束`,
      detail:
        summaryPatch?.detail ??
        (enterMacroRest
          ? "进入前期离键大休息（Early Macro-Rest）以放大跨夜巩固"
          : "进入清醒微休息，静放双手以巩固动作记忆"),
      ...(summaryPatch?.boutKind ? { boutKind: summaryPatch.boutKind } : {}),
      ...(summaryPatch?.speedMultiplier !== undefined
        ? { speedMultiplier: summaryPatch.speedMultiplier }
        : {}),
      ...(summaryPatch?.autoGrade !== undefined ? { autoGrade: summaryPatch.autoGrade } : {}),
      ...(summaryPatch?.effectiveGrade !== undefined
        ? { effectiveGrade: summaryPatch.effectiveGrade }
        : {}),
      ...(summaryPatch?.canMarkHard !== undefined ? { canMarkHard: summaryPatch.canMarkHard } : {}),
      ...(summaryPatch?.markedHard !== undefined ? { markedHard: summaryPatch.markedHard } : {}),
    };

    set({
      sessionPhase: pauseForProbeFailure
        ? "paused"
        : enterMacroRest
          ? "macro-rest"
          : "micro-rest",
      pausedFromPhase: pauseForProbeFailure ? "playing" : null,
      bottomSlotView: pauseForProbeFailure ? "feedback" : state.bottomSlotView,
      chunkQueue: nextChunkQueue,
      plannedQueue: nextPlannedQueue,
      microRestStartedAtMs: enterMacroRest || pauseForProbeFailure ? null : nowMs,
      microRestDurationMs: microRestState ? microRestState.durationMs : state.microRestDurationMs,
      microRestReminder: null,
      microRestState,
      macroRestStartedAtMs: enterMacroRest ? nowMs : null,
      audiationState: null,
      blindPeekUntilMs: null,
      ...(options?.lastProbeResult !== undefined
        ? { lastProbeResult: options.lastProbeResult }
        : { lastProbeResult: null }),
      chunkPassCountsById: {
        ...state.chunkPassCountsById,
        [chunk.chunkId]: prevPasses + 1,
      },
      ...(options?.persistedEvent !== undefined
        ? { lastPersistedEvent: options.persistedEvent }
        : {}),
      ...(options?.piecePracticeState !== undefined
        ? { piecePracticeState: options.piecePracticeState }
        : {}),
      ...(options?.schedulerState !== undefined ? { schedulerState: options.schedulerState } : {}),
      commandNotice: pauseForProbeFailure ? (options?.lastProbeResult?.reasonSummary ?? null) : null,
      scaffoldingPeekUntilMs: null,
      lastBoutSummary: nextSummary,
    });
  },

  skipMicroRest: (nowMs = Date.now()) =>
    set((state) => {
      const nextChunk = state.chunkQueue[state.currentQueueIndex + 1] ?? null;
      if (!nextChunk) {
        return {
          sessionPhase: "summary",
          bottomSlotView: "feedback",
          microRestStartedAtMs: null,
          microRestReminder: null,
          microRestState: null,
          audiationState: null,
        };
      }
      return {
        sessionPhase: "audiation",
        bottomSlotView: "feedback",
        microRestStartedAtMs: null,
        microRestReminder: null,
        microRestState: null,
        audiationState: createAudiationPrimingState({
          enteredAtMs: nowMs,
          chunkId: nextChunk.chunkId,
          historicalPassCount: state.chunkPassCountsById[nextChunk.chunkId] ?? 0,
          previewMode: state.audiationPreviewMode,
          imageryTimerEnabled: state.audiationImageryTimerEnabled,
        }),
      };
    }),

  finishMicroRest: (nowMs = Date.now()) =>
    set((state) => {
      const nextChunk = state.chunkQueue[state.currentQueueIndex + 1] ?? null;
      if (!nextChunk) {
        return {
          sessionPhase: "summary",
          bottomSlotView: "feedback",
          microRestStartedAtMs: null,
          microRestReminder: null,
          microRestState: null,
          audiationState: null,
        };
      }
      return {
        sessionPhase: "audiation",
        bottomSlotView: "feedback",
        microRestStartedAtMs: null,
        microRestReminder: null,
        microRestState: null,
        audiationState: createAudiationPrimingState({
          enteredAtMs: nowMs,
          chunkId: nextChunk.chunkId,
          historicalPassCount: state.chunkPassCountsById[nextChunk.chunkId] ?? 0,
          previewMode: state.audiationPreviewMode,
          imageryTimerEnabled: state.audiationImageryTimerEnabled,
        }),
      };
    }),

  skipMacroRest: (nowMs = Date.now()) =>
    set((state) => {
      const nextScheduler = state.schedulerState
        ? skipEarlyMacroRest(state.schedulerState, nowMs)
        : null;
      const nextChunk = state.chunkQueue[state.currentQueueIndex + 1] ?? null;
      if (!nextChunk) {
        return {
          sessionPhase: "summary",
          bottomSlotView: "feedback",
          macroRestStartedAtMs: null,
          schedulerState: nextScheduler,
          audiationState: null,
        };
      }
      return {
        sessionPhase: "audiation",
        bottomSlotView: "feedback",
        macroRestStartedAtMs: null,
        schedulerState: nextScheduler,
        audiationState: createAudiationPrimingState({
          enteredAtMs: nowMs,
          chunkId: nextChunk.chunkId,
          historicalPassCount: state.chunkPassCountsById[nextChunk.chunkId] ?? 0,
          previewMode: state.audiationPreviewMode,
          imageryTimerEnabled: state.audiationImageryTimerEnabled,
        }),
      };
    }),

  finishMacroRest: (nowMs = Date.now()) => {
    get().skipMacroRest(nowMs);
  },

  markLastBoutHardUI: (updatedEvent, nextPieceState, nextSchedulerState) =>
    set((state) => ({
      lastPersistedEvent: updatedEvent,
      piecePracticeState: nextPieceState,
      schedulerState: nextSchedulerState,
      lastBoutSummary: state.lastBoutSummary
        ? {
            ...state.lastBoutSummary,
            effectiveGrade: 2,
            canMarkHard: false,
            markedHard: true,
            detail: "已保守标为 Hard，保持当前速度巩固",
          }
        : null,
    })),

  pauseActivePlay: (nowMs) =>
    set((state) => {
      if (state.sessionPhase !== "stage0" && state.sessionPhase !== "playing") {
        return state;
      }
      return {
        sessionPhase: "paused",
        pausedFromPhase: state.sessionPhase,
        stage0State: state.stage0State ? pauseStage0(state.stage0State, nowMs) : null,
        scaffoldingPeekUntilMs: null,
        commandNotice: "已暂停练习（按 C8 / 空格继续，或 A0 重练本块）",
      };
    }),

  resumePausedPlay: (nowMs) =>
    set((state) => {
      if (state.sessionPhase !== "paused") return state;
      const targetPhase = state.pausedFromPhase ?? "playing";
      return {
        sessionPhase: targetPhase,
        pausedFromPhase: null,
        bottomSlotView: "piano",
        stage0State:
          targetPhase === "stage0" && state.stage0State
            ? resumeStage0(state.stage0State, nowMs)
            : state.stage0State,
        commandNotice: null,
      };
    }),

  advanceToNextChunk: (stepsForNextChunk, speedMultiplier, nowMs) => {
    const state = get();
    const nextIdx = state.currentQueueIndex + 1;
    if (nextIdx >= state.chunkQueue.length) {
      set({
        sessionPhase: "summary",
        bottomSlotView: "feedback",
        pausedFromPhase: null,
        microRestStartedAtMs: null,
        microRestReminder: null,
        microRestState: null,
        audiationState: null,
        commandNotice: "本轮队列已完成",
      });
      return;
    }
    const nextChunk = state.chunkQueue[nextIdx];
    const nextPlanned = state.plannedQueue[nextIdx] ?? null;
    const effectiveSpeed = nextPlanned ? nextPlanned.targetSpeed : speedMultiplier;
    const shouldStage0 = !(nextPlanned?.skipStage0) && stepsForNextChunk.length > 0;
    set({
      currentQueueIndex: nextIdx,
      sessionPhase: shouldStage0 ? "stage0" : "playing",
      activeBoutSpeedMultiplier: effectiveSpeed,
      activeBoutPracticeMode: null,
      pausedFromPhase: null,
      microRestStartedAtMs: null,
      microRestReminder: null,
      microRestState: null,
      macroRestStartedAtMs: null,
      audiationState: null,
      blindPeekUntilMs: null,
      lastProbeResult: null,
      bottomSlotView: "piano",
      commandNotice: null,
      scaffoldingPeekUntilMs: null,
      stage0State: shouldStage0
        ? createStage0State({
            chunkId: nextChunk.chunkId,
            steps: stepsForNextChunk,
            startedAtMs: nowMs,
            speedMultiplier: effectiveSpeed,
          })
        : null,
    });
  },

  replayCurrentChunk: (stepsForChunk, speedMultiplier, nowMs, useStage0 = true) => {
    const state = get();
    const chunk = state.chunkQueue[state.currentQueueIndex];
    if (!chunk) return;
    const shouldStage0 = useStage0 && stepsForChunk.length > 0;
    set({
      sessionPhase: shouldStage0 ? "stage0" : "playing",
      pausedFromPhase: null,
      microRestStartedAtMs: null,
      microRestReminder: null,
      microRestState: null,
      audiationState: null,
      bottomSlotView: "piano",
      commandNotice: null,
      scaffoldingPeekUntilMs: null,
      stage0State: shouldStage0
        ? createStage0State({
            chunkId: chunk.chunkId,
            steps: stepsForChunk,
            startedAtMs: nowMs,
            speedMultiplier,
          })
        : null,
    });
  },

  suspendForFingering: (nowMs) => {
    const state = get();
    const pausedStage0 = state.stage0State ? pauseStage0(state.stage0State, nowMs) : null;
    const resumePhase: GuidedSessionPhase =
      state.sessionPhase === "stage0"
        ? "stage0"
        : state.sessionPhase === "playing"
          ? "paused"
          : state.sessionPhase === "paused"
            ? "paused"
            : state.sessionPhase === "micro-rest" || state.sessionPhase === "audiation"
              ? "audiation"
              : "paused";

    set({
      studioMode: "free",
      sessionPhase: "suspended",
      bottomSlotView: "piano",
      commandNotice: null,
      scaffoldingPeekUntilMs: null,
      microRestReminder: null,
      stage0State: pausedStage0,
      suspendedSnapshot: {
        timeBoxMinutes: state.timeBoxMinutes,
        selectedMacroSectionId: state.selectedMacroSectionId,
        chunkQueue: state.chunkQueue,
        currentQueueIndex: state.currentQueueIndex,
        resumePhase,
        stage0State: pausedStage0,
        sessionStartedAtMs: state.sessionStartedAtMs ?? nowMs,
        suspendedAtMs: nowMs,
        lastBoutSummary: state.lastBoutSummary,
      },
    });
  },

  resumeSuspendedSession: (refreshedChunks, nowMs) => {
    const state = get();
    const snap = state.suspendedSnapshot;
    if (!snap) return;

    const queue = refreshedChunks.length > 0 ? refreshedChunks : snap.chunkQueue;
    const filteredQueue =
      snap.selectedMacroSectionId !== null
        ? queue.filter((c) => c.sectionId === snap.selectedMacroSectionId)
        : queue;
    const effectiveQueue = filteredQueue.length > 0 ? filteredQueue : queue;
    const restoredIndex = findBestQueueIndex(snap, effectiveQueue);
    const restoredPhase = snap.resumePhase === "suspended" ? "paused" : snap.resumePhase;
    const resumedStage0 =
      restoredPhase === "stage0" && snap.stage0State
        ? resumeStage0(snap.stage0State, nowMs)
        : snap.stage0State;

    set({
      studioMode: "guided",
      sessionPhase: restoredPhase,
      timeBoxMinutes: snap.timeBoxMinutes,
      selectedMacroSectionId: snap.selectedMacroSectionId,
      chunkQueue: effectiveQueue,
      currentQueueIndex: restoredIndex,
      stage0State: resumedStage0,
      sessionStartedAtMs: snap.sessionStartedAtMs,
      lastBoutSummary: snap.lastBoutSummary,
      pausedFromPhase: restoredPhase === "paused" ? "playing" : null,
      bottomSlotView: "piano",
      commandNotice: "已恢复科学练琴会话，并同步最新指法与 Transition Cue",
      suspendedSnapshot: null,
    });
  },

  endSession: () =>
    set((state) => ({
      ...initialGuidedState,
      cc64CommandEnabled: state.cc64CommandEnabled,
      microRestDurationSec: state.microRestDurationSec,
      microRestDurationMs: state.microRestDurationSec * 1000,
      audiationPreviewMode: state.audiationPreviewMode,
      audiationImageryTimerEnabled: state.audiationImageryTimerEnabled,
      overspeedProbeEnabled: state.overspeedProbeEnabled,
      blindColdProbeEnabled: state.blindColdProbeEnabled,
      scaffoldingPreference: state.scaffoldingPreference,
      l3SilentBeatEnabled: state.l3SilentBeatEnabled,
      ehsEnabled: state.ehsEnabled,
      ehsLookaheadPreset: state.ehsLookaheadPreset,
      ehsGhostOpacity: state.ehsGhostOpacity,
      ehsAutoStallFlashEnabled: state.ehsAutoStallFlashEnabled,
      ehsProgressionState: {
        preset: state.ehsLookaheadPreset,
        consecutiveSmoothPasses: 0,
      },
      ehsProgressionPrompt: null,
      scaffoldingPeekUntilMs: null,
      piecePracticeState: state.piecePracticeState,
      chunkPassCountsById: state.chunkPassCountsById,
      studioMode: "free",
      sessionPhase: "idle",
    })),

  reset: () => set({ ...initialGuidedState }),
}));
