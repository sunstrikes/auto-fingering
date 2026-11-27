import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { parseMusicXml } from "../src/musicxml/parser";
import {
  ChunkingCancelledError,
  createChunkingClient,
  toStaticScoreInput,
  type ChunkingWorkerLike,
} from "../src/workers/chunkingClient";
import { handleChunkingWorkerRequest } from "../src/workers/chunkingHandler";
import type {
  ChunkingWorkerRequest,
  ChunkingWorkerResponse,
} from "../src/workers/chunkingProtocol";

describe("workers seam: createChunkingClient & chunking.worker", () => {
  it("strips XML DOM objects via toStaticScoreInput so payloads are structuredClone-safe", () => {
    const xmlText = readFileSync(
      resolve(__dirname, "../test-corpus/01-single-staff-melody.musicxml"),
      "utf-8",
    );
    const { DOMParser } = new JSDOM("").window;
    const scoreDoc = parseMusicXml(xmlText, { DOMParser });

    const staticInput = toStaticScoreInput(scoreDoc);
    expect("xmlDoc" in staticInput).toBe(false);
    expect("noteElementsByUid" in staticInput).toBe(false);
    expect("originalFingeringByUid" in staticInput).toBe(false);
    expect(staticInput.measureCount).toBe(scoreDoc.measureCount);
    expect(staticInput.noteEvents.length).toBe(scoreDoc.noteEvents.length);
    expect(() => structuredClone(staticInput)).not.toThrow();
  });

  it("executes analyzeStatic through injectable ChunkingWorkerLike and cancels superseded requests", async () => {
    const xmlText = readFileSync(
      resolve(__dirname, "../test-corpus/01-single-staff-melody.musicxml"),
      "utf-8",
    );
    const { DOMParser } = new JSDOM("").window;
    const scoreDoc = parseMusicXml(xmlText, { DOMParser });
    const staticInput = toStaticScoreInput(scoreDoc);

    const queue: Array<() => void> = [];
    const terminateSpy = vi.fn();

    const fakeWorker: ChunkingWorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg: unknown) {
        const req = msg as ChunkingWorkerRequest;
        queue.push(() => {
          const resp = handleChunkingWorkerRequest(req);
          fakeWorker.onmessage?.({ data: resp } as MessageEvent<ChunkingWorkerResponse>);
        });
      },
      terminate: terminateSpy,
    };

    const client = createChunkingClient(() => fakeWorker);

    const p1 = client.analyzeStatic(staticInput);
    const p2 = client.analyzeStatic(staticInput);

    await expect(p1).rejects.toBeInstanceOf(ChunkingCancelledError);

    // Flush both stale #1 and active #2 responses
    queue.forEach((fn) => fn());

    const result = await p2;
    expect(result.measureCount).toBe(4);
    expect(result.macroSections.length).toBeGreaterThanOrEqual(1);
    expect(result.motorChunks.length).toBeGreaterThanOrEqual(1);

    client.dispose();
    expect(terminateSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects active requests on worker errors, failed responses, or dispose()", async () => {
    const fakeWorker: ChunkingWorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage() {},
      terminate: vi.fn(),
    };

    const client = createChunkingClient(() => fakeWorker);

    const pErr = client.analyzeStatic({
      noteEvents: [],
      onsetSlices: [],
      measureTimelines: [],
      ticksPerQuarter: 480,
      measureCount: 0,
    });
    fakeWorker.onerror?.({ message: "boom" } as ErrorEvent);
    await expect(pErr).rejects.toThrow("boom");

    const pFailResp = client.analyzeStatic({
      noteEvents: [],
      onsetSlices: [],
      measureTimelines: [],
      ticksPerQuarter: 480,
      measureCount: 0,
    });
    fakeWorker.onmessage?.({
      data: { requestId: 2, ok: false, error: "bad input" },
    } as MessageEvent<ChunkingWorkerResponse>);
    await expect(pFailResp).rejects.toThrow("bad input");

    const pDispose = client.analyzeStatic({
      noteEvents: [],
      onsetSlices: [],
      measureTimelines: [],
      ticksPerQuarter: 480,
      measureCount: 0,
    });
    client.dispose();
    await expect(pDispose).rejects.toBeInstanceOf(ChunkingCancelledError);
  });

  it("handleChunkingWorkerRequest catches thrown errors cleanly", () => {
    const resp = handleChunkingWorkerRequest({
      type: "analyze-static",
      requestId: 7,
      input: null as unknown as Parameters<typeof handleChunkingWorkerRequest>[0]["input"],
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.requestId).toBe(7);
      expect(resp.error.length).toBeGreaterThan(0);
    }
  });
});
