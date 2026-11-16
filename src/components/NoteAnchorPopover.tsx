import { useEffect, useState } from "react";
import type {
  AnchorOverride,
  AnchorOverrideMode,
  Finger,
  NoteEvent,
} from "../domain/types";
import { midiToPitchLabel } from "../solver/keyboard";

export interface PopoverAnchorRect {
  left: number;
  top: number;
  height: number;
}

export interface NoteAnchorPopoverProps {
  note: NoteEvent | null;
  fingerByNoteUid: Record<string, Finger>;
  anchors?: Record<string, AnchorOverride>;
  removedRawAnchorUids?: string[];
  repairedAnchorUids?: string[];
  ignoreExistingFingerings: boolean;
  isResolving?: boolean;
  anchorRect?: PopoverAnchorRect | null;
  onSetAnchor: (noteUid: string, finger: Finger, mode: AnchorOverrideMode) => void;
  onRemoveAnchor: (noteUid: string) => void;
  onPlayFromHere?: () => void;
  onClose: () => void;
}

const FINGERS: Finger[] = [1, 2, 3, 4, 5];

/**
 * Floating inline Note Anchor editor anchored beside the clicked notehead in the score.
 * Replaces the sidebar InspectorPanel note editor for direct score-surface editing.
 */
export function NoteAnchorPopover({
  note,
  fingerByNoteUid,
  anchors = {},
  removedRawAnchorUids = [],
  repairedAnchorUids = [],
  ignoreExistingFingerings,
  isResolving = false,
  anchorRect = null,
  onSetAnchor,
  onRemoveAnchor,
  onPlayFromHere,
  onClose,
}: NoteAnchorPopoverProps) {
  const userAnchor = note ? anchors[note.noteUid] : undefined;
  const [overrideMode, setOverrideMode] = useState<AnchorOverrideMode>("phrase");

  useEffect(() => {
    setOverrideMode(userAnchor?.mode ?? "phrase");
  }, [note?.noteUid, userAnchor?.mode]);

  if (!note) return null;

  const removedRawSet = new Set(removedRawAnchorUids);
  const repairedSet = new Set(repairedAnchorUids);
  const hasRawAnchor = Boolean(
    note.anchorFinger !== undefined &&
      !removedRawSet.has(note.noteUid) &&
      !(ignoreExistingFingerings && note.anchorRawPreserved)
  );
  const hasAnyAnchor = Boolean(userAnchor || hasRawAnchor);
  const isConflict = repairedSet.has(note.noteUid);
  const currentFinger = !note.isTieStop ? fingerByNoteUid[note.noteUid] : undefined;

  const handleTogglePinOnly = () => {
    const nextMode: AnchorOverrideMode = overrideMode === "pinOnly" ? "phrase" : "pinOnly";
    setOverrideMode(nextMode);
    if (userAnchor) {
      onSetAnchor(note.noteUid, userAnchor.finger, nextMode);
    }
  };

  // Clamp floating coordinates comfortably inside browser viewport
  const winW = typeof window !== "undefined" ? window.innerWidth : 1280;
  const winH = typeof window !== "undefined" ? window.innerHeight : 760;
  const popoverW = 296;
  const popoverH = 195;

  const style: React.CSSProperties | undefined = anchorRect
    ? {
        position: "fixed",
        left: `${Math.max(12, Math.min(winW - popoverW - 12, anchorRect.left - popoverW / 2))}px`,
        top: `${
          anchorRect.top + anchorRect.height + 10 + popoverH <= winH - 16
            ? anchorRect.top + anchorRect.height + 10
            : Math.max(12, anchorRect.top - popoverH - 10)
        }px`,
        width: `${popoverW}px`,
        zIndex: 40,
      }
    : undefined;

  return (
    <div
      role="dialog"
      aria-label="Note anchor popover"
      data-testid="note-anchor-popover"
      style={style}
      className={`${
        anchorRect ? "" : "absolute right-4 top-12 z-40 w-72"
      } rounded-xl border border-slate-300 bg-white/95 p-3 shadow-xl backdrop-blur-sm`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
            <span>
              m.{note.measureIndex + 1} · {midiToPitchLabel(note.midi)}
            </span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                note.hand === "RH"
                  ? "bg-teal-50 text-teal-800"
                  : "bg-indigo-50 text-indigo-800"
              }`}
            >
              {note.hand}
            </span>
            {currentFinger !== undefined && (
              <span
                data-testid="popover-current-finger"
                className="rounded-full bg-slate-900 px-1.5 py-0.5 text-[10px] font-bold text-white"
              >
                {currentFinger}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            {userAnchor
              ? `User anchor (${userAnchor.mode === "pinOnly" ? "Pin Only" : "Phrase"})`
              : hasRawAnchor
                ? `Score XML anchor (${note.anchorFinger})`
                : "Auto-deduced fingering"}
            {isConflict && (
              <span className="ml-1.5 font-semibold text-red-600">· Repaired conflict</span>
            )}
          </div>
        </div>

        <button
          type="button"
          data-testid="popover-close-btn"
          onClick={onClose}
          aria-label="Close note popover"
          className="rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          ✕
        </button>
      </div>

      {note.isTieStop ? (
        <div
          data-testid="popover-tie-notice"
          className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[11px] text-slate-600"
        >
          Tie continuation sustains from its preceding note and does not take a new 1–5 finger strike.
        </div>
      ) : (
        <div className="space-y-2.5">
          <div className="grid grid-cols-5 gap-1.5" role="group" aria-label="Assign finger 1 to 5">
            {FINGERS.map((f) => {
              const isSelected = currentFinger === f;
              return (
                <button
                  key={f}
                  type="button"
                  data-testid={`finger-btn-${f}`}
                  aria-pressed={isSelected}
                  disabled={isResolving}
                  onClick={() => onSetAnchor(note.noteUid, f, overrideMode)}
                  className={`rounded-lg border py-1.5 text-xs font-bold transition ${
                    isSelected
                      ? "border-slate-900 bg-slate-900 text-white shadow-xs"
                      : "border-slate-300 bg-white text-slate-800 hover:bg-slate-100"
                  } disabled:opacity-50`}
                >
                  {f}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <button
              type="button"
              data-testid="pin-only-toggle"
              aria-pressed={overrideMode === "pinOnly"}
              disabled={isResolving}
              onClick={handleTogglePinOnly}
              className={`rounded-md border px-2 py-1 text-[11px] font-medium transition ${
                overrideMode === "pinOnly"
                  ? "border-amber-400 bg-amber-50 text-amber-900"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
              }`}
              title="Pin Only locks just this note; Phrase locally re-solves surrounding notes"
            >
              {overrideMode === "pinOnly" ? "Pin Only" : "Phrase Re-solve"}
            </button>

            <div className="flex items-center gap-1">
              {onPlayFromHere && (
                <button
                  type="button"
                  data-testid="popover-play-from-btn"
                  onClick={onPlayFromHere}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                >
                  Play here
                </button>
              )}
              <button
                type="button"
                data-testid="remove-anchor-btn"
                disabled={!hasAnyAnchor || isResolving}
                onClick={() => onRemoveAnchor(note.noteUid)}
                className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Unpin
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
