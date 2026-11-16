import {
  DEFAULT_HAND_SPAN_PROFILE,
  type AnchorOverride,
  type Finger,
  type HandSpanProfile,
  type NoteEvent,
  type OnsetSlice,
  type SolveResult,
} from "../domain/types";
import { computeHorizontalCost, computeVerticalCost, generateSliceCandidates } from "./costModel";
import { getMaxSpan, getSpanScale, toHandFramePos } from "./keyboard";
import {
  BEAM_WIDTH,
  buildStateKeyAndLookaheadPenalty,
  computeAnchorLookahead,
  derivePositionsAndCues,
  resolveCrossSliceAnchorConflicts,
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
          anchorMode: userOverride.mode,
          anchorRawPreserved: false,
        };
      }
      if (removedRawSet.has(note.noteUid) || (ignoreExistingFingerings && note.anchorRawPreserved)) {
        return {
          ...note,
          anchorFinger: undefined,
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

function buildWindowHeldFingerMap(
  slice: OnsetSlice,
  windowSlices: OnsetSlice[],
  layers: BeamNode[][],
  localT: number,
  pIdx: number,
  priorFingerByNoteUid: Record<string, Finger>
): Map<Finger, number> {
  const heldMap = new Map<Finger, number>();
  if (slice.heldNotes.length === 0) return heldMap;

  const heldByUid = new Map<string, number>();
  for (const h of slice.heldNotes) {
    heldByUid.set(h.noteUid, h.midi);
  }

  let cursor = pIdx;
  for (let back = localT - 1; back >= 0 && heldByUid.size > 0 && cursor >= 0; back--) {
    const prevSlice = windowSlices[back];
    const node = layers[back][cursor];
    for (let i = 0; i < prevSlice.notes.length; i++) {
      const uid = prevSlice.notes[i].noteUid;
      const midi = heldByUid.get(uid);
      if (midi !== undefined) {
        heldMap.set(node.fingers[i], midi);
        heldByUid.delete(uid);
      }
    }
    cursor = node.prevIdx;
  }

  for (const [uid, midi] of heldByUid.entries()) {
    const priorF = priorFingerByNoteUid[uid];
    if (priorF) {
      heldMap.set(priorF, midi);
    }
  }
  return heldMap;
}

function resolvePinOnlyOverride(
  targetSlice: OnsetSlice,
  targetNoteUid: string,
  finger: Finger,
  fingerByNoteUid: Record<string, Finger>,
  profile: HandSpanProfile
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
      for (const held of targetSlice.heldNotes) {
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
          if (dist > getMaxSpan(heldF, finger, scale)) {
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
  const candidatesBySlice: Finger[][][] = [];
  let hasAnyAnchors = false;

  for (let i = 0; i < windowSlices.length; i++) {
    const slice = windowSlices[i];
    if (slice.notes.some((n) => n.anchorFinger !== undefined)) {
      hasAnyAnchors = true;
    }
    const { candidates, hadAnchorConflict } = generateSliceCandidates(slice, false, profile);
    if (hadAnchorConflict) {
      anchorConflictSliceIds.add(slice.sliceId);
    }
    candidatesBySlice.push(candidates);
  }

  if (hasAnyAnchors) {
    resolveCrossSliceAnchorConflicts(windowSlices, candidatesBySlice, profile, anchorConflictSliceIds);
  }

  const lookahead = hasAnyAnchors
    ? computeAnchorLookahead(windowSlices, candidatesBySlice, profile)
    : null;

  const layers: BeamNode[][] = [];
  const prevPrefixSlice = startIdx > 0 ? segment[startIdx - 1] : null;
  const prevPrefixFingers = prevPrefixSlice
    ? slicePriorFingers(prevPrefixSlice, priorFingerByNoteUid)
    : null;

  let convergedEndLocal = windowSlices.length - 1;

  for (let localT = 0; localT < windowSlices.length; localT++) {
    const slice = windowSlices[localT];
    const candidates = candidatesBySlice[localT];
    const nextSliceHeldUids =
      localT + 1 < windowSlices.length
        ? windowSlices[localT + 1].heldNotes.map((h) => h.noteUid)
        : [];
    const nextBeam: BeamNode[] = [];

    if (localT === 0) {
      const heldFingers = buildWindowHeldFingerMap(
        slice,
        windowSlices,
        layers,
        0,
        -1,
        priorFingerByNoteUid
      );
      for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
        const cand = candidates[cIdx];
        const vertCost = computeVerticalCost(slice, cand, heldFingers, profile).cost;
        const horizCost =
          prevPrefixSlice && prevPrefixFingers
            ? computeHorizontalCost(prevPrefixSlice, prevPrefixFingers, slice, cand, profile).cost
            : 0;
        const totalCost = vertCost + horizCost;
        const { stateKey, penalty } = buildStateKeyAndLookaheadPenalty(
          slice,
          cand,
          windowSlices,
          layers,
          localT,
          -1,
          cIdx,
          nextSliceHeldUids,
          lookahead
        );
        nextBeam.push({
          fingers: cand,
          totalCost,
          rankScore: totalCost + penalty,
          prevIdx: -1,
          stateKey,
        });
      }
    } else {
      const prevBeam = layers[localT - 1];
      const prevSlice = windowSlices[localT - 1];
      const cachedVertCosts =
        slice.heldNotes.length === 0
          ? candidates.map(
              (cand) => computeVerticalCost(slice, cand, new Map<Finger, number>(), profile).cost
            )
          : null;

      for (let pIdx = 0; pIdx < prevBeam.length; pIdx++) {
        const prevNode = prevBeam[pIdx];
        const heldFingers =
          slice.heldNotes.length > 0
            ? buildWindowHeldFingerMap(
                slice,
                windowSlices,
                layers,
                localT,
                pIdx,
                priorFingerByNoteUid
              )
            : null;

        for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
          const cand = candidates[cIdx];
          const vertCost =
            cachedVertCosts !== null
              ? cachedVertCosts[cIdx]
              : computeVerticalCost(slice, cand, heldFingers!, profile).cost;
          const horiz = computeHorizontalCost(
            prevSlice,
            prevNode.fingers,
            slice,
            cand,
            profile
          );
          const totalCost = prevNode.totalCost + vertCost + horiz.cost;
          const { stateKey, penalty } = buildStateKeyAndLookaheadPenalty(
            slice,
            cand,
            windowSlices,
            layers,
            localT,
            pIdx,
            cIdx,
            nextSliceHeldUids,
            lookahead
          );
          nextBeam.push({
            fingers: cand,
            totalCost,
            rankScore: totalCost + penalty,
            prevIdx: pIdx,
            stateKey,
          });
        }
      }
    }

    nextBeam.sort((a, b) => a.rankScore - b.rankScore || a.totalCost - b.totalCost);
    const deduped: BeamNode[] = [];
    const seenStates = new Set<string>();
    for (const node of nextBeam) {
      if (seenStates.has(node.stateKey)) continue;
      seenStates.add(node.stateKey);
      deduped.push(node);
      if (deduped.length >= BEAM_WIDTH) break;
    }
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
    return {
      fingerByNoteUid,
      handPositions,
      transitionCues,
      warnings,
      repairedAnchorUids: [],
      solveTimeMs: (typeof performance !== "undefined" ? performance.now() : Date.now()) - start,
    };
  }

  let anchorConflictSliceIds = new Set<string>();
  const repairedAnchorUids: string[] = [];

  if (input.override !== null && input.override.mode === "pinOnly") {
    const pinRes = resolvePinOnlyOverride(
      targetSlice,
      input.targetNoteUid,
      input.override.finger,
      fingerByNoteUid,
      profile
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
    const targetSegIdx = segment.findIndex((s) => s.sliceId === targetSlice.sliceId);
    const targetMeasure = targetSlice.measureIndex;

    let minIdx = targetSegIdx;
    while (minIdx > 0 && targetMeasure - segment[minIdx - 1].measureIndex <= LOCAL_MEASURE_RADIUS) {
      minIdx--;
    }
    let maxIdx = targetSegIdx;
    while (
      maxIdx + 1 < segment.length &&
      segment[maxIdx + 1].measureIndex - targetMeasure <= LOCAL_MEASURE_RADIUS
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
      while (startIdx > minIdx && segment[startIdx].heldNotes.length > 0) {
        startIdx--;
      }

      const attemptConflicts = new Set<string>();
      const attempt = solveWindowWithConvergence(
        segment,
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
      const slice = segment[finalStart + offset];
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

  const { handPositions, transitionCues } = derivePositionsAndCues(
    input.onsetSlices,
    fingerByNoteUid,
    profile,
    anchorConflictSliceIds
  );
  const warnings = transitionCues.filter((c) => c.severity === "warn" || c.severity === "danger");
  const end = typeof performance !== "undefined" ? performance.now() : Date.now();

  return {
    fingerByNoteUid,
    handPositions,
    transitionCues,
    warnings,
    repairedAnchorUids,
    solveTimeMs: end - start,
  };
}
