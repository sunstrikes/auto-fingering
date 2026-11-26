import type { MotorChunk } from "../chunking/types";
import type {
  Hand,
  HandPosition,
  OnsetSlice,
  PracticeMode,
  PracticeStep,
  SolveResult,
} from "../domain/types";
import { midiToPitchLabel } from "../solver/keyboard";

export const MIN_MICRO_REST_DURATION_SEC = 10;
export const MAX_MICRO_REST_DURATION_SEC = 15;
export const DEFAULT_MICRO_REST_DURATION_SEC = 12;
export const MICRO_REST_REMINDER_TEXT = "静放巩固效果更佳 · 按 C8 可跳过";

export const UNFAMILIAR_PASS_THRESHOLD = 2;
export const ADVANCED_IMAGERY_TIMER_SEC = 10;
export const ADVANCED_IMAGERY_TIMER_MS = ADVANCED_IMAGERY_TIMER_SEC * 1000;

export type AudiationPreviewMode = "auto-unfamiliar" | "manual";
export type AudiationPreviewStatus = "idle" | "playing" | "interrupted" | "completed";
export type AudiationInterruptReason = "c8" | "first-note" | "manual-stop" | "a0";

export interface MicroRestState {
  startedAtMs: number;
  durationMs: number;
  accidentalKeystrokeCount: number;
  reminderPulseToken: number;
  reminderMessage: string | null;
}

export interface MicroRestTick {
  elapsedMs: number;
  remainingMs: number;
  remainingSec: number;
  progress: number;
  completed: boolean;
}

export interface AudiationCueSummary {
  chunkId: string | null;
  measureRangeLabel: string;
  isUnfamiliar: boolean;
  historicalPassCount: number;
  shouldAutoPreview: boolean;
  firstTargetMidis: number[];
  handPositionLabels: {
    rh?: string;
    lh?: string;
  };
  singleLinePrompt: string;
}

export interface AudiationPrimingState {
  enteredAtMs: number;
  chunkId: string | null;
  historicalPassCount: number;
  isUnfamiliar: boolean;
  previewMode: AudiationPreviewMode;
  previewStatus: AudiationPreviewStatus;
  previewInterruptedReason: AudiationInterruptReason | null;
  imageryTimerEnabled: boolean;
  imageryTimerDurationMs: number;
}

export interface AudiationImageryTick {
  active: boolean;
  remainingMs: number;
  remainingSec: number;
  completed: boolean;
}

/** Clamps Micro-Rest duration into the evidence-backed 10–15 s window (default 12 s). */
export function clampMicroRestDurationSec(sec: number | undefined): number {
  if (typeof sec !== "number" || !Number.isFinite(sec)) {
    return DEFAULT_MICRO_REST_DURATION_SEC;
  }
  return Math.min(
    MAX_MICRO_REST_DURATION_SEC,
    Math.max(MIN_MICRO_REST_DURATION_SEC, Math.round(sec)),
  );
}

/** Creates initial zero-data Micro-Rest countdown state. */
export function createMicroRestState(options: {
  startedAtMs: number;
  durationSec?: number;
}): MicroRestState {
  const durationSec = clampMicroRestDurationSec(options.durationSec);
  return {
    startedAtMs: options.startedAtMs,
    durationMs: durationSec * 1000,
    accidentalKeystrokeCount: 0,
    reminderPulseToken: 0,
    reminderMessage: null,
  };
}

/** Evaluates remaining Micro-Rest time and breathing progress at `nowMs`. */
export function evaluateMicroRestTick(state: MicroRestState, nowMs: number): MicroRestTick {
  const elapsedMs = Math.max(0, nowMs - state.startedAtMs);
  const remainingMs = Math.max(0, state.durationMs - elapsedMs);
  const remainingSec = remainingMs === 0 ? 0 : Math.ceil(remainingMs / 1000);
  const progress = state.durationMs > 0 ? Math.min(1, elapsedMs / state.durationMs) : 1;
  return {
    elapsedMs,
    remainingMs,
    remainingSec,
    progress,
    completed: remainingMs === 0,
  };
}

/**
 * Records an accidental ordinary keystroke during Micro-Rest without aborting the countdown
 * or logging wrong-note errors; updates the gentle pulse reminder token and message.
 */
export function recordMicroRestAccidentalKeystroke(
  state: MicroRestState,
  _nowMs: number,
): MicroRestState {
  return {
    ...state,
    accidentalKeystrokeCount: state.accidentalKeystrokeCount + 1,
    reminderPulseToken: state.reminderPulseToken + 1,
    reminderMessage: MICRO_REST_REMINDER_TEXT,
  };
}

function formatMeasureRange(chunk: MotorChunk): string {
  return chunk.endMeasureIndex > chunk.startMeasureIndex
    ? `m.${chunk.startMeasureIndex + 1}–${chunk.endMeasureIndex + 1}`
    : `m.${chunk.startMeasureIndex + 1}`;
}

function findHandPositionForChunk(
  hand: Hand,
  chunk: MotorChunk,
  steps: readonly PracticeStep[],
  handPositions: readonly HandPosition[],
  onsetSlices?: readonly OnsetSlice[],
): HandPosition | null {
  const handSliceIds = new Set<string>();
  for (const step of steps) {
    if (step.primarySliceId) handSliceIds.add(step.primarySliceId);
  }
  if (onsetSlices) {
    for (const slice of onsetSlices) {
      if (
        slice.hand === hand &&
        slice.measureIndex >= chunk.startMeasureIndex &&
        slice.measureIndex <= chunk.endMeasureIndex
      ) {
        handSliceIds.add(slice.sliceId);
      }
    }
  }

  for (const pos of handPositions) {
    if (pos.hand !== hand) continue;
    if (handSliceIds.has(pos.startSliceId) || handSliceIds.has(pos.endSliceId)) {
      return pos;
    }
  }
  return null;
}

function formatHandSpanLabel(
  hand: Hand,
  chunk: MotorChunk,
  steps: readonly PracticeStep[],
  solveResult: SolveResult | null,
  onsetSlices?: readonly OnsetSlice[],
): string | undefined {
  const pos = solveResult
    ? findHandPositionForChunk(hand, chunk, steps, solveResult.handPositions, onsetSlices)
    : null;
  if (pos) {
    const low = midiToPitchLabel(pos.minMidi);
    const high = midiToPitchLabel(pos.maxMidi);
    return low === high ? low : `${low}–${high}`;
  }
  const handMidis: number[] = [];
  for (const step of steps) {
    for (const note of step.expectedNotes) {
      if (note.hand === hand) handMidis.push(note.midi);
    }
  }
  if (handMidis.length === 0) return undefined;
  const minMidi = Math.min(...handMidis);
  const maxMidi = Math.max(...handMidis);
  const low = midiToPitchLabel(minMidi);
  const high = midiToPitchLabel(maxMidi);
  return low === high ? low : `${low}–${high}`;
}

/**
 * Derives a single-line audiation & HandPosition preparation prompt for the next MotorChunk,
 * along with whether unfamiliar (< 2 historical passes) soft audio preview should auto-trigger.
 */
export function deriveAudiationCue(params: {
  nextChunk: MotorChunk | null;
  nextChunkSteps: readonly PracticeStep[];
  solveResult: SolveResult | null;
  practiceMode: PracticeMode;
  onsetSlices?: readonly OnsetSlice[];
  historicalPassCount?: number;
  previewMode?: AudiationPreviewMode;
}): AudiationCueSummary {
  const {
    nextChunk,
    nextChunkSteps,
    solveResult,
    practiceMode,
    onsetSlices,
    historicalPassCount = 0,
    previewMode = "auto-unfamiliar",
  } = params;

  const isUnfamiliar = historicalPassCount < UNFAMILIAR_PASS_THRESHOLD;
  if (!nextChunk) {
    return {
      chunkId: null,
      measureRangeLabel: "",
      isUnfamiliar,
      historicalPassCount,
      shouldAutoPreview: false,
      firstTargetMidis: [],
      handPositionLabels: {},
      singleLinePrompt: "已完成本轮队列，可按 C8 重开或按 B0 查看指法与 88 键手型",
    };
  }

  const measureRangeLabel = formatMeasureRange(nextChunk);
  const firstStep = nextChunkSteps[0] ?? null;
  const firstTargetMidis = firstStep ? [...firstStep.expectedMidis] : [];

  const includeRh = practiceMode !== "lh-only";
  const includeLh = practiceMode !== "rh-only";
  const rhSpan = includeRh
    ? formatHandSpanLabel("RH", nextChunk, nextChunkSteps, solveResult, onsetSlices)
    : undefined;
  const lhSpan = includeLh
    ? formatHandSpanLabel("LH", nextChunk, nextChunkSteps, solveResult, onsetSlices)
    : undefined;

  const posParts: string[] = [];
  if (rhSpan) posParts.push(`右手 ${rhSpan}`);
  if (lhSpan) posParts.push(`左手 ${lhSpan}`);

  const cueInChunk = solveResult?.transitionCues.find(
    (c) =>
      c.measureIndex >= nextChunk.startMeasureIndex &&
      c.measureIndex <= nextChunk.endMeasureIndex &&
      ((c.hand === "RH" && includeRh) || (c.hand === "LH" && includeLh)),
  );
  const firstPitchText =
    firstTargetMidis.length > 0
      ? firstTargetMidis.map((m) => midiToPitchLabel(m)).join("+")
      : "";

  const parts: string[] = [`默听下一块（${measureRangeLabel}）首拍`];
  if (posParts.length > 0) {
    parts.push(`轻放手位：${posParts.join(" / ")}`);
  } else if (firstPitchText) {
    parts.push(`起音 ${firstPitchText}`);
  }
  if (cueInChunk) {
    parts.push(`留意${cueInChunk.label}`);
  }
  const singleLinePrompt = parts.join(" · ").replace(/[\r\n]+/g, " ");

  return {
    chunkId: nextChunk.chunkId,
    measureRangeLabel,
    isUnfamiliar,
    historicalPassCount,
    shouldAutoPreview:
      previewMode === "auto-unfamiliar" && isUnfamiliar && nextChunkSteps.length > 0,
    firstTargetMidis,
    handPositionLabels: {
      ...(rhSpan ? { rh: rhSpan } : {}),
      ...(lhSpan ? { lh: lhSpan } : {}),
    },
    singleLinePrompt,
  };
}

/** Creates non-blocking Audiation Priming ready-window state. */
export function createAudiationPrimingState(options: {
  enteredAtMs: number;
  chunkId: string | null;
  historicalPassCount: number;
  previewMode: AudiationPreviewMode;
  imageryTimerEnabled: boolean;
}): AudiationPrimingState {
  return {
    enteredAtMs: options.enteredAtMs,
    chunkId: options.chunkId,
    historicalPassCount: options.historicalPassCount,
    isUnfamiliar: options.historicalPassCount < UNFAMILIAR_PASS_THRESHOLD,
    previewMode: options.previewMode,
    previewStatus: "idle",
    previewInterruptedReason: null,
    imageryTimerEnabled: options.imageryTimerEnabled,
    imageryTimerDurationMs: ADVANCED_IMAGERY_TIMER_MS,
  };
}

/** Returns true when soft audio preview should auto-start on entering Audiation Priming. */
export function shouldAutoTriggerAudiationPreview(state: AudiationPrimingState): boolean {
  return (
    state.previewMode === "auto-unfamiliar" &&
    state.isUnfamiliar &&
    state.chunkId !== null &&
    state.previewStatus === "idle"
  );
}

export function markAudiationPreviewPlaying(state: AudiationPrimingState): AudiationPrimingState {
  return {
    ...state,
    previewStatus: "playing",
    previewInterruptedReason: null,
  };
}

export function interruptAudiationPreview(
  state: AudiationPrimingState,
  reason: AudiationInterruptReason,
): AudiationPrimingState {
  if (state.previewStatus !== "playing") {
    return state;
  }
  return {
    ...state,
    previewStatus: "interrupted",
    previewInterruptedReason: reason,
  };
}

export function completeAudiationPreview(state: AudiationPrimingState): AudiationPrimingState {
  if (state.previewStatus !== "playing") {
    return state;
  }
  return {
    ...state,
    previewStatus: "completed",
  };
}

/** Evaluates optional opt-in 10 s advanced imagery timer (strictly non-blocking). */
export function evaluateAudiationImageryTick(
  state: AudiationPrimingState,
  nowMs: number,
): AudiationImageryTick {
  if (!state.imageryTimerEnabled) {
    return {
      active: false,
      remainingMs: 0,
      remainingSec: 0,
      completed: false,
    };
  }
  const elapsedMs = Math.max(0, nowMs - state.enteredAtMs);
  const remainingMs = Math.max(0, state.imageryTimerDurationMs - elapsedMs);
  const remainingSec = remainingMs === 0 ? 0 : Math.ceil(remainingMs / 1000);
  return {
    active: true,
    remainingMs,
    remainingSec,
    completed: remainingMs === 0,
  };
}
