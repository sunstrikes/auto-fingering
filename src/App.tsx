import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { DEFAULT_HAND_SPAN_PROFILE, type SolveResult } from "./domain/types";
import { parseMusicXml } from "./musicxml/parser";
import { serializeScoreDocument, writeFingeringsToScore } from "./musicxml/writer";
import { createSolverClient, SolverCancelledError, type SolverClient } from "./workers/solverClient";
import { ScoreViewer } from "./components/ScoreViewer";

export default function App() {
  const solverClientRef = useRef<SolverClient | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [scoreTitle, setScoreTitle] = useState<string>("");
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

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !solverClientRef.current) return;

    setErrorMsg(null);
    setStatus("Parsing MusicXML...");

    try {
      const xmlText = await file.text();
      const scoreDoc = parseMusicXml(xmlText);
      setFileName(file.name);
      setScoreTitle(scoreDoc.title);
      setNoteCount(scoreDoc.noteEvents.length);

      setStatus("Solving fingerings in Web Worker...");
      const result = await solverClientRef.current.solve(
        scoreDoc.onsetSlices,
        DEFAULT_HAND_SPAN_PROFILE
      );

      writeFingeringsToScore(scoreDoc, result.fingerByNoteUid);
      const exportedXml = serializeScoreDocument(scoreDoc);

      setSolveResult(result);
      setRenderedXml(exportedXml);
      setStatus(`Solved ${scoreDoc.noteEvents.length} notes in ${result.solveTimeMs.toFixed(1)} ms`);
    } catch (err) {
      if (err instanceof SolverCancelledError) {
        return;
      }
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("Error");
    }
  };

  const handleDownload = () => {
    if (!renderedXml) return;
    const baseName = fileName.replace(/\.(musicxml|xml)$/i, "") || "score";
    const blob = new Blob([renderedXml], { type: "application/vnd.recordare.musicxml+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${baseName}-fingered.musicxml`;
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
              100% browser-local Beam Search DP piano fingering &amp; lossless MusicXML export
            </p>
          </div>

          <div className="flex items-center gap-3">
            <label className="cursor-pointer rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
              Upload .musicxml
              <input
                type="file"
                accept=".musicxml,.xml"
                className="hidden"
                onChange={handleFileChange}
              />
            </label>

            <button
              type="button"
              disabled={!renderedXml}
              onClick={handleDownload}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Download .musicxml
            </button>
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
          </div>
          <span className="text-slate-400">Zero backend calls · Web Worker DP</span>
        </div>

        {errorMsg && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorMsg}
          </div>
        )}

        <ScoreViewer xmlString={renderedXml} />
      </main>
    </div>
  );
}
