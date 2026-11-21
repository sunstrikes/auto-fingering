export interface RawMidiNote {
  pitch: number;
  startTick: number;
  endTick: number;
  durationTick: number;
  velocity: number;
  track: number;
  channel: number;
}

export interface RawMidiTempo {
  tick: number;
  usPerQuarter: number;
  bpm: number;
}

export interface RawMidiTimeSig {
  tick: number;
  numerator: number;
  denominator: number;
}

export interface RawMidiKeySig {
  tick: number;
  fifths: number;
  mode: "major" | "minor";
}

export interface RawMidiPedalEvent {
  tick: number;
  type: "start" | "change" | "stop";
  value: number;
  track: number;
  channel: number;
}

export interface RawMidiData {
  format: number;
  trackCount: number;
  ppq: number;
  trackNames: string[];
  notes: RawMidiNote[];
  tempos: RawMidiTempo[];
  timeSigs: RawMidiTimeSig[];
  keySigs: RawMidiKeySig[];
  pedals: RawMidiPedalEvent[];
}

export type ConversionWarningCode =
  | "MIDI_ONLY_FALLBACK"
  | "SVG_NO_SYSTEMS_FALLBACK"
  | "PNG_PAGE_SKIPPED"
  | "INVALID_SVG_PAGE_SKIPPED"
  | "PREVIEW_TRUNCATED"
  | "MEASURE_COUNT_MISMATCH"
  | "LOW_CONFIDENCE_MEASURE_FALLBACK"
  | "ALIGNMENT_ALTER_OUT_OF_RANGE";

export interface ConversionDiagnostic {
  level: "info" | "warning" | "error";
  code: ConversionWarningCode | (string & {});
  message: string;
  measureNumber?: number;
  pageIndex?: number;
}

export interface ConversionDiagnostics extends Array<ConversionDiagnostic> {
  totalPages: number;
  svgPagesParsed: number;
  pngPagesSkipped: number;
  measuresAligned: number;
  fallbackMeasures: number;
  alignmentConfidence: number;
  warnings: ConversionDiagnostic[];
}

export type SvgPageInput = string | Uint8Array | ArrayBuffer;

export interface ConversionOptions {
  title?: string;
  pickupTicks?: number;
  splitPitch?: number;
  totalPages?: number;
  alignmentConfidenceThreshold?: number;
}

export interface ConversionResult {
  xml: string;
  diagnostics: ConversionDiagnostics;
}

export type NoteTypeName =
  | "maxima"
  | "long"
  | "breve"
  | "whole"
  | "half"
  | "quarter"
  | "eighth"
  | "16th"
  | "32nd"
  | "64th"
  | "128th";

export interface BuildPitch {
  step: "C" | "D" | "E" | "F" | "G" | "A" | "B";
  alter?: number;
  octave: number;
}

export type ArticulationType =
  | "staccato"
  | "accent"
  | "tenuto"
  | "staccatissimo"
  | "strong-accent"
  | "detached-legato";

export interface BuildNote {
  kind: "note" | "rest";
  onsetOffset?: number; // offset from measure start in divisions
  isGrace?: boolean;
  isChord?: boolean;
  pitch?: BuildPitch;
  duration: number;
  voice: string;
  staff: 1 | 2;
  type?: NoteTypeName;
  dots?: number;
  tieStart?: boolean;
  tieStop?: boolean;
  slurStarts?: number[];
  slurStops?: number[];
  slurStart?: boolean;
  slurStop?: boolean;
  slurNumber?: number;
  articulations?: ArticulationType[];
  stem?: "up" | "down";
  fingering?: number;
  arpeggiate?: boolean;
  measureRest?: boolean;
}

export type DynamicMarking =
  | "pppp"
  | "ppp"
  | "pp"
  | "p"
  | "mp"
  | "mf"
  | "f"
  | "ff"
  | "fff"
  | "ffff"
  | "fp"
  | "sf"
  | "sfp"
  | "sfpp"
  | "sfz"
  | "sffz"
  | "fz"
  | "rf"
  | "rfz";

export interface BuildDynamicEvent {
  tickOffset: number;
  kind: DynamicMarking;
  staff: 1 | 2;
}

export interface BuildWedgeEvent {
  tickOffset: number; // offset from measure start in divisions
  type: "crescendo" | "diminuendo" | "stop";
  number?: number;
  staff?: 1 | 2;
}

export interface BuildPedalEvent {
  tickOffset: number; // offset from measure start in divisions
  type: "start" | "change" | "stop";
  staff?: 1 | 2;
}

export interface BuildTempoEvent {
  tickOffset: number; // offset from measure start in divisions
  bpm: number;
}

export interface BuildAttributes {
  divisions?: number;
  fifths?: number;
  mode?: "major" | "minor";
  beats?: number;
  beatType?: number;
  staves?: number;
}

export interface BuildMeasure {
  number: string;
  implicit?: boolean;
  duration: number; // total measure duration in divisions
  attributes?: BuildAttributes;
  tempos?: BuildTempoEvent[];
  pedals?: BuildPedalEvent[];
  dynamics?: BuildDynamicEvent[];
  wedges?: BuildWedgeEvent[];
  notes: BuildNote[];
}

export interface ScoreBuildModel {
  title: string;
  divisions: number;
  staves: 1 | 2;
  measures: BuildMeasure[];
}
