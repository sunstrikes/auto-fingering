// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HAND_SPAN_PROFILE } from "../src/domain/types";

const originalOnMessage = window.onmessage;

afterEach(() => {
  window.onmessage = originalOnMessage;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("worker entrypoint isolation", () => {
  it.each(["chunking", "fingering"])(
    "importing %s.worker on the main thread does not overwrite window.onmessage",
    async (name) => {
      const onMessage = vi.fn();
      window.onmessage = onMessage;
      vi.resetModules();

      if (name === "chunking") {
        await import("../src/workers/chunking.worker");
      } else {
        await import("../src/workers/fingering.worker");
      }

      expect(window.onmessage).toBe(onMessage);
    },
  );

  it("importing the chunking hook does not install a window message handler", async () => {
    const onMessage = vi.fn();
    window.onmessage = onMessage;
    vi.resetModules();

    await import("../src/hooks/useChunkingAnalysis");

    expect(window.onmessage).toBe(onMessage);
  });

  it.each(["chunking", "fingering"])(
    "%s entrypoint still replies when running in a dedicated worker",
    async (name) => {
      vi.resetModules();
      vi.stubGlobal("DedicatedWorkerGlobalScope", class {
        static [Symbol.hasInstance](value: unknown) {
          return value === globalThis;
        }
      });
      const postMessage = vi.fn();
      vi.stubGlobal("postMessage", postMessage);

      if (name === "chunking") {
        await import("../src/workers/chunking.worker");
        window.onmessage?.(new MessageEvent("message", {
          data: {
            type: "analyze-static",
            requestId: 17,
            input: {
              noteEvents: [], onsetSlices: [], measureTimelines: [],
              ticksPerQuarter: 480, measureCount: 0,
            },
          },
        }));
      } else {
        await import("../src/workers/fingering.worker");
        window.onmessage?.(new MessageEvent("message", {
          data: { requestId: 17, onsetSlices: [], profile: DEFAULT_HAND_SPAN_PROFILE },
        }));
      }

      expect(postMessage).toHaveBeenCalledOnce();
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: 17, ok: true }));
    },
  );

  it("a DedicatedWorkerGlobalScope constructor alone does not make Window a worker", async () => {
    vi.resetModules();
    vi.stubGlobal("DedicatedWorkerGlobalScope", class {});
    const onMessage = vi.fn();
    window.onmessage = onMessage;

    await import("../src/workers/chunking.worker");
    await import("../src/workers/fingering.worker");

    expect(window.onmessage).toBe(onMessage);
  });
});
