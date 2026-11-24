import type { FingeringPrior, PriorMode, PriorTable } from "../prior/types";

export type { FingeringPrior, PriorMode, PriorTable };
export type Hand = "RH" | "LH";
export type Finger = 1 | 2 | 3 | 4 | 5;
export type SpanPreset = "S" | "M" | "L";
export type AnchorOverrideMode = "phrase" | "pinOnly";

export interface AnchorOverride {
  finger: Finger;
  mode: AnchorOverrideMode;
}

export interface HandSpanProfile {
  preset: SpanPreset;
  avoidThumbOnBlack: boolean;
  preferStablePosition: boolean;
}

export const DEFAULT_HAND_SPAN_PROFILE: HandSpanProfile = {
  preset: "M",
  avoidThumbOnBlack: true,
  preferStablePosition: false,
};

export interface NoteEvent {
  noteUid: string;
  measureIndex: number;
  onsetTick: number;
  /** Part-local position, independent of the playback tick grid. */
  scoreCoord?: ScoreCoord;
  durationTick: number;
  onsetSec: number;
  durationSec: number;
  midi: number;
  hand: Hand;
  /** Source staff/part hand before any whole-score hand inference. */
  writtenHand?: Hand;
  voice: string;
  staff: number;
  isGrace: boolean;
  graceOrder?: number;
  isTieStop: boolean;
  isTieStart: boolean;
  isArpeggiated?: boolean;
  tieChainRootUid?: string;
  anchorFinger?: Finger;
  anchorExitFinger?: Finger;
  anchorRawPreserved?: boolean;
  anchorMode?: "phrase" | "pinOnly";
}

export interface PedalInterval {
  startTick: number;
  endTick: number;
  freshPress: boolean;
}

export interface OnsetSlice {
  sliceId: string;
  hand: Hand;
  measureIndex: number;
  onsetTick: number;
  onsetSec: number;
  isGrace: boolean;
  phraseId: number;
  notes: NoteEvent[];
  heldNotes: Array<{
    noteUid: string;
    midi: number;
    endTick: number;
    onsetTick?: number;
    pedalSustained?: boolean;
  }>;
}

export type CueType =
  | "thumb-under"
  | "cross-over"
  | "position-shift"
  | "wide-stretch"
  | "unreachable-span"
  | "anchor-conflict";

export interface TransitionCue {
  sliceId: string;
  hand: Hand;
  measureIndex: number;
  type: CueType;
  severity: "info" | "warn" | "danger";
  cost: number;
  label: string;
}

export interface HandPosition {
  hand: Hand;
  startSliceId: string;
  endSliceId: string;
  thumbKey: number;
  pinkyKey: number;
  minMidi: number;
  maxMidi: number;
}

export interface SolveOptions {
  ignoreExistingFingerings?: boolean;
  /** Precomputed soft prior table (single-pass). */
  prior?: PriorTable | null;
  /** Pluggable FingeringPrior model (runs up to 2 teacher-forced rounds). */
  priorModel?: FingeringPrior | null;
  /** Soft prior strength multiplier `lambda >= 0` (default `0.85`). */
  priorLambda?: number;
  /** Per-note cap on `-logProb` before scaling by `lambda` (default `6.0`). */
  priorPerNoteCap?: number;
}

export type ScoreRepairStrategy =
  | "hand-redistribution"
  | "octave-fold-thin"
  | "arpeggiate"
  | "clip-duration";

export type ScoreRepairIssueKind =
  | "chord-over-octave"
  | "chord-exceeds-5"
  | "held-over-octave";

export type ScoreRepairNoteEdit =
  | {
      kind: "reassign-hand";
      noteUid: string;
      targetHand: Hand;
    }
  | {
      kind: "change-pitch";
      noteUid: string;
      oldMidi: number;
      newMidi: number;
    }
  | {
      kind: "remove-note";
      noteUid: string;
    }
  | {
      kind: "add-arpeggiate";
      noteUid: string;
    }
  | {
      kind: "clip-duration";
      noteUid: string;
      newDurationTick: number;
    };

export interface ScoreRepairOption {
  optionId: string;
  strategy: ScoreRepairStrategy;
  label: string;
  description: string;
  fidelityScore: number;
  previewSummary: string;
  edits: ScoreRepairNoteEdit[];
}

export interface ScoreRepairSuggestion {
  repairId: string;
  measureIndex: number;
  sliceId: string;
  hand: Hand;
  onsetTick: number;
  issueKind: ScoreRepairIssueKind;
  summary: string;
  maxSemitones: number;
  options: ScoreRepairOption[];
}

export type EarlyReleaseReason = "pedal" | "roll" | "kinematic-release" | "unreachable";

export interface HeldNoteRelease {
  releaseSec: number;
  releaseTick?: number;
  reason: EarlyReleaseReason;
}

export interface SolveResult {
  fingerByNoteUid: Record<string, Finger>;
  handPositions: HandPosition[];
  transitionCues: TransitionCue[];
  warnings: TransitionCue[];
  repairedAnchorUids: string[];
  solveTimeMs: number;
  repairSuggestions?: ScoreRepairSuggestion[];
  earlyReleasesByNoteUid?: Record<string, HeldNoteRelease>;
  priorUsed?: boolean;
  priorFallbackReason?: string;
}

export interface TempoPoint {
  tick: number;
  bpm: number;
}

export interface TimeSignaturePoint {
  tick: number;
  beats: number;
  beatType: number;
}

export interface MeasureTimeline {
  measureIndex: number;
  startTick: number;
  endTick: number;
  startSec: number;
  endSec: number;
  timeBeats: number;
  timeBeatType: number;
  isPickup: boolean;
}

export type ExplicitBarlineKind =
  | "regular"
  | "double"
  | "final"
  | "repeat-forward"
  | "repeat-backward"
  | "repeat-both";

export interface ScoreCoord {
  measureIndex: number;
  beatNum: number;
  beatDen: number;
  graceOrder?: number;
}

/** `measureIndex:beatNum/beatDen:graceOrder-or-m:hand:midi:occIdx` */
export type NoteCoordKey = string;

export interface MeasureEnding {
  location: "left" | "middle" | "right";
  numbers: number[];
  type: "start" | "stop" | "discontinue";
}

export interface MeasureStructuralMeta {
  measureIndex: number;
  barlineLeft?: ExplicitBarlineKind;
  barlineRight?: ExplicitBarlineKind;
  endingNumbers?: number[];
  endingType?: MeasureEnding["type"];
  /** All explicit ending markers, including when both endpoints occur in one measure. */
  endings?: MeasureEnding[];
  rehearsalMark?: string;
  keyFifths?: number;
  keyMode?: string;
  hasFermata?: boolean;
  hasTempoChange?: boolean;
  hasTimeSigChange?: boolean;
  isFullMeasureRest?: boolean;
  measureHash?: string;
}

export interface SlurSpan {
  hand: Hand;
  voice: string;
  startCoord: ScoreCoord;
  endCoord: ScoreCoord;
  crossesBarline: boolean;
}

export type ExportFormat = "musicxml" | "mxl";

export interface ScoreDocument {
  title: string;
  xmlDoc: Document;
  xmlDeclaration: string;
  noteElementsByUid: Map<string, Element>;
  originalFingeringByUid?: Map<string, Element>;
  noteEvents: NoteEvent[];
  onsetSlices: OnsetSlice[];
  isSingleStaff: boolean;
  defaultSingleStaffHand: Hand;
  /** The hand actually assigned by the parser, including a workspace override. */
  singleStaffHand?: Hand;
  measureCount: number;
  ticksPerQuarter: number;
  tempoPoints: TempoPoint[];
  timeSignaturePoints: TimeSignaturePoint[];
  measureTimelines: MeasureTimeline[];
  pedalIntervals?: PedalInterval[];
  measureStructuralMeta?: MeasureStructuralMeta[];
  slurSpans?: SlurSpan[];
  /** Immutable baseline captured before the MusicXML writer updates the DOM. */
  sourceFingeringHash?: string;
}

export type PracticeMode = "both" | "rh-only" | "lh-only";

export type WaitingResetReason = "wrong-note" | "early-release" | null;

export interface PracticeStep {
  stepIndex: number;
  onsetTick: number;
  onsetSec: number;
  measureIndex: number;
  isGrace: boolean;
  graceOrder?: number;
  expectedMidis: number[];
  expectedNotes: NoteEvent[];
  accompanimentNotes: NoteEvent[];
  primarySliceId: string | null;
  /**
   * Minimum score-time duration (in seconds at 1.0x speed) among target notes in this step,
   * honoring tie chains when applicable (`0` for grace notes).
   */
  expectedDurationSec: number;
}

export interface WaitingModeState {
  currentStepIndex: number;
  hitMidis: Set<number>;
  wrongMidis: Set<number>;
  /**
   * Keys touched during the current step that are still physically held down.
   * When `tainted` is true, all keys in `activeStepMidis` must be released (`NoteOff`)
   * before a fresh clean attempt on this step is accepted.
   */
  activeStepMidis: Set<number>;
  /**
   * Absolute strictness flag: set to `true` when any wrong note is pressed or when
   * a required target key is released early before completing the step/hold duration.
   */
  tainted: boolean;
  /**
   * Most recent reason the current step was invalidated (`"wrong-note"` | `"early-release"` | `null`).
   */
  lastResetReason: WaitingResetReason;
  /**
   * Whether all `expectedMidis` are currently held cleanly and awaiting hold duration completion.
   */
  isHolding: boolean;
  /**
   * Normalized hold completion progress `[0..1]` while waiting for duration gate.
   */
  holdProgress: number;
  /**
   * Required real-time hold duration in seconds for the active step (`0` when instant).
   */
  requiredHoldSec: number;
  /**
   * Timestamp (in seconds, e.g., `AudioContext.currentTime` or `performance.now() / 1000`)
   * when all expected notes in the current step were cleanly pressed.
   */
  holdStartedAtSec: number | null;
}

export interface AbLoopBounds {
  startMeasureIndex: number;
  endMeasureIndex: number;
  enabled: boolean;
  loopGap: boolean;
}

/**
 * Normalizes `AbLoopBounds` so `0 <= startMeasureIndex <= endMeasureIndex`
 * (and clamps to `measureCount - 1` when `measureCount > 0`).
 */
export function normalizeAbLoopBounds(
  bounds: AbLoopBounds,
  measureCount?: number
): AbLoopBounds {
  const maxMeasure =
    typeof measureCount === "number" && Number.isFinite(measureCount) && measureCount > 0
      ? Math.floor(measureCount) - 1
      : null;

  const clampIndex = (raw: number): number => {
    const floored = Number.isFinite(raw) ? Math.floor(raw) : 0;
    const nonNegative = Math.max(0, floored);
    return maxMeasure !== null ? Math.min(maxMeasure, nonNegative) : nonNegative;
  };

  const a = clampIndex(bounds.startMeasureIndex);
  const b = clampIndex(bounds.endMeasureIndex);

  return {
    startMeasureIndex: Math.min(a, b),
    endMeasureIndex: Math.max(a, b),
    enabled: Boolean(bounds.enabled),
    loopGap: Boolean(bounds.loopGap),
  };
}

export function createDefaultAbLoopBounds(measureCount = 0): AbLoopBounds {
  return {
    startMeasureIndex: 0,
    endMeasureIndex: measureCount > 0 ? Math.max(0, measureCount - 1) : 0,
    enabled: false,
    loopGap: false,
  };
}
