import type {
  AnchorOverride,
  Finger,
  HandSpanProfile,
  OnsetSlice,
  SolveResult,
} from "../domain/types";

export interface FullSolveWorkerRequest {
  type?: "solve";
  requestId: number;
  onsetSlices: OnsetSlice[];
  profile: HandSpanProfile;
  ignoreExistingFingerings?: boolean;
}

export interface LocalResolveWorkerRequest {
  type: "local-resolve";
  requestId: number;
  onsetSlices: OnsetSlice[];
  profile: HandSpanProfile;
  priorFingerByNoteUid: Record<string, Finger>;
  targetNoteUid: string;
  override: AnchorOverride | null;
  anchors: Record<string, AnchorOverride>;
  removedRawAnchorUids?: string[];
  ignoreExistingFingerings?: boolean;
}

export type WorkerRequest = FullSolveWorkerRequest | LocalResolveWorkerRequest;

export type WorkerResponse =
  | {
      requestId: number;
      ok: true;
      result: SolveResult;
    }
  | {
      requestId: number;
      ok: false;
      error: string;
    };
