import { useEffect, useRef, useState } from "react";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import type { Finger, Hand } from "../domain/types";
import { midiToPitchLabel } from "../solver/keyboard";
import {
  MarginRiskGutter,
  type MeasureGeometry,
  type MeasureRiskSummary,
} from "./MarginRiskGutter";

export interface AnchorMarkerInfo {
  noteUid: string;
  measureIndex: number;
  midi: number;
  hand: Hand;
  finger: Finger;
  isConflict: boolean;
}

export interface ScoreRendererHandle {
  render(xmlString: string): Promise<{
    measureCount: number;
    measureGeometry: MeasureGeometry[];
  }>;
  highlightMeasure(measureIndex: number | null): void;
  markAnchoredNotes(anchors: AnchorMarkerInfo[]): void;
  scrollToMeasure(measureIndex: number, scrollContainer: HTMLElement | null): void;
  dispose(): void;
}

export type ScoreRendererFactory = (container: HTMLElement) => ScoreRendererHandle;

/**
 * Default OpenSheetMusicDisplay renderer adapter for measure geometry,
 * SVG measure highlighting, red anchor markers, and measure scrolling.
 */
export function createOsmdScoreRenderer(container: HTMLElement): ScoreRendererHandle {
  const osmd = new OpenSheetMusicDisplay(container, {
    autoResize: true,
    backend: "svg",
    drawFingerings: true,
    fingeringPosition: "aboveorbelow",
  });

  const getMeasureSvgElements = (measureIndex: number): SVGGElement[] => {
    const row = osmd.GraphicSheet?.MeasureList?.[measureIndex];
    if (!row) return [];
    const elements: SVGGElement[] = [];
    for (const gm of row) {
      const el = gm?.getSVGGElement?.();
      if (el) elements.push(el);
    }
    return elements;
  };

  const clearHighlights = () => {
    container
      .querySelectorAll("[data-studio-highlight='true']")
      .forEach((node) => node.remove());
    container
      .querySelectorAll("[data-active-measure]")
      .forEach((node) => node.removeAttribute("data-active-measure"));
  };

  const clearAnchorMarkers = () => {
    container
      .querySelectorAll("[data-studio-anchor-marker='true']")
      .forEach((node) => node.remove());
    container
      .querySelectorAll("[data-anchor-note]")
      .forEach((node) => node.removeAttribute("data-anchor-note"));
  };

  const extractMeasureGeometry = (): MeasureGeometry[] => {
    const measureList = osmd.GraphicSheet?.MeasureList;
    if (!measureList || measureList.length === 0) return [];
    const containerRect = container.getBoundingClientRect();
    const geometry: MeasureGeometry[] = [];

    for (let m = 0; m < measureList.length; m++) {
      const els = getMeasureSvgElements(m);
      if (els.length === 0) continue;
      let minTop = Infinity;
      let maxBottom = -Infinity;
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.height <= 0) continue;
        const relTop = rect.top - containerRect.top + container.scrollTop;
        minTop = Math.min(minTop, relTop);
        maxBottom = Math.max(maxBottom, relTop + rect.height);
      }
      if (Number.isFinite(minTop) && maxBottom > minTop) {
        geometry.push({
          measureIndex: m,
          top: minTop,
          height: maxBottom - minTop,
        });
      }
    }
    return geometry;
  };

  return {
    async render(xmlString: string) {
      await osmd.load(xmlString);
      osmd.render();
      const measureList = osmd.GraphicSheet?.MeasureList ?? [];
      return {
        measureCount: measureList.length,
        measureGeometry: extractMeasureGeometry(),
      };
    },

    highlightMeasure(measureIndex: number | null) {
      clearHighlights();
      if (measureIndex === null) return;
      const els = getMeasureSvgElements(measureIndex);
      for (const g of els) {
        g.setAttribute("data-active-measure", "true");
        if (typeof g.getBBox === "function") {
          try {
            const box = g.getBBox();
            const svgNs = "http://www.w3.org/2000/svg";
            const rect = container.ownerDocument.createElementNS(svgNs, "rect");
            rect.setAttribute("data-studio-highlight", "true");
            rect.setAttribute("x", String(box.x - 4));
            rect.setAttribute("y", String(box.y - 6));
            rect.setAttribute("width", String(Math.max(12, box.width + 8)));
            rect.setAttribute("height", String(Math.max(24, box.height + 12)));
            rect.setAttribute("rx", "6");
            rect.setAttribute("fill", "rgba(37, 99, 235, 0.08)");
            rect.setAttribute("stroke", "#2563eb");
            rect.setAttribute("stroke-width", "1.5");
            rect.setAttribute("stroke-dasharray", "4,3");
            g.insertBefore(rect, g.firstChild);
          } catch {
            // SVG getBBox unavailable in non-layout environments
          }
        }
      }
    },

    markAnchoredNotes(anchors: AnchorMarkerInfo[]) {
      clearAnchorMarkers();
      const measureList = osmd.GraphicSheet?.MeasureList;
      if (!measureList || anchors.length === 0) return;

      const anchorsByMeasure = new Map<number, AnchorMarkerInfo[]>();
      for (const anchor of anchors) {
        const list = anchorsByMeasure.get(anchor.measureIndex) ?? [];
        list.push(anchor);
        anchorsByMeasure.set(anchor.measureIndex, list);
      }

      for (const [mIdx, measureAnchors] of anchorsByMeasure.entries()) {
        const row = measureList[mIdx];
        if (!row) continue;
        const unmatched = [...measureAnchors];

        for (const gm of row) {
          for (const staffEntry of gm?.staffEntries ?? []) {
            for (const gve of staffEntry?.graphicalVoiceEntries ?? []) {
              for (const gNote of gve?.notes ?? []) {
                const pitch = gNote?.sourceNote?.Pitch;
                if (!pitch) continue;
                const midi = pitch.getHalfTone() + 12;
                const matchIdx = unmatched.findIndex((a) => a.midi === midi);
                if (matchIdx === -1) continue;
                const matched = unmatched.splice(matchIdx, 1)[0];
                const noteSvg = (gNote as { getSVGGElement?: () => SVGGElement | undefined }).getSVGGElement?.();
                if (!noteSvg) continue;

                noteSvg.setAttribute("data-anchor-note", matched.noteUid);
                if (typeof noteSvg.getBBox === "function") {
                  try {
                    const box = noteSvg.getBBox();
                    const svgNs = "http://www.w3.org/2000/svg";
                    const dot = container.ownerDocument.createElementNS(svgNs, "circle");
                    dot.setAttribute("data-studio-anchor-marker", "true");
                    dot.setAttribute("cx", String(box.x + box.width / 2));
                    dot.setAttribute("cy", String(box.y - 6));
                    dot.setAttribute("r", "4");
                    dot.setAttribute("fill", "#dc2626");
                    dot.setAttribute("stroke", "#ffffff");
                    dot.setAttribute("stroke-width", "1.2");
                    noteSvg.appendChild(dot);
                  } catch {
                    // ignore non-layout SVG
                  }
                }
              }
            }
          }
        }
      }
    },

    scrollToMeasure(measureIndex: number, scrollContainer: HTMLElement | null) {
      const els = getMeasureSvgElements(measureIndex);
      const target = els[0];
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const fallback = scrollContainer?.querySelector<HTMLElement>(
        `[data-score-measure-anchor="${measureIndex}"]`
      );
      if (fallback && typeof fallback.scrollIntoView === "function") {
        fallback.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    },

    dispose() {
      clearHighlights();
      clearAnchorMarkers();
      container.innerHTML = "";
    },
  };
}

export interface ScoreViewerProps {
  xmlString: string | null;
  measureRisks?: MeasureRiskSummary[];
  anchoredNotes?: AnchorMarkerInfo[];
  selectedMeasureIndex?: number | null;
  selectedSliceId?: string | null;
  onSelectMeasure?: (measureIndex: number) => void;
  rendererFactory?: ScoreRendererFactory;
}

/**
 * Renders the MusicXML score canvas via OSMD paired with the left-edge MarginRiskGutter,
 * anchor indicators, active measure highlights, and scroll-to-measure support.
 */
export function ScoreViewer({
  xmlString,
  measureRisks = [],
  anchoredNotes = [],
  selectedMeasureIndex = null,
  selectedSliceId = null,
  onSelectMeasure,
  rendererFactory = createOsmdScoreRenderer,
}: ScoreViewerProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const osmdContainerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ScoreRendererHandle | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [measureGeometry, setMeasureGeometry] = useState<MeasureGeometry[]>([]);
  const [isRendered, setIsRendered] = useState<boolean>(false);

  useEffect(() => {
    const container = osmdContainerRef.current;
    if (!container || !xmlString) {
      rendererRef.current?.dispose();
      rendererRef.current = null;
      if (container) container.innerHTML = "";
      setMeasureGeometry([]);
      setIsRendered(false);
      return;
    }

    let cancelled = false;
    setRenderError(null);
    setIsRendered(false);

    const renderScore = async () => {
      try {
        if (!rendererRef.current) {
          rendererRef.current = rendererFactory(container);
        }
        const info = await rendererRef.current.render(xmlString);
        if (!cancelled) {
          setMeasureGeometry(info.measureGeometry);
          setIsRendered(true);
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
  }, [xmlString, rendererFactory]);

  useEffect(() => {
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [rendererFactory]);

  useEffect(() => {
    if (!isRendered || !rendererRef.current) return;
    rendererRef.current.markAnchoredNotes(anchoredNotes);
  }, [isRendered, anchoredNotes]);

  useEffect(() => {
    if (!isRendered || !rendererRef.current) return;
    rendererRef.current.highlightMeasure(selectedMeasureIndex);
    if (selectedMeasureIndex !== null) {
      rendererRef.current.scrollToMeasure(selectedMeasureIndex, scrollContainerRef.current);
    }
  }, [isRendered, selectedMeasureIndex]);

  if (!xmlString) {
    return (
      <div
        data-testid="score-viewer"
        className="flex min-h-80 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-500"
      >
        Upload a <code>.musicxml</code>, <code>.xml</code>, or <code>.mxl</code> file to deduce and preview piano fingerings.
      </div>
    );
  }

  return (
    <div
      data-testid="score-viewer"
      data-active-measure={selectedMeasureIndex !== null ? String(selectedMeasureIndex) : undefined}
      data-selected-slice={selectedSliceId ?? undefined}
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-slate-600">
          <span className="font-semibold text-slate-800">Score Canvas</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800">
            <span className="h-2 w-2 rounded-full bg-amber-400" />
            Warn
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] text-red-700">
            <span className="h-2 w-2 rounded-full bg-red-500" />
            Danger
          </span>
        </div>

        {selectedMeasureIndex !== null && (
          <span
            data-testid="active-measure-badge"
            className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 font-semibold text-blue-700"
          >
            Active: m.{selectedMeasureIndex + 1}
          </span>
        )}
      </div>

      {anchoredNotes.length > 0 && (
        <div
          data-testid="anchor-indicators"
          className="mb-3 flex flex-wrap items-center gap-1.5 rounded-lg border border-red-100 bg-red-50/50 px-3 py-2 text-xs"
        >
          <span className="font-semibold text-red-700">
            Anchors ({anchoredNotes.length}):
          </span>
          {anchoredNotes.map((anchor) => (
            <button
              key={anchor.noteUid}
              type="button"
              data-anchor-note-uid={anchor.noteUid}
              onClick={() => onSelectMeasure?.(anchor.measureIndex)}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition ${
                anchor.isConflict
                  ? "border-red-400 bg-red-100 text-red-800"
                  : "border-red-200 bg-white text-red-700 hover:bg-red-50"
              }`}
              title={`Finger anchor ${anchor.finger} on ${midiToPitchLabel(anchor.midi)} in measure ${anchor.measureIndex + 1}`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-red-600" />
              <span>
                m.{anchor.measureIndex + 1} {midiToPitchLabel(anchor.midi)} ({anchor.hand}): {anchor.finger}
              </span>
            </button>
          ))}
        </div>
      )}

      {renderError && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Render error: {renderError}
        </div>
      )}

      <div className="flex items-start gap-2.5">
        {measureRisks.length > 0 && (
          <MarginRiskGutter
            measures={measureRisks}
            selectedMeasureIndex={selectedMeasureIndex}
            measureGeometry={measureGeometry}
            onSelectMeasure={(m) => onSelectMeasure?.(m)}
          />
        )}

        <div
          ref={scrollContainerRef}
          data-testid="score-scroll-container"
          className="relative max-h-[75vh] min-w-0 flex-1 overflow-auto rounded-lg border border-slate-100"
        >
          <div ref={osmdContainerRef} className="w-full" />
        </div>
      </div>
    </div>
  );
}
