import {
  DEFAULT_HAND_SPAN_PROFILE,
  type Finger,
  type Hand,
  type HandPosition,
  type HandSpanProfile,
  type OnsetSlice,
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
  prevIdx: number;
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

function solvePhraseSegment(
  slices: OnsetSlice[],
  profile: HandSpanProfile,
  fingerByNoteUid: Record<string, Finger>,
  repairedAnchorUids: string[],
  anchorConflictSliceIds: Set<string>
): void {
  if (slices.length === 0) return;

  const layers: BeamNode[][] = [];

  for (let t = 0; t < slices.length; t++) {
    const slice = slices[t];
    const { candidates, hadAnchorConflict } = generateSliceCandidates(slice);
    if (hadAnchorConflict) {
      anchorConflictSliceIds.add(slice.sliceId);
      for (const n of slice.notes) {
        if (n.anchorFinger !== undefined) {
          repairedAnchorUids.push(n.noteUid);
        }
      }
    }

    const nextBeam: BeamNode[] = [];

    if (t === 0) {
      const emptyHeld = new Map<Finger, number>();
      for (const cand of candidates) {
        const { cost } = computeVerticalCost(slice, cand, emptyHeld, profile);
        nextBeam.push({ fingers: cand, totalCost: cost, prevIdx: -1 });
      }
    } else {
      const prevBeam = layers[t - 1];
      const prevSlice = slices[t - 1];

      // Precompute vertical cost once per candidate when no held notes exist
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
          nextBeam.push({
            fingers: cand,
            totalCost,
            prevIdx: pIdx,
          });
        }
      }
    }

    nextBeam.sort((a, b) => a.totalCost - b.totalCost);
    layers.push(nextBeam.slice(0, BEAM_WIDTH));
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
      fingerByNoteUid[slice.notes[i].noteUid] = node.fingers[i];
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
      for (let i = 0; i < slice.notes.length; i++) {
        const posI = toHandFramePos(slice.notes[i].midi, hand);
        for (let j = i + 1; j < slice.notes.length; j++) {
          const dist = Math.abs(toHandFramePos(slice.notes[j].midi, hand) - posI);
          const semitoneDiff = Math.abs(slice.notes[j].midi - slice.notes[i].midi);
          if (fingers[i] === fingers[j]) {
            const isValidDouble =
              (fingers[i] === 1 || fingers[i] === 5) && semitoneDiff <= 2 && dist <= 1.5;
            if (!isValidDouble) {
              transitionCues.push({
                sliceId: slice.sliceId,
                hand,
                measureIndex: slice.measureIndex,
                type: "unreachable-span",
                severity: "danger",
                cost: dist + 10,
                label: "Chord exceeds 5 fingers (arpeggiate/split)",
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

      if (
        currentPos &&
        !hadCrossingOrShift &&
        handSlices[idx - 1].phraseId === slice.phraseId &&
        Math.abs(bounds.thumbKey - anchorThumbKey) <= 1
      ) {
        currentPos.endSliceId = slice.sliceId;
        currentPos.minMidi = Math.min(currentPos.minMidi, bounds.minMidi);
        currentPos.maxMidi = Math.max(currentPos.maxMidi, bounds.maxMidi);
        if (hand === "RH") {
          currentPos.thumbKey = Math.min(currentPos.thumbKey, bounds.thumbKey);
          currentPos.pinkyKey = Math.max(currentPos.pinkyKey, bounds.pinkyKey);
        } else {
          currentPos.thumbKey = Math.max(currentPos.thumbKey, bounds.thumbKey);
          currentPos.pinkyKey = Math.min(currentPos.pinkyKey, bounds.pinkyKey);
        }
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
  profile: HandSpanProfile = DEFAULT_HAND_SPAN_PROFILE
): SolveResult {
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
      anchorConflictSliceIds
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
