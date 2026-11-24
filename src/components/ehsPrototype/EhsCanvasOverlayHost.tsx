import { useCallback, useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import type { ScoreDocument } from "../../domain/types";
import type { ScoreLayoutMode } from "../ScoreViewer";
import { EhsAlignmentDebugLayer } from "./EhsAlignmentDebugLayer";
import { extractEhsOsmdGeometry, scoreBeatToCanvasPoint } from "./ehsOsmdGeometry";
import type {
  EhsConfig,
  EhsExtractedGeometry,
  EhsFrameSnapshot,
  EhsPerfMetrics,
  EhsVariantKey,
} from "./ehsPrototypeTypes";
import { EhsVariantA_BeatGate } from "./EhsVariantA_BeatGate";
import { EhsVariantB_PerNoteFade } from "./EhsVariantB_PerNoteFade";
import { EhsVariantC_SlidingCurtain } from "./EhsVariantC_SlidingCurtain";

export interface EhsCanvasOverlayHostProps {
  variant: EhsVariantKey;
  osmd: OpenSheetMusicDisplay | null;
  container: HTMLElement | null;
  scrollContainer: HTMLElement | null;
  isRendered: boolean;
  layoutMode: ScoreLayoutMode;
  scoreZoom: number;
  scoreDoc: ScoreDocument | null;
  isPlaying: boolean;
  geometry: EhsExtractedGeometry;
  snapshot: EhsFrameSnapshot;
  config: EhsConfig;
  onGeometryExtracted: (geo: EhsExtractedGeometry) => void;
  onPerfUpdate: (perf: EhsPerfMetrics) => void;
}

/**
 * Mounts inside `ScoreViewer`'s relative OSMD surface wrapper so all pixel coordinates stay
 * locked 1:1 with the rendered SVG in both `horizontal` and `page` layouts and across resizes/zoom.
 */
export function EhsCanvasOverlayHost({
  variant,
  osmd,
  container,
  scrollContainer,
  isRendered,
  layoutMode,
  scoreZoom,
  scoreDoc,
  isPlaying,
  geometry,
  snapshot,
  config,
  onGeometryExtracted,
  onPerfUpdate,
}: EhsCanvasOverlayHostProps) {
  const perfSamplesRef = useRef<number[]>([]);
  const lastPerfEmitRef = useRef<number>(0);
  const frameTimesRef = useRef<number[]>([]);

  // Extract OSMD geometry after render, zoom/layout switch, and whenever OSMD autoResizes in page mode
  useEffect(() => {
    if (!isRendered || !osmd || !container) return;

    let rafId = 0;
    const runExtract = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const extracted = extractEhsOsmdGeometry(osmd, container, scoreDoc, layoutMode);
        onGeometryExtracted(extracted);
      });
    };

    runExtract();

    if (typeof ResizeObserver === "undefined") {
      return () => cancelAnimationFrame(rafId);
    }

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      // Wait briefly for OSMD's own autoResize SVG pass to settle before re-extracting coordinates
      resizeTimer = setTimeout(runExtract, 180);
    });
    ro.observe(container);

    return () => {
      cancelAnimationFrame(rafId);
      if (resizeTimer) clearTimeout(resizeTimer);
      ro.disconnect();
    };
  }, [isRendered, osmd, container, scoreDoc, layoutMode, scoreZoom, onGeometryExtracted]);

  // Page-mode lookahead auto-scroll: ensure the NEXT system row containing `frontierBeat`
  // is scrolled into view BEFORE the pianist's hands reach the end of the current line!
  useEffect(() => {
    if (!isPlaying || !config.enabled || layoutMode !== "page" || !scrollContainer) return;
    const frontierPt = scoreBeatToCanvasPoint(geometry, Math.max(0, snapshot.frontierBeat));
    const sys = frontierPt?.system;
    if (!sys) return;

    const viewTop = scrollContainer.scrollTop;
    const viewBottom = viewTop + scrollContainer.clientHeight;
    if (sys.bottom + 24 > viewBottom) {
      const targetTop = Math.max(0, sys.top - scrollContainer.clientHeight * 0.48);
      scrollContainer.scrollTo({ top: targetTop, behavior: "smooth" });
    } else if (sys.top < viewTop + 12) {
      scrollContainer.scrollTo({ top: Math.max(0, sys.top - 24), behavior: "smooth" });
    }
  }, [isPlaying, config.enabled, layoutMode, scrollContainer, geometry, snapshot.frontierMeasureIndex]);

  const handleReportRenderCost = useCallback(
    (updateMs: number, mutatedNodes: number) => {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      perfSamplesRef.current.push(updateMs);
      if (perfSamplesRef.current.length > 20) perfSamplesRef.current.shift();

      frameTimesRef.current.push(now);
      while (frameTimesRef.current.length > 2 && now - frameTimesRef.current[0] > 1000) {
        frameTimesRef.current.shift();
      }

      if (now - lastPerfEmitRef.current > 250) {
        lastPerfEmitRef.current = now;
        const avg =
          perfSamplesRef.current.reduce((a, b) => a + b, 0) /
          Math.max(1, perfSamplesRef.current.length);
        const ft = frameTimesRef.current;
        const spanSec = ft.length >= 2 ? (ft[ft.length - 1] - ft[0]) / 1000 : 0;
        const fps =
          spanSec > 0.15 ? Math.min(120, Math.round((ft.length - 1) / spanSec)) : isPlaying ? 60 : 0;
        onPerfUpdate({
          fps,
          lastUpdateMs: Math.round(updateMs * 100) / 100,
          avgUpdateMs: Math.round(avg * 100) / 100,
          mutatedSvgNodes: mutatedNodes,
        });
      }
    },
    [isPlaying, onPerfUpdate]
  );

  if (!isRendered || geometry.measures.length === 0) return null;

  return (
    <>
      {variant === "A" && (
        <EhsVariantA_BeatGate
          geometry={geometry}
          snapshot={snapshot}
          config={config}
          onReportRenderCost={handleReportRenderCost}
        />
      )}
      {variant === "B" && (
        <EhsVariantB_PerNoteFade
          geometry={geometry}
          snapshot={snapshot}
          config={config}
          onReportRenderCost={handleReportRenderCost}
        />
      )}
      {variant === "C" && (
        <EhsVariantC_SlidingCurtain
          geometry={geometry}
          snapshot={snapshot}
          config={config}
          onReportRenderCost={handleReportRenderCost}
        />
      )}
      {config.showAlignmentDebug && (
        <EhsAlignmentDebugLayer geometry={geometry} snapshot={snapshot} />
      )}
    </>
  );
}
