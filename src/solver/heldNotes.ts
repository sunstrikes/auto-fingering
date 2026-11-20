import type { HandSpanProfile, OnsetSlice } from "../domain/types";
import { MAX_OCTAVE_SPAN, getMaxSpan, getSpanScale, keyPos } from "./keyboard";
import { DEFAULT_COST_WEIGHTS } from "./weights";

export const SHORT_ROLL_MAX_IOI_SEC = 0.08;

export type HeldReleaseReason = "pedal" | "unreachable" | "pre-release";

export interface ReleasedHeldNote {
  noteUid: string;
  midi: number;
  endTick: number;
  onsetTick?: number;
  reason: HeldReleaseReason;
  minOverSpan: number;
}

export interface HandHeldAnalysis {
  activeHeldBySlice: OnsetSlice["heldNotes"][];
  releasedHeldBySlice: ReleasedHeldNote[][];
  rollReleasableUids: Set<string>;
}

function sliceMidiBounds(slice: OnsetSlice): { minMidi: number; maxMidi: number } | null {
  if (slice.notes.length === 0) return null;
  let minMidi = Infinity;
  let maxMidi = -Infinity;
  for (const n of slice.notes) {
    if (n.midi < minMidi) minMidi = n.midi;
    if (n.midi > maxMidi) maxMidi = n.midi;
  }
  return { minMidi, maxMidi };
}

/**
 * Detects tightly spaced directional roll / arpeggio groups (`dt < 80 ms` within
 * the same measure and phrase, expanding monotonically in pitch) and returns the
 * set of earlier noteUids that may be released to sustain pedal if needed.
 */
export function detectShortRollReleasableUids(handSlices: OnsetSlice[]): Set<string> {
  const rollReleasableUids = new Set<string>();
  if (handSlices.length < 2) return rollReleasableUids;

  const midiBounds = handSlices.map(sliceMidiBounds);
  let activeDir: 1 | -1 | 0 = 0;

  for (let t = 0; t < handSlices.length - 1; t++) {
    const prev = handSlices[t];
    const next = handSlices[t + 1];
    const prevB = midiBounds[t];
    const nextB = midiBounds[t + 1];
    const dt = next.onsetSec - prev.onsetSec;

    if (
      !prevB ||
      !nextB ||
      prev.measureIndex !== next.measureIndex ||
      prev.phraseId !== next.phraseId ||
      dt <= 0 ||
      dt >= SHORT_ROLL_MAX_IOI_SEC
    ) {
      activeDir = 0;
      continue;
    }

    const isAsc =
      (nextB.minMidi >= prevB.minMidi && nextB.maxMidi > prevB.maxMidi) ||
      (nextB.minMidi > prevB.minMidi && nextB.maxMidi >= prevB.maxMidi);
    const isDesc =
      (nextB.maxMidi <= prevB.maxMidi && nextB.minMidi < prevB.minMidi) ||
      (nextB.maxMidi < prevB.maxMidi && nextB.minMidi <= prevB.minMidi);

    const stepDir: 1 | -1 | 0 = isAsc && !isDesc ? 1 : isDesc && !isAsc ? -1 : 0;
    if (stepDir === 0) {
      activeDir = 0;
      continue;
    }

    if (activeDir === 0 || activeDir === stepDir) {
      activeDir = stepDir;
      const nextHeldSet = new Set(next.heldNotes.map((h) => h.noteUid));
      for (const n of prev.notes) {
        if (nextHeldSet.has(n.noteUid)) {
          rollReleasableUids.add(n.noteUid);
        }
      }
    } else {
      activeDir = stepDir;
    }
  }

  return rollReleasableUids;
}

function sliceNotePosBounds(slice: OnsetSlice): { minPos: number; maxPos: number } {
  let minPos = Infinity;
  let maxPos = -Infinity;
  for (const n of slice.notes) {
    const p = keyPos(n.midi);
    if (p < minPos) minPos = p;
    if (p > maxPos) maxPos = p;
  }
  return { minPos, maxPos };
}

/**
 * Classifies held notes for a single hand's chronological slice stream into
 * physically finger-held notes (`activeHeldBySlice`) vs notes released to sustain
 * pedal or lifted early because they become unreachable (`releasedHeldBySlice`).
 */
export function analyzeHandHeldNotes(
  handSlices: OnsetSlice[],
  profile: HandSpanProfile
): HandHeldAnalysis {
  const scale = getSpanScale(profile);
  const maxOuterSpan = Math.min(getMaxSpan(1, 5, scale), MAX_OCTAVE_SPAN);
  const wideThreshold = maxOuterSpan * DEFAULT_COST_WEIGHTS.vertical.wideStretchThreshold;

  // Pass 1: Look ahead for held notes that eventually exceed max outer (1-5) reach
  // against struck notes OR newer simultaneously held notes (joint envelope check)
  const eventuallyUnreachableUids = new Set<string>();
  const boundsBySlice = handSlices.map((s) =>
    s.notes.length > 0 ? sliceNotePosBounds(s) : null
  );

  for (let t = 0; t < handSlices.length; t++) {
    const slice = handSlices[t];
    const bounds = boundsBySlice[t];
    if (slice.heldNotes.length === 0) continue;

    const nonPedalNewestFirst = slice.heldNotes
      .filter((h) => !h.pedalSustained)
      .sort((a, b) => (b.onsetTick ?? 0) - (a.onsetTick ?? 0));

    let envMin = bounds ? bounds.minPos : Infinity;
    let envMax = bounds ? bounds.maxPos : -Infinity;

    for (const h of nonPedalNewestFirst) {
      const hPos = keyPos(h.midi);
      const nextMin = Math.min(envMin, hPos);
      const nextMax = Math.max(envMax, hPos);
      const requiredOuterSpan = nextMin === Infinity ? 0 : nextMax - nextMin;
      if (requiredOuterSpan > maxOuterSpan + 1e-6) {
        eventuallyUnreachableUids.add(h.noteUid);
      } else {
        envMin = nextMin;
        envMax = nextMax;
      }
    }
  }

  // Pass 2: Chronological monotonic release scan (once lifted, a held note is not re-pressed)
  const releasedUids = new Set<string>();
  const activeHeldBySlice: OnsetSlice["heldNotes"][] = [];
  const releasedHeldBySlice: ReleasedHeldNote[][] = [];

  for (let t = 0; t < handSlices.length; t++) {
    const slice = handSlices[t];
    const bounds = boundsBySlice[t];
    const activeSet = new Set<string>();
    const releasedMap = new Map<string, ReleasedHeldNote>();

    const nonPedalNewestFirst: OnsetSlice["heldNotes"] = [];
    for (const h of slice.heldNotes) {
      if (h.pedalSustained) {
        releasedUids.add(h.noteUid);
        releasedMap.set(h.noteUid, {
          noteUid: h.noteUid,
          midi: h.midi,
          endTick: h.endTick,
          onsetTick: h.onsetTick,
          reason: "pedal",
          minOverSpan: 0,
        });
      } else {
        nonPedalNewestFirst.push(h);
      }
    }

    nonPedalNewestFirst.sort((a, b) => (b.onsetTick ?? 0) - (a.onsetTick ?? 0));

    let envMin = bounds ? bounds.minPos : Infinity;
    let envMax = bounds ? bounds.maxPos : -Infinity;

    for (const h of nonPedalNewestFirst) {
      const hPos = keyPos(h.midi);
      const nextMin = Math.min(envMin, hPos);
      const nextMax = Math.max(envMax, hPos);
      const requiredOuterSpan = nextMin === Infinity ? 0 : nextMax - nextMin;

      if (requiredOuterSpan > maxOuterSpan + 1e-6) {
        releasedUids.add(h.noteUid);
        releasedMap.set(h.noteUid, {
          noteUid: h.noteUid,
          midi: h.midi,
          endTick: h.endTick,
          onsetTick: h.onsetTick,
          reason: "unreachable",
          minOverSpan: requiredOuterSpan - maxOuterSpan,
        });
      } else if (releasedUids.has(h.noteUid)) {
        releasedMap.set(h.noteUid, {
          noteUid: h.noteUid,
          midi: h.midi,
          endTick: h.endTick,
          onsetTick: h.onsetTick,
          reason: "pre-release",
          minOverSpan: 0,
        });
      } else if (
        eventuallyUnreachableUids.has(h.noteUid) &&
        requiredOuterSpan >= wideThreshold
      ) {
        releasedUids.add(h.noteUid);
        releasedMap.set(h.noteUid, {
          noteUid: h.noteUid,
          midi: h.midi,
          endTick: h.endTick,
          onsetTick: h.onsetTick,
          reason: "pre-release",
          minOverSpan: 0,
        });
      } else {
        activeSet.add(h.noteUid);
        envMin = nextMin;
        envMax = nextMax;
      }
    }

    const activeHeld: OnsetSlice["heldNotes"] = [];
    const releasedHeld: ReleasedHeldNote[] = [];
    for (const h of slice.heldNotes) {
      if (activeSet.has(h.noteUid)) {
        activeHeld.push(h);
      } else {
        const rel = releasedMap.get(h.noteUid);
        if (rel) releasedHeld.push(rel);
      }
    }

    activeHeldBySlice.push(activeHeld);
    releasedHeldBySlice.push(releasedHeld);
  }

  const rollReleasableUids = detectShortRollReleasableUids(handSlices);

  return { activeHeldBySlice, releasedHeldBySlice, rollReleasableUids };
}

/**
 * Returns shallow-cloned slices whose `heldNotes` reflect only physically held notes.
 */
export function applyEffectiveHeldNotes(
  handSlices: OnsetSlice[],
  analysis: HandHeldAnalysis
): OnsetSlice[] {
  return handSlices.map((slice, idx) => ({
    ...slice,
    heldNotes: analysis.activeHeldBySlice[idx] ?? slice.heldNotes,
  }));
}
