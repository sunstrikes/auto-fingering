import type { ChunkJunction, MotorChunk } from "../chunking/types";
import type {
  Hand,
  HandPosition,
  PracticeMode,
  PracticeStep,
  ScoreCoord,
  ScoreDocument,
  SolveResult,
} from "../domain/types";
import { midiToPitchLabel } from "../solver/keyboard";
import type { BoundedAttributionResult } from "./boundedAttribution";
import { compareScoreCoord, roundSpeed } from "./motorFsrs";

export const BRIDGE_PRE_STEPS_DEFAULT = 2;
export const BRIDGE_POST_STEPS_DEFAULT = 2;
export const BRIDGE_MIN_STEPS_EACH_SIDE = 2;
export const BRIDGE_MAX_STEPS_EACH_SIDE = 3;
export const BRIDGE_SOFT_CAP_MS = 45_000;
export const BRIDGE_MAX_ATTEMPTS = 7;
export const BRIDGE_REQUIRED_SMOOTH_PASSES = 2;
export const BRIDGE_STATIC_PRIOR_RISK_THRESHOLD = 0.65;
export const BRIDGE_HESITATION_RATIO_THRESHOLD = 1.6;
export const BRIDGE_HESITATION_MIN_DELAY_MS = 450;
export const BRIDGE_EMPIRICAL_SPEED_FACTOR = 0.88;
export const BRIDGE_MIN_SPEED = 0.5;

export type BridgeTriggerKind = "static-prewarm" | "empirical-fault" | "switch-mismatch";

export interface BridgeWindowSpan {
  junction: ChunkJunction;
  leftChunk: MotorChunk;
  rightChunk: MotorChunk;
  startStepIndex: number;
  endStepIndex: number;
  junctionStepIndex: number;
  steps: PracticeStep[];
  startScoreSec: number;
  endScoreSec: number;
  countInBeats: number;
}

export interface BridgeHandSpanEndpoint {
  thumbMidi: number;
  pinkyMidi: number;
  label: string;
}

export interface BridgeHandPositionPreview {
  junctionId: string;
  prepCueLabel: string;
  beforeSliceId: string | null;
  afterSliceId: string | null;
  beforeRange: {
    rh?: BridgeHandSpanEndpoint;
    lh?: BridgeHandSpanEndpoint;
  };
  afterRange: {
    rh?: BridgeHandSpanEndpoint;
    lh?: BridgeHandSpanEndpoint;
  };
  shiftSummary: string;
}

export type BridgeWindowPhase = "bridging" | "linked-verify" | "completed" | "skipped";

export type BridgeExitReason =
  | "smooth-passes"
  | "attempt-cap"
  | "time-cap"
  | "skipped-c8";

export interface BridgeWindowState {
  trigger: BridgeTriggerKind;
  junction: ChunkJunction;
  leftChunk: MotorChunk;
  rightChunk: MotorChunk;
  span: BridgeWindowSpan;
  originalSpeed: number;
  activeSpeed: number;
  phase: BridgeWindowPhase;
  smoothPassesDone: number;
  requiredSmoothPasses: number;
  attempts: number;
  maxAttempts: number;
  softCapMs: number;
  startedAtMs: number;
  skippableViaC8: true;
  lastSlipNotice: string | null;
  exitReason?: BridgeExitReason;
}

export interface EmpiricalJunctionTracker {
  consecutiveFaultsByJunctionId: Record<string, number>;
}

export interface LinkedVerificationSpan {
  leftChunk: MotorChunk;
  rightChunk: MotorChunk;
  steps: PracticeStep[];
  startScoreSec: number;
  endScoreSec: number;
}

function clampStepsEachSide(n: number | undefined, fallback: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.max(BRIDGE_MIN_STEPS_EACH_SIDE, Math.min(BRIDGE_MAX_STEPS_EACH_SIDE, Math.round(n)));
}

function coordToTick(scoreDoc: ScoreDocument, coord: ScoreCoord): number {
  const tl = scoreDoc.measureTimelines[coord.measureIndex];
  if (!tl) {
    return coord.measureIndex >= scoreDoc.measureCount ? Number.POSITIVE_INFINITY : 0;
  }
  return tl.startTick + (coord.beatNum / Math.max(1, coord.beatDen)) * scoreDoc.ticksPerQuarter;
}

/**
 * Returns compact Count-In beat count for Bridge Window:
 * 2 beats for standard simple meters (4/4, 3/4, 2/4), or compact half-measure for compound meters (e.g. 3 for 6/8).
 */
export function computeCompactBridgeCountInBeats(
  scoreDoc: ScoreDocument,
  measureIndex: number,
): number {
  const tl = scoreDoc.measureTimelines[measureIndex] ?? scoreDoc.measureTimelines[0];
  if (!tl || tl.timeBeats <= 0) return 2;
  if (tl.timeBeats >= 6 && tl.timeBeats % 3 === 0) {
    return Math.max(2, Math.floor(tl.timeBeats / 2));
  }
  return 2;
}

/**
 * Resolves a strictly `PracticeStep`-level Bridge Window span straddling 2–3 steps before
 * and 2–3 steps after a fragile `ChunkJunction`. Never reads or mutates Free Studio's `AbLoopBounds`.
 */
export function resolveBridgeWindowSpan(params: {
  scoreDoc: ScoreDocument;
  practiceSteps: readonly PracticeStep[];
  junction: ChunkJunction;
  leftChunk: MotorChunk;
  rightChunk: MotorChunk;
  preSteps?: number;
  postSteps?: number;
}): BridgeWindowSpan {
  const { scoreDoc, practiceSteps, junction, leftChunk, rightChunk } = params;
  const preCount = clampStepsEachSide(params.preSteps, BRIDGE_PRE_STEPS_DEFAULT);
  const postCount = clampStepsEachSide(params.postSteps, BRIDGE_POST_STEPS_DEFAULT);

  if (practiceSteps.length === 0) {
    const startTl = scoreDoc.measureTimelines[leftChunk.startMeasureIndex];
    const endTl = scoreDoc.measureTimelines[rightChunk.endMeasureIndex];
    const startScoreSec = startTl?.startSec ?? 0;
    const endScoreSec = endTl?.endSec ?? startScoreSec + 1;
    return {
      junction,
      leftChunk,
      rightChunk,
      startStepIndex: 0,
      endStepIndex: 0,
      junctionStepIndex: 0,
      steps: [],
      startScoreSec,
      endScoreSec,
      countInBeats: computeCompactBridgeCountInBeats(scoreDoc, junction.measureIndex),
    };
  }

  const boundaryTick = coordToTick(scoreDoc, junction.boundaryCoord);
  let junctionIdx = practiceSteps.findIndex((s) => s.onsetTick >= boundaryTick - 1e-6);
  if (junctionIdx < 0) {
    junctionIdx = Math.max(
      0,
      Math.min(practiceSteps.length - 1, junction.bridgeWindowSteps.junctionStepIndex),
    );
  }

  const startIdx = Math.max(0, junctionIdx - preCount);
  const endIdx = Math.min(practiceSteps.length - 1, junctionIdx + postCount - 1);
  const steps = practiceSteps.slice(startIdx, endIdx + 1);
  const firstStep = steps[0] ?? practiceSteps[0];
  const lastStep = steps[steps.length - 1] ?? practiceSteps[practiceSteps.length - 1];

  const startScoreSec = firstStep.onsetSec;
  const endScoreSec = Math.max(
    startScoreSec + 0.1,
    lastStep.onsetSec + Math.max(0.25, lastStep.expectedDurationSec),
  );

  return {
    junction,
    leftChunk,
    rightChunk,
    startStepIndex: firstStep.stepIndex,
    endStepIndex: lastStep.stepIndex,
    junctionStepIndex: practiceSteps[junctionIdx]?.stepIndex ?? junction.bridgeWindowSteps.junctionStepIndex,
    steps,
    startScoreSec,
    endScoreSec,
    countInBeats: computeCompactBridgeCountInBeats(scoreDoc, firstStep.measureIndex),
  };
}

function findHandPositionCoveringStep(
  hand: Hand,
  step: PracticeStep | undefined,
  solveResult: SolveResult | null,
  scoreDoc: ScoreDocument,
  sliceIndexById: ReadonlyMap<string, number>,
): HandPosition | null {
  if (!step || !solveResult) return null;

  let targetSliceIdx = -1;
  const stepSliceIds = new Set<string>();
  for (const sl of scoreDoc.onsetSlices) {
    if (
      sl.hand === hand &&
      sl.measureIndex === step.measureIndex &&
      Math.abs(sl.onsetTick - step.onsetTick) <= 1e-4 &&
      sl.isGrace === step.isGrace
    ) {
      stepSliceIds.add(sl.sliceId);
      const idx = sliceIndexById.get(sl.sliceId);
      if (idx !== undefined && targetSliceIdx < 0) {
        targetSliceIdx = idx;
      }
    }
  }
  if (targetSliceIdx < 0 && step.primarySliceId) {
    stepSliceIds.add(step.primarySliceId);
    targetSliceIdx = sliceIndexById.get(step.primarySliceId) ?? -1;
  }

  for (const hp of solveResult.handPositions) {
    if (hp.hand !== hand) continue;
    if (stepSliceIds.has(hp.startSliceId) || stepSliceIds.has(hp.endSliceId)) {
      return hp;
    }
    const startIdx = sliceIndexById.get(hp.startSliceId) ?? -1;
    const endIdx = sliceIndexById.get(hp.endSliceId) ?? -1;
    if (
      targetSliceIdx >= 0 &&
      startIdx >= 0 &&
      endIdx >= 0 &&
      targetSliceIdx >= startIdx &&
      targetSliceIdx <= endIdx
    ) {
      return hp;
    }
  }
  return null;
}

function buildHandSpanEndpoint(
  hand: Hand,
  stepsSubset: readonly PracticeStep[],
  solveResult: SolveResult | null,
  scoreDoc: ScoreDocument,
  sliceIndexById: ReadonlyMap<string, number>,
): BridgeHandSpanEndpoint | undefined {
  for (const st of stepsSubset) {
    const hp = findHandPositionCoveringStep(hand, st, solveResult, scoreDoc, sliceIndexById);
    if (hp) {
      const lo = Math.min(hp.minMidi, hp.maxMidi);
      const hi = Math.max(hp.minMidi, hp.maxMidi);
      const label = lo === hi ? midiToPitchLabel(lo) : `${midiToPitchLabel(lo)}–${midiToPitchLabel(hi)}`;
      return { thumbMidi: lo, pinkyMidi: hi, label };
    }
  }

  const midis: number[] = [];
  for (const st of stepsSubset) {
    for (const n of st.expectedNotes) {
      if (n.hand === hand) midis.push(n.midi);
    }
  }
  if (midis.length === 0) return undefined;
  const lo = Math.min(...midis);
  const hi = Math.max(...midis);
  return {
    thumbMidi: lo,
    pinkyMidi: hi,
    label: lo === hi ? midiToPitchLabel(lo) : `${midiToPitchLabel(lo)}–${midiToPitchLabel(hi)}`,
  };
}

/**
 * Derives before/after `HandPosition` preview spans across a `ChunkJunction`
 * for `UnifiedPiano88` during a `Bridge Window`.
 */
export function deriveBridgeHandPositionPreview(params: {
  scoreDoc: ScoreDocument;
  solveResult: SolveResult | null;
  span: BridgeWindowSpan;
  practiceMode?: PracticeMode;
}): BridgeHandPositionPreview {
  const { scoreDoc, solveResult, span, practiceMode = "both" } = params;
  const sliceIndexById = new Map<string, number>();
  scoreDoc.onsetSlices.forEach((sl, idx) => sliceIndexById.set(sl.sliceId, idx));

  const beforeSteps = span.steps.filter((s) => s.stepIndex < span.junctionStepIndex);
  const afterSteps = span.steps.filter((s) => s.stepIndex >= span.junctionStepIndex);
  const beforeRef = beforeSteps.length > 0 ? [...beforeSteps].reverse() : span.steps;
  const afterRef = afterSteps.length > 0 ? afterSteps : span.steps;

  const includeRh = practiceMode !== "lh-only";
  const includeLh = practiceMode !== "rh-only";

  const beforeRh = includeRh
    ? buildHandSpanEndpoint("RH", beforeRef, solveResult, scoreDoc, sliceIndexById)
    : undefined;
  const afterRh = includeRh
    ? buildHandSpanEndpoint("RH", afterRef, solveResult, scoreDoc, sliceIndexById)
    : undefined;
  const beforeLh = includeLh
    ? buildHandSpanEndpoint("LH", beforeRef, solveResult, scoreDoc, sliceIndexById)
    : undefined;
  const afterLh = includeLh
    ? buildHandSpanEndpoint("LH", afterRef, solveResult, scoreDoc, sliceIndexById)
    : undefined;

  const summaryParts: string[] = [];
  if (beforeRh && afterRh) {
    summaryParts.push(`右手 ${beforeRh.label} → ${afterRh.label}`);
  }
  if (beforeLh && afterLh) {
    summaryParts.push(`左手 ${beforeLh.label} → ${afterLh.label}`);
  }

  return {
    junctionId: span.junction.junctionId,
    prepCueLabel: span.junction.prepCueLabel,
    beforeSliceId: beforeRef[0]?.primarySliceId ?? null,
    afterSliceId: afterRef[0]?.primarySliceId ?? null,
    beforeRange: {
      ...(beforeRh ? { rh: beforeRh } : {}),
      ...(beforeLh ? { lh: beforeLh } : {}),
    },
    afterRange: {
      ...(afterRh ? { rh: afterRh } : {}),
      ...(afterLh ? { lh: afterLh } : {}),
    },
    shiftSummary:
      summaryParts.length > 0 ? summaryParts.join(" · ") : span.junction.prepCueLabel,
  };
}

/**
 * Static pre-warm rule: `priorRisk >= 0.65` (or explicit high-risk / SwitchPoint junction).
 */
export function shouldPrewarmStaticJunction(junction: ChunkJunction): boolean {
  return (
    junction.priorRisk >= BRIDGE_STATIC_PRIOR_RISK_THRESHOLD ||
    junction.isHighRisk ||
    junction.reasonTags.includes("switch-point")
  );
}

/**
 * Checks whether an attribution result exhibits an empirical fault or hesitation
 * (`ratio > 1.6x && delay >= 0.45 s`) at the target `ChunkJunction`.
 */
export function isEmpiricalJunctionFault(params: {
  attribution: BoundedAttributionResult;
  junction: ChunkJunction;
  bridgeSpan?: BridgeWindowSpan;
  expectedSteps?: readonly PracticeStep[];
}): boolean {
  const { attribution, junction, bridgeSpan, expectedSteps } = params;
  if (attribution.fluency.switchBranchMismatch) return true;

  const bwStart = bridgeSpan?.startStepIndex ?? junction.bridgeWindowSteps.startStepIndex;
  const bwEnd = bridgeSpan?.endStepIndex ?? junction.bridgeWindowSteps.endStepIndex;

  const isGlobalStepInBridge = (localStepIdx: number): boolean => {
    const globalIdx = expectedSteps?.[localStepIdx]?.stepIndex ?? localStepIdx;
    return globalIdx >= bwStart && globalIdx <= bwEnd;
  };

  const junctionBreaks = attribution.hesitationBreaks.filter(
    (b) => b.isJunction || (expectedSteps ? isGlobalStepInBridge(b.stepIndex) : false),
  );
  const hasHesitationFault = junctionBreaks.some(
    (b) =>
      b.ioiRatio > BRIDGE_HESITATION_RATIO_THRESHOLD &&
      b.delayMs >= BRIDGE_HESITATION_MIN_DELAY_MS,
  );
  if (hasHesitationFault) return true;

  if (bridgeSpan) {
    const stepSet = new Set(bridgeSpan.steps.map((s) => s.stepIndex));
    if (attribution.missedNotes.some((m) => stepSet.has(m.stepIndex))) {
      return true;
    }
  } else if (expectedSteps && expectedSteps.length > 0) {
    if (attribution.missedNotes.some((m) => isGlobalStepInBridge(m.stepIndex))) {
      return true;
    }
  }

  const mFaults = attribution.measureFaultCounts[junction.measureIndex];
  if (mFaults && mFaults.missed + mFaults.extra > 0) {
    return true;
  }

  return false;
}

export function createEmpiricalJunctionTracker(): EmpiricalJunctionTracker {
  return { consecutiveFaultsByJunctionId: {} };
}

/**
 * Records an empirical outcome on a junction; triggers Bridge Window auto-narrowing
 * after 2 consecutive junction faults or `> 1.6x` & `>= 0.45 s` hesitations.
 */
export function recordEmpiricalJunctionOutcome(
  tracker: EmpiricalJunctionTracker,
  params: {
    junction: ChunkJunction;
    attribution: BoundedAttributionResult;
    bridgeSpan?: BridgeWindowSpan;
    expectedSteps?: readonly PracticeStep[];
  },
): { tracker: EmpiricalJunctionTracker; triggered: boolean; consecutiveCount: number } {
  const faulted = isEmpiricalJunctionFault(params);
  const prev = tracker.consecutiveFaultsByJunctionId[params.junction.junctionId] ?? 0;
  const nextCount = faulted ? prev + 1 : 0;
  return {
    tracker: {
      consecutiveFaultsByJunctionId: {
        ...tracker.consecutiveFaultsByJunctionId,
        [params.junction.junctionId]: nextCount,
      },
    },
    triggered: nextCount >= 2,
    consecutiveCount: nextCount,
  };
}

/**
 * Initializes a Bridge Window micro-practice state machine, stepping speed down
 * by `-10%` to `-15%` (default `-12%`) for empirical faults / branch mismatches.
 */
export function createBridgeWindowState(params: {
  trigger: BridgeTriggerKind;
  junction: ChunkJunction;
  leftChunk: MotorChunk;
  rightChunk: MotorChunk;
  span: BridgeWindowSpan;
  originalSpeed: number;
  startedAtMs: number;
  speedFactor?: number;
  maxAttempts?: number;
  softCapMs?: number;
}): BridgeWindowState {
  const factor =
    params.speedFactor ??
    (params.trigger === "static-prewarm" ? 1.0 : BRIDGE_EMPIRICAL_SPEED_FACTOR);
  const activeSpeed =
    params.trigger === "static-prewarm" && params.speedFactor === undefined
      ? roundSpeed(params.originalSpeed)
      : Math.max(BRIDGE_MIN_SPEED, roundSpeed(params.originalSpeed * factor));

  return {
    trigger: params.trigger,
    junction: params.junction,
    leftChunk: params.leftChunk,
    rightChunk: params.rightChunk,
    span: params.span,
    originalSpeed: roundSpeed(params.originalSpeed),
    activeSpeed,
    phase: "bridging",
    smoothPassesDone: 0,
    requiredSmoothPasses: BRIDGE_REQUIRED_SMOOTH_PASSES,
    attempts: 0,
    maxAttempts: Math.max(6, Math.min(8, params.maxAttempts ?? BRIDGE_MAX_ATTEMPTS)),
    softCapMs: params.softCapMs ?? BRIDGE_SOFT_CAP_MS,
    startedAtMs: params.startedAtMs,
    skippableViaC8: true,
    lastSlipNotice: null,
  };
}

/**
 * Evaluates whether a Bridge Window attempt counts as a smooth, hesitation-free pass.
 */
export function isSmoothBridgePass(attribution: BoundedAttributionResult): boolean {
  if (attribution.fluency.pitchAccuracy < 0.95) return false;
  if (attribution.fluency.stallDetected || attribution.fluency.switchBranchMismatch) return false;
  if (
    attribution.fluency.junctionHesitationRatio > BRIDGE_HESITATION_RATIO_THRESHOLD &&
    attribution.hesitationBreaks.some(
      (b) => b.delayMs >= BRIDGE_HESITATION_MIN_DELAY_MS && b.ioiRatio > BRIDGE_HESITATION_RATIO_THRESHOLD,
    )
  ) {
    return false;
  }
  return attribution.fluency.interiorHesitationCount === 0;
}

/**
 * Records one Bridge Window attempt:
 * - Smooth pass increments `smoothPassesDone`
 * - Single slip preserves `smoothPassesDone` (defers exit by 1 pass without resetting progress)
 * - Exits to `linked-verify` at 2 smooth passes OR ~45 s / 6-8 attempts cap, restoring `originalSpeed`.
 */
export function recordBridgeWindowPass(
  state: BridgeWindowState,
  params: { attribution: BoundedAttributionResult; nowMs: number },
): BridgeWindowState {
  if (state.phase !== "bridging") return state;

  const attempts = state.attempts + 1;
  const smooth = isSmoothBridgePass(params.attribution);
  const smoothPassesDone = smooth ? state.smoothPassesDone + 1 : state.smoothPassesDone;
  const elapsedMs = Math.max(0, params.nowMs - state.startedAtMs);

  let exitReason: BridgeExitReason | undefined;
  if (smoothPassesDone >= state.requiredSmoothPasses) {
    exitReason = "smooth-passes";
  } else if (attempts >= state.maxAttempts) {
    exitReason = "attempt-cap";
  } else if (elapsedMs >= state.softCapMs) {
    exitReason = "time-cap";
  }

  if (exitReason) {
    return {
      ...state,
      attempts,
      smoothPassesDone,
      phase: "linked-verify",
      activeSpeed: state.originalSpeed,
      lastSlipNotice: null,
      exitReason,
    };
  }

  return {
    ...state,
    attempts,
    smoothPassesDone,
    lastSlipNotice: smooth
      ? null
      : `单次滑手已顺延（进度保留 ${smoothPassesDone}/${state.requiredSmoothPasses}）`,
  };
}

export function completeBridgeLinkedVerification(state: BridgeWindowState): BridgeWindowState {
  return {
    ...state,
    phase: "completed",
    activeSpeed: state.originalSpeed,
  };
}

export function skipBridgeWindow(state: BridgeWindowState): BridgeWindowState {
  return {
    ...state,
    phase: "skipped",
    activeSpeed: state.originalSpeed,
    exitReason: "skipped-c8",
  };
}

/**
 * Builds the full linked two-chunk verification pass span (`leftChunk` + `rightChunk`)
 * executed at `originalSpeed` immediately after exiting a Bridge Window.
 */
export function buildLinkedVerificationSpan(
  scoreDoc: ScoreDocument,
  practiceSteps: readonly PracticeStep[],
  leftChunk: MotorChunk,
  rightChunk: MotorChunk,
): LinkedVerificationSpan {
  const startCoord =
    compareScoreCoord(leftChunk.startCoord, rightChunk.startCoord) <= 0
      ? leftChunk.startCoord
      : rightChunk.startCoord;
  const endCoord =
    compareScoreCoord(leftChunk.endCoord, rightChunk.endCoord) >= 0
      ? leftChunk.endCoord
      : rightChunk.endCoord;
  const startTick = coordToTick(scoreDoc, startCoord);
  const endTick = coordToTick(scoreDoc, endCoord);

  const steps = practiceSteps.filter(
    (s) => s.onsetTick >= startTick - 1e-6 && s.onsetTick < endTick - 1e-6,
  );
  const startTl = scoreDoc.measureTimelines[Math.min(leftChunk.startMeasureIndex, rightChunk.startMeasureIndex)];
  const endTl = scoreDoc.measureTimelines[Math.max(leftChunk.endMeasureIndex, rightChunk.endMeasureIndex)];
  const startScoreSec = steps[0]?.onsetSec ?? startTl?.startSec ?? 0;
  const endScoreSec = Math.max(
    startScoreSec + 0.1,
    endTl?.endSec ?? (steps[steps.length - 1]?.onsetSec ?? startScoreSec) + 0.5,
  );

  return {
    leftChunk,
    rightChunk,
    steps,
    startScoreSec,
    endScoreSec,
  };
}
