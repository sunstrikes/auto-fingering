import {
  normalizeAbLoopBounds,
  type AbLoopBounds,
  type NoteEvent,
  type OnsetSlice,
  type PracticeMode,
  type PracticeStep,
  type ScoreDocument,
  type WaitingModeState,
} from "../domain/types";

export interface BuildPracticeStepsOptions {
  skipGraceNotes?: boolean;
}

export interface WaitingNoteOnResult {
  nextState: WaitingModeState;
  matched: boolean;
  completedStep: PracticeStep | null;
  advancedToStep: PracticeStep | null;
  completedScore: boolean;
  loopWrapped: boolean;
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

  const steps: PracticeStep[] = [];
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

    steps.push({
      stepIndex: steps.length,
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

  return steps;
}

/**
 * Creates a fresh `WaitingModeState` positioned at `startStepIndex`,
 * clearing `hitMidis` and `wrongMidis` so held keys never bleed across steps.
 */
export function createWaitingModeState(startStepIndex = 0): WaitingModeState {
  return {
    currentStepIndex: Math.max(0, startStepIndex),
    hitMidis: new Set<number>(),
    wrongMidis: new Set<number>(),
  };
}

/**
 * Processes a `NoteOn` event against the active `PracticeStep` using cumulative
 * hit matching. Unexpected pitches are flagged in `wrongMidis` without clearing
 * already-hit pitches; completing all expected pitches resets `hitMidis` on advance.
 */
export function handleWaitingNoteOn(
  state: WaitingModeState,
  steps: PracticeStep[],
  midi: number,
  abLoop?: AbLoopBounds | null
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
    };
  }

  if (!step.expectedMidis.includes(midi)) {
    const nextWrong = new Set(state.wrongMidis);
    nextWrong.add(midi);
    return {
      nextState: {
        ...state,
        wrongMidis: nextWrong,
      },
      matched: false,
      completedStep: null,
      advancedToStep: null,
      completedScore: false,
      loopWrapped: false,
    };
  }

  const nextHit = new Set(state.hitMidis);
  nextHit.add(midi);

  const isStepComplete = step.expectedMidis.every((expected) => nextHit.has(expected));
  if (!isStepComplete) {
    return {
      nextState: {
        ...state,
        hitMidis: nextHit,
      },
      matched: true,
      completedStep: null,
      advancedToStep: null,
      completedScore: false,
      loopWrapped: false,
    };
  }

  const loopRange = findAbLoopStepRange(steps, abLoop);
  if (loopRange && state.currentStepIndex === loopRange.endStepIndex) {
    return {
      nextState: createWaitingModeState(loopRange.startStepIndex),
      matched: true,
      completedStep: step,
      advancedToStep: steps[loopRange.startStepIndex],
      completedScore: false,
      loopWrapped: true,
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
    };
  }

  return {
    nextState: createWaitingModeState(steps.length),
    matched: true,
    completedStep: step,
    advancedToStep: null,
    completedScore: true,
    loopWrapped: false,
  };
}

/**
 * Clears a released pitch from `wrongMidis` while preserving cumulative `hitMidis`
 * within the current step.
 */
export function handleWaitingNoteOff(
  state: WaitingModeState,
  midi: number
): WaitingModeState {
  if (!state.wrongMidis.has(midi)) return state;
  const nextWrong = new Set(state.wrongMidis);
  nextWrong.delete(midi);
  return {
    ...state,
    wrongMidis: nextWrong,
  };
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
