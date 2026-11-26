import type { AnchorOverride, ScoreDocument, SolveResult } from "../domain/types";
import type { MidiInputEvent } from "../midi/webMidi";
import type { MotorGrade, MotorUnitMemoryState } from "./motorFsrs";
import type { ContextualPhase } from "./motorScheduler";
import { PIANO_COMMAND_MIDI } from "./pianoCommandKeys";

export type ScaffoldingLevel = 0 | 1 | 2 | 3;

export type ScaffoldingPreference =
  | "auto-fade"
  | "always-full"
  | "hide-keyboard-early";

export type ScoreFingeringMode = "all" | "high-risk-and-anchors" | "none";

export const SCAFFOLDING_PEEK_DURATION_MS = 1500;

export interface DeriveScaffoldingOptions {
  preference?: ScaffoldingPreference;
  phase?: ContextualPhase;
  useWaitingMode?: boolean;
  lastGrade?: MotorGrade;
  circuitBreakerTriggered?: boolean;
  l3SilentBeatEnabled?: boolean;
  blindOverlayActive?: boolean;
}

export interface ScaffoldingPolicy {
  level: ScaffoldingLevel;
  preference: ScaffoldingPreference;
  scoreFingeringMode: ScoreFingeringMode;
  hideKeyboardTargets: boolean;
  hideHandSkeleton: boolean;
  suppressLiveWrongFlash: boolean;
  hideLiveErrorCounters: boolean;
  cuesObscured: boolean;
  useCountInOnlyMetronome: boolean;
  useRelaxedDriftAttribution: boolean;
  steppedDown: boolean;
}

/**
 * Pure deterministic derivation of `FadingScaffolding` tier (`L0–L3`) directly from
 * `Motor-FSRS` state and current bout context (zero parallel mutable state).
 */
export function deriveScaffoldingLevel(
  unitState: MotorUnitMemoryState | null | undefined,
  options: DeriveScaffoldingOptions = {},
): ScaffoldingLevel {
  const preference = options.preference ?? "auto-fade";

  if (options.useWaitingMode === true) {
    return 0;
  }
  if (options.phase === 0 && options.useWaitingMode !== false) {
    return 0;
  }
  if (!unitState || unitState.reviewCount === 0) {
    return options.useWaitingMode === false ? 1 : 0;
  }

  if (preference === "always-full") {
    return 1;
  }

  const meetsL3 =
    unitState.handStage === "both" &&
    unitState.stableSpeed >= 0.9 &&
    unitState.sleepConsolidatedNights >= 2;
  const meetsL2 =
    options.phase === 2 ||
    (unitState.handStage === "both" &&
      unitState.stableSpeed >= 0.75 &&
      unitState.sleepConsolidatedNights >= 1);

  let level: ScaffoldingLevel = meetsL3 ? 3 : meetsL2 ? 2 : 1;

  const hasAgainOrBreaker =
    unitState.lastEffectiveGrade === 1 ||
    options.lastGrade === 1 ||
    Boolean(options.circuitBreakerTriggered);

  if (hasAgainOrBreaker && level >= 2) {
    level = (level - 1) as ScaffoldingLevel;
  }

  return level;
}

/**
 * Derives full UI & attribution policy for a `ScaffoldingLevel` and user preference.
 */
export function deriveScaffoldingPolicy(
  unitState: MotorUnitMemoryState | null | undefined,
  options: DeriveScaffoldingOptions = {},
): ScaffoldingPolicy {
  const preference = options.preference ?? "auto-fade";
  const level = deriveScaffoldingLevel(unitState, options);

  const rawUnsteppedLevel =
    options.useWaitingMode === true ||
    (options.phase === 0 && options.useWaitingMode !== false) ||
    !unitState ||
    unitState.reviewCount === 0
      ? level
      : unitState.handStage === "both" &&
          unitState.stableSpeed >= 0.9 &&
          unitState.sleepConsolidatedNights >= 2
        ? 3
        : options.phase === 2 ||
            (unitState.handStage === "both" &&
              unitState.stableSpeed >= 0.75 &&
              unitState.sleepConsolidatedNights >= 1)
          ? 2
          : 1;

  const steppedDown = preference !== "always-full" && level < rawUnsteppedLevel;

  const hideKeyboardTargets =
    level >= 2 || (preference === "hide-keyboard-early" && level >= 1);
  const hideHandSkeleton = hideKeyboardTargets;
  const scoreFingeringMode: ScoreFingeringMode =
    level <= 1 ? "all" : level === 2 ? "high-risk-and-anchors" : "none";
  const suppressLiveWrongFlash = level >= 1;
  const hideLiveErrorCounters = level >= 1;
  const cuesObscured =
    level >= 2 || hideKeyboardTargets || Boolean(options.blindOverlayActive);
  const l3Silent = level === 3 && (options.l3SilentBeatEnabled ?? true);

  return {
    level,
    preference,
    scoreFingeringMode,
    hideKeyboardTargets,
    hideHandSkeleton,
    suppressLiveWrongFlash,
    hideLiveErrorCounters,
    cuesObscured,
    useCountInOnlyMetronome: l3Silent,
    useRelaxedDriftAttribution: level === 3,
    steppedDown,
  };
}

/**
 * Extracts `noteUid`s and `measureIndex`es of user `FingerAnchor`s and high-risk
 * `TransitionCue`s (`warn` / `danger`) that remain visible on the score at `L2`.
 */
export function collectL2PreservedFingeringTargets(
  scoreDoc: ScoreDocument | null,
  solveResult: SolveResult | null,
  anchors: Record<string, AnchorOverride>,
  removedRawAnchorUids: readonly string[] = [],
): {
  preservedNoteUids: string[];
  preservedMeasureIndices: number[];
} {
  if (!scoreDoc) {
    return { preservedNoteUids: [], preservedMeasureIndices: [] };
  }

  const noteUidSet = new Set<string>();
  const measureSet = new Set<number>();
  const removedSet = new Set(removedRawAnchorUids);

  for (const ev of scoreDoc.noteEvents) {
    if (ev.isTieStop) continue;
    const isUserAnchor = Boolean(anchors[ev.noteUid]);
    const isPreservedSourceAnchor =
      ev.anchorFinger !== undefined && !removedSet.has(ev.noteUid);
    if (isUserAnchor || isPreservedSourceAnchor) {
      noteUidSet.add(ev.noteUid);
      measureSet.add(ev.measureIndex);
    }
  }

  if (solveResult) {
    const highRiskSliceIds = new Set<string>();
    for (const cue of [...solveResult.transitionCues, ...solveResult.warnings]) {
      if (cue.severity === "warn" || cue.severity === "danger") {
        highRiskSliceIds.add(cue.sliceId);
        measureSet.add(cue.measureIndex);
      }
    }
    if (highRiskSliceIds.size > 0) {
      for (const slice of scoreDoc.onsetSlices) {
        if (!highRiskSliceIds.has(slice.sliceId)) continue;
        for (const note of slice.notes) {
          noteUidSet.add(note.noteUid);
          measureSet.add(note.measureIndex);
        }
      }
    }
  }

  return {
    preservedNoteUids: Array.from(noteUidSet),
    preservedMeasureIndices: Array.from(measureSet).sort((a, b) => a - b),
  };
}

/**
 * Builds a timestamp-matched predicate for `attributeContinuousBout`'s `isExemptPeekKey`
 * so active-play `B0` (`midi === 23`) flash-peek strikes are never counted as `extra` wrong notes.
 */
export function createPeekKeyExemptionPredicate(
  peekTimestampsMs: readonly number[],
  toleranceMs = 2,
): ((event: MidiInputEvent) => boolean) | undefined {
  if (peekTimestampsMs.length === 0) return undefined;
  return (event: MidiInputEvent) => {
    if (event.type === "sustain") return false;
    if (event.midi !== PIANO_COMMAND_MIDI.B0) return false;
    if (event.type === "noteoff") {
      return peekTimestampsMs.some(
        (ts) => event.timeStampMs >= ts - toleranceMs && event.timeStampMs <= ts + 2500,
      );
    }
    return peekTimestampsMs.some((ts) => Math.abs(event.timeStampMs - ts) <= toleranceMs);
  };
}
