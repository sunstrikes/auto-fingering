import { useEffect, useRef, useState } from "react";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

interface ScoreViewerProps {
  xmlString: string | null;
}

/**
 * Renders a MusicXML string using OpenSheetMusicDisplay with fingering labels enabled.
 */
export function ScoreViewer({ xmlString }: ScoreViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !xmlString) {
      if (container) container.innerHTML = "";
      return;
    }

    let cancelled = false;
    setRenderError(null);

    const renderScore = async () => {
      try {
        if (!osmdRef.current) {
          osmdRef.current = new OpenSheetMusicDisplay(container, {
            autoResize: true,
            backend: "svg",
            drawFingerings: true,
            fingeringPosition: "aboveorbelow",
          });
        }
        await osmdRef.current.load(xmlString);
        if (!cancelled) {
          osmdRef.current.render();
        }
      } catch (err) {
        if (!cancelled) {
          setRenderError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    void renderScore();

    return () => {
      cancelled = true;
    };
  }, [xmlString]);

  if (!xmlString) {
    return (
      <div className="flex min-h-80 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-500">
        Upload a <code>.musicxml</code>, <code>.xml</code>, or <code>.mxl</code> file to deduce and preview piano fingerings.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      {renderError && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Render error: {renderError}
        </div>
      )}
      <div ref={containerRef} className="w-full overflow-x-auto" />
    </div>
  );
}
