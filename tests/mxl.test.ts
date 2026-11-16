import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import JSZip from "jszip";
import { exportMxlContainer, MXL_MIMETYPE, readMxlContainer } from "../src/musicxml/mxl";

function getDomDeps() {
  const dom = new JSDOM("");
  return {
    DOMParser: dom.window.DOMParser,
    XMLSerializer: dom.window.XMLSerializer,
  };
}

function assertMimetypeFirstAndStored(zipBytes: Uint8Array): void {
  // ZIP local file header signature: PK\x03\x04 (0x50 0x4b 0x03 0x04)
  expect(zipBytes[0]).toBe(0x50);
  expect(zipBytes[1]).toBe(0x4b);
  expect(zipBytes[2]).toBe(0x03);
  expect(zipBytes[3]).toBe(0x04);
  // Compression method at offset 8..9 (little-endian): 0 === STORE
  const compressionMethod = zipBytes[8] | (zipBytes[9] << 8);
  expect(compressionMethod).toBe(0);
  // Filename length at offset 26..27
  const nameLen = zipBytes[26] | (zipBytes[27] << 8);
  const firstName = Buffer.from(zipBytes.slice(30, 30 + nameLen)).toString("utf8");
  expect(firstName).toBe("mimetype");
  // Extra field length at offset 28..29; content immediately follows filename + extra
  const extraLen = zipBytes[28] | (zipBytes[29] << 8);
  const contentStart = 30 + nameLen + extraLen;
  const content = Buffer.from(
    zipBytes.slice(contentStart, contentStart + MXL_MIMETYPE.length)
  ).toString("ascii");
  expect(content).toBe(MXL_MIMETYPE);
}

describe("mxl container I/O seam", () => {
  it("reads META-INF/container.xml (rootfiles > rootfile[0]), extracts primary XML, and retains JSZip archive", async () => {
    const buffer = readFileSync(
      resolve(__dirname, "../test-corpus/04-tie-cross-staff-compressed.mxl")
    );
    const { DOMParser } = getDomDeps();

    const container = await readMxlContainer(buffer, { DOMParser });

    expect(container.primaryPath).toBe("score.musicxml");
    expect(container.xmlText).toContain("Sample 04 - Ties, Cross-Staff, Grace Note &amp; MXL");
    expect(container.zip.file("META-INF/container.xml")).not.toBeNull();
  });

  it("strips leading slash on rootfile full-path and rejects missing container.xml", async () => {
    const { DOMParser } = getDomDeps();

    const zip = new JSZip();
    zip.file(
      "META-INF/container.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<container><rootfiles><rootfile full-path="/nested/my-piece.musicxml"/></rootfiles></container>`
    );
    zip.file("nested/my-piece.musicxml", "<score-partwise version='4.0'/>");
    const validBytes = await zip.generateAsync({ type: "uint8array" });

    const loaded = await readMxlContainer(validBytes, { DOMParser });
    expect(loaded.primaryPath).toBe("nested/my-piece.musicxml");
    expect(loaded.xmlText).toContain("<score-partwise");

    const badZip = new JSZip();
    badZip.file("score.musicxml", "<score-partwise/>");
    const badBytes = await badZip.generateAsync({ type: "uint8array" });

    await expect(readMxlContainer(badBytes, { DOMParser })).rejects.toThrow(/container\.xml/i);
  });

  it("exports .mxl preserving bundled assets with mimetype first (STORE), and converts plain .musicxml to .mxl", async () => {
    const { DOMParser } = getDomDeps();

    // Build an archive that even has mimetype out of order and bundled assets
    const origZip = new JSZip();
    origZip.file("assets/cover.png", Uint8Array.from([137, 80, 78, 71, 1, 2, 3]));
    origZip.file(
      "META-INF/container.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<container><rootfiles><rootfile full-path="parts/main.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>`
    );
    origZip.file("parts/main.musicxml", "<score-partwise version='4.0'><work><work-title>Old</work-title></work></score-partwise>");
    origZip.file("mimetype", MXL_MIMETYPE);
    const origBytes = await origZip.generateAsync({ type: "uint8array", compression: "DEFLATE" });

    const loaded = await readMxlContainer(origBytes, { DOMParser });
    const updatedXml = loaded.xmlText.replace("Old", "Updated");
    const exportedExisting = await exportMxlContainer(updatedXml, loaded);

    assertMimetypeFirstAndStored(exportedExisting);
    const reloadedExisting = await readMxlContainer(exportedExisting, { DOMParser });
    expect(reloadedExisting.primaryPath).toBe("parts/main.musicxml");
    expect(reloadedExisting.xmlText).toContain("<work-title>Updated</work-title>");
    const preservedAsset = await reloadedExisting.zip.file("assets/cover.png")?.async("uint8array");
    expect(Array.from(preservedAsset ?? [])).toEqual([137, 80, 78, 71, 1, 2, 3]);

    // Plain .musicxml -> .mxl conversion
    const plainXml = '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>Plain</work-title></work></score-partwise>';
    const convertedBytes = await exportMxlContainer(plainXml);
    assertMimetypeFirstAndStored(convertedBytes);
    const reloadedConverted = await readMxlContainer(convertedBytes, { DOMParser });
    expect(reloadedConverted.primaryPath).toBe("score.musicxml");
    expect(reloadedConverted.xmlText).toContain("<work-title>Plain</work-title>");
  });
});
