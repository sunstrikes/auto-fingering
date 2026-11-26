import type { AbLoopBounds, AnchorOverride, ExportFormat, Hand, HandSpanProfile, NoteCoordKey, PracticeMode, ScoreCoord } from "../domain/types";

export const DATABASE_NAME = "auto-fingering-studio";
export const SCHEMA_VERSION = 1;
export const GLOBAL_WORKSPACE = "__global__";

export interface PieceProfile {
  pieceId: string;
  title: string;
  fingerprints: string[];
  measureHashesByFingerprint: Record<string, string[]>;
  lastPracticedAtMs?: number;
  archivedAtMs?: number;
  bestStableSpeed?: number;
  chunkOverrides?: {
    addedBoundaries: ScoreCoord[];
    removedBoundaries: ScoreCoord[];
    updatedAtMs: number;
  };
}

export interface PracticeEvent {
  eventId: string;
  pieceId: string;
  scoreFingerprint: string;
  timestampMs: number;
  localDateKey: string;
  timezoneOffsetMin: number;
  sessionId: string;
  boutKind: "chunk" | "bridge" | "cold-probe";
  startCoord: ScoreCoord;
  endCoord: ScoreCoord;
  junctionBoundaryCoord?: ScoreCoord;
  cueCoord?: ScoreCoord;
  practiceMode: PracticeMode;
  speedMultiplier: number;
  durationSec: number;
  passCount: number;
  wasColdFirstPass: boolean;
  scaffoldingLevel: 0 | 1 | 2 | 3;
  ehsLookaheadPreset?: "off" | "1-beat" | "2-beats" | "1-bar";
  autoGrade: 1 | 2 | 3 | 4;
  userGradeOverride?: 2;
  fluency: {
    pitchAccuracy: number;
    interiorHesitationCount: number;
    junctionHesitationRatio: number;
    timingCv: number;
    stallDetected: boolean;
    dominantHandFaultRatio: { rh: number; lh: number };
    switchBranchMismatch: boolean;
    reanchorCount: number;
  };
  acoustic?: {
    timingEvennessStatus: "green" | "amber" | "red";
    timingNormNpvi: number;
    worstTimingMeasure?: number;
    secondaryDimension: "voicing" | "articulation" | "hidden";
    voicingDeltaDb?: number;
    melodyRankDominance?: number;
    articulationKor?: number;
    tertiaryDimension: "pedal" | "hand-sync" | "hidden";
    pedalClarityRate?: number;
    handSyncStatus?: "green" | "amber" | "red";
    bleQuantizationRelaxed?: boolean;
  };
  measureFaultCounts: Record<number, { missed: number; extra: number; hesitations: number }>;
  coachTakeaway?: string;
}

export interface DerivedSnapshot {
  pieceId: string;
  reducerVersion: number;
  lastEventId?: string;
  state: unknown;
}

export interface FingerAnchorDraft {
  pieceId: string;
  anchorsByCoord: Record<NoteCoordKey, AnchorOverride>;
  removedRawCoords: NoteCoordKey[];
  sourceFingeringHash: string;
  updatedAtMs: number;
}

/** A single repair edge; the other endpoint's source lives in evictable scoreBlobs. */
export interface RepairEdge {
  direction: "undo" | "redo";
  otherFingerprint: string;
  /** XML-level key when the other source has the same canonical Score Fingerprint. */
  alternateCacheKey?: string;
  otherDraft: FingerAnchorDraft;
}

export interface WorkspacePrefs {
  scopeKey: string;
  lastOpenedPieceId?: string;
  scoreFingerprint?: string;
  handSpanProfile?: HandSpanProfile;
  speedMultiplier?: number;
  abLoop?: AbLoopBounds;
  practiceMode?: PracticeMode;
  singleStaffHand?: Hand;
  ignoreExistingFingerings?: boolean;
  absoluteStrictnessEnabled?: boolean;
  strictHoldDurationEnabled?: boolean;
  freePracticeMinutes?: number;
  repairEdge?: RepairEdge;
  updatedAtMs?: number;
}

export interface ScoreBlobSource {
  bytes: Uint8Array;
  fileName: string;
  byteLength: number;
  sourceFormat?: ExportFormat;
}

export interface ScoreBlob extends ScoreBlobSource {
  fingerprint: string;
  lastAccessedAtMs: number;
  repairAlternate?: ScoreBlobSource & { cacheKey: string };
}

export type MetaRecord =
  | { key: "schemaVersion" | "lastBackupReminderAtMs"; value: number }
  | { key: "storagePersisted"; value: boolean };

export interface PracticeStorageRecords {
  meta: MetaRecord;
  pieceProfiles: PieceProfile;
  practiceEvents: PracticeEvent;
  derivedSnapshots: DerivedSnapshot;
  fingerAnchorDrafts: FingerAnchorDraft;
  workspacePrefs: WorkspacePrefs;
  scoreBlobs: ScoreBlob;
}

export const storeKeyPaths = {
  meta: "key", pieceProfiles: "pieceId", practiceEvents: "eventId", derivedSnapshots: "pieceId",
  fingerAnchorDrafts: "pieceId", workspacePrefs: "scopeKey", scoreBlobs: "fingerprint",
} as const;
export type PracticeStore = keyof PracticeStorageRecords;
export type PracticeStorageWrite = { [K in PracticeStore]?: readonly PracticeStorageRecords[K][] };

/** Storage-only boundary; no browser-specific types or secret/configuration settings. */
export interface PracticeStoragePort {
  get<K extends PracticeStore>(store: K, key: string): Promise<PracticeStorageRecords[K] | undefined>;
  all<K extends PracticeStore>(store: K): Promise<PracticeStorageRecords[K][]>;
  findPieceProfiles(fingerprint: string): Promise<PieceProfile[]>;
  listPracticeEvents(pieceId: string): Promise<PracticeEvent[]>;
  accessScoreBlob(fingerprint: string): Promise<ScoreBlob | undefined>;
  commit(write: PracticeStorageWrite): Promise<void>;
}

export interface ScoreCacheOptions {
  maxScoreCount?: number;
  maxScoreBytes?: number;
  now?: () => number;
}
