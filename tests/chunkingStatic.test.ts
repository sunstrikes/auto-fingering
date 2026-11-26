import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { readMxlContainer } from "../src/musicxml/mxl";
import { parseMusicXml } from "../src/musicxml/parser";
import { makeScoreCoord } from "../src/domain/scoreCoord";
import type {
  MeasureStructuralMeta,
  MeasureTimeline,
  NoteEvent,
  OnsetSlice,
  ScoreCoord,
  ScoreDocument,
  SlurSpan,
} from "../src/domain/types";
import { analyzeScoreStatic } from "../src/chunking/staticAnalyzer";
import type { StaticChunkingResult, StaticScoreInput } from "../src/chunking/types";
import { perfBudget } from "./perfBudget";

function coordToQuarterPos(coord: ScoreCoord, timelines: MeasureTimeline[]): number {
  let acc = 0;
  for (let m = 0; m < coord.measureIndex; m++) {
    const tl = timelines[m];
    acc += tl ? (tl.timeBeats * 4) / tl.timeBeatType : 4;
  }
  return acc + coord.beatNum / coord.beatDen;
}

function buildSyntheticScore(options: {
  measures: number;
  ticksPerQuarter?: number;
  beats?: number;
  beatType?: number;
  bpm?: number;
  isPickupFirst?: boolean;
  measureBuilder: (
    m: number,
    tpq: number,
    measureStartTick: number,
    measureTicks: number,
  ) => {
    notes: Array<{
      offsetTick: number;
      durationTick: number;
      midi: number;
      hand: "RH" | "LH";
    }>;
    meta?: Partial<MeasureStructuralMeta>;
  };
  slurSpans?: SlurSpan[];
}): StaticScoreInput {
  const tpq = options.ticksPerQuarter ?? 480;
  const beats = options.beats ?? 4;
  const beatType = options.beatType ?? 4;
  const bpm = options.bpm ?? 120;
  const fullMeasureTicks = (tpq * 4 * beats) / beatType;
  const secPerTick = 60 / bpm / tpq;

  const measureTimelines: MeasureTimeline[] = [];
  const measureStructuralMeta: MeasureStructuralMeta[] = [];
  const noteEvents: NoteEvent[] = [];
  const onsetSlices: OnsetSlice[] = [];

  let cursorTick = 0;
  let noteCounter = 0;
  let sliceCounter = 0;

  for (let m = 0; m < options.measures; m++) {
    const isPickup = m === 0 && Boolean(options.isPickupFirst);
    const mTicks = isPickup ? Math.round(fullMeasureTicks / 4) : fullMeasureTicks;
    const tl: MeasureTimeline = {
      measureIndex: m,
      startTick: cursorTick,
      endTick: cursorTick + mTicks,
      startSec: cursorTick * secPerTick,
      endSec: (cursorTick + mTicks) * secPerTick,
      timeBeats: beats,
      timeBeatType: beatType,
      isPickup,
    };
    measureTimelines.push(tl);

    const built = options.measureBuilder(m, tpq, cursorTick, mTicks);
    measureStructuralMeta.push({
      measureIndex: m,
      ...built.meta,
    });

    const sliceMap = new Map<string, NoteEvent[]>();
    for (const raw of built.notes) {
      const onsetTick = cursorTick + raw.offsetTick;
      const ev: NoteEvent = {
        noteUid: `n-${noteCounter++}`,
        measureIndex: m,
        onsetTick,
        scoreCoord: makeScoreCoord(m, raw.offsetTick, tpq),
        durationTick: raw.durationTick,
        onsetSec: onsetTick * secPerTick,
        durationSec: raw.durationTick * secPerTick,
        midi: raw.midi,
        hand: raw.hand,
        voice: raw.hand === "RH" ? "1" : "2",
        staff: raw.hand === "RH" ? 1 : 2,
        isGrace: false,
        isTieStop: false,
        isTieStart: false,
      };
      noteEvents.push(ev);
      const sKey = `${raw.hand}:${onsetTick}`;
      const bucket = sliceMap.get(sKey) ?? [];
      bucket.push(ev);
      sliceMap.set(sKey, bucket);
    }

    const sortedKeys = Array.from(sliceMap.entries()).sort((a, b) => {
      const ta = a[1][0].onsetTick;
      const tb = b[1][0].onsetTick;
      if (ta !== tb) return ta - tb;
      return a[0].localeCompare(b[0]);
    });

    for (const [, notes] of sortedKeys) {
      onsetSlices.push({
        sliceId: `slice-${sliceCounter++}`,
        hand: notes[0].hand,
        measureIndex: m,
        onsetTick: notes[0].onsetTick,
        onsetSec: notes[0].onsetSec,
        isGrace: false,
        phraseId: 0,
        notes,
        heldNotes: [],
      });
    }

    cursorTick += mTicks;
  }

  return {
    noteEvents,
    onsetSlices,
    measureTimelines,
    ticksPerQuarter: tpq,
    measureCount: options.measures,
    measureStructuralMeta,
    slurSpans: options.slurSpans,
    tempoPoints: [{ tick: 0, bpm }],
  };
}

async function loadCorpusDoc(filename: string): Promise<ScoreDocument> {
  const { DOMParser } = new JSDOM("").window;
  const fullPath = resolve(__dirname, "../test-corpus", filename);
  if (filename.endsWith(".mxl")) {
    const bytes = readFileSync(fullPath);
    const container = await readMxlContainer(bytes, { DOMParser });
    return parseMusicXml(container.xmlText, { DOMParser });
  }
  const xmlText = readFileSync(fullPath, "utf-8");
  return parseMusicXml(xmlText, { DOMParser });
}

describe("chunking static analyzer (pure TS, zero XML DOM)", () => {
  it("handles empty scores gracefully without throwing", () => {
    const res = analyzeScoreStatic({
      noteEvents: [],
      onsetSlices: [],
      measureTimelines: [],
      ticksPerQuarter: 480,
      measureCount: 0,
    });
    expect(res.measureCount).toBe(0);
    expect(res.macroSections).toEqual([]);
    expect(res.motorChunks).toEqual([]);
    expect(res.passageClusters).toEqual([]);
    expect(res.candidateCues).toEqual([]);
  });

  it("partitions MacroSections (4–16m) honoring explicit MusicXML structural boundaries", () => {
    const input = buildSyntheticScore({
      measures: 16,
      measureBuilder: (m, tpq) => {
        const notes = [];
        for (let b = 0; b < 4; b++) {
          notes.push({
            offsetTick: b * tpq,
            durationTick: tpq,
            midi: m < 8 ? 60 + b : 67 + b,
            hand: "RH" as const,
          });
          notes.push({
            offsetTick: b * tpq,
            durationTick: tpq,
            midi: m < 8 ? 48 : 55,
            hand: "LH" as const,
          });
        }
        return {
          notes,
          meta:
            m === 8
              ? { barlineLeft: "double", rehearsalMark: "B", keyFifths: 1 }
              : undefined,
        };
      },
    });

    const res = analyzeScoreStatic(input);
    expect(res.macroSections.length).toBeGreaterThanOrEqual(2);
    for (const sec of res.macroSections) {
      expect(sec.measureCount).toBeGreaterThanOrEqual(4);
      expect(sec.measureCount).toBeLessThanOrEqual(16);
    }
    expect(res.macroSections.some((s) => s.startMeasureIndex === 8)).toBe(true);
    const secB = res.macroSections.find((s) => s.startMeasureIndex === 8)!;
    expect(["double-bar", "rehearsal", "key-change"]).toContain(secB.boundaryReason);
  });

  it("adapts MotorChunk size (1–4m) to rhythmic density", () => {
    // 8 dense 16th-note measures followed by 8 sparse half-note measures
    const input = buildSyntheticScore({
      measures: 16,
      measureBuilder: (m, tpq) => {
        const notes = [];
        if (m < 8) {
          // 16 sixteenth-note steps per measure
          const stepTick = tpq / 4;
          for (let s = 0; s < 16; s++) {
            notes.push({
              offsetTick: s * stepTick,
              durationTick: stepTick,
              midi: 60 + (s % 8),
              hand: "RH" as const,
            });
          }
        } else {
          // 2 half-note steps per measure
          for (let s = 0; s < 2; s++) {
            notes.push({
              offsetTick: s * tpq * 2,
              durationTick: tpq * 2,
              midi: 60 + (m % 4),
              hand: "RH" as const,
            });
          }
        }
        return {
          notes,
          meta: m === 8 ? { barlineLeft: "double" } : undefined,
        };
      },
    });

    const res = analyzeScoreStatic(input);
    const denseChunks = res.motorChunks.filter((c) => c.endMeasureIndex < 8);
    const sparseChunks = res.motorChunks.filter((c) => c.startMeasureIndex >= 8);

    expect(denseChunks.length).toBeGreaterThan(0);
    expect(sparseChunks.length).toBeGreaterThan(0);
    for (const chunk of res.motorChunks) {
      expect(chunk.measureCount).toBeGreaterThanOrEqual(1);
      expect(chunk.measureCount).toBeLessThanOrEqual(4);
    }
    const avgDenseLen =
      denseChunks.reduce((acc, c) => acc + c.measureCount, 0) / denseChunks.length;
    const avgSparseLen =
      sparseChunks.reduce((acc, c) => acc + c.measureCount, 0) / sparseChunks.length;
    expect(avgDenseLen).toBeLessThan(avgSparseLen);
  });

  it("absorbs explicit pickup measures and cross-barline slurs into anacrusis ScoreCoords (<= 0.5 measure) seamlessly", () => {
    // Case A: explicit pickup measure at index 0
    const pickupInput = buildSyntheticScore({
      measures: 5,
      isPickupFirst: true,
      measureBuilder: (m, tpq) => {
        if (m === 0) {
          return {
            notes: [{ offsetTick: 0, durationTick: tpq, midi: 67, hand: "RH" }],
          };
        }
        return {
          notes: [0, 1, 2, 3].map((b) => ({
            offsetTick: b * tpq,
            durationTick: tpq,
            midi: 60 + b,
            hand: "RH" as const,
          })),
        };
      },
    });

    const pickupRes = analyzeScoreStatic(pickupInput);
    expect(pickupRes.motorChunks[0].startCoord).toEqual({
      measureIndex: 0,
      beatNum: 0,
      beatDen: 1,
    });
    expect(pickupRes.motorChunks[0].hasAnacrusisLeadIn).toBe(true);
    expect(pickupRes.motorChunks[0].anacrusisBeats).toBeLessThanOrEqual(2);
    expect(pickupRes.motorChunks[0].endMeasureIndex).toBeGreaterThanOrEqual(1);

    // Case B: internal cross-barline slur starting on beat 3 (last 1 beat <= 0.5 measure)
    const slurInput = buildSyntheticScore({
      measures: 8,
      measureBuilder: (m, tpq) => {
        // Measure 3 has a half rest / pause on beat 2 then pickup beat 3 into m.4
        const notes = [];
        if (m === 3) {
          notes.push({ offsetTick: 0, durationTick: tpq * 2, midi: 64, hand: "RH" as const });
          notes.push({ offsetTick: tpq * 3, durationTick: tpq, midi: 67, hand: "RH" as const });
        } else {
          for (let b = 0; b < 4; b++) {
            notes.push({
              offsetTick: b * tpq,
              durationTick: tpq,
              midi: 60 + b,
              hand: "RH" as const,
            });
          }
        }
        return {
          notes,
          meta: m === 4 ? { barlineLeft: "double" } : undefined,
        };
      },
      slurSpans: [
        {
          hand: "RH",
          voice: "1",
          startCoord: { measureIndex: 3, beatNum: 3, beatDen: 1 },
          endCoord: { measureIndex: 4, beatNum: 2, beatDen: 1 },
          crossesBarline: true,
        },
      ],
    });

    const slurRes = analyzeScoreStatic(slurInput);
    const chunkAt4 = slurRes.motorChunks.find(
      (c) => c.startMeasureIndex === 3 && c.hasAnacrusisLeadIn,
    );
    expect(chunkAt4).toBeDefined();
    expect(chunkAt4!.startCoord).toEqual({ measureIndex: 3, beatNum: 3, beatDen: 1 });
    expect(chunkAt4!.anacrusisBeats).toBeLessThanOrEqual(2);

    // Seamless contiguity: every chunk's endCoord equals next chunk's startCoord
    for (let i = 0; i < slurRes.motorChunks.length - 1; i++) {
      expect(slurRes.motorChunks[i].endCoord).toEqual(slurRes.motorChunks[i + 1].startCoord);
      expect(
        coordToQuarterPos(slurRes.motorChunks[i].startCoord, slurInput.measureTimelines),
      ).toBeLessThan(
        coordToQuarterPos(slurRes.motorChunks[i].endCoord, slurInput.measureTimelines),
      );
    }
  });

  it("clusters exact repeats, transposed repeats, and detects trailing SwitchPoints with alternate-branch pitch skeletons", () => {
    // 18 measures:
    // m.0..3: Theme A in C major -> m.4..5: Ending 1 (G-F-E-D / C)
    // m.6..9: Theme A exact repeat -> m.10..11: Ending 2 (A-B-C5-D5 / E5) -> SwitchPoint at m.6->10 & m.0->4
    // m.12..15: Theme A transposed up +7 semitones (G major) -> m.16..17: Coda
    const themeBar = (mOffset: number, tpq: number, transpose: number) => {
      const pattern = [
        [60, 62, 64, 65],
        [67, 65, 64, 62],
        [64, 67, 72, 71],
        [69, 67, 65, 64],
      ][mOffset];
      return pattern.flatMap((midi, b) => [
        { offsetTick: b * tpq, durationTick: tpq, midi: midi + transpose, hand: "RH" as const },
        {
          offsetTick: b * tpq,
          durationTick: tpq,
          midi: 48 + transpose + (b % 2 === 0 ? 0 : 7),
          hand: "LH" as const,
        },
      ]);
    };

    const input = buildSyntheticScore({
      measures: 18,
      measureBuilder: (m, tpq) => {
        if (m >= 0 && m <= 3) return { notes: themeBar(m, tpq, 0) };
        if (m === 4 || m === 5) {
          const seq = m === 4 ? [67, 65, 64, 62] : [60, 60, 60, 60];
          return {
            notes: seq.map((midi, b) => ({
              offsetTick: b * tpq,
              durationTick: tpq,
              midi,
              hand: "RH" as const,
            })),
          };
        }
        if (m >= 6 && m <= 9) return { notes: themeBar(m - 6, tpq, 0) };
        if (m === 10 || m === 11) {
          const seq = m === 10 ? [69, 71, 72, 74] : [76, 76, 76, 76];
          return {
            notes: seq.map((midi, b) => ({
              offsetTick: b * tpq,
              durationTick: tpq,
              midi,
              hand: "RH" as const,
            })),
          };
        }
        if (m >= 12 && m <= 15) return { notes: themeBar(m - 12, tpq, 7) };
        return {
          notes: [0, 1, 2, 3].map((b) => ({
            offsetTick: b * tpq,
            durationTick: tpq,
            midi: 79 - b,
            hand: "RH" as const,
          })),
        };
      },
    });

    const res = analyzeScoreStatic(input);
    expect(res.passageClusters.length).toBeGreaterThanOrEqual(1);

    const cluster = res.passageClusters[0];
    expect(cluster.instances.length).toBeGreaterThanOrEqual(3);
    expect(cluster.instances.some((i) => i.startMeasureIndex === 0)).toBe(true);
    expect(cluster.instances.some((i) => i.startMeasureIndex === 6)).toBe(true);
    const transposed = cluster.instances.find((i) => i.startMeasureIndex === 12);
    expect(transposed).toBeDefined();
    expect(transposed!.variantKind).toBe("transposed");
    expect(Math.abs(transposed!.transpositionSemitones)).toBeGreaterThan(0);

    // Trailing SwitchPoint between m.4 (Ending 1) and m.10 (Ending 2)
    expect(cluster.switchPoints.length).toBeGreaterThanOrEqual(2);
    const spAt4 = cluster.switchPoints.find((sp) => sp.measureIndex === 4);
    const spAt10 = cluster.switchPoints.find((sp) => sp.measureIndex === 10);
    expect(spAt4).toBeDefined();
    expect(spAt10).toBeDefined();
    // Alternate branch at m.4 should capture m.10's pitch skeleton (69, 71, 72, 74...)
    expect(spAt4!.alternateBranchMidis.flat()).toContain(69);
    expect(spAt4!.alternateBranchMidis.flat()).toContain(72);
    // Alternate branch at m.10 should capture m.4's pitch skeleton (67, 65, 64, 62...)
    expect(spAt10!.alternateBranchMidis.flat()).toContain(67);
    expect(spAt10!.alternateBranchMidis.flat()).toContain(60);
  });

  it("produces deterministic golden snapshots across test-corpus/01..05", async () => {
    const corpusFiles = [
      "01-single-staff-melody.musicxml",
      "02-grand-staff-arpeggio-chord.musicxml",
      "03-partial-fingering-hanon.musicxml",
      "04-tie-cross-staff-compressed.mxl",
      "05-realworld-wuchang.musicxml",
    ];

    const summaries: Record<string, unknown> = {};
    for (const file of corpusFiles) {
      const doc = await loadCorpusDoc(file);
      const r1 = analyzeScoreStatic(doc);
      const r2 = analyzeScoreStatic(doc);

      const stripTiming = (r: StaticChunkingResult) => ({
        ...r,
        staticTimeMs: 0,
      });

      // Strictly deterministic across repeated runs
      expect(stripTiming(r1)).toEqual(stripTiming(r2));
      expect(r1.measureCount).toBe(doc.measureCount);
      expect(r1.macroSections.length).toBeGreaterThanOrEqual(1);
      expect(r1.motorChunks.length).toBeGreaterThanOrEqual(1);

      for (const chunk of r1.motorChunks) {
        expect(chunk.measureCount).toBeGreaterThanOrEqual(1);
        expect(chunk.measureCount).toBeLessThanOrEqual(4);
      }

      if (doc.measureCount >= 4) {
        for (const sec of r1.macroSections) {
          expect(sec.measureCount).toBeGreaterThanOrEqual(4);
          expect(sec.measureCount).toBeLessThanOrEqual(16);
        }
      }

      summaries[file] = {
        measureCount: r1.measureCount,
        sections: r1.macroSections.map((s) => ({
          id: s.sectionId,
          range: [s.startMeasureIndex, s.endMeasureIndex],
          reason: s.boundaryReason,
        })),
        chunks: r1.motorChunks.map((c) => ({
          id: c.chunkId,
          start: c.startCoord,
          end: c.endCoord,
          measures: c.measureCount,
          pickup: c.hasAnacrusisLeadIn,
        })),
        clusterCount: r1.passageClusters.length,
        clusters: r1.passageClusters.map((cl) => ({
          label: cl.label,
          instances: cl.instances.map((i) => ({
            range: [i.startMeasureIndex, i.endMeasureIndex],
            kind: i.variantKind,
            transpose: i.transpositionSemitones,
          })),
          switchMeasures: cl.switchPoints.map((sp) => sp.measureIndex),
        })),
      };
    }

    expect(summaries).toMatchSnapshot();
  });

  it("meets the < 50 ms budget on a synthetic 200-measure / 4000-note score and degrades SSM cleanly above 250 measures", () => {
    const input200 = buildSyntheticScore({
      measures: 200,
      measureBuilder: (m, tpq) => {
        const notes = [];
        // 20 notes per measure => 4000 notes total
        for (let s = 0; s < 10; s++) {
          const offset = Math.round((s * tpq * 4) / 10);
          notes.push({
            offsetTick: offset,
            durationTick: Math.round((tpq * 4) / 10),
            midi: 60 + ((m + s) % 12),
            hand: "RH" as const,
          });
          notes.push({
            offsetTick: offset,
            durationTick: Math.round((tpq * 4) / 10),
            midi: 48 + ((m * 3 + s) % 12),
            hand: "LH" as const,
          });
        }
        return { notes };
      },
    });
    expect(input200.noteEvents.length).toBe(4000);

    // Warm up JIT across 3 calls, then measure median of 3 runs
    for (let w = 0; w < 3; w++) analyzeScoreStatic(input200);

    const timings: number[] = [];
    let res200 = analyzeScoreStatic(input200);
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      res200 = analyzeScoreStatic(input200);
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    const elapsed = timings[1];

    expect(res200.degradedToWholeMeasureSsm).toBe(false);
    expect(elapsed).toBeLessThan(perfBudget(50));

    const input260 = buildSyntheticScore({
      measures: 260,
      measureBuilder: (m, tpq) => ({
        notes: [0, 1, 2, 3].map((b) => ({
          offsetTick: b * tpq,
          durationTick: tpq,
          midi: 60 + ((m + b) % 12),
          hand: "RH" as const,
        })),
      }),
    });
    const res260 = analyzeScoreStatic(input260);
    expect(res260.degradedToWholeMeasureSsm).toBe(true);
    expect(res260.macroSections.length).toBeGreaterThanOrEqual(16);
  });
});
