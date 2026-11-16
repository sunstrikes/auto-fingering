import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { parseMusicXml } from "../src/musicxml/parser";
import { solveFingering } from "../src/solver/solveFingering";
import { DEFAULT_HAND_SPAN_PROFILE } from "../src/domain/types";

describe("solver seam: solveFingering", () => {
  it("produces valid 1-5 assignments for every pitched note and idiomatic thumb-under 1-2-3-1-2-3-4-5 on C-major ascending scale", () => {
    const xmlText = readFileSync(
      resolve(__dirname, "../test-corpus/01-single-staff-melody.musicxml"),
      "utf-8"
    );
    const { DOMParser } = new JSDOM("").window;
    const scoreDoc = parseMusicXml(xmlText, { DOMParser });

    const result = solveFingering(scoreDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    // Every pitched note gets a valid 1-5 finger assignment
    expect(Object.keys(result.fingerByNoteUid)).toHaveLength(18);
    for (const note of scoreDoc.noteEvents) {
      const f = result.fingerByNoteUid[note.noteUid];
      expect(f).toBeGreaterThanOrEqual(1);
      expect(f).toBeLessThanOrEqual(5);
    }

    // Measure 1 C-major ascending scale (C4..C5) uses standard thumb-under fingering
    const m1Fingers = scoreDoc.noteEvents
      .slice(0, 8)
      .map((n) => result.fingerByNoteUid[n.noteUid]);
    expect(m1Fingers).toEqual([1, 2, 3, 1, 2, 3, 4, 5]);

    // Emits thumb-under transition cue in measure 1
    expect(
      result.transitionCues.some(
        (c) => c.measureIndex === 0 && c.type === "thumb-under"
      )
    ).toBe(true);

    // Measure 2 black keys F#4 / Bb4 / F#5 avoid thumb when avoidThumbOnBlack is enabled
    const m2Notes = scoreDoc.noteEvents.slice(8, 13);
    const fSharp4 = m2Notes[3];
    const fSharp5 = m2Notes[4];
    expect(result.fingerByNoteUid[fSharp4.noteUid]).not.toBe(1);
    expect(result.fingerByNoteUid[fSharp5.noteUid]).not.toBe(1);
  });
});
