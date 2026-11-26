import type { ChunkJunction, MotorChunk } from "../chunking/types";
import type { PracticeMode, ScoreCoord } from "../domain/types";
import type { PieceProfile, PracticeEvent } from "../persistence/storagePort";

export const MOTOR_FSRS_REDUCER_VERSION = 1;

export const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_INTERVAL_DAYS = 28;
export const MIN_MAINTENANCE_CAP_DAYS = 21;
export const MAX_MAINTENANCE_CAP_DAYS = 30;
export const DEFAULT_TARGET_RETENTION = 0.9;
export const MIN_STABLE_SPEED = 0.5;
export const MAX_STABLE_SPEED = 1.05;

/**
 * Standard FSRS-6 default 21 parameters (w[20] = 0.1542 power-law decay exponent).
 * Initial stabilities w[0..3] are overridden with conservative motor stabilities below.
 */
export const FSRS6_DEFAULT_WEIGHTS = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
  1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
] as const;

/** Conservative motor initial stabilities (days), preventing Day-1 8-day jumps. */
export const MOTOR_INITIAL_STABILITY_DAYS: Record<1 | 2 | 3 | 4, number> = {
  1: 0.5, // Again: same-day re-queue + next-day check
  2: 1.0, // Hard: 1 night validation
  3: 1.5, // Good: 1.5 days (overrides language default 2.31 d)
  4: 3.0, // Easy (strictly Both Hands + >=0.85x): 3.0 days (overrides 8.30 d)
};

export type MotorGrade = 1 | 2 | 3 | 4;
export type UserGradeOverrideInput = 2 | "hard";

export interface AutoMidiGradeInput {
  practiceMode: PracticeMode;
  speedMultiplier: number;
  fluency: PracticeEvent["fluency"];
  measureFaultCounts: PracticeEvent["measureFaultCounts"];
}

export interface MaintenanceIntervalOptions {
  targetRetention?: number;
  baseMaxIntervalDays?: number;
  currentDateKey?: string;
  performanceDateKey?: string;
}

export interface MotorUnitMemoryState {
  unitId: string;
  unitKind: "chunk" | "junction";
  startCoord: ScoreCoord;
  endCoord: ScoreCoord;
  boundaryCoord?: ScoreCoord;
  measureIndices: number[];
  handStage: PracticeMode;
  stableSpeed: number;
  targetSpeed: number;
  difficulty: number;
  stabilityDays: number;
  retrievability: number;
  intervalDays: number;
  nextReviewDateKey?: string;
  lastReviewedAtMs: number | null;
  lastEventTimestampMs: number | null;
  lastSleepUpdateTimestampMs: number | null;
  lastSleepGateDateKey: string | null;
  lastScoreFingerprint?: string;
  lastEffectiveGrade?: MotorGrade;
  lastAccuracy?: number;
  lastInteriorHesitations?: number;
  lastJunctionHesitationRatio?: number;
  lastTimingCv?: number | null;
  sleepConsolidatedNights: number;
  consecutiveAgainDays: number;
  lastAgainDateKey?: string;
  reviewCount: number;
  inheritedFromSplit?: boolean;
  pendingInternalJunctionVerify?: boolean;
  internalJunctionCoords?: ScoreCoord[];
  needsRevisionReview?: boolean;
  revisionNotice?: string;
  changedMeasureIndices?: number[];
  isHighRiskJunction?: boolean;
}

export interface PiecePracticeState {
  reducerVersion: number;
  pieceId: string;
  lastEventId?: string;
  eventCount: number;
  bestStableSpeed: number;
  lastPracticedAtMs?: number;
  layoutSignature: string;
  chunkStates: Record<string, MotorUnitMemoryState>;
  junctionStates: Record<string, MotorUnitMemoryState>;
}

export interface MotorFsrsReducerContext {
  pieceId?: string;
  chunks?: readonly MotorChunk[];
  junctions?: readonly ChunkJunction[];
  chunkOverrides?: PieceProfile["chunkOverrides"];
  nowTimestampMs?: number;
  nowLocalDateKey?: string;
  performanceDateKey?: string;
  baseMaxIntervalDays?: number;
  targetRetention?: number;
  targetSpeed?: number;
}

const FSRS_DECAY = FSRS6_DEFAULT_WEIGHTS[20];
const FSRS_FACTOR = Math.pow(0.9, -1 / FSRS_DECAY) - 1;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function roundSpeed(speed: number): number {
  return Math.round(speed * 100) / 100;
}

/**
 * Compares two `<divisions>`-invariant ScoreCoords chronologically.
 */
export function compareScoreCoord(a: ScoreCoord, b: ScoreCoord): number {
  if (a.measureIndex !== b.measureIndex) return a.measureIndex - b.measureIndex;
  const beatDiff = a.beatNum * b.beatDen - b.beatNum * a.beatDen;
  if (beatDiff !== 0) return beatDiff;
  return (a.graceOrder ?? 0) - (b.graceOrder ?? 0);
}

export function sameScoreCoord(a: ScoreCoord, b: ScoreCoord): boolean {
  return compareScoreCoord(a, b) === 0;
}

export function formatScoreCoordKey(c: ScoreCoord): string {
  const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
  const d = c.beatDen > 0 ? c.beatDen : 1;
  const g = gcd(Math.abs(c.beatNum), d) || 1;
  const num = c.beatNum / g;
  const den = d / g;
  return `${c.measureIndex}:${num}/${den}${c.graceOrder !== undefined ? `:g${c.graceOrder}` : ""}`;
}

export function formatSpanKey(start: ScoreCoord, end: ScoreCoord): string {
  return `${formatScoreCoordKey(start)}..${formatScoreCoordKey(end)}`;
}

/**
 * Checks whether half-open (or point) span A overlaps span B.
 */
export function spansOverlap(
  aStart: ScoreCoord,
  aEnd: ScoreCoord,
  bStart: ScoreCoord,
  bEnd: ScoreCoord,
): boolean {
  const aIsPoint = compareScoreCoord(aStart, aEnd) >= 0;
  const bIsPoint = compareScoreCoord(bStart, bEnd) >= 0;
  if (aIsPoint && bIsPoint) return sameScoreCoord(aStart, bStart);
  if (aIsPoint) {
    return compareScoreCoord(bStart, aStart) <= 0 && compareScoreCoord(aStart, bEnd) < 0;
  }
  if (bIsPoint) {
    return compareScoreCoord(aStart, bStart) <= 0 && compareScoreCoord(bStart, aEnd) < 0;
  }
  return compareScoreCoord(aStart, bEnd) < 0 && compareScoreCoord(bStart, aEnd) < 0;
}

/**
 * True when outer span covers inner span (`outerStart <= innerStart && innerEnd <= outerEnd`).
 */
export function spanContains(
  outerStart: ScoreCoord,
  outerEnd: ScoreCoord,
  innerStart: ScoreCoord,
  innerEnd: ScoreCoord,
): boolean {
  const outerEffectiveEnd = compareScoreCoord(outerStart, outerEnd) >= 0
    ? { measureIndex: outerStart.measureIndex + 1, beatNum: 0, beatDen: 1 }
    : outerEnd;
  const innerEffectiveEnd = compareScoreCoord(innerStart, innerEnd) >= 0
    ? { measureIndex: innerStart.measureIndex + 1, beatNum: 0, beatDen: 1 }
    : innerEnd;
  return (
    compareScoreCoord(outerStart, innerStart) <= 0 &&
    compareScoreCoord(innerEffectiveEnd, outerEffectiveEnd) <= 0
  );
}

/**
 * Extracts 0-based measure indices covered by `[start, end]`.
 */
export function getSpanMeasureIndices(start: ScoreCoord, end: ScoreCoord): number[] {
  const startM = Math.max(0, start.measureIndex);
  let endM = end.measureIndex;
  if (compareScoreCoord(start, end) < 0 && end.beatNum === 0 && end.measureIndex > startM) {
    endM = end.measureIndex - 1;
  }
  if (endM < startM) endM = startM;
  const indices: number[] = [];
  for (let m = startM; m <= endM; m++) {
    indices.push(m);
  }
  return indices;
}

export function parseLocalDateKeyMs(dateKey: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  return Date.UTC(y, m - 1, d);
}

export function diffLocalDateDays(fromDateKey: string, toDateKey: string): number {
  const a = parseLocalDateKeyMs(fromDateKey);
  const b = parseLocalDateKeyMs(toDateKey);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / MS_PER_DAY);
}

export function addDaysToDateKey(dateKey: string, days: number): string | undefined {
  const base = parseLocalDateKeyMs(dateKey);
  if (base === null) return undefined;
  const target = new Date(base + Math.round(days) * MS_PER_DAY);
  const y = target.getUTCFullYear();
  const m = String(target.getUTCMonth() + 1).padStart(2, "0");
  const d = String(target.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function timestampToUtcDateKey(timestampMs: number, timezoneOffsetMin = 0): string {
  const shifted = new Date(timestampMs - timezoneOffsetMin * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * FSRS-6 power-law forgetting curve: `R(t, S) = (1 + factor * t / S)^(-w20)`.
 */
export function computeFsrsRetrievability(elapsedDays: number, stabilityDays: number): number {
  if (elapsedDays <= 0) return 1;
  if (stabilityDays <= 0) return 0;
  const r = Math.pow(1 + FSRS_FACTOR * (elapsedDays / stabilityDays), -FSRS_DECAY);
  return clamp(r, 0, 1);
}

/**
 * Computes next review interval in days, capped to `[21..30]` maintenance ceiling
 * and tightened when an optional `performanceDateKey` approaches.
 */
export function computeMaintenanceIntervalDays(
  stabilityDays: number,
  options: MaintenanceIntervalOptions = {},
): number {
  const targetRetention = clamp(options.targetRetention ?? DEFAULT_TARGET_RETENTION, 0.7, 0.98);
  const baseCap = clamp(
    options.baseMaxIntervalDays ?? DEFAULT_MAX_INTERVAL_DAYS,
    MIN_MAINTENANCE_CAP_DAYS,
    MAX_MAINTENANCE_CAP_DAYS,
  );
  let effectiveCap = baseCap;
  if (options.performanceDateKey && options.currentDateKey) {
    const daysUntil = diffLocalDateDays(options.currentDateKey, options.performanceDateKey);
    if (daysUntil <= 1) {
      effectiveCap = 1;
    } else {
      effectiveCap = Math.min(baseCap, Math.max(1, Math.floor(daysUntil * 0.8)));
    }
  }
  if (stabilityDays <= 0) return 0;
  const raw = (stabilityDays / FSRS_FACTOR) * (Math.pow(targetRetention, -1 / FSRS_DECAY) - 1);
  return clamp(Math.round(raw * 100) / 100, 0.5, effectiveCap);
}

function initialDifficulty(grade: MotorGrade): number {
  const w4 = FSRS6_DEFAULT_WEIGHTS[4];
  const w5 = FSRS6_DEFAULT_WEIGHTS[5];
  return clamp(w4 - Math.exp(w5 * (grade - 1)) + 1, 1, 10);
}

function nextDifficulty(difficulty: number, grade: MotorGrade): number {
  const w6 = FSRS6_DEFAULT_WEIGHTS[6];
  const w7 = FSRS6_DEFAULT_WEIGHTS[7];
  const delta = -w6 * (grade - 3);
  const damped = difficulty + (delta * (10 - difficulty)) / 9;
  const reverted = w7 * initialDifficulty(4) + (1 - w7) * damped;
  return clamp(reverted, 1, 10);
}

function nextStabilitySuccess(
  difficulty: number,
  stabilityDays: number,
  retrievability: number,
  grade: 2 | 3 | 4,
): number {
  const w = FSRS6_DEFAULT_WEIGHTS;
  const hb = grade === 2 ? w[15] : grade === 4 ? w[16] : 1;
  const growth =
    1 +
    Math.exp(w[8]) *
      (11 - difficulty) *
      Math.pow(Math.max(0.1, stabilityDays), -w[9]) *
      (Math.exp(w[10] * (1 - retrievability)) - 1) *
      hb;
  return Math.max(stabilityDays, stabilityDays * growth);
}

function nextStabilityLapse(
  difficulty: number,
  stabilityDays: number,
  retrievability: number,
): number {
  const w = FSRS6_DEFAULT_WEIGHTS;
  const candidate =
    w[11] *
    Math.pow(difficulty, -w[12]) *
    (Math.pow(stabilityDays + 1, w[13]) - 1) *
    Math.exp(w[14] * (1 - retrievability));
  const cap = stabilityDays * Math.exp(w[17] * w[18]);
  return clamp(Math.min(candidate, cap, stabilityDays), 0.25, stabilityDays);
}

/**
 * Normalizes persisted or UI grade overrides (`"hard"` -> `2`).
 */
export function normalizeUserGradeOverride(override?: UserGradeOverrideInput): 2 | undefined {
  if (override === 2 || override === "hard") return 2;
  return undefined;
}

/**
 * Automatic MIDI grading strictly gating `Easy` on `Both Hands` + `>= 0.85x` + 0 faults/hesitations.
 */
export function computeAutoMidiGrade(input: AutoMidiGradeInput): MotorGrade {
  const { practiceMode, speedMultiplier, fluency, measureFaultCounts } = input;
  if (fluency.pitchAccuracy < 0.85 || fluency.stallDetected || fluency.switchBranchMismatch) {
    return 1;
  }

  let totalFaults = 0;
  let totalMeasureHesitations = 0;
  for (const counts of Object.values(measureFaultCounts)) {
    totalFaults += counts.missed + counts.extra + counts.hesitations;
    totalMeasureHesitations += counts.hesitations;
  }

  const hasHesitation =
    fluency.interiorHesitationCount > 0 ||
    fluency.junctionHesitationRatio > 1.6 ||
    totalMeasureHesitations > 0;

  if (fluency.pitchAccuracy < 0.95 || hasHesitation) {
    return 2;
  }

  if (
    practiceMode === "both" &&
    speedMultiplier >= 0.85 &&
    fluency.pitchAccuracy === 1 &&
    totalFaults === 0
  ) {
    return 4;
  }

  return 3;
}

export function resolveEffectiveGrade(event: PracticeEvent): MotorGrade {
  const baseGrade: MotorGrade = event.autoGrade ?? computeAutoMidiGrade(event);
  const override = normalizeUserGradeOverride(event.userGradeOverride);
  if (override === 2) {
    return (baseGrade === 1 ? 1 : 2) as MotorGrade;
  }
  return baseGrade;
}

/**
 * Zoned relative sub-maximal speed ladder step-up (`+12-15%` decoding, `+8-10%` core, `+5%` sprint).
 */
export function computeNextSpeedStep(stableSpeed: number, targetSpeed = 1.0): number {
  if (stableSpeed >= targetSpeed) return targetSpeed;
  const factor = stableSpeed < 0.65 ? 1.13 : stableSpeed < 0.85 ? 1.09 : 1.05;
  return Math.min(targetSpeed, roundSpeed(stableSpeed * factor));
}

export function stepDownSpeedTenPercent(stableSpeed: number): number {
  const floor = stableSpeed < MIN_STABLE_SPEED ? Math.max(0.45, stableSpeed) : MIN_STABLE_SPEED;
  return Math.max(floor, roundSpeed(stableSpeed * 0.9));
}

export function sortPracticeEventsChronologically(
  events: readonly PracticeEvent[],
): PracticeEvent[] {
  return [...events].sort(
    (a, b) =>
      a.timestampMs - b.timestampMs ||
      (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
  );
}

export function createEmptyUnitState(params: {
  unitId: string;
  unitKind: "chunk" | "junction";
  startCoord: ScoreCoord;
  endCoord: ScoreCoord;
  boundaryCoord?: ScoreCoord;
  measureIndices: number[];
  targetSpeed: number;
  isHighRiskJunction?: boolean;
}): MotorUnitMemoryState {
  return {
    unitId: params.unitId,
    unitKind: params.unitKind,
    startCoord: params.startCoord,
    endCoord: params.endCoord,
    ...(params.boundaryCoord ? { boundaryCoord: params.boundaryCoord } : {}),
    measureIndices: [...params.measureIndices],
    handStage: "both",
    stableSpeed: 0.55,
    targetSpeed: params.targetSpeed,
    difficulty: initialDifficulty(3),
    stabilityDays: 0,
    retrievability: 1,
    intervalDays: 0,
    lastReviewedAtMs: null,
    lastEventTimestampMs: null,
    lastSleepUpdateTimestampMs: null,
    lastSleepGateDateKey: null,
    sleepConsolidatedNights: 0,
    consecutiveAgainDays: 0,
    reviewCount: 0,
    ...(params.isHighRiskJunction ? { isHighRiskJunction: true } : {}),
  };
}

/**
 * Applies a single chronological `PracticeEvent` onto an existing `MotorUnitMemoryState`
 * using the strict sleep-gate, upgrade discount, and speed-step-down rules.
 */
export function applyEventToUnitState(
  prev: MotorUnitMemoryState,
  event: PracticeEvent,
): MotorUnitMemoryState {
  const next: MotorUnitMemoryState = {
    ...prev,
    measureIndices: [...prev.measureIndices],
    ...(prev.internalJunctionCoords
      ? { internalJunctionCoords: [...prev.internalJunctionCoords] }
      : {}),
  };
  const grade = resolveEffectiveGrade(event);
  next.lastEffectiveGrade = grade;
  next.lastAccuracy = event.fluency.pitchAccuracy;
  next.lastInteriorHesitations = event.fluency.interiorHesitationCount;
  next.lastJunctionHesitationRatio = event.fluency.junctionHesitationRatio;
  next.lastTimingCv = event.fluency.timingCv;
  next.lastScoreFingerprint = event.scoreFingerprint;
  next.lastReviewedAtMs = event.timestampMs;
  next.reviewCount += 1;

  // First practice event initializes conservative Day-0 motor stability without inflating S.
  if (prev.reviewCount === 0 && prev.stabilityDays === 0) {
    next.handStage = event.practiceMode;
    next.stableSpeed = event.speedMultiplier;
    next.difficulty = initialDifficulty(grade);
    // Easy initial stability requires Both Hands + >=0.85x; otherwise cap at Good (1.5d)
    const initialGrade: MotorGrade =
      grade === 4 && (event.practiceMode !== "both" || event.speedMultiplier < 0.85) ? 3 : grade;
    next.stabilityDays = MOTOR_INITIAL_STABILITY_DAYS[initialGrade];
    next.sleepConsolidatedNights = 0;
    next.consecutiveAgainDays = grade === 1 ? 1 : 0;
    if (grade === 1) next.lastAgainDateKey = event.localDateKey;
    next.lastEventTimestampMs = event.timestampMs;
    next.lastSleepUpdateTimestampMs = event.timestampMs;
    next.lastSleepGateDateKey = event.localDateKey;
    return next;
  }

  // Hand-stage upgrade: single-hand -> Both Hands preserves D, discounts S, resets nights.
  const isHandStageUpgrade = prev.handStage !== "both" && event.practiceMode === "both";
  if (isHandStageUpgrade) {
    next.handStage = "both";
    next.stableSpeed = event.speedMultiplier;
    next.stabilityDays = Math.min(prev.stabilityDays * 0.5, 2.0);
    next.sleepConsolidatedNights = 0;
    next.consecutiveAgainDays = 0;
    next.lastEventTimestampMs = event.timestampMs;
    next.lastSleepUpdateTimestampMs = event.timestampMs;
    next.lastSleepGateDateKey = event.localDateKey;
    return next;
  }

  // Anti-entrenchment: manual single-hand sessions on an already-bimanual chunk
  // must not advance Both Hands stableSpeed, sleepConsolidatedNights, or Easy eligibility.
  if (prev.handStage === "both" && event.practiceMode !== "both") {
    next.lastEventTimestampMs = event.timestampMs;
    return next;
  }

  // Speed upgrade (successful pass at higher speed): preserves D, discounts S, resets nights.
  const isSpeedUpgrade =
    grade >= 3 &&
    event.speedMultiplier > prev.stableSpeed + 1e-4 &&
    event.practiceMode === prev.handStage;
  if (isSpeedUpgrade) {
    next.stableSpeed = Math.min(MAX_STABLE_SPEED, event.speedMultiplier);
    next.stabilityDays = Math.min(prev.stabilityDays * 0.5, 2.0);
    next.sleepConsolidatedNights = 0;
    next.consecutiveAgainDays = 0;
    next.lastEventTimestampMs = event.timestampMs;
    next.lastSleepUpdateTimestampMs = event.timestampMs;
    next.lastSleepGateDateKey = event.localDateKey;
    return next;
  }

  // Strict sleep gate: calendar day changed AND >= 8h since previous event AND Cold First-Pass Probe.
  const calendarDayChanged =
    prev.lastSleepGateDateKey !== null &&
    event.localDateKey > prev.lastSleepGateDateKey &&
    diffLocalDateDays(prev.lastSleepGateDateKey, event.localDateKey) >= 1;
  const elapsedSinceLastEventMs =
    prev.lastEventTimestampMs !== null ? event.timestampMs - prev.lastEventTimestampMs : 0;
  const sleepBoundaryCrossed = calendarDayChanged && elapsedSinceLastEventMs >= EIGHT_HOURS_MS;

  if (sleepBoundaryCrossed && event.wasColdFirstPass) {
    const anchorMs = prev.lastSleepUpdateTimestampMs ?? prev.lastEventTimestampMs ?? event.timestampMs;
    const elapsedDays = Math.max(0, (event.timestampMs - anchorMs) / MS_PER_DAY);
    const retrievabilityAtProbe = computeFsrsRetrievability(elapsedDays, prev.stabilityDays);

    next.difficulty = nextDifficulty(prev.difficulty, grade);

    if (grade === 1) {
      next.stabilityDays = nextStabilityLapse(prev.difficulty, prev.stabilityDays, retrievabilityAtProbe);
      next.sleepConsolidatedNights = 0;

      const againDayChanged = prev.lastAgainDateKey !== event.localDateKey;
      const nextAgainDays = againDayChanged ? prev.consecutiveAgainDays + 1 : prev.consecutiveAgainDays;
      const deepDecayCollapse =
        retrievabilityAtProbe < 0.6 && event.fluency.pitchAccuracy < 0.75;

      if (nextAgainDays >= 2 || deepDecayCollapse) {
        next.stableSpeed = stepDownSpeedTenPercent(prev.stableSpeed);
        next.consecutiveAgainDays = 0;
        next.lastAgainDateKey = undefined;
      } else {
        next.consecutiveAgainDays = nextAgainDays;
        next.lastAgainDateKey = event.localDateKey;
      }
    } else {
      const effectiveGrade: 2 | 3 | 4 =
        grade === 4 && (event.practiceMode !== "both" || prev.stableSpeed < 0.85) ? 3 : grade;
      next.stabilityDays = nextStabilitySuccess(
        prev.difficulty,
        prev.stabilityDays,
        retrievabilityAtProbe,
        effectiveGrade,
      );
      next.consecutiveAgainDays = 0;
      next.lastAgainDateKey = undefined;
      if (effectiveGrade >= 3 && next.handStage === "both") {
        next.sleepConsolidatedNights = prev.sleepConsolidatedNights + 1;
      }
    }

    next.lastSleepGateDateKey = event.localDateKey;
    next.lastSleepUpdateTimestampMs = event.timestampMs;
  }

  next.lastEventTimestampMs = event.timestampMs;
  return next;
}

/**
 * Computes conservative Split discount (`0.80x` base, weighted downward by per-measure faults).
 */
export function applySplitDiscountToUnitState(
  parentState: MotorUnitMemoryState,
  childChunk: Pick<MotorChunk, "chunkId" | "startCoord" | "endCoord">,
  faultsByMeasure: ReadonlyMap<number, number>,
): MotorUnitMemoryState {
  const parentMeasures = getSpanMeasureIndices(parentState.startCoord, parentState.endCoord);
  const childMeasures = getSpanMeasureIndices(childChunk.startCoord, childChunk.endCoord);
  let totalFaults = 0;
  for (const m of parentMeasures) {
    totalFaults += faultsByMeasure.get(m) ?? 0;
  }
  let childFaults = 0;
  for (const m of childMeasures) {
    childFaults += faultsByMeasure.get(m) ?? 0;
  }
  const faultRatio = totalFaults > 0 ? clamp(childFaults / totalFaults, 0, 1) : 0;
  const discountFactor = 0.8 * (1 - 0.35 * faultRatio);

  return {
    ...parentState,
    unitId: childChunk.chunkId,
    unitKind: "chunk",
    startCoord: childChunk.startCoord,
    endCoord: childChunk.endCoord,
    measureIndices: childMeasures,
    stabilityDays: Math.max(0.25, parentState.stabilityDays * discountFactor),
    inheritedFromSplit: true,
  };
}

/**
 * Computes Merge state by taking bottleneck `min(stabilityDays)` & `min(stableSpeed)`
 * and flagging internal merged seams for verification.
 */
export function mergeSubUnitStates(
  targetChunk: Pick<MotorChunk, "chunkId" | "startCoord" | "endCoord">,
  subStates: readonly MotorUnitMemoryState[],
): MotorUnitMemoryState {
  const measures = getSpanMeasureIndices(targetChunk.startCoord, targetChunk.endCoord);
  if (subStates.length === 0) {
    return createEmptyUnitState({
      unitId: targetChunk.chunkId,
      unitKind: "chunk",
      startCoord: targetChunk.startCoord,
      endCoord: targetChunk.endCoord,
      measureIndices: measures,
      targetSpeed: 1.0,
    });
  }
  if (subStates.length === 1) {
    return {
      ...subStates[0],
      unitId: targetChunk.chunkId,
      startCoord: targetChunk.startCoord,
      endCoord: targetChunk.endCoord,
      measureIndices: measures,
    };
  }

  let minStability = Infinity;
  let minStableSpeed = Infinity;
  let maxDifficulty = 1;
  let minNights = Infinity;
  let maxLastReviewed: number | null = null;
  let maxLastEvent: number | null = null;
  let maxSleepGateTs: number | null = null;
  let maxSleepGateDate: string | null = null;
  let totalReviews = 0;
  let allBoth = true;
  let fallbackHand: PracticeMode = "both";
  let latestFingerprint: string | undefined;
  let latestFpTime = -1;
  const internalBoundaries: ScoreCoord[] = [];
  const sorted = [...subStates].sort((a, b) => compareScoreCoord(a.startCoord, b.startCoord));

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (s.stabilityDays < minStability) minStability = s.stabilityDays;
    if (s.stableSpeed < minStableSpeed) minStableSpeed = s.stableSpeed;
    if (s.difficulty > maxDifficulty) maxDifficulty = s.difficulty;
    if (s.sleepConsolidatedNights < minNights) minNights = s.sleepConsolidatedNights;
    if (s.handStage !== "both") {
      allBoth = false;
      fallbackHand = s.handStage;
    }
    if (s.lastReviewedAtMs !== null && (maxLastReviewed === null || s.lastReviewedAtMs > maxLastReviewed)) {
      maxLastReviewed = s.lastReviewedAtMs;
    }
    if (s.lastEventTimestampMs !== null && (maxLastEvent === null || s.lastEventTimestampMs > maxLastEvent)) {
      maxLastEvent = s.lastEventTimestampMs;
    }
    if (
      s.lastSleepUpdateTimestampMs !== null &&
      (maxSleepGateTs === null || s.lastSleepUpdateTimestampMs > maxSleepGateTs)
    ) {
      maxSleepGateTs = s.lastSleepUpdateTimestampMs;
    }
    if (s.lastSleepGateDateKey && (!maxSleepGateDate || s.lastSleepGateDateKey > maxSleepGateDate)) {
      maxSleepGateDate = s.lastSleepGateDateKey;
    }
    if (s.lastScoreFingerprint && (s.lastReviewedAtMs ?? 0) >= latestFpTime) {
      latestFpTime = s.lastReviewedAtMs ?? 0;
      latestFingerprint = s.lastScoreFingerprint;
    }
    totalReviews += s.reviewCount;
    if (i > 0) {
      internalBoundaries.push(s.startCoord);
    }
  }

  return {
    unitId: targetChunk.chunkId,
    unitKind: "chunk",
    startCoord: targetChunk.startCoord,
    endCoord: targetChunk.endCoord,
    measureIndices: measures,
    handStage: allBoth ? "both" : fallbackHand,
    stableSpeed: Number.isFinite(minStableSpeed) ? minStableSpeed : 0.55,
    targetSpeed: sorted[0].targetSpeed,
    difficulty: maxDifficulty,
    stabilityDays: Number.isFinite(minStability) ? minStability : 0,
    retrievability: 1,
    intervalDays: 0,
    lastReviewedAtMs: maxLastReviewed,
    lastEventTimestampMs: maxLastEvent,
    lastSleepUpdateTimestampMs: maxSleepGateTs,
    lastSleepGateDateKey: maxSleepGateDate,
    lastScoreFingerprint: latestFingerprint,
    sleepConsolidatedNights: Number.isFinite(minNights) ? minNights : 0,
    consecutiveAgainDays: 0,
    reviewCount: totalReviews,
    pendingInternalJunctionVerify: true,
    internalJunctionCoords: internalBoundaries,
  };
}

/**
 * Applies `PieceProfile.chunkOverrides` (`addedBoundaries`, `removedBoundaries`) to `MotorChunk[]`.
 */
export function applyChunkOverridesToLayout(
  chunks: readonly MotorChunk[],
  overrides?: PieceProfile["chunkOverrides"],
): MotorChunk[] {
  let working: MotorChunk[] = chunks.map((c) => ({ ...c }));
  if (!overrides) return working;

  for (const boundary of overrides.addedBoundaries) {
    const next: MotorChunk[] = [];
    for (const chunk of working) {
      if (
        compareScoreCoord(chunk.startCoord, boundary) < 0 &&
        compareScoreCoord(boundary, chunk.endCoord) < 0
      ) {
        const leftMeasures = getSpanMeasureIndices(chunk.startCoord, boundary);
        const rightMeasures = getSpanMeasureIndices(boundary, chunk.endCoord);
        const splitIdx = next.length;
        const leftChunk: MotorChunk = {
          ...chunk,
          chunkId: `${chunk.chunkId}-s0`,
          index: splitIdx,
          startMeasureIndex: leftMeasures[0],
          endMeasureIndex: leftMeasures[leftMeasures.length - 1],
          startCoord: chunk.startCoord,
          endCoord: boundary,
          measureCount: leftMeasures.length,
          userPinned: true,
        };
        const rightChunk: MotorChunk = {
          ...chunk,
          chunkId: `${chunk.chunkId}-s1`,
          index: splitIdx + 1,
          startMeasureIndex: rightMeasures[0],
          endMeasureIndex: rightMeasures[rightMeasures.length - 1],
          startCoord: boundary,
          endCoord: chunk.endCoord,
          measureCount: rightMeasures.length,
          userPinned: true,
        };
        next.push(leftChunk, rightChunk);
      } else {
        next.push(chunk);
      }
    }
    working = next;
  }

  for (const boundary of overrides.removedBoundaries) {
    const next: MotorChunk[] = [];
    for (let i = 0; i < working.length; i++) {
      const curr = working[i];
      const upcoming = working[i + 1];
      if (
        upcoming &&
        sameScoreCoord(curr.endCoord, boundary) &&
        sameScoreCoord(upcoming.startCoord, boundary)
      ) {
        const mergedMeasures = getSpanMeasureIndices(curr.startCoord, upcoming.endCoord);
        next.push({
          ...curr,
          chunkId: `${curr.chunkId}+${upcoming.chunkId}`,
          index: next.length,
          startMeasureIndex: mergedMeasures[0],
          endMeasureIndex: mergedMeasures[mergedMeasures.length - 1],
          startCoord: curr.startCoord,
          endCoord: upcoming.endCoord,
          measureCount: mergedMeasures.length,
          stepCount: curr.stepCount + upcoming.stepCount,
          userPinned: true,
        });
        i += 1;
      } else {
        next.push({ ...curr, index: next.length });
      }
    }
    working = next;
  }

  return working.map((c, idx) => ({ ...c, index: idx }));
}

function inferChunksFromEvents(
  events: readonly PracticeEvent[],
  overrides?: PieceProfile["chunkOverrides"],
): MotorChunk[] {
  const bySpanKey = new Map<string, { start: ScoreCoord; end: ScoreCoord; lastTs: number }>();
  for (const ev of events) {
    if (ev.boutKind !== "chunk") continue;
    const key = formatSpanKey(ev.startCoord, ev.endCoord);
    const existing = bySpanKey.get(key);
    if (!existing || ev.timestampMs > existing.lastTs) {
      bySpanKey.set(key, { start: ev.startCoord, end: ev.endCoord, lastTs: ev.timestampMs });
    }
  }

  const allEntries = [...bySpanKey.values()].sort((a, b) =>
    compareScoreCoord(a.start, b.start) || compareScoreCoord(a.end, b.end),
  );
  // Keep latest non-overlapping spans (if a span overlaps another, prefer the one with more recent activity)
  const chosen: typeof allEntries = [];
  for (const entry of allEntries) {
    const conflictIdx = chosen.findIndex((c) =>
      spansOverlap(c.start, c.end, entry.start, entry.end),
    );
    if (conflictIdx === -1) {
      chosen.push(entry);
    } else if (entry.lastTs > chosen[conflictIdx].lastTs) {
      chosen[conflictIdx] = entry;
    }
  }
  chosen.sort((a, b) => compareScoreCoord(a.start, b.start));

  const inferred = chosen.map((entry, idx) => {
    const measures = getSpanMeasureIndices(entry.start, entry.end);
    return {
      chunkId: `chunk-${formatSpanKey(entry.start, entry.end)}`,
      index: idx,
      sectionId: "sec-inferred",
      startMeasureIndex: measures[0],
      endMeasureIndex: measures[measures.length - 1],
      startCoord: entry.start,
      endCoord: entry.end,
      measureCount: measures.length,
      stepCount: measures.length * 4,
      densityStepsPerMeasure: 4,
      hasAnacrusisLeadIn: false,
      anacrusisBeats: 0,
      overlapFlag: false,
      boundaryConfidence: 1,
    } satisfies MotorChunk;
  });

  return applyChunkOverridesToLayout(inferred, overrides);
}

function accumulateFaultsByMeasure(
  events: readonly PracticeEvent[],
): Map<number, number> {
  const faults = new Map<number, number>();
  for (const ev of events) {
    for (const [mStr, counts] of Object.entries(ev.measureFaultCounts)) {
      const m = Number(mStr);
      const total = counts.missed + counts.extra + counts.hesitations;
      if (total > 0) {
        faults.set(m, (faults.get(m) ?? 0) + total);
      }
    }
  }
  return faults;
}

function reduceChunkWithSpanReplay(
  chunk: MotorChunk,
  chunkAndProbeEvents: readonly PracticeEvent[],
  targetSpeed: number,
): MotorUnitMemoryState | undefined {
  const overlapping = chunkAndProbeEvents.filter((ev) =>
    spansOverlap(ev.startCoord, ev.endCoord, chunk.startCoord, chunk.endCoord),
  );
  if (overlapping.length === 0) return undefined;

  const chunkMeasureSet = new Set(getSpanMeasureIndices(chunk.startCoord, chunk.endCoord));
  const superSpanGroups = new Map<string, { start: ScoreCoord; end: ScoreCoord; events: PracticeEvent[] }>();
  const subSpanGroups = new Map<string, { start: ScoreCoord; end: ScoreCoord; events: PracticeEvent[] }>();
  const directEvents: PracticeEvent[] = [];

  for (const ev of overlapping) {
    if (ev.boutKind === "cold-probe") {
      directEvents.push(ev);
      continue;
    }
    const evMeasures = getSpanMeasureIndices(ev.startCoord, ev.endCoord);
    const sameSpan =
      sameScoreCoord(ev.startCoord, chunk.startCoord) &&
      sameScoreCoord(ev.endCoord, chunk.endCoord);
    const sameMeasures =
      evMeasures.length === chunkMeasureSet.size && evMeasures.every((m) => chunkMeasureSet.has(m));

    if (sameSpan || sameMeasures) {
      directEvents.push(ev);
    } else if (
      spanContains(ev.startCoord, ev.endCoord, chunk.startCoord, chunk.endCoord) &&
      evMeasures.length > chunkMeasureSet.size
    ) {
      const key = formatSpanKey(ev.startCoord, ev.endCoord);
      let g = superSpanGroups.get(key);
      if (!g) {
        g = { start: ev.startCoord, end: ev.endCoord, events: [] };
        superSpanGroups.set(key, g);
      }
      g.events.push(ev);
    } else if (
      spanContains(chunk.startCoord, chunk.endCoord, ev.startCoord, ev.endCoord) &&
      evMeasures.length < chunkMeasureSet.size
    ) {
      const key = formatSpanKey(ev.startCoord, ev.endCoord);
      let g = subSpanGroups.get(key);
      if (!g) {
        g = { start: ev.startCoord, end: ev.endCoord, events: [] };
        subSpanGroups.set(key, g);
      }
      g.events.push(ev);
    } else {
      directEvents.push(ev);
    }
  }

  // Case 1: Only direct events (no split/merge ancestry)
  if (superSpanGroups.size === 0 && subSpanGroups.size === 0) {
    let state = createEmptyUnitState({
      unitId: chunk.chunkId,
      unitKind: "chunk",
      startCoord: chunk.startCoord,
      endCoord: chunk.endCoord,
      measureIndices: [...chunkMeasureSet],
      targetSpeed,
    });
    for (const ev of directEvents) {
      state = applyEventToUnitState(state, ev);
    }
    return state;
  }

  // Build initial base state from Split parent and/or Merge sub-spans before post-edit direct events
  const firstDirectTs = directEvents.length > 0 ? directEvents[0].timestampMs : Infinity;
  let state: MotorUnitMemoryState | undefined;

  if (superSpanGroups.size > 0) {
    // Use the latest ancestor super-span
    let latestParent: { start: ScoreCoord; end: ScoreCoord; events: PracticeEvent[]; maxTs: number } | undefined;
    for (const g of superSpanGroups.values()) {
      const preEvents = g.events.filter((e) => e.timestampMs <= firstDirectTs);
      if (preEvents.length === 0) continue;
      const maxTs = preEvents[preEvents.length - 1].timestampMs;
      if (!latestParent || maxTs > latestParent.maxTs) {
        latestParent = { ...g, events: preEvents, maxTs };
      }
    }
    if (latestParent) {
      let parentState = createEmptyUnitState({
        unitId: `parent-${formatSpanKey(latestParent.start, latestParent.end)}`,
        unitKind: "chunk",
        startCoord: latestParent.start,
        endCoord: latestParent.end,
        measureIndices: getSpanMeasureIndices(latestParent.start, latestParent.end),
        targetSpeed,
      });
      for (const ev of latestParent.events) {
        parentState = applyEventToUnitState(parentState, ev);
      }
      const faults = accumulateFaultsByMeasure(latestParent.events);
      state = applySplitDiscountToUnitState(parentState, chunk, faults);
    }
  }

  if (subSpanGroups.size > 0) {
    const subStates: MotorUnitMemoryState[] = [];
    for (const g of subSpanGroups.values()) {
      const preEvents = g.events.filter((e) => e.timestampMs <= firstDirectTs);
      if (preEvents.length === 0) continue;
      let subState = createEmptyUnitState({
        unitId: `sub-${formatSpanKey(g.start, g.end)}`,
        unitKind: "chunk",
        startCoord: g.start,
        endCoord: g.end,
        measureIndices: getSpanMeasureIndices(g.start, g.end),
        targetSpeed,
      });
      for (const ev of preEvents) {
        subState = applyEventToUnitState(subState, ev);
      }
      subStates.push(subState);
    }
    if (subStates.length > 0) {
      const merged = mergeSubUnitStates(chunk, subStates);
      state = state
        ? mergeSubUnitStates(chunk, [state, merged])
        : merged;
    }
  }

  if (!state) {
    state = createEmptyUnitState({
      unitId: chunk.chunkId,
      unitKind: "chunk",
      startCoord: chunk.startCoord,
      endCoord: chunk.endCoord,
      measureIndices: [...chunkMeasureSet],
      targetSpeed,
    });
  }

  for (const ev of directEvents) {
    state = applyEventToUnitState(state, ev);
  }
  return state;
}

function finalizeUnitMetrics(
  unit: MotorUnitMemoryState,
  nowTimestampMs: number,
  nowLocalDateKey: string | undefined,
  options: MaintenanceIntervalOptions,
): MotorUnitMemoryState {
  const anchorMs = unit.lastReviewedAtMs ?? unit.lastEventTimestampMs;
  const elapsedDays =
    anchorMs !== null && nowTimestampMs > anchorMs ? (nowTimestampMs - anchorMs) / MS_PER_DAY : 0;
  const retrievability =
    unit.stabilityDays > 0 ? computeFsrsRetrievability(elapsedDays, unit.stabilityDays) : 1;
  const currentDateKey =
    nowLocalDateKey ?? unit.lastSleepGateDateKey ?? timestampToUtcDateKey(nowTimestampMs);
  const intervalDays = computeMaintenanceIntervalDays(unit.stabilityDays, {
    ...options,
    currentDateKey,
  });
  const baseDateKey = unit.lastSleepGateDateKey ?? currentDateKey;
  const nextReviewDateKey =
    intervalDays > 0 ? addDaysToDateKey(baseDateKey, Math.max(1, Math.round(intervalDays))) : undefined;
  return {
    ...unit,
    retrievability,
    intervalDays,
    ...(nextReviewDateKey ? { nextReviewDateKey } : {}),
  };
}

function eventOverlapsJunction(event: PracticeEvent, junction: ChunkJunction): boolean {
  if (event.junctionBoundaryCoord && sameScoreCoord(event.junctionBoundaryCoord, junction.boundaryCoord)) {
    return true;
  }
  return spansOverlap(
    event.startCoord,
    event.endCoord,
    junction.boundaryCoord,
    junction.boundaryCoord,
  );
}

function eventHasJunctionTrouble(event: PracticeEvent, junction: ChunkJunction): boolean {
  if (event.boutKind === "bridge") return true;
  if (!eventOverlapsJunction(event, junction)) return false;
  if (event.fluency.junctionHesitationRatio > 1.6 || event.fluency.switchBranchMismatch) {
    return true;
  }
  const mFaults = event.measureFaultCounts[junction.measureIndex];
  return Boolean(mFaults && mFaults.missed + mFaults.extra + mFaults.hesitations > 0);
}

function isStaticHighRiskJunction(junction: ChunkJunction): boolean {
  return (
    junction.priorRisk >= 0.65 ||
    junction.isHighRisk ||
    junction.reasonTags.includes("switch-point") ||
    junction.dimensions.d5SwitchPointInterference > 0
  );
}

/**
 * Pure deterministic sleep-gated Motor-FSRS reducer (`PracticeEvent[] -> PiecePracticeState`).
 */
export function reducePiecePracticeState(
  events: readonly PracticeEvent[],
  context: MotorFsrsReducerContext = {},
): PiecePracticeState {
  const sortedEvents = sortPracticeEventsChronologically(events);
  const pieceId = context.pieceId ?? sortedEvents[0]?.pieceId ?? "";
  const targetSpeed = context.targetSpeed ?? 1.0;

  const baseChunks =
    context.chunks !== undefined
      ? applyChunkOverridesToLayout(context.chunks, context.chunkOverrides)
      : inferChunksFromEvents(sortedEvents, context.chunkOverrides);

  const chunkProbeEvents = sortedEvents.filter(
    (ev) => ev.boutKind === "chunk" || ev.boutKind === "cold-probe",
  );
  const bridgeEvents = sortedEvents.filter((ev) => ev.boutKind === "bridge");

  const latestEvent = sortedEvents[sortedEvents.length - 1];
  const nowTimestampMs = context.nowTimestampMs ?? latestEvent?.timestampMs ?? 0;
  const nowLocalDateKey = context.nowLocalDateKey ?? latestEvent?.localDateKey;
  const intervalOpts: MaintenanceIntervalOptions = {
    targetRetention: context.targetRetention,
    baseMaxIntervalDays: context.baseMaxIntervalDays,
    performanceDateKey: context.performanceDateKey,
  };

  const chunkStates: Record<string, MotorUnitMemoryState> = {};
  for (const chunk of baseChunks) {
    const reduced = reduceChunkWithSpanReplay(chunk, chunkProbeEvents, targetSpeed);
    if (reduced) {
      chunkStates[chunk.chunkId] = finalizeUnitMetrics(
        reduced,
        nowTimestampMs,
        nowLocalDateKey,
        intervalOpts,
      );
    }
  }

  // Lazy ChunkJunction activation: priorRisk >= 0.65, SwitchPoint, or empirical fault/hesitation
  const junctionStates: Record<string, MotorUnitMemoryState> = {};
  const knownJunctions = context.junctions ?? [];

  for (const junction of knownJunctions) {
    const matchingBridgeEvents = bridgeEvents.filter((ev) => eventOverlapsJunction(ev, junction));
    const empiricalTrigger = sortedEvents.some((ev) => eventHasJunctionTrouble(ev, junction));
    const staticHighRisk = isStaticHighRiskJunction(junction);

    if (!staticHighRisk && !empiricalTrigger && matchingBridgeEvents.length === 0) {
      continue;
    }

    let jState = createEmptyUnitState({
      unitId: junction.junctionId,
      unitKind: "junction",
      startCoord: junction.boundaryCoord,
      endCoord: junction.boundaryCoord,
      boundaryCoord: junction.boundaryCoord,
      measureIndices: [junction.measureIndex],
      targetSpeed,
      isHighRiskJunction: staticHighRisk,
    });
    for (const ev of matchingBridgeEvents) {
      jState = applyEventToUnitState(jState, ev);
    }
    junctionStates[junction.junctionId] = finalizeUnitMetrics(
      jState,
      nowTimestampMs,
      nowLocalDateKey,
      intervalOpts,
    );
  }

  // Also capture ad-hoc bridge events when junctions array wasn't supplied (e.g., backup replay)
  for (const ev of bridgeEvents) {
    if (!ev.junctionBoundaryCoord) continue;
    const alreadyMapped = knownJunctions.some((j) =>
      sameScoreCoord(j.boundaryCoord, ev.junctionBoundaryCoord!),
    );
    if (alreadyMapped) continue;
    const key = `junc-${formatScoreCoordKey(ev.junctionBoundaryCoord)}`;
    let jState =
      junctionStates[key] ??
      createEmptyUnitState({
        unitId: key,
        unitKind: "junction",
        startCoord: ev.junctionBoundaryCoord,
        endCoord: ev.junctionBoundaryCoord,
        boundaryCoord: ev.junctionBoundaryCoord,
        measureIndices: [ev.junctionBoundaryCoord.measureIndex],
        targetSpeed,
      });
    jState = applyEventToUnitState(jState, ev);
    junctionStates[key] = finalizeUnitMetrics(
      jState,
      nowTimestampMs,
      nowLocalDateKey,
      intervalOpts,
    );
  }

  let bestStableSpeed = 0;
  for (const u of Object.values(chunkStates)) {
    if (u.reviewCount > 0 && u.stableSpeed > bestStableSpeed) {
      bestStableSpeed = u.stableSpeed;
    }
  }
  for (const u of Object.values(junctionStates)) {
    if (u.reviewCount > 0 && u.stableSpeed > bestStableSpeed) {
      bestStableSpeed = u.stableSpeed;
    }
  }

  const layoutSignature = baseChunks
    .map((c) => `${c.chunkId}:${formatSpanKey(c.startCoord, c.endCoord)}`)
    .join("|");

  return {
    reducerVersion: MOTOR_FSRS_REDUCER_VERSION,
    pieceId,
    ...(latestEvent ? { lastEventId: latestEvent.eventId } : {}),
    eventCount: sortedEvents.length,
    bestStableSpeed,
    ...(latestEvent ? { lastPracticedAtMs: latestEvent.timestampMs } : {}),
    layoutSignature,
    chunkStates,
    junctionStates,
  };
}
