import { IDBFactory } from "fake-indexeddb";
import { createIndexedDbStorage } from "../src/persistence/indexedDbStorage";
import { createPracticeBackup, importPracticeBackup } from "../src/persistence/backupMerge";
import { copyStorageRecord } from "../src/persistence/storageRecords";
import type { PieceProfile } from "../src/persistence/storagePort";
import { saveWorkspace } from "../src/persistence/studioPersistence";
import { parseMusicXml } from "../src/musicxml/parser";
import { getScoreIdentity } from "../src/persistence/fingerprint";
import { JSDOM } from "jsdom";
import { describe, it, expect } from "vitest";
import { makeScoreCoord } from "../src/domain/scoreCoord";
import type {
  MeasureStructuralMeta,
  MeasureTimeline,
  NoteEvent,
  OnsetSlice,
} from "../src/domain/types";
import { DEFAULT_HAND_SPAN_PROFILE } from "../src/domain/types";
import { solveFingering } from "../src/solver/solveFingering";
import { analyzeScoreStatic } from "../src/chunking/staticAnalyzer";
import { analyzeMotorOverlay } from "../src/chunking/motorOverlay";
import {
  applyChunkOverrides,
  applyPerformanceCueOverrides,
  mergeChunksAtBoundary,
  normalizeScoreCoord,
  resetChunkOverrides,
  resetPerformanceCueOverrides,
  splitChunkAtCoord,
  upsertPerformanceCueOverride,
} from "../src/chunking/chunkOverrides";
import type { StaticScoreInput } from "../src/chunking/types";

function buildBimanualTestScore(measures = 8): StaticScoreInput {
  const tpq = 480;
  const bpm = 120;
  const measureTicks = tpq * 4;
  const secPerTick = 60 / bpm / tpq;
  const measureTimelines: MeasureTimeline[] = [];
  const measureStructuralMeta: MeasureStructuralMeta[] = [];
  const noteEvents: NoteEvent[] = [];
  const onsetSlices: OnsetSlice[] = [];
  let nId = 0;
  let sId = 0;

  for (let m = 0; m < measures; m++) {
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
    measureStructuralMeta.push({
      measureIndex: m,
      hasFermata: m === 3,
    });

    // Measure 2 -> 3 has a simultaneous dual-hand leap for D3 bimanual coupling test
    const rhBase = m >= 3 && m <= 4 ? 84 : 60;
    const lhBase = m >= 3 && m <= 4 ? 36 : 48;

    for (let b = 0; b < 4; b++) {
      const onsetTick = startTick + b * tpq;
      const rhEv: NoteEvent = {
        noteUid: `n-${nId++}`,
        measureIndex: m,
        onsetTick,
        scoreCoord: makeScoreCoord(m, b * tpq, tpq),
        durationTick: tpq,
        onsetSec: onsetTick * secPerTick,
        durationSec: tpq * secPerTick,
        midi: rhBase + (b % 4) * 2,
        hand: "RH",
        voice: "1",
        staff: 1,
        isGrace: false,
        isTieStop: false,
        isTieStart: false,
      };
      const lhEv: NoteEvent = {
        noteUid: `n-${nId++}`,
        measureIndex: m,
        onsetTick,
        scoreCoord: makeScoreCoord(m, b * tpq, tpq),
        durationTick: tpq,
        onsetSec: onsetTick * secPerTick,
        durationSec: tpq * secPerTick,
        midi: lhBase - (b % 2) * 2,
        hand: "LH",
        voice: "2",
        staff: 2,
        isGrace: false,
        isTieStop: false,
        isTieStart: false,
      };
      noteEvents.push(rhEv, lhEv);
      onsetSlices.push(
        {
          sliceId: `s-${sId++}`,
          hand: "RH",
          measureIndex: m,
          onsetTick,
          onsetSec: rhEv.onsetSec,
          isGrace: false,
          phraseId: 0,
          notes: [rhEv],
          heldNotes: [],
        },
        {
          sliceId: `s-${sId++}`,
          hand: "LH",
          measureIndex: m,
          onsetTick,
          onsetSec: lhEv.onsetSec,
          isGrace: false,
          phraseId: 0,
          notes: [lhEv],
          heldNotes: [],
        },
      );
    }
  }

  return {
    noteEvents,
    onsetSlices,
    measureTimelines,
    ticksPerQuarter: tpq,
    measureCount: measures,
    measureStructuralMeta,
    tempoPoints: [{ tick: 0, bpm }],
  };
}

describe("chunkOverrides: boundary-delta Split/Merge & PerformanceCue overrides", () => {
  it("normalizes ScoreCoord across arbitrary <divisions> ratios", () => {
    expect(normalizeScoreCoord({ measureIndex: 3, beatNum: 240, beatDen: 480 })).toEqual({
      measureIndex: 3,
      beatNum: 1,
      beatDen: 2,
    });
    expect(normalizeScoreCoord({ measureIndex: 2, beatNum: 0, beatDen: 960 })).toEqual({
      measureIndex: 2,
      beatNum: 0,
      beatDen: 1,
    });
  });

  it("splits a multi-measure MotorChunk at a <divisions>-invariant ScoreCoord, marks userPinned = true, and updates MacroSection.chunkIds", () => {
    const score = buildBimanualTestScore(8);
    const staticResult = analyzeScoreStatic(score);

    // Find a multi-measure chunk (or split measure 1/2 depending on first chunk)
    const multi = staticResult.motorChunks.find((c) => c.measureCount >= 2);
    expect(multi).toBeDefined();
    const splitMeasure = multi!.startMeasureIndex + 1;

    // Provide unreduced divisions=480 style coord { measureIndex: splitMeasure, beatNum: 0, beatDen: 480 }
    const overrides = splitChunkAtCoord(
      undefined,
      staticResult,
      { measureIndex: splitMeasure, beatNum: 0, beatDen: 480 },
      1000,
    );
    expect(overrides.addedBoundaries).toEqual([
      { measureIndex: splitMeasure, beatNum: 0, beatDen: 1 },
    ]);

    const overridden = applyChunkOverrides(staticResult, overrides);
    expect(overridden.motorChunks.length).toBe(staticResult.motorChunks.length + 1);

    const left = overridden.motorChunks.find((c) => c.endMeasureIndex === splitMeasure - 1);
    const right = overridden.motorChunks.find((c) => c.startMeasureIndex === splitMeasure);
    expect(left?.userPinned).toBe(true);
    expect(right?.userPinned).toBe(true);

    // MacroSections must reference the updated chunkIds consistently
    const sectionChunkIds = overridden.macroSections.flatMap((s) => s.chunkIds);
    expect(sectionChunkIds).toEqual(overridden.motorChunks.map((c) => c.chunkId));
  });

  it("merges two adjacent MotorChunks across an auto boundary and removes the interior ChunkJunction", () => {
    const score = buildBimanualTestScore(8);
    const staticResult = analyzeScoreStatic(score);
    expect(staticResult.motorChunks.length).toBeGreaterThanOrEqual(2);

    const boundary = staticResult.motorChunks[1].startCoord;
    const overrides = mergeChunksAtBoundary(undefined, staticResult, boundary, 2000);
    expect(overrides.removedBoundaries).toHaveLength(1);

    const overridden = applyChunkOverrides(staticResult, overrides);
    expect(overridden.motorChunks.length).toBe(staticResult.motorChunks.length - 1);
    expect(overridden.motorChunks[0].userPinned).toBe(true);
    expect(overridden.motorChunks[0].endMeasureIndex).toBe(
      staticResult.motorChunks[1].endMeasureIndex,
    );

    const solveResult = solveFingering(score.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const overlay = analyzeMotorOverlay(overridden, score, solveResult, "both");
    expect(overlay.chunkJunctions).toHaveLength(overridden.motorChunks.length - 1);
    expect(
      overlay.chunkJunctions.some((j) => j.boundaryCoord.measureIndex === boundary.measureIndex),
    ).toBe(false);

    // Reset restores original chunks
    const reset = applyChunkOverrides(staticResult, resetChunkOverrides(3000));
    expect(reset.motorChunks.map((c) => [c.startMeasureIndex, c.endMeasureIndex])).toEqual(
      staticResult.motorChunks.map((c) => [c.startMeasureIndex, c.endMeasureIndex]),
    );
  });

  it("keeps MotorChunk boundaries invariant across PracticeMode while recomputing ChunkJunction risks dynamically per active hand", () => {
    const score = buildBimanualTestScore(8);
    const rawStatic = analyzeScoreStatic(score);
    // Pin a split at measure 3 (right where simultaneous dual-hand leap happens!)
    const overrides = splitChunkAtCoord(
      undefined,
      rawStatic,
      { measureIndex: 3, beatNum: 0, beatDen: 1 },
      5000,
    );
    const overridden = applyChunkOverrides(rawStatic, overrides);
    const solveResult = solveFingering(score.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    const bothOverlay = analyzeMotorOverlay(overridden, score, solveResult, "both");
    const rhOverlay = analyzeMotorOverlay(overridden, score, solveResult, "rh-only");
    const lhOverlay = analyzeMotorOverlay(overridden, score, solveResult, "lh-only");

    // Boundaries stay identical across PracticeModes
    const expectedSpans = overridden.motorChunks.map((c) => [
      c.startMeasureIndex,
      c.endMeasureIndex,
      Boolean(c.userPinned),
    ]);
    expect(
      applyChunkOverrides(rawStatic, overrides).motorChunks.map((c) => [
        c.startMeasureIndex,
        c.endMeasureIndex,
        Boolean(c.userPinned),
      ]),
    ).toEqual(expectedSpans);

    const jBoth = bothOverlay.chunkJunctions.find((j) => j.measureIndex === 3);
    const jRh = rhOverlay.chunkJunctions.find((j) => j.measureIndex === 3);
    const jLh = lhOverlay.chunkJunctions.find((j) => j.measureIndex === 3);
    expect(jBoth).toBeDefined();
    expect(jRh).toBeDefined();
    expect(jLh).toBeDefined();

    // Both-hands includes bimanual coupling D3, whereas single-hand strips D3
    expect(jBoth!.dimensions.d3BimanualCoupling).toBeGreaterThan(0);
    expect(jRh!.dimensions.d3BimanualCoupling).toBe(0);
    expect(jLh!.dimensions.d3BimanualCoupling).toBe(0);
    expect(jBoth!.priorRisk).toBeGreaterThan(jRh!.priorRisk);
  });

  it("supports Pin, Add, Hide, custom imagery label editing, and reset-to-auto on PerformanceCues", () => {
    const score = buildBimanualTestScore(8);
    const staticResult = analyzeScoreStatic(score);
    const solveResult = solveFingering(score.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const overlay = analyzeMotorOverlay(staticResult, score, solveResult, "both");

    const structuralCue = overlay.performanceCues.find((c) => c.kind === "structural");
    const expressiveCue = overlay.performanceCues.find((c) => c.kind === "expressive");
    expect(structuralCue).toBeDefined();
    expect(expressiveCue).toBeDefined();
    expect(expressiveCue!.collapsed).toBe(true);

    // 1. Pin collapsed expressive cue + give it a custom imagery label
    let overrides = upsertPerformanceCueOverride(
      undefined,
      {
        coord: expressiveCue!.coord,
        kind: "expressive",
        pinned: true,
        customLabel: "像铃铛一样呼吸",
      },
      100,
    );

    // 2. Hide the structural cue
    overrides = upsertPerformanceCueOverride(
      overrides,
      {
        coord: structuralCue!.coord,
        kind: structuralCue!.kind,
        hidden: true,
      },
      200,
    );

    // 3. Add a brand-new user cue at measure 5
    overrides = upsertPerformanceCueOverride(
      overrides,
      {
        coord: { measureIndex: 5, beatNum: 0, beatDen: 1 },
        kind: "technical",
        pinned: true,
        customLabel: "左手提前落位",
      },
      300,
    );

    const updatedCues = applyPerformanceCueOverrides(overlay.performanceCues, overrides);

    const pinnedExp = updatedCues.find(
      (c) => c.measureIndex === expressiveCue!.measureIndex && c.kind === "expressive",
    );
    expect(pinnedExp).toMatchObject({
      userPinned: true,
      collapsed: false,
      isPrimary: true,
      customLabel: "像铃铛一样呼吸",
    });

    const hiddenStruct = updatedCues.find((c) => c.cueId === structuralCue!.cueId);
    expect(hiddenStruct?.hidden).toBe(true);

    const added = updatedCues.find(
      (c) => c.measureIndex === 5 && c.customLabel === "左手提前落位",
    );
    expect(added).toMatchObject({
      userPinned: true,
      isPrimary: true,
      collapsed: false,
      kind: "technical",
    });

    // 4. Reset-to-auto restores exact original cues
    const restored = applyPerformanceCueOverrides(
      overlay.performanceCues,
      resetPerformanceCueOverrides(400),
    );
    expect(restored).toEqual(overlay.performanceCues);
  });
});

describe("PieceProfile persistence & backupMerge for chunkOverrides and performanceCueOverrides", () => {
  it("persists chunkOverrides and performanceCueOverrides in IndexedDB and merges via LWW in JSON backup", async () => {
    const local = createIndexedDbStorage({ indexedDB: new IDBFactory() });
    const remote = createIndexedDbStorage({ indexedDB: new IDBFactory() });

    const baseProfile: PieceProfile = {
      pieceId: "piece-1",
      title: "Test Piece",
      fingerprints: ["fp-1"],
      measureHashesByFingerprint: { "fp-1": ["h0", "h1"] },
      chunkOverrides: {
        addedBoundaries: [{ measureIndex: 1, beatNum: 0, beatDen: 1 }],
        removedBoundaries: [],
        updatedAtMs: 500,
      },
      performanceCueOverrides: {
        entries: [
          {
            coord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
            kind: "structural",
            pinned: true,
            customLabel: "主题A起",
          },
        ],
        updatedAtMs: 100,
      },
    };

    const remoteProfile: PieceProfile = {
      ...baseProfile,
      chunkOverrides: {
        addedBoundaries: [{ measureIndex: 2, beatNum: 0, beatDen: 1 }],
        removedBoundaries: [],
        updatedAtMs: 200, // older than local (500)
      },
      performanceCueOverrides: {
        entries: [
          {
            coord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
            kind: "structural",
            pinned: true,
            customLabel: "主题A轻快起",
          },
        ],
        updatedAtMs: 800, // newer than local (100)
      },
    };

    await local.commit({ pieceProfiles: [baseProfile] });
    await remote.commit({ pieceProfiles: [remoteProfile] });

    const backup = await createPracticeBackup(remote);
    await importPracticeBackup(local, backup.metadataOnlyJson);

    const merged = await local.get("pieceProfiles", "piece-1");
    expect(merged?.chunkOverrides).toEqual(baseProfile.chunkOverrides);
    expect(merged?.performanceCueOverrides).toEqual(remoteProfile.performanceCueOverrides);

    await local.close();
    await remote.close();
  });

  it("rejects malformed chunkOverrides / performanceCueOverrides in backup import and still strips secrets", async () => {
    const storage = createIndexedDbStorage({ indexedDB: new IDBFactory() });
    const badChunkBackup = JSON.stringify({
      schemaVersion: 1,
      pieceProfiles: [
        {
          pieceId: "p1",
          title: "Bad",
          fingerprints: ["fp"],
          measureHashesByFingerprint: { fp: ["m0"] },
          chunkOverrides: { addedBoundaries: [{ measureIndex: 0, beatNum: 0, beatDen: 0 }], removedBoundaries: [], updatedAtMs: 1 },
        },
      ],
      practiceEvents: [],
      fingerAnchorDrafts: [],
      workspacePrefs: [],
    });
    await expect(importPracticeBackup(storage, badChunkBackup)).rejects.toThrow("备份格式无效");

    const badCueBackup = JSON.stringify({
      schemaVersion: 1,
      pieceProfiles: [
        {
          pieceId: "p1",
          title: "BadCue",
          fingerprints: ["fp"],
          measureHashesByFingerprint: { fp: ["m0"] },
          performanceCueOverrides: { entries: [{ coord: { measureIndex: -1, beatNum: 0, beatDen: 1 } }], updatedAtMs: 1 },
        },
      ],
      practiceEvents: [],
      fingerAnchorDrafts: [],
      workspacePrefs: [],
    });
    await expect(importPracticeBackup(storage, badCueBackup)).rejects.toThrow("备份格式无效");

    const sanitized = copyStorageRecord("pieceProfiles", {
      pieceId: "p1",
      title: "SecretTest",
      fingerprints: ["fp"],
      measureHashesByFingerprint: { fp: ["m0"] },
      performanceCueOverrides: {
        entries: [
          {
            coord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
            customLabel: "安全标签",
            ...({ apiKey: "secret-key" } as Record<string, unknown>),
          },
        ],
        updatedAtMs: 10,
      },
    });
    expect(JSON.stringify(sanitized)).not.toContain("secret-key");
    expect(sanitized.performanceCueOverrides?.entries[0]?.customLabel).toBe("安全标签");
    await storage.close();
  });

  it("preserves newer PieceProfile chunkOverrides and performanceCueOverrides during saveWorkspace", async () => {
    const storage = createIndexedDbStorage({ indexedDB: new IDBFactory() });
    const xml = `<score-partwise version="4.0"><work><work-title>SaveTest</work-title></work>
      <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">
      <measure number="1"><attributes><divisions>1</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><staff>1</staff></note></measure>
      </part></score-partwise>`;
    const { DOMParser } = new JSDOM("").window;
    const scoreDoc = parseMusicXml(xml, { DOMParser });
    const fp = getScoreIdentity(scoreDoc).fingerprint;

    const initial: PieceProfile = {
      pieceId: "save-p1",
      title: "SaveTest",
      fingerprints: [fp],
      measureHashesByFingerprint: { [fp]: getScoreIdentity(scoreDoc).measureHashes },
    };
    await storage.commit({ pieceProfiles: [initial] });

    const updated: PieceProfile = {
      ...initial,
      chunkOverrides: {
        addedBoundaries: [{ measureIndex: 0, beatNum: 1, beatDen: 2 }],
        removedBoundaries: [],
        updatedAtMs: Date.now() + 1000,
      },
      performanceCueOverrides: {
        entries: [
          {
            coord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
            kind: "technical",
            pinned: true,
            customLabel: "手位稳定",
          },
        ],
        updatedAtMs: Date.now() + 1000,
      },
    };

    const saved = await saveWorkspace(
      storage,
      updated,
      {
        rawXmlText: xml,
        scoreDoc,
        fileName: "test.musicxml",
        exportFormat: "musicxml",
        anchors: {},
        removedRawAnchorUids: [],
        prefs: {},
      },
      { profile: true },
      async () => new Uint8Array([1]),
    );

    expect(saved.chunkOverrides).toEqual(updated.chunkOverrides);
    expect(saved.performanceCueOverrides).toEqual(updated.performanceCueOverrides);
    const fromDb = await storage.get("pieceProfiles", "save-p1");
    expect(fromDb?.chunkOverrides).toEqual(updated.chunkOverrides);
    expect(fromDb?.performanceCueOverrides).toEqual(updated.performanceCueOverrides);
    await storage.close();
  });
});

