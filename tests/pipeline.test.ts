import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { DEFAULT_HAND_SPAN_PROFILE } from "../src/domain/types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../src/App";
import { exportMxlContainer, readMxlContainer } from "../src/musicxml/mxl";
import { parseMusicXml } from "../src/musicxml/parser";
import { exportScoreOutput, loadScoreInput } from "../src/musicxml/scoreSession";
import { writeFingeringsToScore, serializeScoreDocument } from "../src/musicxml/writer";
import { solveFingering } from "../src/solver/solveFingering";
import { createSolverClient, type WorkerLike } from "../src/workers/solverClient";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";

function createInProcessWorker(): WorkerLike {
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(msg: unknown) {
      const req = msg as WorkerRequest;
      queueMicrotask(() => {
        const result = solveFingering(req.onsetSlices, req.profile);
        const resp: WorkerResponse = { requestId: req.requestId, ok: true, result };
        worker.onmessage?.({ data: resp } as MessageEvent<WorkerResponse>);
      });
    },
    terminate() {},
  };
  return worker;
}

describe("walking skeleton end-to-end headless pipeline", () => {
  it("parses, solves via worker RPC, writes MusicXML 4.0 fingerings, exports, and reloads cleanly", async () => {
    const xmlText = readFileSync(
      resolve(__dirname, "../test-corpus/01-single-staff-melody.musicxml"),
      "utf-8"
    );
    const { DOMParser, XMLSerializer } = new JSDOM("").window;

    const scoreDoc = parseMusicXml(xmlText, { DOMParser });
    const client = createSolverClient(createInProcessWorker);
    const solveResult = await client.solve(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    client.dispose();

    writeFingeringsToScore(scoreDoc, solveResult.fingerByNoteUid);
    const exportedXml = serializeScoreDocument(scoreDoc, { XMLSerializer });

    expect(exportedXml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(exportedXml).toContain("<!DOCTYPE score-partwise");
    expect(exportedXml).not.toContain('xmlns=""');

    const reloaded = parseMusicXml(exportedXml, { DOMParser });
    expect(reloaded.noteEvents).toHaveLength(18);
    expect(reloaded.noteEvents.slice(0, 8).map((n) => n.anchorFinger)).toEqual([
      1, 2, 3, 1, 2, 3, 4, 5,
    ]);
    expect(reloaded.noteEvents.every((n) => n.anchorFinger !== undefined)).toBe(true);
  });

  it("losslessly writes RH above / LH below fingerings across 03, 04 (.mxl roundtrip), and 05 (wuchang), leaving TieContinuations and preserved anchors untouched", async () => {
    const { DOMParser, XMLSerializer } = new JSDOM("").window;

    // 1. 04-tie-cross-staff-compressed.mxl end-to-end .mxl -> solve -> write -> .mxl
    const mxl04 = readFileSync(
      resolve(__dirname, "../test-corpus/04-tie-cross-staff-compressed.mxl")
    );
    const container04 = await readMxlContainer(mxl04, { DOMParser });
    const doc04 = parseMusicXml(container04.xmlText, { DOMParser });
    const res04 = solveFingering(doc04.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    writeFingeringsToScore(doc04, res04.fingerByNoteUid);
    const exportedXml04 = serializeScoreDocument(doc04, { XMLSerializer });
    const exportedMxl04 = await exportMxlContainer(exportedXml04, container04);

    const reloadedContainer04 = await readMxlContainer(exportedMxl04, { DOMParser });
    const reloaded04 = parseMusicXml(reloadedContainer04.xmlText, { DOMParser });
    for (const ev of reloaded04.noteEvents) {
      const el = reloaded04.noteElementsByUid.get(ev.noteUid)!;
      const fingeringEl = el.querySelector("notations > technical > fingering");
      if (ev.isTieStop) {
        expect(fingeringEl).toBeNull();
      } else {
        expect(fingeringEl).not.toBeNull();
        expect(fingeringEl?.getAttribute("placement")).toBe(ev.hand === "LH" ? "below" : "above");
      }
    }
    // Original <tied> elements preserved
    expect(reloaded04.xmlDoc.querySelectorAll("tied")).toHaveLength(3);

    // 2. 03-partial-fingering-hanon.musicxml preserves <lyric> and existing anchors
    const xml03 = readFileSync(
      resolve(__dirname, "../test-corpus/03-partial-fingering-hanon.musicxml"),
      "utf-8"
    );
    const doc03 = parseMusicXml(xml03, { DOMParser });
    const origLyricsCount03 = doc03.xmlDoc.querySelectorAll("lyric").length;
    const res03 = solveFingering(doc03.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    writeFingeringsToScore(doc03, res03.fingerByNoteUid);
    const exported03 = serializeScoreDocument(doc03, { XMLSerializer });
    const reloaded03 = parseMusicXml(exported03, { DOMParser });
    expect(reloaded03.xmlDoc.querySelectorAll("lyric").length).toBe(origLyricsCount03);

    // Untouched original anchor (including hyphenated text like "1-2" without placement) stays 100% verbatim
    const rawAnchorXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice>
        <notations>
          <tied type="start"/>
          <slur type="start"/>
          <technical><fingering default-y="12">1-2</fingering></technical>
          <articulations><staccato/></articulations>
        </notations>
        <lyric><text>la</text></lyric>
      </note>
    </measure>
  </part>
</score-partwise>`;
    const rawAnchorDoc = parseMusicXml(rawAnchorXml, { DOMParser });
    const rawRes = solveFingering(rawAnchorDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    writeFingeringsToScore(rawAnchorDoc, rawRes.fingerByNoteUid);
    const rawOut = serializeScoreDocument(rawAnchorDoc, { XMLSerializer });
    expect(rawOut).toContain('<fingering default-y="12">1-2</fingering>');
    expect(rawOut).toContain("<tied");
    expect(rawOut).toContain("<slur");
    expect(rawOut).toContain("<staccato");
    expect(rawOut).toContain("<lyric>");

    // 3. 05-realworld-wuchang.musicxml preserves all <direction> and <tied> elements 100%
    const xml05 = readFileSync(
      resolve(__dirname, "../test-corpus/05-realworld-wuchang.musicxml"),
      "utf-8"
    );
    const doc05 = parseMusicXml(xml05, { DOMParser });
    const origDirectionCount = doc05.xmlDoc.querySelectorAll("direction").length;
    const origTiedCount = doc05.xmlDoc.querySelectorAll("tied").length;
    const origArpCount = doc05.xmlDoc.querySelectorAll("arpeggiate").length;

    const res05 = solveFingering(doc05.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    writeFingeringsToScore(doc05, res05.fingerByNoteUid);
    const exported05 = serializeScoreDocument(doc05, { XMLSerializer });
    const reloaded05 = parseMusicXml(exported05, { DOMParser });

    expect(reloaded05.xmlDoc.querySelectorAll("direction").length).toBe(origDirectionCount);
    expect(reloaded05.xmlDoc.querySelectorAll("tied").length).toBe(origTiedCount);
    expect(reloaded05.xmlDoc.querySelectorAll("arpeggiate").length).toBe(origArpCount);
    expect(exported05).not.toContain('xmlns=""');
  });

  it("supports .mxl/.musicxml upload session, bidirectional export conversion, and single-staff Right/Left Hand toggle", async () => {
    const { DOMParser, XMLSerializer } = new JSDOM("").window;

    // 1. Upload .mxl -> default export format is "mxl", can convert to "musicxml"
    const mxlBytes = readFileSync(
      resolve(__dirname, "../test-corpus/04-tie-cross-staff-compressed.mxl")
    );
    const mxlSession = await loadScoreInput(
      { fileName: "04.mxl", bytes: new Uint8Array(mxlBytes) },
      { DOMParser }
    );
    expect(mxlSession.sourceFormat).toBe("mxl");
    expect(mxlSession.scoreDoc.isSingleStaff).toBe(false);

    const res04 = solveFingering(mxlSession.scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    writeFingeringsToScore(mxlSession.scoreDoc, res04.fingerByNoteUid);
    const xmlOut04 = serializeScoreDocument(mxlSession.scoreDoc, { XMLSerializer });
    const convertedXml = await exportScoreOutput(xmlOut04, "musicxml", mxlSession.mxlContainer);
    expect(typeof convertedXml.text).toBe("string");
    expect(convertedXml.extension).toBe("musicxml");

    // 2. Upload single-staff .musicxml -> toggle Left Hand -> placement="below" and convert to .mxl
    const xml01 = readFileSync(
      resolve(__dirname, "../test-corpus/01-single-staff-melody.musicxml"),
      "utf-8"
    );
    const singleRh = await loadScoreInput(
      { fileName: "01.musicxml", text: xml01 },
      { DOMParser }
    );
    expect(singleRh.sourceFormat).toBe("musicxml");
    expect(singleRh.scoreDoc.isSingleStaff).toBe(true);
    expect(singleRh.scoreDoc.defaultSingleStaffHand).toBe("RH");

    const singleLh = await loadScoreInput(
      { fileName: "01.musicxml", text: xml01 },
      { DOMParser, singleStaffHandOverride: "LH" }
    );
    expect(singleLh.scoreDoc.noteEvents.every((n) => n.hand === "LH")).toBe(true);
    const resLh = solveFingering(singleLh.scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    writeFingeringsToScore(singleLh.scoreDoc, resLh.fingerByNoteUid);
    const xmlOutLh = serializeScoreDocument(singleLh.scoreDoc, { XMLSerializer });
    expect(xmlOutLh).toContain('placement="below"');
    expect(xmlOutLh).not.toContain('placement="above"');

    const convertedMxl = await exportScoreOutput(xmlOutLh, "mxl");
    expect(convertedMxl.extension).toBe("mxl");
    expect(convertedMxl.bytes).toBeInstanceOf(Uint8Array);

    // 3. Rejects unsupported score-timewise and 3-staff scores via loadScoreInput
    await expect(
      loadScoreInput(
        { fileName: "bad.musicxml", text: "<score-timewise version='4.0'/>" },
        { DOMParser }
      )
    ).rejects.toThrow(/score-partwise/i);

    // 4. App UI renders .musicxml/.xml/.mxl upload and export format controls
    const appHtml = renderToStaticMarkup(createElement(App));
    expect(appHtml).toContain('accept=".musicxml,.xml,.mxl"');
    expect(appHtml).toContain('aria-label="Export format"');
  });
});
