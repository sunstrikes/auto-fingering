import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  type AnchorOverride,
  type AnchorOverrideMode,
  type Finger,
  type Hand,
  type HandSpanProfile,
  type ScoreDocument,
  type SpanPreset,
  type TransitionCue,
} from "./domain/types";
import type { MxlContainer } from "./musicxml/mxl";
import { parseMusicXml } from "./musicxml/parser";
import { exportScoreOutput, loadScoreInput, type ExportFormat } from "./musicxml/scoreSession";
import { applyAnchorOverridesToSlices, localResolveFingering } from "./solver/localResolve";
import { createSolverClient, SolverCancelledError, type SolverClient } from "./workers/solverClient";
import { computeNextAnchorState, useStudioStore } from "./store/useStudioStore";
import { buildMeasureRiskSummaries } from "./components/MarginRiskGutter";
import { InspectorPanel } from "./components/InspectorPanel";
import { DualTrackKeyboard } from "./components/DualTrackKeyboard";
import {
  ScoreViewer,
  type AnchorMarkerInfo,
  type ScoreRendererFactory,
} from "./components/ScoreViewer";

const SPAN_PRESETS: Array<{ preset: SpanPreset; title: string }> = [
  { preset: "S", title: "Small hand span (0.82x)" },
  { preset: "M", title: "Medium hand span (1.00x)" },
  { preset: "L", title: "Large hand span (1.18x)" },
];

function countMeasuresInScoreDoc(doc: ScoreDocument): number {
  const firstPart = doc.xmlDoc.getElementsByTagName("part")[0];
  if (firstPart) {
    let count = 0;
    for (let i = 0; i < firstPart.children.length; i++) {
      const child = firstPart.children[i];
      if (child.localName === "measure" || child.tagName === "measure") {
        count++;
      }
    }
    if (count > 0) return count;
  }
  const maxIdx = doc.noteEvents.reduce((max, n) => Math.max(max, n.measureIndex), -1);
  return maxIdx + 1;
}

export interface AppProps {
  solverClientFactory?: () => SolverClient;
  scoreRendererFactory?: ScoreRendererFactory;
}

export default function App({
  solverClientFactory = createSolverClient,
  scoreRendererFactory,
}: AppProps) {
  const solverClientRef = useRef<SolverClient | null>(null);
  const [isResolving, setIsResolving] = useState<boolean>(false);

  const fileName = useStudioStore((s) => s.fileName);
  const scoreTitle = useStudioStore((s) => s.scoreTitle);
  const rawXmlText = useStudioStore((s) => s.rawXmlText);
  const mxlContainer = useStudioStore((s) => s.mxlContainer);
  const exportFormat = useStudioStore((s) => s.exportFormat);
  const isSingleStaff = useStudioStore((s) => s.isSingleStaff);
  const singleStaffHand = useStudioStore((s) => s.singleStaffHand);
  const handSpanProfile = useStudioStore((s) => s.handSpanProfile);
  const ignoreExistingFingerings = useStudioStore((s) => s.ignoreExistingFingerings);
  const scoreDoc = useStudioStore((s) => s.scoreDoc);
  const renderedXml = useStudioStore((s) => s.renderedXml);
  const solveResult = useStudioStore((s) => s.solveResult);
  const fingerByNoteUid = useStudioStore((s) => s.fingerByNoteUid);
  const anchors = useStudioStore((s) => s.anchors);
  const removedRawAnchorUids = useStudioStore((s) => s.removedRawAnchorUids);
  const lastDiff = useStudioStore((s) => s.lastDiff);
  const history = useStudioStore((s) => s.history);
  const selectedNoteUid = useStudioStore((s) => s.selectedNoteUid);
  const selectedSliceId = useStudioStore((s) => s.selectedSliceId);
  const selectedMeasureIndex = useStudioStore((s) => s.selectedMeasureIndex);
  const status = useStudioStore((s) => s.status);
  const errorMsg = useStudioStore((s) => s.errorMsg);

  useEffect(() => {
    const client = solverClientFactory();
    solverClientRef.current = client;
    return () => {
      client.dispose();
      solverClientRef.current = null;
    };
  }, [solverClientFactory]);

  useEffect(() => {
    return () => {
      useStudioStore.getState().reset();
    };
  }, []);

  const solveAndRender = async (
    nextDoc: ScoreDocument,
    nextRawXml: string,
    nextFileName: string,
    nextFormat: ExportFormat,
    nextMxl: MxlContainer | undefined,
    profile: HandSpanProfile,
    ignoreAnchors: boolean,
    resetHistory: boolean
  ) => {
    if (!solverClientRef.current) return;
    const store = useStudioStore.getState();
    store.setStatus("Solving fingerings in Web Worker...");

    const slicesToSolve = resetHistory
      ? nextDoc.onsetSlices
      : applyAnchorOverridesToSlices(
          nextDoc.onsetSlices,
          store.anchors,
          store.removedRawAnchorUids,
          ignoreAnchors
        );

    const result = await solverClientRef.current.solve(slicesToSolve, profile, {
      ignoreExistingFingerings: resetHistory ? ignoreAnchors : false,
    });

    store.setSolvedScore({
      scoreDoc: nextDoc,
      rawXmlText: nextRawXml,
      mxlContainer: nextMxl,
      fileName: nextFileName,
      exportFormat: nextFormat,
      solveResult: result,
      resetHistory,
    });
  };

  const reSolveScore = async (
    xmlText: string,
    singleStaff: boolean,
    handOverride: Hand,
    profile: HandSpanProfile,
    ignoreAnchors: boolean
  ) => {
    const store = useStudioStore.getState();
    store.setErrorMsg(null);
    try {
      const nextDoc = parseMusicXml(
        xmlText,
        singleStaff ? { singleStaffHandOverride: handOverride } : undefined
      );
      await solveAndRender(
        nextDoc,
        xmlText,
        store.fileName,
        store.exportFormat,
        store.mxlContainer,
        profile,
        ignoreAnchors,
        false
      );
    } catch (err) {
      if (err instanceof SolverCancelledError) {
        return;
      }
      store.setErrorMsg(err instanceof Error ? err.message : String(err));
      store.setStatus("Error");
    }
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !solverClientRef.current) return;

    const store = useStudioStore.getState();
    store.setErrorMsg(null);
    store.setStatus("Parsing MusicXML...");

    try {
      const isMxl = file.name.toLowerCase().endsWith(".mxl");
      const session = isMxl
        ? await loadScoreInput({ fileName: file.name, bytes: await file.arrayBuffer() })
        : await loadScoreInput({ fileName: file.name, text: await file.text() });

      await solveAndRender(
        session.scoreDoc,
        session.rawXmlText,
        file.name,
        session.sourceFormat,
        session.mxlContainer,
        store.handSpanProfile,
        store.ignoreExistingFingerings,
        true
      );
    } catch (err) {
      if (err instanceof SolverCancelledError) {
        return;
      }
      store.clearScoreErrorState(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSingleStaffHandToggle = async (nextHand: Hand) => {
    if (!rawXmlText || !isSingleStaff || nextHand === singleStaffHand) return;
    useStudioStore.getState().setSingleStaffHand(nextHand);
    await reSolveScore(
      rawXmlText,
      isSingleStaff,
      nextHand,
      handSpanProfile,
      ignoreExistingFingerings
    );
  };

  const handleProfileChange = (nextProfile: HandSpanProfile) => {
    useStudioStore.getState().setHandSpanProfile(nextProfile);
    if (rawXmlText) {
      void reSolveScore(
        rawXmlText,
        isSingleStaff,
        singleStaffHand,
        nextProfile,
        ignoreExistingFingerings
      );
    }
  };

  const handleIgnoreExistingToggle = (nextIgnore: boolean) => {
    useStudioStore.getState().setIgnoreExistingFingerings(nextIgnore);
    if (rawXmlText) {
      void reSolveScore(
        rawXmlText,
        isSingleStaff,
        singleStaffHand,
        handSpanProfile,
        nextIgnore
      );
    }
  };

  const runLocalAnchorUpdate = async (
    noteUid: string,
    override: AnchorOverride | null
  ) => {
    const store = useStudioStore.getState();
    if (!store.scoreDoc || !solverClientRef.current) return;
    const targetNote = store.scoreDoc.noteEvents.find((n) => n.noteUid === noteUid);
    if (!targetNote || targetNote.isTieStop) return;

    const { anchors: nextAnchors, removedRawAnchorUids: nextRemoved } = computeNextAnchorState(
      store.anchors,
      store.removedRawAnchorUids,
      targetNote,
      override
    );

    setIsResolving(true);
    try {
      const input = {
        onsetSlices: store.scoreDoc.onsetSlices,
        profile: store.handSpanProfile,
        priorFingerByNoteUid: store.fingerByNoteUid,
        targetNoteUid: noteUid,
        override,
        anchors: nextAnchors,
        removedRawAnchorUids: nextRemoved,
        ignoreExistingFingerings: store.ignoreExistingFingerings,
      };
      const result = solverClientRef.current.resolveLocal
        ? await solverClientRef.current.resolveLocal(input)
        : localResolveFingering(input);

      useStudioStore.getState().commitAnchorResolution({
        targetNoteUid: noteUid,
        override,
        result,
      });
    } catch (err) {
      if (!(err instanceof SolverCancelledError)) {
        useStudioStore.getState().setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setIsResolving(false);
    }
  };

  const handleSetAnchor = (noteUid: string, finger: Finger, mode: AnchorOverrideMode) => {
    void runLocalAnchorUpdate(noteUid, { finger, mode });
  };

  const handleRemoveAnchor = (noteUid: string) => {
    void runLocalAnchorUpdate(noteUid, null);
  };

  const handleDownload = async () => {
    if (!renderedXml) return;
    const baseName = fileName.replace(/\.(musicxml|xml|mxl)$/i, "") || "score";
    const output = await exportScoreOutput(renderedXml, exportFormat, mxlContainer);
    const blobPart: BlobPart = output.bytes
      ? new Uint8Array(output.bytes)
      : output.text ?? renderedXml;
    const blob = new Blob([blobPart], { type: output.mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${baseName}-fingered.${output.extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const onsetSlices = scoreDoc?.onsetSlices ?? [];
  const noteEvents = scoreDoc?.noteEvents ?? [];
  const measureCount = useMemo(
    () => (scoreDoc ? countMeasuresInScoreDoc(scoreDoc) : 0),
    [scoreDoc]
  );

  const measureRisks = useMemo(
    () => buildMeasureRiskSummaries(measureCount, onsetSlices, solveResult?.warnings ?? []),
    [measureCount, onsetSlices, solveResult]
  );

  const anchoredNotes = useMemo<AnchorMarkerInfo[]>(() => {
    const repairedSet = new Set(solveResult?.repairedAnchorUids ?? []);
    const removedSet = new Set(removedRawAnchorUids);
    const markers: AnchorMarkerInfo[] = [];
    for (const ev of noteEvents) {
      if (ev.isTieStop) continue;
      const userAnc = anchors[ev.noteUid];
      if (userAnc) {
        markers.push({
          noteUid: ev.noteUid,
          measureIndex: ev.measureIndex,
          midi: ev.midi,
          hand: ev.hand,
          finger: userAnc.finger,
          isConflict: repairedSet.has(ev.noteUid),
        });
        continue;
      }
      if (ev.anchorFinger === undefined) continue;
      if (removedSet.has(ev.noteUid)) continue;
      if (ignoreExistingFingerings && ev.anchorRawPreserved) continue;
      markers.push({
        noteUid: ev.noteUid,
        measureIndex: ev.measureIndex,
        midi: ev.midi,
        hand: ev.hand,
        finger: ev.anchorFinger,
        isConflict: repairedSet.has(ev.noteUid),
      });
    }
    return markers;
  }, [noteEvents, solveResult, anchors, removedRawAnchorUids, ignoreExistingFingerings]);

  const handleSelectWarning = (cue: TransitionCue) => {
    useStudioStore.getState().selectWarning(cue);
  };

  const handleSelectMeasure = (measureIndex: number) => {
    const summary = measureRisks.find((m) => m.measureIndex === measureIndex);
    useStudioStore
      .getState()
      .selectMeasure(measureIndex, summary?.firstWarningSliceId ?? summary?.firstSliceId ?? null);
  };

  const handleSelectSlice = (sliceId: string) => {
    useStudioStore.getState().selectSlice(sliceId);
  };

  const handleSelectNote = (noteUid: string) => {
    useStudioStore.getState().selectNote(noteUid);
  };

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-slate-900">
              MusicXML Auto-Fingering
            </h1>
            <p className="text-xs text-slate-500">
              100% browser-local Beam Search DP piano fingering &amp; lossless MusicXML / .mxl export
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="cursor-pointer rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
              Upload .musicxml / .mxl
              <input
                type="file"
                accept=".musicxml,.xml,.mxl"
                className="hidden"
                onChange={handleFileChange}
              />
            </label>

            {isSingleStaff && (
              <div
                className="inline-flex rounded-lg border border-slate-300 bg-slate-100 p-0.5 text-xs font-medium"
                role="group"
                aria-label="Single-staff hand assignment"
              >
                <button
                  type="button"
                  onClick={() => void handleSingleStaffHandToggle("RH")}
                  className={`rounded-md px-3 py-1.5 transition ${
                    singleStaffHand === "RH"
                      ? "bg-white text-slate-900 shadow-xs"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  Right Hand
                </button>
                <button
                  type="button"
                  onClick={() => void handleSingleStaffHandToggle("LH")}
                  className={`rounded-md px-3 py-1.5 transition ${
                    singleStaffHand === "LH"
                      ? "bg-white text-slate-900 shadow-xs"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  Left Hand
                </button>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <div
                className="inline-flex rounded-lg border border-slate-300 bg-slate-100 p-0.5 text-xs font-medium"
                role="group"
                aria-label="Hand Span Profile"
              >
                {SPAN_PRESETS.map(({ preset, title }) => (
                  <button
                    key={preset}
                    type="button"
                    title={title}
                    aria-pressed={handSpanProfile.preset === preset}
                    onClick={() =>
                      handleProfileChange({ ...handSpanProfile, preset })
                    }
                    className={`rounded-md px-2.5 py-1.5 transition ${
                      handSpanProfile.preset === preset
                        ? "bg-white text-slate-900 shadow-xs"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>

              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={handSpanProfile.avoidThumbOnBlack}
                  onChange={(e) =>
                    handleProfileChange({
                      ...handSpanProfile,
                      avoidThumbOnBlack: e.target.checked,
                    })
                  }
                  className="rounded border-slate-300 text-slate-900"
                />
                Avoid thumb on black
              </label>

              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={handSpanProfile.preferStablePosition}
                  onChange={(e) =>
                    handleProfileChange({
                      ...handSpanProfile,
                      preferStablePosition: e.target.checked,
                    })
                  }
                  className="rounded border-slate-300 text-slate-900"
                />
                Prefer stable position
              </label>

              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={ignoreExistingFingerings}
                  onChange={(e) => handleIgnoreExistingToggle(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900"
                />
                Ignore original fingerings
              </label>
            </div>

            <div className="inline-flex items-center gap-1.5">
              <button
                type="button"
                data-testid="undo-btn"
                disabled={!canUndo}
                onClick={() => useStudioStore.getState().undo()}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Undo
              </button>
              <button
                type="button"
                data-testid="redo-btn"
                disabled={!canRedo}
                onClick={() => useStudioStore.getState().redo()}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Redo
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <select
                aria-label="Export format"
                value={exportFormat}
                onChange={(e) => useStudioStore.getState().setExportFormat(e.target.value as ExportFormat)}
                disabled={!renderedXml}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="musicxml">.musicxml</option>
                <option value="mxl">.mxl</option>
              </select>

              <button
                type="button"
                disabled={!renderedXml}
                onClick={() => void handleDownload()}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Download .{exportFormat}
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 px-6 py-6">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-600">
          <div className="flex items-center gap-4">
            <span>
              <strong>Status:</strong> {status}
            </span>
            {scoreTitle && (
              <span>
                <strong>Score:</strong> {scoreTitle}
              </span>
            )}
            {noteEvents.length > 0 && (
              <span>
                <strong>Notes:</strong> {noteEvents.length}
              </span>
            )}
            {solveResult && (
              <>
                <span>
                  <strong>Transitions:</strong> {solveResult.transitionCues.length}
                </span>
                <span className={solveResult.warnings.length > 0 ? "text-red-600" : undefined}>
                  <strong>Warnings:</strong> {solveResult.warnings.length}
                </span>
              </>
            )}
          </div>
          <span className="text-slate-400">Zero backend calls · Web Worker DP</span>
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            <strong>Unable to load score:</strong> {errorMsg}
          </div>
        )}

        <div
          data-testid="split-studio-workspace"
          className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,13fr)_minmax(320px,7fr)]"
        >
          <div className="min-w-0">
            <ScoreViewer
              xmlString={renderedXml}
              noteEvents={noteEvents}
              measureRisks={measureRisks}
              anchoredNotes={anchoredNotes}
              diffNotes={lastDiff}
              selectedMeasureIndex={selectedMeasureIndex}
              selectedSliceId={selectedSliceId}
              selectedNoteUid={selectedNoteUid}
              onSelectMeasure={handleSelectMeasure}
              onSelectNote={handleSelectNote}
              rendererFactory={scoreRendererFactory}
            />
          </div>

          <InspectorPanel
            warnings={solveResult?.warnings ?? []}
            onsetSlices={onsetSlices}
            noteEvents={noteEvents}
            fingerByNoteUid={fingerByNoteUid}
            handSpanProfile={handSpanProfile}
            selectedSliceId={selectedSliceId}
            selectedMeasureIndex={selectedMeasureIndex}
            selectedNoteUid={selectedNoteUid}
            anchors={anchors}
            removedRawAnchorUids={removedRawAnchorUids}
            lastDiff={lastDiff}
            canUndo={canUndo}
            canRedo={canRedo}
            isResolving={isResolving}
            ignoreExistingFingerings={ignoreExistingFingerings}
            hasScore={Boolean(renderedXml)}
            onSelectWarning={handleSelectWarning}
            onSelectNote={handleSelectNote}
            onSetAnchor={handleSetAnchor}
            onRemoveAnchor={handleRemoveAnchor}
            onUndo={() => useStudioStore.getState().undo()}
            onRedo={() => useStudioStore.getState().redo()}
          />
        </div>

        <DualTrackKeyboard
          scoreDoc={scoreDoc}
          solveResult={solveResult}
          selectedSliceId={selectedSliceId}
          onSelectSlice={handleSelectSlice}
        />
      </main>
    </div>
  );
}
