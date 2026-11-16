import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { DEFAULT_HAND_SPAN_PROFILE, type Hand, type SolveResult } from "./domain/types";
import type { MxlContainer } from "./musicxml/mxl";
import { parseMusicXml } from "./musicxml/parser";
import { exportScoreOutput, loadScoreInput, type ExportFormat } from "./musicxml/scoreSession";
import { serializeScoreDocument, writeFingeringsToScore } from "./musicxml/writer";
import { createSolverClient, SolverCancelledError, type SolverClient } from "./workers/solverClient";
import { ScoreViewer } from "./components/ScoreViewer";

export default function App() {
  const solverClientRef = useRef<SolverClient | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [scoreTitle, setScoreTitle] = useState<string>("");
  const [rawXmlText, setRawXmlText] = useState<string | null>(null);
  const [mxlContainer, setMxlContainer] = useState<MxlContainer | undefined>(undefined);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("musicxml");
  const [isSingleStaff, setIsSingleStaff] = useState<boolean>(false);
  const [singleStaffHand, setSingleStaffHand] = useState<Hand>("RH");
  const [ignoreExistingFingerings, setIgnoreExistingFingerings] = useState<boolean>(false);
  const [renderedXml, setRenderedXml] = useState<string | null>(null);
  const [solveResult, setSolveResult] = useState<SolveResult | null>(null);
  const [noteCount, setNoteCount] = useState<number>(0);
  const [status, setStatus] = useState<string>("Ready");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const client = createSolverClient();
    solverClientRef.current = client;
    return () => {
      client.dispose();
      solverClientRef.current = null;
    };
  }, []);

  const solveAndRender = async (
    scoreDoc: ReturnType<typeof parseMusicXml>,
    ignoreAnchors = ignoreExistingFingerings
  ) => {
    if (!solverClientRef.current) return;
    setScoreTitle(scoreDoc.title);
    setNoteCount(scoreDoc.noteEvents.length);
    setStatus("Solving fingerings in Web Worker...");

    const result = await solverClientRef.current.solve(
      scoreDoc.onsetSlices,
      DEFAULT_HAND_SPAN_PROFILE,
      { ignoreExistingFingerings: ignoreAnchors }
    );

    writeFingeringsToScore(scoreDoc, result.fingerByNoteUid, {
      ignoreExistingFingerings: ignoreAnchors,
    });
    const exportedXml = serializeScoreDocument(scoreDoc);

    setSolveResult(result);
    setRenderedXml(exportedXml);
    setStatus(`Solved ${scoreDoc.noteEvents.length} notes in ${result.solveTimeMs.toFixed(1)} ms`);
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

      await solveAndRender(session.scoreDoc, ignoreExistingFingerings);
    } catch (err) {
      if (err instanceof SolverCancelledError) {
        return;
      }
      setRawXmlText(null);
      setMxlContainer(undefined);
      setIsSingleStaff(false);
      setRenderedXml(null);
      setSolveResult(null);
      setScoreTitle("");
      setNoteCount(0);
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("Unsupported or invalid score");
    }
  };

  const handleSingleStaffHandToggle = async (nextHand: Hand) => {
    if (!rawXmlText || !isSingleStaff || nextHand === singleStaffHand) return;
    setErrorMsg(null);
    setSingleStaffHand(nextHand);
    try {
      const scoreDoc = parseMusicXml(rawXmlText, { singleStaffHandOverride: nextHand });
      await solveAndRender(scoreDoc, ignoreExistingFingerings);
    } catch (err) {
      if (err instanceof SolverCancelledError) {
        return;
      }
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("Error");
    }
  };

  const handleIgnoreExistingToggle = async (nextIgnore: boolean) => {
    setIgnoreExistingFingerings(nextIgnore);
    if (!rawXmlText) return;
    setErrorMsg(null);
    try {
      const scoreDoc = parseMusicXml(
        rawXmlText,
        isSingleStaff ? { singleStaffHandOverride: singleStaffHand } : undefined
      );
      await solveAndRender(scoreDoc, nextIgnore);
    } catch (err) {
      if (err instanceof SolverCancelledError) {
        return;
      }
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("Error");
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

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
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

            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
              <input
                type="checkbox"
                checked={ignoreExistingFingerings}
                onChange={(e) => void handleIgnoreExistingToggle(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900"
              />
              Ignore original fingerings
            </label>

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

      <main className="mx-auto max-w-6xl space-y-4 px-6 py-6">
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
            {noteCount > 0 && (
              <span>
                <strong>Notes:</strong> {noteCount}
              </span>
            )}
            {solveResult && (
              <span>
                <strong>Transitions:</strong> {solveResult.transitionCues.length}
              </span>
            )}
            {solveResult && solveResult.warnings.length > 0 && (
              <span className="text-red-600">
                <strong>Warnings:</strong> {solveResult.warnings.length}
              </span>
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

        <ScoreViewer xmlString={renderedXml} />
      </main>
    </div>
  );
}
