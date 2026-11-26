import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { readMxlContainer } from "../src/musicxml/mxl";
import { parseMusicXml } from "../src/musicxml/parser";
import { solveFingering } from "../src/solver/solveFingering";
import {
  DEFAULT_HAND_SPAN_PROFILE,
  type Finger,
  type MeasureStructuralMeta,
  type MeasureTimeline,
  type NoteEvent,
  type OnsetSlice,
  type ScoreDocument,
  type SolveResult,
} from "../src/domain/types";
import { makeScoreCoord } from "../src/domain/scoreCoord";
import { analyzeScoreStatic } from "../src/chunking/staticAnalyzer";
import { analyzeMotorOverlay } from "../src/chunking/motorOverlay";
import type { MotorOverlayResult, StaticScoreInput } from "../src/chunking/types";
import { perfBudget } from "./perfBudget";

function buildScoreDocLike(options: {
  measures: number;
  bpm?: number;
  measureBuilder: (
    m: number,
    tpq: number,
    startTick: number,
  ) => {
    notes: Array<{
      offsetTick: number;
      durationTick: number;
      midi: number;
      hand: "RH" | "LH";
      anchorFinger?: Finger;
    }>;
    meta?: Partial<MeasureStructuralMeta>;
    heldOnAllNotesInMeasure?: boolean;
  };
}): StaticScoreInput {
  const tpq = 480;
  const bpm = options.bpm ?? 120;
  const measureTicks = tpq * 4;
  const secPerTick = 60 / bpm / tpq;

  const measureTimelines: MeasureTimeline[] = [];
  const measureStructuralMeta: MeasureStructuralMeta[] = [];
  const noteEvents: NoteEvent[] = [];
  const onsetSlices: OnsetSlice[] = [];

  let noteId = 0;
  let sliceId = 0;

  for (let m = 0; m < options.measures; m++) {
    const startTick = m * measureTicks;
    measureTimelines.push({
      measureIndex: m,
      startTick,
      endTick: startTick + measureTicks,
      startSec: startTick * secPerTick,
      endSec: (startTick + measureTicks) * secPerTick,
      timeBeats: 4,
      timeBeatType: 4,
      isPickup: false,
    });

    const built = options.measureBuilder(m, tpq, startTick);
    measureStructuralMeta.push({ measureIndex: m, ...built.meta });

    const byHandTick = new Map<string, NoteEvent[]>();
    for (const raw of built.notes) {
      const onsetTick = startTick + raw.offsetTick;
      const ev: NoteEvent = {
        noteUid: `n-${noteId++}`,
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
        ...(raw.anchorFinger ? { anchorFinger: raw.anchorFinger, anchorMode: "phrase" as const } : {}),
      };
      noteEvents.push(ev);
      const key = `${raw.hand}:${onsetTick}`;
      const list = byHandTick.get(key) ?? [];
      list.push(ev);
      byHandTick.set(key, list);
    }

    const sorted = Array.from(byHandTick.entries()).sort((a, b) => {
      const dt = a[1][0].onsetTick - b[1][0].onsetTick;
      return dt !== 0 ? dt : a[0].localeCompare(b[0]);
    });

    for (const [, notes] of sorted) {
      const hand = notes[0].hand;
      const heldNotes = built.heldOnAllNotesInMeasure
        ? noteEvents
            .filter(
              (prev) =>
                prev.hand === hand &&
                prev.onsetTick < notes[0].onsetTick &&
                prev.onsetTick + prev.durationTick > notes[0].onsetTick,
            )
            .map((prev) => ({
              noteUid: prev.noteUid,
              midi: prev.midi,
              endTick: prev.onsetTick + prev.durationTick,
              onsetTick: prev.onsetTick,
            }))
        : [];
      onsetSlices.push({
        sliceId: `slice-${sliceId++}`,
        hand,
        measureIndex: m,
        onsetTick: notes[0].onsetTick,
        onsetSec: notes[0].onsetSec,
        isGrace: false,
        phraseId: 0,
        notes,
        heldNotes,
      });
    }
  }

  return {
    noteEvents,
    onsetSlices,
    measureTimelines,
    ticksPerQuarter: tpq,
    measureCount: options.measures,
    measureStructuralMeta,
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

describe("chunking synchronous motor overlay (< 2 ms)", () => {
  it("computes MotorReuse from SolveResult and reflects single-instance FingerAnchor edits without cross-instance mutation", () => {
    const input = buildScoreDocLike({
      measures: 12,
      measureBuilder: (m, tpq) => {
        const themeBars = [
          [60, 62, 64, 65],
          [67, 65, 64, 62],
          [64, 67, 72, 71],
          [69, 67, 65, 64],
        ];
        const pattern =
          m >= 0 && m <= 3
            ? themeBars[m]
            : m >= 4 && m <= 5
              ? [67, 65, 64, 60]
              : m >= 6 && m <= 9
                ? themeBars[m - 6]
                : [69, 71, 72, 74];
        return {
          notes: pattern.map((midi, b) => ({
            offsetTick: b * tpq,
            durationTick: tpq,
            midi,
            hand: "RH" as const,
            ...((m === 0 || m === 6) && b === 0 ? { anchorFinger: 1 as Finger } : {}),
            ...((m === 3 || m === 9) && b === 3 ? { anchorFinger: 2 as Finger } : {}),
          })),
        };
      },
    });

    const staticRes = analyzeScoreStatic(input);
    expect(staticRes.passageClusters.length).toBeGreaterThanOrEqual(1);

    const solveRes = solveFingering(input.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const overlay1 = analyzeMotorOverlay(staticRes, input, solveRes, "both");

    const cl1 = overlay1.passageClusters[0];
    const inst2Before = cl1.instances.find((i) => i.startMeasureIndex === 6)!;
    expect(inst2Before.fingeringIsomorphism).toBeGreaterThanOrEqual(0.9);
    expect(inst2Before.motorReuse).toBeGreaterThanOrEqual(0.9);

    // Simulate user pinning different FingerAnchors only in instance 2 (m.6..9)
    const modifiedFingers = { ...solveRes.fingerByNoteUid };
    for (const ev of input.noteEvents) {
      if (ev.measureIndex >= 6 && ev.measureIndex <= 9) {
        modifiedFingers[ev.noteUid] = ((modifiedFingers[ev.noteUid] % 5) + 1) as Finger;
      }
    }
    const modifiedSolve: SolveResult = {
      ...solveRes,
      fingerByNoteUid: modifiedFingers,
    };

    const overlay2 = analyzeMotorOverlay(staticRes, input, modifiedSolve, "both");
    const cl2 = overlay2.passageClusters[0];
    const inst2After = cl2.instances.find((i) => i.startMeasureIndex === 6)!;
    expect(inst2After.fingeringIsomorphism).toBeLessThan(0.5);
    expect(inst2After.motorReuse).toBeLessThan(inst2Before.motorReuse);
    expect(inst2After.diffCoords.some((d) => d.kind === "fingering")).toBe(true);
    // Prototype instance fingerings remain untouched
    const protoNotes = input.noteEvents.filter((n) => n.measureIndex <= 3);
    for (const n of protoNotes) {
      expect(modifiedSolve.fingerByNoteUid[n.noteUid]).toBe(solveRes.fingerByNoteUid[n.noteUid]);
    }
  });

  it("scores 6-dim ChunkJunction prior risk and strips D3 bimanual coupling in single-hand PracticeMode", () => {
    // 8 measures with a dramatic simultaneous dual leap at m.3 -> m.4
    const input = buildScoreDocLike({
      measures: 8,
      bpm: 160,
      measureBuilder: (m, tpq) => {
        const rhBase = m < 4 ? 60 : 84; // 2-octave jump at m.4
        const lhBase = m < 4 ? 48 : 31; // simultaneous downward leap at m.4
        return {
          notes: [0, 1, 2, 3].flatMap((b) => [
            {
              offsetTick: b * tpq,
              durationTick: tpq,
              midi: rhBase + b,
              hand: "RH" as const,
            },
            {
              offsetTick: b * tpq,
              durationTick: tpq,
              midi: lhBase - b,
              hand: "LH" as const,
            },
          ]),
          meta: m === 4 ? { barlineLeft: "double" } : undefined,
        };
      },
    });

    const staticRes = analyzeScoreStatic(input);
    const solveRes = solveFingering(input.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    const bothOverlay = analyzeMotorOverlay(staticRes, input, solveRes, "both");
    const rhOverlay = analyzeMotorOverlay(staticRes, input, solveRes, "rh-only");
    const lhOverlay = analyzeMotorOverlay(staticRes, input, solveRes, "lh-only");

    const dualJunctionBoth = bothOverlay.chunkJunctions.find((j) => j.measureIndex === 4);
    const dualJunctionRh = rhOverlay.chunkJunctions.find((j) => j.measureIndex === 4);
    const dualJunctionLh = lhOverlay.chunkJunctions.find((j) => j.measureIndex === 4);

    expect(dualJunctionBoth).toBeDefined();
    expect(dualJunctionBoth!.dimensions.d3BimanualCoupling).toBeGreaterThan(0);
    expect(dualJunctionBoth!.priorRisk).toBeGreaterThanOrEqual(0.65);
    expect(dualJunctionBoth!.isHighRisk).toBe(true);
    expect(dualJunctionBoth!.bridgeWindowSteps.startStepIndex).toBeLessThanOrEqual(
      dualJunctionBoth!.bridgeWindowSteps.junctionStepIndex,
    );
    expect(dualJunctionBoth!.bridgeWindowSteps.endStepIndex).toBeGreaterThanOrEqual(
      dualJunctionBoth!.bridgeWindowSteps.junctionStepIndex,
    );

    expect(dualJunctionRh!.dimensions.d3BimanualCoupling).toBe(0);
    expect(dualJunctionLh!.dimensions.d3BimanualCoupling).toBe(0);
    expect(dualJunctionRh!.priorRisk).toBeLessThan(dualJunctionBoth!.priorRisk);
  });

  it("applies D1 unreachable-span max-floor (>= 0.75), D4 held-finger load, and D6 empirical posterior fusion", () => {
    const input = buildScoreDocLike({
      measures: 8,
      measureBuilder: (m, tpq) => ({
        heldOnAllNotesInMeasure: m === 4,
        notes:
          m === 4
            ? [
                { offsetTick: 0, durationTick: tpq * 4, midi: 60, hand: "RH" as const },
                { offsetTick: tpq, durationTick: tpq, midi: 74, hand: "RH" as const },
              ]
            : [0, 1, 2, 3].map((b) => ({
                offsetTick: b * tpq,
                durationTick: tpq,
                midi: 60 + b,
                hand: "RH" as const,
              })),
        meta: m === 4 ? { barlineLeft: "double" } : undefined,
      }),
    });

    const staticRes = analyzeScoreStatic(input);
    const baseSolve = solveFingering(input.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const sliceAtM4 = input.onsetSlices.find((s) => s.measureIndex === 4)!;

    const solveWithUnreachable: SolveResult = {
      ...baseSolve,
      transitionCues: [
        ...baseSolve.transitionCues,
        {
          sliceId: sliceAtM4.sliceId,
          hand: "RH",
          measureIndex: 4,
          type: "unreachable-span",
          severity: "danger",
          cost: 5,
          label: "Unreachable span",
        },
      ],
    };

    const overlay = analyzeMotorOverlay(staticRes, input, solveWithUnreachable, "rh-only");
    const j4 = overlay.chunkJunctions.find((j) => j.measureIndex === 4)!;
    expect(j4.dimensions.d1TransitionHazard).toBe(1.0);
    expect(j4.dimensions.d4HeldFingerLoad).toBeGreaterThan(0);
    expect(j4.priorRisk).toBeGreaterThanOrEqual(0.75);

    const lowRiskJ = overlay.chunkJunctions.find((j) => j.measureIndex !== 4) ?? j4;
    const withEmpirical = analyzeMotorOverlay(staticRes, input, baseSolve, "rh-only", {
      empiricalByJunctionId: {
        [lowRiskJ.junctionId]: { faultCount: 3, hesitationCount: 2, attempts: 3 },
      },
    });
    const jEmp = withEmpirical.chunkJunctions.find((j) => j.junctionId === lowRiskJ.junctionId)!;
    expect(jEmp.dimensions.d6EmpiricalPosterior).toBeGreaterThan(0.5);
    expect(jEmp.posteriorRisk).toBeGreaterThan(jEmp.priorRisk);
  });

  it("enforces Chaffin PerformanceCue hierarchy (Switch > Structural > Technical > collapsed Expressive), 2-measure NMS merge, and <= 1 primary cue per 4–8 measures", () => {
    const input = buildScoreDocLike({
      measures: 24,
      bpm: 150,
      measureBuilder: (m, tpq) => {
        // Repeated theme m.0..3 and m.8..11 with divergent endings at m.4 and m.12,
        // plus extreme technical jump at m.4 & m.16, and expressive fermata at m.7
        const baseNotes = [60, 62, 64, 65];
        if ((m >= 0 && m <= 3) || (m >= 8 && m <= 11)) {
          return {
            notes: baseNotes.map((midi, b) => ({
              offsetTick: b * tpq,
              durationTick: tpq,
              midi,
              hand: "RH" as const,
            })),
            meta: m === 8 ? { barlineLeft: "double", rehearsalMark: "B" } : undefined,
          };
        }
        if (m === 4 || m === 5) {
          return {
            notes: [88, 90, 91, 93].map((midi, b) => ({
              offsetTick: b * tpq,
              durationTick: tpq,
              midi,
              hand: "RH" as const,
            })),
            meta: m === 4 ? { barlineLeft: "double" } : undefined,
          };
        }
        if (m === 12 || m === 13) {
          return {
            notes: [55, 53, 52, 50].map((midi, b) => ({
              offsetTick: b * tpq,
              durationTick: tpq,
              midi,
              hand: "RH" as const,
            })),
          };
        }
        return {
          notes: [0, 1, 2, 3].map((b) => ({
            offsetTick: b * tpq,
            durationTick: tpq,
            midi: m === 16 ? 86 + b : 64 + ((m + b) % 5),
            hand: "RH" as const,
          })),
          meta: m === 7 ? { hasFermata: true } : m === 16 ? { barlineLeft: "double" } : undefined,
        };
      },
    });

    const staticRes = analyzeScoreStatic(input);
    const solveRes = solveFingering(input.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const overlay = analyzeMotorOverlay(staticRes, input, solveRes, "both");

    const primaryCues = overlay.performanceCues.filter((c) => c.isPrimary);
    const expressiveCues = overlay.performanceCues.filter((c) => c.kind === "expressive");

    // Expressive cues are collapsed by default
    for (const exp of expressiveCues) {
      expect(exp.collapsed).toBe(true);
      expect(exp.isPrimary).toBe(false);
    }

    // Hard density cap: <= 1 primary cue per 4 measures globally & in every 4-measure window
    expect(primaryCues.length).toBeLessThanOrEqual(Math.floor(input.measureCount / 4));
    for (let startM = 0; startM < input.measureCount; startM++) {
      const inWindow = primaryCues.filter(
        (c) => c.measureIndex >= startM && c.measureIndex < startM + 4,
      );
      expect(inWindow.length).toBeLessThanOrEqual(1);
    }

    // 2-measure NMS check: no two primary cues within < 2 measures, and Switch outranks Structural/Technical
    for (let i = 0; i < primaryCues.length - 1; i++) {
      expect(primaryCues[i + 1].measureIndex - primaryCues[i].measureIndex).toBeGreaterThanOrEqual(2);
    }

    // Every primary cue has a complete offline label
    for (const cue of primaryCues) {
      expect(cue.label.trim().length).toBeGreaterThan(0);
    }

    // Switch cues present (priority 2.0 > Structural 1.5)
    expect(primaryCues.some((c) => c.kind === "switch")).toBe(true);
  });

  it("produces deterministic motor overlay snapshots across test-corpus/01..05", async () => {
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
      const staticRes = analyzeScoreStatic(doc);
      const solveRes = solveFingering(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

      const o1 = analyzeMotorOverlay(staticRes, doc, solveRes, "both");
      const o2 = analyzeMotorOverlay(staticRes, doc, solveRes, "both");
      const stripTiming = (o: MotorOverlayResult) => ({ ...o, overlayTimeMs: 0 });
      expect(stripTiming(o1)).toEqual(stripTiming(o2));

      const primary = o1.performanceCues.filter((c) => c.isPrimary);
      expect(primary.length).toBeLessThanOrEqual(
        doc.measureCount < 4 ? 1 : Math.floor(doc.measureCount / 4),
      );

      summaries[file] = {
        junctionCount: o1.chunkJunctions.length,
        highRiskJunctionMeasures: o1.chunkJunctions
          .filter((j) => j.isHighRisk)
          .map((j) => j.measureIndex),
        primaryCues: primary.map((c) => ({
          kind: c.kind,
          roles: c.roles,
          measure: c.measureIndex,
        })),
        collapsedExpressiveCount: o1.performanceCues.filter((c) => c.collapsed).length,
        clusterMotorReuse: o1.passageClusters.map((cl) =>
          cl.instances.map((i) => ({
            m: i.startMeasureIndex,
            iso: Number(i.fingeringIsomorphism.toFixed(2)),
            reuse: Number(i.motorReuse.toFixed(2)),
          })),
        ),
      };
    }

    expect(summaries).toMatchSnapshot();
  });

  it("meets the < 2 ms budget for analyzeMotorOverlay on a synthetic 200-measure / 4000-note score", () => {
    const input200 = buildScoreDocLike({
      measures: 200,
      measureBuilder: (m, tpq) => {
        const notes = [];
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

    const staticRes = analyzeScoreStatic(input200);
    const solveRes = solveFingering(input200.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    // Warm up JIT
    analyzeMotorOverlay(staticRes, input200, solveRes, "both");

    const t0 = performance.now();
    const overlay = analyzeMotorOverlay(staticRes, input200, solveRes, "both");
    const elapsed = performance.now() - t0;

    expect(overlay.chunkJunctions.length).toBe(staticRes.motorChunks.length - 1);
    expect(elapsed).toBeLessThan(perfBudget(2));
  });
});
