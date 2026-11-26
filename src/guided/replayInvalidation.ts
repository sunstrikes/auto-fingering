import type { MotorChunk } from "../chunking/types";
import { diffMeasureIndices } from "../persistence/fingerprint";
import type {
  DerivedSnapshot,
  PieceProfile,
  PracticeEvent,
  PracticeStoragePort,
} from "../persistence/storagePort";
import {
  MOTOR_FSRS_REDUCER_VERSION,
  applyChunkOverridesToLayout,
  computeMaintenanceIntervalDays,
  formatSpanKey,
  reducePiecePracticeState,
  sortPracticeEventsChronologically,
  type MotorFsrsReducerContext,
  type MotorUnitMemoryState,
  type PiecePracticeState,
} from "./motorFsrs";

export const SOFT_INVALIDATION_STABILITY_FACTOR = 0.7;

export interface ScoreProjectionInput {
  currentFingerprint: string;
  currentMeasureHashes: readonly string[];
  measureHashesByFingerprint: Record<string, readonly string[]>;
  performanceDateKey?: string;
  baseMaxIntervalDays?: number;
  targetRetention?: number;
}

/**
 * Applies persisted boundary-delta Split/Merge overrides onto symbolic `MotorChunk`s.
 */
export function applyChunkBoundaryOverrides(
  chunks: readonly MotorChunk[],
  overrides?: PieceProfile["chunkOverrides"],
): MotorChunk[] {
  return applyChunkOverridesToLayout(chunks, overrides);
}

function projectUnitStateForScore(
  unit: MotorUnitMemoryState,
  input: ScoreProjectionInput,
): MotorUnitMemoryState {
  const { currentFingerprint, currentMeasureHashes, measureHashesByFingerprint } = input;
  if (!unit.lastScoreFingerprint || unit.lastScoreFingerprint === currentFingerprint) {
    return unit;
  }
  const baselineHashes = measureHashesByFingerprint[unit.lastScoreFingerprint];
  if (!baselineHashes || baselineHashes.length === 0) {
    return unit;
  }

  const changedIndices = diffMeasureIndices(baselineHashes, currentMeasureHashes);
  if (changedIndices.length === 0) {
    return unit;
  }

  const changedSet = new Set(changedIndices);
  const overlapping = unit.measureIndices.filter((m) => changedSet.has(m));
  if (overlapping.length === 0) {
    return unit;
  }

  const discountedStability = Math.max(
    0.25,
    unit.stabilityDays * SOFT_INVALIDATION_STABILITY_FACTOR,
  );
  const intervalDays = computeMaintenanceIntervalDays(discountedStability, {
    targetRetention: input.targetRetention,
    baseMaxIntervalDays: input.baseMaxIntervalDays,
    currentDateKey: unit.lastSleepGateDateKey ?? undefined,
    performanceDateKey: input.performanceDateKey,
  });

  return {
    ...unit,
    stabilityDays: discountedStability,
    intervalDays,
    needsRevisionReview: true,
    revisionNotice: "谱面已修订，建议低速复核",
    changedMeasureIndices: overlapping,
  };
}

/**
 * Pure projection-time per-measure hash diff soft invalidation.
 * Untouched measures retain 100% stability; Undo back to the original fingerprint
 * losslessly restores 100% original stability without mutating base state or events.
 */
export function projectPieceStateForScore(
  baseState: PiecePracticeState,
  input: ScoreProjectionInput,
): PiecePracticeState {
  const chunkStates: Record<string, MotorUnitMemoryState> = {};
  for (const [id, unit] of Object.entries(baseState.chunkStates)) {
    chunkStates[id] = projectUnitStateForScore(unit, input);
  }

  const junctionStates: Record<string, MotorUnitMemoryState> = {};
  for (const [id, unit] of Object.entries(baseState.junctionStates)) {
    junctionStates[id] = projectUnitStateForScore(unit, input);
  }

  return {
    ...baseState,
    chunkStates,
    junctionStates,
  };
}

/**
 * Stamps a `DerivedSnapshot` record with `MOTOR_FSRS_REDUCER_VERSION` and `lastEventId`.
 */
export function buildDerivedSnapshot(
  pieceId: string,
  state: PiecePracticeState,
): DerivedSnapshot {
  return {
    pieceId,
    reducerVersion: MOTOR_FSRS_REDUCER_VERSION,
    ...(state.lastEventId ? { lastEventId: state.lastEventId } : {}),
    state,
  };
}

function isValidPiecePracticeState(
  value: unknown,
  pieceId: string,
): value is PiecePracticeState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PiecePracticeState>;
  return (
    candidate.reducerVersion === MOTOR_FSRS_REDUCER_VERSION &&
    candidate.pieceId === pieceId &&
    typeof candidate.eventCount === "number" &&
    typeof candidate.bestStableSpeed === "number" &&
    typeof candidate.layoutSignature === "string" &&
    Boolean(candidate.chunkStates) &&
    typeof candidate.chunkStates === "object" &&
    Boolean(candidate.junctionStates) &&
    typeof candidate.junctionStates === "object"
  );
}

/**
 * Reads a cached `derivedSnapshots` entry iff `reducerVersion`, `lastEventId`,
 * and optional `layoutSignature` match.
 */
export async function readValidDerivedSnapshot(
  storage: PracticeStoragePort,
  pieceId: string,
  expectedLastEventId?: string,
  expectedLayoutSignature?: string,
): Promise<PiecePracticeState | undefined> {
  const snap = await storage.get("derivedSnapshots", pieceId);
  if (!snap || snap.reducerVersion !== MOTOR_FSRS_REDUCER_VERSION) return undefined;
  if (expectedLastEventId !== undefined && snap.lastEventId !== expectedLastEventId) {
    return undefined;
  }
  if (!isValidPiecePracticeState(snap.state, pieceId)) return undefined;
  if (
    expectedLayoutSignature !== undefined &&
    snap.state.layoutSignature !== expectedLayoutSignature
  ) {
    return undefined;
  }
  return snap.state;
}

export async function writeDerivedSnapshot(
  storage: PracticeStoragePort,
  pieceId: string,
  state: PiecePracticeState,
): Promise<DerivedSnapshot> {
  const snapshot = buildDerivedSnapshot(pieceId, state);
  await storage.commit({ derivedSnapshots: [snapshot] });
  return snapshot;
}

function computeExpectedLayoutSignature(
  context: MotorFsrsReducerContext,
): string | undefined {
  if (!context.chunks) return undefined;
  const effective = applyChunkOverridesToLayout(context.chunks, context.chunkOverrides);
  return effective
    .map((c) => `${c.chunkId}:${formatSpanKey(c.startCoord, c.endCoord)}`)
    .join("|");
}

/**
 * Loads cached `PiecePracticeState` from `derivedSnapshots` when fresh, or deterministically
 * reduces `practiceEvents` and persists the updated snapshot.
 */
export async function loadOrReducePiecePracticeState(
  storage: PracticeStoragePort,
  pieceId: string,
  context: MotorFsrsReducerContext = {},
): Promise<{ state: PiecePracticeState; fromCache: boolean }> {
  const events: PracticeEvent[] = await storage.listPracticeEvents(pieceId);
  const sorted = sortPracticeEventsChronologically(events);
  const latestEventId = sorted[sorted.length - 1]?.eventId;
  const expectedLayoutSignature = computeExpectedLayoutSignature(context);

  const cached = await readValidDerivedSnapshot(
    storage,
    pieceId,
    latestEventId,
    expectedLayoutSignature,
  );
  if (cached && cached.eventCount === sorted.length) {
    return { state: cached, fromCache: true };
  }

  const reduced = reducePiecePracticeState(sorted, { ...context, pieceId });
  if (sorted.length > 0) {
    await writeDerivedSnapshot(storage, pieceId, reduced);
  }
  return { state: reduced, fromCache: false };
}
