import type { AnchorOverride, NoteCoordKey, ScoreDocument } from "../domain/types";
import { getNoteScoreCoord } from "./scoreCoord";
import { sha256 } from "./sha256";
import type { FingerAnchorDraft } from "./storagePort";

export interface NoteCoordIndex {
  keyByUid: Map<string, NoteCoordKey>;
  uidByKey: Map<NoteCoordKey, string>;
}

/** Source order breaks ties between unisons written at the same coordinate. */
export function buildNoteCoordIndex(score: ScoreDocument): NoteCoordIndex {
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

const EMPTY_BASELINE = sha256("[]");
const lexCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Snapshot all source fingering tags, including alternates and substitutions. */
export function computeSourceFingeringHash(
  score: ScoreDocument,
  elementsByUid: ReadonlyMap<string, readonly Element[]>,
): string {
  if (elementsByUid.size === 0) return EMPTY_BASELINE;
  const { keyByUid } = buildNoteCoordIndex(score);
  const entries = [];
  for (const [uid, elements] of elementsByUid) {
    const key = keyByUid.get(uid);
    if (key === undefined) continue;
    const tags = elements.map((el) => [
      (el.textContent ?? "").trim().replace(/\s+/g, " "),
      Array.from(el.attributes)
        .filter((attr) => attr.namespaceURI !== "http://www.w3.org/2000/xmlns/")
        .map((attr) => [attr.namespaceURI ?? "", attr.localName, attr.value])
        .sort((a, b) => lexCompare(a[0], b[0]) || lexCompare(a[1], b[1])),
    ]);
    entries.push({ key, tags });
  }
  entries.sort((a, b) => lexCompare(a.key, b.key));
  return sha256(JSON.stringify(entries.map(({ key, tags }) => [key, tags])));
}

export function hashSourceFingerings(score: ScoreDocument): string {
  if (score.sourceFingeringHash !== undefined) return score.sourceFingeringHash;
  const original = new Map<string, Element[]>();
  for (const [uid, element] of score.originalFingeringByUid ?? []) original.set(uid, [element]);
  return computeSourceFingeringHash(score, original);
}

export interface AnchorState {
  anchors: Record<string, AnchorOverride>;
  removedRawAnchorUids: string[];
}

export function captureDraft(pieceId: string, score: ScoreDocument, state: AnchorState, now: number): FingerAnchorDraft {
  const { keyByUid } = buildNoteCoordIndex(score);
  return {
    pieceId, sourceFingeringHash: hashSourceFingerings(score), updatedAtMs: now,
    anchorsByCoord: Object.fromEntries(Object.entries(state.anchors).flatMap(([uid, override]) => {
      const coord = keyByUid.get(uid);
      return coord === undefined ? [] : [[coord, override]];
    })),
    removedRawCoords: state.removedRawAnchorUids.flatMap((uid) => {
      const coord = keyByUid.get(uid);
      return coord === undefined ? [] : [coord];
    }),
  };
}

export function applyDraft(score: ScoreDocument, draft?: FingerAnchorDraft): AnchorState {
  const { uidByKey } = buildNoteCoordIndex(score);
  return {
    anchors: Object.fromEntries(Object.entries(draft?.anchorsByCoord ?? {}).flatMap(([coord, override]) => {
      const uid = uidByKey.get(coord);
      return uid === undefined ? [] : [[uid, override]];
    })),
    removedRawAnchorUids: (draft?.removedRawCoords ?? []).flatMap((coord) => {
      const uid = uidByKey.get(coord);
      return uid === undefined ? [] : [uid];
    }),
  };
}

export function remapAnchorState(previous: ScoreDocument, next: ScoreDocument, state: AnchorState): AnchorState {
  return applyDraft(next, captureDraft("", previous, state, 0));
}
