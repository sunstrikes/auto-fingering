import { useEffect, useState } from "react";
import type {
  AnchorOverride,
  AnchorOverrideMode,
  Finger,
  Hand,
  HandSpanProfile,
  NoteEvent,
  OnsetSlice,
  TransitionCue,
} from "../domain/types";
import type { NoteDiffEntry } from "../store/useStudioStore";
import { midiToPitchLabel } from "../solver/keyboard";

export interface InspectorPanelProps {
  warnings: TransitionCue[];
  onsetSlices: OnsetSlice[];
  noteEvents?: NoteEvent[];
  fingerByNoteUid: Record<string, Finger>;
  handSpanProfile: HandSpanProfile;
  selectedSliceId: string | null;
  selectedMeasureIndex: number | null;
  selectedNoteUid?: string | null;
  anchors?: Record<string, AnchorOverride>;
  removedRawAnchorUids?: string[];
  lastDiff?: NoteDiffEntry[];
  canUndo?: boolean;
  canRedo?: boolean;
  isResolving?: boolean;
  ignoreExistingFingerings: boolean;
  hasScore: boolean;
  onSelectWarning: (cue: TransitionCue) => void;
  onSelectNote?: (noteUid: string) => void;
  onSetAnchor?: (noteUid: string, finger: Finger, mode: AnchorOverrideMode) => void;
  onRemoveAnchor?: (noteUid: string) => void;
  onUndo?: () => void;
  onRedo?: () => void;
}

const FINGERS: Finger[] = [1, 2, 3, 4, 5];

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
 * Sticky right-hand Inspector panel housing scrollable TransitionCue warnings,
 * the Selected Onset Slice / Note Event 1-5 anchor editor, and Before -> After Diff card.
 */
export function InspectorPanel({
  warnings,
  onsetSlices,
  noteEvents,
  fingerByNoteUid,
  handSpanProfile,
  selectedSliceId,
  selectedMeasureIndex,
  selectedNoteUid = null,
  anchors = {},
  removedRawAnchorUids = [],
  lastDiff = [],
  canUndo = false,
  canRedo = false,
  isResolving = false,
  ignoreExistingFingerings,
  hasScore,
  onSelectWarning,
  onSelectNote,
  onSetAnchor,
  onRemoveAnchor,
  onUndo,
  onRedo,
}: InspectorPanelProps) {
  const sortedWarnings = sortWarningsForNavigation(warnings, onsetSlices);
  const dangerCount = sortedWarnings.filter((w) => w.severity === "danger").length;
  const warnCount = sortedWarnings.length - dangerCount;

  const selectedSlice =
    selectedSliceId !== null
      ? onsetSlices.find((s) => s.sliceId === selectedSliceId) ?? null
      : null;

  const allNotes = noteEvents ?? onsetSlices.flatMap((s) => s.notes);
  const directNote =
    selectedNoteUid !== null && selectedNoteUid !== undefined
      ? allNotes.find((n) => n.noteUid === selectedNoteUid) ?? null
      : null;
  const selectedNote = directNote ?? selectedSlice?.notes[0] ?? null;

  const [overrideMode, setOverrideMode] = useState<AnchorOverrideMode>("phrase");
  const selectedUserAnchor = selectedNote ? anchors[selectedNote.noteUid] : undefined;

  useEffect(() => {
    setOverrideMode(selectedUserAnchor?.mode ?? "phrase");
  }, [selectedNote?.noteUid, selectedUserAnchor?.mode]);

  const removedRawSet = new Set(removedRawAnchorUids);
  const hasRawAnchor = Boolean(
    selectedNote &&
      selectedNote.anchorFinger !== undefined &&
      !removedRawSet.has(selectedNote.noteUid) &&
      !(ignoreExistingFingerings && selectedNote.anchorRawPreserved)
  );
  const hasAnyAnchor = Boolean(selectedUserAnchor || hasRawAnchor);
  const currentFinger =
    selectedNote && !selectedNote.isTieStop ? fingerByNoteUid[selectedNote.noteUid] : undefined;

  const handleTogglePinOnly = () => {
    const nextMode: AnchorOverrideMode = overrideMode === "pinOnly" ? "phrase" : "pinOnly";
    setOverrideMode(nextMode);
    if (
      selectedNote &&
      !selectedNote.isTieStop &&
      selectedUserAnchor &&
      selectedUserAnchor.mode !== nextMode
    ) {
      onSetAnchor?.(selectedNote.noteUid, selectedUserAnchor.finger, nextMode);
    }
  };

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

        <div className="max-h-72 overflow-y-auto p-3">
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
            Selected Note &amp; Slice
          </h3>
          {selectedMeasureIndex !== null && (
            <span className="text-xs font-medium text-slate-700">
              Measure {selectedMeasureIndex + 1}
            </span>
          )}
        </header>
        <div className="space-y-3 p-3 text-xs text-slate-600">
          {selectedSlice && (
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
                  const userAnc = anchors[note.noteUid];
                  const isActiveAnchor =
                    Boolean(userAnc) ||
                    (note.anchorFinger !== undefined &&
                      !removedRawSet.has(note.noteUid) &&
                      !(ignoreExistingFingerings && note.anchorRawPreserved));
                  const isSelectedNote = selectedNote?.noteUid === note.noteUid;
                  return (
                    <button
                      key={note.noteUid}
                      type="button"
                      onClick={() => onSelectNote?.(note.noteUid)}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition ${
                        isSelectedNote
                          ? "border-blue-500 bg-blue-50 text-blue-900 ring-1 ring-blue-500"
                          : isActiveAnchor
                            ? "border-red-300 bg-red-50 text-red-900"
                            : "border-slate-200 bg-slate-50 text-slate-800 hover:border-slate-300"
                      }`}
                    >
                      <span className="font-medium">{midiToPitchLabel(note.midi)}</span>
                      <span className="font-bold">{finger ?? "—"}</span>
                      {isActiveAnchor && (
                        <span className="text-[10px] font-semibold text-red-600">
                          {userAnc?.mode === "pinOnly" ? "Pin" : "Anchor"}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {selectedNote ? (
            selectedNote.isTieStop ? (
              <div
                data-testid="tie-continuation-notice"
                className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-700"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-900">
                    {midiToPitchLabel(selectedNote.midi)} · m.{selectedNote.measureIndex + 1} · {selectedNote.hand}
                  </span>
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                    Tie Continuation
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">
                  Tie Continuation sustains the preceding tied note and receives no independent{" "}
                  <code>&lt;fingering&gt;</code>.
                </p>
                {selectedNote.tieChainRootUid && onSelectNote && (
                  <button
                    type="button"
                    onClick={() => onSelectNote(selectedNote.tieChainRootUid!)}
                    className="mt-2 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                  >
                    Jump to tied start note
                  </button>
                )}
              </div>
            ) : (
              <div
                data-testid="selected-note-editor"
                className="rounded-lg border border-slate-200 bg-slate-50/70 p-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <span className="font-semibold text-slate-900">
                      {midiToPitchLabel(selectedNote.midi)}
                    </span>{" "}
                    <span className="text-slate-500">
                      · m.{selectedNote.measureIndex + 1} · {selectedNote.hand}
                    </span>
                  </div>
                  <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-800">
                    Finger {currentFinger ?? "—"}
                    {selectedUserAnchor
                      ? ` (${selectedUserAnchor.mode})`
                      : hasRawAnchor
                        ? " (XML)"
                        : ""}
                  </span>
                </div>

                <div className="mt-2 grid grid-cols-5 gap-1.5">
                  {FINGERS.map((f) => {
                    const isCurrent = currentFinger === f;
                    const isAnchored =
                      selectedUserAnchor?.finger === f ||
                      (!selectedUserAnchor && hasRawAnchor && selectedNote.anchorFinger === f);
                    return (
                      <button
                        key={f}
                        type="button"
                        data-testid={`finger-btn-${f}`}
                        disabled={isResolving || !onSetAnchor}
                        aria-pressed={isCurrent}
                        onClick={() => onSetAnchor?.(selectedNote.noteUid, f, overrideMode)}
                        className={`rounded-md border py-1.5 text-center text-xs font-bold transition ${
                          isAnchored
                            ? "border-red-500 bg-red-600 text-white"
                            : isCurrent
                              ? "border-blue-600 bg-blue-600 text-white"
                              : "border-slate-300 bg-white text-slate-800 hover:border-blue-400 hover:bg-blue-50"
                        } disabled:cursor-not-allowed disabled:opacity-50`}
                      >
                        {f}
                      </button>
                    );
                  })}
                </div>

                <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5">
                  <button
                    type="button"
                    data-testid="pin-only-toggle"
                    aria-pressed={overrideMode === "pinOnly"}
                    disabled={isResolving}
                    onClick={handleTogglePinOnly}
                    className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition ${
                      overrideMode === "pinOnly"
                        ? "border-indigo-500 bg-indigo-50 text-indigo-800"
                        : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                    }`}
                    title="Toggle between phrase-bounded DP re-solve and single-note pinOnly override"
                  >
                    仅锁单音 (pinOnly){overrideMode === "pinOnly" ? " ✓" : ""}
                  </button>

                  <button
                    type="button"
                    data-testid="remove-anchor-btn"
                    disabled={isResolving || !hasAnyAnchor || !onRemoveAnchor}
                    onClick={() => onRemoveAnchor?.(selectedNote.noteUid)}
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    Remove Anchor
                  </button>
                </div>
              </div>
            )
          ) : (
            <p className="text-slate-500">
              Click any notehead on the score, warning item, or Margin Risk Gutter bar to inspect and edit fingerings.
            </p>
          )}
        </div>
      </section>

      <section
        data-testid="diff-card"
        className="rounded-xl border border-slate-200 bg-white shadow-sm"
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Before → After Diff
            </h3>
            {lastDiff.length > 0 && (
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold text-violet-700">
                {lastDiff.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="inspector-undo-btn"
              disabled={!canUndo}
              onClick={() => onUndo?.()}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Undo
            </button>
            <button
              type="button"
              data-testid="inspector-redo-btn"
              disabled={!canRedo}
              onClick={() => onRedo?.()}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Redo
            </button>
          </div>
        </header>
        <div className="max-h-44 overflow-y-auto p-3 text-xs">
          {lastDiff.length === 0 ? (
            <p className="text-slate-500">
              No manual anchor changes yet. Override any note (1–5) to inspect affected fingerings.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {lastDiff.map((d) => (
                <li key={d.noteUid}>
                  <button
                    type="button"
                    onClick={() => onSelectNote?.(d.noteUid)}
                    className="flex w-full items-center justify-between rounded-md bg-violet-50 px-2.5 py-1.5 text-left text-violet-900 transition hover:bg-violet-100"
                  >
                    <span className="font-medium">
                      m.{d.measureIndex + 1} · {d.pitchLabel} ({d.hand})
                    </span>
                    <span className="font-mono font-bold text-violet-700">
                      {d.before ?? "—"} → {d.after ?? "—"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </aside>
  );
}
