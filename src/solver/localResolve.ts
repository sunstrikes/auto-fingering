import {
  DEFAULT_HAND_SPAN_PROFILE,
  type AnchorOverride,
  type Finger,
  type HandSpanProfile,
  type NoteEvent,
  type OnsetSlice,
  type SolveResult,
} from "../domain/types";
import { analyzeHandHeldNotes, applyEffectiveHeldNotes } from "./heldNotes";
import { getMaxSpan, getSpanScale, toHandFramePos } from "./keyboard";
import { analyzeScoreRepairSuggestions } from "./scoreRepair";
import {
  advanceBeamLayer,
  derivePositionsAndCues,
  prepareSegmentBeamContext,
  type BeamNode,
} from "./solveFingering";

const LOCAL_MEASURE_RADIUS = 16;

export interface LocalResolveInput {
  onsetSlices: OnsetSlice[];
  priorFingerByNoteUid: Record<string, Finger>;
  targetNoteUid: string;
  override: AnchorOverride | null;
  anchors: Record<string, AnchorOverride>;
  removedRawAnchorUids?: string[];
  profile?: HandSpanProfile;
  ignoreExistingFingerings?: boolean;
}

export function applyAnchorOverridesToSlices(
  slices: OnsetSlice[],
  anchors: Record<string, AnchorOverride>,
  removedRawAnchorUids: string[] = [],
  ignoreExistingFingerings = false
): OnsetSlice[] {
  const removedRawSet = new Set(removedRawAnchorUids);
  return slices.map((slice) => ({
    ...slice,
    notes: slice.notes.map((note): NoteEvent => {
      const userOverride = anchors[note.noteUid];
      if (userOverride) {
        return {
          ...note,
          anchorFinger: userOverride.finger,
          anchorExitFinger: undefined,
          anchorMode: userOverride.mode,
          anchorRawPreserved: false,
        };
      }
      if (removedRawSet.has(note.noteUid) || (ignoreExistingFingerings && note.anchorRawPreserved)) {
        return {
          ...note,
          anchorFinger: undefined,
          anchorExitFinger: undefined,
          anchorMode: undefined,
          anchorRawPreserved: false,
        };
      }
      return note;
    }),
  }));
}

function fingersEqual(a: Finger[], b: Finger[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function slicePriorFingers(
  slice: OnsetSlice,
  priorFingerByNoteUid: Record<string, Finger>
): Finger[] | null {
  const result: Finger[] = [];
  for (const note of slice.notes) {
    const f = priorFingerByNoteUid[note.noteUid];
    if (!f) return null;
    result.push(f);
  }
  return result;
}

function resolvePinOnlyOverride(
  targetSlice: OnsetSlice,
  targetNoteUid: string,
  finger: Finger,
  fingerByNoteUid: Record<string, Finger>,
  profile: HandSpanProfile,
  effectiveHeldNotes: OnsetSlice["heldNotes"] = targetSlice.heldNotes
): { anchorConflictSliceIds: Set<string>; repairedAnchorUids: string[] } {
  fingerByNoteUid[targetNoteUid] = finger;
  const anchorConflictSliceIds = new Set<string>();
  const scale = getSpanScale(profile);

  const targetNote = targetSlice.notes.find((n) => n.noteUid === targetNoteUid);
  if (targetNote) {
    let hasConflict = false;
    for (const sibling of targetSlice.notes) {
      if (sibling.noteUid === targetNoteUid) continue;
      const sibF = fingerByNoteUid[sibling.noteUid];
      if (sibF === finger) {
        const semitoneDiff = Math.abs(sibling.midi - targetNote.midi);
        const dist = Math.abs(
          toHandFramePos(sibling.midi, targetSlice.hand) -
            toHandFramePos(targetNote.midi, targetSlice.hand)
        );
        const isValidDouble = (finger === 1 || finger === 5) && semitoneDiff <= 2 && dist <= 1.5;
        if (!isValidDouble) {
          hasConflict = true;
          break;
        }
      }
    }
    if (!hasConflict) {
      for (const held of effectiveHeldNotes) {
        const heldF = fingerByNoteUid[held.noteUid];
        if (heldF === finger && held.midi !== targetNote.midi) {
          hasConflict = true;
          break;
        }
        if (heldF && heldF !== finger) {
          const dist = Math.abs(
            toHandFramePos(targetNote.midi, targetSlice.hand) -
              toHandFramePos(held.midi, targetSlice.hand)
          );
          if (dist > getMaxSpan(heldF, finger, scale) + 1e-6) {
            hasConflict = true;
            break;
          }
        }
      }
    }
    if (hasConflict) {
      anchorConflictSliceIds.add(targetSlice.sliceId);
    }
  }

  return { anchorConflictSliceIds, repairedAnchorUids: [] };
}

function solveWindowWithConvergence(
  segment: OnsetSlice[],
  startIdx: number,
  targetSegIdx: number,
  maxIdx: number,
  priorFingerByNoteUid: Record<string, Finger>,
  profile: HandSpanProfile,
  anchorConflictSliceIds: Set<string>
): { endIdx: number; chosen: Finger[][]; convergedBackward: boolean } {
  const windowSlices = segment.slice(startIdx, maxIdx + 1);
  const localTargetIdx = targetSegIdx - startIdx;
  const { candidatesBySlice, lookahead } = prepareSegmentBeamContext(
    windowSlices,
    profile,
    anchorConflictSliceIds,
    false
  );

  const layers: BeamNode[][] = [];
  const prevPrefixSlice = startIdx > 0 ? segment[startIdx - 1] : null;
  const prevPrefixFingers = prevPrefixSlice
    ? slicePriorFingers(prevPrefixSlice, priorFingerByNoteUid)
    : null;

  let convergedEndLocal = windowSlices.length - 1;

  for (let localT = 0; localT < windowSlices.length; localT++) {
    const slice = windowSlices[localT];
    const nextSliceHeldUids =
      localT + 1 < windowSlices.length
        ? windowSlices[localT + 1].heldNotes.map((h) => h.noteUid)
        : [];
    const deduped = advanceBeamLayer({
      slices: windowSlices,
      layers,
      t: localT,
      candidates: candidatesBySlice[localT],
      nextSliceHeldUids,
      lookahead,
      profile,
      priorFingerByNoteUid,
      prevPrefixSlice,
      prevPrefixFingers,
    });
    layers.push(deduped);

    // Check forward convergence with prior solution after passing target slice
    if (localT >= localTargetIdx + 2 && localT < windowSlices.length - 1 && deduped.length > 0) {
      const top = deduped[0];
      const priorCurr = slicePriorFingers(slice, priorFingerByNoteUid);
      const priorPrev = slicePriorFingers(windowSlices[localT - 1], priorFingerByNoteUid);
      const nextHeldEmpty = nextSliceHeldUids.length === 0;
      if (
        priorCurr &&
        priorPrev &&
        nextHeldEmpty &&
        fingersEqual(top.fingers, priorCurr) &&
        fingersEqual(layers[localT - 1][top.prevIdx].fingers, priorPrev)
      ) {
        convergedEndLocal = localT;
        break;
      }
    }
  }

  const lastLayer = layers[convergedEndLocal];
  let bestIdx = 0;
  for (let i = 1; i < lastLayer.length; i++) {
    if (lastLayer[i].totalCost < lastLayer[bestIdx].totalCost) {
      bestIdx = i;
    }
  }

  const chosen: Finger[][] = new Array(convergedEndLocal + 1);
  let cursor = bestIdx;
  for (let localT = convergedEndLocal; localT >= 0; localT--) {
    const node = layers[localT][cursor];
    chosen[localT] = node.fingers;
    cursor = node.prevIdx;
  }

  let convergedBackward = true;
  if (startIdx > 0 && chosen.length > 0) {
    const priorFirst = slicePriorFingers(windowSlices[0], priorFingerByNoteUid);
    if (!priorFirst || !fingersEqual(chosen[0], priorFirst)) {
      convergedBackward = false;
    }
  }

  return {
    endIdx: startIdx + convergedEndLocal,
    chosen,
    convergedBackward,
  };
}

/**
 * Locally re-solves fingering around a single AnchorOverride change or removal.
 * - `pinOnly`: updates only targetNoteUid and recomputes cues/positions without disturbing neighbors.
 * - `phrase` (or removal `override === null`): re-solves only the target hand's current `phraseId`
 *   segment within `+-16` measures, truncating forward/backward once DP states converge.
 */
export function localResolveFingering(input: LocalResolveInput): SolveResult {
  const start = typeof performance !== "undefined" ? performance.now() : Date.now();
  const profile = input.profile ?? DEFAULT_HAND_SPAN_PROFILE;
  const ignoreExistingFingerings = Boolean(input.ignoreExistingFingerings);
  const fingerByNoteUid: Record<string, Finger> = { ...input.priorFingerByNoteUid };

  const targetSlice = input.onsetSlices.find((s) =>
    s.notes.some((n) => n.noteUid === input.targetNoteUid)
  );

  if (!targetSlice) {
    const { handPositions, transitionCues } = derivePositionsAndCues(
      input.onsetSlices,
      fingerByNoteUid,
      profile,
      new Set<string>()
    );
    const warnings = transitionCues.filter((c) => c.severity === "warn" || c.severity === "danger");
    const repairSuggestions = analyzeScoreRepairSuggestions(input.onsetSlices, profile);
    return {
      fingerByNoteUid,
      handPositions,
      transitionCues,
      warnings,
      repairedAnchorUids: [],
      solveTimeMs: (typeof performance !== "undefined" ? performance.now() : Date.now()) - start,
      repairSuggestions,
    };
  }

  let anchorConflictSliceIds = new Set<string>();
  const repairedAnchorUids: string[] = [];

  if (input.override !== null && input.override.mode === "pinOnly") {
    const handSlices = input.onsetSlices.filter((s) => s.hand === targetSlice.hand);
    const { activeHeldBySlice } = analyzeHandHeldNotes(handSlices, profile);
    const targetHandIdx = handSlices.findIndex((s) => s.sliceId === targetSlice.sliceId);
    const effectiveHeldNotes =
      targetHandIdx >= 0 ? activeHeldBySlice[targetHandIdx] : targetSlice.heldNotes;

    const pinRes = resolvePinOnlyOverride(
      targetSlice,
      input.targetNoteUid,
      input.override.finger,
      fingerByNoteUid,
      profile,
      effectiveHeldNotes
    );
    anchorConflictSliceIds = pinRes.anchorConflictSliceIds;
  } else {
    const rawSegment = input.onsetSlices.filter(
      (s) => s.hand === targetSlice.hand && s.phraseId === targetSlice.phraseId
    );
    const segment = applyAnchorOverridesToSlices(
      rawSegment,
      input.anchors,
      input.removedRawAnchorUids ?? [],
      ignoreExistingFingerings
    );
    const effectiveSegment = applyEffectiveHeldNotes(
      segment,
      analyzeHandHeldNotes(segment, profile)
    );
    const targetSegIdx = effectiveSegment.findIndex((s) => s.sliceId === targetSlice.sliceId);
    const targetMeasure = targetSlice.measureIndex;

    let minIdx = targetSegIdx;
    while (
      minIdx > 0 &&
      targetMeasure - effectiveSegment[minIdx - 1].measureIndex <= LOCAL_MEASURE_RADIUS
    ) {
      minIdx--;
    }
    let maxIdx = targetSegIdx;
    while (
      maxIdx + 1 < effectiveSegment.length &&
      effectiveSegment[maxIdx + 1].measureIndex - targetMeasure <= LOCAL_MEASURE_RADIUS
    ) {
      maxIdx++;
    }

    // Expand backward lookback geometrically until DP converges at the left edge or hits minIdx
    let lookback = 8;
    let finalStart = minIdx;
    let finalChosen: Finger[][] = [];
    let finalConflicts = new Set<string>();

    while (true) {
      let startIdx = Math.max(minIdx, targetSegIdx - lookback);
      while (startIdx > minIdx && effectiveSegment[startIdx].heldNotes.length > 0) {
        startIdx--;
      }

      const attemptConflicts = new Set<string>();
      const attempt = solveWindowWithConvergence(
        effectiveSegment,
        startIdx,
        targetSegIdx,
        maxIdx,
        input.priorFingerByNoteUid,
        profile,
        attemptConflicts
      );

      finalStart = startIdx;
      finalChosen = attempt.chosen;
      finalConflicts = attemptConflicts;

      if (attempt.convergedBackward || startIdx === minIdx) {
        break;
      }
      lookback *= 2;
    }

    anchorConflictSliceIds = finalConflicts;

    for (let offset = 0; offset < finalChosen.length; offset++) {
      const slice = effectiveSegment[finalStart + offset];
      const fingers = finalChosen[offset];
      for (let i = 0; i < slice.notes.length; i++) {
        const note = slice.notes[i];
        fingerByNoteUid[note.noteUid] = fingers[i];
        if (note.anchorFinger !== undefined && fingers[i] !== note.anchorFinger) {
          repairedAnchorUids.push(note.noteUid);
        }
      }
    }
  }

  const effectiveSlices = applyAnchorOverridesToSlices(
    input.onsetSlices,
    input.anchors,
    input.removedRawAnchorUids ?? [],
    ignoreExistingFingerings
  );
  const { handPositions, transitionCues } = derivePositionsAndCues(
    effectiveSlices,
    fingerByNoteUid,
    profile,
    anchorConflictSliceIds,
    ignoreExistingFingerings
  );
  const warnings = transitionCues.filter((c) => c.severity === "warn" || c.severity === "danger");
  const repairSuggestions = analyzeScoreRepairSuggestions(effectiveSlices, profile);
  const end = typeof performance !== "undefined" ? performance.now() : Date.now();

  return {
    fingerByNoteUid,
    handPositions,
    transitionCues,
    warnings,
    repairedAnchorUids,
    solveTimeMs: end - start,
    repairSuggestions,
  };
}
