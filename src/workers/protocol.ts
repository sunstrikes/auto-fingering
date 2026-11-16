import type { HandSpanProfile, OnsetSlice, SolveResult } from "../domain/types";

export interface WorkerRequest {
  requestId: number;
  onsetSlices: OnsetSlice[];
  profile: HandSpanProfile;
}

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
