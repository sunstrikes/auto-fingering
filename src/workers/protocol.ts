import type {
  AnchorOverride,
  Finger,
  HandSpanProfile,
  OnsetSlice,
  PriorMode,
  SolveResult,
} from "../domain/types";

export interface FullSolveWorkerRequest {
  type?: "solve";
  requestId: number;
  onsetSlices: OnsetSlice[];
  profile: HandSpanProfile;
  ignoreExistingFingerings?: boolean;
  priorMode?: PriorMode;
  lambda?: number;
  customModelBaseUrl?: string;
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
  priorMode?: PriorMode;
  lambda?: number;
  customModelBaseUrl?: string;
}

export interface LoadPriorWorkerRequest {
  type: "load-prior";
  requestId: number;
  onsetSlices: OnsetSlice[];
  profile: HandSpanProfile;
  ignoreExistingFingerings?: boolean;
  customModelBaseUrl?: string;
}

export type WorkerRequest =
  | FullSolveWorkerRequest
  | LocalResolveWorkerRequest
  | LoadPriorWorkerRequest;

export type WorkerProgressMessage = {
  requestId: number;
  type: "prior-progress";
  loadedBytes: number;
  totalBytes: number;
};

export type WorkerResponse =
  | WorkerProgressMessage
  | {
      requestId: number;
      ok: true;
      result: SolveResult;
      priorReady?: boolean;
    }
  | {
      requestId: number;
      type: "prior-ready";
      ok: true;
      priorReady: true;
    }
  | {
      requestId: number;
      ok: false;
      error: string;
    };
