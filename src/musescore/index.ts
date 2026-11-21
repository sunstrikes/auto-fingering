import { rawMidiToScoreModel } from "./midiToScoreModel";
import { buildMusicXml } from "./musicxmlBuilder";
import { parseRawMidi } from "./rawMidi";
import type { ConversionDiagnostic, ConversionOptions, ConversionResult } from "./types";

export { parseRawMidi } from "./rawMidi";
export { buildMusicXml } from "./musicxmlBuilder";
export { rawMidiToScoreModel } from "./midiToScoreModel";
export type * from "./types";

/**
 * Pure conversion seam converting MuseScore 4 SVG pages + raw MIDI buffer into MusicXML 4.0.
 * When `svgPages` is empty, executes the non-destructive MIDI-only fallback path.
 */
export function svgsAndMidiToMusicXml(
  svgPages: string[],
  midiBuffer: ArrayBuffer | Uint8Array,
  options?: ConversionOptions
): ConversionResult {
  const diagnostics: ConversionDiagnostic[] = [];
  const rawMidi = parseRawMidi(midiBuffer);

  if (svgPages.length === 0) {
    diagnostics.push({
      level: "info",
      code: "MIDI_ONLY_FALLBACK",
      message: "No SVG pages provided; converting using non-destructive MIDI-only fallback.",
    });
  } else {
    diagnostics.push({
      level: "warning",
      code: "SVG_ALIGNMENT_NOT_YET_ENABLED",
      message: "SVG alignment is not yet enabled in this milestone; using MIDI-only fallback.",
    });
  }

  const model = rawMidiToScoreModel(rawMidi, options);
  const xml = buildMusicXml(model);
  return { xml, diagnostics };
}
