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
} from "./costModel";
import { getMaxSpan, getSpanScale, toHandFramePos, whiteKeyIndex } from "./keyboard";

const BEAM_WIDTH = 28; // SPEC 4.1: BEAM = 24-32

interface BeamNode {
  fingers: Finger[];
  totalCost: number;
  rankScore: number;
  prevIdx: number;
  stateKey: string;
}

interface HeldReservation {
  finger: Finger;
  untilSliceIdx: number;
}

function buildHeldFingerMapFromBeam(
  slice: OnsetSlice,
  slices: OnsetSlice[],
  layers: BeamNode[][],
  t: number,
  pIdx: number
): Map<Finger, number> {
  const heldMap = new Map<Finger, number>();
  if (slice.heldNotes.length === 0 || t === 0) {
    return heldMap;
  }
  const heldByUid = new Map<string, number>();
  for (const h of slice.heldNotes) {
    heldByUid.set(h.noteUid, h.midi);
  }
  let cursor = pIdx;
  for (let back = t - 1; back >= 0 && heldByUid.size > 0; back--) {
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
  return heldMap;
}

function resolveActiveNoteFingers(
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

function computeAnchorLookahead(
  slices: OnsetSlice[],
  candidatesBySlice: Finger[][][],
  profile: HandSpanProfile
): {
  hFuture: number[][];
  reservationsByNoteUid: Map<string, HeldReservation[]>;
} {
  const nSlices = slices.length;
  const emptyHeld = new Map<Finger, number>();

  const baseVertCosts: number[][] = candidatesBySlice.map((cands, t) =>
    cands.map((cand) => computeVerticalCost(slices[t], cand, emptyHeld, profile).cost)
  );

  const backward: number[][] = Array.from({ length: nSlices }, () => []);
  const hFuture: number[][] = Array.from({ length: nSlices }, () => []);

  const last = nSlices - 1;
  for (let c = 0; c < candidatesBySlice[last].length; c++) {
    backward[last][c] = baseVertCosts[last][c];
    hFuture[last][c] = 0;
  }

  for (let t = nSlices - 2; t >= 0; t--) {
    const currCands = candidatesBySlice[t];
    const nextCands = candidatesBySlice[t + 1];
    for (let c = 0; c < currCands.length; c++) {
      let bestNext = Infinity;
      for (let nc = 0; nc < nextCands.length; nc++) {
        const horizCost = computeHorizontalCost(
          slices[t],
          currCands[c],
          slices[t + 1],
          nextCands[nc],
          profile
        ).cost;
        const total = horizCost + backward[t + 1][nc];
        if (total < bestNext) {
          bestNext = total;
        }
      }
      hFuture[t][c] = bestNext;
      backward[t][c] = baseVertCosts[t][c] + bestNext;
    }
  }

  // Reserve fingers required by future anchored notes while earlier notes are held
  const reservationsByNoteUid = new Map<string, HeldReservation[]>();
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

  return { hFuture, reservationsByNoteUid };
}

function resolveCrossSliceAnchorConflicts(
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

function buildStateKeyAndLookaheadPenalty(
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
      for (const [uid, f] of carried.entries()) {
        const resList = lookahead.reservationsByNoteUid.get(uid);
        if (resList && resList.some((r) => r.untilSliceIdx > t && r.finger === f)) {
          penalty += 400.0;
        }
      }
    }
  }
  return { stateKey, penalty };
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

  const lookahead = hasAnyAnchors
    ? computeAnchorLookahead(slices, candidatesBySlice, profile)
    : null;

  const layers: BeamNode[][] = [];

  for (let t = 0; t < slices.length; t++) {
    const slice = slices[t];
    const candidates = candidatesBySlice[t];
    const nextSliceHeldUids =
      t + 1 < slices.length ? slices[t + 1].heldNotes.map((h) => h.noteUid) : [];

    const nextBeam: BeamNode[] = [];

    if (t === 0) {
      const emptyHeld = new Map<Finger, number>();
      for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
        const cand = candidates[cIdx];
        const { cost } = computeVerticalCost(slice, cand, emptyHeld, profile);
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
          totalCost: cost,
          rankScore: cost + penalty,
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
            ? buildHeldFingerMapFromBeam(slice, slices, layers, t, pIdx)
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
    layers.push(deduped);
  }

  // Backtrack best terminal node
  const lastLayer = layers[layers.length - 1];
  let bestIdx = 0;
  for (let i = 1; i < lastLayer.length; i++) {
    if (lastLayer[i].totalCost < lastLayer[bestIdx].totalCost) {
      bestIdx = i;
    }
  }

  let cursor = bestIdx;
  for (let t = slices.length - 1; t >= 0; t--) {
    const node = layers[t][cursor];
    const slice = slices[t];
    for (let i = 0; i < slice.notes.length; i++) {
      const note = slice.notes[i];
      fingerByNoteUid[note.noteUid] = node.fingers[i];
      if (
        !ignoreExistingFingerings &&
        note.anchorFinger !== undefined &&
        node.fingers[i] !== note.anchorFinger
      ) {
        repairedAnchorUids.push(note.noteUid);
      }
    }
    cursor = node.prevIdx;
  }
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

function derivePositionsAndCues(
  slices: OnsetSlice[],
  fingerByNoteUid: Record<string, Finger>,
  profile: HandSpanProfile,
  anchorConflictSliceIds: Set<string>
): { handPositions: HandPosition[]; transitionCues: TransitionCue[] } {
  const handPositions: HandPosition[] = [];
  const transitionCues: TransitionCue[] = [];
  const scale = getSpanScale(profile);

  // Process per hand in chronological slice order
  for (const hand of ["RH", "LH"] as Hand[]) {
    const handSlices = slices.filter((s) => s.hand === hand);
    if (handSlices.length === 0) continue;

    let currentPos: HandPosition | null = null;

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
      for (let i = 0; i < slice.notes.length; i++) {
        const posI = toHandFramePos(slice.notes[i].midi, hand);
        for (let j = i + 1; j < slice.notes.length; j++) {
          const dist = Math.abs(toHandFramePos(slice.notes[j].midi, hand) - posI);
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
          } else if (dist > maxSpan * 0.85) {
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

        for (const held of slice.heldNotes) {
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
          } else if (dist > maxSpan * 0.85) {
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

      let hadCrossingOrShift = false;

      if (idx > 0 && handSlices[idx - 1].phraseId === slice.phraseId) {
        const prev = handSlices[idx - 1];
        const prevFingers = prev.notes.map((n) => fingerByNoteUid[n.noteUid]);
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
            } else if (Math.abs(d) > maxSpan * 0.85 && dt < 0.4) {
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
        if (!hadCrossingOrShift && rootShift >= 2.0) {
          hadCrossingOrShift = true;
          const isFastJump = rootShift / dt > 12.0;
          transitionCues.push({
            sliceId: slice.sliceId,
            hand,
            measureIndex: slice.measureIndex,
            type: "position-shift",
            severity: isFastJump ? "warn" : "info",
            cost: rootShift,
            label: isFastJump ? "Fast position shift" : "Position shift",
          });
        }
      }

      if (
        currentPos &&
        !hadCrossingOrShift &&
        handSlices[idx - 1].phraseId === slice.phraseId &&
        Math.abs(bounds.thumbKey - currentPos.thumbKey) <= 1
      ) {
        currentPos.endSliceId = slice.sliceId;
        currentPos.minMidi = Math.min(currentPos.minMidi, bounds.minMidi);
        currentPos.maxMidi = Math.max(currentPos.maxMidi, bounds.maxMidi);
      } else {
        if (currentPos) {
          handPositions.push(currentPos);
        }
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
    anchorConflictSliceIds
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
