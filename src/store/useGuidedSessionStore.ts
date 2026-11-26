import { create } from "zustand";
import type { MotorChunk } from "../chunking/types";
import type { PracticeStep } from "../domain/types";
import type { AcousticProfileResult } from "../guided/acousticProfile";
import type { GuidedSessionPhase } from "../guided/pianoCommandKeys";
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

export type StudioMode = "free" | "guided";
export type GuidedTimeBoxMinutes = 15 | 25 | 40;
export type BottomSlotView = "piano" | "feedback";

export interface GuidedBoutSummary {
  chunkId: string;
  chunkIndex: number;
  startMeasureIndex: number;
  endMeasureIndex: number;
  stage: "stage0" | "continuous";
  graduationReason?: Stage0GraduationReason;
  accuracy: number;
  passAttempts: number;
  telemetryIsolated: boolean;
  acousticProfile?: AcousticProfileResult;
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
}

export interface GuidedSessionState {
  studioMode: StudioMode;
  sessionPhase: GuidedSessionPhase;
  timeBoxMinutes: GuidedTimeBoxMinutes;
  selectedMacroSectionId: string | null;
  chunkQueue: MotorChunk[];
  currentQueueIndex: number;
  stage0State: Stage0State | null;
  bottomSlotView: BottomSlotView;
  cc64CommandEnabled: boolean;
  microRestDurationSec: number;
  audiationPreviewMode: AudiationPreviewMode;
  audiationImageryTimerEnabled: boolean;
  sessionStartedAtMs: number | null;
  pausedFromPhase: "stage0" | "playing" | null;
  microRestStartedAtMs: number | null;
  microRestDurationMs: number;
  microRestReminder: string | null;
  microRestState: MicroRestState | null;
  audiationState: AudiationPrimingState | null;
  chunkPassCountsById: Record<string, number>;
  commandNotice: string | null;
  lastBoutSummary: GuidedBoutSummary | null;
  suspendedSnapshot: SuspendedGuidedSessionSnapshot | null;

  enterGuidedLaunch: () => void;
  returnToFreeStudio: () => void;
  setTimeBoxMinutes: (minutes: GuidedTimeBoxMinutes) => void;
  setSelectedMacroSectionId: (sectionId: string | null) => void;
  setCc64CommandEnabled: (enabled: boolean) => void;
  setMicroRestDurationSec: (sec: number) => void;
  setAudiationPreviewMode: (mode: AudiationPreviewMode) => void;
  setAudiationImageryTimerEnabled: (enabled: boolean) => void;
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
  completePlayingBout: (nowMs: number, payload?: ContinuousBoutCompletionPayload) => void;
  skipMicroRest: (nowMs?: number) => void;
  finishMicroRest: (nowMs?: number) => void;
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
  timeBoxMinutes: 25 as GuidedTimeBoxMinutes,
  selectedMacroSectionId: null as string | null,
  chunkQueue: [] as MotorChunk[],
  currentQueueIndex: 0,
  stage0State: null as Stage0State | null,
  bottomSlotView: "piano" as BottomSlotView,
  cc64CommandEnabled: false,
  microRestDurationSec: DEFAULT_MICRO_REST_DURATION_SEC,
  audiationPreviewMode: "auto-unfamiliar" as AudiationPreviewMode,
  audiationImageryTimerEnabled: false,
  sessionStartedAtMs: null as number | null,
  pausedFromPhase: null as "stage0" | "playing" | null,
  microRestStartedAtMs: null as number | null,
  microRestDurationMs: DEFAULT_MICRO_REST_DURATION_MS,
  microRestReminder: null as string | null,
  microRestState: null as MicroRestState | null,
  audiationState: null as AudiationPrimingState | null,
  chunkPassCountsById: {} as Record<string, number>,
  commandNotice: null as string | null,
  lastBoutSummary: null as GuidedBoutSummary | null,
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
      chunkQueue: [],
      currentQueueIndex: 0,
      stage0State: null,
      pausedFromPhase: null,
      microRestStartedAtMs: null,
      microRestReminder: null,
      microRestState: null,
      audiationState: null,
      commandNotice: null,
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

  startSession: ({ chunks, firstChunkSteps, speedMultiplier, nowMs, startInStage0 = true }) => {
    if (chunks.length === 0) return;
    const firstChunk = chunks[0];
    const shouldStage0 = startInStage0 && firstChunkSteps.length > 0;
    const stage0State = shouldStage0
      ? createStage0State({
          chunkId: firstChunk.chunkId,
          steps: firstChunkSteps,
          startedAtMs: nowMs,
          speedMultiplier,
        })
      : null;

    set({
      studioMode: "guided",
      sessionPhase: shouldStage0 ? "stage0" : "playing",
      chunkQueue: chunks,
      currentQueueIndex: 0,
      stage0State,
      bottomSlotView: "piano",
      sessionStartedAtMs: nowMs,
      pausedFromPhase: null,
      microRestStartedAtMs: null,
      microRestReminder: null,
      microRestState: null,
      audiationState: null,
      commandNotice: null,
      lastBoutSummary: null,
      suspendedSnapshot: null,
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

  completePlayingBout: (nowMs, payload) => {
    const state = get();
    const chunk = state.chunkQueue[state.currentQueueIndex];
    if (!chunk) return;
    const microRestState = createMicroRestState({
      startedAtMs: nowMs,
      durationSec: state.microRestDurationSec,
    });
    const prevPasses = state.chunkPassCountsById[chunk.chunkId] ?? 0;
    const accuracy = payload?.accuracy ?? state.lastBoutSummary?.accuracy ?? 1;
    set({
      sessionPhase: "micro-rest",
      pausedFromPhase: null,
      microRestStartedAtMs: nowMs,
      microRestDurationMs: microRestState.durationMs,
      microRestReminder: null,
      microRestState,
      audiationState: null,
      chunkPassCountsById: {
        ...state.chunkPassCountsById,
        [chunk.chunkId]: prevPasses + 1,
      },
      commandNotice: null,
      lastBoutSummary: {
        chunkId: chunk.chunkId,
        chunkIndex: state.currentQueueIndex,
        startMeasureIndex: chunk.startMeasureIndex,
        endMeasureIndex: chunk.endMeasureIndex,
        stage: "continuous",
        accuracy,
        passAttempts: (state.lastBoutSummary?.passAttempts ?? 0) + 1,
        telemetryIsolated: false,
        ...(payload?.acousticProfile ? { acousticProfile: payload.acousticProfile } : {}),
        headline: `块 ${chunk.index + 1}（m.${chunk.startMeasureIndex + 1}–${chunk.endMeasureIndex + 1}）回合结束`,
        detail: "进入清醒微休息，静放双手以巩固动作记忆",
      },
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

  pauseActivePlay: (nowMs) =>
    set((state) => {
      if (state.sessionPhase !== "stage0" && state.sessionPhase !== "playing") {
        return state;
      }
      return {
        sessionPhase: "paused",
        pausedFromPhase: state.sessionPhase,
        stage0State: state.stage0State ? pauseStage0(state.stage0State, nowMs) : null,
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
    const shouldStage0 = stepsForNextChunk.length > 0;
    set({
      currentQueueIndex: nextIdx,
      sessionPhase: shouldStage0 ? "stage0" : "playing",
      pausedFromPhase: null,
      microRestStartedAtMs: null,
      microRestReminder: null,
      microRestState: null,
      audiationState: null,
      bottomSlotView: "piano",
      commandNotice: null,
      stage0State: shouldStage0
        ? createStage0State({
            chunkId: nextChunk.chunkId,
            steps: stepsForNextChunk,
            startedAtMs: nowMs,
            speedMultiplier,
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
      chunkPassCountsById: state.chunkPassCountsById,
      studioMode: "free",
      sessionPhase: "idle",
    })),

  reset: () => set({ ...initialGuidedState }),
}));
