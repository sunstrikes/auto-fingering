import type { HandSpanProfile, OnsetSlice } from "../domain/types";
import { getMaxSpan, getSpanScale, keyPos } from "./keyboard";
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
  const maxOuterSpan = getMaxSpan(1, 5, scale);
  const wideThreshold = maxOuterSpan * DEFAULT_COST_WEIGHTS.vertical.wideStretchThreshold;

  // Pass 1: Look ahead for held notes that eventually exceed max outer (1-5) reach
  const eventuallyUnreachableUids = new Set<string>();
  const boundsBySlice = handSlices.map((s) =>
    s.notes.length > 0 ? sliceNotePosBounds(s) : null
  );

  for (let t = 0; t < handSlices.length; t++) {
    const slice = handSlices[t];
    const bounds = boundsBySlice[t];
    if (!bounds || slice.heldNotes.length === 0) continue;

    for (const h of slice.heldNotes) {
      if (h.pedalSustained) continue;
      const hPos = keyPos(h.midi);
      const requiredOuterSpan =
        Math.max(bounds.maxPos, hPos) - Math.min(bounds.minPos, hPos);
      if (requiredOuterSpan > maxOuterSpan) {
        eventuallyUnreachableUids.add(h.noteUid);
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
    const activeHeld: OnsetSlice["heldNotes"] = [];
    const releasedHeld: ReleasedHeldNote[] = [];

    for (const h of slice.heldNotes) {
      const hPos = keyPos(h.midi);
      const requiredOuterSpan = bounds
        ? Math.max(bounds.maxPos, hPos) - Math.min(bounds.minPos, hPos)
        : 0;

      if (h.pedalSustained) {
        releasedUids.add(h.noteUid);
        releasedHeld.push({
          noteUid: h.noteUid,
          midi: h.midi,
          endTick: h.endTick,
          onsetTick: h.onsetTick,
          reason: "pedal",
          minOverSpan: 0,
        });
      } else if (requiredOuterSpan > maxOuterSpan) {
        releasedUids.add(h.noteUid);
        releasedHeld.push({
          noteUid: h.noteUid,
          midi: h.midi,
          endTick: h.endTick,
          onsetTick: h.onsetTick,
          reason: "unreachable",
          minOverSpan: requiredOuterSpan - maxOuterSpan,
        });
      } else if (releasedUids.has(h.noteUid)) {
        releasedHeld.push({
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
        releasedHeld.push({
          noteUid: h.noteUid,
          midi: h.midi,
          endTick: h.endTick,
          onsetTick: h.onsetTick,
          reason: "pre-release",
          minOverSpan: 0,
        });
      } else {
        activeHeld.push(h);
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
