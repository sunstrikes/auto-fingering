// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { DEFAULT_HAND_SPAN_PROFILE } from "../src/domain/types";
import { parseMusicXml } from "../src/musicxml/parser";
import { verifyScoreRepairOption } from "../src/musicxml/repairWriter";
import { analyzeScoreRepairSuggestions, getRepairSpanLimit } from "../src/solver/scoreRepair";

const { window } = new JSDOM("");
const DOMParser = window.DOMParser;

function pitch(step: string, oct: number, chord = false): string {
  return `<note>${chord ? "<chord/>" : ""}<pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>4</duration><voice>1</voice></note>`;
}
function single(notes: string): string {
  return `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>4</divisions><clef><sign>F</sign><line>4</line></clef></attributes>${notes}</measure></part></score-partwise>`;
}

describe("profile-aware repair limits", () => {
  it("default (M) is capped at a pure octave, S excludes octave triads only", () => {
    expect(getRepairSpanLimit(DEFAULT_HAND_SPAN_PROFILE)).toBe(7);
    expect(getRepairSpanLimit({ ...DEFAULT_HAND_SPAN_PROFILE, preset: "S" })).toBeLessThan(7);
    expect(getRepairSpanLimit({ ...DEFAULT_HAND_SPAN_PROFILE, preset: "S" }, 2)).toBe(7);
  });

  it("flags octave triads for small hands but not medium", () => {
    const xml = single(pitch("C", 2) + pitch("G", 2, true) + pitch("C", 3, true));
    const doc = parseMusicXml(xml, { DOMParser });
    expect(analyzeScoreRepairSuggestions(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE)).toHaveLength(0);
    const small = analyzeScoreRepairSuggestions(doc.onsetSlices, {
      ...DEFAULT_HAND_SPAN_PROFILE,
      preset: "S",
    });
    expect(small).toHaveLength(1);
  });

  it("closed-loop verification confirms fixes resolve the issue without regressions", () => {
    const xml = single(pitch("E", 2) + pitch("E", 3, true) + pitch("A", 3, true));
    const doc = parseMusicXml(xml, { DOMParser });
    const [sug] = analyzeScoreRepairSuggestions(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    expect(sug).toBeDefined();
    const results = sug.options.map((o) =>
      verifyScoreRepairOption(xml, doc, sug, o, DEFAULT_HAND_SPAN_PROFILE, { DOMParser })
    );
    expect(results.some((r) => r && r.resolved && r.introduced.length === 0)).toBe(true);
  });
});
