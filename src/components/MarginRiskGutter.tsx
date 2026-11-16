import type { OnsetSlice, TransitionCue } from "../domain/types";

export type RiskSeverity = "none" | "warn" | "danger";

export interface MeasureRiskSummary {
  measureIndex: number;
  highestSeverity: RiskSeverity;
  warningCount: number;
  firstWarningSliceId: string | null;
  firstSliceId: string | null;
  labels: string[];
}

export interface MeasureGeometry {
  measureIndex: number;
  top: number;
  height: number;
  left?: number;
  width?: number;
}

export interface MarginRiskGutterProps {
  measures: MeasureRiskSummary[];
  selectedMeasureIndex: number | null;
  measureGeometry?: MeasureGeometry[];
  orientation?: "vertical" | "horizontal";
  onSelectMeasure: (measureIndex: number) => void;
}

const SEVERITY_RANK: Record<RiskSeverity, number> = {
  none: 0,
  warn: 1,
  danger: 2,
};

const BAR_STYLE: Record<RiskSeverity, string> = {
  none: "bg-slate-200 hover:bg-slate-300 text-slate-500",
  warn: "bg-amber-400 hover:bg-amber-500 text-amber-950",
  danger: "bg-red-500 hover:bg-red-600 text-white",
};

/**
 * Aggregate per-measure risk severity and primary target OnsetSlice IDs
 * across all RH and LH slices and warnings.
 */
export function buildMeasureRiskSummaries(
  measureCount: number,
  onsetSlices: OnsetSlice[],
  warnings: TransitionCue[]
): MeasureRiskSummary[] {
  const maxMeasureFromSlices = onsetSlices.reduce(
    (max, slice) => Math.max(max, slice.measureIndex),
    -1
  );
  const totalMeasures = Math.max(measureCount, maxMeasureFromSlices + 1);
  if (totalMeasures <= 0) return [];

  const firstSliceByMeasure = new Map<number, { sliceId: string; onsetTick: number }>();
  for (const slice of onsetSlices) {
    const existing = firstSliceByMeasure.get(slice.measureIndex);
    if (!existing || slice.onsetTick < existing.onsetTick) {
      firstSliceByMeasure.set(slice.measureIndex, {
        sliceId: slice.sliceId,
        onsetTick: slice.onsetTick,
      });
    }
  }

  const onsetBySliceId = new Map<string, number>();
  for (const slice of onsetSlices) {
    onsetBySliceId.set(slice.sliceId, slice.onsetTick);
  }

  const warningsByMeasure = new Map<
    number,
    Array<TransitionCue & { severity: "warn" | "danger" }>
  >();
  for (const cue of warnings) {
    if (cue.severity !== "warn" && cue.severity !== "danger") continue;
    const narrowedCue: TransitionCue & { severity: "warn" | "danger" } = {
      ...cue,
      severity: cue.severity,
    };
    const list = warningsByMeasure.get(cue.measureIndex) ?? [];
    list.push(narrowedCue);
    warningsByMeasure.set(cue.measureIndex, list);
  }

  const summaries: MeasureRiskSummary[] = [];
  for (let m = 0; m < totalMeasures; m++) {
    const measureWarnings = [...(warningsByMeasure.get(m) ?? [])].sort((a, b) => {
      const sevDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (sevDiff !== 0) return sevDiff;
      const tickA = onsetBySliceId.get(a.sliceId) ?? 0;
      const tickB = onsetBySliceId.get(b.sliceId) ?? 0;
      return tickA - tickB;
    });

    const highestSeverity: RiskSeverity =
      measureWarnings.length > 0 ? measureWarnings[0].severity : "none";

    summaries.push({
      measureIndex: m,
      highestSeverity,
      warningCount: measureWarnings.length,
      firstWarningSliceId: measureWarnings[0]?.sliceId ?? null,
      firstSliceId: firstSliceByMeasure.get(m)?.sliceId ?? null,
      labels: measureWarnings.map((w) => w.label),
    });
  }

  return summaries;
}

interface PositionedBar {
  summary: MeasureRiskSummary;
  top: number;
  height: number;
}

function computeAlignedBars(
  measures: MeasureRiskSummary[],
  geometry: MeasureGeometry[]
): PositionedBar[] | null {
  if (geometry.length !== measures.length || geometry.length === 0) {
    return null;
  }

  const geoByMeasure = new Map<number, MeasureGeometry>();
  for (const g of geometry) {
    if (g.height <= 0) return null;
    geoByMeasure.set(g.measureIndex, g);
  }

  // Group measures sharing the same system row (similar vertical top) so bars never overlap
  const bands: Array<{ top: number; height: number; items: MeasureRiskSummary[] }> = [];
  for (const summary of measures) {
    const g = geoByMeasure.get(summary.measureIndex);
    if (!g) return null;
    const existingBand = bands.find((b) => Math.abs(b.top - g.top) < 16);
    if (existingBand) {
      existingBand.items.push(summary);
      existingBand.height = Math.max(existingBand.height, g.height);
    } else {
      bands.push({ top: g.top, height: g.height, items: [summary] });
    }
  }

  const bars: PositionedBar[] = [];
  for (const band of bands) {
    const gap = 3;
    const totalGap = gap * (band.items.length - 1);
    const sliceHeight = Math.max(12, (band.height - totalGap) / band.items.length);
    band.items.forEach((summary, idx) => {
      bars.push({
        summary,
        top: band.top + idx * (sliceHeight + gap),
        height: sliceHeight,
      });
    });
  }
  return bars;
}

/**
 * Per-measure vertical risk indicator rail rendered beside the score canvas.
 */
export function MarginRiskGutter({
  measures,
  selectedMeasureIndex,
  measureGeometry = [],
  orientation = "vertical",
  onSelectMeasure,
}: MarginRiskGutterProps) {
  if (measures.length === 0) {
    return null;
  }

  const renderBarButton = (
    summary: MeasureRiskSummary,
    style?: { top?: number; height?: number; left?: number; width?: number },
    isHorizontal = false
  ) => {
    const isSelected = selectedMeasureIndex === summary.measureIndex;
    const titleParts = [`Measure ${summary.measureIndex + 1}`];
    if (summary.warningCount > 0) {
      titleParts.push(`${summary.warningCount} warning(s): ${summary.labels.join(", ")}`);
    } else {
      titleParts.push("No risk warnings");
    }

    const posStyle: React.CSSProperties | undefined = style
      ? isHorizontal
        ? { position: "absolute", left: `${style.left ?? 0}px`, width: `${style.width ?? 24}px`, top: 0, bottom: 0 }
        : { position: "absolute", top: `${style.top ?? 0}px`, height: `${style.height ?? 16}px`, left: 0, right: 0 }
      : undefined;

    return (
      <button
        key={summary.measureIndex}
        type="button"
        data-measure-index={summary.measureIndex}
        data-severity={summary.highestSeverity}
        aria-pressed={isSelected}
        aria-label={`Measure ${summary.measureIndex + 1}${
          summary.highestSeverity !== "none" ? ` (${summary.highestSeverity})` : ""
        }`}
        title={titleParts.join(" · ")}
        onClick={() => onSelectMeasure(summary.measureIndex)}
        style={posStyle}
        className={`flex items-center justify-center rounded text-[10px] font-bold transition focus:outline-none ${
          BAR_STYLE[summary.highestSeverity]
        } ${
          isHorizontal
            ? style
              ? "h-5"
              : "h-5 min-w-6 flex-1 px-1"
            : style
              ? "w-5"
              : "min-h-6 w-5 flex-1 py-1"
        } ${isSelected ? "ring-2 ring-blue-600 ring-offset-1" : ""}`}
      >
        {summary.measureIndex + 1}
      </button>
    );
  };

  if (orientation === "horizontal") {
    const geoByMeasure = new Map(measureGeometry.map((g) => [g.measureIndex, g]));
    const hasHorizontalGeo =
      measureGeometry.length === measures.length &&
      measures.every((m) => {
        const g = geoByMeasure.get(m.measureIndex);
        return Boolean(g && g.left !== undefined && g.width !== undefined && g.width > 0);
      });

    if (hasHorizontalGeo) {
      const totalWidth = measures.reduce((max, m) => {
        const g = geoByMeasure.get(m.measureIndex)!;
        return Math.max(max, (g.left ?? 0) + (g.width ?? 0));
      }, 240);

      return (
        <nav
          data-testid="margin-risk-gutter"
          data-orientation="horizontal"
          aria-label="Measure risk strip"
          className="relative h-5 shrink-0 select-none"
          style={{ width: `${Math.ceil(totalWidth)}px` }}
        >
          {measures.map((summary) => {
            const g = geoByMeasure.get(summary.measureIndex)!;
            return renderBarButton(
              summary,
              { left: g.left ?? 0, width: Math.max(16, (g.width ?? 24) - 2) },
              true
            );
          })}
        </nav>
      );
    }

    return (
      <nav
        data-testid="margin-risk-gutter"
        data-orientation="horizontal"
        aria-label="Measure risk strip"
        className="flex h-5 w-full items-center gap-1 select-none"
      >
        {measures.map((summary) => renderBarButton(summary, undefined, true))}
      </nav>
    );
  }

  const alignedBars = computeAlignedBars(measures, measureGeometry);

  if (alignedBars) {
    const maxBottom = alignedBars.reduce((acc, b) => Math.max(acc, b.top + b.height), 120);
    return (
      <nav
        data-testid="margin-risk-gutter"
        data-orientation="vertical"
        aria-label="Measure risk gutter"
        className="relative w-5 shrink-0 select-none"
        style={{ minHeight: `${Math.ceil(maxBottom)}px` }}
      >
        {alignedBars.map((bar) => renderBarButton(bar.summary, { top: bar.top, height: bar.height }))}
      </nav>
    );
  }

  return (
    <nav
      data-testid="margin-risk-gutter"
      data-orientation="vertical"
      aria-label="Measure risk gutter"
      className="flex w-5 shrink-0 flex-col gap-1 select-none"
    >
      {measures.map((summary) => renderBarButton(summary))}
    </nav>
  );
}
