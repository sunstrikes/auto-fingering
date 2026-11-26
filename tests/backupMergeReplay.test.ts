// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { PracticeBackupPanel } from "../src/components/PracticeBackupPanel";
import { MOTOR_FSRS_REDUCER_VERSION, type PiecePracticeState } from "../src/guided/motorFsrs";
import {
  createPracticeBackup,
  importPracticeBackup,
  previewPracticeBackupImport,
} from "../src/persistence/backupMerge";
import { createIndexedDbStorage } from "../src/persistence/indexedDbStorage";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import type { PieceProfile, PracticeEvent } from "../src/persistence/storagePort";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const DAY_MS = 24 * 60 * 60 * 1000;
const roots: ReturnType<typeof createRoot>[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function makeEvent(overrides: Partial<PracticeEvent> = {}): PracticeEvent {
  return {
    eventId: overrides.eventId ?? "ev-1",
    pieceId: overrides.pieceId ?? "p1",
    scoreFingerprint: overrides.scoreFingerprint ?? "fp-1",
    timestampMs: overrides.timestampMs ?? Date.UTC(2026, 10, 10, 10, 0, 0),
    localDateKey: overrides.localDateKey ?? "2026-11-10",
    timezoneOffsetMin: overrides.timezoneOffsetMin ?? 0,
    sessionId: overrides.sessionId ?? "sess-1",
    boutKind: overrides.boutKind ?? "chunk",
    startCoord: overrides.startCoord ?? { measureIndex: 0, beatNum: 0, beatDen: 1 },
    endCoord: overrides.endCoord ?? { measureIndex: 2, beatNum: 0, beatDen: 1 },
    practiceMode: overrides.practiceMode ?? "both",
    speedMultiplier: overrides.speedMultiplier ?? 0.75,
    durationSec: overrides.durationSec ?? 30,
    passCount: overrides.passCount ?? 1,
    wasColdFirstPass: overrides.wasColdFirstPass ?? true,
    scaffoldingLevel: overrides.scaffoldingLevel ?? 1,
    autoGrade: overrides.autoGrade ?? 3,
    fluency: overrides.fluency ?? {
      pitchAccuracy: 0.98,
      interiorHesitationCount: 0,
      junctionHesitationRatio: 1,
      timingCv: 0.04,
      stallDetected: false,
      dominantHandFaultRatio: { rh: 0.5, lh: 0.5 },
      switchBranchMismatch: false,
      reanchorCount: 0,
    },
    measureFaultCounts: overrides.measureFaultCounts ?? {},
    ...overrides,
  };
}

describe("Multi-device JSON union replay merge & conflict preview", () => {
  it("performs commutative (A ∪ B = B ∪ A) and idempotent two-device merge, unifying profiles and rebuilding derivedSnapshots & bestStableSpeed", async () => {
    const t0 = Date.UTC(2026, 10, 10, 10, 0, 0);

    // Device A practiced measures [0..2) up to 0.75x over 2 days under pieceId "dev-a"
    const devA = createInMemoryStorage();
    const profileA: PieceProfile = {
      pieceId: "dev-a",
      title: "Invention No. 1",
      fingerprints: ["fp-shared", "fp-a-repair"],
      measureHashesByFingerprint: {
        "fp-shared": ["h0", "h1", "h2", "h3"],
        "fp-a-repair": ["h0", "h1-mod", "h2", "h3"],
      },
      lastPracticedAtMs: t0 + DAY_MS,
    };
    const evA1 = makeEvent({
      eventId: "a-1",
      pieceId: "dev-a",
      scoreFingerprint: "fp-shared",
      timestampMs: t0,
      localDateKey: "2026-11-10",
      startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
      endCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
      speedMultiplier: 0.75,
    });
    const evA2 = makeEvent({
      eventId: "a-2",
      pieceId: "dev-a",
      scoreFingerprint: "fp-shared",
      timestampMs: t0 + DAY_MS,
      localDateKey: "2026-11-11",
      startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
      endCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
      speedMultiplier: 0.75,
    });
    await devA.commit({
      pieceProfiles: [profileA],
      practiceEvents: [evA1, evA2],
    });

    // Device B practiced measures [2..4) up to 0.90x under a DIFFERENT pieceId "dev-b" sharing "fp-shared"
    // plus an overlapping duplicate eventId "a-1" (should deduplicate!)
    const devB = createInMemoryStorage();
    const profileB: PieceProfile = {
      pieceId: "dev-b",
      title: "Invention No. 1",
      fingerprints: ["fp-shared", "fp-b-repair"],
      measureHashesByFingerprint: {
        "fp-shared": ["h0", "h1", "h2", "h3"],
        "fp-b-repair": ["h0", "h1", "h2-mod", "h3"],
      },
      lastPracticedAtMs: t0 + 2 * DAY_MS,
    };
    const evB1 = makeEvent({
      eventId: "b-1",
      pieceId: "dev-b",
      scoreFingerprint: "fp-shared",
      timestampMs: t0 + 12 * 60 * 60 * 1000,
      localDateKey: "2026-11-10",
      startCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
      endCoord: { measureIndex: 4, beatNum: 0, beatDen: 1 },
      speedMultiplier: 0.9,
      autoGrade: 4,
    });
    const evB2 = makeEvent({
      eventId: "b-2",
      pieceId: "dev-b",
      scoreFingerprint: "fp-shared",
      timestampMs: t0 + 2 * DAY_MS,
      localDateKey: "2026-11-12",
      startCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
      endCoord: { measureIndex: 4, beatNum: 0, beatDen: 1 },
      speedMultiplier: 0.9,
      autoGrade: 4,
    });
    const evADupOnB = { ...evA1, pieceId: "dev-b" };
    await devB.commit({
      pieceProfiles: [profileB],
      practiceEvents: [evADupOnB, evB1, evB2],
    });

    const backupA = await createPracticeBackup(devA);
    const backupB = await createPracticeBackup(devB);

    // Merge A <- B and B <- A
    await importPracticeBackup(devA, backupB.metadataOnlyJson);
    await importPracticeBackup(devB, backupA.metadataOnlyJson);

    const profilesAB = await devA.all("pieceProfiles");
    const profilesBA = await devB.all("pieceProfiles");
    expect(profilesAB).toHaveLength(1);
    expect(profilesBA).toHaveLength(1);
    expect(new Set(profilesAB[0].fingerprints)).toEqual(
      new Set(["fp-shared", "fp-a-repair", "fp-b-repair"]),
    );
    expect(new Set(profilesBA[0].fingerprints)).toEqual(new Set(profilesAB[0].fingerprints));
    expect(profilesAB[0].bestStableSpeed).toBe(0.9);
    expect(profilesBA[0].bestStableSpeed).toBe(0.9);

    const eventsAB = await devA.listPracticeEvents("dev-a");
    const eventsBA = await devB.listPracticeEvents("dev-b");
    expect(eventsAB.map((e) => e.eventId)).toEqual(["a-1", "b-1", "a-2", "b-2"]);
    expect(eventsBA.map((e) => e.eventId)).toEqual(["a-1", "b-1", "a-2", "b-2"]);

    const snapAB = await devA.get("derivedSnapshots", "dev-a");
    const snapBA = await devB.get("derivedSnapshots", "dev-b");
    expect(snapAB?.reducerVersion).toBe(MOTOR_FSRS_REDUCER_VERSION);
    expect(snapAB?.lastEventId).toBe("b-2");
    expect(snapBA?.lastEventId).toBe("b-2");

    const stateAB = snapAB!.state as PiecePracticeState;
    const stateBA = snapBA!.state as PiecePracticeState;
    expect(stateAB.bestStableSpeed).toBe(0.9);
    expect(stateBA.bestStableSpeed).toBe(0.9);
    expect(stateAB.chunkStates).toEqual(stateBA.chunkStates);

    // Idempotency: importing backupB again produces zero change
    await importPracticeBackup(devA, backupB.metadataOnlyJson);
    expect((await devA.listPracticeEvents("dev-a")).map((e) => e.eventId)).toEqual([
      "a-1",
      "b-1",
      "a-2",
      "b-2",
    ]);
    expect(await devA.get("derivedSnapshots", "dev-a")).toEqual(snapAB);
  });

  it("surfaces >=85% measure-similarity link preview when unlinked and unifies only when opted in", async () => {
    const hashesA = Array.from({ length: 14 }, (_, i) => `m-${i}`);
    const hashesB = [...hashesA];
    hashesB[0] = "m-0-revised"; // 13/15 = 86.7% >= 85%

    const local = createInMemoryStorage();
    await local.commit({
      pieceProfiles: [
        {
          pieceId: "local-1",
          title: "Prelude (Original)",
          fingerprints: ["fp-orig"],
          measureHashesByFingerprint: { "fp-orig": hashesA },
          lastPracticedAtMs: 1000,
        },
      ],
      practiceEvents: [
        makeEvent({ eventId: "ev-local", pieceId: "local-1", scoreFingerprint: "fp-orig" }),
      ],
    });

    const remote = createInMemoryStorage();
    await remote.commit({
      pieceProfiles: [
        {
          pieceId: "remote-1",
          title: "Prelude (MuseScore Fix)",
          fingerprints: ["fp-rev"],
          measureHashesByFingerprint: { "fp-rev": hashesB },
          lastPracticedAtMs: 2000,
        },
      ],
      practiceEvents: [
        makeEvent({
          eventId: "ev-remote",
          pieceId: "remote-1",
          scoreFingerprint: "fp-rev",
          timestampMs: Date.UTC(2026, 10, 11, 10, 0, 0),
          localDateKey: "2026-11-11",
        }),
      ],
    });

    const backup = await createPracticeBackup(remote);
    const preview = await previewPracticeBackupImport(local, backup.metadataOnlyJson);
    expect(preview.similarityLinks).toHaveLength(1);
    expect(preview.similarityLinks[0]).toMatchObject({
      importedPieceId: "remote-1",
      localPieceId: "local-1",
    });
    expect(preview.similarityLinks[0].similarityRatio).toBeGreaterThanOrEqual(0.85);

    // Without opt-in, default import keeps them separate (never silently merges external revisions)
    const separateClone = createInMemoryStorage();
    await separateClone.commit({
      pieceProfiles: await local.all("pieceProfiles"),
      practiceEvents: await local.all("practiceEvents"),
    });
    await importPracticeBackup(separateClone, backup.metadataOnlyJson);
    expect(await separateClone.all("pieceProfiles")).toHaveLength(2);

    // With explicit linkByImportedPieceId opt-in, they unify and replay together
    await importPracticeBackup(local, backup.metadataOnlyJson, {
      linkByImportedPieceId: { "remote-1": "local-1" },
    });
    const unified = await local.all("pieceProfiles");
    expect(unified).toHaveLength(1);
    expect(new Set(unified[0].fingerprints)).toEqual(new Set(["fp-orig", "fp-rev"]));
    expect((await local.listPracticeEvents("local-1")).map((e) => e.eventId)).toEqual([
      "ev-local",
      "ev-remote",
    ]);
  });

  it("detects LWW conflicts for FingerAnchorDraft, HandSpanProfile/prefs, and chunkOverrides, honoring per-item choices", async () => {
    const local = createInMemoryStorage();
    const remote = createInMemoryStorage();

    await local.commit({
      pieceProfiles: [
        {
          pieceId: "p1",
          title: "Sonatina",
          fingerprints: ["fp-1"],
          measureHashesByFingerprint: { "fp-1": ["h0", "h1"] },
          chunkOverrides: {
            addedBoundaries: [{ measureIndex: 1, beatNum: 0, beatDen: 1 }],
            removedBoundaries: [],
            updatedAtMs: 100,
          },
        },
      ],
      fingerAnchorDrafts: [
        {
          pieceId: "p1",
          anchorsByCoord: { "0:0/1:m:RH:60:0": { finger: 2, mode: "pinOnly" } },
          removedRawCoords: [],
          sourceFingeringHash: "h-src",
          updatedAtMs: 300, // newer locally
        },
      ],
      workspacePrefs: [
        {
          scopeKey: "p1",
          handSpanProfile: { preset: "S", avoidThumbOnBlack: true, preferStablePosition: false },
          speedMultiplier: 0.75,
          updatedAtMs: 100, // older locally
        },
      ],
    });

    await remote.commit({
      pieceProfiles: [
        {
          pieceId: "p1",
          title: "Sonatina",
          fingerprints: ["fp-1"],
          measureHashesByFingerprint: { "fp-1": ["h0", "h1"] },
          chunkOverrides: {
            addedBoundaries: [],
            removedBoundaries: [{ measureIndex: 1, beatNum: 0, beatDen: 1 }],
            updatedAtMs: 200, // newer remotely
          },
        },
      ],
      fingerAnchorDrafts: [
        {
          pieceId: "p1",
          anchorsByCoord: { "0:0/1:m:RH:60:0": { finger: 4, mode: "phrase" } },
          removedRawCoords: [],
          sourceFingeringHash: "h-src",
          updatedAtMs: 150, // older remotely
        },
      ],
      workspacePrefs: [
        {
          scopeKey: "p1",
          handSpanProfile: { preset: "L", avoidThumbOnBlack: false, preferStablePosition: true },
          speedMultiplier: 0.9,
          updatedAtMs: 250, // newer remotely
        },
      ],
    });

    const backup = await createPracticeBackup(remote);
    const preview = await previewPracticeBackupImport(local, backup.metadataOnlyJson);

    expect(preview.conflicts.map((c) => c.kind).sort()).toEqual([
      "chunk-overrides",
      "finger-anchor-draft",
      "workspace-prefs",
    ]);

    const draftConflict = preview.conflicts.find((c) => c.kind === "finger-anchor-draft")!;
    const prefsConflict = preview.conflicts.find((c) => c.kind === "workspace-prefs")!;
    const chunkConflict = preview.conflicts.find((c) => c.kind === "chunk-overrides")!;

    expect(draftConflict.defaultChoice).toBe("keep-local");
    expect(prefsConflict.defaultChoice).toBe("adopt-imported");
    expect(chunkConflict.defaultChoice).toBe("adopt-imported");

    // Override LWW defaults: adopt older draft, keep older local prefs, keep older local chunkOverrides
    await importPracticeBackup(local, backup.metadataOnlyJson, {
      choicesByConflictId: {
        [draftConflict.conflictId]: "adopt-imported",
        [prefsConflict.conflictId]: "keep-local",
        [chunkConflict.conflictId]: "keep-local",
      },
    });

    expect((await local.get("fingerAnchorDrafts", "p1"))?.anchorsByCoord).toEqual({
      "0:0/1:m:RH:60:0": { finger: 4, mode: "phrase" },
    });
    expect((await local.get("workspacePrefs", "p1"))?.handSpanProfile?.preset).toBe("S");
    expect((await local.get("pieceProfiles", "p1"))?.chunkOverrides?.addedBoundaries).toEqual([
      { measureIndex: 1, beatNum: 0, beatDen: 1 },
    ]);
  });

  it("renders interactive conflict preview in PracticeBackupPanel and applies per-item user choices on confirm", async () => {
    const local = createInMemoryStorage();
    const remote = createInMemoryStorage();

    await local.commit({
      pieceProfiles: [
        {
          pieceId: "p1",
          title: "Menuet",
          fingerprints: ["fp-1"],
          measureHashesByFingerprint: { "fp-1": ["m0", "m1"] },
        },
      ],
      fingerAnchorDrafts: [
        {
          pieceId: "p1",
          anchorsByCoord: { "0:0/1:m:RH:60:0": { finger: 1, mode: "pinOnly" } },
          removedRawCoords: [],
          sourceFingeringHash: "h",
          updatedAtMs: 100,
        },
      ],
      workspacePrefs: [
        {
          scopeKey: "p1",
          handSpanProfile: { preset: "M", avoidThumbOnBlack: true, preferStablePosition: false },
          speedMultiplier: 0.7,
          updatedAtMs: 100,
        },
      ],
    });

    await remote.commit({
      pieceProfiles: [
        {
          pieceId: "p1",
          title: "Menuet",
          fingerprints: ["fp-1"],
          measureHashesByFingerprint: { "fp-1": ["m0", "m1"] },
        },
      ],
      fingerAnchorDrafts: [
        {
          pieceId: "p1",
          anchorsByCoord: { "0:0/1:m:RH:60:0": { finger: 5, mode: "pinOnly" } },
          removedRawCoords: [],
          sourceFingeringHash: "h",
          updatedAtMs: 200,
        },
      ],
      workspacePrefs: [
        {
          scopeKey: "p1",
          handSpanProfile: { preset: "L", avoidThumbOnBlack: false, preferStablePosition: true },
          speedMultiplier: 0.85,
          updatedAtMs: 200,
        },
      ],
      practiceEvents: [makeEvent({ eventId: "remote-ev", pieceId: "p1", scoreFingerprint: "fp-1" })],
    });

    const backup = await createPracticeBackup(remote);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        createElement(PracticeBackupPanel, {
          storage: local,
          onClose: () => {},
          flush: async () => {},
          onImport: async (json, resolutions) => {
            await importPracticeBackup(local, json, resolutions);
          },
        }),
      );
    });

    const previewInput = container.querySelector<HTMLInputElement>(
      '[data-testid="practice-backup-preview-import"]',
    )!;
    expect(previewInput).not.toBeNull();
    Object.defineProperty(previewInput, "files", {
      value: [{ name: "remote.json", text: async () => backup.metadataOnlyJson }],
    });
    await act(async () => {
      previewInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const previewPanel = container.querySelector('[data-testid="practice-backup-conflict-preview"]');
    expect(previewPanel).not.toBeNull();

    // Keep local FingerAnchorDraft (overriding remote's newer timestamp), while leaving prefs as adopt-imported
    const keepDraftRadio = container.querySelector<HTMLInputElement>(
      '[data-testid="backup-conflict-keep-draft:p1"]',
    )!;
    expect(keepDraftRadio).not.toBeNull();
    await act(async () => {
      keepDraftRadio.click();
    });

    const confirmBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="practice-backup-confirm-merge"]',
    )!;
    await act(async () => {
      confirmBtn.click();
    });

    expect((await local.get("fingerAnchorDrafts", "p1"))?.anchorsByCoord).toEqual({
      "0:0/1:m:RH:60:0": { finger: 1, mode: "pinOnly" },
    });
    expect((await local.get("workspacePrefs", "p1"))?.handSpanProfile?.preset).toBe("L");
    expect((await local.listPracticeEvents("p1")).map((e) => e.eventId)).toEqual(["remote-ev"]);
    expect((await local.get("derivedSnapshots", "p1"))?.lastEventId).toBe("remote-ev");
  });

  it("persists replayed derivedSnapshots and bestStableSpeed cleanly through IndexedDB storage", async () => {
    const idb = createIndexedDbStorage({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange });
    const source = createInMemoryStorage();
    await source.commit({
      pieceProfiles: [
        {
          pieceId: "idb-p1",
          title: "Etude IDB",
          fingerprints: ["fp-idb"],
          measureHashesByFingerprint: { "fp-idb": ["m0", "m1"] },
          chunkOverrides: {
            addedBoundaries: [{ measureIndex: 1, beatNum: 0, beatDen: 1 }],
            removedBoundaries: [],
            updatedAtMs: 500,
          },
        },
      ],
      practiceEvents: [
        makeEvent({
          eventId: "idb-e1",
          pieceId: "idb-p1",
          scoreFingerprint: "fp-idb",
          speedMultiplier: 0.85,
          autoGrade: 4,
        }),
      ],
    });
    const backup = await createPracticeBackup(source);
    await importPracticeBackup(idb, backup.metadataOnlyJson);

    const profile = await idb.get("pieceProfiles", "idb-p1");
    expect(profile?.bestStableSpeed).toBe(0.85);
    expect(profile?.chunkOverrides?.addedBoundaries).toHaveLength(1);
    const snap = await idb.get("derivedSnapshots", "idb-p1");
    expect(snap?.lastEventId).toBe("idb-e1");
    expect((snap?.state as PiecePracticeState).bestStableSpeed).toBe(0.85);
    await idb.close();
  });
});
