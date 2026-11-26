import type { PlaybackClockAnchor } from "../audio/playbackEngine";
import type {
  Hand,
  MeasureTimeline,
  NoteEvent,
  PracticeMode,
  PracticeStep,
  ScoreCoord,
} from "../domain/types";
import type { MidiInputEvent } from "../midi/webMidi";
import type { PracticeEvent } from "../persistence/storagePort";

const MAX_REANCHORS = 2;
const STALL_BEAT_RATIO_THRESHOLD = 0.6;
const SEVERE_STALL_RATIO_THRESHOLD = 2.5;
const MAX_ENTRY_CALIBRATION_MS = 220;
const MAX_REANCHOR_SHIFT_MS = 10_000;
const DEFAULT_BEAT_MS = 500;

export interface SwitchBranchSkeleton {
  branchId?: string;
  stepMidis: readonly (readonly number[])[];
}

export interface SwitchPointSpec {
  startStepIndex?: number;
  startScoreSec?: number;
  alternateBranches: readonly SwitchBranchSkeleton[];
}

export interface BoundedAttributionInput {
  clockAnchor: PlaybackClockAnchor;
  expectedSteps: readonly PracticeStep[];
  midiEvents: readonly MidiInputEvent[];
  measureTimelines?: readonly MeasureTimeline[];
  practiceMode?: PracticeMode;
  junctionBoundaryCoord?: ScoreCoord;
  junctionStepIndex?: number;
  isExemptCommandKey?: (event: MidiInputEvent) => boolean;
  isExemptPeekKey?: (event: MidiInputEvent) => boolean;
  switchPoint?: SwitchPointSpec;
  l3RelaxedDrift?: boolean;
}

export interface AttributedMatchedNote {
  note: NoteEvent;
  stepIndex: number;
  strikeEvent: MidiInputEvent;
  releaseEvent?: MidiInputEvent;
  expectedPerfMs: number;
  timingErrorMs: number;
  reanchorAppliedMs: number;
}

export interface AttributedMissedNote {
  note: NoteEvent;
  stepIndex: number;
  expectedPerfMs: number;
}

export interface HesitationBreak {
  stepIndex: number;
  measureIndex: number;
  onsetSec: number;
  delayMs: number;
  beatRatio: number;
  ioiRatio: number;
  isJunction: boolean;
  reanchored: boolean;
}

export interface BoundedAttributionResult {
  calibratedEntryOffsetMs: number;
  matchedNotes: AttributedMatchedNote[];
  missedNotes: AttributedMissedNote[];
  extraEvents: MidiInputEvent[];
  filteredGhostCount: number;
  filteredExemptCount: number;
  hesitationBreaks: HesitationBreak[];
  fluency: PracticeEvent["fluency"];
  measureFaultCounts: PracticeEvent["measureFaultCounts"];
}

type NoteOnEvent = Extract<MidiInputEvent, { type: "noteon" }>;
type NoteOffEvent = Extract<MidiInputEvent, { type: "noteoff" }>;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function lowerBoundByTime(
  indices: readonly number[],
  events: readonly { timeStampMs: number }[],
  targetMs: number
): number {
  let lo = 0;
  let hi = indices.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[indices[mid]].timeStampMs < targetMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function getBeatMsForMeasure(
  measureTimelines: readonly MeasureTimeline[] | undefined,
  measureIndex: number,
  speed: number
): number {
  const m = measureTimelines?.[measureIndex];
  if (m && m.timeBeats > 0 && m.endSec > m.startSec) {
    return (((m.endSec - m.startSec) / m.timeBeats) / speed) * 1000;
  }
  return DEFAULT_BEAT_MS / speed;
}

function isStrongBeatStep(
  step: PracticeStep,
  prevStep: PracticeStep | undefined,
  measureTimelines: readonly MeasureTimeline[] | undefined
): boolean {
  if (step.isGrace) return false;
  const m = measureTimelines?.[step.measureIndex];
  if (!m || m.endSec <= m.startSec || m.timeBeats <= 0) {
    return step.stepIndex === 0 || !prevStep || prevStep.measureIndex !== step.measureIndex;
  }
  if (Math.abs(step.onsetSec - m.startSec) <= 1e-3) return true;
  const beatSec = (m.endSec - m.startSec) / m.timeBeats;
  if (beatSec <= 0) return false;
  const beatOffset = (step.onsetSec - m.startSec) / beatSec;
  if (m.timeBeats === 4 && Math.abs(beatOffset - 2) < 0.05) return true;
  if (m.timeBeats === 6 && Math.abs(beatOffset - 3) < 0.05) return true;
  if (m.timeBeats === 9 && (Math.abs(beatOffset - 3) < 0.05 || Math.abs(beatOffset - 6) < 0.05)) {
    return true;
  }
  if (m.timeBeats === 12 && Math.abs(beatOffset - 6) < 0.05) return true;
  return false;
}

function computeLocalIoiMs(
  baseOnsetMs: readonly number[],
  steps: readonly PracticeStep[],
  index: number,
  beatMs: number
): number {
  const curr = baseOnsetMs[index];
  let prevDelta = Infinity;
  for (let i = index - 1; i >= 0; i--) {
    const d = curr - baseOnsetMs[i];
    if (d > 1) {
      prevDelta = d;
      break;
    }
  }
  let nextDelta = Infinity;
  for (let i = index + 1; i < steps.length; i++) {
    const d = baseOnsetMs[i] - curr;
    if (d > 1) {
      nextDelta = d;
      break;
    }
  }
  const finite = [prevDelta, nextDelta].filter(Number.isFinite);
  if (finite.length === 0) return Math.max(60, beatMs);
  return Math.max(60, Math.min(...finite));
}

function resolveJunctionStepIndex(
  steps: readonly PracticeStep[],
  measureTimelines: readonly MeasureTimeline[] | undefined,
  junctionStepIndex?: number,
  junctionBoundaryCoord?: ScoreCoord
): number {
  if (typeof junctionStepIndex === "number" && Number.isInteger(junctionStepIndex)) {
    return junctionStepIndex;
  }
  if (!junctionBoundaryCoord) return -1;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const coord = step.expectedNotes[0]?.scoreCoord;
    if (coord) {
      if (coord.measureIndex > junctionBoundaryCoord.measureIndex) return i;
      if (coord.measureIndex === junctionBoundaryCoord.measureIndex) {
        const stepBeat = coord.beatNum / coord.beatDen;
        const targetBeat = junctionBoundaryCoord.beatNum / junctionBoundaryCoord.beatDen;
        if (stepBeat >= targetBeat - 1e-4) return i;
      }
      continue;
    }
    const m = measureTimelines?.[junctionBoundaryCoord.measureIndex];
    if (m && m.timeBeats > 0 && m.endSec > m.startSec) {
      const quarterSec = ((m.endSec - m.startSec) / m.timeBeats) * (m.timeBeatType / 4);
      const targetSec =
        m.startSec + (junctionBoundaryCoord.beatNum / junctionBoundaryCoord.beatDen) * quarterSec;
      if (step.onsetSec >= targetSec - 1e-3) return i;
    } else if (step.measureIndex >= junctionBoundaryCoord.measureIndex) {
      return i;
    }
  }
  return -1;
}

function findNearestUnusedIndex(
  midi: number,
  targetMs: number,
  lowMs: number,
  highMs: number,
  noteOns: readonly NoteOnEvent[],
  byMidi: ReadonlyMap<number, number[]>,
  used: Uint8Array
): number {
  const indices = byMidi.get(midi);
  if (!indices || indices.length === 0) return -1;
  let pos = lowerBoundByTime(indices, noteOns, lowMs);
  let bestIdx = -1;
  let bestAbsErr = Infinity;
  for (; pos < indices.length; pos++) {
    const evIdx = indices[pos];
    const t = noteOns[evIdx].timeStampMs;
    if (t > highMs) break;
    if (used[evIdx]) continue;
    const err = Math.abs(t - targetMs);
    if (err < bestAbsErr) {
      bestAbsErr = err;
      bestIdx = evIdx;
    }
  }
  return bestIdx;
}

function calibrateEntryOffsetMs(
  steps: readonly PracticeStep[],
  baseOnsetMs: readonly number[],
  wEarly: readonly number[],
  wLate: readonly number[],
  noteOns: readonly NoteOnEvent[],
  byMidi: ReadonlyMap<number, number[]>
): number {
  const limit = Math.min(2, steps.length);
  const usedCal = new Uint8Array(noteOns.length);
  const stepMedians: number[] = [];

  for (let i = 0; i < limit; i++) {
    const step = steps[i];
    const target = baseOnsetMs[i];
    const low = target - wEarly[i];
    const high = target + Math.max(wLate[i], MAX_ENTRY_CALIBRATION_MS);
    const offsets: number[] = [];

    for (const midi of step.expectedMidis) {
      const idx = findNearestUnusedIndex(midi, target, low, high, noteOns, byMidi, usedCal);
      if (idx >= 0) {
        usedCal[idx] = 1;
        offsets.push(noteOns[idx].timeStampMs - target);
      }
    }
    if (offsets.length > 0) {
      stepMedians.push(median(offsets));
    }
  }

  if (stepMedians.length === 0) return 0;
  return Math.max(0, Math.min(MAX_ENTRY_CALIBRATION_MS, median(stepMedians)));
}

function inferExtraHand(
  event: NoteOnEvent,
  steps: readonly PracticeStep[],
  stepTimesMs: readonly number[],
  practiceMode: PracticeMode
): Hand {
  if (practiceMode === "rh-only") return "RH";
  if (practiceMode === "lh-only") return "LH";
  if (steps.length === 0) return event.midi >= 60 ? "RH" : "LH";

  // Binary search nearest step by expected time
  let lo = 0;
  let hi = stepTimesMs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (stepTimesMs[mid] < event.timeStampMs) lo = mid + 1;
    else hi = mid;
  }
  const candidateIdx =
    lo > 0 &&
    Math.abs(stepTimesMs[lo - 1] - event.timeStampMs) <
      Math.abs(stepTimesMs[lo] - event.timeStampMs)
      ? lo - 1
      : lo;
  const step = steps[candidateIdx];
  let bestHand: Hand = event.midi >= 60 ? "RH" : "LH";
  let bestDist = Infinity;
  for (const n of step.expectedNotes) {
    const d = Math.abs(n.midi - event.midi);
    if (d < bestDist) {
      bestDist = d;
      bestHand = n.hand;
    }
  }
  return bestHand;
}

function findNearestStepMeasure(
  timeMs: number,
  steps: readonly PracticeStep[],
  stepTimesMs: readonly number[]
): number {
  if (steps.length === 0) return 0;
  let lo = 0;
  let hi = stepTimesMs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (stepTimesMs[mid] < timeMs) lo = mid + 1;
    else hi = mid;
  }
  if (
    lo > 0 &&
    Math.abs(stepTimesMs[lo - 1] - timeMs) < Math.abs(stepTimesMs[lo] - timeMs)
  ) {
    return steps[lo - 1].measureIndex;
  }
  return steps[lo].measureIndex;
}

function checkSwitchBranchMismatch(
  switchPoint: SwitchPointSpec | undefined,
  steps: readonly PracticeStep[],
  stepTimesMs: readonly number[],
  wEarly: readonly number[],
  missedNotes: readonly AttributedMissedNote[],
  extraEvents: readonly NoteOnEvent[]
): boolean {
  if (!switchPoint || switchPoint.alternateBranches.length === 0 || extraEvents.length === 0) {
    return false;
  }

  let startIdx = switchPoint.startStepIndex ?? -1;
  if (startIdx < 0 && typeof switchPoint.startScoreSec === "number") {
    startIdx = steps.findIndex((s) => s.onsetSec >= switchPoint.startScoreSec! - 1e-4);
  }
  if (startIdx < 0 || startIdx >= steps.length) return false;

  const hasPostSwitchMiss = missedNotes.some((m) => m.stepIndex >= startIdx);
  if (!hasPostSwitchMiss) return false;

  const cutoffMs = stepTimesMs[startIdx] - wEarly[startIdx];
  const postExtras = extraEvents.filter((e) => e.timeStampMs >= cutoffMs);
  if (postExtras.length === 0) return false;

  for (const branch of switchPoint.alternateBranches) {
    const nonEmptySteps = branch.stepMidis.filter((m) => m.length > 0);
    if (nonEmptySteps.length === 0) continue;

    let extraCursor = 0;
    let matchedSteps = 0;
    for (const branchStepMidis of nonEmptySteps) {
      const targetSet = new Set(branchStepMidis);
      let scan = extraCursor;
      while (scan < postExtras.length && !targetSet.has(postExtras[scan].midi)) {
        scan += 1;
      }
      if (scan < postExtras.length) {
        matchedSteps += 1;
        extraCursor = scan + 1;
      }
    }

    const requiredMatches = nonEmptySteps.length === 1 ? 1 : Math.min(2, nonEmptySteps.length);
    if (matchedSteps >= requiredMatches) {
      return true;
    }
  }

  return false;
}

/**
 * Pure post-bout Bounded Window Attribution (`< 2 ms` for 200-note bouts).
 * Performs one-shot entry-offset calibration, asymmetric capture-window pitch matching,
 * ghost/command filtering, missed/extra isolation, capped strong-beat re-anchoring,
 * and post-SwitchPoint alternate-branch mismatch detection.
 */
export function attributeContinuousBout(
  input: BoundedAttributionInput
): BoundedAttributionResult {
  const {
    clockAnchor,
    expectedSteps,
    midiEvents,
    measureTimelines,
    practiceMode = "both",
    junctionBoundaryCoord,
    junctionStepIndex,
    isExemptCommandKey,
    isExemptPeekKey,
    switchPoint,
    l3RelaxedDrift = false,
  } = input;

  const speed = clockAnchor.speedMultiplier > 0 ? clockAnchor.speedMultiplier : 1;
  const windowScale = l3RelaxedDrift ? 1.2 : 1.0;
  const maxEarlyMs = l3RelaxedDrift ? 260 : 220;
  const maxLateMs = l3RelaxedDrift ? 320 : 280;

  let filteredGhostCount = 0;
  let filteredExemptCount = 0;
  const noteOns: NoteOnEvent[] = [];
  const noteOffs: NoteOffEvent[] = [];

  for (const ev of midiEvents) {
    if (ev.type === "noteon") {
      if (ev.velocity <= 1) {
        filteredGhostCount += 1;
        continue;
      }
      if (isExemptCommandKey?.(ev) || isExemptPeekKey?.(ev)) {
        filteredExemptCount += 1;
        continue;
      }
      noteOns.push(ev);
    } else if (ev.type === "noteoff") {
      if (isExemptCommandKey?.(ev) || isExemptPeekKey?.(ev)) continue;
      noteOffs.push(ev);
    }
  }

  noteOns.sort((a, b) => a.timeStampMs - b.timeStampMs);
  noteOffs.sort((a, b) => a.timeStampMs - b.timeStampMs);

  const noteOnByMidi = new Map<number, number[]>();
  for (let i = 0; i < noteOns.length; i++) {
    const list = noteOnByMidi.get(noteOns[i].midi);
    if (list) list.push(i);
    else noteOnByMidi.set(noteOns[i].midi, [i]);
  }

  const noteOffByMidi = new Map<number, number[]>();
  for (let i = 0; i < noteOffs.length; i++) {
    const list = noteOffByMidi.get(noteOffs[i].midi);
    if (list) list.push(i);
    else noteOffByMidi.set(noteOffs[i].midi, [i]);
  }

  const baseOnsetMs = new Array<number>(expectedSteps.length);
  const beatMsByStep = new Array<number>(expectedSteps.length);
  const wEarly = new Array<number>(expectedSteps.length);
  const wLate = new Array<number>(expectedSteps.length);

  for (let i = 0; i < expectedSteps.length; i++) {
    const step = expectedSteps[i];
    baseOnsetMs[i] =
      clockAnchor.t0PerfMs +
      ((step.onsetSec - clockAnchor.startScoreSec) / speed) * 1000;
    beatMsByStep[i] = getBeatMsForMeasure(measureTimelines, step.measureIndex, speed);
  }

  for (let i = 0; i < expectedSteps.length; i++) {
    const localIoi = computeLocalIoiMs(baseOnsetMs, expectedSteps, i, beatMsByStep[i]);
    wEarly[i] = Math.min(maxEarlyMs, 0.4 * localIoi * windowScale);
    wLate[i] = Math.min(maxLateMs, 0.48 * localIoi * windowScale);
  }

  const calibratedEntryOffsetMs = calibrateEntryOffsetMs(
    expectedSteps,
    baseOnsetMs,
    wEarly,
    wLate,
    noteOns,
    noteOnByMidi
  );

  const junctionTargetStepIdx = resolveJunctionStepIndex(
    expectedSteps,
    measureTimelines,
    junctionStepIndex,
    junctionBoundaryCoord
  );

  const usedNoteOns = new Uint8Array(noteOns.length);
  const matchedNotes: AttributedMatchedNote[] = [];
  const missedNotes: AttributedMissedNote[] = [];
  const hesitationBreaks: HesitationBreak[] = [];
  const finalExpectedMs = new Array<number>(expectedSteps.length);
  const stepStrikeMs = new Array<number | null>(expectedSteps.length).fill(null);

  let reanchorShiftMs = 0;
  let reanchorCount = 0;
  let unrecoveredStallDetected = false;
  let lastMatchedStepIdx = -1;
  let lastMatchedStrikeMs = -1;

  const findReleaseEvent = (midi: number, strikeTimeMs: number): NoteOffEvent | undefined => {
    const offs = noteOffByMidi.get(midi);
    if (!offs) return undefined;
    const pos = lowerBoundByTime(offs, noteOffs, strikeTimeMs + 0.001);
    return pos < offs.length ? noteOffs[offs[pos]] : undefined;
  };

  for (let i = 0; i < expectedSteps.length; i++) {
    const step = expectedSteps[i];
    let expectedPerfMs = baseOnsetMs[i] + calibratedEntryOffsetMs + reanchorShiftMs;
    finalExpectedMs[i] = expectedPerfMs;

    const matchInWindow = (centerMs: number) => {
      const low = centerMs - wEarly[i];
      const high = centerMs + wLate[i];
      const hits = new Map<number, number>();
      for (const note of step.expectedNotes) {
        if (hits.has(note.midi)) continue;
        const evIdx = findNearestUnusedIndex(
          note.midi,
          centerMs,
          low,
          high,
          noteOns,
          noteOnByMidi,
          usedNoteOns
        );
        if (evIdx >= 0) hits.set(note.midi, evIdx);
      }
      return hits;
    };

    let matchedByMidi = matchInWindow(expectedPerfMs);

    // If step completely missed its window, check for > 0.6 beat stall & local strong-beat re-anchor
    if (matchedByMidi.size === 0 && step.expectedNotes.length > 0) {
      const beatMs = beatMsByStep[i];
      const stallMinDelayMs = STALL_BEAT_RATIO_THRESHOLD * beatMs;
      const isStrong = isStrongBeatStep(step, expectedSteps[i - 1], measureTimelines);

      // Find candidate delayed shift from unused events matching step's primary pitch
      let candidateDeltaMs: number | null = null;
      for (const midi of step.expectedMidis) {
        const indices = noteOnByMidi.get(midi);
        if (!indices) continue;
        const low = expectedPerfMs + Math.max(wLate[i], stallMinDelayMs);
        const high = expectedPerfMs + MAX_REANCHOR_SHIFT_MS;
        let pos = lowerBoundByTime(indices, noteOns, low);
        for (; pos < indices.length; pos++) {
          const evIdx = indices[pos];
          if (noteOns[evIdx].timeStampMs > high) break;
          if (usedNoteOns[evIdx]) continue;
          const delta = noteOns[evIdx].timeStampMs - expectedPerfMs;
          if (delta > stallMinDelayMs) {
            candidateDeltaMs = delta;
            break;
          }
        }
        if (candidateDeltaMs !== null) break;
      }

      if (candidateDeltaMs !== null) {
        // Verify lookahead step (if present) also aligns at the shifted grid (prevents false re-anchor on a single skipped note)
        let lookaheadConfirmed = true;
        if (i + 1 < expectedSteps.length) {
          const nextStep = expectedSteps[i + 1];
          const nextShiftedMs =
            baseOnsetMs[i + 1] + calibratedEntryOffsetMs + reanchorShiftMs + candidateDeltaMs;
          const nextHasNormalMatch = nextStep.expectedMidis.some(
            (midi) =>
              findNearestUnusedIndex(
                midi,
                baseOnsetMs[i + 1] + calibratedEntryOffsetMs + reanchorShiftMs,
                baseOnsetMs[i + 1] + calibratedEntryOffsetMs + reanchorShiftMs - wEarly[i + 1],
                baseOnsetMs[i + 1] + calibratedEntryOffsetMs + reanchorShiftMs + wLate[i + 1],
                noteOns,
                noteOnByMidi,
                usedNoteOns
              ) >= 0
          );
          const nextHasShiftedMatch = nextStep.expectedMidis.some(
            (midi) =>
              findNearestUnusedIndex(
                midi,
                nextShiftedMs,
                nextShiftedMs - wEarly[i + 1],
                nextShiftedMs + wLate[i + 1],
                noteOns,
                noteOnByMidi,
                usedNoteOns
              ) >= 0
          );
          lookaheadConfirmed = !nextHasNormalMatch && nextHasShiftedMatch;
        }

        if (lookaheadConfirmed) {
          const expectedGapMs =
            lastMatchedStepIdx >= 0
              ? Math.max(1, ((step.onsetSec - expectedSteps[lastMatchedStepIdx].onsetSec) / speed) * 1000)
              : beatMs;
          const actualGapMs =
            lastMatchedStepIdx >= 0
              ? expectedPerfMs + candidateDeltaMs - lastMatchedStrikeMs
              : expectedGapMs + candidateDeltaMs;
          const ioiRatio = actualGapMs / expectedGapMs;
          const beatRatio = candidateDeltaMs / beatMs;
          const isJunction =
            junctionTargetStepIdx >= 0 &&
            (i === junctionTargetStepIdx ||
              (lastMatchedStepIdx >= 0 &&
                lastMatchedStepIdx < junctionTargetStepIdx &&
                i >= junctionTargetStepIdx));

          if (isStrong && reanchorCount < MAX_REANCHORS) {
            reanchorShiftMs += candidateDeltaMs;
            reanchorCount += 1;
            expectedPerfMs = baseOnsetMs[i] + calibratedEntryOffsetMs + reanchorShiftMs;
            finalExpectedMs[i] = expectedPerfMs;
            matchedByMidi = matchInWindow(expectedPerfMs);
            hesitationBreaks.push({
              stepIndex: i,
              measureIndex: step.measureIndex,
              onsetSec: step.onsetSec,
              delayMs: candidateDeltaMs,
              beatRatio,
              ioiRatio,
              isJunction,
              reanchored: true,
            });
          } else if (reanchorCount >= MAX_REANCHORS) {
            unrecoveredStallDetected = true;
            hesitationBreaks.push({
              stepIndex: i,
              measureIndex: step.measureIndex,
              onsetSec: step.onsetSec,
              delayMs: candidateDeltaMs,
              beatRatio,
              ioiRatio,
              isJunction,
              reanchored: false,
            });
          }
        }
      }
    }

    const stepStrikeTimes: number[] = [];
    for (const note of step.expectedNotes) {
      const evIdx = matchedByMidi.get(note.midi);
      if (evIdx !== undefined) {
        usedNoteOns[evIdx] = 1;
        const strike = noteOns[evIdx];
        stepStrikeTimes.push(strike.timeStampMs);
        matchedNotes.push({
          note,
          stepIndex: i,
          strikeEvent: strike,
          releaseEvent: findReleaseEvent(note.midi, strike.timeStampMs),
          expectedPerfMs,
          timingErrorMs: strike.timeStampMs - expectedPerfMs,
          reanchorAppliedMs: reanchorShiftMs,
        });
      } else {
        missedNotes.push({
          note,
          stepIndex: i,
          expectedPerfMs,
        });
      }
    }

    if (stepStrikeTimes.length > 0) {
      const stepMedianStrikeMs = median(stepStrikeTimes);
      stepStrikeMs[i] = stepMedianStrikeMs;

      // Detect matched-step hesitation (e.g., fast tempo with long note values where delay > 0.6 beat landed inside W_late)
      if (lastMatchedStepIdx >= 0) {
        const alreadyRecorded = hesitationBreaks.some((b) => b.stepIndex === i);
        if (!alreadyRecorded) {
          const expectedGapMs = Math.max(
            1,
            ((step.onsetSec - expectedSteps[lastMatchedStepIdx].onsetSec) / speed) * 1000
          );
          const actualGapMs = stepMedianStrikeMs - lastMatchedStrikeMs;
          const delayMs = actualGapMs - expectedGapMs;
          const beatMs = beatMsByStep[i];
          const beatRatio = delayMs / beatMs;
          const ioiRatio = actualGapMs / expectedGapMs;
          if (beatRatio > STALL_BEAT_RATIO_THRESHOLD || (ioiRatio > 1.6 && delayMs >= 450)) {
            const isJunction =
              junctionTargetStepIdx >= 0 &&
              lastMatchedStepIdx < junctionTargetStepIdx &&
              i >= junctionTargetStepIdx;
            hesitationBreaks.push({
              stepIndex: i,
              measureIndex: step.measureIndex,
              onsetSec: step.onsetSec,
              delayMs,
              beatRatio,
              ioiRatio,
              isJunction,
              reanchored: false,
            });
          }
        }
      }

      lastMatchedStepIdx = i;
      lastMatchedStrikeMs = stepMedianStrikeMs;
    }
  }

  const extraEvents: NoteOnEvent[] = [];
  for (let i = 0; i < noteOns.length; i++) {
    if (!usedNoteOns[i]) {
      extraEvents.push(noteOns[i]);
    }
  }

  // Compute timingCv strictly over matched steps (excluding grace notes and hesitation breaks)
  const breakStepIndices = new Set(hesitationBreaks.map((b) => b.stepIndex));
  const normalizedIois: number[] = [];
  let prevStepIdx = -1;
  for (let i = 0; i < expectedSteps.length; i++) {
    if (expectedSteps[i].isGrace || stepStrikeMs[i] === null) continue;
    if (prevStepIdx >= 0 && !breakStepIndices.has(i)) {
      const expectedIoi =
        ((expectedSteps[i].onsetSec - expectedSteps[prevStepIdx].onsetSec) / speed) * 1000;
      const actualIoi = stepStrikeMs[i]! - stepStrikeMs[prevStepIdx]!;
      if (expectedIoi > 1 && actualIoi > 0) {
        normalizedIois.push(actualIoi / expectedIoi);
      }
    }
    prevStepIdx = i;
  }

  let timingCv = 0;
  if (normalizedIois.length >= 2) {
    let sum = 0;
    for (const r of normalizedIois) sum += r;
    const mean = sum / normalizedIois.length;
    if (mean > 0) {
      let sq = 0;
      for (const r of normalizedIois) {
        const d = r - mean;
        sq += d * d;
      }
      timingCv = Math.sqrt(sq / normalizedIois.length) / mean;
    }
  }

  // Compute measureFaultCounts and dominantHandFaultRatio
  const measureFaultCounts: PracticeEvent["measureFaultCounts"] = {};
  const ensureMeasureBucket = (m: number) => {
    let bucket = measureFaultCounts[m];
    if (!bucket) {
      bucket = { missed: 0, extra: 0, hesitations: 0 };
      measureFaultCounts[m] = bucket;
    }
    return bucket;
  };

  let rhFaults = 0;
  let lhFaults = 0;

  for (const m of missedNotes) {
    ensureMeasureBucket(m.note.measureIndex).missed += 1;
    if (m.note.hand === "RH") rhFaults += 1;
    else lhFaults += 1;
  }

  for (const ex of extraEvents) {
    const mIdx = findNearestStepMeasure(ex.timeStampMs, expectedSteps, finalExpectedMs);
    ensureMeasureBucket(mIdx).extra += 1;
    const hand = inferExtraHand(ex, expectedSteps, finalExpectedMs, practiceMode);
    if (hand === "RH") rhFaults += 1;
    else lhFaults += 1;
  }

  for (const brk of hesitationBreaks) {
    ensureMeasureBucket(brk.measureIndex).hesitations += 1;
  }

  const totalHandFaults = rhFaults + lhFaults;
  const dominantHandFaultRatio =
    totalHandFaults > 0
      ? { rh: rhFaults / totalHandFaults, lh: lhFaults / totalHandFaults }
      : { rh: 0, lh: 0 };

  const interiorHesitationCount = hesitationBreaks.filter((b) => !b.isJunction).length;

  let junctionHesitationRatio = 1.0;
  if (junctionTargetStepIdx > 0 && junctionTargetStepIdx < expectedSteps.length) {
    for (const b of hesitationBreaks) {
      if (b.isJunction) {
        junctionHesitationRatio = Math.max(junctionHesitationRatio, b.ioiRatio);
      }
    }
    if (stepStrikeMs[junctionTargetStepIdx] !== null) {
      let prevIdx = junctionTargetStepIdx - 1;
      while (prevIdx >= 0 && stepStrikeMs[prevIdx] === null) prevIdx -= 1;
      if (prevIdx >= 0) {
        const expectedGap =
          ((expectedSteps[junctionTargetStepIdx].onsetSec - expectedSteps[prevIdx].onsetSec) /
            speed) *
          1000;
        const actualGap = stepStrikeMs[junctionTargetStepIdx]! - stepStrikeMs[prevIdx]!;
        if (expectedGap > 1) {
          junctionHesitationRatio = Math.max(junctionHesitationRatio, actualGap / expectedGap);
        }
      }
    }
  }

  // Trailing unrecovered misses (>= 2 consecutive completely-missed steps at the tail)
  let trailingMissedSteps = 0;
  for (let i = expectedSteps.length - 1; i >= 0; i--) {
    if (expectedSteps[i].expectedNotes.length > 0 && stepStrikeMs[i] === null) {
      trailingMissedSteps += 1;
    } else if (expectedSteps[i].expectedNotes.length > 0) {
      break;
    }
  }

  const stallDetected =
    unrecoveredStallDetected ||
    (expectedSteps.length >= 3 && trailingMissedSteps >= 2 && matchedNotes.length > 0) ||
    hesitationBreaks.some(
      (b) => b.beatRatio > SEVERE_STALL_RATIO_THRESHOLD || b.ioiRatio > SEVERE_STALL_RATIO_THRESHOLD
    );

  const totalExpectedNotes = matchedNotes.length + missedNotes.length;
  const pitchAccuracy =
    totalExpectedNotes + extraEvents.length > 0
      ? matchedNotes.length / (totalExpectedNotes + extraEvents.length)
      : 1;

  const switchBranchMismatch = checkSwitchBranchMismatch(
    switchPoint,
    expectedSteps,
    finalExpectedMs,
    wEarly,
    missedNotes,
    extraEvents
  );

  return {
    calibratedEntryOffsetMs,
    matchedNotes,
    missedNotes,
    extraEvents,
    filteredGhostCount,
    filteredExemptCount,
    hesitationBreaks,
    fluency: {
      pitchAccuracy,
      interiorHesitationCount,
      junctionHesitationRatio,
      timingCv,
      stallDetected,
      dominantHandFaultRatio,
      switchBranchMismatch,
      reanchorCount,
    },
    measureFaultCounts,
  };
}
