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
  tieChainRootUid?: string;
  anchorFinger?: Finger;
  anchorExitFinger?: Finger;
  anchorRawPreserved?: boolean;
  anchorMode?: "phrase" | "pinOnly";
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

export interface SolveResult {
  fingerByNoteUid: Record<string, Finger>;
  handPositions: HandPosition[];
  transitionCues: TransitionCue[];
  warnings: TransitionCue[];
  repairedAnchorUids: string[];
  solveTimeMs: number;
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
}
