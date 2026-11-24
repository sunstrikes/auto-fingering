import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/solver/**/*.ts",
        "src/musicxml/**/*.ts",
        "src/midi/**/*.ts",
        "src/persistence/**/*.ts",
        "src/practice/**/*.ts",
      ],
      exclude: ["src/practice/useScreenWakeLock.ts"],
      reporter: ["text", "json-summary"],
    },
  },
});
