#!/usr/bin/env node
import fs from "node:fs";
import moduleApi from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolve extensionless relative imports (e.g. "./assetValidation" -> "./assetValidation.ts")
// so Node.js >=22.12 can execute src/musescore/*.ts directly without a separate build step.
if (typeof moduleApi.registerHooks === "function") {
  moduleApi.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        !path.extname(specifier) &&
        context.parentURL?.startsWith("file:")
      ) {
        const parentDir = path.dirname(fileURLToPath(context.parentURL));
        const tsPath = path.resolve(parentDir, `${specifier}.ts`);
        if (fs.existsSync(tsPath)) {
          return nextResolve(pathToFileURL(tsPath).href, context);
        }
      }
      return nextResolve(specifier, context);
    },
  });
} else if (typeof moduleApi.register === "function") {
  const loaderSource = `
    import fs from "node:fs";
    import path from "node:path";
    import { fileURLToPath, pathToFileURL } from "node:url";
    export function resolve(specifier, context, nextResolve) {
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
        const parentDir = path.dirname(fileURLToPath(context.parentURL));
        const tsPath = path.resolve(parentDir, specifier + ".ts");
        if (fs.existsSync(tsPath)) {
          return nextResolve(pathToFileURL(tsPath).href, context);
        }
      }
      return nextResolve(specifier, context);
    }
  `;
  moduleApi.register(
    `data:text/javascript,${encodeURIComponent(loaderSource)}`,
    import.meta.url
  );
}

const { runCli } = await import("../src/musescore/cli.ts");
const exitCode = await runCli(process.argv.slice(2));
process.exitCode = exitCode;
