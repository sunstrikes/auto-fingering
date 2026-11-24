import { getNoteScoreCoord } from "./scoreCoord";
import type { NoteCoordKey, ScoreDocument } from "./types";

export type NoteCoordinates = Pick<ScoreDocument, "noteEvents" | "measureTimelines" | "ticksPerQuarter">;

export interface NoteCoordIndex {
  keyByUid: Map<string, NoteCoordKey>;
  uidByKey: Map<NoteCoordKey, string>;
}

/** Source order breaks ties between unisons written at the same coordinate. */
export function buildNoteCoordIndex(score: NoteCoordinates): NoteCoordIndex {
  const keyByUid = new Map<string, NoteCoordKey>();
  const uidByKey = new Map<NoteCoordKey, string>();
  const counts = new Map<string, number>();
  for (const note of score.noteEvents) {
    const { measureIndex, beatNum, beatDen, graceOrder } = getNoteScoreCoord(score, note);
    // Inferred hand may change after edits anywhere in a cross-staff voice.
    const hand = note.writtenHand ?? note.hand;
    const prefix = `${measureIndex}:${beatNum}/${beatDen}:${graceOrder ?? "m"}:${hand}:${note.midi}`;
    const occurrence = counts.get(prefix) ?? 0;
    counts.set(prefix, occurrence + 1);
    const key = `${prefix}:${occurrence}`;
    keyByUid.set(note.noteUid, key);
    uidByKey.set(key, note.noteUid);
  }
  return { keyByUid, uidByKey };
}
