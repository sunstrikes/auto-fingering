import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { buildMusicXml } from "../src/musescore/musicxmlBuilder";
import { parseMusicXml } from "../src/musicxml/parser";
import type { ScoreBuildModel } from "../src/musescore/types";

const dom = new JSDOM();
const domDeps = {
  DOMParser: dom.window.DOMParser,
  XMLSerializer: dom.window.XMLSerializer,
};

describe("Unified MusicXML 4.0 builder (buildMusicXml)", () => {
  it("enforces strict <note> child-element ordering, synchronized <tie>/<tied> on chords, pickup implicit='yes', and exact measure duration closure", () => {
    const model: ScoreBuildModel = {
      title: "Builder Test",
      divisions: 480,
      staves: 2,
      measures: [
        {
          number: "0",
          implicit: true,
          duration: 480, // 1-beat pickup in 4/4
          attributes: {
            divisions: 480,
            fifths: 1,
            mode: "major",
            beats: 4,
            beatType: 4,
            staves: 2,
          },
          tempos: [{ tickOffset: 0, bpm: 120 }],
          pedals: [{ tickOffset: 0, type: "start", staff: 2 }],
          notes: [
            // RH chord tied into measure 1
            {
              kind: "note",
              onsetOffset: 0,
              pitch: { step: "G", octave: 4 },
              duration: 480,
              voice: "1",
              staff: 1,
              type: "quarter",
              tieStart: true,
            },
            {
              kind: "note",
              onsetOffset: 0,
              isChord: true,
              pitch: { step: "B", octave: 4 },
              duration: 480,
              voice: "1",
              staff: 1,
              type: "quarter",
              tieStart: true,
            },
            // LH quarter rest in voice 5
            {
              kind: "rest",
              onsetOffset: 0,
              duration: 480,
              voice: "5",
              staff: 2,
              type: "quarter",
            },
          ],
        },
        {
          number: "1",
          duration: 1920,
          pedals: [{ tickOffset: 960, type: "stop", staff: 2 }],
          notes: [
            // RH chord tie stop
            {
              kind: "note",
              onsetOffset: 0,
              pitch: { step: "G", octave: 4 },
              duration: 960,
              voice: "1",
              staff: 1,
              type: "half",
              tieStop: true,
            },
            {
              kind: "note",
              onsetOffset: 0,
              isChord: true,
              pitch: { step: "B", octave: 4 },
              duration: 960,
              voice: "1",
              staff: 1,
              type: "half",
              tieStop: true,
            },
            {
              kind: "rest",
              onsetOffset: 960,
              duration: 960,
              voice: "1",
              staff: 1,
              type: "half",
            },
            // LH whole note
            {
              kind: "note",
              onsetOffset: 0,
              pitch: { step: "G", octave: 3 },
              duration: 1920,
              voice: "5",
              staff: 2,
              type: "whole",
            },
          ],
        },
      ],
    };

    const xml = buildMusicXml(model);
    const doc = new dom.window.DOMParser().parseFromString(xml, "application/xml");
    expect(doc.querySelector("parsererror")).toBeNull();

    // Check pickup measure attribute
    const measures = Array.from(doc.querySelectorAll("part > measure"));
    expect(measures).toHaveLength(2);
    expect(measures[0].getAttribute("number")).toBe("0");
    expect(measures[0].getAttribute("implicit")).toBe("yes");
    expect(measures[1].getAttribute("implicit")).toBeNull();

    // Check strict <note> child-element ordering on every <note>
    const ORDER = [
      "grace",
      "chord",
      "pitch",
      "rest",
      "duration",
      "tie",
      "voice",
      "type",
      "dot",
      "stem",
      "staff",
      "notations",
    ];
    for (const noteEl of Array.from(doc.querySelectorAll("note"))) {
      const childTags = Array.from(noteEl.children).map((c) => c.tagName);
      let lastIdx = -1;
      for (const tag of childTags) {
        const idx = ORDER.indexOf(tag);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeGreaterThanOrEqual(lastIdx);
        lastIdx = idx;
      }
    }

    // Check synchronized <tie> and <tied> on chord notes
    const m0ChordNote = measures[0].querySelectorAll("note")[1];
    expect(m0ChordNote.querySelector("chord")).not.toBeNull();
    expect(m0ChordNote.querySelector('tie[type="start"]')).not.toBeNull();
    expect(m0ChordNote.querySelector('notations > tied[type="start"]')).not.toBeNull();

    // Check exact per-measure duration closure via parseMusicXml
    const score = parseMusicXml(xml, domDeps);
    expect(score.measureCount).toBe(2);
    expect(score.measureTimelines[0].isPickup).toBe(true);
    expect(score.measureTimelines[0].startTick).toBe(0);
    expect(score.measureTimelines[0].endTick).toBe(480);
    expect(score.measureTimelines[1].isPickup).toBe(false);
    expect(score.measureTimelines[1].startTick).toBe(480);
    expect(score.measureTimelines[1].endTick).toBe(2400);
    expect(score.pedalIntervals).toEqual([{ startTick: 0, endTick: 1440, freshPress: true }]);
  });
});
