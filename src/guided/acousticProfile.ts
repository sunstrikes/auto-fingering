import type { PlaybackClockAnchor } from "../audio/playbackEngine";
import type {
  MeasureTimeline,
  PedalInterval,
  PracticeMode,
  PracticeStep,
  ScoreDocument,
} from "../domain/types";
import type { MidiInputEvent } from "../midi/webMidi";
import type { PracticeEvent } from "../persistence/storagePort";
import {
  attributeContinuousBout,
  type AttributedMatchedNote,
  type BoundedAttributionResult,
} from "./boundedAttribution";

export type AcousticStatus = "green" | "amber" | "red";
export type PedalHardwareKind = "switch" | "continuous" | "none";

export interface AcousticCapsule {
  id: "timing" | "voicing" | "articulation" | "pedal" | "hand-sync";
  label: string;
  valueText: string;
  status: AcousticStatus;
  detailText?: string;
}

export interface AcousticTroubleMeasure {
  measureIndex: number;
  severity: "amber" | "red";
  reasons: string[];
}

export interface AcousticProfileInput {
  attribution: BoundedAttributionResult;
  midiEvents: readonly MidiInputEvent[];
  speedMultiplier?: number;
  practiceMode?: PracticeMode;
  measureTimelines?: readonly MeasureTimeline[];
  pedalIntervals?: readonly PedalInterval[];
  expectedSteps?: readonly PracticeStep[];
  deviceNames?: readonly string[];
}

export interface AcousticProfileResult extends NonNullable<PracticeEvent["acoustic"]> {
  capsules: AcousticCapsule[];
  troubleMeasures: AcousticTroubleMeasure[];
  pedalHardware: PedalHardwareKind;
  voicingStatus?: AcousticStatus;
  articulationStatus?: AcousticStatus;
  pedalStatus?: AcousticStatus;
  handSyncMedianEffOffsetMs?: number;
  handSyncHeavySplitPct?: number;
}

/**
 * Extracts the strictly schema-compliant `PracticeEvent["acoustic"]` persistence subset.
 */
export function toPracticeEventAcoustic(
  profile: AcousticProfileResult,
): NonNullable<PracticeEvent["acoustic"]> {
  return {
    timingEvennessStatus: profile.timingEvennessStatus,
    timingNormNpvi: profile.timingNormNpvi,
    ...(profile.worstTimingMeasure !== undefined
      ? { worstTimingMeasure: profile.worstTimingMeasure }
      : {}),
    secondaryDimension: profile.secondaryDimension,
    ...(profile.voicingDeltaDb !== undefined ? { voicingDeltaDb: profile.voicingDeltaDb } : {}),
    ...(profile.melodyRankDominance !== undefined
      ? { melodyRankDominance: profile.melodyRankDominance }
      : {}),
    ...(profile.articulationKor !== undefined ? { articulationKor: profile.articulationKor } : {}),
    tertiaryDimension: profile.tertiaryDimension,
    ...(profile.pedalClarityRate !== undefined
      ? { pedalClarityRate: profile.pedalClarityRate }
      : {}),
    ...(profile.handSyncStatus !== undefined ? { handSyncStatus: profile.handSyncStatus } : {}),
    ...(profile.bleQuantizationRelaxed !== undefined
      ? { bleQuantizationRelaxed: profile.bleQuantizationRelaxed }
      : {}),
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function computeIqr(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.75) - quantile(sorted, 0.25);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function velocityToDbProxy(velocity: number): number {
  const v = Math.max(2, Math.min(127, velocity));
  return 40 * Math.log10(v / 127);
}

interface StepTimingPoint {
  stepIndex: number;
  measureIndex: number;
  onsetSec: number;
  strikeMs: number;
  expectedPerfMs: number;
}

function buildLeadStepSequence(
  matchedNotes: readonly AttributedMatchedNote[],
  practiceMode: PracticeMode,
): StepTimingPoint[] {
  const byStep = new Map<number, AttributedMatchedNote[]>();
  for (const m of matchedNotes) {
    if (m.note.isGrace) continue;
    const list = byStep.get(m.stepIndex);
    if (list) list.push(m);
    else byStep.set(m.stepIndex, [m]);
  }

  const orderedSteps = [...byStep.entries()].sort((a, b) => a[0] - b[0]);
  const points: StepTimingPoint[] = [];

  for (const [stepIndex, notes] of orderedSteps) {
    let leadNotes = notes;
    if (practiceMode === "both") {
      const rhNotes = notes.filter((n) => n.note.hand === "RH");
      if (rhNotes.length > 0) leadNotes = rhNotes;
    }
    const strikeMs = median(leadNotes.map((n) => n.strikeEvent.timeStampMs));
    points.push({
      stepIndex,
      measureIndex: leadNotes[0].note.measureIndex,
      onsetSec: leadNotes[0].note.onsetSec,
      strikeMs,
      expectedPerfMs: leadNotes[0].expectedPerfMs,
    });
  }
  return points;
}

function inferSpeedMultiplier(
  points: readonly StepTimingPoint[],
  explicitSpeed?: number,
): number {
  if (explicitSpeed !== undefined && Number.isFinite(explicitSpeed) && explicitSpeed > 0) {
    return explicitSpeed;
  }
  for (let i = 1; i < points.length; i++) {
    const scoreGapSec = points[i].onsetSec - points[i - 1].onsetSec;
    const expectedGapMs = points[i].expectedPerfMs - points[i - 1].expectedPerfMs;
    if (scoreGapSec > 0.01 && expectedGapMs > 5) {
      return Math.max(0.25, Math.min(2.0, (scoreGapSec * 1000) / expectedGapMs));
    }
  }
  return 1.0;
}

function computeTimingEvenness(
  attribution: BoundedAttributionResult,
  speedMultiplier: number | undefined,
  practiceMode: PracticeMode,
  bleScale: number,
): {
  status: AcousticStatus;
  normNpvi: number;
  worstMeasure?: number;
} {
  const points = buildLeadStepSequence(attribution.matchedNotes, practiceMode);
  const speed = inferSpeedMultiplier(points, speedMultiplier);
  const breakSteps = new Set(attribution.hesitationBreaks.map((b) => b.stepIndex));

  interface RatioInterval {
    ratio: number;
    actualMs: number;
    expectedMs: number;
    measureIndex: number;
  }

  const intervals: RatioInterval[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (breakSteps.has(b.stepIndex)) continue;
    const scoreGapSec = b.onsetSec - a.onsetSec;
    if (scoreGapSec <= 0.001) continue;
    const expectedMs = (scoreGapSec / speed) * 1000;
    const actualMs = b.strikeMs - a.strikeMs;
    if (expectedMs <= 1 || actualMs <= 0) continue;
    intervals.push({
      ratio: actualMs / expectedMs,
      actualMs,
      expectedMs,
      measureIndex: b.measureIndex,
    });
  }

  if (intervals.length < 2) {
    return { status: "green", normNpvi: 0 };
  }

  let pairSum = 0;
  const localNpviByIdx = new Array<number>(intervals.length).fill(0);
  for (let k = 0; k < intervals.length - 1; k++) {
    const r1 = intervals[k].ratio;
    const r2 = intervals[k + 1].ratio;
    const term = Math.abs(r1 - r2) / (r1 + r2);
    pairSum += term;
    localNpviByIdx[k] += term;
    localNpviByIdx[k + 1] += term;
  }

  const normNpvi = round2((100 / (intervals.length - 1)) * pairSum);

  let severeSpikes = 0;
  let extremeSpikes = 0;
  const measureDeviationScore = new Map<number, number>();

  for (let k = 0; k < intervals.length; k++) {
    const winStart = Math.max(0, k - 2);
    const winEnd = Math.min(intervals.length, k + 3);
    const localMed = median(intervals.slice(winStart, winEnd).map((x) => x.ratio));
    const relDev = Math.abs(intervals[k].ratio - localMed) / Math.max(0.1, localMed);
    const absDevMs = Math.abs(intervals[k].actualMs - localMed * intervals[k].expectedMs);
    const absFloorMs = Math.max(15 * bleScale, 0.08 * bleScale * intervals[k].expectedMs * localMed);

    if (relDev > 0.12 * bleScale && absDevMs > absFloorMs) {
      if (relDev > 0.2 * bleScale) severeSpikes += 1;
      if (relDev > 0.25 * bleScale) extremeSpikes += 1;
    }

    const score = localNpviByIdx[k] * 100 + relDev * 50;
    const mIdx = intervals[k].measureIndex;
    measureDeviationScore.set(mIdx, Math.max(measureDeviationScore.get(mIdx) ?? 0, score));
  }

  let status: AcousticStatus = "green";
  if (normNpvi >= 9.5 * bleScale || extremeSpikes >= 2) {
    status = "red";
  } else if (normNpvi >= 5.0 * bleScale || (intervals.length >= 5 && severeSpikes >= 2)) {
    status = "amber";
  }

  let worstMeasure: number | undefined;
  if (status !== "green" && measureDeviationScore.size > 0) {
    let bestScore = -1;
    for (const [mIdx, score] of measureDeviationScore) {
      if (score > bestScore) {
        bestScore = score;
        worstMeasure = mIdx;
      }
    }
  }

  return { status, normNpvi, worstMeasure };
}

function detectBleQuantization(
  midiEvents: readonly MidiInputEvent[],
  matchedNotes: readonly AttributedMatchedNote[],
  deviceNames?: readonly string[],
): boolean {
  if (deviceNames?.some((name) => /bluetooth|\bble\b/i.test(name))) {
    return true;
  }
  const midiOnly = midiEvents.filter((e) => e.source === "midi");
  if (midiOnly.some((e) => /bluetooth|\bble\b/i.test(e.portId))) {
    return true;
  }
  if (midiOnly.length < 6) return false;

  // Check if distinct expected steps (expected gap >= 15ms) coalesce onto identical timestamps
  const stepTimes = new Map<number, { strikeMs: number; expectedMs: number }>();
  for (const m of matchedNotes) {
    if (m.strikeEvent.source !== "midi") continue;
    if (!stepTimes.has(m.stepIndex)) {
      stepTimes.set(m.stepIndex, {
        strikeMs: m.strikeEvent.timeStampMs,
        expectedMs: m.expectedPerfMs,
      });
    }
  }
  const orderedStepTimes = [...stepTimes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  let coalescedPairs = 0;
  for (let i = 1; i < orderedStepTimes.length; i++) {
    const expGap = orderedStepTimes[i].expectedMs - orderedStepTimes[i - 1].expectedMs;
    const actGap = Math.abs(orderedStepTimes[i].strikeMs - orderedStepTimes[i - 1].strikeMs);
    if (expGap >= 15 && actGap <= 1.5) coalescedPairs += 1;
  }
  if (coalescedPairs >= 2) return true;

  // Check periodic BLE burst grid quantization (standard 7.5ms / 11.25ms / 15ms BLE intervals)
  const times = midiOnly.map((e) => e.timeStampMs).sort((a, b) => a - b);
  const tBase = times[0];
  const candidateQuanta = [15, 11.25, 7.5];
  const hasTimingResiduals = matchedNotes.some((m) => Math.abs(m.timingErrorMs) >= 1.5);

  for (const q of candidateQuanta) {
    let alignedCount = 0;
    const distinctRemainders = new Set<number>();
    for (const t of times) {
      const rel = t - tBase;
      const nearest = Math.round(rel / q) * q;
      if (Math.abs(rel - nearest) <= 0.9) {
        alignedCount += 1;
        distinctRemainders.add(Math.round(rel) % 100);
      }
    }
    if (alignedCount / times.length >= 0.85 && (hasTimingResiduals || distinctRemainders.size >= 3)) {
      return true;
    }
  }

  return false;
}

interface ClearedInterval {
  startMs: number;
  endMs: number;
}

interface PedalClarityResult {
  active: boolean;
  hardware: PedalHardwareKind;
  clarityRate?: number;
  status?: AcousticStatus;
  worstMeasures: number[];
}

function buildSwitchClearedIntervals(
  sustainEvents: readonly Extract<MidiInputEvent, { type: "sustain" }>[],
): { engagedRanges: Array<{ startMs: number; endMs: number }>; clearedEvents: number[]; clearedIntervals: ClearedInterval[] } {
  const engagedRanges: Array<{ startMs: number; endMs: number }> = [];
  const clearedIntervals: ClearedInterval[] = [];
  const clearedEvents: number[] = [];
  let engagedStart: number | null = null;
  let clearedStart: number | null = null;

  for (const ev of sustainEvents) {
    const pressed = ev.value >= 64;
    if (pressed) {
      if (engagedStart === null) engagedStart = ev.timeStampMs;
      if (clearedStart !== null) {
        clearedIntervals.push({ startMs: clearedStart, endMs: ev.timeStampMs });
        clearedStart = null;
      }
    } else {
      clearedEvents.push(ev.timeStampMs);
      if (engagedStart !== null) {
        engagedRanges.push({ startMs: engagedStart, endMs: ev.timeStampMs });
        engagedStart = null;
      }
      if (clearedStart === null) clearedStart = ev.timeStampMs;
    }
  }
  if (engagedStart !== null) engagedRanges.push({ startMs: engagedStart, endMs: Infinity });
  if (clearedStart !== null) clearedIntervals.push({ startMs: clearedStart, endMs: Infinity });
  return { engagedRanges, clearedEvents, clearedIntervals };
}

function buildContinuousClearedIntervals(
  sustainEvents: readonly Extract<MidiInputEvent, { type: "sustain" }>[],
  debounceMs = 30,
): { engagedRanges: Array<{ startMs: number; endMs: number }>; clearedEvents: number[]; clearedIntervals: ClearedInterval[] } {
  // Schmitt hysteresis (>=40 engaged, <=20 cleared) with 30ms lookahead debounce
  const rawTransitions: Array<{ timeMs: number; state: "engaged" | "cleared" }> = [];
  let current: "engaged" | "cleared" | null = null;

  for (const ev of sustainEvents) {
    if (ev.value >= 40 && current !== "engaged") {
      current = "engaged";
      rawTransitions.push({ timeMs: ev.timeStampMs, state: "engaged" });
    } else if (ev.value <= 20 && current !== "cleared") {
      current = "cleared";
      rawTransitions.push({ timeMs: ev.timeStampMs, state: "cleared" });
    }
  }

  // Filter out bounces shorter than debounceMs
  const debounced: Array<{ timeMs: number; state: "engaged" | "cleared" }> = [];
  for (let i = 0; i < rawTransitions.length; i++) {
    const cur = rawTransitions[i];
    const next = rawTransitions[i + 1];
    if (next && next.timeMs - cur.timeMs < debounceMs) {
      // Skip brief transient state flip; if previous debounced already had same state as next, skip next too
      continue;
    }
    if (debounced.length > 0 && debounced[debounced.length - 1].state === cur.state) {
      continue;
    }
    debounced.push(cur);
  }

  const engagedRanges: Array<{ startMs: number; endMs: number }> = [];
  const clearedIntervals: ClearedInterval[] = [];
  const clearedEvents: number[] = [];

  for (let i = 0; i < debounced.length; i++) {
    const cur = debounced[i];
    const nextMs = debounced[i + 1]?.timeMs ?? Infinity;
    if (cur.state === "engaged") {
      engagedRanges.push({ startMs: cur.timeMs, endMs: nextMs });
    } else {
      clearedEvents.push(cur.timeMs);
      clearedIntervals.push({ startMs: cur.timeMs, endMs: nextMs });
    }
  }

  return { engagedRanges, clearedEvents, clearedIntervals };
}

function computeHarmonicBoundaries(
  attribution: BoundedAttributionResult,
  measureTimelines: readonly MeasureTimeline[] | undefined,
  pedalIntervals: readonly PedalInterval[] | undefined,
  speed: number,
  t0AnchorMs: number,
): Array<{ timeMs: number; measureIndex: number }> {
  const boundaries: Array<{ timeMs: number; measureIndex: number }> = [];
  const matched = attribution.matchedNotes;
  if (matched.length === 0) return boundaries;

  // Map scoreSec -> calibrated perfMs using median entry+reanchor offset from matched notes
  const firstMatch = matched[0];
  const scoreToPerfMs = (scoreSec: number, refMeasureIndex: number): number => {
    const inMeasure = matched.find((m) => m.note.measureIndex === refMeasureIndex);
    const ref = inMeasure ?? firstMatch;
    return ref.expectedPerfMs + ((scoreSec - ref.note.onsetSec) / speed) * 1000;
  };

  if (pedalIntervals && pedalIntervals.length > 0 && measureTimelines && measureTimelines.length > 0) {
    for (const p of pedalIntervals) {
      if (!p.freshPress) continue;
      // Estimate scoreSec from startTick via measureTimelines
      const tl =
        measureTimelines.find((m) => p.startTick >= m.startTick && p.startTick < m.endTick) ??
        measureTimelines[0];
      const tickSpan = Math.max(1, tl.endTick - tl.startTick);
      const frac = (p.startTick - tl.startTick) / tickSpan;
      const scoreSec = tl.startSec + frac * (tl.endSec - tl.startSec);
      if (tl.measureIndex > firstMatch.note.measureIndex || frac > 0.05) {
        boundaries.push({ timeMs: scoreToPerfMs(scoreSec, tl.measureIndex), measureIndex: tl.measureIndex });
      }
    }
  }

  // Group matched notes by step to detect measure-boundary & intra-measure bass pitch-class changes
  const byStep = new Map<number, AttributedMatchedNote[]>();
  for (const m of matched) {
    if (m.note.isGrace) continue;
    const list = byStep.get(m.stepIndex);
    if (list) list.push(m);
    else byStep.set(m.stepIndex, [m]);
  }
  const orderedSteps = [...byStep.entries()].sort((a, b) => a[0] - b[0]);

  let prevMeasure = -1;
  let prevMeasureBassPc: number | null = null;
  let prevStepBassPc: number | null = null;

  for (const [, stepNotes] of orderedSteps) {
    const mIdx = stepNotes[0].note.measureIndex;
    const lhNotes = stepNotes.filter((n) => n.note.hand === "LH");
    const bassPool = lhNotes.length > 0 ? lhNotes : stepNotes;
    const minNote = bassPool.reduce((low, cur) => (cur.note.midi < low.note.midi ? cur : low));
    const bassPc = ((minNote.note.midi % 12) + 12) % 12;
    const stepTimeMs = Math.max(t0AnchorMs, minNote.expectedPerfMs);

    const tl = measureTimelines?.[mIdx];
    const beatSec = tl && tl.timeBeats > 0 ? (tl.endSec - tl.startSec) / tl.timeBeats : 0.5;

    if (prevMeasure !== -1 && mIdx !== prevMeasure) {
      if (prevMeasureBassPc === null || bassPc !== prevMeasureBassPc) {
        if (!boundaries.some((b) => Math.abs(b.timeMs - stepTimeMs) < 120)) {
          boundaries.push({ timeMs: stepTimeMs, measureIndex: mIdx });
        }
      }
      prevMeasureBassPc = bassPc;
    } else if (prevMeasure === -1) {
      prevMeasureBassPc = bassPc;
    } else if (
      lhNotes.length > 0 &&
      prevStepBassPc !== null &&
      bassPc !== prevStepBassPc &&
      minNote.note.durationSec >= beatSec * 0.9
    ) {
      if (!boundaries.some((b) => Math.abs(b.timeMs - stepTimeMs) < 120)) {
        boundaries.push({ timeMs: stepTimeMs, measureIndex: mIdx });
      }
    }

    prevMeasure = mIdx;
    prevStepBassPc = bassPc;
  }

  return boundaries.sort((a, b) => a.timeMs - b.timeMs);
}

function computePedalClarity(
  sustainEvents: readonly Extract<MidiInputEvent, { type: "sustain" }>[],
  attribution: BoundedAttributionResult,
  measureTimelines: readonly MeasureTimeline[] | undefined,
  pedalIntervals: readonly PedalInterval[] | undefined,
  speed: number,
  bleScale: number,
): PedalClarityResult {
  if (sustainEvents.length === 0 || !sustainEvents.some((e) => e.value > 20)) {
    return { active: false, hardware: "none", worstMeasures: [] };
  }

  const uniqueVals = new Set(sustainEvents.map((e) => e.value));
  const hasIntermediate = [...uniqueVals].some((v) => v > 10 && v < 115 && v !== 64);
  const hardware: PedalHardwareKind = hasIntermediate || uniqueVals.size > 3 ? "continuous" : "switch";

  const { engagedRanges, clearedEvents, clearedIntervals } =
    hardware === "continuous"
      ? buildContinuousClearedIntervals(sustainEvents, 30)
      : buildSwitchClearedIntervals(sustainEvents);

  const firstTime = attribution.matchedNotes[0]?.expectedPerfMs ?? sustainEvents[0].timeStampMs;
  const boundaries = computeHarmonicBoundaries(
    attribution,
    measureTimelines,
    pedalIntervals,
    speed,
    firstTime,
  );

  if (boundaries.length === 0) {
    return { active: false, hardware, worstMeasures: [] };
  }

  const isEngagedLeadingInto = (tH: number): boolean =>
    engagedRanges.some((r) => r.startMs < tH - 30 && r.endMs >= tH - 120);

  let activeBoundaryCount = 0;
  let cleanCount = 0;
  const worstSet = new Set<number>();

  for (const b of boundaries) {
    if (!isEngagedLeadingInto(b.timeMs)) continue;
    activeBoundaryCount += 1;

    const winStart = b.timeMs - 60 * bleScale;
    const winEnd = b.timeMs + 220 * bleScale;
    const hasCleanClear =
      clearedEvents.some((t) => t >= winStart && t <= winEnd) ||
      clearedIntervals.some((iv) => iv.startMs <= winEnd && iv.endMs >= winStart && iv.endMs > b.timeMs - 60);

    if (hasCleanClear) {
      cleanCount += 1;
    } else {
      worstSet.add(b.measureIndex);
    }
  }

  if (activeBoundaryCount === 0) {
    return { active: false, hardware, worstMeasures: [] };
  }

  const clarityRate = round2(cleanCount / activeBoundaryCount);
  let status: AcousticStatus = "green";
  if (clarityRate < 0.55) status = "red";
  else if (clarityRate < 0.8) status = "amber";

  return {
    active: true,
    hardware,
    clarityRate,
    status,
    worstMeasures: [...worstSet].sort((a, b) => a - b),
  };
}

interface HandSyncResult {
  active: boolean;
  status?: AcousticStatus;
  medianEffOffsetMs?: number;
  heavySplitPct?: number;
  worstMeasures: number[];
}

function computeHandSync(
  attribution: BoundedAttributionResult,
  practiceMode: PracticeMode,
  bleScale: number,
  hasReliableVelocity: boolean,
): HandSyncResult {
  if (practiceMode !== "both") {
    return { active: false, worstMeasures: [] };
  }

  const byStep = new Map<number, AttributedMatchedNote[]>();
  for (const m of attribution.matchedNotes) {
    if (m.note.isGrace || m.note.isArpeggiated) continue;
    const list = byStep.get(m.stepIndex);
    if (list) list.push(m);
    else byStep.set(m.stepIndex, [m]);
  }

  const effOffsets: number[] = [];
  const rawAbsOffsets: number[] = [];
  const worstSet = new Set<number>();
  let heavySplits = 0;

  for (const notes of byStep.values()) {
    const rh = notes.filter((n) => n.note.hand === "RH");
    const lh = notes.filter((n) => n.note.hand === "LH");
    if (rh.length === 0 || lh.length === 0) continue;

    const tRh = median(rh.map((n) => n.strikeEvent.timeStampMs));
    const tLh = median(lh.map((n) => n.strikeEvent.timeStampMs));
    const deltaMs = tRh - tLh; // < 0 means RH struck earlier; > 0 means LH struck earlier

    const maxVelRh = Math.max(
      ...rh.map((n) => (n.strikeEvent.type === "noteon" ? n.strikeEvent.velocity : 0)),
    );
    const maxVelLh = Math.max(
      ...lh.map((n) => (n.strikeEvent.type === "noteon" ? n.strikeEvent.velocity : 0)),
    );
    const deltaVel = maxVelRh - maxVelLh;

    // Strong-hand velocity-lead occurs when stronger hand strikes earlier (deltaMs * deltaVel < 0)
    const isStrongHandLead =
      hasReliableVelocity && Math.abs(deltaVel) >= 8 && deltaMs * deltaVel < 0;
    const deadzoneMs = (isStrongHandLead ? 35 : 22) * bleScale;
    const absDelta = Math.abs(deltaMs);
    const eff = Math.max(0, absDelta - deadzoneMs);

    effOffsets.push(eff);
    rawAbsOffsets.push(absDelta);
    if (absDelta > 50 * bleScale) {
      heavySplits += 1;
    }
    if (eff > 5 * bleScale) {
      worstSet.add(notes[0].note.measureIndex);
    }
  }

  if (effOffsets.length < 3) {
    return { active: false, worstMeasures: [] };
  }

  const medianEff = round2(median(effOffsets));
  const medianAbs = round2(median(rawAbsOffsets));
  const heavySplitPct = round2(heavySplits / effOffsets.length);

  let status: AcousticStatus = "green";
  if (heavySplitPct > 0.25 || medianEff > 23 * bleScale || medianAbs > 55 * bleScale) {
    status = "red";
  } else if (heavySplitPct >= 0.1 || medianEff > 5 * bleScale) {
    status = "amber";
  }

  return {
    active: true,
    status,
    medianEffOffsetMs: medianEff,
    heavySplitPct,
    worstMeasures: status === "green" ? [] : [...worstSet].sort((a, b) => a - b),
  };
}

function isSustainEngagedAt(
  sustainEvents: readonly Extract<MidiInputEvent, { type: "sustain" }>[],
  timeMs: number,
): boolean {
  if (sustainEvents.length === 0) return false;
  let engaged = false;
  for (const ev of sustainEvents) {
    if (ev.timeStampMs > timeMs) break;
    engaged = ev.value >= 40;
  }
  return engaged;
}

interface SecondaryAnalysis {
  dimension: "voicing" | "articulation" | "hidden";
  voicingDeltaDb?: number;
  melodyRankDominance?: number;
  voicingStatus?: AcousticStatus;
  voicingWorstMeasures: number[];
  articulationKor?: number;
  articulationStatus?: AcousticStatus;
  articulationWorstMeasures: number[];
}

function computeSecondaryDimension(
  attribution: BoundedAttributionResult,
  midiEvents: readonly MidiInputEvent[],
  sustainEvents: readonly Extract<MidiInputEvent, { type: "sustain" }>[],
  practiceMode: PracticeMode,
  speed: number,
): SecondaryAnalysis {
  const hidden: SecondaryAnalysis = {
    dimension: "hidden",
    voicingWorstMeasures: [],
    articulationWorstMeasures: [],
  };

  const validMidiStrikes = attribution.matchedNotes
    .map((m) => m.strikeEvent)
    .filter((ev): ev is Extract<MidiInputEvent, { type: "noteon" }> =>
      ev.type === "noteon" && ev.source === "midi" && ev.velocity > 1,
    );

  // Check source from matched strikes or raw noteons if matched is small
  const allValidNoteOns = midiEvents.filter(
    (ev): ev is Extract<MidiInputEvent, { type: "noteon" }> =>
      ev.type === "noteon" && ev.velocity > 1,
  );
  const hasAnyNonMidi =
    (validMidiStrikes.length === 0 && allValidNoteOns.some((e) => e.source !== "midi")) ||
    attribution.matchedNotes.some((m) => m.strikeEvent.source !== "midi");

  if (hasAnyNonMidi) return hidden;

  const velocities = (validMidiStrikes.length > 0 ? validMidiStrikes : allValidNoteOns)
    .filter((ev) => ev.source === "midi")
    .map((ev) => ev.velocity);

  if (velocities.length === 0 || computeIqr(velocities) < 3) {
    return hidden;
  }

  // Group matched notes by step to look for multi-voice / bimanual voicing pairs
  const byStep = new Map<number, AttributedMatchedNote[]>();
  for (const m of attribution.matchedNotes) {
    if (m.note.isGrace || m.strikeEvent.type !== "noteon" || m.strikeEvent.velocity <= 1) continue;
    const list = byStep.get(m.stepIndex);
    if (list) list.push(m);
    else byStep.set(m.stepIndex, [m]);
  }

  // Determine whether LH is solo single-note melody against RH chords
  let lhSingleSteps = 0;
  let rhChordSteps = 0;
  let bimanualSteps = 0;
  for (const notes of byStep.values()) {
    const rh = notes.filter((n) => n.note.hand === "RH");
    const lh = notes.filter((n) => n.note.hand === "LH");
    if (rh.length > 0 && lh.length > 0) {
      bimanualSteps += 1;
      if (lh.length === 1 && rh.length >= 2) rhChordSteps += 1;
      if (lh.length === 1) lhSingleSteps += 1;
    }
  }
  const lhIsMelody =
    practiceMode === "both" && bimanualSteps >= 4 && rhChordSteps / bimanualSteps >= 0.6 && lhSingleSteps >= bimanualSteps * 0.6;

  const melodyDb: number[] = [];
  const accompDb: number[] = [];
  const pairs: Array<{ mVel: number; aVel: number; measureIndex: number }> = [];

  for (const notes of byStep.values()) {
    if (notes.length < 2) continue;
    let melodyNote: AttributedMatchedNote;
    if (practiceMode === "both") {
      const targetHand = lhIsMelody ? "LH" : "RH";
      const handNotes = notes.filter((n) => n.note.hand === targetHand);
      const pool = handNotes.length > 0 ? handNotes : notes;
      melodyNote = pool.reduce((best, cur) => (cur.note.midi > best.note.midi ? cur : best));
    } else {
      melodyNote = notes.reduce((best, cur) => (cur.note.midi > best.note.midi ? cur : best));
    }
    const mVel = melodyNote.strikeEvent.type === "noteon" ? melodyNote.strikeEvent.velocity : 0;
    const accompNotes = notes.filter((n) => n !== melodyNote);
    if (accompNotes.length === 0 || mVel <= 1) continue;

    melodyDb.push(velocityToDbProxy(mVel));
    for (const acc of accompNotes) {
      if (acc.strikeEvent.type !== "noteon" || acc.strikeEvent.velocity <= 1) continue;
      accompDb.push(velocityToDbProxy(acc.strikeEvent.velocity));
      pairs.push({
        mVel,
        aVel: acc.strikeEvent.velocity,
        measureIndex: melodyNote.note.measureIndex,
      });
    }
  }

  // Fallback: pair melody vs accompaniment within 150ms for broken-chord / Alberti textures
  if (pairs.length < 4 && practiceMode === "both") {
    const ordered = [...attribution.matchedNotes]
      .filter((m) => !m.note.isGrace && m.strikeEvent.type === "noteon" && m.strikeEvent.velocity > 1)
      .sort((a, b) => a.strikeEvent.timeStampMs - b.strikeEvent.timeStampMs);
    const melPool = ordered.filter((n) => n.note.hand === (lhIsMelody ? "LH" : "RH"));
    const accPool = ordered.filter((n) => n.note.hand === (lhIsMelody ? "RH" : "LH"));
    if (melPool.length >= 4 && accPool.length >= 4) {
      pairs.length = 0;
      melodyDb.length = 0;
      accompDb.length = 0;
      for (const m of melPool) {
        const mVel = (m.strikeEvent as Extract<MidiInputEvent, { type: "noteon" }>).velocity;
        const mTime = m.strikeEvent.timeStampMs;
        let nearestAcc: AttributedMatchedNote | null = null;
        let bestDist = 151;
        for (const a of accPool) {
          const d = Math.abs(a.strikeEvent.timeStampMs - mTime);
          if (d < bestDist) {
            bestDist = d;
            nearestAcc = a;
          }
        }
        if (nearestAcc && nearestAcc.strikeEvent.type === "noteon") {
          melodyDb.push(velocityToDbProxy(mVel));
          accompDb.push(velocityToDbProxy(nearestAcc.strikeEvent.velocity));
          pairs.push({
            mVel,
            aVel: nearestAcc.strikeEvent.velocity,
            measureIndex: m.note.measureIndex,
          });
        }
      }
    }
  }

  if (pairs.length >= 4 && melodyDb.length > 0 && accompDb.length > 0) {
    const voicingDeltaDb = round2(median(melodyDb) - median(accompDb));
    const dominantCount = pairs.filter((p) => p.mVel > p.aVel).length;
    const melodyRankDominance = round2(dominantCount / pairs.length);

    let voicingStatus: AcousticStatus = "green";
    if (voicingDeltaDb < 1.5 || melodyRankDominance < 0.6) {
      voicingStatus = "red";
    } else if (voicingDeltaDb < 3.0 || melodyRankDominance < 0.75) {
      voicingStatus = "amber";
    }

    const voicingWorstMeasures: number[] = [];
    if (voicingStatus !== "green") {
      const byMeasure = new Map<number, Array<{ mVel: number; aVel: number }>>();
      for (const p of pairs) {
        const list = byMeasure.get(p.measureIndex);
        if (list) list.push(p);
        else byMeasure.set(p.measureIndex, [p]);
      }
      for (const [mIdx, items] of byMeasure) {
        const mDelta =
          median(items.map((x) => velocityToDbProxy(x.mVel))) -
          median(items.map((x) => velocityToDbProxy(x.aVel)));
        const mDom = items.filter((x) => x.mVel > x.aVel).length / items.length;
        if (mDelta < 1.5 || mDom < 0.6) voicingWorstMeasures.push(mIdx);
      }
      voicingWorstMeasures.sort((a, b) => a - b);
    }

    return {
      dimension: "voicing",
      voicingDeltaDb,
      melodyRankDominance,
      voicingStatus,
      voicingWorstMeasures,
      articulationWorstMeasures: [],
    };
  }

  // Single-line unpedaled passage -> Articulation KOR
  const orderedSingle = [...attribution.matchedNotes]
    .filter((m) => !m.note.isGrace && m.strikeEvent.type === "noteon" && m.strikeEvent.velocity > 1)
    .sort((a, b) => a.strikeEvent.timeStampMs - b.strikeEvent.timeStampMs);

  const breakSteps = new Set(attribution.hesitationBreaks.map((b) => b.stepIndex));
  const korSamples: Array<{ kor: number; ioiMs: number; scoreDurMs: number; measureIndex: number }> = [];

  for (let i = 1; i < orderedSingle.length; i++) {
    const prev = orderedSingle[i - 1];
    const curr = orderedSingle[i];
    if (prev.note.hand !== curr.note.hand || prev.note.voice !== curr.note.voice) continue;
    if (prev.note.midi === curr.note.midi) continue;
    if (breakSteps.has(curr.stepIndex)) continue;
    if (!prev.releaseEvent) continue;
    const ioiMs = curr.strikeEvent.timeStampMs - prev.strikeEvent.timeStampMs;
    if (ioiMs <= 20) continue;
    // Skip if sustain pedal was engaged across the release/onset transition
    if (
      isSustainEngagedAt(sustainEvents, curr.strikeEvent.timeStampMs) ||
      isSustainEngagedAt(sustainEvents, prev.releaseEvent.timeStampMs)
    ) {
      continue;
    }
    const kotMs = prev.releaseEvent.timeStampMs - curr.strikeEvent.timeStampMs;
    const kor = clamp(kotMs / ioiMs, -1, 1);
    korSamples.push({
      kor,
      ioiMs,
      scoreDurMs: (prev.note.durationSec / speed) * 1000,
      measureIndex: curr.note.measureIndex,
    });
  }

  if (korSamples.length >= 3) {
    const articulationKor = round2(median(korSamples.map((s) => s.kor)));
    const medIoi = median(korSamples.map((s) => s.ioiMs));
    const medScoreDur = median(korSamples.map((s) => s.scoreDurMs));

    let articulationStatus: AcousticStatus = "green";
    if (medIoi < 350 && articulationKor > 0.35) {
      articulationStatus = "red";
    } else if (medIoi < 350 && articulationKor > 0.25) {
      articulationStatus = "amber";
    } else if (medIoi >= 350 && medScoreDur >= 350 && articulationKor < -0.55) {
      articulationStatus = "red";
    } else if (medIoi >= 350 && medScoreDur >= 350 && articulationKor < -0.35) {
      articulationStatus = "amber";
    }

    const articulationWorstMeasures: number[] = [];
    if (articulationStatus !== "green") {
      const bad = new Set<number>();
      for (const s of korSamples) {
        if ((medIoi < 350 && s.kor > 0.25) || (medIoi >= 350 && medScoreDur >= 350 && s.kor < -0.35)) {
          bad.add(s.measureIndex);
        }
      }
      articulationWorstMeasures.push(...[...bad].sort((a, b) => a - b));
    }

    return {
      dimension: "articulation",
      articulationKor,
      articulationStatus,
      voicingWorstMeasures: [],
      articulationWorstMeasures,
    };
  }

  return hidden;
}

/**
 * Pure 5-dimensional hardware-invariant Acoustic Profile analyzer.
 */
export function analyzeAcousticProfile(input: AcousticProfileInput): AcousticProfileResult {
  const practiceMode = input.practiceMode ?? "both";
  const bleQuantizationRelaxed = detectBleQuantization(
    input.midiEvents,
    input.attribution.matchedNotes,
    input.deviceNames,
  );
  const bleScale = bleQuantizationRelaxed ? 1.4 : 1.0;

  const sustainEvents = input.midiEvents
    .filter((ev): ev is Extract<MidiInputEvent, { type: "sustain" }> => ev.type === "sustain")
    .sort((a, b) => a.timeStampMs - b.timeStampMs);

  const points = buildLeadStepSequence(input.attribution.matchedNotes, practiceMode);
  const speed = inferSpeedMultiplier(points, input.speedMultiplier);

  const timing = computeTimingEvenness(
    input.attribution,
    speed,
    practiceMode,
    bleScale,
  );

  const secondary = computeSecondaryDimension(
    input.attribution,
    input.midiEvents,
    sustainEvents,
    practiceMode,
    speed,
  );

  const pedal = computePedalClarity(
    sustainEvents,
    input.attribution,
    input.measureTimelines,
    input.pedalIntervals,
    speed,
    bleScale,
  );

  const validMidiVels = input.attribution.matchedNotes
    .map((m) => m.strikeEvent)
    .filter((ev): ev is Extract<MidiInputEvent, { type: "noteon" }> =>
      ev.type === "noteon" && ev.source === "midi" && ev.velocity > 1,
    )
    .map((ev) => ev.velocity);
  const hasReliableVelocity =
    validMidiVels.length > 0 &&
    !input.attribution.matchedNotes.some((m) => m.strikeEvent.source !== "midi") &&
    computeIqr(validMidiVels) >= 3;

  const handSync = !pedal.active
    ? computeHandSync(input.attribution, practiceMode, bleScale, hasReliableVelocity)
    : { active: false, worstMeasures: [] };

  const tertiaryDimension: "pedal" | "hand-sync" | "hidden" = pedal.active
    ? "pedal"
    : handSync.active
      ? "hand-sync"
      : "hidden";

  const capsules: AcousticCapsule[] = [
    {
      id: "timing",
      label: "节奏均匀",
      valueText: `nPVI ${timing.normNpvi.toFixed(1)}`,
      status: timing.status,
      ...(bleQuantizationRelaxed ? { detailText: "BLE 1.4× 抗噪" } : {}),
    },
  ];

  if (secondary.dimension === "voicing" && secondary.voicingDeltaDb !== undefined) {
    const sign = secondary.voicingDeltaDb >= 0 ? "+" : "";
    const domPct = Math.round((secondary.melodyRankDominance ?? 0) * 100);
    capsules.push({
      id: "voicing",
      label: "声部层次",
      valueText: `${sign}${secondary.voicingDeltaDb.toFixed(1)} dB · 主位 ${domPct}%`,
      status: secondary.voicingStatus ?? "green",
    });
  } else if (secondary.dimension === "articulation" && secondary.articulationKor !== undefined) {
    const sign = secondary.articulationKor >= 0 ? "+" : "";
    capsules.push({
      id: "articulation",
      label: "触键清晰",
      valueText: `KOR ${sign}${secondary.articulationKor.toFixed(2)}`,
      status: secondary.articulationStatus ?? "green",
    });
  }

  if (tertiaryDimension === "pedal" && pedal.clarityRate !== undefined) {
    const pct = Math.round(pedal.clarityRate * 100);
    capsules.push({
      id: "pedal",
      label: "踏板清音",
      valueText: `${pct}% (${pedal.hardware === "continuous" ? "半踏" : "开关"})`,
      status: pedal.status ?? "green",
    });
  } else if (tertiaryDimension === "hand-sync" && handSync.status) {
    capsules.push({
      id: "hand-sync",
      label: "双手对齐",
      valueText:
        handSync.status === "green"
          ? "整齐融合"
          : `错开 ${Math.round(handSync.medianEffOffsetMs ?? 0)} ms`,
      status: handSync.status,
    });
  }

  const troubleMap = new Map<number, AcousticTroubleMeasure>();
  const addTrouble = (measureIndex: number, severity: "amber" | "red", reason: string) => {
    const existing = troubleMap.get(measureIndex);
    if (!existing) {
      troubleMap.set(measureIndex, { measureIndex, severity, reasons: [reason] });
    } else {
      if (severity === "red") existing.severity = "red";
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    }
  };

  if (timing.status !== "green" && timing.worstMeasure !== undefined) {
    addTrouble(timing.worstMeasure, timing.status, `节奏起伏 (nPVI ${timing.normNpvi.toFixed(1)})`);
  }
  if (secondary.dimension === "voicing" && secondary.voicingStatus && secondary.voicingStatus !== "green") {
    for (const mIdx of secondary.voicingWorstMeasures) {
      addTrouble(mIdx, secondary.voicingStatus, "声部层次偏平");
    }
  }
  if (
    secondary.dimension === "articulation" &&
    secondary.articulationStatus &&
    secondary.articulationStatus !== "green"
  ) {
    for (const mIdx of secondary.articulationWorstMeasures) {
      addTrouble(mIdx, secondary.articulationStatus, "触键粘连/干断");
    }
  }
  if (tertiaryDimension === "pedal" && pedal.status && pedal.status !== "green") {
    for (const mIdx of pedal.worstMeasures) {
      addTrouble(mIdx, pedal.status, "踏板换音浑浊");
    }
  }
  if (tertiaryDimension === "hand-sync" && handSync.status && handSync.status !== "green") {
    for (const mIdx of handSync.worstMeasures) {
      addTrouble(mIdx, handSync.status, "双手纵向错开");
    }
  }

  const troubleMeasures = [...troubleMap.values()].sort(
    (a, b) => a.measureIndex - b.measureIndex,
  );

  return {
    timingEvennessStatus: timing.status,
    timingNormNpvi: timing.normNpvi,
    ...(timing.worstMeasure !== undefined ? { worstTimingMeasure: timing.worstMeasure } : {}),
    secondaryDimension: secondary.dimension,
    ...(secondary.voicingDeltaDb !== undefined ? { voicingDeltaDb: secondary.voicingDeltaDb } : {}),
    ...(secondary.melodyRankDominance !== undefined
      ? { melodyRankDominance: secondary.melodyRankDominance }
      : {}),
    ...(secondary.articulationKor !== undefined
      ? { articulationKor: secondary.articulationKor }
      : {}),
    tertiaryDimension,
    ...(pedal.clarityRate !== undefined ? { pedalClarityRate: pedal.clarityRate } : {}),
    ...(handSync.status !== undefined ? { handSyncStatus: handSync.status } : {}),
    bleQuantizationRelaxed,
    capsules,
    troubleMeasures,
    pedalHardware: pedal.hardware,
    ...(secondary.voicingStatus ? { voicingStatus: secondary.voicingStatus } : {}),
    ...(secondary.articulationStatus ? { articulationStatus: secondary.articulationStatus } : {}),
    ...(pedal.status ? { pedalStatus: pedal.status } : {}),
    ...(handSync.medianEffOffsetMs !== undefined
      ? { handSyncMedianEffOffsetMs: handSync.medianEffOffsetMs }
      : {}),
    ...(handSync.heavySplitPct !== undefined
      ? { handSyncHeavySplitPct: handSync.heavySplitPct }
      : {}),
  };
}

export interface ContinuousPerformanceAnalysisInput {
  clockAnchor: PlaybackClockAnchor;
  expectedSteps: readonly PracticeStep[];
  scoreDoc: ScoreDocument;
  practiceMode: PracticeMode;
  sliceContinuousMidiWindow: (fromMs: number, toMs: number) => MidiInputEvent[];
  endClockMs?: number;
  deviceNames?: readonly string[];
}

export interface ContinuousPerformanceAnalysisResult {
  attribution: BoundedAttributionResult;
  acousticProfile: AcousticProfileResult;
}

/**
 * Shared post-bout attribution + Acoustic Profile helper for continuous Guided Session
 * bouts and Free Studio A-B Loop iterations. Returns null if no valid keystrokes occurred.
 */
export function analyzeContinuousPerformanceWindow(
  input: ContinuousPerformanceAnalysisInput,
): ContinuousPerformanceAnalysisResult | null {
  const {
    clockAnchor,
    expectedSteps,
    scoreDoc,
    practiceMode,
    sliceContinuousMidiWindow,
    endClockMs = performance.now(),
    deviceNames,
  } = input;
  if (expectedSteps.length === 0) return null;

  const expectedDurationMs =
    ((clockAnchor.endScoreSec - clockAnchor.startScoreSec) /
      Math.max(0.1, clockAnchor.speedMultiplier)) *
    1000;
  const toMs = Math.max(endClockMs, clockAnchor.t0PerfMs + expectedDurationMs) + 500;
  const captured = sliceContinuousMidiWindow(clockAnchor.t0PerfMs - 250, toMs);
  if (!captured.some((ev) => ev.type === "noteon" && ev.velocity > 1)) {
    return null;
  }

  const attribution = attributeContinuousBout({
    clockAnchor,
    expectedSteps,
    midiEvents: captured,
    measureTimelines: scoreDoc.measureTimelines,
    practiceMode,
  });
  const acousticProfile = analyzeAcousticProfile({
    attribution,
    midiEvents: captured,
    speedMultiplier: clockAnchor.speedMultiplier,
    practiceMode,
    measureTimelines: scoreDoc.measureTimelines,
    pedalIntervals: scoreDoc.pedalIntervals,
    expectedSteps,
    deviceNames,
  });
  return { attribution, acousticProfile };
}
