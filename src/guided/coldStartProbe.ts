import type { PlaybackClockAnchor } from "../audio/playbackEngine";
import type {
  ChunkJunction,
  MacroSection,
  MotorChunk,
  PassageCluster,
  PerformanceCue,
  SwitchPoint,
} from "../chunking/types";
import { scoreCoordToTick } from "../domain/scoreCoord";
import type {
  MeasureTimeline,
  PracticeStep,
  ScoreCoord,
  ScoreDocument,
} from "../domain/types";
import type { MidiInputEvent } from "../midi/webMidi";
import type { BoundedAttributionResult, SwitchPointSpec } from "./boundedAttribution";
import {
  EIGHT_HOURS_MS,
  compareScoreCoord,
  diffLocalDateDays,
  type MotorUnitMemoryState,
  type PiecePracticeState,
} from "./motorFsrs";
import type { PlannedQueueItem } from "./sessionPlanner";

export const COLD_PROBE_MIN_ACCURACY = 0.92;
export const COLD_PROBE_MAX_ENTRY_SEC = 0.6;
export const COLD_PROBE_MAX_ENTRY_BEATS = 1.0;
export const COLD_PROBE_MAX_RETRIES = 1;
export const COLD_PROBE_DEFAULT_MIN_MEASURES = 2;
export const COLD_PROBE_DEFAULT_MAX_MEASURES = 4;
export const COLD_PROBE_SWITCH_POST_MEASURES = 2;

export interface ColdProbeSpan {
  cue: PerformanceCue;
  anchorChunk: MotorChunk;
  startCoord: ScoreCoord;
  endCoord: ScoreCoord;
  startScoreSec: number;
  endScoreSec: number;
  expectedSteps: PracticeStep[];
  countInBeats: number;
  switchPointSpec?: SwitchPointSpec;
}

export interface ColdStartProbeEvaluation {
  cueId: string;
  cueLabel: string;
  cueCoord: ScoreCoord;
  passed: boolean;
  entryHesitationMs: number;
  entryHesitationBeats: number;
  entryTimedOut: boolean;
  pitchAccuracy: number;
  stallDetected: boolean;
  branchDivergenceDetected: boolean;
  flaggedLabel: string | null;
  canRetryA0: boolean;
  canContinueC8: true;
  retriesUsed: number;
  queuedBridgeJunction?: ChunkJunction;
  reasonSummary: string;
}

function nextPrng(seed: number): { value: number; nextSeed: number } {
  const nextSeed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
  return { value: nextSeed / 0x100000000, nextSeed };
}

function hasUnitCompletedInitialLinking(
  chunkId: string,
  chunkStates: Record<string, MotorUnitMemoryState>,
  inSessionCompletedChunkIds?: ReadonlySet<string>,
): boolean {
  if ((chunkStates[chunkId]?.reviewCount ?? 0) > 0) return true;
  return Boolean(inSessionCompletedChunkIds?.has(chunkId));
}

/**
 * Unlocks Chaffin cold-start retrieval probes locally once `>= 1` `MacroSection`
 * OR `>= 3` contiguous `MotorChunk`s have completed Stage 0 + initial linking.
 * Never interrupts early decoding.
 */
export function isColdProbeLocallyUnlocked(params: {
  macroSections: readonly MacroSection[];
  motorChunks: readonly MotorChunk[];
  piecePracticeState: PiecePracticeState | null;
  inSessionCompletedChunkIds?: ReadonlySet<string>;
}): boolean {
  const { macroSections, motorChunks, piecePracticeState, inSessionCompletedChunkIds } = params;
  const chunkStates = piecePracticeState?.chunkStates ?? {};

  for (const section of macroSections) {
    if (section.chunkIds.length === 0) continue;
    if (
      section.chunkIds.every((id) =>
        hasUnitCompletedInitialLinking(id, chunkStates, inSessionCompletedChunkIds),
      )
    ) {
      return true;
    }
  }

  let contiguous = 0;
  const ordered = [...motorChunks].sort((a, b) => a.index - b.index);
  for (const chunk of ordered) {
    if (hasUnitCompletedInitialLinking(chunk.chunkId, chunkStates, inSessionCompletedChunkIds)) {
      contiguous += 1;
      if (contiguous >= 3) return true;
    } else {
      contiguous = 0;
    }
  }

  return false;
}

function findMatchingSwitchPoint(
  cue: PerformanceCue,
  endCoord: ScoreCoord,
  passageClusters: readonly PassageCluster[],
): SwitchPoint | undefined {
  for (const cluster of passageClusters) {
    for (const sp of cluster.switchPoints) {
      if (cue.switchPointId && sp.switchId === cue.switchPointId) return sp;
      if (
        sp.measureIndex >= cue.measureIndex &&
        sp.measureIndex <= endCoord.measureIndex
      ) {
        return sp;
      }
    }
    for (const inst of cluster.instances) {
      const sp = inst.switchPoint;
      if (!sp) continue;
      if (cue.switchPointId && sp.switchId === cue.switchPointId) return sp;
      if (
        sp.measureIndex >= cue.measureIndex &&
        sp.measureIndex <= endCoord.measureIndex
      ) {
        return sp;
      }
    }
  }
  return undefined;
}

/**
 * Computes end coordinate for a cold-start probe:
 * span to next `PerformanceCue` or 2–4 measures, ensuring `>= 2` measures past any `SwitchPoint`.
 */
export function computeColdProbeEndCoord(params: {
  cue: PerformanceCue;
  allCues: readonly PerformanceCue[];
  motorChunks: readonly MotorChunk[];
  passageClusters?: readonly PassageCluster[];
}): ScoreCoord {
  const { cue, allCues, motorChunks, passageClusters = [] } = params;
  const maxMeasure = motorChunks.reduce(
    (max, c) => Math.max(max, c.endMeasureIndex),
    cue.measureIndex,
  );
  const pieceEndMeasure = maxMeasure + 1;
  const isSwitchCue =
    cue.kind === "switch" ||
    cue.roles.includes("switch") ||
    Boolean(cue.switchPointId);

  const tentativeEndCoord: ScoreCoord = {
    measureIndex: Math.min(pieceEndMeasure, cue.measureIndex + 3),
    beatNum: 0,
    beatDen: 1,
  };
  const sp = findMatchingSwitchPoint(cue, tentativeEndCoord, passageClusters);
  const switchAnchorMeasure = sp ? Math.max(cue.measureIndex, sp.measureIndex) : cue.measureIndex;

  // At least 2 full measures PAST the SwitchPoint measure => endCoord.measureIndex >= switchAnchorMeasure + 3
  const minEndAfterSwitch = isSwitchCue || sp
    ? Math.min(pieceEndMeasure, switchAnchorMeasure + COLD_PROBE_SWITCH_POST_MEASURES + 1)
    : Math.min(pieceEndMeasure, cue.measureIndex + COLD_PROBE_DEFAULT_MIN_MEASURES);

  const maxEndMeasure = Math.min(
    pieceEndMeasure,
    Math.max(minEndAfterSwitch, cue.measureIndex + COLD_PROBE_DEFAULT_MAX_MEASURES),
  );
  const defaultSpanMeasures = isSwitchCue || sp ? 3 : 3;
  const capEndCoord: ScoreCoord = {
    measureIndex: Math.min(
      pieceEndMeasure,
      Math.max(minEndAfterSwitch, Math.min(maxEndMeasure, cue.measureIndex + defaultSpanMeasures)),
    ),
    beatNum: 0,
    beatDen: 1,
  };

  const nextCue = [...allCues]
    .filter((other) => !other.hidden && compareScoreCoord(other.coord, cue.coord) > 0)
    .sort((a, b) => compareScoreCoord(a.coord, b.coord))[0];

  if (nextCue) {
    const minEndCoord: ScoreCoord = { measureIndex: minEndAfterSwitch, beatNum: 0, beatDen: 1 };
    if (compareScoreCoord(nextCue.coord, minEndCoord) >= 0) {
      return compareScoreCoord(nextCue.coord, capEndCoord) < 0 ? nextCue.coord : capEndCoord;
    }
    return minEndCoord;
  }

  return capEndCoord;
}

/**
 * Resolves full playback/attribution span for a cold-start probe with zero run-up
 * and 1-measure `Count-In`.
 */
export function computeColdProbeSpan(params: {
  cue: PerformanceCue;
  allCues: readonly PerformanceCue[];
  motorChunks: readonly MotorChunk[];
  passageClusters?: readonly PassageCluster[];
  scoreDoc: ScoreDocument;
  practiceSteps: readonly PracticeStep[];
}): ColdProbeSpan {
  const { cue, allCues, motorChunks, passageClusters = [], scoreDoc, practiceSteps } = params;
  const endCoord = computeColdProbeEndCoord({
    cue,
    allCues,
    motorChunks,
    passageClusters,
  });

  const anchorChunk =
    motorChunks.find(
      (c) => cue.measureIndex >= c.startMeasureIndex && cue.measureIndex <= c.endMeasureIndex,
    ) ?? motorChunks[0];

  const startTick = scoreCoordToTick(scoreDoc, cue.coord);
  const endTick = scoreCoordToTick(scoreDoc, endCoord);
  const steps = practiceSteps.filter(
    (s) => s.onsetTick >= startTick - 1e-6 && s.onsetTick < endTick - 1e-6,
  );

  const startTl =
    scoreDoc.measureTimelines[cue.measureIndex] ?? scoreDoc.measureTimelines[0];
  const endMeasureIdx = Math.max(
    cue.measureIndex,
    endCoord.beatNum === 0 && endCoord.measureIndex > 0
      ? endCoord.measureIndex - 1
      : endCoord.measureIndex,
  );
  const endTl =
    scoreDoc.measureTimelines[Math.min(endMeasureIdx, scoreDoc.measureTimelines.length - 1)] ??
    startTl;

  const startScoreSec = steps[0]?.onsetSec ?? startTl?.startSec ?? 0;
  const endScoreSec = Math.max(
    startScoreSec + 0.1,
    endTl?.endSec ?? startScoreSec + 2,
  );
  const countInBeats = Math.max(1, startTl?.timeBeats ?? 4);

  const sp = findMatchingSwitchPoint(cue, endCoord, passageClusters);
  const switchPointSpec: SwitchPointSpec | undefined =
    sp && sp.alternateBranchMidis.length > 0
      ? {
          startScoreSec:
            scoreDoc.measureTimelines[sp.measureIndex]?.startSec ?? startScoreSec,
          alternateBranches: [
            {
              branchId: sp.alternateBranchLabels[0] ?? sp.switchId,
              stepMidis: sp.alternateBranchMidis,
            },
          ],
        }
      : undefined;

  return {
    cue,
    anchorChunk,
    startCoord: cue.coord,
    endCoord,
    startScoreSec,
    endScoreSec,
    expectedSteps: steps,
    countInBeats,
    ...(switchPointSpec ? { switchPointSpec } : {}),
  };
}

/**
 * True ONLY when the target unit has crossed a sleep boundary (local calendar day changed
 * AND `>= 8 h` elapsed). Same-day probes return `false` so they never inflate `S`.
 */
export function computeColdProbeIsCrossDay(
  unitState: MotorUnitMemoryState | undefined,
  nowTimestampMs: number,
  nowLocalDateKey: string,
): boolean {
  if (!unitState || unitState.reviewCount === 0) return false;
  if (!unitState.lastSleepGateDateKey || unitState.lastEventTimestampMs === null) {
    return false;
  }
  const dayChanged =
    nowLocalDateKey > unitState.lastSleepGateDateKey &&
    diffLocalDateDays(unitState.lastSleepGateDateKey, nowLocalDateKey) >= 1;
  const elapsedMs = nowTimestampMs - unitState.lastEventTimestampMs;
  return dayChanged && elapsedMs >= EIGHT_HOURS_MS;
}

function buildFallbackCues(chunks: readonly MotorChunk[]): PerformanceCue[] {
  return chunks.map((chunk, idx) => ({
    cueId: `cue-fallback-${chunk.chunkId}`,
    kind: "structural" as const,
    roles: ["structural" as const],
    priorityWeight: 1.5,
    coord: chunk.startCoord,
    measureIndex: chunk.startMeasureIndex,
    label: `m.${chunk.startMeasureIndex + 1} 块${idx + 1}起点`,
    collapsed: false,
    isPrimary: true,
    sectionId: chunk.sectionId,
  }));
}

/**
 * Generates 2–4 random Chaffin cold-start probe queue items from unlocked regions
 * (or from all/scoped chunks in manual "冷启动专项测验" mode).
 */
export function buildColdStartProbeItems(params: {
  macroSections: readonly MacroSection[];
  motorChunks: readonly MotorChunk[];
  performanceCues: readonly PerformanceCue[];
  passageClusters?: readonly PassageCluster[];
  piecePracticeState: PiecePracticeState | null;
  selectedMacroSectionId?: string | null;
  inSessionCompletedChunkIds?: ReadonlySet<string>;
  nowTimestampMs: number;
  nowLocalDateKey: string;
  count?: number;
  seed?: number;
  manualMode?: boolean;
}): PlannedQueueItem[] {
  const {
    macroSections,
    motorChunks,
    performanceCues,
    passageClusters = [],
    piecePracticeState,
    selectedMacroSectionId = null,
    inSessionCompletedChunkIds,
    nowTimestampMs,
    nowLocalDateKey,
    count = 3,
    seed = 2026,
    manualMode = false,
  } = params;

  const orderedChunks = [...motorChunks].sort((a, b) => a.index - b.index);
  if (orderedChunks.length === 0) return [];

  const chunkStates = piecePracticeState?.chunkStates ?? {};

  if (
    !manualMode &&
    !isColdProbeLocallyUnlocked({
      macroSections,
      motorChunks: orderedChunks,
      piecePracticeState,
      inSessionCompletedChunkIds,
    })
  ) {
    return [];
  }

  const scopedChunks =
    selectedMacroSectionId !== null
      ? orderedChunks.filter((c) => c.sectionId === selectedMacroSectionId)
      : orderedChunks;
  const activeChunks = scopedChunks.length > 0 ? scopedChunks : orderedChunks;

  const unlockedMeasures = new Set<number>();
  for (const c of orderedChunks) {
    const practiced =
      manualMode ||
      hasUnitCompletedInitialLinking(c.chunkId, chunkStates, inSessionCompletedChunkIds);
    if (practiced) {
      for (let m = c.startMeasureIndex; m <= c.endMeasureIndex; m++) {
        unlockedMeasures.add(m);
      }
    }
  }

  const scopedMeasureSet = new Set<number>();
  for (const c of activeChunks) {
    for (let m = c.startMeasureIndex; m <= c.endMeasureIndex; m++) {
      scopedMeasureSet.add(m);
    }
  }

  const visibleCues = performanceCues.filter(
    (c) =>
      !c.hidden &&
      !c.collapsed &&
      unlockedMeasures.has(c.measureIndex) &&
      (!manualMode || scopedMeasureSet.has(c.measureIndex)),
  );
  const candidatePool =
    visibleCues.length > 0
      ? visibleCues
      : manualMode
        ? buildFallbackCues(activeChunks)
        : [];
  if (candidatePool.length === 0) return [];

  // Shuffle within priority tiers deterministically so Switch > Structural > Technical
  let prngState = seed >>> 0 || 1;
  const jittered = candidatePool.map((cue) => {
    const r = nextPrng(prngState);
    prngState = r.nextSeed;
    return {
      cue,
      score: cue.priorityWeight + r.value * 0.45,
    };
  });
  jittered.sort((a, b) => b.score - a.score || a.cue.measureIndex - b.cue.measureIndex);

  const targetCount = Math.max(
    1,
    Math.min(Math.max(2, Math.min(4, count)), jittered.length),
  );
  const chosenCues = jittered.slice(0, targetCount).map((x) => x.cue);

  return chosenCues
    .map((cue, idx): PlannedQueueItem | null => {
      const anchorChunk =
        orderedChunks.find(
          (c) => cue.measureIndex >= c.startMeasureIndex && cue.measureIndex <= c.endMeasureIndex,
        ) ?? activeChunks[0];
      if (!anchorChunk) return null;
      const st = chunkStates[anchorChunk.chunkId];
      const probeEndCoord = computeColdProbeEndCoord({
        cue,
        allCues: performanceCues.length > 0 ? performanceCues : candidatePool,
        motorChunks: orderedChunks,
        passageClusters,
      });
      return {
        itemId: `${manualMode ? "manual-probe" : "probe"}-${idx}-${cue.cueId}`,
        segment: "closing-probe",
        boutKind: "cold-probe",
        chunk: anchorChunk,
        cue,
        probeEndCoord,
        skipStage0: true,
        isColdFirstPass: computeColdProbeIsCrossDay(st, nowTimestampMs, nowLocalDateKey),
        targetSpeed: st ? st.stableSpeed : 0.75,
        estimatedDurationSec: 30,
      };
    })
    .filter((item): item is PlannedQueueItem => item !== null);
}

function getStartBeatMs(
  measureTimelines: readonly MeasureTimeline[] | undefined,
  measureIndex: number,
  speed: number,
): number {
  const tl = measureTimelines?.[measureIndex];
  if (tl && tl.timeBeats > 0 && tl.endSec > tl.startSec) {
    return (((tl.endSec - tl.startSec) / tl.timeBeats) / Math.max(0.25, speed)) * 1000;
  }
  return 500 / Math.max(0.25, speed);
}

function findCorrespondingBridgeJunction(
  cue: PerformanceCue,
  chunkJunctions: readonly ChunkJunction[],
): ChunkJunction | undefined {
  if (cue.junctionId) {
    const exact = chunkJunctions.find((j) => j.junctionId === cue.junctionId);
    if (exact) return exact;
  }
  const switchTagged = chunkJunctions.filter(
    (j) =>
      j.reasonTags.includes("switch-point") ||
      j.dimensions.d5SwitchPointInterference > 0,
  );
  const pool = switchTagged.length > 0 ? switchTagged : chunkJunctions;
  let best: ChunkJunction | undefined;
  let bestDist = Infinity;
  for (const j of pool) {
    const dist = Math.abs(j.measureIndex - cue.measureIndex);
    if (dist < bestDist) {
      bestDist = dist;
      best = j;
    }
  }
  return best;
}

/**
 * Evaluates a Chaffin cold-start probe bout using gentle pass criteria:
 * - entry hesitation `<= 1 beat` / `<= 0.6 s`
 * - NO `switchBranchMismatch`
 * - `pitchAccuracy >= 92%`
 * - NO stall
 *
 * Failure never locks: offers 1 immediate `A0` retry OR `C8` log-and-continue,
 * and on `SwitchPoint` alternate-branch mismatch flags branch divergence and
 * resolves the corresponding `ChunkJunction` for automatic `Bridge Window` queuing.
 */
export function evaluateColdStartProbeOutcome(params: {
  attribution: BoundedAttributionResult;
  clockAnchor: PlaybackClockAnchor;
  expectedSteps: readonly PracticeStep[];
  midiEvents: readonly MidiInputEvent[];
  measureTimelines?: readonly MeasureTimeline[];
  cue: PerformanceCue;
  chunkJunctions: readonly ChunkJunction[];
  retriesUsed: number;
  isExemptCommandKey?: (event: MidiInputEvent) => boolean;
  isExemptPeekKey?: (event: MidiInputEvent) => boolean;
}): ColdStartProbeEvaluation {
  const {
    attribution,
    clockAnchor,
    expectedSteps,
    midiEvents,
    measureTimelines,
    cue,
    chunkJunctions,
    retriesUsed,
    isExemptCommandKey,
    isExemptPeekKey,
  } = params;

  const speed = clockAnchor.speedMultiplier > 0 ? clockAnchor.speedMultiplier : 1;
  const firstStep = expectedSteps[0];
  const beatMs = getStartBeatMs(
    measureTimelines,
    firstStep?.measureIndex ?? cue.measureIndex,
    speed,
  );

  const playableNoteOns = midiEvents
    .filter(
      (ev): ev is Extract<MidiInputEvent, { type: "noteon" }> =>
        ev.type === "noteon" &&
        ev.velocity > 1 &&
        !isExemptCommandKey?.(ev) &&
        !isExemptPeekKey?.(ev),
    )
    .sort((a, b) => a.timeStampMs - b.timeStampMs);

  const firstExpectedMs = firstStep
    ? clockAnchor.t0PerfMs + ((firstStep.onsetSec - clockAnchor.startScoreSec) / speed) * 1000
    : clockAnchor.t0PerfMs;
  const firstNoteOn = playableNoteOns[0];
  const entryHesitationMs = firstNoteOn
    ? Math.max(0, firstNoteOn.timeStampMs - firstExpectedMs)
    : Number.POSITIVE_INFINITY;
  const entryHesitationBeats = Number.isFinite(entryHesitationMs)
    ? entryHesitationMs / Math.max(1, beatMs)
    : Number.POSITIVE_INFINITY;

  const maxAllowedEntryMs = Math.max(COLD_PROBE_MAX_ENTRY_SEC * 1000, beatMs * COLD_PROBE_MAX_ENTRY_BEATS);
  const entryTimedOut = entryHesitationMs > maxAllowedEntryMs;

  const branchDivergenceDetected = attribution.fluency.switchBranchMismatch;
  const pitchAccuracy = attribution.fluency.pitchAccuracy;
  const stallDetected = attribution.fluency.stallDetected;

  const passed =
    !entryTimedOut &&
    !branchDivergenceDetected &&
    pitchAccuracy >= COLD_PROBE_MIN_ACCURACY &&
    !stallDetected;

  const queuedBridgeJunction = branchDivergenceDetected
    ? findCorrespondingBridgeJunction(cue, chunkJunctions)
    : undefined;

  const pct = Math.round(pitchAccuracy * 100);
  const canRetryA0 = !passed && retriesUsed < COLD_PROBE_MAX_RETRIES;

  let flaggedLabel: string | null = null;
  let reasonSummary = `冷启动通过（准确度 ${pct}%）`;
  if (!passed) {
    if (branchDivergenceDetected) {
      flaggedLabel = "Switch Point 分支跑偏";
      reasonSummary = queuedBridgeJunction
        ? `检出 ${flaggedLabel}，已自动将接缝「${queuedBridgeJunction.prepCueLabel}」入队 Bridge Window（按 A0 重测 1 次或 C8 入队并继续）`
        : `检出 ${flaggedLabel}（按 A0 重测 1 次或 C8 记录并继续）`;
    } else if (entryTimedOut) {
      reasonSummary = `起拍犹豫超时（${
        Number.isFinite(entryHesitationMs)
          ? `${(entryHesitationMs / 1000).toFixed(2)}s`
          : "未落键"
      }），${canRetryA0 ? "按 A0 立即重测 1 次，或 C8 记录薄弱点继续" : "按 C8 记录薄弱点继续"}`;
    } else if (stallDetected) {
      reasonSummary = `检索中出现明显卡顿（准确度 ${pct}%），${
        canRetryA0 ? "按 A0 立即重测 1 次，或 C8 记录薄弱点继续" : "按 C8 记录薄弱点继续"
      }`;
    } else {
      reasonSummary = `准确度 ${pct}% < 92%，${
        canRetryA0 ? "按 A0 立即重测 1 次，或 C8 记录薄弱点继续" : "按 C8 记录薄弱点继续"
      }`;
    }
  }

  return {
    cueId: cue.cueId,
    cueLabel: cue.customLabel || cue.label,
    cueCoord: cue.coord,
    passed,
    entryHesitationMs,
    entryHesitationBeats,
    entryTimedOut,
    pitchAccuracy,
    stallDetected,
    branchDivergenceDetected,
    flaggedLabel,
    canRetryA0,
    canContinueC8: true,
    retriesUsed,
    ...(queuedBridgeJunction ? { queuedBridgeJunction } : {}),
    reasonSummary,
  };
}
