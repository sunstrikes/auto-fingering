import type {
  Hand,
  MeasureStructuralMeta,
  MeasureTimeline,
  NoteEvent,
  OnsetSlice,
  PracticeMode,
  ScoreCoord,
  SlurSpan,
  TempoPoint,
} from "../domain/types";

/**
 * Pure serializable score input for static symbolic chunking (zero XML DOM access).
 */
export interface StaticScoreInput {
  noteEvents: NoteEvent[];
  onsetSlices: OnsetSlice[];
  measureTimelines: MeasureTimeline[];
  ticksPerQuarter: number;
  measureCount: number;
  measureStructuralMeta?: MeasureStructuralMeta[];
  slurSpans?: SlurSpan[];
  tempoPoints?: TempoPoint[];
}

export type MacroBoundaryReason =
  | "start"
  | "double-bar"
  | "repeat"
  | "rehearsal"
  | "key-change"
  | "time-change"
  | "tempo-change"
  | "cadence"
  | "novelty"
  | "length-cap";

/**
 * Top-level formal musical section (typically 4–16 measures).
 */
export interface MacroSection {
  sectionId: string;
  index: number;
  startMeasureIndex: number;
  endMeasureIndex: number;
  startCoord: ScoreCoord;
  endCoord: ScoreCoord;
  measureCount: number;
  label: string;
  boundaryReason: MacroBoundaryReason;
  chunkIds: string[];
}

/**
 * Atomic deliberate-practice unit (1–4 measures, ScoreCoord-anchored, PracticeMode-invariant).
 */
export interface MotorChunk {
  chunkId: string;
  index: number;
  sectionId: string;
  startMeasureIndex: number;
  endMeasureIndex: number;
  startCoord: ScoreCoord;
  endCoord: ScoreCoord;
  measureCount: number;
  stepCount: number;
  densityStepsPerMeasure: number;
  hasAnacrusisLeadIn: boolean;
  anacrusisBeats: number;
  overlapFlag: boolean;
  boundaryConfidence: number;
  userPinned?: boolean;
}

export type VariantDiffKind = "pitch" | "rhythm" | "ornament" | "transposition" | "fingering";

export interface VariantDiffCoord {
  coord: ScoreCoord;
  measureIndex: number;
  kind: VariantDiffKind;
  hand?: Hand;
  noteUid?: string;
  prototypeMidi?: number;
  instanceMidi?: number;
  description: string;
}

/**
 * Divergence point at the end of repeated instances where material branches.
 */
export interface SwitchPoint {
  switchId: string;
  clusterId: string;
  instanceId: string;
  coord: ScoreCoord;
  measureIndex: number;
  priorSharedMeasures: number;
  /** Ordered step-level sorted MIDI pitches of the alternate continuation branch. */
  alternateBranchMidis: number[][];
  alternateBranchLabels: string[];
  description: string;
}

export type PassageVariantKind = "exact" | "transposed" | "ornamented";

export interface PassageInstance {
  instanceId: string;
  clusterId: string;
  startMeasureIndex: number;
  endMeasureIndex: number;
  startCoord: ScoreCoord;
  endCoord: ScoreCoord;
  isPrototype: boolean;
  transpositionSemitones: number;
  musicSimilarity: number;
  fingeringIsomorphism: number;
  motorReuse: number;
  variantKind: PassageVariantKind;
  diffCoords: VariantDiffCoord[];
  switchPoint?: SwitchPoint;
}

/**
 * Group of exact repeats or near-variant passages paired with motor-transfer estimates.
 */
export interface PassageCluster {
  clusterId: string;
  label: string;
  prototypeInstanceId: string;
  instances: PassageInstance[];
  leverageRatio: number;
  totalCoveredMeasures: number;
  switchPoints: SwitchPoint[];
}

export interface BridgeWindowStepRange {
  startStepIndex: number;
  endStepIndex: number;
  junctionStepIndex: number;
}

export interface ChunkJunctionDimensions {
  d1TransitionHazard: number;
  d2PositionLeapVelocity: number;
  d3BimanualCoupling: number;
  d4HeldFingerLoad: number;
  d5SwitchPointInterference: number;
  d6EmpiricalPosterior: number;
}

/**
 * High-load transition boundary between two adjacent Motor Chunks.
 */
export interface ChunkJunction {
  junctionId: string;
  leftChunkId: string;
  rightChunkId: string;
  boundaryCoord: ScoreCoord;
  measureIndex: number;
  bridgeWindowSteps: BridgeWindowStepRange;
  dimensions: ChunkJunctionDimensions;
  priorRisk: number;
  posteriorRisk: number;
  isHighRisk: boolean;
  reasonTags: string[];
  prepCueLabel: string;
}

export type PerformanceCueKind = "switch" | "structural" | "technical" | "expressive";

/**
 * Sparse hierarchical memory-retrieval landmark placed on the score.
 */
export interface PerformanceCue {
  cueId: string;
  kind: PerformanceCueKind;
  roles: PerformanceCueKind[];
  priorityWeight: number;
  coord: ScoreCoord;
  measureIndex: number;
  label: string;
  collapsed: boolean;
  isPrimary: boolean;
  userPinned?: boolean;
  hidden?: boolean;
  customLabel?: string;
  switchPointId?: string;
  junctionId?: string;
  sectionId?: string;
}

export interface StaticChunkingResult {
  measureCount: number;
  macroSections: MacroSection[];
  motorChunks: MotorChunk[];
  passageClusters: PassageCluster[];
  candidateCues: PerformanceCue[];
  staticTimeMs: number;
  degradedToWholeMeasureSsm: boolean;
}

export interface EmpiricalJunctionStat {
  faultCount: number;
  hesitationCount: number;
  attempts: number;
}

export interface MotorOverlayOptions {
  /** Optional empirical hesitation/fault stats keyed by `junctionId` or `measureIndex`. */
  empiricalByJunctionId?: Record<string, EmpiricalJunctionStat>;
}

export interface MotorOverlayResult {
  practiceMode: PracticeMode;
  passageClusters: PassageCluster[];
  chunkJunctions: ChunkJunction[];
  performanceCues: PerformanceCue[];
  overlayTimeMs: number;
}

export interface ChunkAnalysisResult {
  staticResult: StaticChunkingResult;
  motorOverlay: MotorOverlayResult;
}
