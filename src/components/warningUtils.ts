import type { Hand, OnsetSlice, TransitionCue } from "../domain/types";

const SEVERITY_ORDER: Record<"danger" | "warn", number> = {
  danger: 0,
  warn: 1,
};

const HAND_ORDER: Record<Hand, number> = {
  RH: 0,
  LH: 1,
};

/**
 * Filter TransitionCues to warn/danger severities and sort chronologically by
 * measureIndex and slice onsetTick.
 */
export function sortWarningsForNavigation(
  warnings: TransitionCue[],
  onsetSlices: OnsetSlice[]
): TransitionCue[] {
  const onsetBySliceId = new Map<string, number>();
  for (const slice of onsetSlices) {
    onsetBySliceId.set(slice.sliceId, slice.onsetTick);
  }

  return warnings
    .filter((cue) => cue.severity === "warn" || cue.severity === "danger")
    .slice()
    .sort((a, b) => {
      if (a.measureIndex !== b.measureIndex) {
        return a.measureIndex - b.measureIndex;
      }
      const tickA = onsetBySliceId.get(a.sliceId) ?? 0;
      const tickB = onsetBySliceId.get(b.sliceId) ?? 0;
      if (tickA !== tickB) {
        return tickA - tickB;
      }
      if (a.hand !== b.hand) {
        return HAND_ORDER[a.hand] - HAND_ORDER[b.hand];
      }
      const sevDiff =
        SEVERITY_ORDER[a.severity as "danger" | "warn"] -
        SEVERITY_ORDER[b.severity as "danger" | "warn"];
      if (sevDiff !== 0) return sevDiff;
      return b.cost - a.cost;
    });
}
