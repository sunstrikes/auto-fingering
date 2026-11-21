import type { SvgPageInput } from "./types";

const PNG_MAGIC_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export type ValidatedPageAsset =
  | { kind: "svg"; svgText: string }
  | { kind: "png" }
  | { kind: "invalid"; reason: string };

/**
 * Checks whether a byte buffer begins with the 8-byte PNG signature.
 */
export function isPngMagicBytes(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC_BYTES.length) return false;
  for (let i = 0; i < PNG_MAGIC_BYTES.length; i++) {
    if (bytes[i] !== PNG_MAGIC_BYTES[i]) return false;
  }
  return true;
}

function isPngString(text: string): boolean {
  if (text.length >= 4) {
    const c0 = text.charCodeAt(0);
    if ((c0 === 0x89 || c0 === 0xfffd) && text.slice(1, 4) === "PNG") {
      return true;
    }
  }
  if (text.trimStart().toLowerCase().startsWith("data:image/png")) {
    return true;
  }
  return false;
}

function looksLikeSvg(text: string): boolean {
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  if (!trimmed) return false;
  // Strip optional XML declaration, DOCTYPE, and leading comments before checking root <svg
  const stripped = trimmed
    .replace(/^(?:<\?[\s\S]*?\?>\s*|<!DOCTYPE[\s\S]*?>\s*|<!--[\s\S]*?-->\s*)*/gi, "");
  return /^<svg[\s>]/i.test(stripped);
}

/**
 * Validates a MuseScore page asset by inspecting magic bytes and content headers
 * before passing it to the SVG parser.
 */
export function validateSvgPageAsset(input: SvgPageInput): ValidatedPageAsset {
  if (typeof input === "string") {
    if (isPngString(input)) {
      return { kind: "png" };
    }
    if (looksLikeSvg(input)) {
      return { kind: "svg", svgText: input };
    }
    return { kind: "invalid", reason: "Asset string does not contain a valid <svg> root element." };
  }

  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (isPngMagicBytes(bytes)) {
    return { kind: "png" };
  }

  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (isPngString(decoded)) {
    return { kind: "png" };
  }
  if (looksLikeSvg(decoded)) {
    return { kind: "svg", svgText: decoded };
  }
  return { kind: "invalid", reason: "Binary asset is neither a valid PNG nor an SVG document." };
}
