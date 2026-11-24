import type { EhsExtractedGeometry, EhsFrameSnapshot } from "./ehsPrototypeTypes";

interface EhsAlignmentDebugLayerProps {
  geometry: EhsExtractedGeometry;
  snapshot: EhsFrameSnapshot;
}

/**
 * Calibration overlay for Decision Point 3 (OSMD SVG alignment verification across horizontal & page layouts):
 * Draws measure bounding boxes, clef/key-sig `contentLeft` boundaries, and extracted `staffEntry` beat anchor dots.
 */
export function EhsAlignmentDebugLayer({ geometry, snapshot }: EhsAlignmentDebugLayerProps) {
  if (geometry.measures.length === 0) return null;

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 z-30 overflow-visible"
      width={Math.max(1, Math.ceil(geometry.containerWidth))}
      height={Math.max(1, Math.ceil(geometry.containerHeight))}
    >
      {geometry.measures.map((m) => {
        const isHand = m.measureIndex === snapshot.handMeasureIndex;
        const isFrontier = m.measureIndex === snapshot.frontierMeasureIndex;
        const stroke = isFrontier ? "#059669" : isHand ? "#2563eb" : "rgba(100,116,139,0.35)";
        return (
          <g key={m.measureIndex}>
            <rect
              x={m.left}
              y={m.top}
              width={Math.max(2, m.width)}
              height={Math.max(2, m.height)}
              fill="none"
              stroke={stroke}
              strokeWidth={isHand || isFrontier ? 1.5 : 0.8}
              strokeDasharray="3,2"
            />
            {/* Clef / Key-Sig contentLeft boundary line */}
            <line
              x1={m.contentLeft}
              y1={m.top - 3}
              x2={m.contentLeft}
              y2={m.bottom + 3}
              stroke="#d97706"
              strokeWidth={1.2}
              strokeDasharray="2,2"
            />
            <text
              x={m.left + 3}
              y={Math.max(10, m.top - 4)}
              fontSize="9"
              fontFamily="ui-monospace, monospace"
              fill="#475569"
            >
              M{m.measureIndex + 1} · S{m.systemIndex + 1} ({m.anchors.length}a)
            </text>
            {/* Extracted OSMD staffEntry beat anchor dots */}
            {m.anchors.map((a, idx) => (
              <circle
                key={idx}
                cx={a.centerX}
                cy={m.top + 3}
                r={2.5}
                fill="#10b981"
                stroke="#ffffff"
                strokeWidth={0.7}
              />
            ))}
          </g>
        );
      })}
    </svg>
  );
}
