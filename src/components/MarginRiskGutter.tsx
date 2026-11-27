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

export interface MeasureSystemGroup {
  systemIndex: number;
  measureIndices: number[];
  top: number;
  height: number;
}

/**
 * Group measures into visual systems (staff rows) using rendered OSMD geometry when
 * available, or fixed-size fallback chunks when horizontal/unrendered.
 */
export function groupMeasuresIntoSystems(
  measureCount: number,
  measureGeometry: MeasureGeometry[],
  options?: { layoutMode?: "horizontal" | "page"; fallbackPerRow?: number }
): MeasureSystemGroup[] {
  const total = Math.max(0, measureCount);
  if (total === 0) return [];
  const fallbackPerRow = Math.max(1, options?.fallbackPerRow ?? 4);
  const layoutMode = options?.layoutMode ?? "page";

  if (layoutMode === "page" && measureGeometry.length > 0) {
    const geoByMeasure = new Map<number, MeasureGeometry>();
    for (const g of measureGeometry) {
      if (g.height > 0 && g.measureIndex >= 0 && g.measureIndex < total) {
        geoByMeasure.set(g.measureIndex, g);
      }
    }

    if (geoByMeasure.size > 0) {
      const bands: MeasureSystemGroup[] = [];
      const unmapped: number[] = [];

      for (let m = 0; m < total; m++) {
        const g = geoByMeasure.get(m);
        if (!g) {
          unmapped.push(m);
          continue;
        }
        const existing = bands.find((b) => Math.abs(b.top - g.top) < 16);
        if (existing) {
          existing.measureIndices.push(m);
          existing.height = Math.max(existing.height, g.height);
        } else {
          bands.push({
            systemIndex: bands.length,
            measureIndices: [m],
            top: g.top,
            height: g.height,
          });
        }
      }

      for (let i = 0; i < unmapped.length; i += fallbackPerRow) {
        bands.push({
          systemIndex: bands.length,
          measureIndices: unmapped.slice(i, i + fallbackPerRow),
          top: 0,
          height: 0,
        });
      }

      if (bands.length > 0) {
        return bands.map((b, idx) => ({ ...b, systemIndex: idx }));
      }
    }
  }

  const groups: MeasureSystemGroup[] = [];
  for (let i = 0; i < total; i += fallbackPerRow) {
    const indices: number[] = [];
    for (let m = i; m < Math.min(total, i + fallbackPerRow); m++) {
      indices.push(m);
    }
    groups.push({
      systemIndex: groups.length,
      measureIndices: indices,
      top: 0,
      height: 0,
    });
  }
  return groups;
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

interface PositionedSystemBar {
  systemIndex: number;
  targetMeasureIndex: number;
  startMeasureIndex: number;
  endMeasureIndex: number;
  highestSeverity: RiskSeverity;
  warningCount: number;
  labels: string[];
  containsSelected: boolean;
  top: number;
  height: number;
}

function computeAlignedSystemBars(
  measures: MeasureRiskSummary[],
  geometry: MeasureGeometry[],
  selectedMeasureIndex: number | null
): PositionedSystemBar[] | null {
  if (geometry.length !== measures.length || geometry.length === 0) {
    return null;
  }

  const measureMap = new Map<number, MeasureRiskSummary>();
  for (const m of measures) {
    measureMap.set(m.measureIndex, m);
  }

  const systems = groupMeasuresIntoSystems(measures.length, geometry, {
    layoutMode: "page",
  });
  if (systems.length === 0 || systems.some((s) => s.height <= 0)) {
    return null;
  }

  return systems.map((sys) => {
    const rowSummaries = sys.measureIndices
      .map((idx) => measureMap.get(idx))
      .filter((s): s is MeasureRiskSummary => Boolean(s));

    let highestSeverity: RiskSeverity = "none";
    let warningCount = 0;
    const labels: string[] = [];
    let firstRiskMeasure: number | null = null;
    let containsSelected = false;

    for (const s of rowSummaries) {
      if (s.measureIndex === selectedMeasureIndex) {
        containsSelected = true;
      }
      warningCount += s.warningCount;
      labels.push(...s.labels);
      if (SEVERITY_RANK[s.highestSeverity] > SEVERITY_RANK[highestSeverity]) {
        highestSeverity = s.highestSeverity;
        firstRiskMeasure = s.measureIndex;
      } else if (
        s.highestSeverity !== "none" &&
        s.highestSeverity === highestSeverity &&
        firstRiskMeasure === null
      ) {
        firstRiskMeasure = s.measureIndex;
      }
    }

    const startMeasureIndex = sys.measureIndices[0] ?? 0;
    const endMeasureIndex = sys.measureIndices[sys.measureIndices.length - 1] ?? startMeasureIndex;

    return {
      systemIndex: sys.systemIndex,
      targetMeasureIndex: firstRiskMeasure ?? startMeasureIndex,
      startMeasureIndex,
      endMeasureIndex,
      highestSeverity,
      warningCount,
      labels,
      containsSelected,
      top: sys.top,
      height: Math.max(20, sys.height),
    };
  });
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
    const titleParts = [`第 ${summary.measureIndex + 1} 小节`];
    if (summary.warningCount > 0) {
      titleParts.push(`${summary.warningCount} 条提示: ${summary.labels.join("、")}`);
    } else {
      titleParts.push("无风险提示");
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
        aria-label={`第 ${summary.measureIndex + 1} 小节${
          summary.highestSeverity !== "none"
            ? ` (${summary.highestSeverity === "danger" ? "高风险" : "警告"})`
            : ""
        }`}
        title={titleParts.join(" · ")}
        onClick={() => onSelectMeasure(summary.measureIndex)}
        style={posStyle}
        className={`flex items-center justify-center rounded font-bold transition focus:outline-none ${
          BAR_STYLE[summary.highestSeverity]
        } ${
          isHorizontal
            ? style
              ? "h-4 text-[9px]"
              : "h-4 min-w-6 flex-1 px-1 text-[9px]"
            : style
              ? "w-5 text-[10px]"
              : "min-h-6 w-5 flex-1 py-1 text-[10px]"
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
          aria-label="小节风险导航条"
          className="relative h-4 shrink-0 select-none"
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
        aria-label="小节风险导航条"
        className="flex h-4 w-full items-center gap-1 select-none"
      >
        {measures.map((summary) => renderBarButton(summary, undefined, true))}
      </nav>
    );
  }

  const alignedSystemBars = computeAlignedSystemBars(
    measures,
    measureGeometry,
    selectedMeasureIndex
  );

  if (alignedSystemBars) {
    const maxBottom = alignedSystemBars.reduce((acc, b) => Math.max(acc, b.top + b.height), 120);
    return (
      <nav
        data-testid="margin-risk-gutter"
        data-orientation="vertical"
        aria-label="谱行风险边栏"
        className="relative w-5 shrink-0 select-none"
        style={{ minHeight: `${Math.ceil(maxBottom)}px` }}
      >
        {alignedSystemBars.map((bar) => {
          const rangeLabel =
            bar.startMeasureIndex === bar.endMeasureIndex
              ? `第 ${bar.startMeasureIndex + 1} 小节`
              : `第 ${bar.startMeasureIndex + 1}–${bar.endMeasureIndex + 1} 小节`;
          const titleParts = [`第 ${bar.systemIndex + 1} 行 (${rangeLabel})`];
          if (bar.warningCount > 0) {
            titleParts.push(`${bar.warningCount} 条提示（点击跳至第 ${bar.targetMeasureIndex + 1} 小节）`);
          } else {
            titleParts.push("无风险提示");
          }

          return (
            <button
              key={`sys-${bar.systemIndex}`}
              type="button"
              data-system-index={bar.systemIndex}
              data-measure-index={bar.targetMeasureIndex}
              data-severity={bar.highestSeverity}
              aria-pressed={bar.containsSelected}
              aria-label={`第 ${bar.systemIndex + 1} 行 ${rangeLabel}${
                bar.highestSeverity !== "none"
                  ? ` (${bar.highestSeverity === "danger" ? "高风险" : "警告"})`
                  : ""
              }`}
              title={titleParts.join(" · ")}
              onClick={() => onSelectMeasure(bar.targetMeasureIndex)}
              style={{
                position: "absolute",
                top: `${bar.top}px`,
                height: `${bar.height}px`,
                left: 0,
                right: 0,
              }}
              className={`flex w-5 items-center justify-center rounded text-[10px] font-bold transition focus:outline-none ${
                BAR_STYLE[bar.highestSeverity]
              } ${bar.containsSelected ? "ring-2 ring-blue-600 ring-offset-1" : ""}`}
            >
              {bar.systemIndex + 1}
            </button>
          );
        })}
      </nav>
    );
  }

  return (
    <nav
      data-testid="margin-risk-gutter"
      data-orientation="vertical"
      aria-label="小节风险边栏"
      className="flex w-5 shrink-0 flex-col gap-1 select-none"
    >
      {measures.map((summary) => renderBarButton(summary))}
    </nav>
  );
}
