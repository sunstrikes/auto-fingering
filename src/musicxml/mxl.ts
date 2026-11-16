import JSZip from "jszip";
import type { XmlDomDeps } from "./parser";

export const MXL_MIMETYPE = "application/vnd.recordare.musicxml";

export interface MxlContainer {
  xmlText: string;
  primaryPath: string;
  zip: JSZip;
}

/**
 * Load a compressed .mxl archive, locate the primary MusicXML path from
 * META-INF/container.xml (rootfiles > rootfile[0]), and retain the JSZip archive.
 */
export async function readMxlContainer(
  buffer: ArrayBuffer | Uint8Array,
  deps?: XmlDomDeps
): Promise<MxlContainer> {
  const ParserCtor = deps?.DOMParser ?? globalThis.DOMParser;
  if (!ParserCtor) {
    throw new Error("DOMParser is not available in this environment.");
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new Error(
      `Invalid .mxl archive: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const containerEntry = zip.file("META-INF/container.xml");
  if (!containerEntry) {
    throw new Error("Invalid .mxl archive: missing META-INF/container.xml.");
  }

  const containerXml = await containerEntry.async("string");
  const parser = new ParserCtor();
  const containerDoc = parser.parseFromString(containerXml, "application/xml");
  if (containerDoc.querySelector("parsererror")) {
    throw new Error("Invalid .mxl archive: malformed META-INF/container.xml.");
  }

  const rootfile = containerDoc.querySelector("container > rootfiles > rootfile");
  const rawPath = rootfile?.getAttribute("full-path")?.trim();
  if (!rawPath) {
    throw new Error(
      "Invalid .mxl archive: META-INF/container.xml has no <rootfile full-path>."
    );
  }

  const primaryPath = rawPath.replace(/^\/+/, "");
  const scoreEntry = zip.file(primaryPath);
  if (!scoreEntry) {
    throw new Error(
      `Invalid .mxl archive: primary score "${primaryPath}" referenced by container.xml was not found.`
    );
  }

  const xmlText = await scoreEntry.async("string");
  return { xmlText, primaryPath, zip };
}

function buildDefaultContainerXml(primaryPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container>
  <rootfiles>
    <rootfile full-path="${primaryPath}" media-type="application/vnd.recordare.musicxml+xml"/>
  </rootfiles>
</container>
`;
}

/**
 * Export a MusicXML string as a compressed .mxl archive.
 * Guarantees `mimetype` is the first entry stored uncompressed (STORE),
 * and preserves all bundled assets when updating an existing MxlContainer.
 */
export async function exportMxlContainer(
  xmlText: string,
  existingArchive?: Pick<MxlContainer, "zip" | "primaryPath">
): Promise<Uint8Array> {
  const outZip = new JSZip();

  // First entry must be uncompressed ASCII mimetype per MusicXML 4.0 .mxl spec
  outZip.file("mimetype", MXL_MIMETYPE, { compression: "STORE" });

  if (existingArchive) {
    const targetPath = existingArchive.primaryPath.replace(/^\/+/, "");
    let replacedPrimary = false;

    for (const [entryName, entry] of Object.entries(existingArchive.zip.files)) {
      if (entry.dir || entryName === "mimetype") {
        continue;
      }
      if (entryName.replace(/^\/+/, "") === targetPath) {
        outZip.file(entryName, xmlText, { compression: "DEFLATE" });
        replacedPrimary = true;
      } else {
        const rawBytes = await entry.async("uint8array");
        outZip.file(entryName, rawBytes, { compression: "DEFLATE" });
      }
    }

    if (!replacedPrimary) {
      outZip.file(targetPath, xmlText, { compression: "DEFLATE" });
    }
  } else {
    const defaultPrimaryPath = "score.musicxml";
    outZip.file("META-INF/container.xml", buildDefaultContainerXml(defaultPrimaryPath), {
      compression: "DEFLATE",
    });
    outZip.file(defaultPrimaryPath, xmlText, { compression: "DEFLATE" });
  }

  return outZip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
