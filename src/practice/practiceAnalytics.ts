import type { AbLoopBounds, Hand, PracticeMode, PracticeStep, TransitionCue } from "../domain/types";
import { midiToPitchLabel } from "../solver/keyboard";

export type PracticeFaultKind = "wrong-note" | "early-release";

/** Number of consecutive 0-fault rehearsal passes required to consider a measure/segment mastered. */
export const MASTERY_REQUIRED_CLEAN_PASSES = 3;

/** Ratio of actual inter-step latency to expected tempo-scaled onset gap above which a transition is flagged as a hesitation. */
export const FLUENCY_HESITATION_RATIO_THRESHOLD = 1.6;

/** Minimum absolute extra delay (in seconds) beyond the expected onset gap before flagging a hesitation. */
export const FLUENCY_MIN_EXTRA_LATENCY_SEC = 0.45;

export interface StepErrorStats {
  stepIndex: number;
  measureIndex: number;
  pitchErrors: number;
  durationErrors: number;
  hesitationCount: number;
  failedPasses: number;
  lastFailedPassIndex: number | null;
  rhFaultCount: number;
  lhFaultCount: number;
  faultedMidis: Set<number>;
}

export type MeasureMasteryStatus = "trouble" | "recovering" | "mastered" | "clean";

export interface MeasureErrorSummary {
  measureIndex: number;
  pitchErrors: number;
  durationErrors: number;
  totalErrors: number;
  hesitationCount: number;
  recurrentPasses: number;
  cleanStreak: number;
  completedPasses: number;
  mastered: boolean;
  status: MeasureMasteryStatus;
  troubleScore: number;
  dominantFault: "pitch" | "duration" | "mixed";
  dominantHand: Hand | "both";
}

export interface PracticeRepeatRecommendation {
  id: string;
  startMeasureIndex: number;
  endMeasureIndex: number;
  troubleScore: number;
  pitchErrors: number;
  durationErrors: number;
  recurrentPasses: number;
  cleanStreak: number;
  dominantFault: "pitch" | "duration" | "mixed";
  dominantHand: Hand | "both";
  recommendedSpeedMultiplier: number | null;
  recommendedPracticeMode: PracticeMode | null;
  recommendMetronome: boolean;
  cueLabels: string[];
  headline: string;
  prescription: string;
}

export type PracticeProgressionStage =
  | "practicing"
  | "step-up-hand"
  | "step-up-speed"
  | "ready-next-measure"
  | "piece-mastered";

export interface PracticeProgressionEvaluation {
  startMeasureIndex: number;
  endMeasureIndex: number;
  cleanStreak: number;
  requiredCleanPasses: number;
  isCleanStreakMet: boolean;
  hesitationCount: number;
  recentPassHadHesitation: boolean;
  stage: PracticeProgressionStage;
  canAdvanceToNextMeasure: boolean;
  nextStartMeasureIndex: number | null;
  nextEndMeasureIndex: number | null;
  bridgeStartMeasureIndex: number | null;
  bridgeEndMeasureIndex: number | null;
  recommendedNextPracticeMode: PracticeMode | null;
  recommendedNextSpeedMultiplier: number | null;
  headline: string;
  detail: string;
}

export interface PracticeAnalyticsState {
  currentPassIndex: number;
  completedPasses: number;
  totalStepsCompleted: number;
  firstTryCleanSteps: number;
  currentStepHadFaultInPass: boolean;
  stepStatsByIndex: Record<number, StepErrorStats>;
  currentPassFaultSteps: Set<number>;
  currentPassMeasuresTouched: Set<number>;
  currentPassFaultMeasures: Set<number>;
  currentPassHesitationMeasures: Set<number>;
  measureCleanStreakByIndex: Record<number, number>;
  measurePassCountByIndex: Record<number, number>;
  lastPassHesitationByMeasure: Record<number, number>;
  lastStepCompletedAtSec: number | null;
  lastCompletedStep: PracticeStep | null;
}

export function createPracticeAnalyticsState(): PracticeAnalyticsState {
  return {
    currentPassIndex: 0,
    completedPasses: 0,
    totalStepsCompleted: 0,
    firstTryCleanSteps: 0,
    currentStepHadFaultInPass: false,
    stepStatsByIndex: {},
    currentPassFaultSteps: new Set<number>(),
    currentPassMeasuresTouched: new Set<number>(),
    currentPassFaultMeasures: new Set<number>(),
    currentPassHesitationMeasures: new Set<number>(),
    measureCleanStreakByIndex: {},
    measurePassCountByIndex: {},
    lastPassHesitationByMeasure: {},
    lastStepCompletedAtSec: null,
    lastCompletedStep: null,
  };
}

/**
 * Resets the consecutive clean pass streak for a measure range (e.g. when upgrading from single-hand
 * to both-hands or from slow speed to 1.0x speed so the user validates 3 clean passes at the new difficulty).
 */
export function resetMeasureCleanStreak(
  analytics: PracticeAnalyticsState,
  startMeasureIndex: number,
  endMeasureIndex: number
): PracticeAnalyticsState {
  const nextStreaks = { ...analytics.measureCleanStreakByIndex };
  for (let m = startMeasureIndex; m <= endMeasureIndex; m += 1) {
    nextStreaks[m] = 0;
  }
  return {
    ...analytics,
    measureCleanStreakByIndex: nextStreaks,
    currentPassMeasuresTouched: new Set<number>(),
    currentPassFaultMeasures: new Set<number>(),
    currentPassHesitationMeasures: new Set<number>(),
    lastStepCompletedAtSec: null,
    lastCompletedStep: null,
  };
}

function inferFaultHands(step: PracticeStep, faultMidi?: number): Hand[] {
  const hands = new Set<Hand>();
  for (const note of step.expectedNotes) {
    hands.add(note.hand);
  }
  if (hands.size === 1) {
    return Array.from(hands);
  }
  if (typeof faultMidi === "number" && step.expectedNotes.length > 0) {
    let bestHand: Hand = step.expectedNotes[0].hand;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const note of step.expectedNotes) {
      const dist = Math.abs(note.midi - faultMidi);
      if (dist < bestDist) {
        bestDist = dist;
        bestHand = note.hand;
      }
    }
    return [bestHand];
  }
  return Array.from(hands);
}

function createEmptyStepErrorStats(stepIndex: number, measureIndex: number): StepErrorStats {
  return {
    stepIndex,
    measureIndex,
    pitchErrors: 0,
    durationErrors: 0,
    hesitationCount: 0,
    failedPasses: 0,
    lastFailedPassIndex: null,
    rhFaultCount: 0,
    lhFaultCount: 0,
    faultedMidis: new Set<number>(),
  };
}

/**
 * Records a pitch fault (`"wrong-note"`) or hold duration fault (`"early-release"`)
 * on the active `PracticeStep`, deduplicating pass-level recurrence so a single burst
 * of mis-hits on one step increments `failedPasses` at most once per rehearsal pass.
 */
export function recordPracticeStepFault(
  analytics: PracticeAnalyticsState,
  step: PracticeStep | undefined,
  faultKind: PracticeFaultKind,
  faultMidi?: number
): PracticeAnalyticsState {
  if (!step) return analytics;

  const prevStats =
    analytics.stepStatsByIndex[step.stepIndex] ??
    createEmptyStepErrorStats(step.stepIndex, step.measureIndex);

  const isFirstFaultThisPass = !analytics.currentPassFaultSteps.has(step.stepIndex);
  const nextFaultedMidis = new Set(prevStats.faultedMidis);
  if (typeof faultMidi === "number") {
    nextFaultedMidis.add(faultMidi);
  }

  const faultHands = inferFaultHands(step, faultMidi);
  const nextStats: StepErrorStats = {
    ...prevStats,
    pitchErrors: prevStats.pitchErrors + (faultKind === "wrong-note" ? 1 : 0),
    durationErrors: prevStats.durationErrors + (faultKind === "early-release" ? 1 : 0),
    failedPasses: prevStats.failedPasses + (isFirstFaultThisPass ? 1 : 0),
    lastFailedPassIndex: analytics.currentPassIndex,
    rhFaultCount: prevStats.rhFaultCount + (faultHands.includes("RH") ? 1 : 0),
    lhFaultCount: prevStats.lhFaultCount + (faultHands.includes("LH") ? 1 : 0),
    faultedMidis: nextFaultedMidis,
  };

  const nextPassFaultSteps = new Set(analytics.currentPassFaultSteps);
  nextPassFaultSteps.add(step.stepIndex);

  const nextPassFaultMeasures = new Set(analytics.currentPassFaultMeasures);
  nextPassFaultMeasures.add(step.measureIndex);

  const nextPassMeasuresTouched = new Set(analytics.currentPassMeasuresTouched);
  nextPassMeasuresTouched.add(step.measureIndex);

  // Immediately reset the measure's clean streak when a fault occurs during the pass
  const nextStreaks = {
    ...analytics.measureCleanStreakByIndex,
    [step.measureIndex]: 0,
  };

  return {
    ...analytics,
    currentStepHadFaultInPass: true,
    stepStatsByIndex: {
      ...analytics.stepStatsByIndex,
      [step.stepIndex]: nextStats,
    },
    currentPassFaultSteps: nextPassFaultSteps,
    currentPassFaultMeasures: nextPassFaultMeasures,
    currentPassMeasuresTouched: nextPassMeasuresTouched,
    measureCleanStreakByIndex: nextStreaks,
  };
}

/**
 * Records completion of a `PracticeStep`, evaluates inter-step hesitation latency when
 * timestamps are provided, and updates per-measure consecutive clean pass streaks
 * when the score completes or an A-B loop wraps back to start (`passCompleted: true`).
 */
export function recordPracticeStepCompleted(
  analytics: PracticeAnalyticsState,
  options: {
    completedStep?: PracticeStep | null;
    passCompleted?: boolean;
    nowSec?: number;
    speedMultiplier?: number;
  } = {}
): PracticeAnalyticsState {
  const wasClean = !analytics.currentStepHadFaultInPass;
  const passCompleted = Boolean(options.passCompleted);
  const completedStep = options.completedStep ?? null;
  const nowSec =
    typeof options.nowSec === "number" && Number.isFinite(options.nowSec)
      ? options.nowSec
      : null;
  const speed =
    typeof options.speedMultiplier === "number" && options.speedMultiplier > 0
      ? options.speedMultiplier
      : 1;

  let nextStepStatsByIndex = analytics.stepStatsByIndex;
  const nextPassHesitationMeasures = new Set(analytics.currentPassHesitationMeasures);

  // Check inter-step transition latency (fluency) if consecutive steps in the same pass have timestamps
  if (
    completedStep &&
    nowSec !== null &&
    analytics.lastStepCompletedAtSec !== null &&
    analytics.lastCompletedStep &&
    completedStep.stepIndex > analytics.lastCompletedStep.stepIndex
  ) {
    const scoreGapSec = Math.max(
      0,
      (completedStep.onsetSec - analytics.lastCompletedStep.onsetSec) / speed
    );
    const prevRequiredHoldSec = Math.max(
      0,
      (analytics.lastCompletedStep.expectedDurationSec / speed) * 0.8
    );
    const expectedTransitionGapSec = Math.max(0.15, scoreGapSec - prevRequiredHoldSec * 0.5);
    const actualGapSec = Math.max(0, nowSec - analytics.lastStepCompletedAtSec);

    if (
      actualGapSec >
      expectedTransitionGapSec * FLUENCY_HESITATION_RATIO_THRESHOLD +
        FLUENCY_MIN_EXTRA_LATENCY_SEC
    ) {
      const prevStats =
        nextStepStatsByIndex[completedStep.stepIndex] ??
        createEmptyStepErrorStats(completedStep.stepIndex, completedStep.measureIndex);
      nextStepStatsByIndex = {
        ...nextStepStatsByIndex,
        [completedStep.stepIndex]: {
          ...prevStats,
          hesitationCount: prevStats.hesitationCount + 1,
        },
      };
      nextPassHesitationMeasures.add(completedStep.measureIndex);
    }
  }

  const nextPassMeasuresTouched = new Set(analytics.currentPassMeasuresTouched);
  if (completedStep) {
    nextPassMeasuresTouched.add(completedStep.measureIndex);
  }

  let nextMeasureCleanStreakByIndex = analytics.measureCleanStreakByIndex;
  let nextMeasurePassCountByIndex = analytics.measurePassCountByIndex;
  let nextLastPassHesitationByMeasure = analytics.lastPassHesitationByMeasure;

  if (passCompleted) {
    const coveredMeasures = new Set<number>([
      ...nextPassMeasuresTouched,
      ...analytics.currentPassFaultMeasures,
    ]);
    // Fallback for unit-test callers that omit `completedStep` on clean passes:
    // include any measure previously tracked in stepStatsByIndex or measurePassCountByIndex
    if (coveredMeasures.size === 0) {
      for (const stat of Object.values(nextStepStatsByIndex)) {
        coveredMeasures.add(stat.measureIndex);
      }
      for (const mKey of Object.keys(analytics.measurePassCountByIndex)) {
        coveredMeasures.add(Number(mKey));
      }
    } else {
      for (const stat of Object.values(nextStepStatsByIndex)) {
        if (nextPassMeasuresTouched.size === 0 || coveredMeasures.has(stat.measureIndex)) {
          coveredMeasures.add(stat.measureIndex);
        }
      }
    }

    nextMeasureCleanStreakByIndex = { ...analytics.measureCleanStreakByIndex };
    nextMeasurePassCountByIndex = { ...analytics.measurePassCountByIndex };
    nextLastPassHesitationByMeasure = { ...analytics.lastPassHesitationByMeasure };

    for (const mIdx of coveredMeasures) {
      nextMeasurePassCountByIndex[mIdx] = (nextMeasurePassCountByIndex[mIdx] ?? 0) + 1;
      if (analytics.currentPassFaultMeasures.has(mIdx)) {
        nextMeasureCleanStreakByIndex[mIdx] = 0;
      } else {
        nextMeasureCleanStreakByIndex[mIdx] =
          (nextMeasureCleanStreakByIndex[mIdx] ?? 0) + 1;
      }
      nextLastPassHesitationByMeasure[mIdx] = nextPassHesitationMeasures.has(mIdx) ? 1 : 0;
    }
  }

  return {
    ...analytics,
    currentPassIndex: passCompleted ? analytics.currentPassIndex + 1 : analytics.currentPassIndex,
    completedPasses: passCompleted ? analytics.completedPasses + 1 : analytics.completedPasses,
    totalStepsCompleted: analytics.totalStepsCompleted + 1,
    firstTryCleanSteps: analytics.firstTryCleanSteps + (wasClean ? 1 : 0),
    currentStepHadFaultInPass: false,
    stepStatsByIndex: nextStepStatsByIndex,
    currentPassFaultSteps: passCompleted ? new Set<number>() : analytics.currentPassFaultSteps,
    currentPassMeasuresTouched: passCompleted ? new Set<number>() : nextPassMeasuresTouched,
    currentPassFaultMeasures: passCompleted
      ? new Set<number>()
      : analytics.currentPassFaultMeasures,
    currentPassHesitationMeasures: passCompleted
      ? new Set<number>()
      : nextPassHesitationMeasures,
    measureCleanStreakByIndex: nextMeasureCleanStreakByIndex,
    measurePassCountByIndex: nextMeasurePassCountByIndex,
    lastPassHesitationByMeasure: nextLastPassHesitationByMeasure,
    lastStepCompletedAtSec: passCompleted ? null : (nowSec ?? analytics.lastStepCompletedAtSec),
    lastCompletedStep: passCompleted ? null : (completedStep ?? analytics.lastCompletedStep),
  };
}

/**
 * Aggregates per-measure error and mastery summaries across all recorded `StepErrorStats`
 * and pass streaks. Includes any measure that has recorded faults OR has reached
 * mastery (`cleanStreak >= MASTERY_REQUIRED_CLEAN_PASSES`).
 */
export function buildMeasureErrorSummaries(
  analytics: PracticeAnalyticsState,
  requiredCleanPasses = MASTERY_REQUIRED_CLEAN_PASSES
): Map<number, MeasureErrorSummary> {
  const byMeasure = new Map<
    number,
    {
      pitchErrors: number;
      durationErrors: number;
      hesitationCount: number;
      maxRecurrentPasses: number;
      faultStepCount: number;
      rhFaults: number;
      lhFaults: number;
    }
  >();

  for (const stat of Object.values(analytics.stepStatsByIndex)) {
    const total = stat.pitchErrors + stat.durationErrors;
    if (total === 0 && stat.hesitationCount === 0) continue;
    const entry = byMeasure.get(stat.measureIndex) ?? {
      pitchErrors: 0,
      durationErrors: 0,
      hesitationCount: 0,
      maxRecurrentPasses: 0,
      faultStepCount: 0,
      rhFaults: 0,
      lhFaults: 0,
    };
    entry.pitchErrors += stat.pitchErrors;
    entry.durationErrors += stat.durationErrors;
    entry.hesitationCount += stat.hesitationCount;
    entry.maxRecurrentPasses = Math.max(entry.maxRecurrentPasses, stat.failedPasses);
    if (total > 0) {
      entry.faultStepCount += 1;
    }
    entry.rhFaults += stat.rhFaultCount;
    entry.lhFaults += stat.lhFaultCount;
    byMeasure.set(stat.measureIndex, entry);
  }

  // Also include measures that reached mastery streak even if they had 0 errors
  for (const [mKey, streak] of Object.entries(analytics.measureCleanStreakByIndex)) {
    const mIdx = Number(mKey);
    if (streak >= requiredCleanPasses && !byMeasure.has(mIdx)) {
      byMeasure.set(mIdx, {
        pitchErrors: 0,
        durationErrors: 0,
        hesitationCount: 0,
        maxRecurrentPasses: 0,
        faultStepCount: 0,
        rhFaults: 0,
        lhFaults: 0,
      });
    }
  }

  const summaries = new Map<number, MeasureErrorSummary>();
  for (const [measureIndex, m] of byMeasure.entries()) {
    const totalErrors = m.pitchErrors + m.durationErrors;
    const cleanStreak = analytics.measureCleanStreakByIndex[measureIndex] ?? 0;
    const completedPasses = analytics.measurePassCountByIndex[measureIndex] ?? 0;
    const mastered = cleanStreak >= requiredCleanPasses;

    // Exclude 0-error measures that haven't reached mastery yet
    if (totalErrors === 0 && !mastered) {
      continue;
    }

    const status: MeasureMasteryStatus = mastered
      ? "mastered"
      : totalErrors > 0 && cleanStreak > 0
        ? "recovering"
        : totalErrors > 0
          ? "trouble"
          : "clean";

    const rawTroubleScore =
      m.maxRecurrentPasses * 3.0 +
      m.pitchErrors * 1.5 +
      m.durationErrors * 1.2 +
      m.faultStepCount;
    // Discount troubleScore as cleanStreak progresses toward mastery
    const streakDiscount = mastered ? 0 : Math.max(0.25, 1 - cleanStreak * 0.25);
    const troubleScore = Number((rawTroubleScore * streakDiscount).toFixed(2));

    const dominantFault: MeasureErrorSummary["dominantFault"] =
      m.pitchErrors > 0 && m.durationErrors === 0
        ? "pitch"
        : m.durationErrors > 0 && m.pitchErrors === 0
          ? "duration"
          : m.pitchErrors >= m.durationErrors * 1.5
            ? "pitch"
            : m.durationErrors >= m.pitchErrors * 1.5
              ? "duration"
              : "mixed";

    const totalHandFaults = m.rhFaults + m.lhFaults;
    const dominantHand: MeasureErrorSummary["dominantHand"] =
      totalHandFaults > 0 && m.rhFaults / totalHandFaults >= 0.75
        ? "RH"
        : totalHandFaults > 0 && m.lhFaults / totalHandFaults >= 0.75
          ? "LH"
          : "both";

    summaries.set(measureIndex, {
      measureIndex,
      pitchErrors: m.pitchErrors,
      durationErrors: m.durationErrors,
      totalErrors,
      hesitationCount: m.hesitationCount,
      recurrentPasses: m.maxRecurrentPasses,
      cleanStreak,
      completedPasses,
      mastered,
      status,
      troubleScore,
      dominantFault,
      dominantHand,
    });
  }

  return summaries;
}

/**
 * Clusters unmastered trouble measures into actionable A-B Loop repeat recommendations (1–4 measures),
 * correlating with solver `TransitionCue`s, dominant hand, and current playback speed.
 * Measures that have achieved `mastered === true` (3 consecutive clean passes) automatically graduate out.
 */
export function buildPracticeRepeatRecommendations(
  analytics: PracticeAnalyticsState,
  options: {
    measureCount: number;
    currentSpeed: number;
    currentPracticeMode: PracticeMode;
    isSingleStaff?: boolean;
    warnings?: TransitionCue[];
    maxRecommendations?: number;
    requiredCleanPasses?: number;
  }
): PracticeRepeatRecommendation[] {
  const requiredCleanPasses = options.requiredCleanPasses ?? MASTERY_REQUIRED_CLEAN_PASSES;
  const summaries = buildMeasureErrorSummaries(analytics, requiredCleanPasses);
  if (summaries.size === 0) return [];

  // Filter out measures that have already graduated (mastered) or have 0 errors
  const unmasteredMeasures = Array.from(summaries.values())
    .filter((m) => m.totalErrors > 0 && !m.mastered)
    .sort((a, b) => a.measureIndex - b.measureIndex);

  if (unmasteredMeasures.length === 0) return [];

  // Merge adjacent or 1-bar-separated trouble measures into contiguous spans (max 4 measures)
  interface Cluster {
    measures: MeasureErrorSummary[];
    startMeasureIndex: number;
    endMeasureIndex: number;
  }

  const clusters: Cluster[] = [];
  for (const item of unmasteredMeasures) {
    const prev = clusters[clusters.length - 1];
    if (
      prev &&
      item.measureIndex - prev.endMeasureIndex <= 1 &&
      item.measureIndex - prev.startMeasureIndex < 4
    ) {
      prev.measures.push(item);
      prev.endMeasureIndex = item.measureIndex;
    } else {
      clusters.push({
        measures: [item],
        startMeasureIndex: item.measureIndex,
        endMeasureIndex: item.measureIndex,
      });
    }
  }

  const warnings = options.warnings ?? [];
  const maxRecommendations = options.maxRecommendations ?? 3;

  const recommendations: PracticeRepeatRecommendation[] = clusters.map((cluster) => {
    let pitchErrors = 0;
    let durationErrors = 0;
    let recurrentPasses = 0;
    let troubleScore = 0;
    let rhWeight = 0;
    let lhWeight = 0;
    let minCleanStreak = Number.POSITIVE_INFINITY;

    for (const m of cluster.measures) {
      pitchErrors += m.pitchErrors;
      durationErrors += m.durationErrors;
      recurrentPasses = Math.max(recurrentPasses, m.recurrentPasses);
      troubleScore += m.troubleScore;
      minCleanStreak = Math.min(minCleanStreak, m.cleanStreak);
      if (m.dominantHand === "RH") rhWeight += m.totalErrors;
      else if (m.dominantHand === "LH") lhWeight += m.totalErrors;
    }
    const cleanStreak = Number.isFinite(minCleanStreak) ? minCleanStreak : 0;

    const dominantFault: PracticeRepeatRecommendation["dominantFault"] =
      pitchErrors > 0 && durationErrors === 0
        ? "pitch"
        : durationErrors > 0 && pitchErrors === 0
          ? "duration"
          : pitchErrors >= durationErrors * 1.5
            ? "pitch"
            : durationErrors >= pitchErrors * 1.5
              ? "duration"
              : "mixed";

    const totalHandWeight = rhWeight + lhWeight;
    const dominantHand: PracticeRepeatRecommendation["dominantHand"] =
      totalHandWeight > 0 && rhWeight / totalHandWeight >= 0.75
        ? "RH"
        : totalHandWeight > 0 && lhWeight / totalHandWeight >= 0.75
          ? "LH"
          : "both";

    const startM = cluster.startMeasureIndex;
    const endM = cluster.endMeasureIndex;

    const matchingCues = warnings.filter(
      (w) => w.measureIndex >= startM && w.measureIndex <= endM
    );
    const cueLabels = Array.from(new Set(matchingCues.map((c) => c.label))).slice(0, 2);

    const rangeLabel =
      startM === endM ? `第 ${startM + 1} 小节` : `第 ${startM + 1}–${endM + 1} 小节`;

    const faultParts: string[] = [];
    if (pitchErrors > 0) faultParts.push(`错音 ${pitchErrors} 次`);
    if (durationErrors > 0) faultParts.push(`时值不足 ${durationErrors} 次`);
    if (recurrentPasses >= 2) faultParts.push(`连续 ${recurrentPasses} 遍复发`);
    if (cleanStreak > 0) {
      faultParts.push(`已连续 ${cleanStreak}/${requiredCleanPasses} 遍零失误`);
    }

    const headline = `${rangeLabel}（${faultParts.join(" · ")}）`;

    // Determine actionable speed / mode / metronome prescription
    let recommendedSpeedMultiplier: number | null = null;
    if (recurrentPasses >= 2 || pitchErrors >= 3 || matchingCues.length > 0) {
      const targetSpeed = Math.max(0.5, Math.round(options.currentSpeed * 0.75 * 20) / 20);
      if (targetSpeed < options.currentSpeed - 0.04) {
        recommendedSpeedMultiplier = targetSpeed;
      }
    }

    let recommendedPracticeMode: PracticeMode | null = null;
    if (!options.isSingleStaff && options.currentPracticeMode === "both") {
      if (dominantHand === "RH" && pitchErrors + durationErrors >= 2) {
        recommendedPracticeMode = "rh-only";
      } else if (dominantHand === "LH" && pitchErrors + durationErrors >= 2) {
        recommendedPracticeMode = "lh-only";
      }
    }

    const recommendMetronome = dominantFault === "duration" || durationErrors > 0;

    // Gather most frequently missed pitches in this cluster for concrete guidance
    const missedMidis: number[] = [];
    for (const stat of Object.values(analytics.stepStatsByIndex)) {
      if (stat.measureIndex >= startM && stat.measureIndex <= endM) {
        for (const m of stat.faultedMidis) {
          if (!missedMidis.includes(m)) missedMidis.push(m);
        }
      }
    }
    const missedPitchText =
      missedMidis.length > 0
        ? `（易错音: ${missedMidis.slice(0, 3).map(midiToPitchLabel).join("、")}）`
        : "";

    const prescriptionTips: string[] = [];
    if (dominantFault === "pitch") {
      prescriptionTips.push(`音高/和弦误触较多${missedPitchText}`);
    } else if (dominantFault === "duration") {
      prescriptionTips.push(`存在提前松键导致时值不足${missedPitchText}`);
    } else {
      prescriptionTips.push(`同时存在错音与时值保持不足${missedPitchText}`);
    }

    if (cueLabels.length > 0) {
      prescriptionTips.push(`含指法难点「${cueLabels.join("、")}」`);
    }

    if (cleanStreak > 0) {
      prescriptionTips.push(
        `再保持 ${requiredCleanPasses - cleanStreak} 遍零失误即可达标通关`
      );
    } else {
      if (recommendedPracticeMode) {
        prescriptionTips.push(
          `建议先切到「${recommendedPracticeMode === "rh-only" ? "仅右手" : "仅左手"}」单独巩固`
        );
      }
      if (recommendedSpeedMultiplier !== null) {
        prescriptionTips.push(
          `降速至 ${Number(recommendedSpeedMultiplier.toFixed(2))}x 进行 A-B 循环`
        );
      } else {
        prescriptionTips.push(`建议开启 ${rangeLabel} A-B 循环重点重复`);
      }
    }

    return {
      id: `rec-${startM}-${endM}`,
      startMeasureIndex: startM,
      endMeasureIndex: endM,
      troubleScore,
      pitchErrors,
      durationErrors,
      recurrentPasses,
      cleanStreak,
      dominantFault,
      dominantHand,
      recommendedSpeedMultiplier,
      recommendedPracticeMode,
      recommendMetronome,
      cueLabels,
      headline,
      prescription: prescriptionTips.join("，") + "。",
    };
  });

  return recommendations
    .sort((a, b) => b.troubleScore - a.troubleScore || a.startMeasureIndex - b.startMeasureIndex)
    .slice(0, maxRecommendations);
}

/**
 * Evaluates whether the currently practiced measure or A-B loop segment has met the mastery
 * criteria (default: 3 consecutive 0-fault passes), whether the player needs to restore two-hand
 * or full-speed playback first, or whether they are ready to advance to the next measure(s).
 */
export function evaluatePracticeProgression(
  analytics: PracticeAnalyticsState,
  options: {
    measureCount: number;
    abLoop?: AbLoopBounds | null;
    activeMeasureIndex?: number | null;
    currentSpeed: number;
    targetSpeed?: number;
    currentPracticeMode: PracticeMode;
    isSingleStaff?: boolean;
    requiredCleanPasses?: number;
  }
): PracticeProgressionEvaluation {
  const totalMeasures = Math.max(1, options.measureCount);
  const requiredCleanPasses = options.requiredCleanPasses ?? MASTERY_REQUIRED_CLEAN_PASSES;
  const targetSpeed = options.targetSpeed ?? 1.0;

  let startMeasureIndex = 0;
  let endMeasureIndex = totalMeasures - 1;

  if (options.abLoop?.enabled) {
    startMeasureIndex = Math.max(
      0,
      Math.min(totalMeasures - 1, options.abLoop.startMeasureIndex)
    );
    endMeasureIndex = Math.max(
      startMeasureIndex,
      Math.min(totalMeasures - 1, options.abLoop.endMeasureIndex)
    );
  } else {
    const practicedMeasures = Object.keys(analytics.measurePassCountByIndex)
      .map(Number)
      .filter((m) => Number.isFinite(m) && m >= 0 && m < totalMeasures)
      .sort((a, b) => a - b);

    if (practicedMeasures.length > 0) {
      startMeasureIndex = practicedMeasures[0];
      endMeasureIndex = practicedMeasures[practicedMeasures.length - 1];
    } else if (
      typeof options.activeMeasureIndex === "number" &&
      options.activeMeasureIndex >= 0 &&
      options.activeMeasureIndex < totalMeasures
    ) {
      startMeasureIndex = options.activeMeasureIndex;
      endMeasureIndex = options.activeMeasureIndex;
    }
  }

  let minStreak = Number.POSITIVE_INFINITY;
  let hesitationCount = 0;
  let recentHesitation = false;

  for (let m = startMeasureIndex; m <= endMeasureIndex; m += 1) {
    const streak = analytics.measureCleanStreakByIndex[m] ?? 0;
    minStreak = Math.min(minStreak, streak);
    if ((analytics.lastPassHesitationByMeasure[m] ?? 0) > 0) {
      recentHesitation = true;
    }
  }

  for (const stat of Object.values(analytics.stepStatsByIndex)) {
    if (stat.measureIndex >= startMeasureIndex && stat.measureIndex <= endMeasureIndex) {
      hesitationCount += stat.hesitationCount;
    }
  }

  const cleanStreak = Number.isFinite(minStreak) ? minStreak : 0;
  const isCleanStreakMet = cleanStreak >= requiredCleanPasses;

  const needsBothHands = !options.isSingleStaff && options.currentPracticeMode !== "both";
  const needsTempoRestore = options.currentSpeed < targetSpeed - 0.04;
  const canAdvanceToNextMeasure = endMeasureIndex + 1 < totalMeasures;

  const spanLength = Math.max(1, endMeasureIndex - startMeasureIndex + 1);
  const nextStartMeasureIndex = canAdvanceToNextMeasure ? endMeasureIndex + 1 : null;
  const nextEndMeasureIndex =
    nextStartMeasureIndex !== null
      ? Math.min(totalMeasures - 1, nextStartMeasureIndex + spanLength - 1)
      : null;

  const bridgeStartMeasureIndex = canAdvanceToNextMeasure ? endMeasureIndex : null;
  const bridgeEndMeasureIndex = canAdvanceToNextMeasure ? endMeasureIndex + 1 : null;

  const rangeLabel =
    startMeasureIndex === endMeasureIndex
      ? `第 ${startMeasureIndex + 1} 小节`
      : `第 ${startMeasureIndex + 1}–${endMeasureIndex + 1} 小节`;

  let stage: PracticeProgressionStage = "practicing";
  let recommendedNextPracticeMode: PracticeMode | null = null;
  let recommendedNextSpeedMultiplier: number | null = null;
  let headline = "";
  let detail = "";

  if (!isCleanStreakMet) {
    stage = "practicing";
    const remaining = Math.max(1, requiredCleanPasses - cleanStreak);
    headline = `${rangeLabel} · 通关进度 ${cleanStreak}/${requiredCleanPasses} 遍`;
    detail =
      cleanStreak === 0
        ? `当前段落需连续 ${requiredCleanPasses} 遍零失误（无错音、无提前松键）方可判定掌握。`
        : `已连续 ${cleanStreak} 遍零失误，再稳定弹对 ${remaining} 遍即可进入下一阶段！`;
  } else if (needsBothHands) {
    stage = "step-up-hand";
    recommendedNextPracticeMode = "both";
    const handLabel = options.currentPracticeMode === "rh-only" ? "右手" : "左手";
    headline = `${rangeLabel} 单手已达标（连续 ${cleanStreak} 遍零失误）`;
    detail = `${handLabel}单独练习已形成稳定肌肉记忆，建议切回「双手合练」完成合手检验。`;
  } else if (needsTempoRestore) {
    stage = "step-up-speed";
    recommendedNextSpeedMultiplier = Number(
      Math.min(targetSpeed, Math.round((options.currentSpeed + 0.15) * 20) / 20).toFixed(2)
    );
    if (targetSpeed - recommendedNextSpeedMultiplier < 0.06) {
      recommendedNextSpeedMultiplier = targetSpeed;
    }
    headline = `${rangeLabel} 慢速已达标（${Number(options.currentSpeed.toFixed(2))}x 连续 ${cleanStreak} 遍零失误）`;
    detail = `当前慢速下准确率与时值已稳定，建议提速至 ${Number(recommendedNextSpeedMultiplier.toFixed(2))}x 巩固原速流畅度。`;
  } else if (canAdvanceToNextMeasure && nextStartMeasureIndex !== null && nextEndMeasureIndex !== null) {
    stage = "ready-next-measure";
    const nextLabel =
      nextStartMeasureIndex === nextEndMeasureIndex
        ? `第 ${nextStartMeasureIndex + 1} 小节`
        : `第 ${nextStartMeasureIndex + 1}–${nextEndMeasureIndex + 1} 小节`;
    headline = `🎉 ${rangeLabel} 已掌握（连续 ${cleanStreak} 遍零失误），可进入 ${nextLabel}！`;
    detail = recentHesitation
      ? `音高与按住时值已连续 ${cleanStreak} 遍达标（仍有少量步间找键停顿，可先做跨小节衔接练习或直接进入 ${nextLabel}）。`
      : `音高、时值与合手速度均已稳定达标，可以直接推进至 ${nextLabel}，或先做「第 ${endMeasureIndex + 1}–${endMeasureIndex + 2} 小节」跨小节衔接练习。`;
  } else {
    stage = "piece-mastered";
    headline = `🎉 ${rangeLabel} 已彻底掌握（连续 ${cleanStreak} 遍零失误通关）！`;
    detail = `已到达乐谱末尾并完成连续 ${cleanStreak} 遍零失误检验，当前段落/全曲练习圆满达标。`;
  }

  return {
    startMeasureIndex,
    endMeasureIndex,
    cleanStreak,
    requiredCleanPasses,
    isCleanStreakMet,
    hesitationCount,
    recentPassHadHesitation: recentHesitation,
    stage,
    canAdvanceToNextMeasure,
    nextStartMeasureIndex,
    nextEndMeasureIndex,
    bridgeStartMeasureIndex,
    bridgeEndMeasureIndex,
    recommendedNextPracticeMode,
    recommendedNextSpeedMultiplier,
    headline,
    detail,
  };
}
