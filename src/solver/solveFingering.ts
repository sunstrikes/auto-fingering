import {
  DEFAULT_HAND_SPAN_PROFILE,
  type EarlyReleaseReason,
  type Finger,
  type Hand,
  type HandPosition,
  type HandSpanProfile,
  type HeldNoteRelease,
  type OnsetSlice,
  type SolveOptions,
  type SolveResult,
  type TransitionCue,
} from "../domain/types";
import {
  computeHandRoot,
  computeHorizontalCost,
  computeVerticalCost,
  generateSliceCandidates,
  resolveDepartureFingers,
} from "./costModel";
import { analyzeHandHeldNotes, applyEffectiveHeldNotes } from "./heldNotes";
import {
  getComfortSpan,
  getMaxSpan,
  getSpanScale,
  toHandFramePos,
  whiteKeyIndex,
} from "./keyboard";
import { analyzeScoreRepairSuggestions } from "./scoreRepair";
import { DEFAULT_COST_WEIGHTS } from "./weights";

export const BEAM_WIDTH = 28; // SPEC 4.1: BEAM = 24-32
export const ASTAR_MAX_EXPANSIONS_PER_SLICE = 64;
export const ASTAR_MIN_EXPANSION_BUDGET = 4000;
export const ROLL_RELEASE_COST = 1.8;
export const KINEMATIC_RELEASE_COST = 120.0;
const EMPTY_ROLL_UIDS = new Set<string>();
const EMPTY_HELD_MAP = new Map<Finger, number>();

export interface BeamNode {
  fingers: Finger[];
  totalCost: number;
  rankScore: number;
  prevIdx: number;
  stateKey: string;
  releasedUids?: string[];
}

export interface HeldReleaseOption {
  heldFingers: Map<Finger, number>;
  releasedUids?: string[];
  releaseCost: number;
}

/**
 * Enumerates monotonic, oldest-first early release prefixes (0..k) for the
 * physically retained held notes at `slice`, prioritizing roll-releasable notes
 * over non-roll sustained voices.
 */
export function buildHeldReleaseOptions(
  slice: OnsetSlice,
  heldFingerByUid: Map<string, Finger>,
  rollReleasableUids: Set<string> = EMPTY_ROLL_UIDS
): HeldReleaseOption[] {
  if (slice.heldNotes.length === 0 || heldFingerByUid.size === 0) {
    return [{ heldFingers: EMPTY_HELD_MAP, releaseCost: 0 }];
  }

  const retained: Array<{
    noteUid: string;
    midi: number;
    finger: Finger;
    onsetTick: number;
    isRoll: boolean;
  }> = [];

  for (const h of slice.heldNotes) {
    const f = heldFingerByUid.get(h.noteUid);
    if (f === undefined) continue;
    retained.push({
      noteUid: h.noteUid,
      midi: h.midi,
      finger: f,
      onsetTick: h.onsetTick ?? 0,
      isRoll: rollReleasableUids.has(h.noteUid),
    });
  }

  if (retained.length === 0) {
    return [{ heldFingers: EMPTY_HELD_MAP, releaseCost: 0 }];
  }

  // Sort oldest-first; tie-break by roll-releasable first, then lowest pitch first (retain upper voice)
  retained.sort((a, b) => {
    if (a.onsetTick !== b.onsetTick) return a.onsetTick - b.onsetTick;
    if (a.isRoll !== b.isRoll) return a.isRoll ? -1 : 1;
    return a.midi - b.midi;
  });

  const options: HeldReleaseOption[] = [];
  let cumulativeReleaseCost = 0;

  for (let k = 0; k <= retained.length; k++) {
    if (k > 0) {
      const releasedItem = retained[k - 1];
      cumulativeReleaseCost += releasedItem.isRoll ? ROLL_RELEASE_COST : KINEMATIC_RELEASE_COST;
    }
    const heldFingers = new Map<Finger, number>();
    for (let i = k; i < retained.length; i++) {
      heldFingers.set(retained[i].finger, retained[i].midi);
    }
    const releasedUids =
      k > 0 ? retained.slice(0, k).map((item) => item.noteUid) : undefined;
    options.push({
      heldFingers,
      releasedUids,
      releaseCost: cumulativeReleaseCost,
    });
  }

  return options;
}

export interface HeldReservation {
  finger: Finger;
  untilSliceIdx: number;
}

export function buildHeldFingerByUidFromBeam(
  slice: OnsetSlice,
  slices: OnsetSlice[],
  layers: BeamNode[][],
  t: number,
  pIdx: number,
  priorFingerByNoteUid?: Record<string, Finger>
): Map<string, Finger> {
  const heldFingerByUid = new Map<string, Finger>();
  if (slice.heldNotes.length === 0) {
    return heldFingerByUid;
  }
  const remaining = new Set<string>();
  for (const h of slice.heldNotes) {
    remaining.add(h.noteUid);
  }
  let cursor = pIdx;
  for (let back = t - 1; back >= 0 && remaining.size > 0 && cursor >= 0; back--) {
    const prevSlice = slices[back];
    const node = layers[back][cursor];
    if (node.releasedUids) {
      for (const relUid of node.releasedUids) {
        remaining.delete(relUid);
      }
    }
    for (let i = 0; i < prevSlice.notes.length; i++) {
      const uid = prevSlice.notes[i].noteUid;
      if (remaining.has(uid)) {
        heldFingerByUid.set(uid, node.fingers[i]);
        remaining.delete(uid);
      }
    }
    cursor = node.prevIdx;
  }
  if (priorFingerByNoteUid && remaining.size > 0) {
    for (const uid of remaining) {
      const priorF = priorFingerByNoteUid[uid];
      if (priorF) {
        heldFingerByUid.set(uid, priorF);
      }
    }
  }
  return heldFingerByUid;
}

export function buildHeldFingerMapFromBeam(
  slice: OnsetSlice,
  slices: OnsetSlice[],
  layers: BeamNode[][],
  t: number,
  pIdx: number,
  priorFingerByNoteUid?: Record<string, Finger>
): Map<Finger, number> {
  const heldMap = new Map<Finger, number>();
  if (slice.heldNotes.length === 0) {
    return heldMap;
  }
  const byUid = buildHeldFingerByUidFromBeam(
    slice,
    slices,
    layers,
    t,
    pIdx,
    priorFingerByNoteUid
  );
  for (const h of slice.heldNotes) {
    const f = byUid.get(h.noteUid);
    if (f !== undefined) {
      heldMap.set(f, h.midi);
    }
  }
  return heldMap;
}

export function resolveActiveNoteFingers(
  slice: OnsetSlice,
  cand: Finger[],
  slices: OnsetSlice[],
  layers: BeamNode[][],
  t: number,
  pIdx: number,
  neededUids: string[],
  releasedAtSlice?: string[]
): Map<string, Finger> {
  const result = new Map<string, Finger>();
  if (neededUids.length === 0) return result;
  const remaining = new Set(neededUids);
  if (releasedAtSlice) {
    for (const relUid of releasedAtSlice) {
      remaining.delete(relUid);
    }
  }

  for (let i = 0; i < slice.notes.length; i++) {
    const uid = slice.notes[i].noteUid;
    if (remaining.has(uid)) {
      result.set(uid, cand[i]);
      remaining.delete(uid);
    }
  }

  let cursor = pIdx;
  for (let back = t - 1; back >= 0 && remaining.size > 0; back--) {
    const prevSlice = slices[back];
    const node = layers[back][cursor];
    if (node.releasedUids) {
      for (const relUid of node.releasedUids) {
        remaining.delete(relUid);
      }
    }
    for (let i = 0; i < prevSlice.notes.length; i++) {
      const uid = prevSlice.notes[i].noteUid;
      if (remaining.has(uid)) {
        result.set(uid, node.fingers[i]);
        remaining.delete(uid);
      }
    }
    cursor = node.prevIdx;
  }
  return result;
}

export interface AnchorLookahead {
  hFuture: number[][];
  backward: number[][];
  bestNextChoice: number[][];
  reservationsByNoteUid: Map<string, HeldReservation[]>;
}

export function computeAnchorLookahead(
  slices: OnsetSlice[],
  candidatesBySlice: Finger[][][],
  profile: HandSpanProfile,
  ignoreExistingFingerings = false
): AnchorLookahead {
  const nSlices = slices.length;
  const emptyHeld = new Map<Finger, number>();

  const baseVertCosts: number[][] = candidatesBySlice.map((cands, t) =>
    cands.map((cand) => computeVerticalCost(slices[t], cand, emptyHeld, profile).cost)
  );

  const backward: number[][] = Array.from({ length: nSlices }, () => []);
  const hFuture: number[][] = Array.from({ length: nSlices }, () => []);
  const bestNextChoice: number[][] = Array.from({ length: nSlices }, () => []);

  const last = nSlices - 1;
  for (let c = 0; c < candidatesBySlice[last].length; c++) {
    backward[last][c] = baseVertCosts[last][c];
    hFuture[last][c] = 0;
    bestNextChoice[last][c] = -1;
  }

  for (let t = nSlices - 2; t >= 0; t--) {
    const currCands = candidatesBySlice[t];
    const nextCands = candidatesBySlice[t + 1];
    for (let c = 0; c < currCands.length; c++) {
      let bestNext = Infinity;
      let bestNc = 0;
      for (let nc = 0; nc < nextCands.length; nc++) {
        const horizCost = computeHorizontalCost(
          slices[t],
          currCands[c],
          slices[t + 1],
          nextCands[nc],
          profile,
          ignoreExistingFingerings
        ).cost;
        const total = horizCost + backward[t + 1][nc];
        if (total < bestNext) {
          bestNext = total;
          bestNc = nc;
        }
      }
      hFuture[t][c] = bestNext;
      backward[t][c] = baseVertCosts[t][c] + bestNext;
      bestNextChoice[t][c] = bestNc;
    }
  }

  // Reserve fingers required by future anchored notes while earlier notes are held
  const reservationsByNoteUid = new Map<string, HeldReservation[]>();
  if (!ignoreExistingFingerings) {
    for (let u = 0; u < nSlices; u++) {
      const slice = slices[u];
      const cands = candidatesBySlice[u];
      if (cands.length === 0 || slice.heldNotes.length === 0) continue;

      for (let i = 0; i < slice.notes.length; i++) {
        const note = slice.notes[i];
        if (note.anchorFinger === undefined) continue;
        // Only reserve if all surviving candidates at slice u commit this note to the same finger
        const f0 = cands[0][i];
        if (!cands.every((c) => c[i] === f0)) continue;

        for (const held of slice.heldNotes) {
          if (held.midi === note.midi) continue;
          let list = reservationsByNoteUid.get(held.noteUid);
          if (!list) {
            list = [];
            reservationsByNoteUid.set(held.noteUid, list);
          }
          list.push({ finger: f0, untilSliceIdx: u });
        }
      }
    }
  }

  return { hFuture, backward, bestNextChoice, reservationsByNoteUid };
}

export function resolveCrossSliceAnchorConflicts(
  slices: OnsetSlice[],
  candidatesBySlice: Finger[][][],
  profile: HandSpanProfile,
  anchorConflictSliceIds: Set<string>
): void {
  const scale = getSpanScale(profile);
  const committedByUid = new Map<string, { midi: number; finger: Finger }>();

  for (let t = 0; t < slices.length; t++) {
    const slice = slices[t];
    const cands = candidatesBySlice[t];
    if (slice.heldNotes.length > 0 && cands.length > 0) {
      const conflictedNoteUids = new Set<string>();
      for (let i = 0; i < slice.notes.length; i++) {
        const sNote = slice.notes[i];
        if (sNote.anchorFinger === undefined) continue;
        const fS = cands[0][i];
        if (!cands.every((c) => c[i] === fS)) continue;

        const posS = toHandFramePos(sNote.midi, slice.hand);
        for (const held of slice.heldNotes) {
          const hCommitted = committedByUid.get(held.noteUid);
          if (!hCommitted) continue;

          if (hCommitted.finger === fS && hCommitted.midi !== sNote.midi) {
            conflictedNoteUids.add(sNote.noteUid);
            break;
          }
          const dist = Math.abs(posS - toHandFramePos(hCommitted.midi, slice.hand));
          const maxSpan = getMaxSpan(hCommitted.finger, fS, scale);
          if (dist > maxSpan + 1e-6) {
            const allFingers: Finger[] = [1, 2, 3, 4, 5];
            const canImprove = allFingers.some(
              (fAlt) =>
                fAlt !== hCommitted.finger && getMaxSpan(hCommitted.finger, fAlt, scale) + 1e-6 >= dist
            );
            if (canImprove) {
              conflictedNoteUids.add(sNote.noteUid);
              break;
            }
          }
        }
      }

      if (conflictedNoteUids.size > 0) {
        anchorConflictSliceIds.add(slice.sliceId);
        candidatesBySlice[t] = generateSliceCandidates(
          slice,
          false,
          profile,
          conflictedNoteUids
        ).candidates;
      }
    }

    const updatedCands = candidatesBySlice[t];
    if (updatedCands.length > 0) {
      for (let i = 0; i < slice.notes.length; i++) {
        const note = slice.notes[i];
        if (note.anchorFinger === undefined) continue;
        const f0 = updatedCands[0][i];
        if (updatedCands.every((c) => c[i] === f0)) {
          committedByUid.set(note.noteUid, { midi: note.midi, finger: f0 });
        }
      }
    }
  }
}

export function buildStateKeyAndLookaheadPenalty(
  slice: OnsetSlice,
  cand: Finger[],
  slices: OnsetSlice[],
  layers: BeamNode[][],
  t: number,
  pIdx: number,
  cIdx: number,
  nextSliceHeldUids: string[],
  lookahead: { hFuture: number[][]; reservationsByNoteUid: Map<string, HeldReservation[]> } | null,
  releasedAtSlice?: string[]
): { stateKey: string; penalty: number } {
  let penalty = lookahead ? lookahead.hFuture[t][cIdx] : 0;
  let stateKey = cand.join("");
  if (nextSliceHeldUids.length > 0) {
    const carried = resolveActiveNoteFingers(
      slice,
      cand,
      slices,
      layers,
      t,
      pIdx,
      nextSliceHeldUids,
      releasedAtSlice
    );
    stateKey += `|${nextSliceHeldUids.map((uid) => carried.get(uid) ?? 0).join("")}`;
    if (lookahead) {
      const stealPenalty = DEFAULT_COST_WEIGHTS.vertical.heldStealPenalty;
      for (const [uid, f] of carried.entries()) {
        const resList = lookahead.reservationsByNoteUid.get(uid);
        if (resList && resList.some((r) => r.untilSliceIdx > t && r.finger === f)) {
          penalty += stealPenalty;
        }
      }
    }
  }
  return { stateKey, penalty };
}

export interface SegmentBeamContext {
  candidatesBySlice: Finger[][][];
  lookahead: AnchorLookahead | null;
}

/**
 * Generates slice candidates, resolves cross-slice anchor conflicts, and computes
 * unconditional backward 1st-order DP lookahead bounds & anchor reservations.
 */
export function prepareSegmentBeamContext(
  slices: OnsetSlice[],
  profile: HandSpanProfile,
  anchorConflictSliceIds: Set<string>,
  ignoreExistingFingerings = false
): SegmentBeamContext {
  const candidatesBySlice: Finger[][][] = [];
  let hasAnyAnchors = false;

  for (let t = 0; t < slices.length; t++) {
    const slice = slices[t];
    if (!ignoreExistingFingerings && slice.notes.some((n) => n.anchorFinger !== undefined)) {
      hasAnyAnchors = true;
    }
    const { candidates, hadAnchorConflict } = generateSliceCandidates(
      slice,
      ignoreExistingFingerings,
      profile
    );
    if (hadAnchorConflict) {
      anchorConflictSliceIds.add(slice.sliceId);
    }
    candidatesBySlice.push(candidates);
  }

  if (hasAnyAnchors) {
    resolveCrossSliceAnchorConflicts(slices, candidatesBySlice, profile, anchorConflictSliceIds);
  }

  const lookahead =
    slices.length > 0
      ? computeAnchorLookahead(slices, candidatesBySlice, profile, ignoreExistingFingerings)
      : null;

  return { candidatesBySlice, lookahead };
}

export interface AdvanceBeamLayerOptions {
  slices: OnsetSlice[];
  layers: BeamNode[][];
  t: number;
  candidates: Finger[][];
  nextSliceHeldUids: string[];
  lookahead: SegmentBeamContext["lookahead"];
  profile: HandSpanProfile;
  ignoreExistingFingerings?: boolean;
  priorFingerByNoteUid?: Record<string, Finger>;
  prevPrefixSlice?: OnsetSlice | null;
  prevPrefixFingers?: Finger[] | null;
  rollReleasableUids?: Set<string>;
}

/**
 * Expands and prunes one Beam Search DP layer (`BEAM_WIDTH`) for slice index `t`.
 */
export function advanceBeamLayer(opts: AdvanceBeamLayerOptions): BeamNode[] {
  const {
    slices,
    layers,
    t,
    candidates,
    nextSliceHeldUids,
    lookahead,
    profile,
    ignoreExistingFingerings = false,
    priorFingerByNoteUid,
    prevPrefixSlice,
    prevPrefixFingers,
    rollReleasableUids = EMPTY_ROLL_UIDS,
  } = opts;

  const slice = slices[t];
  const nextBeam: BeamNode[] = [];

  if (t === 0) {
    const heldFingerByUid = buildHeldFingerByUidFromBeam(
      slice,
      slices,
      layers,
      0,
      -1,
      priorFingerByNoteUid
    );
    const releaseOptions = buildHeldReleaseOptions(slice, heldFingerByUid, rollReleasableUids);
    for (const relOpt of releaseOptions) {
      for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
        const cand = candidates[cIdx];
        const vertCost = computeVerticalCost(slice, cand, relOpt.heldFingers, profile).cost;
        const horizCost =
          prevPrefixSlice && prevPrefixFingers
            ? computeHorizontalCost(
                prevPrefixSlice,
                prevPrefixFingers,
                slice,
                cand,
                profile,
                ignoreExistingFingerings
              ).cost
            : 0;
        const totalCost = vertCost + horizCost + relOpt.releaseCost;
        const { stateKey, penalty } = buildStateKeyAndLookaheadPenalty(
          slice,
          cand,
          slices,
          layers,
          t,
          -1,
          cIdx,
          nextSliceHeldUids,
          lookahead,
          relOpt.releasedUids
        );
        nextBeam.push({
          fingers: cand,
          totalCost,
          rankScore: totalCost + penalty,
          prevIdx: -1,
          stateKey,
          releasedUids: relOpt.releasedUids,
        });
      }
    }
  } else {
    const prevBeam = layers[t - 1];
    const prevSlice = slices[t - 1];
    const cachedVertCosts =
      slice.heldNotes.length === 0
        ? candidates.map(
            (cand) => computeVerticalCost(slice, cand, EMPTY_HELD_MAP, profile).cost
          )
        : null;

    for (let pIdx = 0; pIdx < prevBeam.length; pIdx++) {
      const prevNode = prevBeam[pIdx];
      const releaseOptions =
        slice.heldNotes.length > 0
          ? buildHeldReleaseOptions(
              slice,
              buildHeldFingerByUidFromBeam(
                slice,
                slices,
                layers,
                t,
                pIdx,
                priorFingerByNoteUid
              ),
              rollReleasableUids
            )
          : [{ heldFingers: EMPTY_HELD_MAP, releaseCost: 0 } as HeldReleaseOption];

      for (const relOpt of releaseOptions) {
        for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
          const cand = candidates[cIdx];
          const vertCost =
            cachedVertCosts !== null
              ? cachedVertCosts[cIdx]
              : computeVerticalCost(slice, cand, relOpt.heldFingers, profile).cost;
          const horiz = computeHorizontalCost(
            prevSlice,
            prevNode.fingers,
            slice,
            cand,
            profile,
            ignoreExistingFingerings
          );
          const totalCost = prevNode.totalCost + vertCost + horiz.cost + relOpt.releaseCost;
          const { stateKey, penalty } = buildStateKeyAndLookaheadPenalty(
            slice,
            cand,
            slices,
            layers,
            t,
            pIdx,
            cIdx,
            nextSliceHeldUids,
            lookahead,
            relOpt.releasedUids
          );
          nextBeam.push({
            fingers: cand,
            totalCost,
            rankScore: totalCost + penalty,
            prevIdx: pIdx,
            stateKey,
            releasedUids: relOpt.releasedUids,
          });
        }
      }
    }
  }

  // Deduplicate dominated Markov states before pruning to BEAM_WIDTH
  nextBeam.sort((a, b) => a.rankScore - b.rankScore || a.totalCost - b.totalCost);
  const deduped: BeamNode[] = [];
  const seenStates = new Set<string>();
  for (const node of nextBeam) {
    if (seenStates.has(node.stateKey)) continue;
    seenStates.add(node.stateKey);
    deduped.push(node);
    if (deduped.length >= BEAM_WIDTH) break;
  }
  return deduped;
}

interface AStarNode {
  t: number;
  cIdx: number;
  g: number;
  f: number;
  parentIdx: number;
  nextHeldByUid: Map<string, Finger>;
  stateKey: string;
  releasedUids?: string[];
}

class MinNodeHeap {
  private readonly heap: number[] = [];

  constructor(private readonly nodes: AStarNode[]) {}

  get size(): number {
    return this.heap.length;
  }

  push(nodeIdx: number): void {
    this.heap.push(nodeIdx);
    this.siftUp(this.heap.length - 1);
  }

  pop(): number {
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private isLess(aIdx: number, bIdx: number): boolean {
    const a = this.nodes[aIdx];
    const b = this.nodes[bIdx];
    if (a.f !== b.f) return a.f < b.f;
    if (a.t !== b.t) return a.t > b.t; // prefer deeper slices on exact f ties
    return a.g < b.g;
  }

  private siftUp(idx: number): void {
    let i = idx;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.isLess(this.heap[i], this.heap[parent])) {
        const tmp = this.heap[i];
        this.heap[i] = this.heap[parent];
        this.heap[parent] = tmp;
        i = parent;
      } else {
        break;
      }
    }
  }

  private siftDown(idx: number): void {
    let i = idx;
    const n = this.heap.length;
    while (true) {
      let best = i;
      const left = 2 * i + 1;
      const right = left + 1;
      if (left < n && this.isLess(this.heap[left], this.heap[best])) {
        best = left;
      }
      if (right < n && this.isLess(this.heap[right], this.heap[best])) {
        best = right;
      }
      if (best === i) break;
      const tmp = this.heap[i];
      this.heap[i] = this.heap[best];
      this.heap[best] = tmp;
      i = best;
    }
  }
}

function recordSolvedPath(
  slices: OnsetSlice[],
  chosenFingersBySlice: Finger[][],
  fingerByNoteUid: Record<string, Finger>,
  repairedAnchorUids: string[],
  ignoreExistingFingerings: boolean
): void {
  for (let t = 0; t < slices.length; t++) {
    const slice = slices[t];
    const fingers = chosenFingersBySlice[t];
    for (let i = 0; i < slice.notes.length; i++) {
      const note = slice.notes[i];
      fingerByNoteUid[note.noteUid] = fingers[i];
      if (
        !ignoreExistingFingerings &&
        note.anchorFinger !== undefined &&
        fingers[i] !== note.anchorFinger
      ) {
        repairedAnchorUids.push(note.noteUid);
      }
    }
  }
}

interface SegmentSolveOutput {
  chosen: Finger[][];
  releasesBySlice: Array<string[] | undefined>;
}

function solvePhraseSegmentBeamFallback(
  slices: OnsetSlice[],
  candidatesBySlice: Finger[][][],
  lookahead: AnchorLookahead | null,
  profile: HandSpanProfile,
  ignoreExistingFingerings: boolean,
  rollReleasableUids: Set<string> = EMPTY_ROLL_UIDS
): SegmentSolveOutput {
  const layers: BeamNode[][] = [];

  for (let t = 0; t < slices.length; t++) {
    const nextSliceHeldUids =
      t + 1 < slices.length ? slices[t + 1].heldNotes.map((h) => h.noteUid) : [];
    layers.push(
      advanceBeamLayer({
        slices,
        layers,
        t,
        candidates: candidatesBySlice[t],
        nextSliceHeldUids,
        lookahead,
        profile,
        ignoreExistingFingerings,
        rollReleasableUids,
      })
    );
  }

  const lastLayer = layers[layers.length - 1];
  let bestIdx = 0;
  for (let i = 1; i < lastLayer.length; i++) {
    if (lastLayer[i].totalCost < lastLayer[bestIdx].totalCost) {
      bestIdx = i;
    }
  }

  const chosen: Finger[][] = new Array(slices.length);
  const releasesBySlice: Array<string[] | undefined> = new Array(slices.length);
  let cursor = bestIdx;
  for (let t = slices.length - 1; t >= 0; t--) {
    const node = layers[t][cursor];
    chosen[t] = node.fingers;
    releasesBySlice[t] = node.releasedUids;
    cursor = node.prevIdx;
  }
  return { chosen, releasesBySlice };
}

function buildNextHeldState(
  slice: OnsetSlice,
  cand: Finger[],
  prevHeldByUid: Map<string, Finger> | null,
  nextSliceHeldUids: string[],
  lookahead: AnchorLookahead | null,
  t: number,
  cIdx: number,
  releasedAtSlice?: string[]
): { nextHeldByUid: Map<string, Finger>; stateKey: string; heuristic: number } {
  let heuristic = lookahead ? lookahead.hFuture[t][cIdx] : 0;
  let stateKey = String(cIdx);
  const nextHeldByUid = new Map<string, Finger>();

  if (nextSliceHeldUids.length > 0) {
    const stealPenalty = DEFAULT_COST_WEIGHTS.vertical.heldStealPenalty;
    const suffixParts: number[] = [];
    const releasedSet = releasedAtSlice ? new Set(releasedAtSlice) : null;

    for (const uid of nextSliceHeldUids) {
      let f: Finger | undefined;
      if (!releasedSet || !releasedSet.has(uid)) {
        for (let i = 0; i < slice.notes.length; i++) {
          if (slice.notes[i].noteUid === uid) {
            f = cand[i];
            break;
          }
        }
        if (f === undefined && prevHeldByUid) {
          f = prevHeldByUid.get(uid);
        }
      }
      if (f !== undefined) {
        nextHeldByUid.set(uid, f);
        if (lookahead) {
          const resList = lookahead.reservationsByNoteUid.get(uid);
          if (resList && resList.some((r) => r.untilSliceIdx > t && r.finger === f)) {
            heuristic += stealPenalty;
          }
        }
      }
      suffixParts.push(f ?? 0);
    }
    stateKey += `|${suffixParts.join("")}`;
  }

  return { nextHeldByUid, stateKey, heuristic };
}

function solvePhraseSegmentAStar(
  slices: OnsetSlice[],
  candidatesBySlice: Finger[][][],
  lookahead: AnchorLookahead,
  profile: HandSpanProfile,
  ignoreExistingFingerings: boolean,
  rollReleasableUids: Set<string> = EMPTY_ROLL_UIDS
): SegmentSolveOutput | null {
  const nSlices = slices.length;
  const maxExpansions = Math.max(
    ASTAR_MIN_EXPANSION_BUDGET,
    nSlices * ASTAR_MAX_EXPANSIONS_PER_SLICE
  );
  const emptyHeld = EMPTY_HELD_MAP;

  // Precompute vertical cost for slices without heldNotes
  const cachedBaseVertCosts: Array<number[] | null> = slices.map((s, t) =>
    s.heldNotes.length === 0
      ? candidatesBySlice[t].map(
          (cand) => computeVerticalCost(s, cand, emptyHeld, profile).cost
        )
      : null
  );

  const nextHeldUidsBySlice: string[][] = slices.map((_, t) =>
    t + 1 < nSlices ? slices[t + 1].heldNotes.map((h) => h.noteUid) : []
  );

  const nodes: AStarNode[] = [];
  const heap = new MinNodeHeap(nodes);
  const bestGByLayer: Array<Map<string, number>> = Array.from(
    { length: nSlices },
    () => new Map<string, number>()
  );

  // Seed t = 0
  const slice0 = slices[0];
  const cands0 = candidatesBySlice[0];
  for (let cIdx = 0; cIdx < cands0.length; cIdx++) {
    const cand = cands0[cIdx];
    const g =
      cachedBaseVertCosts[0] !== null
        ? cachedBaseVertCosts[0][cIdx]
        : computeVerticalCost(slice0, cand, emptyHeld, profile).cost;
    const { nextHeldByUid, stateKey, heuristic } = buildNextHeldState(
      slice0,
      cand,
      null,
      nextHeldUidsBySlice[0],
      lookahead,
      0,
      cIdx
    );
    const prevBest = bestGByLayer[0].get(stateKey);
    if (prevBest !== undefined && prevBest <= g) continue;
    bestGByLayer[0].set(stateKey, g);
    const nodeIdx = nodes.length;
    nodes.push({
      t: 0,
      cIdx,
      g,
      f: g + heuristic,
      parentIdx: -1,
      nextHeldByUid,
      stateKey,
    });
    heap.push(nodeIdx);
  }

  let expansions = 0;
  while (heap.size > 0) {
    const nodeIdx = heap.pop();
    const node = nodes[nodeIdx];
    const bestG = bestGByLayer[node.t].get(node.stateKey);
    if (bestG !== undefined && node.g > bestG) {
      continue;
    }

    if (node.t === nSlices - 1) {
      const chosen: Finger[][] = new Array(nSlices);
      const releasesBySlice: Array<string[] | undefined> = new Array(nSlices);
      let cursor = nodeIdx;
      while (cursor >= 0) {
        const cur = nodes[cursor];
        chosen[cur.t] = candidatesBySlice[cur.t][cur.cIdx];
        releasesBySlice[cur.t] = cur.releasedUids;
        cursor = cur.parentIdx;
      }
      return { chosen, releasesBySlice };
    }

    expansions++;
    if (expansions > maxExpansions) {
      return null;
    }

    const nextT = node.t + 1;
    const prevSlice = slices[node.t];
    const prevCand = candidatesBySlice[node.t][node.cIdx];
    const currSlice = slices[nextT];
    const currCands = candidatesBySlice[nextT];

    const releaseOptions =
      currSlice.heldNotes.length > 0
        ? buildHeldReleaseOptions(currSlice, node.nextHeldByUid, rollReleasableUids)
        : [{ heldFingers: emptyHeld, releaseCost: 0 } as HeldReleaseOption];

    const cachedVert = cachedBaseVertCosts[nextT];
    const nextHeldUids = nextHeldUidsBySlice[nextT];
    const bestLayerMap = bestGByLayer[nextT];

    for (const relOpt of releaseOptions) {
      for (let cIdx = 0; cIdx < currCands.length; cIdx++) {
        const cand = currCands[cIdx];
        const vertCost =
          cachedVert !== null
            ? cachedVert[cIdx]
            : computeVerticalCost(currSlice, cand, relOpt.heldFingers, profile).cost;
        const horizCost = computeHorizontalCost(
          prevSlice,
          prevCand,
          currSlice,
          cand,
          profile,
          ignoreExistingFingerings
        ).cost;
        const g = node.g + vertCost + horizCost + relOpt.releaseCost;

        const { nextHeldByUid, stateKey, heuristic } = buildNextHeldState(
          currSlice,
          cand,
          node.nextHeldByUid,
          nextHeldUids,
          lookahead,
          nextT,
          cIdx,
          relOpt.releasedUids
        );
        const prevBest = bestLayerMap.get(stateKey);
        if (prevBest !== undefined && prevBest <= g) {
          continue;
        }
        bestLayerMap.set(stateKey, g);
        const childIdx = nodes.length;
        nodes.push({
          t: nextT,
          cIdx,
          g,
          f: g + heuristic,
          parentIdx: nodeIdx,
          nextHeldByUid,
          stateKey,
          releasedUids: relOpt.releasedUids,
        });
        heap.push(childIdx);
      }
    }
  }

  return null;
}

export function recordEarlyRelease(
  earlyReleasesByNoteUid: Record<string, HeldNoteRelease>,
  noteUid: string,
  releaseSec: number,
  releaseTick: number,
  reason: EarlyReleaseReason
): void {
  const existing = earlyReleasesByNoteUid[noteUid];
  if (!existing || releaseSec < existing.releaseSec) {
    earlyReleasesByNoteUid[noteUid] = { releaseSec, releaseTick, reason };
  }
}

export function recordSliceEarlyReleases(
  earlyReleasesByNoteUid: Record<string, HeldNoteRelease>,
  slice: OnsetSlice,
  relUids: readonly string[] | undefined,
  rollReleasableUids: ReadonlySet<string>
): void {
  if (!relUids || relUids.length === 0) return;
  for (const uid of relUids) {
    const reason: EarlyReleaseReason = rollReleasableUids.has(uid)
      ? "roll"
      : "kinematic-release";
    recordEarlyRelease(earlyReleasesByNoteUid, uid, slice.onsetSec, slice.onsetTick, reason);
  }
}

export function recordStaticHeldReleases(
  slices: OnsetSlice[],
  releasedHeldBySlice: ReturnType<typeof analyzeHandHeldNotes>["releasedHeldBySlice"],
  earlyReleasesByNoteUid: Record<string, HeldNoteRelease>
): void {
  for (let t = 0; t < slices.length; t++) {
    const rels = releasedHeldBySlice[t];
    if (!rels || rels.length === 0) continue;
    const slice = slices[t];
    for (const rel of rels) {
      const reason: EarlyReleaseReason =
        rel.reason === "pedal"
          ? "pedal"
          : rel.reason === "unreachable"
            ? "unreachable"
            : "kinematic-release";
      recordEarlyRelease(earlyReleasesByNoteUid, rel.noteUid, slice.onsetSec, slice.onsetTick, reason);
    }
  }
}

function solvePhraseSegment(
  slices: OnsetSlice[],
  profile: HandSpanProfile,
  fingerByNoteUid: Record<string, Finger>,
  repairedAnchorUids: string[],
  anchorConflictSliceIds: Set<string>,
  earlyReleasesByNoteUid: Record<string, HeldNoteRelease>,
  ignoreExistingFingerings = false
): void {
  if (slices.length === 0) return;

  const heldAnalysis = analyzeHandHeldNotes(slices, profile);
  recordStaticHeldReleases(slices, heldAnalysis.releasedHeldBySlice, earlyReleasesByNoteUid);
  const effectiveSlices = applyEffectiveHeldNotes(slices, heldAnalysis);

  const { candidatesBySlice, lookahead } = prepareSegmentBeamContext(
    effectiveSlices,
    profile,
    anchorConflictSliceIds,
    ignoreExistingFingerings
  );

  const hasHeldNotes = effectiveSlices.some((s) => s.heldNotes.length > 0);
  let output: SegmentSolveOutput | null = null;

  if (!hasHeldNotes && lookahead) {
    // Strictly 1st-order Markov segment: backward DP already gives the exact global optimum
    const chosen = new Array<Finger[]>(effectiveSlices.length);
    const firstBack = lookahead.backward[0];
    let c = 0;
    for (let i = 1; i < firstBack.length; i++) {
      if (firstBack[i] < firstBack[c]) c = i;
    }
    for (let t = 0; t < effectiveSlices.length; t++) {
      chosen[t] = candidatesBySlice[t][c];
      c = lookahead.bestNextChoice[t][c];
    }
    output = { chosen, releasesBySlice: new Array(effectiveSlices.length) };
  } else if (lookahead) {
    // Polyphonic / held-note segment: admissible A* with anytime Beam fallback
    output = solvePhraseSegmentAStar(
      effectiveSlices,
      candidatesBySlice,
      lookahead,
      profile,
      ignoreExistingFingerings,
      heldAnalysis.rollReleasableUids
    );
  }

  if (!output) {
    output = solvePhraseSegmentBeamFallback(
      effectiveSlices,
      candidatesBySlice,
      lookahead,
      profile,
      ignoreExistingFingerings,
      heldAnalysis.rollReleasableUids
    );
  }

  for (let t = 0; t < slices.length; t++) {
    recordSliceEarlyReleases(
      earlyReleasesByNoteUid,
      slices[t],
      output.releasesBySlice[t],
      heldAnalysis.rollReleasableUids
    );
  }

  recordSolvedPath(
    slices,
    output.chosen,
    fingerByNoteUid,
    repairedAnchorUids,
    ignoreExistingFingerings
  );
}

function sliceHandBounds(
  slice: OnsetSlice,
  fingers: Finger[]
): { thumbKey: number; pinkyKey: number; minMidi: number; maxMidi: number } {
  const thumbEstimates: number[] = [];
  let minMidi = Infinity;
  let maxMidi = -Infinity;
  let minWhite = Infinity;
  let maxWhite = -Infinity;

  for (let i = 0; i < slice.notes.length; i++) {
    const midi = slice.notes[i].midi;
    const f = fingers[i];
    const w = whiteKeyIndex(midi);
    if (midi < minMidi) minMidi = midi;
    if (midi > maxMidi) maxMidi = midi;
    if (w < minWhite) minWhite = w;
    if (w > maxWhite) maxWhite = w;

    if (slice.hand === "RH") {
      thumbEstimates.push(w - (f - 1));
    } else {
      thumbEstimates.push(w + (f - 1));
    }
  }

  thumbEstimates.sort((a, b) => a - b);
  const medianThumb = thumbEstimates[Math.floor(thumbEstimates.length / 2)];
  let thumbKey = medianThumb;
  let pinkyKey = slice.hand === "RH" ? thumbKey + 4 : thumbKey - 4;

  if (slice.hand === "RH") {
    thumbKey = Math.min(thumbKey, minWhite);
    pinkyKey = Math.max(pinkyKey, maxWhite);
  } else {
    thumbKey = Math.max(thumbKey, maxWhite);
    pinkyKey = Math.min(pinkyKey, minWhite);
  }

  return { thumbKey, pinkyKey, minMidi, maxMidi };
}

export function derivePositionsAndCues(
  slices: OnsetSlice[],
  fingerByNoteUid: Record<string, Finger>,
  profile: HandSpanProfile,
  anchorConflictSliceIds: Set<string>,
  ignoreExistingFingerings = false
): { handPositions: HandPosition[]; transitionCues: TransitionCue[] } {
  const handPositions: HandPosition[] = [];
  const transitionCues: TransitionCue[] = [];
  const scale = getSpanScale(profile);

  // Process per hand in chronological slice order
  for (const hand of ["RH", "LH"] as Hand[]) {
    const handSlices = slices.filter((s) => s.hand === hand);
    if (handSlices.length === 0) continue;
    const { activeHeldBySlice, releasedHeldBySlice } = analyzeHandHeldNotes(handSlices, profile);

    let currentPos: HandPosition | null = null;
    let anchorThumbKey = 0;
    let prevBounds: { thumbKey: number; pinkyKey: number; minMidi: number; maxMidi: number } | null =
      null;

    for (let idx = 0; idx < handSlices.length; idx++) {
      const slice = handSlices[idx];
      const fingers = slice.notes.map((n) => fingerByNoteUid[n.noteUid]);
      const bounds = sliceHandBounds(slice, fingers);

      if (anchorConflictSliceIds.has(slice.sliceId)) {
        transitionCues.push({
          sliceId: slice.sliceId,
          hand,
          measureIndex: slice.measureIndex,
          type: "anchor-conflict",
          severity: "danger",
          cost: 100,
          label: "Anchor conflict",
        });
      }

      // Check vertical chord & active held+struck span warnings
      let emittedChordExceeds5 = false;
      const allNotesArpeggiated =
        slice.notes.length >= 2 && slice.notes.every((n) => Boolean(n.isArpeggiated));
      for (let i = 0; i < slice.notes.length; i++) {
        const posI = toHandFramePos(slice.notes[i].midi, hand);
        for (let j = i + 1; j < slice.notes.length; j++) {
          const dist = Math.abs(toHandFramePos(slice.notes[j].midi, hand) - posI);
          const semitoneDiff = Math.abs(slice.notes[j].midi - slice.notes[i].midi);
          const pairArpeggiated =
            Boolean(slice.notes[i].isArpeggiated) && Boolean(slice.notes[j].isArpeggiated);
          if (fingers[i] === fingers[j]) {
            const isValidDouble =
              (fingers[i] === 1 || fingers[i] === 5) && semitoneDiff <= 2 && dist <= 1.5;
            if (!isValidDouble && !emittedChordExceeds5) {
              emittedChordExceeds5 = true;
              transitionCues.push({
                sliceId: slice.sliceId,
                hand,
                measureIndex: slice.measureIndex,
                type: allNotesArpeggiated ? "wide-stretch" : "unreachable-span",
                severity: allNotesArpeggiated ? "info" : "danger",
                cost: dist + 10,
                label: allNotesArpeggiated
                  ? "Chord exceeds 5 fingers (arpeggiated)"
                  : "Chord exceeds 5 fingers (arpeggiate / split)",
              });
            }
            continue;
          }
          const maxSpan = getMaxSpan(fingers[i], fingers[j], scale);
          const comfortSpan = getComfortSpan(fingers[i], fingers[j], scale);
          if (dist > maxSpan + 1e-6) {
            transitionCues.push({
              sliceId: slice.sliceId,
              hand,
              measureIndex: slice.measureIndex,
              type: pairArpeggiated ? "wide-stretch" : "unreachable-span",
              severity: pairArpeggiated ? "info" : "danger",
              cost: dist - maxSpan,
              label: pairArpeggiated ? "Arpeggiated span" : "Unreachable span",
            });
          } else if (dist >= comfortSpan * 0.85 - 1e-6) {
            transitionCues.push({
              sliceId: slice.sliceId,
              hand,
              measureIndex: slice.measureIndex,
              type: "wide-stretch",
              severity: pairArpeggiated ? "info" : "warn",
              cost: dist / comfortSpan,
              label: pairArpeggiated ? "Arpeggiated span" : "Wide stretch",
            });
          }
        }

        for (const held of activeHeldBySlice[idx]) {
          const heldFinger = fingerByNoteUid[held.noteUid];
          if (!heldFinger || heldFinger === fingers[i]) continue;
          const dist = Math.abs(posI - toHandFramePos(held.midi, hand));
          const maxSpan = getMaxSpan(heldFinger, fingers[i], scale);
          const comfortSpan = getComfortSpan(heldFinger, fingers[i], scale);
          if (dist > maxSpan + 1e-6) {
            transitionCues.push({
              sliceId: slice.sliceId,
              hand,
              measureIndex: slice.measureIndex,
              type: "unreachable-span",
              severity: "danger",
              cost: dist - maxSpan,
              label: "Unreachable span (held)",
            });
          } else if (dist >= comfortSpan * 0.85 - 1e-6) {
            transitionCues.push({
              sliceId: slice.sliceId,
              hand,
              measureIndex: slice.measureIndex,
              type: "wide-stretch",
              severity: "warn",
              cost: dist / comfortSpan,
              label: "Wide stretch (held)",
            });
          }
        }
      }

      for (const rel of releasedHeldBySlice[idx]) {
        if (rel.reason === "unreachable") {
          transitionCues.push({
            sliceId: slice.sliceId,
            hand,
            measureIndex: slice.measureIndex,
            type: "unreachable-span",
            severity: "danger",
            cost: rel.minOverSpan,
            label: "Unreachable span (held — use pedal)",
          });
        }
      }

      let hadCrossingOrShift = false;

      if (idx > 0 && handSlices[idx - 1].phraseId === slice.phraseId) {
        const prev = handSlices[idx - 1];
        const prevFingers = resolveDepartureFingers(
          prev,
          prev.notes.map((n) => fingerByNoteUid[n.noteUid]),
          ignoreExistingFingerings
        );
        const dt = Math.max(0.05, slice.onsetSec - prev.onsetSec);

        if (prev.notes.length === 1 && slice.notes.length === 1) {
          const d =
            toHandFramePos(slice.notes[0].midi, hand) -
            toHandFramePos(prev.notes[0].midi, hand);
          const fPrev = prevFingers[0];
          const fCurr = fingers[0];

          if (d > 0.2 && Math.abs(d) <= 3.5 * scale && fCurr === 1 && fPrev >= 2 && fPrev <= 4) {
            hadCrossingOrShift = true;
            transitionCues.push({
              sliceId: slice.sliceId,
              hand,
              measureIndex: slice.measureIndex,
              type: "thumb-under",
              severity: "info",
              cost: 1.5,
              label: `Thumb-under (${fPrev}→1)`,
            });
          } else if (d < -0.2 && Math.abs(d) <= 3.5 * scale && fPrev === 1 && fCurr >= 2 && fCurr <= 4) {
            hadCrossingOrShift = true;
            transitionCues.push({
              sliceId: slice.sliceId,
              hand,
              measureIndex: slice.measureIndex,
              type: "cross-over",
              severity: "info",
              cost: 1.5,
              label: `Cross-over (1→${fCurr})`,
            });
          } else if (
            fPrev !== fCurr &&
            Math.abs(d) > 0.2 &&
            ((d > 0 && fCurr > fPrev) || (d < 0 && fCurr < fPrev))
          ) {
            const maxSpan = getMaxSpan(fPrev, fCurr, scale);
            const comfortSpan = getComfortSpan(fPrev, fCurr, scale);
            if (Math.abs(d) > maxSpan + 1e-6 && dt < 0.2) {
              transitionCues.push({
                sliceId: slice.sliceId,
                hand,
                measureIndex: slice.measureIndex,
                type: "unreachable-span",
                severity: "danger",
                cost: Math.abs(d) - maxSpan,
                label: "Unreachable span",
              });
            } else if (Math.abs(d) >= comfortSpan * 0.85 - 1e-6 && dt < 0.4) {
              transitionCues.push({
                sliceId: slice.sliceId,
                hand,
                measureIndex: slice.measureIndex,
                type: "wide-stretch",
                severity: "warn",
                cost: Math.abs(d) / comfortSpan,
                label: "Wide stretch",
              });
            }
          }
        }

        const prevRoot = computeHandRoot(prev.notes, prevFingers, hand);
        const currRoot = computeHandRoot(slice.notes, fingers, hand);
        const rootShift = Math.abs(currRoot - prevRoot);
        const noOverlap =
          prevBounds !== null &&
          (hand === "RH"
            ? bounds.thumbKey > prevBounds.pinkyKey || bounds.pinkyKey < prevBounds.thumbKey
            : bounds.pinkyKey > prevBounds.thumbKey || bounds.thumbKey < prevBounds.pinkyKey);

        if (!hadCrossingOrShift && (rootShift >= 2.0 || noOverlap)) {
          hadCrossingOrShift = true;
          const velocity = rootShift / dt;
          const isSameFingerJump =
            prev.notes.length === 1 &&
            slice.notes.length === 1 &&
            prevFingers[0] === fingers[0] &&
            prev.notes[0].midi !== slice.notes[0].midi &&
            (rootShift >= 2.5 && dt <= 0.3 || velocity > 18.0);
          const isDangerLeap =
            (velocity >= 35.0 && rootShift >= 7.0) || (rootShift >= 10.0 && dt <= 0.25);
          const isWarnLeap =
            isSameFingerJump ||
            (velocity >= 22.0 && rootShift >= 4.0) ||
            (rootShift >= 7.0 && dt <= 0.3);

          const severity: TransitionCue["severity"] = isDangerLeap
            ? "danger"
            : isWarnLeap
              ? "warn"
              : "info";
          const label = isDangerLeap
            ? "Extreme position leap"
            : isSameFingerJump
              ? "Awkward jump"
              : isWarnLeap
                ? "Fast position shift"
                : "Position shift";

          transitionCues.push({
            sliceId: slice.sliceId,
            hand,
            measureIndex: slice.measureIndex,
            type: "position-shift",
            severity,
            cost: rootShift,
            label,
          });
        }
      }

      const mergedThumb =
        hand === "RH"
          ? Math.min(currentPos?.thumbKey ?? bounds.thumbKey, bounds.thumbKey)
          : Math.max(currentPos?.thumbKey ?? bounds.thumbKey, bounds.thumbKey);
      const mergedPinky =
        hand === "RH"
          ? Math.max(currentPos?.pinkyKey ?? bounds.pinkyKey, bounds.pinkyKey)
          : Math.min(currentPos?.pinkyKey ?? bounds.pinkyKey, bounds.pinkyKey);
      const withinSingleHandSpan =
        currentPos !== null &&
        Math.abs(mergedPinky - mergedThumb) <= 7 &&
        Math.abs(bounds.pinkyKey - currentPos.pinkyKey) <= 2;

      if (
        currentPos &&
        !hadCrossingOrShift &&
        handSlices[idx - 1].phraseId === slice.phraseId &&
        Math.abs(bounds.thumbKey - anchorThumbKey) <= 1 &&
        withinSingleHandSpan
      ) {
        currentPos.endSliceId = slice.sliceId;
        currentPos.minMidi = Math.min(currentPos.minMidi, bounds.minMidi);
        currentPos.maxMidi = Math.max(currentPos.maxMidi, bounds.maxMidi);
        currentPos.thumbKey = mergedThumb;
        currentPos.pinkyKey = mergedPinky;
      } else {
        if (currentPos) {
          handPositions.push(currentPos);
        }
        anchorThumbKey = bounds.thumbKey;
        currentPos = {
          hand,
          startSliceId: slice.sliceId,
          endSliceId: slice.sliceId,
          thumbKey: bounds.thumbKey,
          pinkyKey: bounds.pinkyKey,
          minMidi: bounds.minMidi,
          maxMidi: bounds.maxMidi,
        };
      }
      prevBounds = bounds;
    }

    if (currentPos) {
      handPositions.push(currentPos);
    }
  }

  return { handPositions, transitionCues };
}

/**
 * Pure TypeScript Beam Search DP solver over OnsetSlices (zero DOM dependencies).
 */
export function solveFingering(
  onsetSlices: OnsetSlice[],
  profile: HandSpanProfile = DEFAULT_HAND_SPAN_PROFILE,
  options?: SolveOptions
): SolveResult {
  const ignoreExistingFingerings = Boolean(options?.ignoreExistingFingerings);
  const start = typeof performance !== "undefined" ? performance.now() : Date.now();
  const fingerByNoteUid: Record<string, Finger> = {};
  const repairedAnchorUids: string[] = [];
  const anchorConflictSliceIds = new Set<string>();
  const earlyReleasesByNoteUid: Record<string, HeldNoteRelease> = {};

  // Group slices into independent (hand, phraseId) segments
  const segmentMap = new Map<string, OnsetSlice[]>();
  const segmentOrder: string[] = [];

  for (const slice of onsetSlices) {
    const key = `${slice.hand}:${slice.phraseId}`;
    let seg = segmentMap.get(key);
    if (!seg) {
      seg = [];
      segmentMap.set(key, seg);
      segmentOrder.push(key);
    }
    seg.push(slice);
  }

  for (const key of segmentOrder) {
    const segment = segmentMap.get(key)!;
    solvePhraseSegment(
      segment,
      profile,
      fingerByNoteUid,
      repairedAnchorUids,
      anchorConflictSliceIds,
      earlyReleasesByNoteUid,
      ignoreExistingFingerings
    );
  }

  const { handPositions, transitionCues } = derivePositionsAndCues(
    onsetSlices,
    fingerByNoteUid,
    profile,
    anchorConflictSliceIds,
    ignoreExistingFingerings
  );

  const warnings = transitionCues.filter(
    (c) => c.severity === "warn" || c.severity === "danger"
  );
  const repairSuggestions = analyzeScoreRepairSuggestions(onsetSlices, profile);
  const end = typeof performance !== "undefined" ? performance.now() : Date.now();

  return {
    fingerByNoteUid,
    handPositions,
    transitionCues,
    warnings,
    repairedAnchorUids,
    solveTimeMs: end - start,
    repairSuggestions,
    earlyReleasesByNoteUid,
  };
}
