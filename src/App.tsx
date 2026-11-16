import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  DEFAULT_HAND_SPAN_PROFILE,
  type Hand,
  type HandSpanProfile,
  type ScoreDocument,
  type SolveResult,
  type SpanPreset,
  type TransitionCue,
} from "./domain/types";
import type { MxlContainer } from "./musicxml/mxl";
import { parseMusicXml } from "./musicxml/parser";
import { exportScoreOutput, loadScoreInput, type ExportFormat } from "./musicxml/scoreSession";
import { serializeScoreDocument, writeFingeringsToScore } from "./musicxml/writer";
import { createSolverClient, SolverCancelledError, type SolverClient } from "./workers/solverClient";
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
  const [fileName, setFileName] = useState<string>("");
  const [scoreTitle, setScoreTitle] = useState<string>("");
  const [rawXmlText, setRawXmlText] = useState<string | null>(null);
  const [mxlContainer, setMxlContainer] = useState<MxlContainer | undefined>(undefined);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("musicxml");
  const [isSingleStaff, setIsSingleStaff] = useState<boolean>(false);
  const [singleStaffHand, setSingleStaffHand] = useState<Hand>("RH");
  const [handSpanProfile, setHandSpanProfile] = useState<HandSpanProfile>(
    DEFAULT_HAND_SPAN_PROFILE
  );
  const [ignoreExistingFingerings, setIgnoreExistingFingerings] = useState<boolean>(false);
  const [renderedXml, setRenderedXml] = useState<string | null>(null);
  const [scoreDoc, setScoreDoc] = useState<ScoreDocument | null>(null);
  const [solveResult, setSolveResult] = useState<SolveResult | null>(null);
  const [selectedSliceId, setSelectedSliceId] = useState<string | null>(null);
  const [selectedMeasureIndex, setSelectedMeasureIndex] = useState<number | null>(null);
  const [status, setStatus] = useState<string>("Ready");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const client = solverClientFactory();
    solverClientRef.current = client;
    return () => {
      client.dispose();
      solverClientRef.current = null;
    };
  }, [solverClientFactory]);

  const solveAndRender = async (
    nextDoc: ScoreDocument,
    profile: HandSpanProfile,
    ignoreAnchors: boolean,
    resetSelection: boolean
  ) => {
    if (!solverClientRef.current) return;
    setScoreTitle(nextDoc.title);
    setStatus("Solving fingerings in Web Worker...");

    const result = await solverClientRef.current.solve(nextDoc.onsetSlices, profile, {
      ignoreExistingFingerings: ignoreAnchors,
    });

    writeFingeringsToScore(nextDoc, result.fingerByNoteUid, {
      ignoreExistingFingerings: ignoreAnchors,
    });
    const exportedXml = serializeScoreDocument(nextDoc);

    const preserved =
      !resetSelection && selectedSliceId !== null
        ? nextDoc.onsetSlices.find((s) => s.sliceId === selectedSliceId)
        : undefined;
    const nextSlice = preserved ?? nextDoc.onsetSlices[0] ?? null;

    setScoreDoc(nextDoc);
    setSolveResult(result);
    setSelectedSliceId(nextSlice?.sliceId ?? null);
    setSelectedMeasureIndex(nextSlice?.measureIndex ?? null);
    setRenderedXml(exportedXml);
    setStatus(`Solved ${nextDoc.noteEvents.length} notes in ${result.solveTimeMs.toFixed(1)} ms`);
  };

  const reSolveScore = async (
    xmlText: string,
    singleStaff: boolean,
    handOverride: Hand,
    profile: HandSpanProfile,
    ignoreAnchors: boolean
  ) => {
    setErrorMsg(null);
    try {
      const nextDoc = parseMusicXml(
        xmlText,
        singleStaff ? { singleStaffHandOverride: handOverride } : undefined
      );
      await solveAndRender(nextDoc, profile, ignoreAnchors, false);
    } catch (err) {
      if (err instanceof SolverCancelledError) {
        return;
      }
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("Error");
    }
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !solverClientRef.current) return;

    setErrorMsg(null);
    setStatus("Parsing MusicXML...");

    try {
      const isMxl = file.name.toLowerCase().endsWith(".mxl");
      const session = isMxl
        ? await loadScoreInput({ fileName: file.name, bytes: await file.arrayBuffer() })
        : await loadScoreInput({ fileName: file.name, text: await file.text() });

      setFileName(file.name);
      setRawXmlText(session.rawXmlText);
      setMxlContainer(session.mxlContainer);
      setExportFormat(session.sourceFormat);
      setIsSingleStaff(session.scoreDoc.isSingleStaff);
      setSingleStaffHand(session.scoreDoc.defaultSingleStaffHand);

      await solveAndRender(
        session.scoreDoc,
        handSpanProfile,
        ignoreExistingFingerings,
        true
      );
    } catch (err) {
      if (err instanceof SolverCancelledError) {
        return;
      }
      setRawXmlText(null);
      setMxlContainer(undefined);
      setIsSingleStaff(false);
      setRenderedXml(null);
      setScoreDoc(null);
      setSolveResult(null);
      setSelectedSliceId(null);
      setSelectedMeasureIndex(null);
      setScoreTitle("");
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("Unsupported or invalid score");
    }
  };

  const handleSingleStaffHandToggle = async (nextHand: Hand) => {
    if (!rawXmlText || !isSingleStaff || nextHand === singleStaffHand) return;
    setSingleStaffHand(nextHand);
    await reSolveScore(
      rawXmlText,
      isSingleStaff,
      nextHand,
      handSpanProfile,
      ignoreExistingFingerings
    );
  };

  const handleProfileChange = (nextProfile: HandSpanProfile) => {
    setHandSpanProfile(nextProfile);
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
    setIgnoreExistingFingerings(nextIgnore);
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
    const markers: AnchorMarkerInfo[] = [];
    for (const ev of noteEvents) {
      if (ev.anchorFinger === undefined) continue;
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
  }, [noteEvents, solveResult, ignoreExistingFingerings]);

  const handleSelectWarning = (cue: TransitionCue) => {
    setSelectedSliceId(cue.sliceId);
    setSelectedMeasureIndex(cue.measureIndex);
  };

  const handleSelectMeasure = (measureIndex: number) => {
    const summary = measureRisks.find((m) => m.measureIndex === measureIndex);
    setSelectedMeasureIndex(measureIndex);
    setSelectedSliceId(summary?.firstWarningSliceId ?? summary?.firstSliceId ?? null);
  };

  const handleSelectSlice = (sliceId: string) => {
    setSelectedSliceId(sliceId);
    const slice = onsetSlices.find((s) => s.sliceId === sliceId);
    if (slice) {
      setSelectedMeasureIndex(slice.measureIndex);
    }
  };

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

            <div className="flex items-center gap-1.5">
              <select
                aria-label="Export format"
                value={exportFormat}
                onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
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
              measureRisks={measureRisks}
              anchoredNotes={anchoredNotes}
              selectedMeasureIndex={selectedMeasureIndex}
              selectedSliceId={selectedSliceId}
              onSelectMeasure={handleSelectMeasure}
              rendererFactory={scoreRendererFactory}
            />
          </div>

          <InspectorPanel
            warnings={solveResult?.warnings ?? []}
            onsetSlices={onsetSlices}
            fingerByNoteUid={solveResult?.fingerByNoteUid ?? {}}
            handSpanProfile={handSpanProfile}
            selectedSliceId={selectedSliceId}
            selectedMeasureIndex={selectedMeasureIndex}
            ignoreExistingFingerings={ignoreExistingFingerings}
            hasScore={Boolean(renderedXml)}
            onSelectWarning={handleSelectWarning}
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
