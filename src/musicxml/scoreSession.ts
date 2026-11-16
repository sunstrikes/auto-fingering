import type { ScoreDocument } from "../domain/types";
import { exportMxlContainer, readMxlContainer, type MxlContainer } from "./mxl";
import { parseMusicXml, type ParseMusicXmlOptions } from "./parser";

export type ExportFormat = "musicxml" | "mxl";

export interface ScoreInputPayload {
  fileName: string;
  text?: string;
  bytes?: Uint8Array | ArrayBuffer;
}

export interface LoadedScoreSession {
  rawXmlText: string;
  sourceFormat: ExportFormat;
  mxlContainer?: MxlContainer;
  scoreDoc: ScoreDocument;
}

export interface ExportedScoreOutput {
  extension: ExportFormat;
  mimeType: string;
  text?: string;
  bytes?: Uint8Array;
}

function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Load an uploaded .musicxml, .xml, or .mxl file into a lossless ScoreDocument
 * while retaining the raw XML and optional MxlContainer for round-trip export.
 */
export async function loadScoreInput(
  input: ScoreInputPayload,
  options?: ParseMusicXmlOptions
): Promise<LoadedScoreSession> {
  const lowerName = input.fileName.toLowerCase();
  const rawBytes =
    input.bytes instanceof ArrayBuffer
      ? new Uint8Array(input.bytes)
      : input.bytes;

  const isMxl = lowerName.endsWith(".mxl") || (rawBytes ? isZipBytes(rawBytes) : false);

  if (isMxl) {
    if (!rawBytes) {
      throw new Error("Binary buffer is required to load a .mxl file.");
    }
    const container = await readMxlContainer(rawBytes, options);
    const scoreDoc = parseMusicXml(container.xmlText, options);
    return {
      rawXmlText: container.xmlText,
      sourceFormat: "mxl",
      mxlContainer: container,
      scoreDoc,
    };
  }

  const xmlText =
    input.text ??
    (rawBytes ? new TextDecoder("utf-8").decode(rawBytes) : "");
  const scoreDoc = parseMusicXml(xmlText, options);
  return {
    rawXmlText: xmlText,
    sourceFormat: "musicxml",
    scoreDoc,
  };
}

/**
 * Convert serialized MusicXML into either plain .musicxml text or compressed .mxl bytes.
 */
export async function exportScoreOutput(
  xmlText: string,
  format: ExportFormat,
  mxlContainer?: Pick<MxlContainer, "zip" | "primaryPath">
): Promise<ExportedScoreOutput> {
  if (format === "mxl") {
    const bytes = await exportMxlContainer(xmlText, mxlContainer);
    return {
      extension: "mxl",
      mimeType: "application/vnd.recordare.musicxml",
      bytes,
    };
  }

  return {
    extension: "musicxml",
    mimeType: "application/vnd.recordare.musicxml+xml;charset=utf-8",
    text: xmlText,
  };
}
