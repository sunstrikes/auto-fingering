import { useEffect } from "react";
import { scoreBeatToCanvasPoint } from "./ehsOsmdGeometry";
import type { EhsVariantOverlayProps } from "./EhsVariantA_BeatGate";

const SPOTLIGHT_BEATS = 1.6;

/**
 * Variant C — 渐隐滑动幕布 (Translucent Fog Curtain)
 *
 * Structurally continuous 60fps optical veil:
 * - Sweeps a feathered linear-gradient paper fog continuously along each visual system row
 *   using exact OSMD staffEntry X interpolation.
 * - Paired with a soft warm-emerald Reading Spotlight ahead of the feathered edge to pull
 *   foveal gaze into the upcoming `[frontierBeat, frontierBeat + 1.6 beats]` reading window.
 * - Cross-line wrap in `page` mode: completed upper systems stay uniformly veiled while the
 *   gliding curtain seamlessly enters the next system row's `contentLeft` (past its clef/key sig)
 *   before the pianist's hands finish the current line.
 * - In `horizontal` scroll mode, combines with `ScoreViewer`'s smooth 30%-anchor tracking so
 *   the feathered edge sits stably in viewport space while notation flows underneath like a teleprompter.
 */
export function EhsVariantC_SlidingCurtain({
  geometry,
  snapshot,
  config,
  onReportRenderCost,
}: EhsVariantOverlayProps) {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();

  const handPt = scoreBeatToCanvasPoint(geometry, Math.max(0, snapshot.handBeat));
  const frontierPt = scoreBeatToCanvasPoint(geometry, Math.max(0, snapshot.frontierBeat));
  const spotlightEndPt = scoreBeatToCanvasPoint(
    geometry,
    Math.max(0, snapshot.frontierBeat + SPOTLIGHT_BEATS)
  );
  const rescueMeasure =
    snapshot.peek.active && snapshot.peek.rescueMeasureIndex !== null
      ? geometry.measures.find((m) => m.measureIndex === snapshot.peek.rescueMeasureIndex) ?? null
      : null;

  const veilMaxAlpha = Math.max(0.75, Math.min(0.98, 1 - config.ghostResidualOpacity));
  const activeSystemIdx = frontierPt?.system?.systemIndex ?? -1;

  // Estimate feather width (~0.65 beat in pixels of the active measure, clamped to [28, 110])
  const activeMeasure = frontierPt?.measure;
  const pxPerBeat =
    activeMeasure && activeMeasure.beatsInMeasure > 0
      ? Math.max(24, (activeMeasure.right - activeMeasure.contentLeft) / activeMeasure.beatsInMeasure)
      : 64;
  const featherPx = Math.max(28, Math.min(110, pxPerBeat * 0.65));

  const renderMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  useEffect(() => {
    onReportRenderCost?.(renderMs, geometry.systems.length);
  });

  if (geometry.systems.length === 0) return null;

  return (
    <svg
      data-testid="ehs-overlay-variant-c"
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 z-20 overflow-visible"
      width={Math.max(1, Math.ceil(geometry.containerWidth))}
      height={Math.max(1, Math.ceil(geometry.containerHeight))}
    >
      <defs>
        {/* Soft multi-stop feathered horizontal fog ramp */}
        <linearGradient id="ehs-c-feather" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#f8fafc" stopOpacity={veilMaxAlpha} />
          <stop offset="45%" stopColor="#f8fafc" stopOpacity={veilMaxAlpha * 0.62} />
          <stop offset="80%" stopColor="#f8fafc" stopOpacity={veilMaxAlpha * 0.18} />
          <stop offset="100%" stopColor="#f8fafc" stopOpacity={0} />
        </linearGradient>

        {/* Forward reading spotlight ahead of the fog edge */}
        <linearGradient id="ehs-c-spotlight" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#10b981" stopOpacity={0.13} />
          <stop offset="70%" stopColor="#10b981" stopOpacity={0.07} />
          <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* Per-system Continuous Fog Curtains */}
      <g
        style={{
          opacity: snapshot.isMasked ? 1 : 0,
          transition: snapshot.isMasked ? "opacity 240ms ease-in" : "opacity 90ms ease-out",
        }}
      >
        {geometry.systems.map((sys) => {
          const padTop = sys.top - 8;
          const padHeight = sys.height + 16;

          // Completed upper system rows
          if (sys.systemIndex < activeSystemIdx) {
            return (
              <rect
                key={`sys-done-${sys.systemIndex}`}
                x={sys.contentLeft}
                y={padTop}
                width={Math.max(4, sys.right - sys.contentLeft + 6)}
                height={padHeight}
                rx={4}
                fill={`rgba(248, 250, 252, ${veilMaxAlpha})`}
              />
            );
          }

          // Active system containing the continuous eye frontier
          if (sys.systemIndex === activeSystemIdx && frontierPt) {
            const solidEndX = Math.max(sys.contentLeft, frontierPt.x - featherPx * 0.25);
            const solidWidth = Math.max(0, solidEndX - sys.contentLeft);
            const featherX = solidEndX;
            const maxFeatherRight = sys.right + 12;
            const actualFeatherW = Math.max(0, Math.min(featherPx, maxFeatherRight - featherX));

            const spotStartX = Math.min(sys.right, frontierPt.x + actualFeatherW * 0.25);
            const spotEndX =
              spotlightEndPt && spotlightEndPt.system?.systemIndex === sys.systemIndex
                ? Math.max(spotStartX + 20, Math.min(sys.right + 4, spotlightEndPt.x))
                : sys.right + 4;

            return (
              <g key={`sys-active-${sys.systemIndex}`}>
                {/* Solid/frosted behind-curtain fog */}
                {solidWidth > 0 && (
                  <rect
                    x={sys.contentLeft}
                    y={padTop}
                    width={solidWidth}
                    height={padHeight}
                    rx={3}
                    fill={`rgba(248, 250, 252, ${veilMaxAlpha})`}
                  />
                )}
                {/* Smooth feathered fog leading edge */}
                {actualFeatherW > 0 && (
                  <rect
                    x={featherX}
                    y={padTop}
                    width={actualFeatherW}
                    height={padHeight}
                    fill="url(#ehs-c-feather)"
                  />
                )}
                {/* Soft eye-focus reading spotlight directly ahead of the curtain */}
                {spotEndX > spotStartX + 4 && (
                  <rect
                    x={spotStartX}
                    y={padTop + 2}
                    width={spotEndX - spotStartX}
                    height={padHeight - 4}
                    rx={6}
                    fill="url(#ehs-c-spotlight)"
                  />
                )}
              </g>
            );
          }

          // Cross-line reading spotlight peek on the START of the next system row!
          if (
            sys.systemIndex === activeSystemIdx + 1 &&
            spotlightEndPt &&
            spotlightEndPt.system?.systemIndex === sys.systemIndex
          ) {
            const nextSpotWidth = Math.max(24, spotlightEndPt.x - sys.contentLeft);
            return (
              <rect
                key={`sys-next-spot-${sys.systemIndex}`}
                x={sys.contentLeft}
                y={padTop + 2}
                width={Math.min(sys.right - sys.contentLeft, nextSpotWidth)}
                height={padHeight - 4}
                rx={6}
                fill="url(#ehs-c-spotlight)"
              />
            );
          }

          return null;
        })}
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

      {/* Calm Hand Position Indicator (visible through the fog at top edge so tempo anchor is never lost) */}
      {handPt && config.enabled && (
        <g>
          <line
            x1={handPt.x}
            y1={handPt.measure.top - 10}
            x2={handPt.x}
            y2={handPt.measure.bottom + 6}
            stroke="rgba(79, 70, 229, 0.45)"
            strokeWidth={1.5}
          />
          <circle cx={handPt.x} cy={handPt.measure.top - 12} r={4} fill="#4f46e5" />
          <text
            x={handPt.x - 8}
            y={Math.max(10, handPt.measure.top - 9)}
            textAnchor="end"
            fontSize="9"
            fontWeight="700"
            fill="#4338ca"
          >
            手位
          </text>
        </g>
      )}

      {/* Subtle top-edge fog frontier marker */}
      {frontierPt && snapshot.isMasked && (
        <g>
          <line
            x1={frontierPt.x}
            y1={frontierPt.measure.top - 10}
            x2={frontierPt.x}
            y2={frontierPt.measure.top - 2}
            stroke="#059669"
            strokeWidth={2}
          />
          <text
            x={frontierPt.x + 6}
            y={Math.max(10, frontierPt.measure.top - 10)}
            fontSize="9"
            fontWeight="700"
            fill="#047857"
          >
            前瞻幕布 +{snapshot.effectiveLookaheadBeats.toFixed(1)}拍
          </text>
        </g>
      )}
    </svg>
  );
}
