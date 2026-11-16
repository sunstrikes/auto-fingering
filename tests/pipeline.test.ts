import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { DEFAULT_HAND_SPAN_PROFILE } from "../src/domain/types";
import { parseMusicXml } from "../src/musicxml/parser";
import { writeFingeringsToScore, serializeScoreDocument } from "../src/musicxml/writer";
import { solveFingering } from "../src/solver/solveFingering";
import { createSolverClient, type WorkerLike } from "../src/workers/solverClient";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";

function createInProcessWorker(): WorkerLike {
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(msg: unknown) {
      const req = msg as WorkerRequest;
      queueMicrotask(() => {
        const result = solveFingering(req.onsetSlices, req.profile);
        const resp: WorkerResponse = { requestId: req.requestId, ok: true, result };
        worker.onmessage?.({ data: resp } as MessageEvent<WorkerResponse>);
      });
    },
    terminate() {},
  };
  return worker;
}

describe("walking skeleton end-to-end headless pipeline", () => {
  it("parses, solves via worker RPC, writes MusicXML 4.0 fingerings, exports, and reloads cleanly", async () => {
    const xmlText = readFileSync(
      resolve(__dirname, "../test-corpus/01-single-staff-melody.musicxml"),
      "utf-8"
    );
    const { DOMParser, XMLSerializer } = new JSDOM("").window;

    const scoreDoc = parseMusicXml(xmlText, { DOMParser });
    const client = createSolverClient(createInProcessWorker);
    const solveResult = await client.solve(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    client.dispose();

    writeFingeringsToScore(scoreDoc, solveResult.fingerByNoteUid);
    const exportedXml = serializeScoreDocument(scoreDoc, { XMLSerializer });

    expect(exportedXml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(exportedXml).toContain("<!DOCTYPE score-partwise");
    expect(exportedXml).not.toContain('xmlns=""');

    const reloaded = parseMusicXml(exportedXml, { DOMParser });
    expect(reloaded.noteEvents).toHaveLength(18);
    expect(reloaded.noteEvents.slice(0, 8).map((n) => n.anchorFinger)).toEqual([
      1, 2, 3, 1, 2, 3, 4, 5,
    ]);
    expect(reloaded.noteEvents.every((n) => n.anchorFinger !== undefined)).toBe(true);
  });
});
