import type { PracticeStep } from "../domain/types";

export const STAGE0_TIME_CAP_MS = 120_000;
export const STAGE0_ACCURACY_THRESHOLD = 0.9;
export const STAGE0_HESITATION_RATIO = 1.6;
export const STAGE0_MIN_EXTRA_HESITATION_MS = 450;
export const STAGE0_FALLBACK_MAX_GAP_MS = 2500;

export type Stage0GraduationReason = "smooth-pass" | "time-cap" | null;

export interface Stage0State {
  chunkId: string;
  steps: PracticeStep[];
  speedMultiplier: number;
  startedAtMs: number;
  pausedAtMs: number | null;
  totalPausedMs: number;
  activeElapsedMs: number;
  currentStepIndex: number;
  totalRequiredNotes: number;
  wrongNoteCount: number;
  longHesitationCount: number;
  lastStepCompletedAtMs: number | null;
  passAttempts: number;
  lastPassAccuracy: number;
  graduated: boolean;
  graduationReason: Stage0GraduationReason;
}

export interface Stage0TelemetrySummary {
  chunkId: string;
  telemetryIsolated: true;
  acoustic: undefined;
  graduated: boolean;
  graduationReason: Stage0GraduationReason;
  passAttempts: number;
  lastPassAccuracy: number;
  activeElapsedMs: number;
}

export interface CreateStage0Options {
  chunkId: string;
  steps: PracticeStep[];
  startedAtMs: number;
  speedMultiplier: number;
}

function computeActiveElapsedMs(state: Stage0State, nowMs: number): number {
  const effectiveNow = state.pausedAtMs !== null ? state.pausedAtMs : nowMs;
  return Math.max(0, effectiveNow - state.startedAtMs - state.totalPausedMs);
}

function computePassAccuracy(totalRequiredNotes: number, wrongNoteCount: number): number {
  const denom = Math.max(1, totalRequiredNotes);
  return Math.max(0, Math.min(1, (denom - wrongNoteCount) / denom));
}

function isLongHesitationGap(
  prevStep: PracticeStep,
  nextStep: PracticeStep,
  actualGapMs: number,
  speedMultiplier: number,
): boolean {
  const safeSpeed = Number.isFinite(speedMultiplier) && speedMultiplier > 0 ? speedMultiplier : 1.0;
  const expectedGapMs =
    Math.max(0, (nextStep.onsetSec - prevStep.onsetSec) / safeSpeed) * 1000;
  if (expectedGapMs <= 0) {
    return actualGapMs >= STAGE0_FALLBACK_MAX_GAP_MS;
  }
  return (
    actualGapMs > expectedGapMs * STAGE0_HESITATION_RATIO &&
    actualGapMs - expectedGapMs >= STAGE0_MIN_EXTRA_HESITATION_MS
  );
}

/** Creates initial Stage 0 Waiting Mode scaffolding state for a single MotorChunk. */
export function createStage0State({
  chunkId,
  steps,
  startedAtMs,
  speedMultiplier,
}: CreateStage0Options): Stage0State {
  const totalRequiredNotes = steps.reduce((acc, s) => acc + s.expectedMidis.length, 0);
  return {
    chunkId,
    steps,
    speedMultiplier,
    startedAtMs,
    pausedAtMs: null,
    totalPausedMs: 0,
    activeElapsedMs: 0,
    currentStepIndex: 0,
    totalRequiredNotes,
    wrongNoteCount: 0,
    longHesitationCount: 0,
    lastStepCompletedAtMs: null,
    passAttempts: 0,
    lastPassAccuracy: 1,
    graduated: steps.length === 0,
    graduationReason: steps.length === 0 ? "smooth-pass" : null,
  };
}

/** Evaluates elapsed active time against the 2-minute Stage 0 cap. */
export function evaluateStage0Tick(state: Stage0State, nowMs: number): Stage0State {
  if (state.graduated || state.pausedAtMs !== null) {
    return state;
  }
  const activeElapsedMs = computeActiveElapsedMs(state, nowMs);
  if (activeElapsedMs >= STAGE0_TIME_CAP_MS) {
    return {
      ...state,
      activeElapsedMs,
      graduated: true,
      graduationReason: "time-cap",
    };
  }
  if (activeElapsedMs === state.activeElapsedMs) {
    return state;
  }
  return {
    ...state,
    activeElapsedMs,
  };
}

/** Pauses Stage 0 timer so paused or suspended time does not consume the 2-minute cap. */
export function pauseStage0(state: Stage0State, nowMs: number): Stage0State {
  if (state.graduated || state.pausedAtMs !== null) {
    return state;
  }
  const ticked = evaluateStage0Tick(state, nowMs);
  if (ticked.graduated) return ticked;
  return {
    ...ticked,
    pausedAtMs: nowMs,
  };
}

/** Resumes Stage 0 timer after a pause or suspend/return cycle. */
export function resumeStage0(state: Stage0State, nowMs: number): Stage0State {
  if (state.pausedAtMs === null) {
    return state;
  }
  const pausedDelta = Math.max(0, nowMs - state.pausedAtMs);
  return {
    ...state,
    pausedAtMs: null,
    totalPausedMs: state.totalPausedMs + pausedDelta,
    lastStepCompletedAtMs: null,
  };
}

/** Records a Waiting Mode pitch fault during the active Stage 0 pass. */
export function recordStage0WrongNote(
  state: Stage0State,
  _midi: number,
  nowMs: number,
): Stage0State {
  const ticked = evaluateStage0Tick(state, nowMs);
  if (ticked.graduated) return ticked;
  return {
    ...ticked,
    wrongNoteCount: ticked.wrongNoteCount + 1,
  };
}

/**
 * Advances Stage 0 progress on a completed Waiting Mode step, checking for long hesitations
 * and graduating immediately on 1 smooth pass (>= 90% accuracy, 0 long hesitations) or 2-min cap.
 */
export function recordStage0StepCompleted(
  state: Stage0State,
  completedRelativeStepIndex: number,
  nowMs: number,
): Stage0State {
  const ticked = evaluateStage0Tick(state, nowMs);
  if (ticked.graduated || ticked.steps.length === 0) {
    return ticked;
  }

  let nextHesitations = ticked.longHesitationCount;
  if (ticked.lastStepCompletedAtMs !== null && completedRelativeStepIndex > 0) {
    const prevStep = ticked.steps[completedRelativeStepIndex - 1];
    const curStep = ticked.steps[completedRelativeStepIndex];
    if (prevStep && curStep) {
      const gapMs = Math.max(0, nowMs - ticked.lastStepCompletedAtMs);
      if (isLongHesitationGap(prevStep, curStep, gapMs, ticked.speedMultiplier)) {
        nextHesitations += 1;
      }
    }
  }

  const isPassComplete = completedRelativeStepIndex >= ticked.steps.length - 1;
  if (!isPassComplete) {
    return {
      ...ticked,
      currentStepIndex: completedRelativeStepIndex + 1,
      longHesitationCount: nextHesitations,
      lastStepCompletedAtMs: nowMs,
    };
  }

  const accuracy = computePassAccuracy(ticked.totalRequiredNotes, ticked.wrongNoteCount);
  const nextPassAttempts = ticked.passAttempts + 1;

  if (accuracy >= STAGE0_ACCURACY_THRESHOLD && nextHesitations === 0) {
    return {
      ...ticked,
      longHesitationCount: 0,
      lastStepCompletedAtMs: nowMs,
      passAttempts: nextPassAttempts,
      lastPassAccuracy: accuracy,
      graduated: true,
      graduationReason: "smooth-pass",
    };
  }

  // Pass did not meet smooth-pass criteria: reset pass counters for another attempt
  return {
    ...ticked,
    currentStepIndex: 0,
    wrongNoteCount: 0,
    longHesitationCount: 0,
    lastStepCompletedAtMs: null,
    passAttempts: nextPassAttempts,
    lastPassAccuracy: accuracy,
  };
}

/**
 * Builds a Stage 0 telemetry summary that strictly isolates Waiting Mode pauses from
 * continuous AcousticProfile data (`acoustic: undefined`).
 */
export function buildStage0TelemetrySummary(state: Stage0State): Stage0TelemetrySummary {
  return {
    chunkId: state.chunkId,
    telemetryIsolated: true,
    acoustic: undefined,
    graduated: state.graduated,
    graduationReason: state.graduationReason,
    passAttempts: state.passAttempts,
    lastPassAccuracy: state.lastPassAccuracy,
    activeElapsedMs: state.activeElapsedMs,
  };
}
