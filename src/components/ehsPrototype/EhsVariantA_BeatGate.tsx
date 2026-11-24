import { useEffect } from "react";
import { fracToMeasureX, scoreBeatToCanvasPoint } from "./ehsOsmdGeometry";
import type {
  EhsConfig,
  EhsExtractedGeometry,
  EhsFrameSnapshot,
} from "./ehsPrototypeTypes";

export interface EhsVariantOverlayProps {
  geometry: EhsExtractedGeometry;
  snapshot: EhsFrameSnapshot;
  config: EhsConfig;
  onReportRenderCost?: (updateMs: number, mutatedNodes: number) => void;
}

interface BeatTileRect {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isRecentBeat: boolean;
}

/**
 * Variant A — 拍格瞬隐门 (Beat-Gate Snap)
 *
 * Structurally discrete beat-column occlusion:
 * - Zero continuous sliding motion; every beat slot snaps cleanly on exact beat boundaries.
 * - Preserves clef & key signatures (`contentLeft`) and draws calm manuscript-paper tiles
 *   with subtle ghost staff rulings so the eye never fights harsh solid blocks.
 * - Separates two explicit spatial anchors: Hand Marker (indigo) vs Eye Gate Bracket (emerald).
 */
export function EhsVariantA_BeatGate({
  geometry,
  snapshot,
  config,
  onReportRenderCost,
}: EhsVariantOverlayProps) {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();

  // Snap frontier discretely to whole beats (or half-beats when lookahead < 1 beat)
  const snapStep = snapshot.effectiveLookaheadBeats < 1 ? 0.5 : 1;
  const snappedFrontierBeat = Math.floor(snapshot.frontierBeat / snapStep + 1e-4) * snapStep;

  const tiles: BeatTileRect[] = [];
  if (geometry.measures.length > 0 && snapshot.isMasked) {
    for (const m of geometry.measures) {
      if (snappedFrontierBeat <= m.startBeat + 1e-4) continue;

      if (snappedFrontierBeat >= m.endBeat - 1e-4) {
        // Whole measure is behind the snapped horizon: one crisp measure tile starting after clef
        const isRecent = m.measureIndex >= snapshot.handMeasureIndex;
        tiles.push({
          key: `m-${m.measureIndex}`,
          x: m.contentLeft,
          y: m.top - 5,
          width: Math.max(4, m.right - m.contentLeft + 1),
          height: m.height + 10,
          isRecentBeat: isRecent,
        });
      } else {
        // Partial measure: snap beat-by-beat tiles up to snappedFrontierBeat
        const beatsMasked = Math.max(0, Math.min(m.beatsInMeasure, snappedFrontierBeat - m.startBeat));
        const slotCount = Math.max(1, Math.round(beatsMasked / snapStep));
        for (let s = 0; s < slotCount; s++) {
          const b0 = s * snapStep;
          const b1 = Math.min(m.beatsInMeasure, (s + 1) * snapStep);
          const x0 = fracToMeasureX(m, b0 / m.beatsInMeasure);
          const x1 = fracToMeasureX(m, b1 / m.beatsInMeasure);
          if (x1 - x0 < 2) continue;
          tiles.push({
            key: `m-${m.measureIndex}-s-${s}`,
            x: x0,
            y: m.top - 5,
            width: Math.max(4, x1 - x0 - 1),
            height: m.height + 10,
            isRecentBeat: s === slotCount - 1,
          });
        }
      }
    }
  }

  const handPt = scoreBeatToCanvasPoint(geometry, Math.max(0, snapshot.handBeat));
  const gatePt = scoreBeatToCanvasPoint(geometry, Math.max(0, snappedFrontierBeat));
  const rescueMeasure =
    snapshot.peek.active && snapshot.peek.rescueMeasureIndex !== null
      ? geometry.measures.find((m) => m.measureIndex === snapshot.peek.rescueMeasureIndex) ?? null
      : null;

  const maskAlpha = Math.max(0.76, Math.min(0.99, 1 - config.ghostResidualOpacity));

  const renderMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  useEffect(() => {
    onReportRenderCost?.(renderMs, tiles.length);
  });

  if (geometry.measures.length === 0) return null;

  return (
    <svg
      data-testid="ehs-overlay-variant-a"
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 z-20 overflow-visible"
      width={Math.max(1, Math.ceil(geometry.containerWidth))}
      height={Math.max(1, Math.ceil(geometry.containerHeight))}
    >
      <defs>
        {/* Subtle blank manuscript-paper hairline pattern so hidden bars feel calm, not blocky */}
        <pattern id="ehs-a-paper-lines" width="24" height="10" patternUnits="userSpaceOnUse">
          <line x1="0" y1="9" x2="24" y2="9" stroke="rgba(148,163,184,0.16)" strokeWidth="0.7" />
        </pattern>
      </defs>

      {/* Discrete Beat-Gate Mask Tiles */}
      <g
        style={{
          opacity: snapshot.isMasked ? 1 : 0,
          transition: snapshot.isMasked ? "opacity 220ms ease-in" : "opacity 90ms ease-out",
        }}
      >
        {tiles.map((tile) => (
          <g key={tile.key}>
            <rect
              x={tile.x}
              y={tile.y}
              width={tile.width}
              height={tile.height}
              rx={3}
              fill={`rgba(250, 250, 248, ${maskAlpha})`}
              stroke={tile.isRecentBeat ? "rgba(16, 185, 129, 0.35)" : "rgba(203, 213, 225, 0.45)"}
              strokeWidth={tile.isRecentBeat ? 1.2 : 0.7}
            />
            <rect
              x={tile.x}
              y={tile.y}
              width={tile.width}
              height={tile.height}
              rx={3}
              fill="url(#ehs-a-paper-lines)"
            />
          </g>
        ))}
      </g>

      {/* Auto-stall Local Rescue Highlight (Decision Point 3) */}
      {rescueMeasure && (
        <rect
          x={rescueMeasure.contentLeft - 4}
          y={rescueMeasure.top - 8}
          width={Math.max(12, rescueMeasure.right - rescueMeasure.contentLeft + 8)}
          height={rescueMeasure.height + 16}
          rx={6}
          fill="rgba(251, 191, 36, 0.14)"
          stroke="#f59e0b"
          strokeWidth={2}
          strokeDasharray="6,3"
        />
      )}

      {/* Hand Position Anchor (top-mounted so always visible even on compact grand-staff viewports) */}
      {handPt && config.enabled && (
        <g>
          <line
            x1={handPt.x}
            y1={handPt.measure.top - 12}
            x2={handPt.x}
            y2={handPt.measure.bottom + 8}
            stroke="rgba(79, 70, 229, 0.65)"
            strokeWidth={1.75}
            strokeDasharray="3,3"
          />
          <rect
            x={handPt.x - 18}
            y={Math.max(2, handPt.measure.top - 26)}
            width={36}
            height={14}
            rx={7}
            fill="#4f46e5"
          />
          <text
            x={handPt.x}
            y={Math.max(12, handPt.measure.top - 16)}
            textAnchor="middle"
            fontSize="9"
            fontWeight="700"
            fill="#ffffff"
          >
            手位
          </text>
        </g>
      )}

      {/* Discrete Snapped Eye-Horizon Gate Bracket */}
      {gatePt && snapshot.isMasked && (
        <g>
          <line
            x1={gatePt.x}
            y1={gatePt.measure.top - 14}
            x2={gatePt.x}
            y2={gatePt.measure.bottom + 10}
            stroke="#059669"
            strokeWidth={2.5}
          />
          {/* Top forward-pointing bracket */}
          <path
            d={`M ${gatePt.x} ${gatePt.measure.top - 14} L ${gatePt.x + 14} ${gatePt.measure.top - 14}`}
            stroke="#059669"
            strokeWidth={2.5}
            fill="none"
          />
          <path
            d={`M ${gatePt.x} ${gatePt.measure.bottom + 10} L ${gatePt.x + 14} ${gatePt.measure.bottom + 10}`}
            stroke="#059669"
            strokeWidth={2.5}
            fill="none"
          />
          <rect
            x={gatePt.x + 4}
            y={Math.max(2, gatePt.measure.top - 26)}
            width={62}
            height={15}
            rx={7.5}
            fill="#059669"
          />
          <text
            x={gatePt.x + 35}
            y={Math.max(12, gatePt.measure.top - 15.5)}
            textAnchor="middle"
            fontSize="9.5"
            fontWeight="700"
            fill="#ffffff"
          >
            视线前沿 →
          </text>
        </g>
      )}
    </svg>
  );
}
