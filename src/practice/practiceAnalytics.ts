import type { AbLoopBounds, Hand, PracticeMode, PracticeStep, TransitionCue } from "../domain/types";
import { midiToPitchLabel } from "../solver/keyboard";

export type PracticeFaultKind = "wrong-note" | "early-release";

const FLUENCY_CREDIT_TARGET = 2;

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
  fluencyCredit: number;
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
  fluencyCredit: number;
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

export interface PracticeSectionPaceSuggestion {
  startMeasureIndex: number;
  endMeasureIndex: number;
  practicedSpeed: number;
  suggestedSpeed: number;
}

export interface PracticeProgressionEvaluation {
  startMeasureIndex: number;
  endMeasureIndex: number;
  fluencyCredit: number;
  isFluent: boolean;
  hesitationCount: number;
  recentPassHadHesitation: boolean;
  sectionPaceSuggestions: PracticeSectionPaceSuggestion[];
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

interface MeasurePassProgress {
  completedPasses: number;
  fluencyCredit: number;
  fluentSpeed?: number;
  lastPassHesitated: boolean;
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
  currentPassFaultWeightByMeasure: Record<number, number>;
  currentPassHesitationMeasures: Set<number>;
  measureProgressByMode: Record<PracticeMode, Record<number, MeasurePassProgress>>;
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
    currentPassFaultWeightByMeasure: {},
    currentPassHesitationMeasures: new Set<number>(),
    measureProgressByMode: { both: {}, "rh-only": {}, "lh-only": {} },
    lastStepCompletedAtSec: null,
    lastCompletedStep: null,
  };
}

/** Drops incomplete-pass data when changing exercise settings, not earned fluency. */
export function resetCurrentPracticePass(analytics: PracticeAnalyticsState): PracticeAnalyticsState {
  return {
    ...analytics,
    currentPassIndex: analytics.currentPassIndex + 1,
    currentStepHadFaultInPass: false,
    currentPassFaultSteps: new Set<number>(),
    currentPassMeasuresTouched: new Set<number>(),
    currentPassFaultWeightByMeasure: {},
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

  return {
    ...analytics,
    currentStepHadFaultInPass: true,
    stepStatsByIndex: {
      ...analytics.stepStatsByIndex,
      [step.stepIndex]: nextStats,
    },
    currentPassFaultSteps: nextPassFaultSteps,
    currentPassFaultWeightByMeasure: {
      ...analytics.currentPassFaultWeightByMeasure,
      [step.measureIndex]: (analytics.currentPassFaultWeightByMeasure[step.measureIndex] ?? 0)
        + (faultKind === "early-release" ? 2 : 1),
    },
  };
}

/**
 * Records completion of a `PracticeStep`, evaluates inter-step hesitation latency when
 * timestamps are provided, and updates per-measure accumulated fluency
 * when the score completes or an A-B loop wraps back to start (`passCompleted: true`).
 */
export function recordPracticeStepCompleted(
  analytics: PracticeAnalyticsState,
  options: {
    completedStep?: PracticeStep | null;
    passCompleted?: boolean;
    nowSec?: number;
    speedMultiplier?: number;
    practiceMode?: PracticeMode;
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

  const practiceMode = options.practiceMode ?? "both";
  let measureProgressByMode = analytics.measureProgressByMode;
  if (passCompleted) {
    const progress = { ...measureProgressByMode[practiceMode] };
    for (const mIdx of nextPassMeasuresTouched) {
      const previous = progress[mIdx];
      const hesitated = nextPassHesitationMeasures.has(mIdx);
      const faultWeight = analytics.currentPassFaultWeightByMeasure[mIdx] ?? 0;
      // A smooth clean pass is enough. An isolated pitch slip earns partial credit;
      // a shaky pass earns none but never erases earlier progress.
      const earned = hesitated ? 0 : Math.max(0, FLUENCY_CREDIT_TARGET - faultWeight);
      const fluencyCredit = Math.min(FLUENCY_CREDIT_TARGET, (previous?.fluencyCredit ?? 0) + earned);
      progress[mIdx] = {
        completedPasses: (previous?.completedPasses ?? 0) + 1,
        fluencyCredit,
        fluentSpeed: earned > 0 && fluencyCredit >= FLUENCY_CREDIT_TARGET ? speed : previous?.fluentSpeed,
        lastPassHesitated: hesitated,
      };
    }
    measureProgressByMode = { ...measureProgressByMode, [practiceMode]: progress };
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
    currentPassFaultWeightByMeasure: passCompleted ? {} : analytics.currentPassFaultWeightByMeasure,
    currentPassHesitationMeasures: passCompleted
      ? new Set<number>()
      : nextPassHesitationMeasures,
    measureProgressByMode,
    lastStepCompletedAtSec: passCompleted ? null : (nowSec ?? analytics.lastStepCompletedAtSec),
    lastCompletedStep: passCompleted ? null : (completedStep ?? analytics.lastCompletedStep),
  };
}

/** Aggregates recorded pitch, duration and hesitation faults alongside earned fluency. */
export function buildMeasureErrorSummaries(
  analytics: PracticeAnalyticsState,
  practiceMode: PracticeMode = "both",
): Map<number, MeasureErrorSummary> {
  const progress = analytics.measureProgressByMode[practiceMode];
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

  for (const key of Object.keys(progress)) {
    const mIdx = Number(key);
    if (!byMeasure.has(mIdx)) {
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
    const fluencyCredit = progress[measureIndex]?.fluencyCredit ?? 0;
    const completedPasses = progress[measureIndex]?.completedPasses ?? 0;
    const mastered = fluencyCredit >= FLUENCY_CREDIT_TARGET;

    const status: MeasureMasteryStatus = mastered
      ? "mastered"
      : totalErrors > 0 && fluencyCredit > 0
        ? "recovering"
        : totalErrors > 0 || m.hesitationCount > 0
          ? "trouble"
          : "clean";

    const rawTroubleScore =
      m.maxRecurrentPasses * 3.0 +
      m.pitchErrors * 1.5 +
      m.durationErrors * 1.2 +
      m.faultStepCount;
    const troubleScore = mastered ? 0 : rawTroubleScore * (1 - fluencyCredit * 0.25);

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
      fluencyCredit,
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
 * Fluent measures graduate out of pitch/duration trouble recommendations.
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
  }
): PracticeRepeatRecommendation[] {
  const summaries = buildMeasureErrorSummaries(analytics, options.currentPracticeMode);
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
    let minCredit = Number.POSITIVE_INFINITY;

    for (const m of cluster.measures) {
      pitchErrors += m.pitchErrors;
      durationErrors += m.durationErrors;
      recurrentPasses = Math.max(recurrentPasses, m.recurrentPasses);
      troubleScore += m.troubleScore;
      minCredit = Math.min(minCredit, m.fluencyCredit);
      if (m.dominantHand === "RH") rhWeight += m.totalErrors;
      else if (m.dominantHand === "LH") lhWeight += m.totalErrors;
    }
    const fluencyCredit = Number.isFinite(minCredit) ? minCredit : 0;

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
    if (recurrentPasses >= 2) faultParts.push(`${recurrentPasses} 遍遇到失误`);
    if (fluencyCredit > 0) {
      faultParts.push("已有流畅进展");
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
      prescriptionTips.push(`可开启 ${rangeLabel} A-B 循环重点练习`);
    }

    return {
      id: `rec-${startM}-${endM}`,
      startMeasureIndex: startM,
      endMeasureIndex: endM,
      troubleScore,
      pitchErrors,
      durationErrors,
      recurrentPasses,
      fluencyCredit,
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

/** Suggests optional next steps for the current exercise range. */
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
  }
): PracticeProgressionEvaluation {
  const totalMeasures = Math.max(1, options.measureCount);
  const targetSpeed = options.targetSpeed ?? 1.0;
  const progress = analytics.measureProgressByMode[options.currentPracticeMode];

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
    const practicedMeasures = Object.keys(progress)
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

  let minCredit = Number.POSITIVE_INFINITY;
  let hesitationCount = 0;
  let recentHesitation = false;

  for (let m = startMeasureIndex; m <= endMeasureIndex; m += 1) {
    minCredit = Math.min(minCredit, progress[m]?.fluencyCredit ?? 0);
    if (progress[m]?.lastPassHesitated) {
      recentHesitation = true;
    }
  }

  for (const stat of Object.values(analytics.stepStatsByIndex)) {
    if (stat.measureIndex >= startMeasureIndex && stat.measureIndex <= endMeasureIndex) {
      hesitationCount += stat.hesitationCount;
    }
  }

  const fluencyCredit = Number.isFinite(minCredit) ? minCredit : 0;
  const isFluent = fluencyCredit >= FLUENCY_CREDIT_TARGET;

  const needsBothHands = !options.isSingleStaff && options.currentPracticeMode !== "both";
  const sectionPaceSuggestions: PracticeSectionPaceSuggestion[] = [];
  for (let index = 0; index < totalMeasures; index++) {
    const practicedSpeed = progress[index]?.fluentSpeed;
    if (!practicedSpeed || practicedSpeed >= targetSpeed || progress[index]?.lastPassHesitated) {
      continue;
    }
    const suggestedSpeed = Number(Math.min(targetSpeed, practicedSpeed * 1.1).toFixed(2));
    if (suggestedSpeed <= practicedSpeed) continue;
    const previous = sectionPaceSuggestions.at(-1);
    if (previous?.endMeasureIndex === index - 1 && previous.practicedSpeed === practicedSpeed) {
      previous.endMeasureIndex = index;
    } else {
      sectionPaceSuggestions.push({ startMeasureIndex: index, endMeasureIndex: index, practicedSpeed, suggestedSpeed });
    }
  }
  const activeSectionPace = sectionPaceSuggestions.find((section) =>
    section.startMeasureIndex <= startMeasureIndex && endMeasureIndex <= section.endMeasureIndex
      && section.suggestedSpeed > options.currentSpeed
  );
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

  if (!isFluent) {
    headline = `${rangeLabel} · ${fluencyCredit > 0 ? "渐趋流畅" : "练习中"}`;
    detail = "保持舒适的速度，慢慢连起来；偶尔误触不影响已累积的进展。";
  } else if (needsBothHands) {
    stage = "step-up-hand";
    recommendedNextPracticeMode = "both";
    headline = `${rangeLabel} · 单手已流畅`;
    detail = "可以试试双手合练，切回时会自动补偿 −12% 速度。";
  } else if (activeSectionPace) {
    stage = "step-up-speed";
    recommendedNextSpeedMultiplier = activeSectionPace.suggestedSpeed;
    headline = `${rangeLabel} · 慢速已流畅`;
    detail = `这段可尝试相对提速约 10% 至 ${recommendedNextSpeedMultiplier}x。`;
  } else if (canAdvanceToNextMeasure && nextStartMeasureIndex !== null && nextEndMeasureIndex !== null) {
    stage = "ready-next-measure";
    const nextLabel =
      nextStartMeasureIndex === nextEndMeasureIndex
        ? `第 ${nextStartMeasureIndex + 1} 小节`
        : `第 ${nextStartMeasureIndex + 1}–${nextEndMeasureIndex + 1} 小节`;
    headline = `${rangeLabel} · 已流畅`;
    detail = `可以试试 ${nextLabel}，或练一下小节间的衔接。`;
  } else {
    stage = "piece-mastered";
    headline = `${rangeLabel} · 已流畅`;
    detail = "可以换一段练习，也可以继续享受这一段。";
  }

  if (recentHesitation) {
    detail += " 上一遍有步间犹豫，可放慢速度连一连相邻音符。";
  }

  return {
    startMeasureIndex,
    endMeasureIndex,
    fluencyCredit,
    isFluent,
    hesitationCount,
    recentPassHadHesitation: recentHesitation,
    sectionPaceSuggestions,
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
