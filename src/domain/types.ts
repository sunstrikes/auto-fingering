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
  durationTick: number;
  onsetSec: number;
  durationSec: number;
  midi: number;
  hand: Hand;
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
  measureCount: number;
  ticksPerQuarter: number;
  tempoPoints: TempoPoint[];
  timeSignaturePoints: TimeSignaturePoint[];
  measureTimelines: MeasureTimeline[];
  pedalIntervals?: PedalInterval[];
}

export type PracticeMode = "both" | "rh-only" | "lh-only";

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
}

export interface WaitingModeState {
  currentStepIndex: number;
  hitMidis: Set<number>;
  wrongMidis: Set<number>;
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
