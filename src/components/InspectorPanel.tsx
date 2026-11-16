import type {
  Finger,
  Hand,
  HandSpanProfile,
  OnsetSlice,
  TransitionCue,
} from "../domain/types";
import { midiToPitchLabel } from "../solver/keyboard";

export interface InspectorPanelProps {
  warnings: TransitionCue[];
  onsetSlices: OnsetSlice[];
  fingerByNoteUid: Record<string, Finger>;
  handSpanProfile: HandSpanProfile;
  selectedSliceId: string | null;
  selectedMeasureIndex: number | null;
  ignoreExistingFingerings: boolean;
  hasScore: boolean;
  onSelectWarning: (cue: TransitionCue) => void;
}

const SEVERITY_ORDER: Record<"danger" | "warn", number> = {
  danger: 0,
  warn: 1,
};

const HAND_ORDER: Record<Hand, number> = {
  RH: 0,
  LH: 1,
};

/**
 * Filter to warn/danger cues and sort chronologically by measureIndex and onsetTick.
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

/**
 * Sticky right-hand Inspector panel housing scrollable TransitionCue warnings
 * and the currently selected OnsetSlice summary.
 */
export function InspectorPanel({
  warnings,
  onsetSlices,
  fingerByNoteUid,
  handSpanProfile,
  selectedSliceId,
  selectedMeasureIndex,
  ignoreExistingFingerings,
  hasScore,
  onSelectWarning,
}: InspectorPanelProps) {
  const sortedWarnings = sortWarningsForNavigation(warnings, onsetSlices);
  const dangerCount = sortedWarnings.filter((w) => w.severity === "danger").length;
  const warnCount = sortedWarnings.length - dangerCount;

  const selectedSlice =
    selectedSliceId !== null
      ? onsetSlices.find((s) => s.sliceId === selectedSliceId) ?? null
      : null;

  return (
    <aside
      data-testid="inspector-panel"
      aria-label="Fingering Inspector"
      className="flex flex-col gap-3 lg:sticky lg:top-4"
    >
      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-900">
              Warnings ({sortedWarnings.length})
            </h2>
            {dangerCount > 0 && (
              <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                {dangerCount} danger
              </span>
            )}
            {warnCount > 0 && (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                {warnCount} warn
              </span>
            )}
          </div>
          <span className="rounded-full border border-slate-200 bg-slate-100 px-2.5 py-0.5 text-[11px] font-medium text-slate-600">
            Span {handSpanProfile.preset}
          </span>
        </header>

        <div className="max-h-96 overflow-y-auto p-3">
          {!hasScore ? (
            <p className="py-6 text-center text-xs text-slate-500">
              Upload a MusicXML or .mxl score to inspect fingering warnings and transition cues.
            </p>
          ) : sortedWarnings.length === 0 ? (
            <p className="py-6 text-center text-xs text-emerald-700">
              No high-risk transitions or span warnings under Span {handSpanProfile.preset}.
            </p>
          ) : (
            <div className="space-y-2" role="list" aria-label="Fingering warnings">
              {sortedWarnings.map((cue, index) => {
                const isSelected = selectedSliceId === cue.sliceId;
                const isDanger = cue.severity === "danger";
                return (
                  <button
                    key={`${cue.sliceId}-${cue.type}-${index}`}
                    type="button"
                    data-warning-item="true"
                    data-slice-id={cue.sliceId}
                    data-measure-index={cue.measureIndex}
                    data-severity={cue.severity}
                    data-cue-type={cue.type}
                    aria-pressed={isSelected}
                    onClick={() => onSelectWarning(cue)}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                      isSelected
                        ? "border-blue-500 bg-blue-50/70 ring-1 ring-blue-500"
                        : "border-slate-200 bg-white hover:border-blue-300 hover:bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-bold text-slate-900">
                          m.{cue.measureIndex + 1}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            cue.hand === "RH"
                              ? "bg-teal-100 text-teal-800"
                              : "bg-indigo-100 text-indigo-800"
                          }`}
                        >
                          {cue.hand}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            isDanger
                              ? "border border-red-200 bg-red-100 text-red-700"
                              : "border border-amber-200 bg-amber-100 text-amber-800"
                          }`}
                        >
                          {cue.severity}
                        </span>
                      </div>
                      <span className="font-mono text-[11px] text-slate-500">
                        cost {cue.cost.toFixed(1)}
                      </span>
                    </div>

                    <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                      <span className="font-medium text-slate-800">{cue.label}</span>
                      <span className="font-mono text-[10px] text-slate-400">{cue.type}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section
        data-testid="selected-slice-summary"
        className="rounded-xl border border-slate-200 bg-white shadow-sm"
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            Selected Onset Slice
          </h3>
          {selectedMeasureIndex !== null && (
            <span className="text-xs font-medium text-slate-700">
              Measure {selectedMeasureIndex + 1}
            </span>
          )}
        </header>
        <div className="p-3 text-xs text-slate-600">
          {selectedSlice ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-900">
                  m.{selectedSlice.measureIndex + 1} · {selectedSlice.hand}
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  {selectedSlice.sliceId}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {selectedSlice.notes.map((note) => {
                  const finger = fingerByNoteUid[note.noteUid];
                  const isActiveAnchor =
                    note.anchorFinger !== undefined &&
                    !(ignoreExistingFingerings && note.anchorRawPreserved);
                  return (
                    <span
                      key={note.noteUid}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                        isActiveAnchor
                          ? "border-red-300 bg-red-50 text-red-900"
                          : "border-slate-200 bg-slate-50 text-slate-800"
                      }`}
                    >
                      <span className="font-medium">{midiToPitchLabel(note.midi)}</span>
                      <span className="font-bold">{finger ?? "—"}</span>
                      {isActiveAnchor && (
                        <span className="text-[10px] font-semibold text-red-600">Anchor</span>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-slate-500">
              Click any warning item or Margin Risk Gutter bar to inspect a measure and onset slice.
            </p>
          )}
        </div>
      </section>
    </aside>
  );
}
