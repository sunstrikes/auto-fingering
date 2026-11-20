import type { HandSpanProfile, OnsetSlice } from "../domain/types";
import { MAX_OCTAVE_SPAN, getMaxSpan, getSpanScale, keyPos } from "./keyboard";
import { DEFAULT_COST_WEIGHTS } from "./weights";

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

  return { activeHeldBySlice, releasedHeldBySlice };
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
