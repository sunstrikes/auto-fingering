import type { AnchorOverride, ScoreDocument } from "../domain/types";
import { buildNoteCoordIndex, type NoteCoordinates } from "../domain/noteCoordIndex";
import { sha256 } from "../domain/sha256";
import type { FingerAnchorDraft } from "./storagePort";

export { buildNoteCoordIndex } from "../domain/noteCoordIndex";

type AnchorSource = NoteCoordinates & Pick<ScoreDocument, "sourceFingeringHash">;
const EMPTY_BASELINE = sha256("[]");

export function hashSourceFingerings(score: Pick<ScoreDocument, "sourceFingeringHash">): string {
  return score.sourceFingeringHash ?? EMPTY_BASELINE;
}

export interface AnchorState {
  anchors: Record<string, AnchorOverride>;
  removedRawAnchorUids: string[];
}

export function captureDraft(pieceId: string, score: AnchorSource, state: AnchorState, now: number): FingerAnchorDraft {
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

export function applyDraft(score: NoteCoordinates, draft?: FingerAnchorDraft): AnchorState {
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

export function remapAnchorState(previous: AnchorSource, next: NoteCoordinates, state: AnchorState): AnchorState {
  return applyDraft(next, captureDraft("", previous, state, 0));
}
