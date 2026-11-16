import { create, type StateCreator } from "zustand";
import { createStore } from "zustand/vanilla";
import {
  DEFAULT_HAND_SPAN_PROFILE,
  type AnchorOverride,
  type Finger,
  type Hand,
  type HandSpanProfile,
  type NoteEvent,
  type ScoreDocument,
  type SolveResult,
  type TransitionCue,
} from "../domain/types";
import type { MxlContainer } from "../musicxml/mxl";
import type { XmlDomDeps } from "../musicxml/parser";
import type { ExportFormat } from "../musicxml/scoreSession";
import { serializeScoreDocument, writeFingeringsToScore } from "../musicxml/writer";
import { midiToPitchLabel } from "../solver/keyboard";

export interface NoteDiffEntry {
  noteUid: string;
  measureIndex: number;
  pitchLabel: string;
  hand: Hand;
  before: Finger | undefined;
  after: Finger | undefined;
}

export interface StudioSnapshot {
  anchors: Record<string, AnchorOverride>;
  removedRawAnchorUids: string[];
  solveResult: SolveResult;
  fingerByNoteUid: Record<string, Finger>;
  lastDiff: NoteDiffEntry[];
}

export interface SetSolvedScorePayload {
  scoreDoc: ScoreDocument;
  rawXmlText: string;
  mxlContainer?: MxlContainer;
  fileName: string;
  exportFormat: ExportFormat;
  solveResult: SolveResult;
  resetHistory?: boolean;
  xmlDeps?: XmlDomDeps;
}

export interface CommitAnchorResolutionPayload {
  targetNoteUid: string;
  override: AnchorOverride | null;
  result: SolveResult;
  xmlDeps?: XmlDomDeps;
}

export interface StudioState {
  fileName: string;
  scoreTitle: string;
  rawXmlText: string | null;
  mxlContainer: MxlContainer | undefined;
  exportFormat: ExportFormat;
  isSingleStaff: boolean;
  singleStaffHand: Hand;
  handSpanProfile: HandSpanProfile;
  ignoreExistingFingerings: boolean;
  scoreDoc: ScoreDocument | null;
  renderedXml: string | null;
  solveResult: SolveResult | null;
  fingerByNoteUid: Record<string, Finger>;
  anchors: Record<string, AnchorOverride>;
  removedRawAnchorUids: string[];
  lastDiff: NoteDiffEntry[];
  history: {
    past: StudioSnapshot[];
    future: StudioSnapshot[];
  };
  selectedNoteUid: string | null;
  selectedSliceId: string | null;
  selectedMeasureIndex: number | null;
  status: string;
  errorMsg: string | null;

  setExportFormat: (format: ExportFormat) => void;
  setSingleStaffHand: (hand: Hand) => void;
  setHandSpanProfile: (profile: HandSpanProfile) => void;
  setIgnoreExistingFingerings: (ignore: boolean) => void;
  setStatus: (status: string) => void;
  setErrorMsg: (errorMsg: string | null) => void;
  clearScoreErrorState: (errorMsg: string, status?: string) => void;

  setSolvedScore: (payload: SetSolvedScorePayload) => void;
  selectNote: (noteUid: string) => void;
  selectSlice: (sliceId: string) => void;
  selectMeasure: (measureIndex: number, fallbackSliceId?: string | null) => void;
  selectWarning: (cue: TransitionCue) => void;
  commitAnchorResolution: (payload: CommitAnchorResolutionPayload) => void;
  undo: (xmlDeps?: XmlDomDeps) => void;
  redo: (xmlDeps?: XmlDomDeps) => void;
  reset: () => void;
}

export function computeNoteDiff(
  noteEvents: NoteEvent[],
  beforeMap: Record<string, Finger>,
  afterMap: Record<string, Finger>
): NoteDiffEntry[] {
  const diffs: NoteDiffEntry[] = [];
  for (const note of noteEvents) {
    if (note.isTieStop) continue;
    const before = beforeMap[note.noteUid];
    const after = afterMap[note.noteUid];
    if (before !== after) {
      diffs.push({
        noteUid: note.noteUid,
        measureIndex: note.measureIndex,
        pitchLabel: midiToPitchLabel(note.midi),
        hand: note.hand,
        before,
        after,
      });
    }
  }
  return diffs;
}

export function computeNextAnchorState(
  anchors: Record<string, AnchorOverride>,
  removedRawAnchorUids: string[],
  targetNote: NoteEvent | undefined,
  override: AnchorOverride | null
): { anchors: Record<string, AnchorOverride>; removedRawAnchorUids: string[] } {
  if (!targetNote) {
    return { anchors: { ...anchors }, removedRawAnchorUids: [...removedRawAnchorUids] };
  }
  const nextAnchors = { ...anchors };
  const removedSet = new Set(removedRawAnchorUids);

  if (override === null) {
    delete nextAnchors[targetNote.noteUid];
    if (targetNote.anchorFinger !== undefined && targetNote.anchorRawPreserved) {
      removedSet.add(targetNote.noteUid);
    }
  } else {
    nextAnchors[targetNote.noteUid] = override;
    removedSet.delete(targetNote.noteUid);
  }

  return {
    anchors: nextAnchors,
    removedRawAnchorUids: Array.from(removedSet),
  };
}

function buildForceWriteUids(
  anchors: Record<string, AnchorOverride>,
  removedRawAnchorUids: string[],
  extraUids: string[] = []
): Set<string> {
  return new Set([
    ...Object.keys(anchors),
    ...removedRawAnchorUids,
    ...extraUids,
  ]);
}

function syncXmlOutput(
  scoreDoc: ScoreDocument,
  fingerByNoteUid: Record<string, Finger>,
  anchors: Record<string, AnchorOverride>,
  removedRawAnchorUids: string[],
  ignoreExistingFingerings: boolean,
  extraForceUids: string[] = [],
  xmlDeps?: XmlDomDeps
): string {
  writeFingeringsToScore(scoreDoc, fingerByNoteUid, {
    ignoreExistingFingerings,
    forceWriteNoteUids: buildForceWriteUids(anchors, removedRawAnchorUids, extraForceUids),
  });
  return serializeScoreDocument(scoreDoc, xmlDeps);
}

function createSnapshot(state: StudioState): StudioSnapshot | null {
  if (!state.solveResult) return null;
  return {
    anchors: { ...state.anchors },
    removedRawAnchorUids: [...state.removedRawAnchorUids],
    solveResult: state.solveResult,
    fingerByNoteUid: { ...state.fingerByNoteUid },
    lastDiff: [...state.lastDiff],
  };
}

function findSliceIdForNote(scoreDoc: ScoreDocument, note: NoteEvent): string | null {
  if (!note.isTieStop) {
    const direct = scoreDoc.onsetSlices.find((s) =>
      s.notes.some((n) => n.noteUid === note.noteUid)
    );
    if (direct) return direct.sliceId;
  }
  if (note.tieChainRootUid) {
    const rootSlice = scoreDoc.onsetSlices.find((s) =>
      s.notes.some((n) => n.noteUid === note.tieChainRootUid)
    );
    if (rootSlice) return rootSlice.sliceId;
  }
  const measureSlice = scoreDoc.onsetSlices.find(
    (s) => s.measureIndex === note.measureIndex && s.hand === note.hand
  );
  return measureSlice?.sliceId ?? null;
}

const INITIAL_DATA = {
  fileName: "",
  scoreTitle: "",
  rawXmlText: null as string | null,
  mxlContainer: undefined as MxlContainer | undefined,
  exportFormat: "musicxml" as ExportFormat,
  isSingleStaff: false,
  singleStaffHand: "RH" as Hand,
  handSpanProfile: DEFAULT_HAND_SPAN_PROFILE,
  ignoreExistingFingerings: false,
  scoreDoc: null as ScoreDocument | null,
  renderedXml: null as string | null,
  solveResult: null as SolveResult | null,
  fingerByNoteUid: {} as Record<string, Finger>,
  anchors: {} as Record<string, AnchorOverride>,
  removedRawAnchorUids: [] as string[],
  lastDiff: [] as NoteDiffEntry[],
  history: {
    past: [] as StudioSnapshot[],
    future: [] as StudioSnapshot[],
  },
  selectedNoteUid: null as string | null,
  selectedSliceId: null as string | null,
  selectedMeasureIndex: null as number | null,
  status: "Ready",
  errorMsg: null as string | null,
};

const createStudioStateCreator: StateCreator<StudioState> = (set, get) => ({
  ...INITIAL_DATA,

  setExportFormat: (exportFormat) => set({ exportFormat }),
  setSingleStaffHand: (singleStaffHand) => set({ singleStaffHand }),
  setHandSpanProfile: (handSpanProfile) => set({ handSpanProfile }),
  setIgnoreExistingFingerings: (ignoreExistingFingerings) => set({ ignoreExistingFingerings }),
  setStatus: (status) => set({ status }),
  setErrorMsg: (errorMsg) => set({ errorMsg }),

  clearScoreErrorState: (errorMsg, status = "Unsupported or invalid score") =>
    set({
      rawXmlText: null,
      mxlContainer: undefined,
      isSingleStaff: false,
      renderedXml: null,
      scoreDoc: null,
      solveResult: null,
      fingerByNoteUid: {},
      anchors: {},
      removedRawAnchorUids: [],
      lastDiff: [],
      history: { past: [], future: [] },
      selectedNoteUid: null,
      selectedSliceId: null,
      selectedMeasureIndex: null,
      scoreTitle: "",
      errorMsg,
      status,
    }),

  setSolvedScore: ({
    scoreDoc,
    rawXmlText,
    mxlContainer,
    fileName,
    exportFormat,
    solveResult,
    resetHistory = false,
    xmlDeps,
  }) => {
    const state = get();
    const nextAnchors = resetHistory ? {} : state.anchors;
    const nextRemoved = resetHistory ? [] : state.removedRawAnchorUids;
    const nextHistory = resetHistory ? { past: [], future: [] } : state.history;
    const nextDiff = resetHistory ? [] : state.lastDiff;

    const exportedXml = syncXmlOutput(
      scoreDoc,
      solveResult.fingerByNoteUid,
      nextAnchors,
      nextRemoved,
      state.ignoreExistingFingerings,
      [],
      xmlDeps
    );

    const preservedSlice =
      !resetHistory && state.selectedSliceId !== null
        ? scoreDoc.onsetSlices.find((s) => s.sliceId === state.selectedSliceId)
        : undefined;
    const nextSlice = preservedSlice ?? scoreDoc.onsetSlices[0] ?? null;
    const preservedNote =
      !resetHistory && state.selectedNoteUid !== null
        ? scoreDoc.noteEvents.find((n) => n.noteUid === state.selectedNoteUid)
        : undefined;
    const nextNote = preservedNote ?? nextSlice?.notes[0] ?? null;

    set({
      fileName,
      scoreTitle: scoreDoc.title,
      rawXmlText,
      mxlContainer,
      exportFormat,
      isSingleStaff: scoreDoc.isSingleStaff,
      singleStaffHand: scoreDoc.defaultSingleStaffHand,
      scoreDoc,
      solveResult,
      fingerByNoteUid: { ...solveResult.fingerByNoteUid },
      anchors: nextAnchors,
      removedRawAnchorUids: nextRemoved,
      lastDiff: nextDiff,
      history: nextHistory,
      selectedSliceId: nextSlice?.sliceId ?? null,
      selectedMeasureIndex: nextSlice?.measureIndex ?? null,
      selectedNoteUid: nextNote?.noteUid ?? null,
      renderedXml: exportedXml,
      status: `Solved ${scoreDoc.noteEvents.length} notes in ${solveResult.solveTimeMs.toFixed(1)} ms`,
      errorMsg: null,
    });
  },

  selectNote: (noteUid) => {
    const { scoreDoc } = get();
    if (!scoreDoc) return;
    const note = scoreDoc.noteEvents.find((n) => n.noteUid === noteUid);
    if (!note) return;
    const sliceId = findSliceIdForNote(scoreDoc, note);
    set({
      selectedNoteUid: note.noteUid,
      selectedMeasureIndex: note.measureIndex,
      selectedSliceId: sliceId,
    });
  },

  selectSlice: (sliceId) => {
    const { scoreDoc } = get();
    if (!scoreDoc) {
      set({ selectedSliceId: sliceId });
      return;
    }
    const slice = scoreDoc.onsetSlices.find((s) => s.sliceId === sliceId);
    if (!slice) return;
    set({
      selectedSliceId: slice.sliceId,
      selectedMeasureIndex: slice.measureIndex,
      selectedNoteUid: slice.notes[0]?.noteUid ?? null,
    });
  },

  selectMeasure: (measureIndex, fallbackSliceId = null) => {
    const { scoreDoc } = get();
    const targetSlice =
      scoreDoc?.onsetSlices.find((s) => s.sliceId === fallbackSliceId) ??
      scoreDoc?.onsetSlices.find((s) => s.measureIndex === measureIndex) ??
      null;
    set({
      selectedMeasureIndex: measureIndex,
      selectedSliceId: targetSlice?.sliceId ?? fallbackSliceId,
      selectedNoteUid: targetSlice?.notes[0]?.noteUid ?? null,
    });
  },

  selectWarning: (cue) => {
    const { scoreDoc } = get();
    const slice = scoreDoc?.onsetSlices.find((s) => s.sliceId === cue.sliceId) ?? null;
    set({
      selectedSliceId: cue.sliceId,
      selectedMeasureIndex: cue.measureIndex,
      selectedNoteUid: slice?.notes[0]?.noteUid ?? null,
    });
  },

  commitAnchorResolution: ({ targetNoteUid, override, result, xmlDeps }) => {
    const state = get();
    const { scoreDoc } = state;
    if (!scoreDoc) return;

    const snapshot = createSnapshot(state);
    const targetNote = scoreDoc.noteEvents.find((n) => n.noteUid === targetNoteUid);
    const { anchors: nextAnchors, removedRawAnchorUids: nextRemoved } = computeNextAnchorState(
      state.anchors,
      state.removedRawAnchorUids,
      targetNote,
      override
    );

    const diff = computeNoteDiff(
      scoreDoc.noteEvents,
      state.fingerByNoteUid,
      result.fingerByNoteUid
    );

    const exportedXml = syncXmlOutput(
      scoreDoc,
      result.fingerByNoteUid,
      nextAnchors,
      nextRemoved,
      state.ignoreExistingFingerings,
      [targetNoteUid],
      xmlDeps
    );

    set({
      anchors: nextAnchors,
      removedRawAnchorUids: nextRemoved,
      solveResult: result,
      fingerByNoteUid: { ...result.fingerByNoteUid },
      lastDiff: diff,
      history: {
        past: snapshot ? [...state.history.past, snapshot] : state.history.past,
        future: [],
      },
      renderedXml: exportedXml,
      status: `Updated anchor (${diff.length} note${diff.length === 1 ? "" : "s"} changed in ${result.solveTimeMs.toFixed(1)} ms)`,
    });
  },

  undo: (xmlDeps) => {
    const state = get();
    const { scoreDoc, history } = state;
    if (!scoreDoc || history.past.length === 0) return;

    const previous = history.past[history.past.length - 1];
    const currentSnapshot = createSnapshot(state);
    const prevDiffUids = state.lastDiff.map((d) => d.noteUid);

    const exportedXml = syncXmlOutput(
      scoreDoc,
      previous.fingerByNoteUid,
      previous.anchors,
      previous.removedRawAnchorUids,
      state.ignoreExistingFingerings,
      prevDiffUids,
      xmlDeps
    );

    set({
      anchors: { ...previous.anchors },
      removedRawAnchorUids: [...previous.removedRawAnchorUids],
      solveResult: previous.solveResult,
      fingerByNoteUid: { ...previous.fingerByNoteUid },
      lastDiff: [...previous.lastDiff],
      history: {
        past: history.past.slice(0, -1),
        future: currentSnapshot ? [currentSnapshot, ...history.future] : history.future,
      },
      renderedXml: exportedXml,
      status: "Undid last fingering change",
    });
  },

  redo: (xmlDeps) => {
    const state = get();
    const { scoreDoc, history } = state;
    if (!scoreDoc || history.future.length === 0) return;

    const next = history.future[0];
    const currentSnapshot = createSnapshot(state);
    const nextDiffUids = next.lastDiff.map((d) => d.noteUid);

    const exportedXml = syncXmlOutput(
      scoreDoc,
      next.fingerByNoteUid,
      next.anchors,
      next.removedRawAnchorUids,
      state.ignoreExistingFingerings,
      nextDiffUids,
      xmlDeps
    );

    set({
      anchors: { ...next.anchors },
      removedRawAnchorUids: [...next.removedRawAnchorUids],
      solveResult: next.solveResult,
      fingerByNoteUid: { ...next.fingerByNoteUid },
      lastDiff: [...next.lastDiff],
      history: {
        past: currentSnapshot ? [...history.past, currentSnapshot] : history.past,
        future: history.future.slice(1),
      },
      renderedXml: exportedXml,
      status: "Redid fingering change",
    });
  },

  reset: () => set({ ...INITIAL_DATA, history: { past: [], future: [] } }),
});

export function createStudioStore() {
  return createStore<StudioState>(createStudioStateCreator);
}

export const useStudioStore = create<StudioState>(createStudioStateCreator);
