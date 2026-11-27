import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: 4,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/solver/**/*.ts",
        "src/domain/{measureHashes,noteCoordIndex,scoreCoord,sha256}.ts",
        "src/musicxml/**/*.ts",
        "src/midi/**/*.ts",
        "src/persistence/**/*.ts",
        "src/practice/**/*.ts",
        "src/chunking/**/*.ts",
        "src/workers/chunkingClient.ts",
        "src/workers/chunkingHandler.ts",
        "src/guided/**/*.ts",
        "src/coach/**/*.ts",
      ],
      exclude: ["src/practice/useScreenWakeLock.ts"],
      reporter: ["text", "json-summary"],
    },
  },
});
