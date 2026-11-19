import {
  DEFAULT_HAND_SPAN_PROFILE,
  type Finger,
  type Hand,
  type HandPosition,
  type HandSpanProfile,
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
import { getMaxSpan, getSpanScale, toHandFramePos, whiteKeyIndex } from "./keyboard";
import { DEFAULT_COST_WEIGHTS } from "./weights";

export const BEAM_WIDTH = 28; // SPEC 4.1: BEAM = 24-32
export const ASTAR_MAX_EXPANSIONS_PER_SLICE = 64;
export const ASTAR_MIN_EXPANSION_BUDGET = 4000;

export interface BeamNode {
  fingers: Finger[];
  totalCost: number;
  rankScore: number;
  prevIdx: number;
  stateKey: string;
}

export interface HeldReservation {
  finger: Finger;
  untilSliceIdx: number;
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
  const heldByUid = new Map<string, number>();
  for (const h of slice.heldNotes) {
    heldByUid.set(h.noteUid, h.midi);
  }
  let cursor = pIdx;
  for (let back = t - 1; back >= 0 && heldByUid.size > 0 && cursor >= 0; back--) {
    const prevSlice = slices[back];
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
  if (priorFingerByNoteUid) {
    for (const [uid, midi] of heldByUid.entries()) {
      const priorF = priorFingerByNoteUid[uid];
      if (priorF) {
        heldMap.set(priorF, midi);
      }
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
  neededUids: string[]
): Map<string, Finger> {
  const result = new Map<string, Finger>();
  if (neededUids.length === 0) return result;
  const remaining = new Set(neededUids);

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
          if (dist > maxSpan) {
            const allFingers: Finger[] = [1, 2, 3, 4, 5];
            const canImprove = allFingers.some(
              (fAlt) => fAlt !== hCommitted.finger && getMaxSpan(hCommitted.finger, fAlt, scale) >= dist
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
  lookahead: { hFuture: number[][]; reservationsByNoteUid: Map<string, HeldReservation[]> } | null
): { stateKey: string; penalty: number } {
  let penalty = lookahead ? lookahead.hFuture[t][cIdx] : 0;
  let stateKey = cand.join("");
  if (nextSliceHeldUids.length > 0) {
    const carried = resolveActiveNoteFingers(slice, cand, slices, layers, t, pIdx, nextSliceHeldUids);
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
  } = opts;

  const slice = slices[t];
  const nextBeam: BeamNode[] = [];

  if (t === 0) {
    const heldFingers = buildHeldFingerMapFromBeam(
      slice,
      slices,
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
          ? computeHorizontalCost(
              prevPrefixSlice,
              prevPrefixFingers,
              slice,
              cand,
              profile,
              ignoreExistingFingerings
            ).cost
          : 0;
      const totalCost = vertCost + horizCost;
      const { stateKey, penalty } = buildStateKeyAndLookaheadPenalty(
        slice,
        cand,
        slices,
        layers,
        t,
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
    const prevBeam = layers[t - 1];
    const prevSlice = slices[t - 1];
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
          ? buildHeldFingerMapFromBeam(
              slice,
              slices,
              layers,
              t,
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
          profile,
          ignoreExistingFingerings
        );
        const totalCost = prevNode.totalCost + vertCost + horiz.cost;
        const { stateKey, penalty } = buildStateKeyAndLookaheadPenalty(
          slice,
          cand,
          slices,
          layers,
          t,
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

function solvePhraseSegmentBeamFallback(
  slices: OnsetSlice[],
  candidatesBySlice: Finger[][][],
  lookahead: AnchorLookahead | null,
  profile: HandSpanProfile,
  ignoreExistingFingerings: boolean
): Finger[][] {
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
  let cursor = bestIdx;
  for (let t = slices.length - 1; t >= 0; t--) {
    const node = layers[t][cursor];
    chosen[t] = node.fingers;
    cursor = node.prevIdx;
  }
  return chosen;
}

function buildNextHeldState(
  slice: OnsetSlice,
  cand: Finger[],
  prevHeldByUid: Map<string, Finger> | null,
  nextSliceHeldUids: string[],
  lookahead: AnchorLookahead | null,
  t: number,
  cIdx: number
): { nextHeldByUid: Map<string, Finger>; stateKey: string; heuristic: number } {
  let heuristic = lookahead ? lookahead.hFuture[t][cIdx] : 0;
  let stateKey = String(cIdx);
  const nextHeldByUid = new Map<string, Finger>();

  if (nextSliceHeldUids.length > 0) {
    const stealPenalty = DEFAULT_COST_WEIGHTS.vertical.heldStealPenalty;
    const suffixParts: number[] = [];

    for (const uid of nextSliceHeldUids) {
      let f: Finger | undefined;
      for (let i = 0; i < slice.notes.length; i++) {
        if (slice.notes[i].noteUid === uid) {
          f = cand[i];
          break;
        }
      }
      if (f === undefined && prevHeldByUid) {
        f = prevHeldByUid.get(uid);
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
  ignoreExistingFingerings: boolean
): Finger[][] | null {
  const nSlices = slices.length;
  const maxExpansions = Math.max(
    ASTAR_MIN_EXPANSION_BUDGET,
    nSlices * ASTAR_MAX_EXPANSIONS_PER_SLICE
  );
  const emptyHeld = new Map<Finger, number>();

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
      let cursor = nodeIdx;
      while (cursor >= 0) {
        const cur = nodes[cursor];
        chosen[cur.t] = candidatesBySlice[cur.t][cur.cIdx];
        cursor = cur.parentIdx;
      }
      return chosen;
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

    let heldFingers = emptyHeld;
    if (currSlice.heldNotes.length > 0) {
      heldFingers = new Map<Finger, number>();
      for (const h of currSlice.heldNotes) {
        const f = node.nextHeldByUid.get(h.noteUid);
        if (f !== undefined) {
          heldFingers.set(f, h.midi);
        }
      }
    }

    const cachedVert = cachedBaseVertCosts[nextT];
    const nextHeldUids = nextHeldUidsBySlice[nextT];
    const bestLayerMap = bestGByLayer[nextT];

    for (let cIdx = 0; cIdx < currCands.length; cIdx++) {
      const cand = currCands[cIdx];
      const vertCost =
        cachedVert !== null
          ? cachedVert[cIdx]
          : computeVerticalCost(currSlice, cand, heldFingers, profile).cost;
      const horizCost = computeHorizontalCost(
        prevSlice,
        prevCand,
        currSlice,
        cand,
        profile,
        ignoreExistingFingerings
      ).cost;
      const g = node.g + vertCost + horizCost;

      const { nextHeldByUid, stateKey, heuristic } = buildNextHeldState(
        currSlice,
        cand,
        node.nextHeldByUid,
        nextHeldUids,
        lookahead,
        nextT,
        cIdx
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
      });
      heap.push(childIdx);
    }
  }

  return null;
}

function solvePhraseSegment(
  slices: OnsetSlice[],
  profile: HandSpanProfile,
  fingerByNoteUid: Record<string, Finger>,
  repairedAnchorUids: string[],
  anchorConflictSliceIds: Set<string>,
  ignoreExistingFingerings = false
): void {
  if (slices.length === 0) return;

  const heldAnalysis = analyzeHandHeldNotes(slices, profile);
  const effectiveSlices = applyEffectiveHeldNotes(slices, heldAnalysis);

  const { candidatesBySlice, lookahead } = prepareSegmentBeamContext(
    effectiveSlices,
    profile,
    anchorConflictSliceIds,
    ignoreExistingFingerings
  );

  const hasHeldNotes = effectiveSlices.some((s) => s.heldNotes.length > 0);
  let chosen: Finger[][] | null = null;

  if (!hasHeldNotes && lookahead) {
    // Strictly 1st-order Markov segment: backward DP already gives the exact global optimum
    chosen = new Array<Finger[]>(effectiveSlices.length);
    const firstBack = lookahead.backward[0];
    let c = 0;
    for (let i = 1; i < firstBack.length; i++) {
      if (firstBack[i] < firstBack[c]) c = i;
    }
    for (let t = 0; t < effectiveSlices.length; t++) {
      chosen[t] = candidatesBySlice[t][c];
      c = lookahead.bestNextChoice[t][c];
    }
  } else if (lookahead) {
    // Polyphonic / held-note segment: admissible A* with anytime Beam fallback
    chosen = solvePhraseSegmentAStar(
      effectiveSlices,
      candidatesBySlice,
      lookahead,
      profile,
      ignoreExistingFingerings
    );
  }

  if (!chosen) {
    chosen = solvePhraseSegmentBeamFallback(
      effectiveSlices,
      candidatesBySlice,
      lookahead,
      profile,
      ignoreExistingFingerings
    );
  }

  recordSolvedPath(
    slices,
    chosen,
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
      for (let i = 0; i < slice.notes.length; i++) {
        const posI = toHandFramePos(slice.notes[i].midi, hand);
        for (let j = i + 1; j < slice.notes.length; j++) {
          const dist = Math.abs(toHandFramePos(slice.notes[j].midi, hand) - posI);
          const semitoneDiff = Math.abs(slice.notes[j].midi - slice.notes[i].midi);
          if (fingers[i] === fingers[j]) {
            const isValidDouble =
              (fingers[i] === 1 || fingers[i] === 5) && semitoneDiff <= 2 && dist <= 1.5;
            if (!isValidDouble && !emittedChordExceeds5) {
              emittedChordExceeds5 = true;
              transitionCues.push({
                sliceId: slice.sliceId,
                hand,
                measureIndex: slice.measureIndex,
                type: "unreachable-span",
                severity: "danger",
                cost: dist + 10,
                label: "Chord exceeds 5 fingers (arpeggiate / split)",
              });
            }
            continue;
          }
          const maxSpan = getMaxSpan(fingers[i], fingers[j], scale);
          if (dist > maxSpan) {
            transitionCues.push({
              sliceId: slice.sliceId,
              hand,
              measureIndex: slice.measureIndex,
              type: "unreachable-span",
              severity: "danger",
              cost: dist - maxSpan,
              label: "Unreachable span",
            });
          } else if (dist >= maxSpan * 0.85) {
            transitionCues.push({
              sliceId: slice.sliceId,
              hand,
              measureIndex: slice.measureIndex,
              type: "wide-stretch",
              severity: "warn",
              cost: dist / maxSpan,
              label: "Wide stretch",
            });
          }
        }

        for (const held of activeHeldBySlice[idx]) {
          const heldFinger = fingerByNoteUid[held.noteUid];
          if (!heldFinger || heldFinger === fingers[i]) continue;
          const dist = Math.abs(posI - toHandFramePos(held.midi, hand));
          const maxSpan = getMaxSpan(heldFinger, fingers[i], scale);
          if (dist > maxSpan) {
            transitionCues.push({
              sliceId: slice.sliceId,
              hand,
              measureIndex: slice.measureIndex,
              type: "unreachable-span",
              severity: "danger",
              cost: dist - maxSpan,
              label: "Unreachable span (held)",
            });
          } else if (dist >= maxSpan * 0.85) {
            transitionCues.push({
              sliceId: slice.sliceId,
              hand,
              measureIndex: slice.measureIndex,
              type: "wide-stretch",
              severity: "warn",
              cost: dist / maxSpan,
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
            if (Math.abs(d) > maxSpan && dt < 0.2) {
              transitionCues.push({
                sliceId: slice.sliceId,
                hand,
                measureIndex: slice.measureIndex,
                type: "unreachable-span",
                severity: "danger",
                cost: Math.abs(d) - maxSpan,
                label: "Unreachable span",
              });
            } else if (Math.abs(d) >= maxSpan * 0.85 && dt < 0.4) {
              transitionCues.push({
                sliceId: slice.sliceId,
                hand,
                measureIndex: slice.measureIndex,
                type: "wide-stretch",
                severity: "warn",
                cost: Math.abs(d) / maxSpan,
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
