import { useEffect, useRef } from "react";
import { scoreBeatToCanvasPoint } from "./ehsOsmdGeometry";
import type { EhsVariantOverlayProps } from "./EhsVariantA_BeatGate";

const FADE_WIDTH_BEATS = 0.85;

function easeOutQuad(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return 1 - (1 - c) * (1 - c);
}

/**
 * Variant B — 逐音渐隐消散 (Per-Note SVG Fade)
 *
 * Structurally zero overlay rectangles or curtains:
 * - Directly mutates `style.opacity` on individual OSMD/VexFlow SVG elements
 *   (noteheads, stems, beams, flags, ledger lines, ties, modifiers).
 * - Five-line staves, barlines, clefs, key signatures, and time signatures stay 100% crisp.
 * - Shared SVG elements (e.g. multi-note beams) take the MAX opacity across constituent notes
 *   so a beam never disappears prematurely while an upcoming beamed note is still visible.
 * - Notes matched by live MIDI NoteOn dissolve immediately alongside the lookahead frontier.
 */
export function EhsVariantB_PerNoteFade({
  geometry,
  snapshot,
  config,
  onReportRenderCost,
}: EhsVariantOverlayProps) {
  const lastOpacityByElRef = useRef<Map<Element, number>>(new Map());
  const touchedElementsRef = useRef<Set<Element>>(new Set());

  // Apply per-note SVG opacity directly without triggering React layout thrash
  useEffect(() => {
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const notes = geometry.notes;
    if (notes.length === 0) return;

    const targetOpacityByEl = new Map<Element, number>();
    const residual = Math.max(0, Math.min(0.25, config.ghostResidualOpacity));
    const struckUids = snapshot.telemetry.struckNoteUids;

    for (const note of notes) {
      let op = 1;
      if (snapshot.isMasked) {
        if (note.noteUid && struckUids.has(note.noteUid)) {
          op = residual;
        } else {
          const aheadBeats = note.scoreBeat - snapshot.frontierBeat;
          if (aheadBeats <= 0) {
            op = residual;
          } else if (aheadBeats < FADE_WIDTH_BEATS) {
            const ratio = easeOutQuad(aheadBeats / FADE_WIDTH_BEATS);
            op = residual + (1 - residual) * ratio;
          } else {
            op = 1;
          }
        }
      }
      const quantized = Math.round(op * 50) / 50; // 0.02 granularity reduces redundant style writes

      for (const el of note.svgElements) {
        const prev = targetOpacityByEl.get(el);
        if (prev === undefined || quantized > prev) {
          targetOpacityByEl.set(el, quantized);
        }
      }
    }

    let mutated = 0;
    const lastMap = lastOpacityByElRef.current;
    const touched = touchedElementsRef.current;

    for (const [el, nextOp] of targetOpacityByEl.entries()) {
      const prevOp = lastMap.get(el);
      if (prevOp !== nextOp) {
        const style = (el as SVGElement).style;
        if (style) {
          style.opacity = nextOp >= 0.99 ? "" : String(nextOp);
          style.transition = snapshot.isMasked ? "opacity 110ms linear" : "opacity 90ms ease-out";
          lastMap.set(el, nextOp);
          touched.add(el);
          mutated += 1;
        }
      }
    }

    const dt = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    onReportRenderCost?.(dt, mutated);
  }, [
    geometry,
    snapshot.frontierBeat,
    snapshot.isMasked,
    snapshot.telemetry.struckNoteUids,
    config.ghostResidualOpacity,
    onReportRenderCost,
  ]);

  // Guaranteed cleanup on unmount or when OSMD re-renders new SVG nodes
  useEffect(() => {
    const touched = touchedElementsRef.current;
    const lastMap = lastOpacityByElRef.current;
    return () => {
      for (const el of touched) {
        const style = (el as SVGElement).style;
        if (style) {
          style.opacity = "";
          style.transition = "";
        }
      }
      touched.clear();
      lastMap.clear();
    };
  }, [geometry]);

  const handPt = scoreBeatToCanvasPoint(geometry, Math.max(0, snapshot.handBeat));
  const frontierPt = scoreBeatToCanvasPoint(geometry, Math.max(0, snapshot.frontierBeat));
  const rescueMeasure =
    snapshot.peek.active && snapshot.peek.rescueMeasureIndex !== null
      ? geometry.measures.find((m) => m.measureIndex === snapshot.peek.rescueMeasureIndex) ?? null
      : null;

  if (geometry.measures.length === 0) return null;

  return (
    <svg
      data-testid="ehs-overlay-variant-b"
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 z-20 overflow-visible"
      width={Math.max(1, Math.ceil(geometry.containerWidth))}
      height={Math.max(1, Math.ceil(geometry.containerHeight))}
    >
      {/* Auto-stall Local Rescue Highlight (Decision Point 3) */}
      {rescueMeasure && (
        <rect
          x={rescueMeasure.contentLeft - 4}
          y={rescueMeasure.top - 8}
          width={Math.max(12, rescueMeasure.right - rescueMeasure.contentLeft + 8)}
          height={rescueMeasure.height + 16}
          rx={6}
          fill="rgba(251, 191, 36, 0.12)"
          stroke="#f59e0b"
          strokeWidth={2}
          strokeDasharray="6,3"
        />
      )}

      {/* Minimal non-blocking top-edge ticks only (zero vertical bars over staff lines!) */}
      {handPt && config.enabled && (
        <g>
          <polygon
            points={`${handPt.x - 5},${handPt.measure.top - 12} ${handPt.x + 5},${handPt.measure.top - 12} ${handPt.x},${handPt.measure.top - 4}`}
            fill="#4f46e5"
          />
          <text
            x={handPt.x}
            y={Math.max(10, handPt.measure.top - 15)}
            textAnchor="middle"
            fontSize="9"
            fontWeight="700"
            fill="#4338ca"
          >
            手位
          </text>
        </g>
      )}

      {frontierPt && snapshot.isMasked && (
        <g>
          <polygon
            points={`${frontierPt.x - 5},${frontierPt.measure.top - 12} ${frontierPt.x + 5},${frontierPt.measure.top - 12} ${frontierPt.x},${frontierPt.measure.top - 4}`}
            fill="#0d9488"
          />
          <line
            x1={frontierPt.x}
            y1={frontierPt.measure.top - 4}
            x2={frontierPt.x}
            y2={frontierPt.measure.bottom + 4}
            stroke="rgba(13, 148, 136, 0.28)"
            strokeWidth={1.2}
            strokeDasharray="2,4"
          />
          <text
            x={frontierPt.x + 8}
            y={Math.max(10, frontierPt.measure.top - 12)}
            fontSize="9"
            fontWeight="700"
            fill="#0f766e"
          >
            消散前沿 ({Math.round((1 - config.ghostResidualOpacity) * 100)}%)
          </text>
        </g>
      )}
    </svg>
  );
}
