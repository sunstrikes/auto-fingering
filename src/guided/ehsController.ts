import type { PracticeStep, ScoreDocument } from "../domain/types";
import type { ScaffoldingLevel } from "./fadingScaffolding";
import type { MotorGrade } from "./motorFsrs";

export type EhsActiveLookaheadPreset = "1-beat" | "2-beats" | "1-bar";
export type EhsLookaheadPreset = "off" | EhsActiveLookaheadPreset;
export type EhsGhostOpacity = 0 | 0.06;

export const EHS_DEFAULT_ENABLED = false;
export const EHS_DEFAULT_PRESET: EhsActiveLookaheadPreset = "2-beats";
export const EHS_DEFAULT_GHOST_OPACITY: EhsGhostOpacity = 0.06;
export const EHS_DEFAULT_AUTO_STALL_FLASH_ENABLED = true;
export const EHS_FLASH_DURATION_MS = 1500;
export const EHS_SPOTLIGHT_BEATS = 1.5;
export const EHS_FADE_WIDTH_BEATS = 0.85;
export const EHS_STALL_CONSECUTIVE_MISSED_STEPS = 2;
export const EHS_PROGRESSION_REQUIRED_PASSES = 2;

export interface EhsConfig {
  enabled: boolean;
  preset: EhsActiveLookaheadPreset;
  ghostOpacity: EhsGhostOpacity;
  autoStallFlashEnabled: boolean;
}

export interface MeasureBeatSpan {
  measureIndex: number;
  startBeat: number;
  beatsInMeasure: number;
  endBeat: number;
  startSec: number;
  endSec: number;
  timeBeats: number;
  timeBeatType: number;
}

export interface EhsFrameSnapshot {
  active: boolean;
  isMasked: boolean;
  isCountIn: boolean;
  handBeat: number;
  handMeasureIndex: number;
  handBeatInMeasure: number;
  lookaheadBeats: number;
  frontierBeat: number;
  frontierMeasureIndex: number;
  spotlightEndBeat: number;
  preset: EhsLookaheadPreset;
  ghostOpacity: EhsGhostOpacity;
  manualPeekActive: boolean;
  autoStallMeasureIndex: number | null;
  autoStallRemainingMs: number;
  consecutiveMissedSteps: number;
  stallFlashCount: number;
  struckNoteUids: ReadonlySet<string>;
}

export interface EhsProgressionState {
  preset: EhsActiveLookaheadPreset;
  consecutiveSmoothPasses: number;
}

export interface EhsProgressionPrompt {
  fromPreset: EhsActiveLookaheadPreset;
  toPreset: EhsActiveLookaheadPreset;
  consecutiveSmoothPasses: number;
  message: string;
}

/**
 * Builds a monotonic continuous beat axis aligned with `MeasureTimeline` and `metronome.ts`.
 */
export function buildMeasureBeatSpans(scoreDoc: ScoreDocument | null): MeasureBeatSpan[] {
  if (!scoreDoc || scoreDoc.measureTimelines.length === 0) return [];
  const tpq = Math.max(1, scoreDoc.ticksPerQuarter || 480);
  const spans: MeasureBeatSpan[] = [];
  let cursorBeat = 0;

  for (const tl of scoreDoc.measureTimelines) {
    const ticksPerBeat = (4 * tpq) / Math.max(1, tl.timeBeatType || 4);
    const rawBeats =
      tl.endTick > tl.startTick ? (tl.endTick - tl.startTick) / ticksPerBeat : tl.timeBeats || 4;
    const beatsInMeasure = Math.max(0.25, Math.round(rawBeats * 1000) / 1000);
    spans.push({
      measureIndex: tl.measureIndex,
      startBeat: cursorBeat,
      beatsInMeasure,
      endBeat: cursorBeat + beatsInMeasure,
      startSec: tl.startSec,
      endSec: Math.max(tl.startSec + 0.05, tl.endSec),
      timeBeats: tl.timeBeats || 4,
      timeBeatType: tl.timeBeatType || 4,
    });
    cursorBeat += beatsInMeasure;
  }

  return spans;
}

/**
 * Converts continuous score time (`scoreSec`) into continuous score beats and measure position.
 */
export function scoreSecToBeat(
  spans: MeasureBeatSpan[],
  scoreSec: number,
): { scoreBeat: number; measureIndex: number; beatInMeasure: number; beatsInMeasure: number } {
  if (spans.length === 0) {
    return { scoreBeat: 0, measureIndex: 0, beatInMeasure: 0, beatsInMeasure: 4 };
  }
  const clampedSec = Math.max(0, scoreSec);

  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    if (clampedSec < sp.endSec || i === spans.length - 1) {
      const dur = Math.max(0.05, sp.endSec - sp.startSec);
      const frac = Math.max(0, Math.min(1, (clampedSec - sp.startSec) / dur));
      const beatInMeasure = frac * sp.beatsInMeasure;
      return {
        scoreBeat: sp.startBeat + beatInMeasure,
        measureIndex: sp.measureIndex,
        beatInMeasure,
        beatsInMeasure: sp.beatsInMeasure,
      };
    }
  }

  const last = spans[spans.length - 1];
  return {
    scoreBeat: last.endBeat,
    measureIndex: last.measureIndex,
    beatInMeasure: last.beatsInMeasure,
    beatsInMeasure: last.beatsInMeasure,
  };
}

/**
 * Converts a continuous score beat back into `{ measureIndex, beatInMeasure, frac, scoreSec, beatsInMeasure }`.
 */
export function beatToMeasurePosition(
  spans: MeasureBeatSpan[],
  scoreBeat: number,
): { measureIndex: number; beatInMeasure: number; frac: number; scoreSec: number; beatsInMeasure: number } {
  if (spans.length === 0) {
    return { measureIndex: 0, beatInMeasure: 0, frac: 0, scoreSec: 0, beatsInMeasure: 4 };
  }
  if (scoreBeat <= 0) {
    const first = spans[0];
    return {
      measureIndex: first.measureIndex,
      beatInMeasure: 0,
      frac: 0,
      scoreSec: first.startSec,
      beatsInMeasure: first.beatsInMeasure,
    };
  }

  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    if (scoreBeat < sp.endBeat || i === spans.length - 1) {
      const beatInMeasure = Math.max(0, Math.min(sp.beatsInMeasure, scoreBeat - sp.startBeat));
      const frac = sp.beatsInMeasure > 0 ? beatInMeasure / sp.beatsInMeasure : 0;
      return {
        measureIndex: sp.measureIndex,
        beatInMeasure,
        frac,
        scoreSec: sp.startSec + frac * (sp.endSec - sp.startSec),
        beatsInMeasure: sp.beatsInMeasure,
      };
    }
  }

  const last = spans[spans.length - 1];
  return {
    measureIndex: last.measureIndex,
    beatInMeasure: last.beatsInMeasure,
    frac: 1,
    scoreSec: last.endSec,
    beatsInMeasure: last.beatsInMeasure,
  };
}

/**
 * Returns fixed lookahead beat count for a preset (`"off" | "1-beat" | "2-beats" | "1-bar"`).
 */
export function getPresetBeats(preset: EhsLookaheadPreset, beatsInMeasure: number): number {
  switch (preset) {
    case "off":
      return 0;
    case "1-beat":
      return 1;
    case "2-beats":
      return 2;
    case "1-bar":
      return Math.max(1, beatsInMeasure || 4);
  }
}

/**
 * Returns true only when FadingScaffolding is L1+ continuous play (never L0 Stage 0).
 */
export function isEhsEligibleLevel(scaffoldingLevel: ScaffoldingLevel): boolean {
  return scaffoldingLevel >= 1;
}

/**
 * Resolves the effective EHS preset for a bout (`"off"` if disabled or in L0 Stage 0).
 */
export function resolveEffectiveEhsPreset(args: {
  enabled: boolean;
  preset: EhsActiveLookaheadPreset;
  scaffoldingLevel: ScaffoldingLevel;
}): EhsLookaheadPreset {
  if (!args.enabled || !isEhsEligibleLevel(args.scaffoldingLevel)) {
    return "off";
  }
  return args.preset;
}

/**
 * Computes per-note EHS opacity in `[ghostOpacity, 1]` using an ease-out quadratic ramp
 * ahead of `frontierBeat`, dissolving passed or MIDI-struck notes to `0` or `0.06` ghost ink.
 */
export function computeEhsNoteOpacity(args: {
  noteScoreBeat: number;
  frontierBeat: number;
  ghostOpacity: EhsGhostOpacity;
  isStruck?: boolean;
  isMasked?: boolean;
  isMeasureFlashed?: boolean;
  fadeWidthBeats?: number;
}): number {
  if (args.isMasked === false || args.isMeasureFlashed === true) {
    return 1;
  }
  if (args.isStruck) {
    return args.ghostOpacity;
  }
  const aheadBeats = args.noteScoreBeat - args.frontierBeat;
  if (aheadBeats <= 0) {
    return args.ghostOpacity;
  }
  const fadeWidth = Math.max(0.05, args.fadeWidthBeats ?? EHS_FADE_WIDTH_BEATS);
  if (aheadBeats < fadeWidth) {
    const t = Math.max(0, Math.min(1, aheadBeats / fadeWidth));
    const eased = 1 - (1 - t) * (1 - t);
    return args.ghostOpacity + (1 - args.ghostOpacity) * eased;
  }
  return 1;
}

/**
 * Returns the next preset tier for bout-to-bout progression (`1-beat -> 2-beats -> 1-bar`),
 * or `null` when already at `"1-bar"`.
 */
export function getNextEhsPreset(
  preset: EhsActiveLookaheadPreset,
): EhsActiveLookaheadPreset | null {
  if (preset === "1-beat") return "2-beats";
  if (preset === "2-beats") return "1-bar";
  return null;
}

const PRESET_LABEL_ZH: Record<EhsActiveLookaheadPreset, string> = {
  "1-beat": "1 拍",
  "2-beats": "2 拍",
  "1-bar": "1 小节",
};

/**
 * Pure bout-to-bout EHS preset progression evaluator: recommends stepping up
 * (`1-beat -> 2-beats -> 1-bar`) after `>= 2` consecutive smooth continuous passes.
 */
export function recordEhsBoutProgression(
  state: EhsProgressionState,
  outcome: {
    ehsActive: boolean;
    autoGrade: MotorGrade;
    pitchAccuracy: number;
    interiorHesitationCount: number;
    stallDetected: boolean;
  },
): { nextState: EhsProgressionState; prompt: EhsProgressionPrompt | null } {
  if (!outcome.ehsActive) {
    return { nextState: state, prompt: null };
  }

  const isSmoothPass =
    outcome.autoGrade >= 3 &&
    outcome.pitchAccuracy >= 0.95 &&
    outcome.interiorHesitationCount === 0 &&
    !outcome.stallDetected;

  if (!isSmoothPass) {
    return {
      nextState: { preset: state.preset, consecutiveSmoothPasses: 0 },
      prompt: null,
    };
  }

  const consecutiveSmoothPasses = state.consecutiveSmoothPasses + 1;
  const nextPreset = getNextEhsPreset(state.preset);
  if (consecutiveSmoothPasses >= EHS_PROGRESSION_REQUIRED_PASSES && nextPreset) {
    return {
      nextState: { preset: state.preset, consecutiveSmoothPasses },
      prompt: {
        fromPreset: state.preset,
        toPreset: nextPreset,
        consecutiveSmoothPasses,
        message: `连续 ${consecutiveSmoothPasses} 遍流畅视奏，可尝试前瞻升档：${PRESET_LABEL_ZH[state.preset]} → ${PRESET_LABEL_ZH[nextPreset]}`,
      },
    };
  }

  return {
    nextState: { preset: state.preset, consecutiveSmoothPasses },
    prompt: null,
  };
}

export interface EhsController {
  resetForBout(args?: { startScoreSec?: number }): void;
  recordMidiNoteOn(args: {
    midi: number;
    nowMs: number;
    scoreSec: number;
    speedMultiplier: number;
    practiceSteps: PracticeStep[];
  }): { matched: boolean; lagMs: number | null };
  triggerAutoStallFlash(measureIndex: number, nowMs: number, durationMs?: number): void;
  tick(args: {
    nowMs: number;
    scoreDoc: ScoreDocument | null;
    scoreSec: number;
    isPlaying: boolean;
    isCountIn?: boolean;
    countdownRemaining?: number;
    speedMultiplier: number;
    practiceSteps: PracticeStep[];
    config: EhsConfig;
    scaffoldingLevel: ScaffoldingLevel;
    manualPeekActive: boolean;
    hasReceivedMidiInBout?: boolean;
  }): EhsFrameSnapshot;
  getLastSnapshot(): EhsFrameSnapshot | null;
}

/**
 * Imperative EHS controller strictly outside React state:
 * tracks MIDI note strikes, strictly fixed per-bout lookahead span, and
 * auto-stall local measure 1.5s flash on `>= 2` consecutive missed steps.
 */
export function createEhsController(): EhsController {
  let boutStartScoreSec = 0;
  let internalHasReceivedMidi = false;
  let struckNoteUids = new Set<string>();
  let matchedStepIndices = new Set<number>();
  let checkedMissStepIndex = -1;
  let consecutiveMissedSteps = 0;
  let stallFlashCount = 0;
  let autoStallMeasureIndex: number | null = null;
  let autoStallUntilMs = 0;

  let cachedDocRef: ScoreDocument | null = null;
  let cachedSpans: MeasureBeatSpan[] = [];
  let lastSnapshot: EhsFrameSnapshot | null = null;

  const getSpans = (doc: ScoreDocument | null): MeasureBeatSpan[] => {
    if (doc !== cachedDocRef) {
      cachedDocRef = doc;
      cachedSpans = buildMeasureBeatSpans(doc);
    }
    return cachedSpans;
  };

  return {
    resetForBout(args) {
      boutStartScoreSec = Math.max(0, args?.startScoreSec ?? 0);
      internalHasReceivedMidi = false;
      struckNoteUids = new Set<string>();
      matchedStepIndices = new Set<number>();
      checkedMissStepIndex = -1;
      consecutiveMissedSteps = 0;
      stallFlashCount = 0;
      autoStallMeasureIndex = null;
      autoStallUntilMs = 0;
      lastSnapshot = null;
    },

    recordMidiNoteOn({ midi, scoreSec, speedMultiplier, practiceSteps }) {
      internalHasReceivedMidi = true;
      const speed = Math.max(0.25, speedMultiplier || 1);
      let bestStep: PracticeStep | null = null;
      let bestAbsDiffMs = Infinity;
      let bestSignedLagMs = 0;

      for (let i = 0; i < practiceSteps.length; i++) {
        const step = practiceSteps[i];
        if (!step.expectedMidis.includes(midi)) continue;
        const nextStep = practiceSteps[i + 1];
        const prevStep = practiceSteps[i - 1];
        const ioiRealMs =
          nextStep && nextStep.onsetSec > step.onsetSec
            ? ((nextStep.onsetSec - step.onsetSec) / speed) * 1000
            : prevStep && step.onsetSec > prevStep.onsetSec
              ? ((step.onsetSec - prevStep.onsetSec) / speed) * 1000
              : 500;

        const wEarly = Math.min(240, Math.max(110, 0.42 * ioiRealMs));
        const wLate = Math.min(340, Math.max(150, 0.52 * ioiRealMs));
        const signedLagMs = ((scoreSec - step.onsetSec) / speed) * 1000;

        if (signedLagMs >= -wEarly && signedLagMs <= wLate) {
          const absDiff = Math.abs(signedLagMs);
          if (absDiff < bestAbsDiffMs) {
            bestAbsDiffMs = absDiff;
            bestSignedLagMs = signedLagMs;
            bestStep = step;
          }
        }
      }

      if (!bestStep) {
        return { matched: false, lagMs: null };
      }

      for (const n of bestStep.expectedNotes) {
        if (n.midi === midi) {
          struckNoteUids.add(n.noteUid);
        }
      }

      if (!matchedStepIndices.has(bestStep.stepIndex)) {
        matchedStepIndices.add(bestStep.stepIndex);
        consecutiveMissedSteps = 0;
      }

      return { matched: true, lagMs: Math.round(bestSignedLagMs) };
    },

    triggerAutoStallFlash(measureIndex, nowMs, durationMs = EHS_FLASH_DURATION_MS) {
      autoStallMeasureIndex = measureIndex;
      autoStallUntilMs = nowMs + Math.max(200, durationMs);
      stallFlashCount += 1;
    },

    tick({
      nowMs,
      scoreDoc,
      scoreSec,
      isPlaying,
      isCountIn = false,
      countdownRemaining = 0,
      speedMultiplier,
      practiceSteps,
      config,
      scaffoldingLevel,
      manualPeekActive,
      hasReceivedMidiInBout,
    }) {
      const effectivePreset = resolveEffectiveEhsPreset({
        enabled: config.enabled,
        preset: config.preset,
        scaffoldingLevel,
      });
      const spans = getSpans(scoreDoc);
      const pos = scoreSecToBeat(spans, scoreSec);

      if (effectivePreset === "off") {
        lastSnapshot = {
          active: false,
          isMasked: false,
          isCountIn,
          handBeat: pos.scoreBeat,
          handMeasureIndex: pos.measureIndex,
          handBeatInMeasure: pos.beatInMeasure,
          lookaheadBeats: 0,
          frontierBeat: pos.scoreBeat,
          frontierMeasureIndex: pos.measureIndex,
          spotlightEndBeat: pos.scoreBeat,
          preset: "off",
          ghostOpacity: config.ghostOpacity,
          manualPeekActive: false,
          autoStallMeasureIndex: null,
          autoStallRemainingMs: 0,
          consecutiveMissedSteps: 0,
          stallFlashCount,
          struckNoteUids,
        };
        return lastSnapshot;
      }

      // Expire active auto-stall local measure flash
      if (autoStallMeasureIndex !== null && nowMs >= autoStallUntilMs) {
        autoStallMeasureIndex = null;
        autoStallUntilMs = 0;
      }

      const midiActive = hasReceivedMidiInBout ?? internalHasReceivedMidi;
      const speed = Math.max(0.25, speedMultiplier || 1);
      if (isPlaying && !isCountIn && midiActive && practiceSteps.length > 0) {
        const missThresholdScoreSec = 0.34 * speed;
        for (let i = Math.max(0, checkedMissStepIndex + 1); i < practiceSteps.length; i++) {
          const step = practiceSteps[i];
          if (step.onsetSec < boutStartScoreSec - 0.05) {
            checkedMissStepIndex = i;
            continue;
          }
          if (step.onsetSec > scoreSec - missThresholdScoreSec) {
            break;
          }
          checkedMissStepIndex = i;
          if (!matchedStepIndices.has(step.stepIndex)) {
            consecutiveMissedSteps += 1;
            if (
              config.autoStallFlashEnabled &&
              consecutiveMissedSteps >= EHS_STALL_CONSECUTIVE_MISSED_STEPS &&
              autoStallMeasureIndex === null
            ) {
              autoStallMeasureIndex = step.measureIndex;
              autoStallUntilMs = nowMs + EHS_FLASH_DURATION_MS;
              stallFlashCount += 1;
              consecutiveMissedSteps = 0;
            }
          }
        }
      }

      const lookaheadBeats = getPresetBeats(effectivePreset, pos.beatsInMeasure);
      const handBeat = isCountIn
        ? pos.scoreBeat - Math.max(0, countdownRemaining)
        : pos.scoreBeat;
      const frontierBeat = handBeat + lookaheadBeats;
      const spotlightEndBeat = frontierBeat + EHS_SPOTLIGHT_BEATS;

      let frontierMeasureIndex = pos.measureIndex;
      for (let i = 0; i < spans.length; i++) {
        if (frontierBeat < spans[i].endBeat || i === spans.length - 1) {
          frontierMeasureIndex = spans[i].measureIndex;
          break;
        }
      }

      const isMasked = !isCountIn && !manualPeekActive;
      const autoStallRemainingMs =
        autoStallMeasureIndex !== null ? Math.max(0, Math.round(autoStallUntilMs - nowMs)) : 0;

      lastSnapshot = {
        active: true,
        isMasked,
        isCountIn,
        handBeat,
        handMeasureIndex: pos.measureIndex,
        handBeatInMeasure: pos.beatInMeasure,
        lookaheadBeats,
        frontierBeat,
        frontierMeasureIndex,
        spotlightEndBeat,
        preset: effectivePreset,
        ghostOpacity: config.ghostOpacity,
        manualPeekActive,
        autoStallMeasureIndex,
        autoStallRemainingMs,
        consecutiveMissedSteps,
        stallFlashCount,
        struckNoteUids,
      };
      return lastSnapshot;
    },

    getLastSnapshot() {
      return lastSnapshot;
    },
  };
}
