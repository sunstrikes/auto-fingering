import type { StaticChunkingResult, StaticScoreInput } from "../chunking/types";

export interface AnalyzeStaticWorkerRequest {
  type: "analyze-static";
  requestId: number;
  input: StaticScoreInput;
}

export type ChunkingWorkerRequest = AnalyzeStaticWorkerRequest;

export type ChunkingWorkerResponse =
  | {
      requestId: number;
      ok: true;
      result: StaticChunkingResult;
    }
  | {
      requestId: number;
      ok: false;
      error: string;
    };
