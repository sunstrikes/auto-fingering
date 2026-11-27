import type {
  ChunkJunction,
  MotorChunk,
  PassageCluster,
  PassageInstance,
  PerformanceCue,
} from "../chunking/types";
import type { PracticeMode, ScoreCoord } from "../domain/types";
import {
  computeNextSpeedStep,
  roundSpeed,
  spanContains,
  type MotorGrade,
  type MotorUnitMemoryState,
  type PiecePracticeState,
} from "./motorFsrs";
import {
  DECODING_DEFAULT_SPEED,
  type GuidedTimeBoxMinutes,
  type PlannedQueueItem,
  type SessionPlan,
} from "./sessionPlanner";

export const PHASE0_HARD_CAP_MS = 180_000;
export const PHASE1_DWELL_CAP_MS = 150_000;
export const BRIDGE_SOFT_CAP_MS = 45_000;
export const BRIDGE_MAX_ATTEMPTS = 6;
export const BRIDGE_REQUIRED_SMOOTH_PASSES = 2;
export const SINGLE_HAND_ISOLATION_SPEED_CAP = 0.75;
export const SINGLE_HAND_RETURN_COMPENSATION = 0.88;
export const CIRCUIT_BREAKER_SPEED_STEP_DOWN = 0.85;
export const MIN_WORKING_SPEED = 0.5;
export const OVERSPEED_PROBE_SPEED = 1.05;
export const EARLY_MACRO_REST_MIN_ELAPSED_MS = 12 * 60_000;
export const EARLY_MACRO_REST_DURATION_MS = 120_000;

export type ContextualPhase = 0 | 1 | 2;

export type CircuitBreakerKind =
  | "bridge"
  | "single-hand-isolation"
  | "speed-step-down"
  | "waiting-rescue";

export interface ActiveRescueState {
  kind: CircuitBreakerKind;
  skippableViaC8: true;
  junction?: ChunkJunction;
  isolatedHand?: "RH" | "LH";
  preRescueSpeed: number;
  targetSpeed: number;
  smoothPassesDone: number;
  attempts: number;
  startedAtMs: number;
}

export interface ClusterWarmStartInfo {
  clusterId: string;
  sourceChunkId: string;
  motorReuse: number;
  skipStage0: boolean;
  targetSpeed: number;
  initialStabilityDays: number;
  sleepConsolidatedNights: 0;
  switchPointExcluded: boolean;
}

export interface SchedulerUnitRuntime {
  chunkId: string;
  chunk: MotorChunk;
  phase: ContextualPhase;
  workingSpeed: number;
  stableSpeed: number;
  handMode: PracticeMode;
  handStage: PracticeMode;
  stabilityDays: number;
  sleepConsolidatedNights: number;
  reviewCount: number;
  lastEffectiveGrade?: MotorGrade;
  easyEligible: boolean;
  clusterId?: string;
  hasTrailingSwitchPoint: boolean;
  phase0ElapsedMs: number;
  phase0Stage0Graduated: boolean;
  phase0SteadyPassDone: boolean;
  consecutiveFaults: number;
  lastFaultedSteps: number[];
  lastFaultedJunctionId?: string;
  nonAdjacentCleanRounds: number;
  speedUpgradesThisSession: number;
  activeRescue: ActiveRescueState | null;
}

export type SchedulerDirective =
  | {
      kind: "chunk";
      chunk: MotorChunk;
      boutKind: "chunk";
      skipStage0: boolean;
      useWaitingMode: boolean;
      speedMultiplier: number;
      targetSpeed: number;
      practiceMode: PracticeMode;
      isColdFirstPass: boolean;
      clusterId?: string;
      skippableViaC8: boolean;
      rescueKind?: CircuitBreakerKind;
    }
  | {
      kind: "bridge";
      chunk: MotorChunk;
      boutKind: "bridge";
      junction: ChunkJunction;
      countInBeats: 2;
      speedMultiplier: number;
      targetSpeed: number;
      practiceMode: PracticeMode;
      skippableViaC8: true;
    }
  | {
      kind: "cold-probe";
      chunk: MotorChunk;
      boutKind: "cold-probe";
      cue: PerformanceCue;
      endCoord: ScoreCoord;
      countInBeats?: number;
      speedMultiplier: number;
      targetSpeed: number;
      practiceMode: PracticeMode;
      isColdFirstPass: boolean;
      skippableViaC8: true;
    }
  | {
      kind: "macro-rest";
      durationMs: number;
      skippableViaC8: true;
    }
  | {
      kind: "completed";
    };

export interface MotorSchedulerState {
  timeBoxMinutes: GuidedTimeBoxMinutes;
  startedAtMs: number;
  earlyMacroRestEligible: boolean;
  earlyMacroRestOffered: boolean;
  earlyMacroRestActive: boolean;
  isManualSingleHandSession: boolean;
  manualPracticeMode: PracticeMode;
  overspeedProbeEnabled: boolean;
  activePool: string[];
  units: Record<string, SchedulerUnitRuntime>;
  clusters: readonly PassageCluster[];
  junctions: readonly ChunkJunction[];
  remainingPlannedItems: PlannedQueueItem[];
  serialCursor: number;
  roundNumber: number;
  lastUnitId: string | null;
  lastClusterId: string | null;
  prngState: number;
  currentDirective: SchedulerDirective;
}

export interface CreateMotorSchedulerOptions {
  plan: SessionPlan;
  chunks: readonly MotorChunk[];
  junctions: readonly ChunkJunction[];
  passageClusters: readonly PassageCluster[];
  piecePracticeState: PiecePracticeState | null;
  manualPracticeMode: PracticeMode;
  overspeedProbeEnabled?: boolean;
  startedAtMs: number;
  seed?: number;
}

export interface SchedulerBoutOutcome {
  chunkId: string;
  boutKind: "chunk" | "bridge" | "cold-probe";
  junction?: ChunkJunction;
  practiceMode: PracticeMode;
  speedMultiplier: number;
  grade: MotorGrade;
  pitchAccuracy: number;
  stallDetected: boolean;
  interiorHesitationCount: number;
  junctionHesitationRatio: number;
  dominantHandFaultRatio: { rh: number; lh: number };
  faultedSteps?: number[];
  boundaryFault?: boolean;
  isColdFirstPass?: boolean;
  durationMs: number;
  nowMs: number;
}

function nextPrng(seed: number): { value: number; nextSeed: number } {
  const nextSeed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
  return { value: nextSeed / 0x100000000, nextSeed };
}

function findClusterInstanceForChunk(
  chunk: MotorChunk,
  clusters: readonly PassageCluster[],
): { cluster: PassageCluster; instance: PassageInstance } | null {
  for (const cluster of clusters) {
    for (const inst of cluster.instances) {
      if (
        spanContains(inst.startCoord, inst.endCoord, chunk.startCoord, chunk.endCoord) ||
        spanContains(chunk.startCoord, chunk.endCoord, inst.startCoord, inst.endCoord) ||
        (chunk.startMeasureIndex >= inst.startMeasureIndex &&
          chunk.endMeasureIndex <= inst.endMeasureIndex)
      ) {
        return { cluster, instance: inst };
      }
    }
  }
  return null;
}

function deriveInitialPhase(unitState: MotorUnitMemoryState | undefined): ContextualPhase {
  if (!unitState || unitState.reviewCount === 0) return 0;
  if (
    unitState.handStage === "both" &&
    unitState.stableSpeed >= 0.75 &&
    unitState.sleepConsolidatedNights >= 1
  ) {
    return 2;
  }
  return 1;
}

function hasStepOverlap(prev: readonly number[], curr: readonly number[] | undefined): boolean {
  if (!curr || curr.length === 0 || prev.length === 0) return false;
  const set = new Set(prev);
  return curr.some((s) => set.has(s));
}

function computeWarmStartFromRuntime(
  targetChunk: MotorChunk,
  units: Record<string, SchedulerUnitRuntime>,
  clusters: readonly PassageCluster[],
): ClusterWarmStartInfo | null {
  const match = findClusterInstanceForChunk(targetChunk, clusters);
  if (!match) return null;
  const { cluster, instance } = match;

  let best: { source: SchedulerUnitRuntime; reuse: number } | null = null;

  for (const peerInst of cluster.instances) {
    if (peerInst.instanceId === instance.instanceId) continue;
    const peerUnit = Object.values(units).find(
      (u) =>
        u.chunkId !== targetChunk.chunkId &&
        (spanContains(peerInst.startCoord, peerInst.endCoord, u.chunk.startCoord, u.chunk.endCoord) ||
          (u.chunk.startMeasureIndex >= peerInst.startMeasureIndex &&
            u.chunk.endMeasureIndex <= peerInst.endMeasureIndex)),
    );
    if (!peerUnit || peerUnit.reviewCount === 0) continue;
    const consolidated =
      peerUnit.sleepConsolidatedNights >= 1 ||
      (peerUnit.lastEffectiveGrade ?? 0) >= 3 ||
      peerUnit.stabilityDays >= 1.5;
    if (!consolidated) continue;

    const reuse = instance.isPrototype
      ? peerInst.motorReuse
      : peerInst.isPrototype
        ? instance.motorReuse
        : Math.min(instance.motorReuse, peerInst.motorReuse);
    if (reuse < 0.4) continue;

    if (!best || reuse > best.reuse || (reuse === best.reuse && peerUnit.stableSpeed > best.source.stableSpeed)) {
      best = { source: peerUnit, reuse };
    }
  }

  if (!best) return null;

  const isExact = best.reuse >= 0.9;
  const targetSpeed = isExact
    ? best.source.stableSpeed
    : Math.max(
        DECODING_DEFAULT_SPEED,
        roundSpeed(best.source.stableSpeed * (0.75 + 0.2 * best.reuse)),
      );

  return {
    clusterId: cluster.clusterId,
    sourceChunkId: best.source.chunkId,
    motorReuse: best.reuse,
    skipStage0: isExact,
    targetSpeed,
    initialStabilityDays: Math.min(best.source.stabilityDays * 0.5, 2.0),
    sleepConsolidatedNights: 0,
    switchPointExcluded: Boolean(instance.switchPoint),
  };
}

/**
 * Returns symmetric `PassageCluster` warm-start parameters for an unpracticed chunk
 * once any cluster instance has consolidated, strictly isolating trailing `SwitchPoint`s.
 */
export function getClusterWarmStartForChunk(
  state: MotorSchedulerState,
  chunkId: string,
): ClusterWarmStartInfo | null {
  const unit = state.units[chunkId];
  if (!unit) return null;
  return computeWarmStartFromRuntime(unit.chunk, state.units, state.clusters);
}

function buildDirectiveForUnit(
  unit: SchedulerUnitRuntime,
  state: MotorSchedulerState,
  opts: { isColdFirstPass?: boolean; forceSkipStage0?: boolean } = {},
): SchedulerDirective {
  if (unit.activeRescue) {
    if (unit.activeRescue.kind === "bridge" && unit.activeRescue.junction) {
      return {
        kind: "bridge",
        chunk: unit.chunk,
        boutKind: "bridge",
        junction: unit.activeRescue.junction,
        countInBeats: 2,
        speedMultiplier: unit.activeRescue.targetSpeed,
        targetSpeed: unit.activeRescue.targetSpeed,
        practiceMode: state.manualPracticeMode,
        skippableViaC8: true,
      };
    }
    const rescueKind = unit.activeRescue.kind;
    const rescuePracticeMode: PracticeMode =
      rescueKind === "single-hand-isolation" && unit.activeRescue.isolatedHand
        ? unit.activeRescue.isolatedHand === "RH"
          ? "rh-only"
          : "lh-only"
        : state.manualPracticeMode;

    return {
      kind: "chunk",
      chunk: unit.chunk,
      boutKind: "chunk",
      skipStage0: rescueKind !== "waiting-rescue",
      useWaitingMode: rescueKind === "waiting-rescue",
      speedMultiplier: unit.activeRescue.targetSpeed,
      targetSpeed: unit.activeRescue.targetSpeed,
      practiceMode: rescuePracticeMode,
      isColdFirstPass: false,
      ...(unit.clusterId ? { clusterId: unit.clusterId } : {}),
      skippableViaC8: true,
      rescueKind,
    };
  }

  const warm = unit.reviewCount === 0 ? computeWarmStartFromRuntime(unit.chunk, state.units, state.clusters) : null;
  const skipStage0 =
    Boolean(opts.forceSkipStage0) ||
    unit.phase > 0 ||
    unit.phase0Stage0Graduated ||
    Boolean(warm?.skipStage0);
  const effectiveSpeed = warm ? warm.targetSpeed : unit.workingSpeed;

  return {
    kind: "chunk",
    chunk: unit.chunk,
    boutKind: "chunk",
    skipStage0,
    useWaitingMode: !skipStage0,
    speedMultiplier: effectiveSpeed,
    targetSpeed: effectiveSpeed,
    practiceMode: state.manualPracticeMode,
    isColdFirstPass: Boolean(opts.isColdFirstPass),
    ...(unit.clusterId ? { clusterId: unit.clusterId } : {}),
    skippableViaC8: false,
  };
}

function buildDirectiveFromPlannedItem(
  item: PlannedQueueItem,
  state: MotorSchedulerState,
): SchedulerDirective {
  if (item.boutKind === "bridge" && item.junction) {
    return {
      kind: "bridge",
      chunk: item.chunk,
      boutKind: "bridge",
      junction: item.junction,
      countInBeats: 2,
      speedMultiplier: item.targetSpeed,
      targetSpeed: item.targetSpeed,
      practiceMode: state.manualPracticeMode,
      skippableViaC8: true,
    };
  }
  if (item.boutKind === "cold-probe" && item.cue && item.probeEndCoord) {
    return {
      kind: "cold-probe",
      chunk: item.chunk,
      boutKind: "cold-probe",
      cue: item.cue,
      endCoord: item.probeEndCoord,
      speedMultiplier: item.targetSpeed,
      targetSpeed: item.targetSpeed,
      practiceMode: state.manualPracticeMode,
      isColdFirstPass: item.isColdFirstPass,
      skippableViaC8: true,
    };
  }
  const unit = state.units[item.chunk.chunkId];
  if (unit) {
    return buildDirectiveForUnit(unit, state, {
      isColdFirstPass: item.isColdFirstPass,
      forceSkipStage0: item.skipStage0,
    });
  }
  return {
    kind: "chunk",
    chunk: item.chunk,
    boutKind: "chunk",
    skipStage0: item.skipStage0,
    useWaitingMode: !item.skipStage0,
    speedMultiplier: item.targetSpeed,
    targetSpeed: item.targetSpeed,
    practiceMode: state.manualPracticeMode,
    isColdFirstPass: item.isColdFirstPass,
    ...(item.clusterId ? { clusterId: item.clusterId } : {}),
    skippableViaC8: false,
  };
}

/**
 * Initializes the pure `MotorScheduler` state machine from a `SessionPlan` and
 * current `PiecePracticeState`.
 */
export function createMotorSchedulerState(
  options: CreateMotorSchedulerOptions,
): MotorSchedulerState {
  const {
    plan,
    chunks,
    junctions,
    passageClusters,
    piecePracticeState,
    manualPracticeMode,
    overspeedProbeEnabled = false,
    startedAtMs,
    seed = 1337,
  } = options;

  const chunkStates = piecePracticeState?.chunkStates ?? {};
  const units: Record<string, SchedulerUnitRuntime> = {};

  for (const chunk of chunks) {
    const st = chunkStates[chunk.chunkId];
    const clusterMatch = findClusterInstanceForChunk(chunk, passageClusters);
    const phase = deriveInitialPhase(st);
    const workingSpeed = st ? st.stableSpeed : DECODING_DEFAULT_SPEED;

    units[chunk.chunkId] = {
      chunkId: chunk.chunkId,
      chunk,
      phase,
      workingSpeed,
      stableSpeed: st ? st.stableSpeed : DECODING_DEFAULT_SPEED,
      handMode: manualPracticeMode,
      handStage: st ? st.handStage : "both",
      stabilityDays: st ? st.stabilityDays : 0,
      sleepConsolidatedNights: st ? st.sleepConsolidatedNights : 0,
      reviewCount: st ? st.reviewCount : 0,
      lastEffectiveGrade: st?.lastEffectiveGrade,
      easyEligible: false,
      ...(clusterMatch ? { clusterId: clusterMatch.cluster.clusterId } : {}),
      hasTrailingSwitchPoint: Boolean(clusterMatch?.instance.switchPoint),
      phase0ElapsedMs: 0,
      phase0Stage0Graduated: phase > 0,
      phase0SteadyPassDone: phase > 0,
      consecutiveFaults: 0,
      lastFaultedSteps: [],
      nonAdjacentCleanRounds: 0,
      speedUpgradesThisSession: 0,
      activeRescue: null,
    };
  }

  // Apply warm-start initial states for unpracticed cluster peers
  for (const unit of Object.values(units)) {
    if (unit.reviewCount === 0) {
      const warm = computeWarmStartFromRuntime(unit.chunk, units, passageClusters);
      if (warm) {
        unit.workingSpeed = warm.targetSpeed;
        if (warm.skipStage0) {
          unit.phase = 1;
          unit.phase0Stage0Graduated = true;
        }
      }
    }
  }

  const baseState: MotorSchedulerState = {
    timeBoxMinutes: plan.timeBoxMinutes,
    startedAtMs,
    earlyMacroRestEligible: plan.timeBoxMinutes === 25 || plan.timeBoxMinutes === 40,
    earlyMacroRestOffered: false,
    earlyMacroRestActive: false,
    isManualSingleHandSession: manualPracticeMode !== "both",
    manualPracticeMode,
    overspeedProbeEnabled,
    activePool: [...plan.activePoolChunkIds],
    units,
    clusters: passageClusters,
    junctions,
    remainingPlannedItems: plan.items.slice(1),
    serialCursor: 0,
    roundNumber: 1,
    lastUnitId: null,
    lastClusterId: null,
    prngState: seed >>> 0 || 1,
    currentDirective: { kind: "completed" },
  };

  const firstItem = plan.items[0];
  if (firstItem) {
    baseState.currentDirective = buildDirectiveFromPlannedItem(firstItem, baseState);
  } else if (baseState.activePool.length > 0 && units[baseState.activePool[0]]) {
    baseState.currentDirective = buildDirectiveForUnit(units[baseState.activePool[0]], baseState);
  }

  return baseState;
}

/** Records Stage 0 Waiting Mode graduation for a unit in Phase 0. */
export function recordSchedulerStage0Graduated(
  state: MotorSchedulerState,
  chunkId: string,
  _nowMs: number,
): MotorSchedulerState {
  const unit = state.units[chunkId];
  if (!unit) return state;
  return {
    ...state,
    units: {
      ...state.units,
      [chunkId]: {
        ...unit,
        phase0Stage0Graduated: true,
      },
    },
  };
}

function resolveBoundaryJunction(
  unit: SchedulerUnitRuntime,
  outcome: SchedulerBoutOutcome,
  junctions: readonly ChunkJunction[],
): ChunkJunction | undefined {
  if (outcome.junction) return outcome.junction;
  return junctions.find(
    (j) => j.leftChunkId === unit.chunkId || j.rightChunkId === unit.chunkId,
  );
}

/**
 * Pure transition processing a completed bout outcome: updates Phase 0/1/2 progression,
 * runs the 2-consecutive-fault priority circuit-breaker, applies the zoned speed ladder
 * and anti-entrenchment guard, and tracks non-adjacent clean interleaving rounds.
 */
export function recordSchedulerBoutOutcome(
  state: MotorSchedulerState,
  outcome: SchedulerBoutOutcome,
): MotorSchedulerState {
  const prevUnit = state.units[outcome.chunkId];
  if (!prevUnit) return state;

  const unit: SchedulerUnitRuntime = {
    ...prevUnit,
    lastFaultedSteps: [...prevUnit.lastFaultedSteps],
  };

  const isNonAdjacentReturn = state.lastUnitId !== null && state.lastUnitId !== outcome.chunkId;
  unit.reviewCount += 1;
  unit.lastEffectiveGrade = outcome.grade;

  // 1. Handle active circuit-breaker rescue completion / continuation
  if (unit.activeRescue) {
    const rescue = { ...unit.activeRescue };
    rescue.attempts += 1;
    const elapsedRescueMs = Math.max(0, outcome.nowMs - rescue.startedAtMs);

    if (rescue.kind === "bridge" && outcome.boutKind === "bridge") {
      if (outcome.grade >= 3 && !outcome.stallDetected && outcome.junctionHesitationRatio <= 1.6) {
        rescue.smoothPassesDone += 1;
      }
      if (
        rescue.smoothPassesDone >= BRIDGE_REQUIRED_SMOOTH_PASSES ||
        rescue.attempts >= BRIDGE_MAX_ATTEMPTS ||
        elapsedRescueMs >= BRIDGE_SOFT_CAP_MS
      ) {
        unit.activeRescue = null;
        unit.workingSpeed = rescue.preRescueSpeed;
        unit.consecutiveFaults = 0;
      } else {
        unit.activeRescue = rescue;
      }
      return {
        ...state,
        lastUnitId: outcome.chunkId,
        lastClusterId: unit.clusterId ?? null,
        units: { ...state.units, [outcome.chunkId]: unit },
      };
    }

    if (rescue.kind === "single-hand-isolation") {
      if (
        outcome.grade >= 3 ||
        rescue.attempts >= 2 ||
        elapsedRescueMs >= 120_000
      ) {
        unit.activeRescue = null;
        unit.handMode = "both";
        unit.workingSpeed = Math.max(
          MIN_WORKING_SPEED,
          roundSpeed(rescue.preRescueSpeed * SINGLE_HAND_RETURN_COMPENSATION),
        );
        unit.consecutiveFaults = 0;
      } else {
        unit.activeRescue = rescue;
      }
      return {
        ...state,
        lastUnitId: outcome.chunkId,
        lastClusterId: unit.clusterId ?? null,
        units: { ...state.units, [outcome.chunkId]: unit },
      };
    }

    // speed-step-down or waiting-rescue clears after 1 attempt
    unit.activeRescue = null;
    unit.consecutiveFaults = 0;
  }

  // 2. Phase 0 progression (0.55x decoding, Stage 0 + 1 steady pass, 3-min hard cap)
  if (unit.phase === 0) {
    unit.phase0ElapsedMs += Math.max(0, outcome.durationMs);
    const steadyPassOk = outcome.pitchAccuracy >= 0.8 && !outcome.stallDetected;
    if ((unit.phase0Stage0Graduated && steadyPassOk) || unit.phase0ElapsedMs >= PHASE0_HARD_CAP_MS) {
      unit.phase = 1;
      unit.phase0SteadyPassDone = true;
    }
  }

  // 3. Detect in-bout fault (< 80% accuracy, stall, or repeated step/junction fault)
  const boundaryFault =
    Boolean(outcome.boundaryFault) || outcome.junctionHesitationRatio > 1.6;
  const repeatedStepFault = hasStepOverlap(prevUnit.lastFaultedSteps, outcome.faultedSteps);
  const repeatedBoundaryFault =
    prevUnit.consecutiveFaults >= 1 &&
    boundaryFault &&
    prevUnit.lastFaultedJunctionId !== undefined &&
    prevUnit.lastFaultedJunctionId === outcome.junction?.junctionId;

  const isFault =
    outcome.pitchAccuracy < 0.8 ||
    outcome.stallDetected ||
    repeatedStepFault ||
    repeatedBoundaryFault;

  if (isFault) {
    unit.consecutiveFaults = prevUnit.consecutiveFaults + 1;
    unit.lastFaultedSteps = outcome.faultedSteps ? [...outcome.faultedSteps] : [];
    unit.lastFaultedJunctionId = outcome.junction?.junctionId;
    unit.nonAdjacentCleanRounds = 0;
  } else {
    unit.consecutiveFaults = 0;
    unit.lastFaultedSteps = [];
    unit.lastFaultedJunctionId = undefined;
  }

  // 4. 2-consecutive-fault circuit-breaker in STRICT priority order
  if (unit.consecutiveFaults >= 2) {
    const boundaryJunc = resolveBoundaryJunction(unit, outcome, state.junctions);
    if (boundaryFault && boundaryJunc) {
      unit.activeRescue = {
        kind: "bridge",
        skippableViaC8: true,
        junction: boundaryJunc,
        preRescueSpeed: unit.workingSpeed,
        targetSpeed: Math.max(MIN_WORKING_SPEED, roundSpeed(unit.workingSpeed * 0.88)),
        smoothPassesDone: 0,
        attempts: 0,
        startedAtMs: outcome.nowMs,
      };
    } else if (
      outcome.practiceMode === "both" &&
      Math.max(outcome.dominantHandFaultRatio.rh, outcome.dominantHandFaultRatio.lh) >= 0.75
    ) {
      const isolatedHand = outcome.dominantHandFaultRatio.rh >= 0.75 ? "RH" : "LH";
      const cappedSpeed = Math.min(SINGLE_HAND_ISOLATION_SPEED_CAP, unit.workingSpeed);
      unit.handMode = isolatedHand === "RH" ? "rh-only" : "lh-only";
      unit.activeRescue = {
        kind: "single-hand-isolation",
        skippableViaC8: true,
        isolatedHand,
        preRescueSpeed: unit.workingSpeed,
        targetSpeed: Math.max(MIN_WORKING_SPEED, cappedSpeed),
        smoothPassesDone: 0,
        attempts: 0,
        startedAtMs: outcome.nowMs,
      };
    } else if (unit.workingSpeed > 0.55) {
      const steppedDown = Math.max(
        MIN_WORKING_SPEED,
        roundSpeed(unit.workingSpeed * CIRCUIT_BREAKER_SPEED_STEP_DOWN),
      );
      unit.workingSpeed = steppedDown;
      unit.activeRescue = {
        kind: "speed-step-down",
        skippableViaC8: true,
        preRescueSpeed: prevUnit.workingSpeed,
        targetSpeed: steppedDown,
        smoothPassesDone: 0,
        attempts: 0,
        startedAtMs: outcome.nowMs,
      };
    } else {
      unit.workingSpeed = MIN_WORKING_SPEED;
      unit.activeRescue = {
        kind: "waiting-rescue",
        skippableViaC8: true,
        preRescueSpeed: prevUnit.workingSpeed,
        targetSpeed: MIN_WORKING_SPEED,
        smoothPassesDone: 0,
        attempts: 0,
        startedAtMs: outcome.nowMs,
      };
    }

    return {
      ...state,
      lastUnitId: outcome.chunkId,
      lastClusterId: unit.clusterId ?? null,
      units: { ...state.units, [outcome.chunkId]: unit },
    };
  }

  // 5. Anti-entrenchment: manual single-hand sessions must never advance Both Hands metrics
  if (state.isManualSingleHandSession || outcome.practiceMode !== "both") {
    unit.easyEligible = false;
    return {
      ...state,
      lastUnitId: outcome.chunkId,
      lastClusterId: unit.clusterId ?? null,
      units: { ...state.units, [outcome.chunkId]: unit },
    };
  }

  // 6. Clean bout progression: Phase 1 -> 2 promotion & zoned relative speed ladder
  if (outcome.grade >= 3 && !outcome.stallDetected) {
    if (isNonAdjacentReturn || prevUnit.reviewCount === 0) {
      unit.nonAdjacentCleanRounds += 1;
    }

    unit.easyEligible =
      unit.handStage === "both" &&
      unit.workingSpeed >= 0.85 &&
      outcome.pitchAccuracy === 1 &&
      outcome.interiorHesitationCount === 0;

    // Phase 1 -> Phase 2: Both Hands, >= 0.75x, and (>= 2 non-adjacent clean rounds OR >= 1 sleep night)
    if (
      unit.phase === 1 &&
      unit.workingSpeed >= 0.75 &&
      (unit.nonAdjacentCleanRounds >= 2 || unit.sleepConsolidatedNights >= 1)
    ) {
      unit.phase = 2;
    }

    // Zoned sub-maximal speed ladder
    if (unit.workingSpeed < 0.65) {
      // Decoding zone (+12-15%) can exit quickly
      const nextSpd = computeNextSpeedStep(unit.workingSpeed, 1.0);
      if (nextSpd > unit.workingSpeed) {
        unit.workingSpeed = nextSpd;
        unit.stableSpeed = nextSpd;
        unit.stabilityDays = Math.min(unit.stabilityDays * 0.5, 2.0);
        unit.sleepConsolidatedNights = 0;
      }
    } else if (unit.speedUpgradesThisSession < 1) {
      const canUpgradeInCoreOrSprint =
        Boolean(outcome.isColdFirstPass) || unit.nonAdjacentCleanRounds >= 2;
      if (unit.workingSpeed < 1.0 && canUpgradeInCoreOrSprint) {
        const nextSpd = computeNextSpeedStep(unit.workingSpeed, 1.0);
        if (nextSpd > unit.workingSpeed) {
          unit.workingSpeed = nextSpd;
          unit.stableSpeed = nextSpd;
          unit.speedUpgradesThisSession += 1;
          unit.stabilityDays = Math.min(unit.stabilityDays * 0.5, 2.0);
          unit.sleepConsolidatedNights = 0;
        }
      } else if (
        unit.workingSpeed >= 1.0 &&
        state.overspeedProbeEnabled &&
        unit.sleepConsolidatedNights >= 2 &&
        unit.chunk.measureCount <= 4
      ) {
        unit.workingSpeed = OVERSPEED_PROBE_SPEED;
        unit.speedUpgradesThisSession += 1;
      }
    }
  }

  return {
    ...state,
    lastUnitId: outcome.chunkId,
    lastClusterId: unit.clusterId ?? null,
    units: { ...state.units, [outcome.chunkId]: unit },
  };
}

/**
 * Checks whether the single `Early Macro-Rest` (~2 min) should be offered now:
 * ONLY in 25 / 40 min sessions after 12–15 min elapsed, never in 15 min sessions, max once.
 */
export function shouldOfferEarlyMacroRest(
  state: MotorSchedulerState,
  nowMs: number,
): boolean {
  if (!state.earlyMacroRestEligible || state.earlyMacroRestOffered) {
    return false;
  }
  return nowMs - state.startedAtMs >= EARLY_MACRO_REST_MIN_ELAPSED_MS;
}

/** Dismisses / skips `Early Macro-Rest` via C8 or button and advances to next scheduled unit. */
export function skipEarlyMacroRest(
  state: MotorSchedulerState,
  nowMs: number,
): MotorSchedulerState {
  if (!state.earlyMacroRestActive) return state;
  const cleared: MotorSchedulerState = {
    ...state,
    earlyMacroRestActive: false,
  };
  return advanceMotorScheduler(cleared, nowMs);
}

/** Skips an active 2-consecutive-fault circuit-breaker rescue via C8. */
export function skipCircuitBreaker(
  state: MotorSchedulerState,
  chunkId: string,
  nowMs = state.startedAtMs,
): MotorSchedulerState {
  const unit = state.units[chunkId];
  if (!unit || !unit.activeRescue) return state;
  const cleared: MotorSchedulerState = {
    ...state,
    units: {
      ...state.units,
      [chunkId]: {
        ...unit,
        handMode: "both",
        consecutiveFaults: 0,
        activeRescue: null,
      },
    },
  };
  return advanceMotorScheduler(cleared, nowMs);
}

function pickNextPoolUnit(
  state: MotorSchedulerState,
): { unit: SchedulerUnitRuntime; nextSerialCursor: number; nextPrng: number } | null {
  const poolUnits = state.activePool
    .map((id) => state.units[id])
    .filter((u): u is SchedulerUnitRuntime => Boolean(u));
  if (poolUnits.length === 0) return null;

  const isEligibleStrict = (u: SchedulerUnitRuntime) =>
    u.chunkId !== state.lastUnitId &&
    (!state.lastClusterId || !u.clusterId || u.clusterId !== state.lastClusterId);
  const isEligibleDiffChunk = (u: SchedulerUnitRuntime) => u.chunkId !== state.lastUnitId;

  const strictPool = poolUnits.filter(isEligibleStrict);
  const fallbackPool = poolUnits.filter(isEligibleDiffChunk);
  const eligible =
    strictPool.length > 0 ? strictPool : fallbackPool.length > 0 ? fallbackPool : poolUnits;

  const anyPhase2 = eligible.some((u) => u.phase === 2);
  let nextPrngSeed = state.prngState;
  let chosen: SchedulerUnitRuntime;

  if (anyPhase2 && eligible.length > 1) {
    const prng = nextPrng(state.prngState);
    nextPrngSeed = prng.nextSeed;
    chosen = eligible[Math.floor(prng.value * eligible.length) % eligible.length];
  } else {
    // Phase 1 serial rotation (`A -> B -> C -> A -> B -> C`)
    const startIdx = state.serialCursor % poolUnits.length;
    chosen = eligible[0];
    for (let offset = 0; offset < poolUnits.length; offset++) {
      const cand = poolUnits[(startIdx + offset) % poolUnits.length];
      if (eligible.some((e) => e.chunkId === cand.chunkId)) {
        chosen = cand;
        break;
      }
    }
  }

  return {
    unit: chosen,
    nextSerialCursor: (state.serialCursor + 1) % Math.max(1, poolUnits.length),
    nextPrng: nextPrngSeed,
  };
}

/**
 * Advances `MotorScheduler` to the next directive after completing a bout or rest:
 * checks active circuit-breaker rescues first, then Early Macro-Rest eligibility,
 * then planned items and Active Rotation Pool interleaving (Phase 1 serial / Phase 2 pseudorandom)
 * strictly enforcing the back-to-back & same-cluster anti-interference bans.
 */
export function advanceMotorScheduler(
  state: MotorSchedulerState,
  nowMs: number,
): MotorSchedulerState {
  // 1. If the last unit triggered an active rescue, execute it next
  if (state.lastUnitId && state.units[state.lastUnitId]?.activeRescue) {
    const rescueUnit = state.units[state.lastUnitId];
    return {
      ...state,
      currentDirective: buildDirectiveForUnit(rescueUnit, state),
    };
  }

  // 2. Offer Early Macro-Rest once at 12-15 min in 25 / 40 min sessions
  if (shouldOfferEarlyMacroRest(state, nowMs)) {
    return {
      ...state,
      earlyMacroRestOffered: true,
      earlyMacroRestActive: true,
      currentDirective: {
        kind: "macro-rest",
        durationMs: EARLY_MACRO_REST_DURATION_MS,
        skippableViaC8: true,
      },
    };
  }

  // 3. Follow remaining planned items while strictly honoring back-to-back & same-cluster bans
  if (state.remainingPlannedItems.length > 0) {
    const headSegment = state.remainingPlannedItems[0].segment;
    const sameSegmentLimit = state.remainingPlannedItems.findIndex((i) => i.segment !== headSegment);
    const searchEnd =
      sameSegmentLimit === -1 ? state.remainingPlannedItems.length : sameSegmentLimit;

    let chosenIdx = state.remainingPlannedItems
      .slice(0, searchEnd)
      .findIndex((item) => {
        const uCluster = item.clusterId ?? state.units[item.chunk.chunkId]?.clusterId;
        return (
          item.chunk.chunkId !== state.lastUnitId &&
          (!state.lastClusterId || !uCluster || uCluster !== state.lastClusterId)
        );
      });
    if (chosenIdx === -1) {
      chosenIdx = state.remainingPlannedItems
        .slice(0, searchEnd)
        .findIndex((item) => item.chunk.chunkId !== state.lastUnitId);
    }
    if (chosenIdx === -1) chosenIdx = 0;

    const nextItem = state.remainingPlannedItems[chosenIdx];
    const nextRemaining = [
      ...state.remainingPlannedItems.slice(0, chosenIdx),
      ...state.remainingPlannedItems.slice(chosenIdx + 1),
    ];
    return {
      ...state,
      remainingPlannedItems: nextRemaining,
      currentDirective: buildDirectiveFromPlannedItem(nextItem, state),
    };
  }

  // 4. Cycle Active Rotation Pool (Phase 1 serial / Phase 2 pseudorandom)
  const picked = pickNextPoolUnit(state);
  if (!picked) {
    return {
      ...state,
      currentDirective: { kind: "completed" },
    };
  }

  return {
    ...state,
    serialCursor: picked.nextSerialCursor,
    prngState: picked.nextPrng,
    roundNumber: state.roundNumber + 1,
    currentDirective: buildDirectiveForUnit(picked.unit, state),
  };
}
