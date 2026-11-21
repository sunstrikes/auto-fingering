import { validateSvgPageAsset } from "./assetValidation";
import { rawMidiToScoreModel } from "./midiToScoreModel";
import { buildMusicXml } from "./musicxmlBuilder";
import { parseRawMidi } from "./rawMidi";
import { alignSvgsAndMidi } from "./svgMidiAligner";
import { parseMs4Svg } from "./svgParser";
import type {
  ConversionDiagnostic,
  ConversionDiagnostics,
  ConversionOptions,
  ConversionResult,
  SvgPageInput,
} from "./types";

export { parseRawMidi } from "./rawMidi";
export { buildMusicXml } from "./musicxmlBuilder";
export { rawMidiToScoreModel } from "./midiToScoreModel";
export { parseMs4Svg } from "./svgParser";
export { alignSvgsAndMidi, closeBoundarySpanners } from "./svgMidiAligner";
export { validateSvgPageAsset, isPngMagicBytes } from "./assetValidation";
export type * from "./types";

function createDiagnostics(
  items: ConversionDiagnostic[],
  meta: {
    totalPages: number;
    svgPagesParsed: number;
    pngPagesSkipped: number;
    measuresAligned: number;
    fallbackMeasures: number;
    alignmentConfidence: number;
  }
): ConversionDiagnostics {
  const warnings = items.filter((d) => d.level === "warning");
  return Object.assign([...items], {
    ...meta,
    warnings,
  });
}

/**
 * Pure conversion seam converting MuseScore 4 SVG pages + raw MIDI buffer into MusicXML 4.0.
 * Validates page assets (skipping binary PNGs cleanly), handles preview truncation and
 * low-confidence measure fallbacks, and reports structured diagnostics.
 */
export function svgsAndMidiToMusicXml(
  svgPages: readonly SvgPageInput[],
  midiBuffer: ArrayBuffer | Uint8Array,
  options?: ConversionOptions
): ConversionResult {
  const items: ConversionDiagnostic[] = [];
  const rawMidi = parseRawMidi(midiBuffer);
  const totalPages = options?.totalPages ?? svgPages.length;

  let pngPagesSkipped = 0;
  const parsedPages = [];

  for (let i = 0; i < svgPages.length; i++) {
    const validated = validateSvgPageAsset(svgPages[i]);
    if (validated.kind === "png") {
      pngPagesSkipped++;
      items.push({
        level: "warning",
        code: "PNG_PAGE_SKIPPED",
        pageIndex: i,
        message: `Skipped raster PNG asset at page index ${i}.`,
      });
      continue;
    }
    if (validated.kind === "invalid") {
      items.push({
        level: "warning",
        code: "INVALID_SVG_PAGE_SKIPPED",
        pageIndex: i,
        message: `Skipped invalid page asset at page index ${i}: ${validated.reason}`,
      });
      continue;
    }
    parsedPages.push(parseMs4Svg(validated.svgText, i));
  }

  const svgPagesParsed = parsedPages.length;

  if (totalPages > svgPagesParsed) {
    items.push({
      level: "warning",
      code: "PREVIEW_TRUNCATED",
      message: `Preview truncated: ${svgPagesParsed} of ${totalPages} pages available as SVG; uncovered measures will be synthesized from MIDI.`,
    });
  }

  if (svgPages.length === 0) {
    items.push({
      level: "info",
      code: "MIDI_ONLY_FALLBACK",
      message: "No SVG pages provided; converting using non-destructive MIDI-only fallback.",
    });
    const model = rawMidiToScoreModel(rawMidi, options);
    const xml = buildMusicXml(model);
    return {
      xml,
      diagnostics: createDiagnostics(items, {
        totalPages,
        svgPagesParsed: 0,
        pngPagesSkipped: 0,
        measuresAligned: 0,
        fallbackMeasures: model.measures.length,
        alignmentConfidence: 0,
      }),
    };
  }

  if (svgPagesParsed === 0) {
    const model = rawMidiToScoreModel(rawMidi, options);
    const xml = buildMusicXml(model);
    return {
      xml,
      diagnostics: createDiagnostics(items, {
        totalPages,
        svgPagesParsed: 0,
        pngPagesSkipped,
        measuresAligned: 0,
        fallbackMeasures: model.measures.length,
        alignmentConfidence: 0,
      }),
    };
  }

  const hasSystems = parsedPages.some((p) => p.systems.length > 0);
  if (!hasSystems) {
    items.push({
      level: "warning",
      code: "SVG_NO_SYSTEMS_FALLBACK",
      message: "No musical staves found in SVG pages; falling back to MIDI-only conversion.",
    });
    const model = rawMidiToScoreModel(rawMidi, options);
    const xml = buildMusicXml(model);
    return {
      xml,
      diagnostics: createDiagnostics(items, {
        totalPages,
        svgPagesParsed,
        pngPagesSkipped,
        measuresAligned: 0,
        fallbackMeasures: model.measures.length,
        alignmentConfidence: 0,
      }),
    };
  }

  const aligned = alignSvgsAndMidi(parsedPages, rawMidi, options);
  items.push(...aligned.diagnostics);
  const xml = buildMusicXml(aligned.model);
  return {
    xml,
    diagnostics: createDiagnostics(items, {
      totalPages,
      svgPagesParsed,
      pngPagesSkipped,
      measuresAligned: aligned.measuresAligned,
      fallbackMeasures: aligned.fallbackMeasures,
      alignmentConfidence: aligned.alignmentConfidence,
    }),
  };
}
