import type {
  ChunkJunction,
  MacroSection,
  MotorChunk,
  PassageCluster,
  PassageInstance,
  PerformanceCue,
} from "../chunking/types";
import type { PracticeMode, ScoreCoord } from "../domain/types";
import {
  compareScoreCoord,
  roundSpeed,
  spanContains,
  type MotorUnitMemoryState,
  type PiecePracticeState,
} from "./motorFsrs";

export type GuidedTimeBoxMinutes = 15 | 25 | 40;

export interface PlannedQueueItem {
  itemId: string;
  segment: "opening-review" | "middle-build" | "closing-probe" | "quick-triage";
  boutKind: "chunk" | "bridge" | "cold-probe";
  chunk: MotorChunk;
  junction?: ChunkJunction;
  cue?: PerformanceCue;
  probeEndCoord?: ScoreCoord;
  skipStage0: boolean;
  isColdFirstPass: boolean;
  targetSpeed: number;
  estimatedDurationSec: number;
  clusterId?: string;
  isClusterWarmStart?: boolean;
  warmStartSourceChunkId?: string;
  motorReuse?: number;
  switchPointExcluded?: boolean;
}

export interface SessionPlan {
  mode: "standard" | "quick-triage";
  timeBoxMinutes: GuidedTimeBoxMinutes;
  budgetBreakdown: {
    totalBudgetSec: number;
    openingReviewRatio: number;
    middleBuildRatio: number;
    closingRetrievalRatio: number;
    openingBudgetSec: number;
    middleBudgetSec: number;
    closingBudgetSec: number;
  };
  openingReviews: PlannedQueueItem[];
  middleItems: PlannedQueueItem[];
  closingProbes: PlannedQueueItem[];
  items: PlannedQueueItem[];
  activePoolChunkIds: string[];
  poolTargetSize: number;
  overdueTotalCount: number;
  selectedOverdueCount: number;
  silentBacklogCapped: boolean;
  showOverdueRedBadge: false;
  coldProbeUnlocked: boolean;
  earlyMacroRestEligible: boolean;
  summaryText: string;
}

export interface SessionPlannerInput {
  timeBoxMinutes: GuidedTimeBoxMinutes;
  macroSections: readonly MacroSection[];
  motorChunks: readonly MotorChunk[];
  chunkJunctions: readonly ChunkJunction[];
  passageClusters: readonly PassageCluster[];
  performanceCues: readonly PerformanceCue[];
  piecePracticeState: PiecePracticeState | null;
  selectedMacroSectionId: string | null;
  practiceMode?: PracticeMode;
  nowTimestampMs: number;
  nowLocalDateKey: string;
  quickTriage?: boolean;
}

export const OVERDUE_BACKLOG_THRESHOLD = 10;
export const DECODING_DEFAULT_SPEED = 0.55;

function clamp(val: number, min: number, max: number): number {
  return val < min ? min : val > max ? max : val;
}

function estimateChunkBoutSec(chunk: MotorChunk, speed: number): number {
  const safeSpeed = Math.max(0.45, speed);
  const baseSec = Math.max(20, chunk.measureCount * 8);
  return Math.round(baseSec / safeSpeed);
}

function isUnitDueForReview(
  unitState: MotorUnitMemoryState | undefined,
  nowLocalDateKey: string,
): boolean {
  if (!unitState || unitState.reviewCount === 0) return false;
  if (unitState.needsRevisionReview) return true;
  if (unitState.nextReviewDateKey && unitState.nextReviewDateKey <= nowLocalDateKey) return true;
  return unitState.retrievability < 0.9;
}

function findClusterForChunk(
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

function findConsolidatedClusterPeer(
  chunk: MotorChunk,
  clusters: readonly PassageCluster[],
  allChunks: readonly MotorChunk[],
  chunkStates: Record<string, MotorUnitMemoryState>,
): {
  sourceChunkId: string;
  sourceState: MotorUnitMemoryState;
  motorReuse: number;
  hasTrailingSwitchPoint: boolean;
  clusterId: string;
} | null {
  const match = findClusterForChunk(chunk, clusters);
  if (!match) return null;
  const { cluster, instance } = match;

  let bestPeer: {
    sourceChunkId: string;
    sourceState: MotorUnitMemoryState;
    motorReuse: number;
  } | null = null;

  for (const peerInst of cluster.instances) {
    if (peerInst.instanceId === instance.instanceId) continue;
    const peerChunk = allChunks.find(
      (c) =>
        c.chunkId !== chunk.chunkId &&
        (spanContains(peerInst.startCoord, peerInst.endCoord, c.startCoord, c.endCoord) ||
          (c.startMeasureIndex >= peerInst.startMeasureIndex &&
            c.endMeasureIndex <= peerInst.endMeasureIndex)),
    );
    if (!peerChunk) continue;
    const peerState = chunkStates[peerChunk.chunkId];
    if (!peerState || peerState.reviewCount === 0) continue;
    const isConsolidated =
      peerState.sleepConsolidatedNights >= 1 ||
      (peerState.lastEffectiveGrade ?? 0) >= 3 ||
      peerState.stabilityDays >= 1.5;
    if (!isConsolidated) continue;

    const reuse = instance.isPrototype
      ? peerInst.motorReuse
      : peerInst.isPrototype
        ? instance.motorReuse
        : Math.min(instance.motorReuse, peerInst.motorReuse);
    if (reuse < 0.4) continue;

    if (
      !bestPeer ||
      reuse > bestPeer.motorReuse ||
      (reuse === bestPeer.motorReuse && peerState.stableSpeed > bestPeer.sourceState.stableSpeed)
    ) {
      bestPeer = {
        sourceChunkId: peerChunk.chunkId,
        sourceState: peerState,
        motorReuse: reuse,
      };
    }
  }

  if (!bestPeer) return null;

  return {
    ...bestPeer,
    hasTrailingSwitchPoint: Boolean(instance.switchPoint),
    clusterId: cluster.clusterId,
  };
}

/**
 * Scales `Active Rotation Pool` target size `K` between 2 and 5 based on
 * cognitive load (high-load polyphony: 2-3; standard: 3-4; pure review: 4-5).
 */
export function computeActivePoolSize(params: {
  candidates: readonly MotorChunk[];
  chunkStates: Record<string, MotorUnitMemoryState>;
  chunkJunctions: readonly ChunkJunction[];
  practiceMode?: PracticeMode;
}): number {
  const { candidates, chunkStates, chunkJunctions, practiceMode = "both" } = params;
  if (candidates.length === 0) return 0;

  let unreviewedCount = 0;
  let highDensityCount = 0;
  for (const chunk of candidates) {
    const st = chunkStates[chunk.chunkId];
    if (!st || st.reviewCount === 0) {
      unreviewedCount += 1;
      if (chunk.densityStepsPerMeasure >= 8) {
        highDensityCount += 1;
      }
    }
  }

  const allReviewed = unreviewedCount === 0;
  if (allReviewed) {
    return Math.min(candidates.length, candidates.length >= 5 ? 5 : 4);
  }

  const highRiskJunctions = chunkJunctions.filter((j) => j.isHighRisk || j.priorRisk >= 0.65).length;
  const highPolyphonyLoad =
    practiceMode === "both" &&
    (highDensityCount >= 2 || (unreviewedCount >= 2 && highRiskJunctions >= 2));
  if (highPolyphonyLoad) {
    return Math.min(candidates.length, highDensityCount >= 3 ? 2 : 3);
  }

  return Math.min(candidates.length, unreviewedCount >= 3 ? 3 : 4);
}

/**
 * Checks Chaffin cold-start retrieval unlock condition:
 * `>= 1` MacroSection OR `>= 3` contiguous MotorChunks have completed initial linking (`reviewCount > 0`).
 */
export function isColdProbeUnlocked(
  macroSections: readonly MacroSection[],
  motorChunks: readonly MotorChunk[],
  chunkStates: Record<string, MotorUnitMemoryState>,
): boolean {
  for (const section of macroSections) {
    if (section.chunkIds.length === 0) continue;
    if (section.chunkIds.every((id) => (chunkStates[id]?.reviewCount ?? 0) > 0)) {
      return true;
    }
  }

  let contiguous = 0;
  const ordered = [...motorChunks].sort((a, b) => a.index - b.index);
  for (const chunk of ordered) {
    if ((chunkStates[chunk.chunkId]?.reviewCount ?? 0) > 0) {
      contiguous += 1;
      if (contiguous >= 3) return true;
    } else {
      contiguous = 0;
    }
  }
  return false;
}

/**
 * Orders items while honoring the hard ban on back-to-back identical units and
 * adjacent same-`PassageCluster` near-variants whenever any alternative exists.
 */
export function orderAntiInterferenceUnits<
  T extends { chunk: MotorChunk; clusterId?: string },
>(items: readonly T[]): T[] {
  const remaining = [...items];
  const ordered: T[] = [];

  while (remaining.length > 0) {
    const prev = ordered[ordered.length - 1];
    let pickedIdx = -1;

    if (!prev) {
      pickedIdx = 0;
    } else {
      // Strict preference 1: different chunkId AND different PassageCluster
      pickedIdx = remaining.findIndex(
        (cand) =>
          cand.chunk.chunkId !== prev.chunk.chunkId &&
          (!prev.clusterId || !cand.clusterId || cand.clusterId !== prev.clusterId),
      );
      // Fallback 2: at least different chunkId
      if (pickedIdx === -1) {
        pickedIdx = remaining.findIndex((cand) => cand.chunk.chunkId !== prev.chunk.chunkId);
      }
      if (pickedIdx === -1) {
        pickedIdx = 0;
      }
    }

    ordered.push(remaining[pickedIdx]);
    remaining.splice(pickedIdx, 1);
  }

  return ordered;
}

function computeChunkJunctionRisk(
  chunk: MotorChunk,
  junctions: readonly ChunkJunction[],
): { maxRisk: number; hasSwitchPoint: boolean } {
  let maxRisk = 0;
  let hasSwitchPoint = false;
  for (const j of junctions) {
    if (j.leftChunkId === chunk.chunkId || j.rightChunkId === chunk.chunkId) {
      maxRisk = Math.max(maxRisk, j.posteriorRisk, j.priorRisk);
      if (j.reasonTags.includes("switch-point") || j.dimensions.d5SwitchPointInterference > 0) {
        hasSwitchPoint = true;
      }
    }
  }
  return { maxRisk, hasSwitchPoint };
}

function computeProbeEndCoord(
  cue: PerformanceCue,
  nextCue: PerformanceCue | undefined,
  motorChunks: readonly MotorChunk[],
): ScoreCoord {
  const maxMeasure = motorChunks.reduce(
    (max, c) => Math.max(max, c.endMeasureIndex),
    cue.measureIndex,
  );
  const spanMeasures = cue.kind === "switch" ? 3 : 2;
  const maxEndMeasure = Math.min(maxMeasure + 1, cue.measureIndex + spanMeasures);
  const capEndCoord: ScoreCoord = { measureIndex: maxEndMeasure, beatNum: 0, beatDen: 1 };

  if (nextCue && compareScoreCoord(nextCue.coord, cue.coord) > 0) {
    if (cue.kind === "switch" && nextCue.measureIndex < cue.measureIndex + 2) {
      return capEndCoord;
    }
    return compareScoreCoord(nextCue.coord, capEndCoord) < 0 ? nextCue.coord : capEndCoord;
  }
  return capEndCoord;
}

/**
 * Plans a Whole-Piece Quick Triage pass across all `MotorChunk`s in score order
 * without Stage 0 locking, gathering baseline Motor-FSRS telemetry in one sweep.
 */
export function planQuickTriageSession(input: SessionPlannerInput): SessionPlan {
  const orderedChunks = [...input.motorChunks].sort((a, b) => a.index - b.index);
  const chunkStates = input.piecePracticeState?.chunkStates ?? {};
  const items: PlannedQueueItem[] = orderedChunks.map((chunk, idx) => {
    const clusterMatch = findClusterForChunk(chunk, input.passageClusters);
    const st = chunkStates[chunk.chunkId];
    return {
      itemId: `triage-${idx}-${chunk.chunkId}`,
      segment: "quick-triage",
      boutKind: "chunk",
      chunk,
      skipStage0: true,
      isColdFirstPass: false,
      targetSpeed: st ? st.stableSpeed : 0.75,
      estimatedDurationSec: estimateChunkBoutSec(chunk, st ? st.stableSpeed : 0.75),
      ...(clusterMatch ? { clusterId: clusterMatch.cluster.clusterId } : {}),
    };
  });

  const totalBudgetSec = input.timeBoxMinutes * 60;
  return {
    mode: "quick-triage",
    timeBoxMinutes: input.timeBoxMinutes,
    budgetBreakdown: {
      totalBudgetSec,
      openingReviewRatio: 0,
      middleBuildRatio: 1,
      closingRetrievalRatio: 0,
      openingBudgetSec: 0,
      middleBudgetSec: totalBudgetSec,
      closingBudgetSec: 0,
    },
    openingReviews: [],
    middleItems: items,
    closingProbes: [],
    items,
    activePoolChunkIds: orderedChunks.map((c) => c.chunkId),
    poolTargetSize: orderedChunks.length,
    overdueTotalCount: 0,
    selectedOverdueCount: 0,
    silentBacklogCapped: false,
    showOverdueRedBadge: false,
    coldProbeUnlocked: false,
    earlyMacroRestEligible: input.timeBoxMinutes !== 15,
    summaryText: `全曲快速分诊：按乐谱顺序连续巡检全部 ${orderedChunks.length} 个组块，建立基础速度与保持率基线`,
  };
}

/**
 * Pure 3-segment Guided Session planner (`15 / 25 / 40 min`):
 * - Opening (40–50%): due Motor-FSRS cold reviews with guilt-free 4–5 item capping on 10+ backlog
 * - Middle (45–55%): interleaved Active Rotation Pool building + fragile ChunkJunction pre-warmers
 * - Closing reserve: unlocked Chaffin PerformanceCue cold-start probes
 */
export function planGuidedSession(input: SessionPlannerInput): SessionPlan {
  if (input.quickTriage) {
    return planQuickTriageSession(input);
  }

  const chunkStates = input.piecePracticeState?.chunkStates ?? {};
  const orderedChunks = [...input.motorChunks].sort((a, b) => a.index - b.index);
  const scopedChunks =
    input.selectedMacroSectionId !== null
      ? orderedChunks.filter((c) => c.sectionId === input.selectedMacroSectionId)
      : orderedChunks;
  const effectiveChunks = scopedChunks.length > 0 ? scopedChunks : orderedChunks;

  // 1. Identify due Motor-FSRS cold reviews
  const dueCandidates = effectiveChunks
    .map((chunk) => {
      const state = chunkStates[chunk.chunkId];
      if (!isUnitDueForReview(state, input.nowLocalDateKey)) return null;
      const jRisk = computeChunkJunctionRisk(chunk, input.chunkJunctions);
      const clusterMatch = findClusterForChunk(chunk, input.passageClusters);
      return {
        chunk,
        state: state!,
        retrievability: state!.retrievability,
        hasSwitchPoint: jRisk.hasSwitchPoint || Boolean(clusterMatch?.instance.switchPoint),
        maxJunctionRisk: jRisk.maxRisk,
        clusterId: clusterMatch?.cluster.clusterId,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Sort by lowest retrievability, then SwitchPoint / junction risk, then score position
  dueCandidates.sort((a, b) => {
    if (Math.abs(a.retrievability - b.retrievability) > 0.015) {
      return a.retrievability - b.retrievability;
    }
    if (a.hasSwitchPoint !== b.hasSwitchPoint) {
      return a.hasSwitchPoint ? -1 : 1;
    }
    if (Math.abs(a.maxJunctionRisk - b.maxJunctionRisk) > 0.05) {
      return b.maxJunctionRisk - a.maxJunctionRisk;
    }
    return a.chunk.index - b.chunk.index;
  });

  const overdueTotalCount = dueCandidates.length;
  const silentBacklogCapped = overdueTotalCount >= OVERDUE_BACKLOG_THRESHOLD;
  const maxDueCap = silentBacklogCapped ? (input.timeBoxMinutes === 15 ? 4 : 5) : dueCandidates.length;

  const coldProbeUnlocked = isColdProbeUnlocked(
    input.macroSections,
    orderedChunks,
    chunkStates,
  );

  const hasDue = dueCandidates.length > 0;
  const openingReviewRatio = hasDue ? (coldProbeUnlocked ? 0.42 : 0.45) : 0;
  const middleBuildRatio = hasDue ? (coldProbeUnlocked ? 0.48 : 0.55) : coldProbeUnlocked ? 0.85 : 1.0;
  const closingRetrievalRatio = roundSpeed(1 - openingReviewRatio - middleBuildRatio);

  const totalBudgetSec = input.timeBoxMinutes * 60;
  const openingBudgetSec = Math.round(totalBudgetSec * openingReviewRatio);
  const middleBudgetSec = Math.round(totalBudgetSec * middleBuildRatio);
  const closingBudgetSec = Math.max(0, totalBudgetSec - openingBudgetSec - middleBudgetSec);

  // Fill opening reviews within cap & budget
  const selectedDueRaw: typeof dueCandidates = [];
  let usedOpeningSec = 0;
  for (const cand of dueCandidates.slice(0, maxDueCap)) {
    const estSec = estimateChunkBoutSec(cand.chunk, cand.state.stableSpeed);
    if (selectedDueRaw.length >= 1 && usedOpeningSec + estSec > openingBudgetSec && silentBacklogCapped) {
      if (selectedDueRaw.length >= 4) break;
    }
    selectedDueRaw.push(cand);
    usedOpeningSec += estSec;
  }

  const openingOrdered = orderAntiInterferenceUnits(selectedDueRaw);
  const openingReviews: PlannedQueueItem[] = openingOrdered.map((item, idx) => ({
    itemId: `open-${idx}-${item.chunk.chunkId}`,
    segment: "opening-review",
    boutKind: "chunk",
    chunk: item.chunk,
    skipStage0: true,
    isColdFirstPass: true,
    targetSpeed: item.state.stableSpeed,
    estimatedDurationSec: estimateChunkBoutSec(item.chunk, item.state.stableSpeed),
    ...(item.clusterId ? { clusterId: item.clusterId } : {}),
  }));

  // 2. Middle segment: Active Rotation Pool building + fragile ChunkJunction pre-warmers
  const dueIdSet = new Set(openingReviews.map((r) => r.chunk.chunkId));
  const nonDueChunks = effectiveChunks.filter((c) => !dueIdSet.has(c.chunkId));
  const poolSource = nonDueChunks.length > 0 ? nonDueChunks : effectiveChunks;

  const poolTargetSize = computeActivePoolSize({
    candidates: poolSource,
    chunkStates,
    chunkJunctions: input.chunkJunctions,
    practiceMode: input.practiceMode,
  });

  // Select pool members avoiding putting multiple near-variants from same cluster if other chunks exist
  const selectedPoolChunks: MotorChunk[] = [];
  const usedClusterInPool = new Set<string>();
  for (const c of poolSource) {
    if (selectedPoolChunks.length >= poolTargetSize) break;
    const cm = findClusterForChunk(c, input.passageClusters);
    if (cm && usedClusterInPool.has(cm.cluster.clusterId) && poolSource.length > poolTargetSize) {
      continue;
    }
    selectedPoolChunks.push(c);
    if (cm) usedClusterInPool.add(cm.cluster.clusterId);
  }
  for (const c of poolSource) {
    if (selectedPoolChunks.length >= poolTargetSize) break;
    if (!selectedPoolChunks.some((s) => s.chunkId === c.chunkId)) {
      selectedPoolChunks.push(c);
    }
  }

  const middleRawItems: PlannedQueueItem[] = selectedPoolChunks.map((chunk, idx) => {
    const state = chunkStates[chunk.chunkId];
    const clusterMatch = findClusterForChunk(chunk, input.passageClusters);
    const warmPeer =
      !state || state.reviewCount === 0
        ? findConsolidatedClusterPeer(chunk, input.passageClusters, orderedChunks, chunkStates)
        : null;

    let skipStage0 = Boolean(state && state.reviewCount > 0);
    let targetSpeed = state ? state.stableSpeed : DECODING_DEFAULT_SPEED;
    let isClusterWarmStart = false;
    let warmStartSourceChunkId: string | undefined;
    let motorReuse: number | undefined;
    let switchPointExcluded = false;

    if (warmPeer) {
      isClusterWarmStart = true;
      warmStartSourceChunkId = warmPeer.sourceChunkId;
      motorReuse = warmPeer.motorReuse;
      switchPointExcluded = warmPeer.hasTrailingSwitchPoint;
      if (warmPeer.motorReuse >= 0.9) {
        skipStage0 = true;
        targetSpeed = warmPeer.sourceState.stableSpeed;
      } else {
        skipStage0 = false;
        targetSpeed = Math.max(
          DECODING_DEFAULT_SPEED,
          roundSpeed(warmPeer.sourceState.stableSpeed * (0.75 + 0.2 * warmPeer.motorReuse)),
        );
      }
    }

    return {
      itemId: `mid-${idx}-${chunk.chunkId}`,
      segment: "middle-build",
      boutKind: "chunk",
      chunk,
      skipStage0,
      isColdFirstPass: false,
      targetSpeed,
      estimatedDurationSec: estimateChunkBoutSec(chunk, targetSpeed),
      ...(clusterMatch ? { clusterId: clusterMatch.cluster.clusterId } : {}),
      ...(isClusterWarmStart
        ? {
            isClusterWarmStart: true,
            warmStartSourceChunkId,
            motorReuse,
            switchPointExcluded,
          }
        : {}),
    };
  });

  const middleChunkOrdered = orderAntiInterferenceUnits(middleRawItems);

  // Inject fragile ChunkJunction Bridge Window pre-warmers (priorRisk >= 0.65 or SwitchPoint)
  const sessionChunkIdSet = new Set([
    ...dueIdSet,
    ...selectedPoolChunks.map((c) => c.chunkId),
  ]);
  const fragileJunctions = input.chunkJunctions
    .filter(
      (j) =>
        (j.isHighRisk || j.priorRisk >= 0.65 || j.reasonTags.includes("switch-point")) &&
        (sessionChunkIdSet.has(j.leftChunkId) || sessionChunkIdSet.has(j.rightChunkId)),
    )
    .slice(0, 2);

  const middleItems: PlannedQueueItem[] = [];
  const injectedJunctionIds = new Set<string>();
  for (const item of middleChunkOrdered) {
    middleItems.push(item);
    const matchingJunction = fragileJunctions.find(
      (j) => !injectedJunctionIds.has(j.junctionId) && j.leftChunkId === item.chunk.chunkId,
    );
    if (matchingJunction) {
      injectedJunctionIds.add(matchingJunction.junctionId);
      middleItems.push({
        itemId: `mid-bridge-${matchingJunction.junctionId}`,
        segment: "middle-build",
        boutKind: "bridge",
        chunk: item.chunk,
        junction: matchingJunction,
        skipStage0: true,
        isColdFirstPass: false,
        targetSpeed: Math.max(0.5, roundSpeed(item.targetSpeed * 0.9)),
        estimatedDurationSec: 25,
      });
    }
  }
  for (const j of fragileJunctions) {
    if (injectedJunctionIds.has(j.junctionId)) continue;
    const anchorChunk =
      selectedPoolChunks.find((c) => c.chunkId === j.rightChunkId || c.chunkId === j.leftChunkId) ??
      effectiveChunks[0];
    if (anchorChunk) {
      middleItems.push({
        itemId: `mid-bridge-${j.junctionId}`,
        segment: "middle-build",
        boutKind: "bridge",
        chunk: anchorChunk,
        junction: j,
        skipStage0: true,
        isColdFirstPass: false,
        targetSpeed: DECODING_DEFAULT_SPEED,
        estimatedDurationSec: 25,
      });
    }
  }

  // 3. Closing retrieval reserve: 2-4 Chaffin PerformanceCue probes when unlocked
  const closingProbes: PlannedQueueItem[] = [];
  if (coldProbeUnlocked) {
    const practicedMeasures = new Set<number>();
    for (const chunk of orderedChunks) {
      if ((chunkStates[chunk.chunkId]?.reviewCount ?? 0) > 0) {
        for (let m = chunk.startMeasureIndex; m <= chunk.endMeasureIndex; m++) {
          practicedMeasures.add(m);
        }
      }
    }
    const unlockedCues = input.performanceCues
      .filter((c) => !c.hidden && !c.collapsed && practicedMeasures.has(c.measureIndex))
      .sort((a, b) => b.priorityWeight - a.priorityWeight || a.measureIndex - b.measureIndex);

    const probeCap = clamp(input.timeBoxMinutes === 15 ? 2 : 4, 2, 4);
    const chosenCues = unlockedCues.slice(0, probeCap);

    for (let i = 0; i < chosenCues.length; i++) {
      const cue = chosenCues[i];
      const nextCue = input.performanceCues.find(
        (other) => compareScoreCoord(other.coord, cue.coord) > 0 && !other.hidden,
      );
      const anchorChunk =
        orderedChunks.find(
          (c) => cue.measureIndex >= c.startMeasureIndex && cue.measureIndex <= c.endMeasureIndex,
        ) ?? effectiveChunks[0];
      if (!anchorChunk) continue;
      const st = chunkStates[anchorChunk.chunkId];
      closingProbes.push({
        itemId: `probe-${i}-${cue.cueId}`,
        segment: "closing-probe",
        boutKind: "cold-probe",
        chunk: anchorChunk,
        cue,
        probeEndCoord: computeProbeEndCoord(cue, nextCue, orderedChunks),
        skipStage0: true,
        isColdFirstPass: isUnitDueForReview(st, input.nowLocalDateKey),
        targetSpeed: st ? st.stableSpeed : 0.75,
        estimatedDurationSec: 30,
      });
    }
  }

  const items = [...openingReviews, ...middleItems, ...closingProbes];
  const summaryParts: string[] = [];
  if (openingReviews.length > 0) {
    summaryParts.push(
      silentBacklogCapped
        ? `开场已按保持率与接缝风险优先安排 ${openingReviews.length} 项冷检`
        : `开场冷检 ${openingReviews.length} 项`,
    );
  }
  summaryParts.push(`中段穿插池 ${selectedPoolChunks.length} 块`);
  if (fragileJunctions.length > 0) {
    summaryParts.push(`${fragileJunctions.length} 处接缝桥接`);
  }
  if (closingProbes.length > 0) {
    summaryParts.push(`尾声冷启检索 ${closingProbes.length} 题`);
  }

  return {
    mode: "standard",
    timeBoxMinutes: input.timeBoxMinutes,
    budgetBreakdown: {
      totalBudgetSec,
      openingReviewRatio,
      middleBuildRatio,
      closingRetrievalRatio,
      openingBudgetSec,
      middleBudgetSec,
      closingBudgetSec,
    },
    openingReviews,
    middleItems,
    closingProbes,
    items,
    activePoolChunkIds: selectedPoolChunks.map((c) => c.chunkId),
    poolTargetSize,
    overdueTotalCount,
    selectedOverdueCount: openingReviews.length,
    silentBacklogCapped,
    showOverdueRedBadge: false,
    coldProbeUnlocked,
    earlyMacroRestEligible: input.timeBoxMinutes !== 15,
    summaryText: summaryParts.join(" · "),
  };
}
