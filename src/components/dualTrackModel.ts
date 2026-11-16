import type {
  Finger,
  Hand,
  HandPosition,
  OnsetSlice,
  ScoreDocument,
  SolveResult,
  TransitionCue,
} from "../domain/types";
import { isBlackKey, whiteKeyIndex } from "../solver/keyboard";

export interface KeyFingerBadge {
  noteUid: string;
  midi: number;
  finger: Finger | undefined;
  isAnchor: boolean;
  isRepairedAnchor: boolean;
}

export interface HeldFingerBadge {
  noteUid: string;
  midi: number;
  finger: Finger | undefined;
  endTick: number;
}

export interface TransitionCueArc {
  cue: TransitionCue;
  fromMidi: number;
  toMidi: number;
  isSequential: boolean;
}

export interface HandTrackState {
  hand: Hand;
  activeSliceId: string | null;
  activeKeys: KeyFingerBadge[];
  heldFingers: HeldFingerBadge[];
  handPosition: HandPosition | null;
  transitionCues: TransitionCueArc[];
  startMidi: number;
  endMidi: number;
}

export interface DualTrackState {
  selectedSlice: OnsetSlice | null;
  selectedIndex: number;
  totalSlices: number;
  rh: HandTrackState;
  lh: HandTrackState;
}

const NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const WHITE_STEP_SEMITONES = [0, 2, 4, 5, 7, 9, 11];

/**
 * Formats a MIDI pitch (21..108) into a concise note label such as "C4" or "Gb5".
 */
export function midiToNoteName(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[pc]}${octave}`;
}

/**
 * Converts a white-key index from `whiteKeyIndex()` back into its MIDI pitch.
 */
export function whiteKeyIndexToMidi(whiteIdx: number): number {
  const octave = Math.floor(whiteIdx / 7);
  const step = ((whiteIdx % 7) + 7) % 7;
  return (octave + 1) * 12 + WHITE_STEP_SEMITONES[step];
}

function emptyHandTrack(hand: Hand): HandTrackState {
  return {
    hand,
    activeSliceId: null,
    activeKeys: [],
    heldFingers: [],
    handPosition: null,
    transitionCues: [],
    startMidi: hand === "RH" ? 60 : 36,
    endMidi: hand === "RH" ? 91 : 64,
  };
}

function findHandPositionForSlice(
  hand: Hand,
  sliceId: string,
  handPositions: HandPosition[],
  sliceIndexById: Map<string, number>
): HandPosition | null {
  const targetIdx = sliceIndexById.get(sliceId);
  if (targetIdx === undefined) return null;

  for (const hp of handPositions) {
    if (hp.hand !== hand) continue;
    const startIdx = sliceIndexById.get(hp.startSliceId);
    const endIdx = sliceIndexById.get(hp.endSliceId);
    if (startIdx !== undefined && endIdx !== undefined && targetIdx >= startIdx && targetIdx <= endIdx) {
      return hp;
    }
  }
  return null;
}

function computeTrackMidiRange(
  hand: Hand,
  activeKeys: KeyFingerBadge[],
  heldFingers: HeldFingerBadge[],
  handPosition: HandPosition | null,
  transitionCues: TransitionCueArc[]
): { startMidi: number; endMidi: number } {
  let minMidi = hand === "RH" ? 60 : 36;
  let maxMidi = hand === "RH" ? 91 : 64;

  const includeMidi = (m: number) => {
    if (m - 2 < minMidi) minMidi = m - 2;
    if (m + 2 > maxMidi) maxMidi = m + 2;
  };

  for (const k of activeKeys) includeMidi(k.midi);
  for (const h of heldFingers) includeMidi(h.midi);
  for (const c of transitionCues) {
    includeMidi(c.fromMidi);
    includeMidi(c.toMidi);
  }
  if (handPosition) {
    const lowWhite = Math.min(handPosition.thumbKey, handPosition.pinkyKey);
    const highWhite = Math.max(handPosition.thumbKey, handPosition.pinkyKey);
    includeMidi(whiteKeyIndexToMidi(lowWhite));
    includeMidi(whiteKeyIndexToMidi(highWhite));
  }

  minMidi = Math.max(21, minMidi);
  maxMidi = Math.min(108, maxMidi);
  if (isBlackKey(minMidi) && minMidi > 21) minMidi -= 1;
  if (isBlackKey(maxMidi) && maxMidi < 108) maxMidi += 1;

  return { startMidi: minMidi, endMidi: maxMidi };
}

function computeChainEndTicks(scoreDoc: ScoreDocument): Map<string, number> {
  const endByRoot = new Map<string, number>();
  for (const ev of scoreDoc.noteEvents) {
    if (ev.isGrace) continue;
    const evEnd = ev.onsetTick + ev.durationTick;
    if (!ev.isTieStop) {
      endByRoot.set(ev.noteUid, Math.max(endByRoot.get(ev.noteUid) ?? 0, evEnd));
    } else if (ev.tieChainRootUid) {
      endByRoot.set(
        ev.tieChainRootUid,
        Math.max(endByRoot.get(ev.tieChainRootUid) ?? 0, evEnd)
      );
    }
  }
  return endByRoot;
}

function findSustainingHandSliceId(
  hand: Hand,
  targetOnsetTick: number,
  onsetSlices: OnsetSlice[]
): string | null {
  let latestSliceId: string | null = null;
  for (const s of onsetSlices) {
    if (s.hand === hand && s.onsetTick < targetOnsetTick) {
      latestSliceId = s.sliceId;
    }
  }
  return latestSliceId;
}

function sliceCenterMidi(slice: OnsetSlice): number {
  if (slice.notes.length === 0) return 60;
  if (slice.notes.length === 1) return slice.notes[0].midi;
  return Math.round((slice.notes[0].midi + slice.notes[slice.notes.length - 1].midi) / 2);
}

function findPrevSameHandSlice(
  hand: Hand,
  activeSliceId: string,
  onsetSlices: OnsetSlice[],
  sliceIndexById: Map<string, number>
): OnsetSlice | null {
  const activeIdx = sliceIndexById.get(activeSliceId);
  if (activeIdx === undefined) return null;
  for (let i = activeIdx - 1; i >= 0; i--) {
    if (onsetSlices[i].hand === hand) {
      return onsetSlices[i];
    }
  }
  return null;
}

const SEVERITY_RANK: Record<TransitionCue["severity"], number> = {
  danger: 3,
  warn: 2,
  info: 1,
};

function buildTransitionCueArcs(
  hand: Hand,
  activeSlice: OnsetSlice | null,
  onsetSlices: OnsetSlice[],
  allCues: TransitionCue[],
  sliceIndexById: Map<string, number>
): TransitionCueArc[] {
  if (!activeSlice) return [];
  const rawCues = allCues.filter((c) => c.sliceId === activeSlice.sliceId && c.hand === hand);
  if (rawCues.length === 0) return [];

  const deduped: TransitionCue[] = [];
  const seen = new Set<string>();
  for (const c of rawCues) {
    const key = `${c.type}:${c.severity}:${c.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  deduped.sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.cost - a.cost
  );

  const prevSlice = findPrevSameHandSlice(hand, activeSlice.sliceId, onsetSlices, sliceIndexById);
  const currCenter = sliceCenterMidi(activeSlice);

  return deduped.map((cue) => {
    if (cue.type === "thumb-under" || cue.type === "cross-over" || cue.type === "position-shift") {
      return {
        cue,
        fromMidi: prevSlice ? sliceCenterMidi(prevSlice) : currCenter,
        toMidi: currCenter,
        isSequential: true,
      };
    }

    if (activeSlice.notes.length >= 2) {
      return {
        cue,
        fromMidi: activeSlice.notes[0].midi,
        toMidi: activeSlice.notes[activeSlice.notes.length - 1].midi,
        isSequential: false,
      };
    }

    if (activeSlice.heldNotes.length > 0 && activeSlice.notes.length === 1) {
      let farthest = activeSlice.heldNotes[0];
      let bestDist = Math.abs(farthest.midi - currCenter);
      for (const h of activeSlice.heldNotes) {
        const d = Math.abs(h.midi - currCenter);
        if (d > bestDist) {
          bestDist = d;
          farthest = h;
        }
      }
      return {
        cue,
        fromMidi: farthest.midi,
        toMidi: currCenter,
        isSequential: false,
      };
    }

    if (prevSlice) {
      return {
        cue,
        fromMidi: sliceCenterMidi(prevSlice),
        toMidi: currCenter,
        isSequential: true,
      };
    }

    return {
      cue,
      fromMidi: currCenter,
      toMidi: currCenter,
      isSequential: false,
    };
  });
}

function projectSingleHandTrack(
  hand: Hand,
  selectedSlice: OnsetSlice,
  scoreDoc: ScoreDocument,
  solveResult: SolveResult,
  sliceIndexById: Map<string, number>,
  repairedSet: Set<string>,
  chainEndByRoot: Map<string, number>
): HandTrackState {
  const activeSlice =
    selectedSlice.hand === hand
      ? selectedSlice
      : scoreDoc.onsetSlices.find(
          (s) =>
            s.hand === hand &&
            s.onsetTick === selectedSlice.onsetTick &&
            s.isGrace === selectedSlice.isGrace
        ) ?? null;

  const activeKeys: KeyFingerBadge[] = activeSlice
    ? activeSlice.notes.map((n) => ({
        noteUid: n.noteUid,
        midi: n.midi,
        finger: solveResult.fingerByNoteUid[n.noteUid],
        isAnchor: n.anchorFinger !== undefined,
        isRepairedAnchor: repairedSet.has(n.noteUid),
      }))
    : [];

  const activeMidis = new Set(activeKeys.map((k) => k.midi));
  let heldFingers: HeldFingerBadge[] = [];

  if (activeSlice) {
    heldFingers = activeSlice.heldNotes
      .filter((h) => !activeMidis.has(h.midi))
      .map((h) => ({
        noteUid: h.noteUid,
        midi: h.midi,
        finger: solveResult.fingerByNoteUid[h.noteUid],
        endTick: h.endTick,
      }));
  } else {
    for (const ev of scoreDoc.noteEvents) {
      if (ev.hand !== hand || ev.isTieStop || ev.isGrace || ev.durationTick <= 0) continue;
      const endTick = chainEndByRoot.get(ev.noteUid) ?? ev.onsetTick + ev.durationTick;
      if (ev.onsetTick < selectedSlice.onsetTick && endTick > selectedSlice.onsetTick) {
        heldFingers.push({
          noteUid: ev.noteUid,
          midi: ev.midi,
          finger: solveResult.fingerByNoteUid[ev.noteUid],
          endTick,
        });
      }
    }
  }

  const positionLookupSliceId =
    activeSlice?.sliceId ??
    (heldFingers.length > 0
      ? findSustainingHandSliceId(hand, selectedSlice.onsetTick, scoreDoc.onsetSlices)
      : null);

  const handPosition = positionLookupSliceId
    ? findHandPositionForSlice(hand, positionLookupSliceId, solveResult.handPositions, sliceIndexById)
    : null;

  const transitionCues = buildTransitionCueArcs(
    hand,
    activeSlice,
    scoreDoc.onsetSlices,
    solveResult.transitionCues,
    sliceIndexById
  );

  const { startMidi, endMidi } = computeTrackMidiRange(
    hand,
    activeKeys,
    heldFingers,
    handPosition,
    transitionCues
  );

  return {
    hand,
    activeSliceId: activeSlice?.sliceId ?? null,
    activeKeys,
    heldFingers,
    handPosition,
    transitionCues,
    startMidi,
    endMidi,
  };
}

/**
 * Projects a ScoreDocument + SolveResult at a selected OnsetSlice onto separate RH and LH
 * keyboard track states (active struck keys, HeldFingers, HandPosition, and TransitionCues).
 */
export function projectDualTrackState(
  scoreDoc: ScoreDocument | null,
  solveResult: SolveResult | null,
  selectedSliceId: string | null
): DualTrackState {
  if (!scoreDoc || !solveResult || scoreDoc.onsetSlices.length === 0) {
    return {
      selectedSlice: null,
      selectedIndex: -1,
      totalSlices: 0,
      rh: emptyHandTrack("RH"),
      lh: emptyHandTrack("LH"),
    };
  }

  const slices = scoreDoc.onsetSlices;
  const foundIdx = selectedSliceId ? slices.findIndex((s) => s.sliceId === selectedSliceId) : -1;
  const selectedIndex = foundIdx >= 0 ? foundIdx : 0;
  const selectedSlice = slices[selectedIndex];

  const sliceIndexById = new Map<string, number>();
  slices.forEach((s, i) => sliceIndexById.set(s.sliceId, i));
  const repairedSet = new Set(solveResult.repairedAnchorUids);
  const chainEndByRoot = computeChainEndTicks(scoreDoc);

  return {
    selectedSlice,
    selectedIndex,
    totalSlices: slices.length,
    rh: projectSingleHandTrack(
      "RH",
      selectedSlice,
      scoreDoc,
      solveResult,
      sliceIndexById,
      repairedSet,
      chainEndByRoot
    ),
    lh: projectSingleHandTrack(
      "LH",
      selectedSlice,
      scoreDoc,
      solveResult,
      sliceIndexById,
      repairedSet,
      chainEndByRoot
    ),
  };
}

export { whiteKeyIndex };
