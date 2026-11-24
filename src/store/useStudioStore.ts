import { create, type StateCreator } from "zustand";
import { createStore } from "zustand/vanilla";
import {
  DEFAULT_HAND_SPAN_PROFILE,
  type AnchorOverride,
  type Finger,
  type Hand,
  type HandSpanProfile,
  type NoteEvent,
  type PriorMode,
  type ScoreDocument,
  type SolveResult,
  type TransitionCue,
} from "../domain/types";
import { DEFAULT_PRIOR_LAMBDA } from "../prior/types";
import type { MxlContainer } from "../musicxml/mxl";
import type { XmlDomDeps } from "../musicxml/parser";
import type { ExportFormat } from "../musicxml/scoreSession";
import { serializeScoreDocument, writeFingeringsToScore } from "../musicxml/writer";
import { remapAnchorState, type AnchorState } from "../persistence/anchorDrafts";
import { diffMeasureIndices, getScoreIdentity } from "../persistence/fingerprint";
import { midiToPitchLabel } from "../solver/keyboard";

export interface NoteDiffEntry {
  noteUid: string;
  measureIndex: number;
  midi: number;
  pitchLabel: string;
  hand: Hand;
  before: Finger | undefined;
  after: Finger | undefined;
}

export interface StudioSnapshot {
  rawXmlText?: string;
  scoreDoc?: ScoreDocument;
  anchors: Record<string, AnchorOverride>;
  removedRawAnchorUids: string[];
  solveResult: SolveResult;
  fingerByNoteUid: Record<string, Finger>;
  lastDiff: NoteDiffEntry[];
}

export interface ScoreRepairTransition {
  previousFingerprint: string;
  nextFingerprint: string;
  modifiedMeasureIndices: readonly number[];
}

export interface ApplyScoreRepairPayload {
  rawXmlText: string;
  scoreDoc: ScoreDocument;
  solveResult: SolveResult;
  anchors?: Record<string, AnchorOverride>;
  removedRawAnchorUids?: string[];
  repairSummary?: string;
  xmlDeps?: XmlDomDeps;
}

export interface SetSolvedScorePayload {
  scoreDoc: ScoreDocument;
  rawXmlText: string;
  mxlContainer?: MxlContainer;
  fileName: string;
  exportFormat: ExportFormat;
  solveResult: SolveResult;
  resetHistory?: boolean;
  restored?: AnchorState & { history?: StudioState["history"] };
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
  priorMode: PriorMode;
  priorLambda: number;
  customModelBaseUrl: string;
  scoreDoc: ScoreDocument | null;
  renderedXml: string | null;
  solveResult: SolveResult | null;
  fingerByNoteUid: Record<string, Finger>;
  anchors: Record<string, AnchorOverride>;
  removedRawAnchorUids: string[];
  lastDiff: NoteDiffEntry[];
  lastScoreRepairTransition: ScoreRepairTransition | null;
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
  setPriorMode: (priorMode: PriorMode) => void;
  setPriorLambda: (priorLambda: number) => void;
  setCustomModelBaseUrl: (customModelBaseUrl: string) => void;
  setStatus: (status: string) => void;
  setErrorMsg: (errorMsg: string | null) => void;
  clearScoreErrorState: (errorMsg: string, status?: string) => void;

  setSolvedScore: (payload: SetSolvedScorePayload) => void;
  selectNote: (noteUid: string) => void;
  selectSlice: (sliceId: string) => void;
  selectMeasure: (measureIndex: number, fallbackSliceId?: string | null) => void;
  selectWarning: (cue: TransitionCue) => void;
  commitAnchorResolution: (payload: CommitAnchorResolutionPayload) => void;
  applyScoreRepair: (payload: ApplyScoreRepairPayload) => void;
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
        midi: note.midi,
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
  removedRawAnchorUids: string[]
): Set<string> {
  return new Set([...Object.keys(anchors), ...removedRawAnchorUids]);
}

function syncXmlOutput(
  scoreDoc: ScoreDocument,
  fingerByNoteUid: Record<string, Finger>,
  anchors: Record<string, AnchorOverride>,
  removedRawAnchorUids: string[],
  ignoreExistingFingerings: boolean,
  xmlDeps?: XmlDomDeps
): string {
  writeFingeringsToScore(scoreDoc, fingerByNoteUid, {
    ignoreExistingFingerings,
    forceWriteNoteUids: buildForceWriteUids(anchors, removedRawAnchorUids),
  });
  return serializeScoreDocument(scoreDoc, xmlDeps);
}

function createSnapshot(state: StudioState, includeScore = false): StudioSnapshot | null {
  if (!state.solveResult) return null;
  return {
    ...(includeScore
      ? {
          rawXmlText: state.rawXmlText ?? undefined,
          scoreDoc: state.scoreDoc ?? undefined,
        }
      : {}),
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
  priorMode: "model-assist" as PriorMode,
  priorLambda: DEFAULT_PRIOR_LAMBDA,
  customModelBaseUrl: "",
  scoreDoc: null as ScoreDocument | null,
  renderedXml: null as string | null,
  solveResult: null as SolveResult | null,
  fingerByNoteUid: {} as Record<string, Finger>,
  anchors: {} as Record<string, AnchorOverride>,
  removedRawAnchorUids: [] as string[],
  lastDiff: [] as NoteDiffEntry[],
  lastScoreRepairTransition: null,
  history: {
    past: [] as StudioSnapshot[],
    future: [] as StudioSnapshot[],
  },
  selectedNoteUid: null as string | null,
  selectedSliceId: null as string | null,
  selectedMeasureIndex: null as number | null,
  status: "就绪",
  errorMsg: null as string | null,
};

const createStudioStateCreator: StateCreator<StudioState> = (set, get) => ({
  ...INITIAL_DATA,

  setExportFormat: (exportFormat) => set({ exportFormat }),
  setSingleStaffHand: (singleStaffHand) => set({ singleStaffHand }),
  setHandSpanProfile: (handSpanProfile) => set({ handSpanProfile }),
  setIgnoreExistingFingerings: (ignoreExistingFingerings) => set({ ignoreExistingFingerings }),
  setPriorMode: (priorMode) => set({ priorMode }),
  setPriorLambda: (priorLambda) => set({ priorLambda }),
  setCustomModelBaseUrl: (customModelBaseUrl) => set({ customModelBaseUrl }),
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
      lastScoreRepairTransition: null,
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
    restored,
    xmlDeps,
  }) => {
    const state = get();
    const nextAnchors = restored?.anchors ?? (resetHistory ? {} : state.anchors);
    const nextRemoved = restored?.removedRawAnchorUids ?? (resetHistory ? [] : state.removedRawAnchorUids);
    const nextHistory = restored?.history ?? (resetHistory ? { past: [], future: [] } : state.history);
    const nextDiff = resetHistory ? [] : state.lastDiff;

    const exportedXml = syncXmlOutput(
      scoreDoc,
      solveResult.fingerByNoteUid,
      nextAnchors,
      nextRemoved,
      state.ignoreExistingFingerings,
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
      ...(resetHistory ? { lastScoreRepairTransition: null } : {}),
      history: nextHistory,
      selectedSliceId: nextSlice?.sliceId ?? null,
      selectedMeasureIndex: nextSlice?.measureIndex ?? null,
      selectedNoteUid: nextNote?.noteUid ?? null,
      renderedXml: exportedXml,
      status: `已完成 ${scoreDoc.noteEvents.length} 个音符指法推导（耗时 ${solveResult.solveTimeMs.toFixed(1)} ms）`,
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
      status: `已更新锚点（${diff.length} 个音符指法变更，耗时 ${result.solveTimeMs.toFixed(1)} ms）`,
    });
  },

  applyScoreRepair: ({
    rawXmlText,
    scoreDoc,
    solveResult,
    anchors,
    removedRawAnchorUids,
    repairSummary,
    xmlDeps,
  }) => {
    const state = get();
    if (!state.scoreDoc || !state.solveResult) return;

    const snapshot = createSnapshot(state, true);
    const remapped = anchors !== undefined && removedRawAnchorUids !== undefined
      ? { anchors, removedRawAnchorUids } : remapAnchorState(state.scoreDoc, scoreDoc, state);
    const nextAnchors = anchors ?? remapped.anchors;
    const nextRemoved = removedRawAnchorUids ?? remapped.removedRawAnchorUids;
    const previousIdentity = getScoreIdentity(state.scoreDoc);
    const nextIdentity = getScoreIdentity(scoreDoc);

    const exportedXml = syncXmlOutput(
      scoreDoc,
      solveResult.fingerByNoteUid,
      nextAnchors,
      nextRemoved,
      state.ignoreExistingFingerings,
      xmlDeps
    );

    const fallbackSlice =
      (state.selectedMeasureIndex !== null
        ? scoreDoc.onsetSlices.find((s) => s.measureIndex === state.selectedMeasureIndex)
        : undefined) ??
      scoreDoc.onsetSlices[0] ??
      null;
    const preservedNote =
      state.selectedNoteUid !== null
        ? scoreDoc.noteEvents.find((n) => n.noteUid === state.selectedNoteUid)
        : undefined;
    const nextNote = preservedNote ?? fallbackSlice?.notes[0] ?? null;

    set({
      rawXmlText,
      scoreDoc,
      scoreTitle: scoreDoc.title,
      isSingleStaff: scoreDoc.isSingleStaff,
      singleStaffHand: scoreDoc.defaultSingleStaffHand,
      solveResult,
      fingerByNoteUid: { ...solveResult.fingerByNoteUid },
      anchors: nextAnchors,
      removedRawAnchorUids: nextRemoved,
      lastDiff: [],
      lastScoreRepairTransition: {
        previousFingerprint: previousIdentity.fingerprint,
        nextFingerprint: nextIdentity.fingerprint,
        modifiedMeasureIndices: diffMeasureIndices(previousIdentity.measureHashes, nextIdentity.measureHashes),
      },
      history: {
        past: snapshot ? [...state.history.past, snapshot] : state.history.past,
        future: [],
      },
      selectedSliceId: fallbackSlice?.sliceId ?? null,
      selectedMeasureIndex: fallbackSlice?.measureIndex ?? null,
      selectedNoteUid: nextNote?.noteUid ?? null,
      renderedXml: exportedXml,
      status: repairSummary
        ? `已应用乐谱修复（${repairSummary}）并重算指法（耗时 ${solveResult.solveTimeMs.toFixed(1)} ms）`
        : `已应用乐谱修复并重算指法（耗时 ${solveResult.solveTimeMs.toFixed(1)} ms）`,
      errorMsg: null,
    });
  },

  undo: (xmlDeps) => {
    const state = get();
    const { scoreDoc, history } = state;
    if (!scoreDoc || history.past.length === 0) return;

    const previous = history.past[history.past.length - 1];
    const includesScore = previous.scoreDoc !== undefined || previous.rawXmlText !== undefined;
    const currentSnapshot = createSnapshot(state, includesScore);
    const targetScoreDoc = previous.scoreDoc ?? scoreDoc;
    const targetRawXml = previous.rawXmlText ?? state.rawXmlText;

    const exportedXml = syncXmlOutput(
      targetScoreDoc,
      previous.fingerByNoteUid,
      previous.anchors,
      previous.removedRawAnchorUids,
      state.ignoreExistingFingerings,
      xmlDeps
    );

    const nextSelection = includesScore
      ? (() => {
          const fallbackSlice =
            (state.selectedMeasureIndex !== null
              ? targetScoreDoc.onsetSlices.find(
                  (s) => s.measureIndex === state.selectedMeasureIndex
                )
              : undefined) ??
            targetScoreDoc.onsetSlices[0] ??
            null;
          return {
            selectedSliceId: fallbackSlice?.sliceId ?? null,
            selectedMeasureIndex: fallbackSlice?.measureIndex ?? null,
            selectedNoteUid: fallbackSlice?.notes[0]?.noteUid ?? null,
          };
        })()
      : {};

    set({
      scoreDoc: targetScoreDoc,
      rawXmlText: targetRawXml,
      scoreTitle: targetScoreDoc.title,
      isSingleStaff: targetScoreDoc.isSingleStaff,
      singleStaffHand: targetScoreDoc.defaultSingleStaffHand,
      anchors: { ...previous.anchors },
      removedRawAnchorUids: [...previous.removedRawAnchorUids],
      solveResult: previous.solveResult,
      fingerByNoteUid: { ...previous.fingerByNoteUid },
      lastDiff: [...previous.lastDiff],
      history: {
        past: history.past.slice(0, -1),
        future: currentSnapshot ? [currentSnapshot, ...history.future] : history.future,
      },
      ...nextSelection,
      renderedXml: exportedXml,
      status: includesScore ? "已撤销乐谱修复" : "已撤销上一次指法修改",
    });
  },

  redo: (xmlDeps) => {
    const state = get();
    const { scoreDoc, history } = state;
    if (!scoreDoc || history.future.length === 0) return;

    const next = history.future[0];
    const includesScore = next.scoreDoc !== undefined || next.rawXmlText !== undefined;
    const currentSnapshot = createSnapshot(state, includesScore);
    const targetScoreDoc = next.scoreDoc ?? scoreDoc;
    const targetRawXml = next.rawXmlText ?? state.rawXmlText;

    const exportedXml = syncXmlOutput(
      targetScoreDoc,
      next.fingerByNoteUid,
      next.anchors,
      next.removedRawAnchorUids,
      state.ignoreExistingFingerings,
      xmlDeps
    );

    const nextSelection = includesScore
      ? (() => {
          const fallbackSlice =
            (state.selectedMeasureIndex !== null
              ? targetScoreDoc.onsetSlices.find(
                  (s) => s.measureIndex === state.selectedMeasureIndex
                )
              : undefined) ??
            targetScoreDoc.onsetSlices[0] ??
            null;
          return {
            selectedSliceId: fallbackSlice?.sliceId ?? null,
            selectedMeasureIndex: fallbackSlice?.measureIndex ?? null,
            selectedNoteUid: fallbackSlice?.notes[0]?.noteUid ?? null,
          };
        })()
      : {};

    set({
      scoreDoc: targetScoreDoc,
      rawXmlText: targetRawXml,
      scoreTitle: targetScoreDoc.title,
      isSingleStaff: targetScoreDoc.isSingleStaff,
      singleStaffHand: targetScoreDoc.defaultSingleStaffHand,
      anchors: { ...next.anchors },
      removedRawAnchorUids: [...next.removedRawAnchorUids],
      solveResult: next.solveResult,
      fingerByNoteUid: { ...next.fingerByNoteUid },
      lastDiff: [...next.lastDiff],
      history: {
        past: currentSnapshot ? [...history.past, currentSnapshot] : history.past,
        future: history.future.slice(1),
      },
      ...nextSelection,
      renderedXml: exportedXml,
      status: includesScore ? "已重做乐谱修复" : "已重做指法修改",
    });
  },

  reset: () => set({ ...INITIAL_DATA, history: { past: [], future: [] } }),
});

export function createStudioStore() {
  return createStore<StudioState>(createStudioStateCreator);
}

export const useStudioStore = create<StudioState>(createStudioStateCreator);
