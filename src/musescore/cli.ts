import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { exportMxlContainer } from "../musicxml/mxl";
import {
  downloadMuseScoreAssets,
  downloadMuseScorePdf,
  parseMuseScoreInput,
  shouldUseBrowserMode,
  svgsToPdfViaBrowser,
} from "./downloader";
import { svgsAndMidiToMusicXml } from "./index";
import type { ConversionDiagnostics } from "./types";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: Record<string, string | undefined>;
}

interface ParsedArgs {
  help: boolean;
  target?: string;
  outPath?: string;
  pdfPath?: string;
  format?: "musicxml" | "mxl";
  cookie?: string;
  headers: Record<string, string>;
  title?: string;
  baseOrigin?: string;
  mode?: "auto" | "browser" | "fetch";
  headless: boolean;
  profile?: string;
  json: boolean;
}

const USAGE = `Usage: musescore-import <url-or-score-id> [options]

Fetch MuseScore 4 SVG/PNG pages + MIDI and convert to MusicXML 4.0 (.musicxml / .mxl).
Uses msdl-style persistent Chrome browser session by default to clear Cloudflare challenges.

Options:
  -o, --out <path>          Output file path (.musicxml or .mxl)
  --pdf <path>              Also download MuseScore PDF to <path>
  --format <musicxml|mxl>   Output format (inferred from -o extension if omitted)
  --headless                Run Chrome in headless mode (requires cached cf_clearance)
  --profile <dir>           Persistent Chrome profile dir (default: ~/.cache/msdl/profile)
  --fetch                   Use pure Node.js fetch instead of Chrome browser session
  --cookie <cookie>         Browser session Cookie header (or MUSESCORE_COOKIE env, --fetch mode)
  --header <Key: Value>     Extra HTTP header for MuseScore origin (repeatable, --fetch mode)
  --title <title>           Override output score title
  --base-origin <origin>    Override base origin (default: https://musescore.com)
  --json                    Print diagnostic summary as JSON
  -h, --help                Show this help message
`;

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    headers: {},
    headless: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      return parsed;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--headless") {
      parsed.headless = true;
      continue;
    }
    if (arg === "--fetch") {
      parsed.mode = "fetch";
      continue;
    }
    if (arg === "--profile") {
      const val = argv[++i];
      if (!val) throw new Error("Missing value for --profile");
      parsed.profile = val;
      continue;
    }
    if (arg === "-o" || arg === "--out") {
      const val = argv[++i];
      if (!val) throw new Error(`Missing value for ${arg}`);
      parsed.outPath = val;
      continue;
    }
    if (arg === "--pdf") {
      const val = argv[++i];
      if (!val) throw new Error("Missing value for --pdf");
      parsed.pdfPath = val;
      continue;
    }
    if (arg === "--format") {
      const val = argv[++i]?.toLowerCase();
      if (val !== "musicxml" && val !== "mxl") {
        throw new Error(`Invalid --format "${val ?? ""}" (expected "musicxml" or "mxl")`);
      }
      parsed.format = val;
      continue;
    }
    if (arg === "--cookie") {
      const val = argv[++i];
      if (val === undefined) throw new Error("Missing value for --cookie");
      parsed.cookie = val;
      continue;
    }
    if (arg === "--header") {
      const val = argv[++i];
      if (!val) throw new Error("Missing value for --header");
      const colonIdx = val.indexOf(":");
      if (colonIdx <= 0) {
        throw new Error(`Invalid --header "${val}" (expected "Key: Value")`);
      }
      const key = val.slice(0, colonIdx).trim();
      const headerVal = val.slice(colonIdx + 1).trim();
      parsed.headers[key] = headerVal;
      continue;
    }
    if (arg === "--title") {
      const val = argv[++i];
      if (val === undefined) throw new Error("Missing value for --title");
      parsed.title = val;
      continue;
    }
    if (arg === "--base-origin") {
      const val = argv[++i];
      if (!val) throw new Error("Missing value for --base-origin");
      parsed.baseOrigin = val;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (parsed.target !== undefined) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    parsed.target = arg;
  }

  return parsed;
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "score";
}

function buildDiagnosticSummary(
  diagnostics: ConversionDiagnostics,
  outPath: string,
  format: "musicxml" | "mxl",
  pdfPath?: string
) {
  return {
    outputPath: outPath,
    ...(pdfPath !== undefined ? { pdfPath } : {}),
    format,
    totalPages: diagnostics.totalPages,
    svgPagesParsed: diagnostics.svgPagesParsed,
    pngPagesSkipped: diagnostics.pngPagesSkipped,
    measuresAligned: diagnostics.measuresAligned,
    alignmentConfidence: diagnostics.alignmentConfidence,
    warnings: diagnostics.warnings.map((w) => ({
      code: w.code,
      message: w.message,
      ...(w.measureNumber !== undefined ? { measureNumber: w.measureNumber } : {}),
      ...(w.pageIndex !== undefined ? { pageIndex: w.pageIndex } : {}),
    })),
  };
}

function formatTextSummary(summary: ReturnType<typeof buildDiagnosticSummary>): string {
  const lines = [
    `Wrote ${summary.format.toUpperCase()} to ${summary.outputPath}`,
    ...(summary.pdfPath ? [`Wrote PDF to ${summary.pdfPath}`] : []),
    `svgPagesParsed: ${summary.svgPagesParsed}`,
    `pngPagesSkipped: ${summary.pngPagesSkipped}`,
    `measuresAligned: ${summary.measuresAligned}`,
    `warnings: ${summary.warnings.length}`,
  ];
  for (const w of summary.warnings) {
    lines.push(`  - [${w.code}] ${w.message}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Run the MuseScore import CLI with the given arguments. Returns an exit code.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
  }
): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (args.help) {
    io.stdout(USAGE);
    return 0;
  }

  if (!args.target) {
    io.stderr("Missing required <url-or-score-id> argument.\n\n" + USAGE);
    return 1;
  }

  const cookie = args.cookie ?? io.env?.MUSESCORE_COOKIE;

  try {
    const downloadOpts = {
      baseOrigin: args.baseOrigin,
      mode: args.mode,
      headless: args.headless,
      profile: args.profile,
      cookie,
      headers: Object.keys(args.headers).length > 0 ? args.headers : undefined,
    };

    const wantsMusicXml = args.outPath !== undefined || args.format !== undefined || !args.pdfPath;

    if (!wantsMusicXml && args.pdfPath) {
      const pdfBytes = await downloadMuseScorePdf(args.target, downloadOpts);
      const pdfOutPath = resolve(args.pdfPath);
      mkdirSync(dirname(pdfOutPath), { recursive: true });
      writeFileSync(pdfOutPath, pdfBytes);
      if (args.json) {
        io.stdout(JSON.stringify({ pdfPath: pdfOutPath }, null, 2) + "\n");
      } else {
        io.stdout(`Wrote PDF to ${pdfOutPath}\n`);
      }
      return 0;
    }

    const assets = await downloadMuseScoreAssets(args.target, downloadOpts);

    let pdfOutPath: string | undefined;
    if (args.pdfPath) {
      const target = parseMuseScoreInput(args.target, args.baseOrigin);
      const scoreOrigin = args.baseOrigin
        ? new URL(args.baseOrigin).origin
        : new URL(target.scoreUrl).origin;
      const pdfBytes = shouldUseBrowserMode(scoreOrigin, downloadOpts)
        ? await svgsToPdfViaBrowser(assets.pages)
        : await downloadMuseScorePdf(args.target, downloadOpts);
      pdfOutPath = resolve(args.pdfPath);
      mkdirSync(dirname(pdfOutPath), { recursive: true });
      writeFileSync(pdfOutPath, pdfBytes);
    }

    const result = svgsAndMidiToMusicXml(assets.pages, assets.midiBuffer, {
      title: args.title ?? assets.title,
      totalPages: assets.totalPages,
    });

    const inferredFormat: "musicxml" | "mxl" =
      args.format ??
      (args.outPath && extname(args.outPath).toLowerCase() === ".mxl"
        ? "mxl"
        : "musicxml");

    const defaultFilename = `${sanitizeFilename(args.title ?? assets.title)}.${inferredFormat}`;
    const outPath = resolve(args.outPath ?? defaultFilename);
    mkdirSync(dirname(outPath), { recursive: true });

    if (inferredFormat === "mxl") {
      const mxlBytes = await exportMxlContainer(result.xml);
      writeFileSync(outPath, mxlBytes);
    } else {
      writeFileSync(outPath, result.xml, "utf8");
    }

    const summary = buildDiagnosticSummary(result.diagnostics, outPath, inferredFormat, pdfOutPath);
    if (args.json) {
      io.stdout(JSON.stringify(summary, null, 2) + "\n");
    } else {
      io.stdout(formatTextSummary(summary));
    }

    return 0;
  } catch (err) {
    io.stderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
