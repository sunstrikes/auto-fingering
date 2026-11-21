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

export interface ConversionDiagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  measureNumber?: number;
}

export interface ConversionOptions {
  title?: string;
  pickupTicks?: number;
  splitPitch?: number;
}

export interface ConversionResult {
  xml: string;
  diagnostics: ConversionDiagnostic[];
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
  stem?: "up" | "down";
  fingering?: number;
  arpeggiate?: boolean;
  measureRest?: boolean;
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
  notes: BuildNote[];
}

export interface ScoreBuildModel {
  title: string;
  divisions: number;
  staves: 1 | 2;
  measures: BuildMeasure[];
}
