import type { NoteEvent } from "./types";

/**
 * Aggregates the full tie-chain end position (`tick` or `sec`) keyed by each struck root NoteEvent's `noteUid`.
 */
export function computeTieChainEndByRoot(
  noteEvents: readonly NoteEvent[],
  unit: "tick" | "sec"
): Map<string, number> {
  const endByRoot = new Map<string, number>();
  for (const ev of noteEvents) {
    if (ev.isGrace) continue;
    const evEnd =
      unit === "tick" ? ev.onsetTick + ev.durationTick : ev.onsetSec + ev.durationSec;
    const rootUid = !ev.isTieStop ? ev.noteUid : ev.tieChainRootUid;
    if (!rootUid) continue;
    const prev = endByRoot.get(rootUid) ?? 0;
    if (evEnd > prev) {
      endByRoot.set(rootUid, evEnd);
    }
  }
  return endByRoot;
}
