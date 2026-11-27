import { describe, expect, it } from "vitest";
import { scoreCoordToSec, scoreCoordToTick } from "../src/domain/scoreCoord";
import type { MeasureTimeline } from "../src/domain/types";

function makeTimelines(count: number): MeasureTimeline[] {
  const ticksPerMeasure = 480 * 4;
  const secPerMeasure = 2.0;
  return Array.from({ length: count }, (_, m) => ({
    measureIndex: m,
    startTick: m * ticksPerMeasure,
    endTick: (m + 1) * ticksPerMeasure,
    startSec: m * secPerMeasure,
    endSec: (m + 1) * secPerMeasure,
    timeBeats: 4,
    timeBeatType: 4,
    isPickup: false,
  }));
}

describe("scoreCoordToTick & scoreCoordToSec", () => {
  it("converts in-range, negative, and exclusive-end ScoreCoords to ticks and seconds", () => {
    const scoreDoc = {
      measureTimelines: makeTimelines(3),
      ticksPerQuarter: 480,
      measureCount: 3,
    };

    // Negative measureIndex -> 0
    expect(scoreCoordToTick(scoreDoc, { measureIndex: -1, beatNum: 2, beatDen: 1 })).toBe(0);
    expect(scoreCoordToSec(scoreDoc, { measureIndex: -1, beatNum: 2, beatDen: 1 })).toBe(0);

    // Mid-measure anacrusis boundary in measure 1 at beat 3 of 4/4
    expect(scoreCoordToTick(scoreDoc, { measureIndex: 1, beatNum: 3, beatDen: 1 })).toBe(
      1920 + 3 * 480,
    );
    expect(scoreCoordToSec(scoreDoc, { measureIndex: 1, beatNum: 3, beatDen: 1 })).toBeCloseTo(
      3.5,
      6,
    );

    // Exclusive end boundary at scoreDoc.measureCount -> +Infinity ticks, lastTl.endSec seconds
    expect(scoreCoordToTick(scoreDoc, { measureIndex: 3, beatNum: 0, beatDen: 1 })).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(scoreCoordToSec(scoreDoc, { measureIndex: 3, beatNum: 0, beatDen: 1 })).toBeCloseTo(
      6.0,
      6,
    );
  });

  it("handles empty measureTimelines gracefully", () => {
    const emptyDoc = {
      measureTimelines: [] as MeasureTimeline[],
      ticksPerQuarter: 480,
      measureCount: 2,
    };

    expect(scoreCoordToTick(emptyDoc, { measureIndex: 2, beatNum: 0, beatDen: 1 })).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(scoreCoordToSec(emptyDoc, { measureIndex: 2, beatNum: 0, beatDen: 1 })).toBe(0);
    expect(scoreCoordToSec(emptyDoc, { measureIndex: 0, beatNum: 1, beatDen: 1 })).toBe(0);
  });
});
