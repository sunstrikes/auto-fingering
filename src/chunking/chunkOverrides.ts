import type { ScoreCoord } from "../domain/types";
import type {
  ChunkOverrides,
  MacroSection,
  MotorChunk,
  PerformanceCue,
  PerformanceCueKind,
  PerformanceCueOverrideEntry,
  PerformanceCueOverrides,
  StaticChunkingResult,
} from "./types";

export type {
  ChunkOverrides,
  PerformanceCueOverrideEntry,
  PerformanceCueOverrides,
} from "./types";

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y > 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

/**
 * Reduces a ScoreCoord to canonical lowest-terms rational form so boundary
 * comparisons remain invariant across MusicXML `<divisions>` changes.
 */
export function normalizeScoreCoord(coord: ScoreCoord): ScoreCoord {
  const safeDen = Math.max(1, Math.trunc(coord.beatDen));
  const safeNum = Math.trunc(coord.beatNum);
  if (safeNum === 0) {
    return {
      measureIndex: coord.measureIndex,
      beatNum: 0,
      beatDen: 1,
      ...(coord.graceOrder !== undefined ? { graceOrder: coord.graceOrder } : {}),
    };
  }
  const divisor = gcd(safeNum, safeDen);
  return {
    measureIndex: coord.measureIndex,
    beatNum: safeNum / divisor,
    beatDen: safeDen / divisor,
    ...(coord.graceOrder !== undefined ? { graceOrder: coord.graceOrder } : {}),
  };
}

/** Compares two ScoreCoords in chronological score order. */
export function compareScoreCoords(a: ScoreCoord, b: ScoreCoord): number {
  if (a.measureIndex !== b.measureIndex) {
    return a.measureIndex - b.measureIndex;
  }
  const diff = a.beatNum * b.beatDen - b.beatNum * a.beatDen;
  if (diff !== 0) return diff;
  return (a.graceOrder ?? -1) - (b.graceOrder ?? -1);
}

/** Returns true when two ScoreCoords denote the exact same musical position. */
export function areScoreCoordsEqual(a: ScoreCoord, b: ScoreCoord): boolean {
  return compareScoreCoords(a, b) === 0;
}

function coordToFloatMeasure(coord: ScoreCoord): number {
  return coord.measureIndex + coord.beatNum / Math.max(1, coord.beatDen) / 4;
}

function findSectionForMeasure(
  macroSections: MacroSection[],
  measureIndex: number,
): string {
  for (const sec of macroSections) {
    if (measureIndex >= sec.startMeasureIndex && measureIndex <= sec.endMeasureIndex) {
      return sec.sectionId;
    }
  }
  return macroSections[0]?.sectionId ?? "sec-0";
}

function computeEndMeasureIndex(startMeasureIndex: number, endCoord: ScoreCoord): number {
  if (endCoord.beatNum === 0) {
    return Math.max(startMeasureIndex, endCoord.measureIndex - 1);
  }
  return Math.max(startMeasureIndex, endCoord.measureIndex);
}

function estimateStepCount(
  origChunks: MotorChunk[],
  startCoord: ScoreCoord,
  endCoord: ScoreCoord,
): number {
  const sFloat = coordToFloatMeasure(startCoord);
  const eFloat = coordToFloatMeasure(endCoord);
  let total = 0;

  for (const orig of origChunks) {
    const oStart = coordToFloatMeasure(orig.startCoord);
    const oEnd = coordToFloatMeasure(orig.endCoord);
    const overlap = Math.max(0, Math.min(eFloat, oEnd) - Math.max(sFloat, oStart));
    if (overlap <= 1e-9) continue;
    const origSpan = Math.max(1e-6, oEnd - oStart);
    if (overlap >= origSpan - 1e-6) {
      total += orig.stepCount;
    } else {
      total += Math.round((orig.stepCount * overlap) / origSpan);
    }
  }

  return Math.max(0, total);
}

/**
 * Applies `<divisions>`-invariant ScoreCoord boundary deltas (`addedBoundaries` /
 * `removedBoundaries`) to a StaticChunkingResult without mutating the input.
 * Chunks created or altered by manual overrides are marked `userPinned = true`.
 */
export function applyChunkOverrides(
  staticResult: StaticChunkingResult,
  chunkOverrides?: ChunkOverrides | null,
): StaticChunkingResult {
  const origChunks = staticResult.motorChunks;
  if (
    origChunks.length === 0 ||
    !chunkOverrides ||
    (chunkOverrides.addedBoundaries.length === 0 &&
      chunkOverrides.removedBoundaries.length === 0)
  ) {
    return staticResult;
  }

  const pieceStart = normalizeScoreCoord(origChunks[0].startCoord);
  const pieceEnd = normalizeScoreCoord(origChunks[origChunks.length - 1].endCoord);

  const removedNormalized = chunkOverrides.removedBoundaries.map(normalizeScoreCoord);
  const addedNormalized = chunkOverrides.addedBoundaries.map(normalizeScoreCoord);

  const autoInterior = origChunks
    .slice(1)
    .map((c) => normalizeScoreCoord(c.startCoord));

  const keptInterior: Array<{ coord: ScoreCoord; fromAdded: boolean; origChunk?: MotorChunk }> = [];

  for (let i = 0; i < autoInterior.length; i++) {
    const b = autoInterior[i];
    if (!removedNormalized.some((r) => areScoreCoordsEqual(r, b))) {
      keptInterior.push({ coord: b, fromAdded: false, origChunk: origChunks[i + 1] });
    }
  }

  for (const added of addedNormalized) {
    if (
      compareScoreCoords(added, pieceStart) <= 0 ||
      compareScoreCoords(added, pieceEnd) >= 0
    ) {
      continue;
    }
    if (!keptInterior.some((item) => areScoreCoordsEqual(item.coord, added))) {
      keptInterior.push({ coord: added, fromAdded: true });
    }
  }

  keptInterior.sort((a, b) => compareScoreCoords(a.coord, b.coord));

  const boundaryPoints: Array<{ coord: ScoreCoord; fromAdded: boolean; origStartChunk?: MotorChunk }> = [
    { coord: pieceStart, fromAdded: false, origStartChunk: origChunks[0] },
    ...keptInterior.map((item) => ({
      coord: item.coord,
      fromAdded: item.fromAdded,
      origStartChunk: item.origChunk,
    })),
    { coord: pieceEnd, fromAdded: false },
  ];

  const newChunks: MotorChunk[] = [];

  for (let i = 0; i < boundaryPoints.length - 1; i++) {
    const left = boundaryPoints[i];
    const right = boundaryPoints[i + 1];
    const startCoord = left.coord;
    const endCoord = right.coord;

    const exactOrig = origChunks.find(
      (c) =>
        areScoreCoordsEqual(c.startCoord, startCoord) &&
        areScoreCoordsEqual(c.endCoord, endCoord),
    );

    const chunkId = `chunk-${i}`;
    if (exactOrig) {
      newChunks.push({
        ...exactOrig,
        chunkId,
        index: i,
      });
      continue;
    }

    const startMeasureIndex = startCoord.measureIndex;
    const endMeasureIndex = computeEndMeasureIndex(startMeasureIndex, endCoord);
    const measureCount = Math.max(1, endMeasureIndex - startMeasureIndex + 1);
    const stepCount = estimateStepCount(origChunks, startCoord, endCoord);
    const origEndChunk = origChunks.find((c) => areScoreCoordsEqual(c.endCoord, endCoord));

    newChunks.push({
      chunkId,
      index: i,
      sectionId: findSectionForMeasure(staticResult.macroSections, startMeasureIndex),
      startMeasureIndex,
      endMeasureIndex,
      startCoord,
      endCoord,
      measureCount,
      stepCount,
      densityStepsPerMeasure: stepCount / measureCount,
      hasAnacrusisLeadIn:
        left.origStartChunk?.hasAnacrusisLeadIn ?? startCoord.beatNum > 0,
      anacrusisBeats: left.origStartChunk?.anacrusisBeats ?? 0,
      overlapFlag: origEndChunk?.overlapFlag ?? false,
      boundaryConfidence: left.fromAdded
        ? 1.0
        : (left.origStartChunk?.boundaryConfidence ?? 1.0),
      userPinned: true,
    });
  }

  const chunkIdsBySection = new Map<string, string[]>();
  for (const sec of staticResult.macroSections) {
    chunkIdsBySection.set(sec.sectionId, []);
  }
  for (const chunk of newChunks) {
    const bucket = chunkIdsBySection.get(chunk.sectionId);
    if (bucket) {
      bucket.push(chunk.chunkId);
    } else if (staticResult.macroSections[0]) {
      chunkIdsBySection.get(staticResult.macroSections[0].sectionId)?.push(chunk.chunkId);
    }
  }

  const updatedSections = staticResult.macroSections.map((sec) => ({
    ...sec,
    chunkIds: chunkIdsBySection.get(sec.sectionId) ?? [],
  }));

  return {
    ...staticResult,
    macroSections: updatedSections,
    motorChunks: newChunks,
  };
}

/**
 * Adds a manual Split boundary at `boundaryCoord` (or restores an auto boundary
 * previously removed by a Merge).
 */
export function splitChunkAtCoord(
  current: ChunkOverrides | null | undefined,
  staticResult: StaticChunkingResult,
  boundaryCoord: ScoreCoord,
  nowMs = Date.now(),
): ChunkOverrides {
  const norm = normalizeScoreCoord(boundaryCoord);
  const autoBoundaries = staticResult.motorChunks
    .slice(1)
    .map((c) => normalizeScoreCoord(c.startCoord));
  const isAutoBoundary = autoBoundaries.some((b) => areScoreCoordsEqual(b, norm));

  const nextRemoved = (current?.removedBoundaries ?? []).filter(
    (b) => !areScoreCoordsEqual(b, norm),
  );
  const prevAdded = current?.addedBoundaries ?? [];
  const nextAdded =
    !isAutoBoundary && !prevAdded.some((b) => areScoreCoordsEqual(b, norm))
      ? [...prevAdded, norm]
      : [...prevAdded];

  return {
    addedBoundaries: nextAdded,
    removedBoundaries: nextRemoved,
    updatedAtMs: nowMs,
  };
}

/**
 * Merges two adjacent chunks across `boundaryCoord` by removing the added
 * boundary or recording an auto boundary in `removedBoundaries`.
 */
export function mergeChunksAtBoundary(
  current: ChunkOverrides | null | undefined,
  staticResult: StaticChunkingResult,
  boundaryCoord: ScoreCoord,
  nowMs = Date.now(),
): ChunkOverrides {
  const norm = normalizeScoreCoord(boundaryCoord);
  const prevAdded = current?.addedBoundaries ?? [];
  const wasAdded = prevAdded.some((b) => areScoreCoordsEqual(b, norm));
  const nextAdded = prevAdded.filter((b) => !areScoreCoordsEqual(b, norm));

  const autoBoundaries = staticResult.motorChunks
    .slice(1)
    .map((c) => normalizeScoreCoord(c.startCoord));
  const isAutoBoundary = autoBoundaries.some((b) => areScoreCoordsEqual(b, norm));

  const prevRemoved = current?.removedBoundaries ?? [];
  const nextRemoved =
    !wasAdded &&
    isAutoBoundary &&
    !prevRemoved.some((b) => areScoreCoordsEqual(b, norm))
      ? [...prevRemoved, norm]
      : [...prevRemoved];

  return {
    addedBoundaries: nextAdded,
    removedBoundaries: nextRemoved,
    updatedAtMs: nowMs,
  };
}

/** Clears all manual chunk Split/Merge overrides while stamping `updatedAtMs` for LWW sync. */
export function resetChunkOverrides(nowMs = Date.now()): ChunkOverrides {
  return {
    addedBoundaries: [],
    removedBoundaries: [],
    updatedAtMs: nowMs,
  };
}

function matchesCueEntry(cue: PerformanceCue, entry: PerformanceCueOverrideEntry): boolean {
  if (!areScoreCoordsEqual(cue.coord, entry.coord)) return false;
  if (!entry.kind) return true;
  return cue.kind === entry.kind || cue.roles.includes(entry.kind);
}

/**
 * Applies user Performance Cue overrides (Pin / Add / Hide / custom imagery label)
 * on top of auto-generated cues without mutating the input array.
 */
export function applyPerformanceCueOverrides(
  cues: PerformanceCue[],
  overrides?: PerformanceCueOverrides | null,
): PerformanceCue[] {
  if (!overrides || overrides.entries.length === 0) {
    return cues;
  }

  const entries = overrides.entries.map((entry) => ({
    ...entry,
    coord: normalizeScoreCoord(entry.coord),
  }));
  const matchedEntryIndices = new Set<number>();

  const result: PerformanceCue[] = cues.map((cue) => {
    const entryIndex = entries.findIndex((entry) => matchesCueEntry(cue, entry));
    if (entryIndex < 0) return cue;

    matchedEntryIndices.add(entryIndex);
    const entry = entries[entryIndex];
    const hasCustomLabel = entry.customLabel !== undefined && entry.customLabel.trim().length > 0;

    return {
      ...cue,
      ...(entry.pinned ? { userPinned: true, collapsed: false, isPrimary: true } : {}),
      ...(entry.hidden !== undefined ? { hidden: entry.hidden } : {}),
      ...(hasCustomLabel
        ? { customLabel: entry.customLabel!.trim(), userPinned: true }
        : entry.customLabel !== undefined
          ? { customLabel: undefined }
          : {}),
    };
  });

  for (let i = 0; i < entries.length; i++) {
    if (matchedEntryIndices.has(i)) continue;
    const entry = entries[i];
    if (entry.hidden) continue;

    const kind: PerformanceCueKind = entry.kind ?? "expressive";
    const trimmedLabel = entry.customLabel?.trim();
    result.push({
      cueId: `cue-user-${entry.coord.measureIndex}-${entry.coord.beatNum}-${entry.coord.beatDen}-${kind}`,
      kind,
      roles: [kind],
      priorityWeight: 1.8,
      coord: entry.coord,
      measureIndex: entry.coord.measureIndex,
      label: trimmedLabel || `m.${entry.coord.measureIndex + 1} 自定义检索锚点`,
      ...(trimmedLabel ? { customLabel: trimmedLabel } : {}),
      collapsed: false,
      isPrimary: true,
      userPinned: true,
    });
  }

  return result.sort(
    (a, b) =>
      a.measureIndex - b.measureIndex ||
      compareScoreCoords(a.coord, b.coord) ||
      Number(b.isPrimary) - Number(a.isPrimary),
  );
}

/** Inserts or updates a single Performance Cue override entry by ScoreCoord + kind. */
export function upsertPerformanceCueOverride(
  current: PerformanceCueOverrides | null | undefined,
  entry: PerformanceCueOverrideEntry,
  nowMs = Date.now(),
): PerformanceCueOverrides {
  const normalizedEntry: PerformanceCueOverrideEntry = {
    ...entry,
    coord: normalizeScoreCoord(entry.coord),
  };

  const existing = current?.entries ?? [];
  const idx = existing.findIndex(
    (e) =>
      areScoreCoordsEqual(e.coord, normalizedEntry.coord) &&
      (e.kind ?? undefined) === (normalizedEntry.kind ?? undefined),
  );

  const nextEntries = [...existing];
  if (idx >= 0) {
    nextEntries[idx] = { ...existing[idx], ...normalizedEntry };
  } else {
    nextEntries.push(normalizedEntry);
  }

  return {
    entries: nextEntries,
    updatedAtMs: nowMs,
  };
}

/** Removes a specific Performance Cue override entry (e.g. un-hiding or removing a user-added cue). */
export function removePerformanceCueOverride(
  current: PerformanceCueOverrides | null | undefined,
  coord: ScoreCoord,
  kind?: PerformanceCueKind,
  nowMs = Date.now(),
): PerformanceCueOverrides {
  const norm = normalizeScoreCoord(coord);
  const nextEntries = (current?.entries ?? []).filter(
    (e) => !(areScoreCoordsEqual(e.coord, norm) && (kind === undefined || e.kind === kind)),
  );
  return {
    entries: nextEntries,
    updatedAtMs: nowMs,
  };
}

/** Clears all Performance Cue overrides while stamping `updatedAtMs` for LWW sync. */
export function resetPerformanceCueOverrides(nowMs = Date.now()): PerformanceCueOverrides {
  return {
    entries: [],
    updatedAtMs: nowMs,
  };
}
