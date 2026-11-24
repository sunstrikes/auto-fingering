import { computeTieChainEndByRoot } from "../domain/tieUtils";
import {
  normalizeAbLoopBounds,
  type AbLoopBounds,
  type NoteEvent,
  type OnsetSlice,
  type PracticeMode,
  type PracticeStep,
  type ScoreDocument,
  type WaitingModeState,
  type WaitingResetReason,
} from "../domain/types";

export interface BuildPracticeStepsOptions {
  skipGraceNotes?: boolean;
}

export interface WaitingStepAdvanceResult {
  nextState: WaitingModeState;
  matched: boolean;
  completedStep: PracticeStep | null;
  advancedToStep: PracticeStep | null;
  completedScore: boolean;
  loopWrapped: boolean;
  faultReason: WaitingResetReason;
}

export type WaitingNoteOnResult = WaitingStepAdvanceResult;

export interface WaitingNoteOnOptions {
  /** Clear all hits and require a full release after a wrong pitch (default: false). */
  absoluteStrictness?: boolean;
  /**
   * Whether the active step requires holding keys for `requiredHoldSec` before advancing.
   * Defaults to `false` regardless of whether a clock or hold ratio is supplied.
   */
  enforceHoldDuration?: boolean;
  /**
   * Current real-time clock in seconds (e.g., `AudioContext.currentTime` or `performance.now() / 1000`).
   */
  nowSec?: number;
  /**
   * Current playback speed multiplier (`1.0` = native score tempo).
   */
  speedMultiplier?: number;
  /**
   * Fraction of the step's scaled duration that must be held before advancing (default `0.8`).
   */
  requiredHoldRatio?: number;
}

export interface WaitingNoteOffOptions {
  absoluteStrictness?: boolean;
  enforceHoldDuration?: boolean;
  /**
   * Whether the sustain pedal (CC64) is currently depressed; when true, releasing a key
   * during `isHolding` does not invalidate the hold duration.
   */
  sustainPedalPressed?: boolean;
}

export interface WaitingNoteOffResult {
  nextState: WaitingModeState;
  faultReason: WaitingResetReason;
}

export const DEFAULT_HOLD_DURATION_RATIO = 0.8;
export const MIN_REQUIRED_HOLD_SEC = 0.06;
export const MAX_REQUIRED_HOLD_SEC = 4.0;

/**
 * Computes the required real-time hold duration (in seconds) for a `PracticeStep`
 * at the given `speedMultiplier` and `holdRatio`.
 */
export function computeStepRequiredHoldSec(
  step: PracticeStep,
  speedMultiplier = 1.0,
  holdRatio = DEFAULT_HOLD_DURATION_RATIO
): number {
  if (step.isGrace || step.expectedDurationSec <= 0 || holdRatio <= 0) {
    return 0;
  }
  const safeSpeed = Number.isFinite(speedMultiplier) && speedMultiplier > 0 ? speedMultiplier : 1.0;
  const scaled = (step.expectedDurationSec / safeSpeed) * holdRatio;
  if (scaled < MIN_REQUIRED_HOLD_SEC) return 0;
  return Math.min(MAX_REQUIRED_HOLD_SEC, scaled);
}

/**
 * Finds the `[startStepIndex, endStepIndex]` range of `PracticeStep`s falling
 * inside an enabled `AbLoopBounds` `[startMeasureIndex, endMeasureIndex]`.
 */
export function findAbLoopStepRange(
  steps: PracticeStep[],
  abLoop?: AbLoopBounds | null
): { startStepIndex: number; endStepIndex: number } | null {
  if (!abLoop?.enabled || steps.length === 0) return null;
  const norm = normalizeAbLoopBounds(abLoop);
  let startStepIndex = -1;
  let endStepIndex = -1;
  for (let i = 0; i < steps.length; i++) {
    const m = steps[i].measureIndex;
    if (m >= norm.startMeasureIndex && m <= norm.endMeasureIndex) {
      if (startStepIndex === -1) startStepIndex = i;
      endStepIndex = i;
    }
  }
  if (startStepIndex === -1 || endStepIndex === -1) return null;
  return { startStepIndex, endStepIndex };
}

function isTargetHand(hand: NoteEvent["hand"], mode: PracticeMode): boolean {
  if (mode === "both") return true;
  if (mode === "rh-only") return hand === "RH";
  return hand === "LH";
}

function resolvePrimarySliceId(
  slices: OnsetSlice[],
  measureIndex: number,
  onsetTick: number,
  isGrace: boolean,
  preferredHand?: NoteEvent["hand"]
): string | null {
  const matching = slices.filter(
    (s) =>
      s.measureIndex === measureIndex &&
      s.onsetTick === onsetTick &&
      s.isGrace === isGrace
  );
  if (matching.length === 0) return null;
  if (preferredHand) {
    const handMatch = matching.find((s) => s.hand === preferredHand);
    if (handMatch) return handMatch.sliceId;
  }
  return matching[0].sliceId;
}

/**
 * Projects a ScoreDocument into an ordered sequence of cross-hand `PracticeStep`s
 * for the given `PracticeMode`, excluding `Tie Continuation`s (`isTieStop`) and
 * optionally skipping `Grace Note`s.
 */
export function buildPracticeSteps(
  scoreDoc: ScoreDocument,
  practiceMode: PracticeMode,
  options: BuildPracticeStepsOptions = {}
): PracticeStep[] {
  const skipGraceNotes = options.skipGraceNotes ?? false;
  const tieChainEndSecByRootUid = computeTieChainEndByRoot(scoreDoc.noteEvents, "sec");

  interface Bucket {
    onsetTick: number;
    onsetSec: number;
    measureIndex: number;
    isGrace: boolean;
    graceOrder: number | undefined;
    notes: NoteEvent[];
  }

  const buckets = new Map<string, Bucket>();

  for (const ev of scoreDoc.noteEvents) {
    if (ev.isTieStop) continue;
    if (skipGraceNotes && ev.isGrace) continue;

    const graceOrder = ev.isGrace ? (ev.graceOrder ?? 0) : undefined;
    const key = `${ev.onsetTick}|${ev.isGrace ? 1 : 0}|${graceOrder ?? ""}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        onsetTick: ev.onsetTick,
        onsetSec: ev.onsetSec,
        measureIndex: ev.measureIndex,
        isGrace: ev.isGrace,
        graceOrder,
        notes: [],
      };
      buckets.set(key, bucket);
    }
    bucket.notes.push(ev);
  }

  const sortedBuckets = Array.from(buckets.values()).sort((a, b) => {
    if (a.onsetTick !== b.onsetTick) return a.onsetTick - b.onsetTick;
    if (a.isGrace !== b.isGrace) return a.isGrace ? -1 : 1;
    return (a.graceOrder ?? 0) - (b.graceOrder ?? 0);
  });

  const preferredHand =
    practiceMode === "rh-only" ? "RH" : practiceMode === "lh-only" ? "LH" : undefined;

  const rawSteps: Array<Omit<PracticeStep, "expectedDurationSec">> = [];
  for (const bucket of sortedBuckets) {
    const expectedNotes: NoteEvent[] = [];
    const accompanimentNotes: NoteEvent[] = [];

    for (const note of bucket.notes) {
      if (isTargetHand(note.hand, practiceMode)) {
        expectedNotes.push(note);
      } else {
        accompanimentNotes.push(note);
      }
    }

    if (expectedNotes.length === 0) continue;

    const expectedMidis = Array.from(new Set(expectedNotes.map((n) => n.midi))).sort(
      (a, b) => a - b
    );

    rawSteps.push({
      stepIndex: rawSteps.length,
      onsetTick: bucket.onsetTick,
      onsetSec: bucket.onsetSec,
      measureIndex: bucket.measureIndex,
      isGrace: bucket.isGrace,
      graceOrder: bucket.graceOrder,
      expectedMidis,
      expectedNotes,
      accompanimentNotes,
      primarySliceId: resolvePrimarySliceId(
        scoreDoc.onsetSlices,
        bucket.measureIndex,
        bucket.onsetTick,
        bucket.isGrace,
        preferredHand
      ),
    });
  }

  return rawSteps.map((raw, idx) => {
    if (raw.isGrace) {
      return { ...raw, expectedDurationSec: 0 };
    }
    let minNoteDurationSec = Number.POSITIVE_INFINITY;
    for (const note of raw.expectedNotes) {
      const tieEndSec = tieChainEndSecByRootUid.get(note.noteUid);
      const effectiveDur =
        tieEndSec !== undefined
          ? Math.max(note.durationSec, tieEndSec - note.onsetSec)
          : note.durationSec;
      if (effectiveDur > 0 && effectiveDur < minNoteDurationSec) {
        minNoteDurationSec = effectiveDur;
      }
    }
    if (!Number.isFinite(minNoteDurationSec)) {
      minNoteDurationSec = 0.25;
    }

    // Cap required duration by the score time until the next non-grace step so a long held note
    // in one hand never blocks the player from advancing to the next beat in the other hand.
    let nextStepOnsetSec: number | null = null;
    for (let j = idx + 1; j < rawSteps.length; j++) {
      if (rawSteps[j].onsetSec > raw.onsetSec + 1e-5) {
        nextStepOnsetSec = rawSteps[j].onsetSec;
        break;
      }
    }
    const interOnsetGapSec =
      nextStepOnsetSec !== null ? Math.max(0, nextStepOnsetSec - raw.onsetSec) : minNoteDurationSec;
    const expectedDurationSec = Math.max(0, Math.min(minNoteDurationSec, interOnsetGapSec));

    return {
      ...raw,
      expectedDurationSec,
    };
  });
}

/**
 * Creates a fresh `WaitingModeState` positioned at `startStepIndex`,
 * clearing `hitMidis`, `wrongMidis`, and any hold/taint flags so held keys never bleed across steps.
 */
export function createWaitingModeState(startStepIndex = 0): WaitingModeState {
  return {
    currentStepIndex: Math.max(0, startStepIndex),
    hitMidis: new Set<number>(),
    wrongMidis: new Set<number>(),
    activeStepMidis: new Set<number>(),
    tainted: false,
    lastResetReason: null,
    isHolding: false,
    holdProgress: 0,
    requiredHoldSec: 0,
    holdStartedAtSec: null,
  };
}

function advanceCompletedStep(
  state: WaitingModeState,
  steps: PracticeStep[],
  step: PracticeStep,
  abLoop?: AbLoopBounds | null
): WaitingStepAdvanceResult {
  const loopRange = findAbLoopStepRange(steps, abLoop);
  if (loopRange && state.currentStepIndex === loopRange.endStepIndex) {
    return {
      nextState: createWaitingModeState(loopRange.startStepIndex),
      matched: true,
      completedStep: step,
      advancedToStep: steps[loopRange.startStepIndex],
      completedScore: false,
      loopWrapped: true,
      faultReason: null,
    };
  }

  const nextIndex = state.currentStepIndex + 1;
  if (nextIndex < steps.length) {
    return {
      nextState: createWaitingModeState(nextIndex),
      matched: true,
      completedStep: step,
      advancedToStep: steps[nextIndex],
      completedScore: false,
      loopWrapped: false,
      faultReason: null,
    };
  }

  return {
    nextState: createWaitingModeState(steps.length),
    matched: true,
    completedStep: step,
    advancedToStep: null,
    completedScore: true,
    loopWrapped: false,
    faultReason: null,
  };
}

/**
 * Accumulates target pitches for the active Practice Step. Wrong pitches are reported
 * without resetting hits unless Absolute Strictness is enabled. Strict Hold Duration
 * separately requires the complete chord to be held before advancing.
 */
export function handleWaitingNoteOn(
  state: WaitingModeState,
  steps: PracticeStep[],
  midi: number,
  abLoop?: AbLoopBounds | null,
  options: WaitingNoteOnOptions = {}
): WaitingNoteOnResult {
  const step = steps[state.currentStepIndex];
  if (!step) {
    return {
      nextState: state,
      matched: false,
      completedStep: null,
      advancedToStep: null,
      completedScore: false,
      loopWrapped: false,
      faultReason: null,
    };
  }

  const nextActive = new Set(state.activeStepMidis);
  nextActive.add(midi);

  const isExpected = step.expectedMidis.includes(midi);

  if (!isExpected) {
    const nextWrong = new Set(state.wrongMidis);
    nextWrong.add(midi);
    return {
      nextState: {
        ...state,
        wrongMidis: nextWrong,
        activeStepMidis: nextActive,
        ...(options.absoluteStrictness && {
          hitMidis: new Set<number>(),
          tainted: true,
          lastResetReason: "wrong-note",
          isHolding: false,
          holdProgress: 0,
          requiredHoldSec: 0,
          holdStartedAtSec: null,
        }),
      },
      matched: false,
      completedStep: null,
      advancedToStep: null,
      completedScore: false,
      loopWrapped: false,
      faultReason: "wrong-note",
    };
  }

  // An opt-in reset or failed hold blocks new hits until the hand is released.
  if (state.tainted) {
    return {
      nextState: {
        ...state,
        hitMidis: new Set<number>(),
        activeStepMidis: nextActive,
        tainted: true,
        isHolding: false,
        holdProgress: 0,
      },
      matched: false,
      completedStep: null,
      advancedToStep: null,
      completedScore: false,
      loopWrapped: false,
      faultReason: null,
    };
  }

  const nextHit = new Set(state.hitMidis);
  nextHit.add(midi);

  const requiredHoldSec = options.enforceHoldDuration
    ? computeStepRequiredHoldSec(
        step,
        options.speedMultiplier ?? 1.0,
        options.requiredHoldRatio ?? DEFAULT_HOLD_DURATION_RATIO
      )
    : 0;

  const isStepComplete = step.expectedMidis.every((expected) =>
    nextHit.has(expected) && (requiredHoldSec === 0 || state.isHolding || nextActive.has(expected))
  );
  if (!isStepComplete) {
    return {
      nextState: {
        ...state,
        hitMidis: nextHit,
        activeStepMidis: nextActive,
        lastResetReason: null,
      },
      matched: true,
      completedStep: null,
      advancedToStep: null,
      completedScore: false,
      loopWrapped: false,
      faultReason: null,
    };
  }

  if (requiredHoldSec > 0) {
    const nowSec = options.nowSec ?? 0;
    const holdStartedAtSec = state.isHolding && state.holdStartedAtSec !== null ? state.holdStartedAtSec : nowSec;
    return {
      nextState: {
        ...state,
        hitMidis: nextHit,
        activeStepMidis: nextActive,
        tainted: false,
        lastResetReason: null,
        isHolding: true,
        holdProgress: 0,
        requiredHoldSec,
        holdStartedAtSec,
      },
      matched: true,
      completedStep: null,
      advancedToStep: null,
      completedScore: false,
      loopWrapped: false,
      faultReason: null,
    };
  }

  return advanceCompletedStep(state, steps, step, abLoop);
}

/**
 * Advances an in-progress `isHolding` step according to the elapsed real time (`nowSec`).
 * Once `nowSec - holdStartedAtSec >= requiredHoldSec`, the step completes and advances.
 */
export function advanceWaitingHoldProgress(
  state: WaitingModeState,
  steps: PracticeStep[],
  nowSec: number,
  abLoop?: AbLoopBounds | null
): WaitingStepAdvanceResult {
  const step = steps[state.currentStepIndex];
  if (!step || !state.isHolding || state.tainted || state.holdStartedAtSec === null) {
    return {
      nextState: state,
      matched: false,
      completedStep: null,
      advancedToStep: null,
      completedScore: false,
      loopWrapped: false,
      faultReason: null,
    };
  }

  const elapsed = Math.max(0, nowSec - state.holdStartedAtSec);
  if (state.requiredHoldSec <= 0 || elapsed + 1e-4 >= state.requiredHoldSec) {
    return advanceCompletedStep(state, steps, step, abLoop);
  }

  const progress = Math.max(0, Math.min(1, elapsed / state.requiredHoldSec));
  if (Math.abs(progress - state.holdProgress) < 1e-4) {
    return {
      nextState: state,
      matched: true,
      completedStep: null,
      advancedToStep: null,
      completedScore: false,
      loopWrapped: false,
      faultReason: null,
    };
  }

  return {
    nextState: {
      ...state,
      holdProgress: progress,
    },
    matched: true,
    completedStep: null,
    advancedToStep: null,
    completedScore: false,
    loopWrapped: false,
    faultReason: null,
  };
}

/**
 * Processes a `NoteOff` event with detailed fault reporting:
 * - Releases the pitch from `wrongMidis` and `activeStepMidis`.
 * - Under Absolute Strictness, if `tainted` is true, `tainted` clears ONLY when all keys in
 *   `activeStepMidis` have been released (`nextActive.size === 0`).
 * - In either strict mode, a chord pitch released before the chord is complete is no longer
 *   a hit. In friendly mode it remains matched for the rest of the step.
 * - If the step is currently in `isHolding` (waiting for duration completion) and an expected key
 *   is released early (while sustain pedal is NOT pressed), the hold fails with `"early-release"`
 *   and taints the step (requiring full release and re-strike).
 */
export function handleWaitingNoteOffWithResult(
  state: WaitingModeState,
  midi: number,
  options: WaitingNoteOffOptions = {}
): WaitingNoteOffResult {
  const nextWrong = new Set(state.wrongMidis);
  nextWrong.delete(midi);

  const nextActive = new Set(state.activeStepMidis);
  nextActive.delete(midi);

  // If currently holding for duration verification and a target key is released early without sustain pedal
  if (state.isHolding && state.hitMidis.has(midi) && !options.sustainPedalPressed) {
    const stillHasHeldKeys = nextActive.size > 0;
    return {
      nextState: {
        ...state,
        hitMidis: new Set<number>(),
        wrongMidis: nextWrong,
        activeStepMidis: nextActive,
        tainted: stillHasHeldKeys,
        lastResetReason: "early-release",
        isHolding: false,
        holdProgress: 0,
        requiredHoldSec: 0,
        holdStartedAtSec: null,
      },
      faultReason: "early-release",
    };
  }

  // If the step was tainted by a wrong note or prior early release, keep it tainted until ALL keys are released
  if (state.tainted) {
    const stillTainted = nextActive.size > 0 || nextWrong.size > 0;
    return {
      nextState: {
        ...state,
        hitMidis: new Set<number>(),
        wrongMidis: nextWrong,
        activeStepMidis: nextActive,
        tainted: stillTainted,
        lastResetReason: stillTainted ? state.lastResetReason : null,
        isHolding: false,
        holdProgress: 0,
        requiredHoldSec: 0,
        holdStartedAtSec: null,
      },
      faultReason: null,
    };
  }

  const nextHit = new Set(state.hitMidis);
  if (!state.isHolding && (options.absoluteStrictness || options.enforceHoldDuration)) {
    nextHit.delete(midi);
  }

  return {
    nextState: {
      ...state,
      hitMidis: nextHit,
      wrongMidis: nextWrong,
      activeStepMidis: nextActive,
    },
    faultReason: null,
  };
}

/**
 * Convenience wrapper around `handleWaitingNoteOffWithResult` returning `nextState`.
 */
export function handleWaitingNoteOff(
  state: WaitingModeState,
  midi: number,
  options: WaitingNoteOffOptions = {}
): WaitingModeState {
  return handleWaitingNoteOffWithResult(state, midi, options).nextState;
}

/**
 * Returns true if a `NoteOn` pitch matches any expected pitch on the current
 * paused cursor step, allowing Waiting Mode rehearsal to start immediately.
 */
export function doesNoteOnMatchPausedStep(
  step: PracticeStep | undefined,
  midi: number
): boolean {
  return Boolean(step && step.expectedMidis.includes(midi));
}
