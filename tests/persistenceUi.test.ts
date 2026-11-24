// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/App";
import type { ScoreRendererHandle } from "../src/components/ScoreViewer";
import type { PracticeStoragePort } from "../src/persistence/storagePort";
import { createPracticeBackup, importPracticeBackup } from "../src/persistence/backupMerge";
import { applyScoreRepairToXml } from "../src/musicxml/repairWriter";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import { getScoreIdentity } from "../src/persistence/fingerprint";
import { buildNoteCoordIndex, hashSourceFingerings } from "../src/persistence/anchorDrafts";
import { exportMxlContainer } from "../src/musicxml/mxl";
import { parseMusicXml } from "../src/musicxml/parser";
import { solveFingering } from "../src/solver/solveFingering";
import { useStudioStore } from "../src/store/useStudioStore";
import type { SolverClient } from "../src/workers/solverClient";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const xml = `<score-partwise version="4.0"><work><work-title>First Étude</work-title></work>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">
  <measure number="1"><attributes><divisions>1</divisions><staves>2</staves></attributes>
  <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><staff>1</staff></note>
  <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><staff>2</staff></note></measure>
  </part></score-partwise>`;
const profile = { preset: "L", avoidThumbOnBlack: false, preferStablePosition: true } as const;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(practiceStorage: PracticeStoragePort, solverClient?: SolverClient) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  let renderedXml = "";
  const scoreRendererFactory = (): ScoreRendererHandle => ({
    async render(nextXml) { renderedXml = nextXml; return { measureCount: 1, measureGeometry: [] }; },
    highlightMeasure() {}, markAnchoredNotes() {}, syncCursor() {}, hitTestNoteAtClientPoint: () => null,
    scrollToMeasure() {}, dispose() {},
  });
  await act(async () => {
    root.render(createElement(StrictMode, {}, createElement(App, {
      practiceStorage,
      solverClientFactory: () => solverClient ?? ({
        solve: async (slices, profile, options) => solveFingering(slices, profile, options),
        dispose() {},
      }),
      scoreRendererFactory,
    })));
  });
  return { element, rendered: () => renderedXml };
}

async function seed(storage: PracticeStoragePort, source = xml, cache = true) {
  const score = parseMusicXml(source);
  const identity = getScoreIdentity(score);
  const bytes = await exportMxlContainer(source);
  const pieceId = "etude";
  const coord = buildNoteCoordIndex(score).keyByUid.get(score.noteEvents[0].noteUid)!;
  await storage.commit({
    pieceProfiles: [{ pieceId, title: "First Étude", fingerprints: [identity.fingerprint],
      measureHashesByFingerprint: { [identity.fingerprint]: identity.measureHashes } }],
    fingerAnchorDrafts: [{ pieceId, sourceFingeringHash: hashSourceFingerings(score),
      anchorsByCoord: { [coord]: { finger: 4, mode: "pinOnly" } }, removedRawCoords: [], updatedAtMs: 1 }],
    workspacePrefs: [{ scopeKey: "__global__", lastOpenedPieceId: pieceId },
      { scopeKey: pieceId, scoreFingerprint: identity.fingerprint, speedMultiplier: 0.75,
        abLoop: { startMeasureIndex: 0, endMeasureIndex: 0, enabled: true, loopGap: false },
        handSpanProfile: profile, practiceMode: "lh-only", freePracticeMinutes: 1.5 }],
    scoreBlobs: cache ? [{ fingerprint: identity.fingerprint, fileName: "first.mxl", bytes,
      byteLength: bytes.byteLength, lastAccessedAtMs: 1 }] : [],
  });
  return { identity, pieceId, score, coord };
}

it("opens the cached score on startup and restores Free Studio preferences and coordinate anchors", async () => {
  const storage = createInMemoryStorage();
  await seed(storage);
  const ui = await mount(storage);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  expect(ui.rendered()).toContain("First Étude");
  expect(ui.element.querySelector('[data-testid="practice-mode-lh-only"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(ui.rendered()).toMatch(/<fingering[^>]*>4<\/fingering>/);
  expect(useStudioStore.getState().handSpanProfile).toEqual(profile);
  expect(await storage.all("practiceEvents")).toEqual([]);
});


it("keeps a single-staff hand override and its effective Practice Mode after reloading", async () => {
  const storage = createInMemoryStorage();
  const singleStaff = xml.replace("<staves>2</staves>", "").replace("<staff>2</staff>", "<staff>1</staff>");
  const { pieceId } = await seed(storage, singleStaff);
  const ui = await mount(storage);
  await act(async () => { await vi.waitFor(() => expect(ui.rendered()).toContain("First Étude")); });
  const handGroup = ui.element.querySelector('[aria-label="单谱表声部手别"]')!;
  await act(async () => [...handGroup.querySelectorAll("button")].find((button) => button.textContent === "左手")!.click());
  await act(async () => { await vi.waitFor(async () =>
    expect(await storage.get("workspacePrefs", pieceId)).toMatchObject({ singleStaffHand: "LH" })); });
  act(() => roots.pop()!.unmount());

  const refreshed = await mount(storage);
  await act(async () => { await vi.waitFor(() => expect(refreshed.rendered()).toContain("First Étude")); });
  expect(refreshed.element.querySelector('[data-testid="practice-mode-lh-only"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(useStudioStore.getState().scoreDoc?.onsetSlices.every((slice) => slice.hand === "LH")).toBe(true);
  await act(async () => refreshed.element.querySelector<HTMLButtonElement>('[data-testid="speed-preset-1"]')!.click());
  expect(await storage.get("workspacePrefs", pieceId)).toMatchObject({ singleStaffHand: "LH", speedMultiplier: 1 });
});

it("opens a backup panel with cached scores included by default and both sizes visible", async () => {
  const ui = await mount(createInMemoryStorage());
  await act(async () => { ui.element.querySelector<HTMLButtonElement>('[data-testid="practice-backup-open"]')!.click(); });
  const include = ui.element.querySelector<HTMLInputElement>('[data-testid="practice-backup-include-scores"]')!;
  expect(include.checked).toBe(true);
  expect(ui.element.querySelector('[data-testid="practice-backup-full-size"]')?.textContent).toMatch(/\d/);
  expect(ui.element.querySelector('[data-testid="practice-backup-data-size"]')?.textContent).toMatch(/\d/);
  act(() => include.click());
  expect(include.checked).toBe(false);
});


it.each(["full", "metadata-only"] as const)("applies a %s backup to an already open workspace", async (kind) => {
  const now = vi.spyOn(Date, "now").mockReturnValue(100);
  const storage = createInMemoryStorage(kind === "full" ? {} : { maxScoreCount: 0 });
  const { pieceId, identity, score, coord } = await seed(storage, xml, kind === "full");
  const ui = await mount(storage);
  if (kind === "metadata-only") await openFile(ui.element, xml);
  await act(async () => { await vi.waitFor(() => expect(ui.rendered()).toMatch(/<fingering[^>]*>4<\/fingering>/)); });
  const click = async (id: string) => {
    await act(async () => ui.element.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click());
  };
  await click("practice-backup-open");

  const backupStorage = createInMemoryStorage();
  const importedXml = xml.replace("First Étude", "Updated Étude");
  const bytes = await exportMxlContainer(importedXml);
  await backupStorage.commit({
    pieceProfiles: [(await storage.get("pieceProfiles", pieceId))!],
    fingerAnchorDrafts: [{ pieceId, sourceFingeringHash: hashSourceFingerings(score),
      anchorsByCoord: { [coord]: { finger: 3, mode: "pinOnly" } }, removedRawCoords: [], updatedAtMs: 200 }],
    workspacePrefs: [{ scopeKey: "__global__", lastOpenedPieceId: pieceId, updatedAtMs: 200 },
      { scopeKey: pieceId, scoreFingerprint: identity.fingerprint, speedMultiplier: 0.5,
        practiceMode: "rh-only", freePracticeMinutes: 7, handSpanProfile: profile, updatedAtMs: 200 }],
    scoreBlobs: [{ fingerprint: identity.fingerprint, fileName: "updated.mxl", bytes,
      byteLength: bytes.byteLength, lastAccessedAtMs: 200 }],
  });
  const backup = await createPracticeBackup(backupStorage);
  const input = ui.element.querySelector<HTMLInputElement>('[data-testid="practice-backup-import"]')!;
  const json = kind === "full" ? backup.fullJson : backup.metadataOnlyJson;
  Object.defineProperty(input, "files", { value: [{ name: "backup.json", text: async () => json }] });
  now.mockReturnValue(300);
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(ui.element.querySelector('[data-testid="practice-backup-status"]')?.textContent).toContain("已导入备份");
    expect(ui.rendered()).toMatch(/<fingering[^>]*>3<\/fingering>/);
  });
  expect(ui.rendered()).toContain(kind === "full" ? "Updated Étude" : "First Étude");
  expect(ui.element.querySelector('[data-testid="practice-mode-rh-only"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(await storage.get("workspacePrefs", pieceId)).toMatchObject({ speedMultiplier: 0.5, updatedAtMs: 200 });
  await click("speed-preset-1");
  expect(await storage.get("workspacePrefs", pieceId)).toMatchObject({
    speedMultiplier: 1, practiceMode: "rh-only", freePracticeMinutes: 7,
  });
  expect(await storage.get("fingerAnchorDrafts", pieceId)).toMatchObject({ anchorsByCoord: { [coord]: { finger: 3 } } });
});

async function openFile(element: HTMLElement, source: string) {
  const input = element.querySelector<HTMLInputElement>('input[accept=".musicxml,.xml,.mxl"]')!;
  Object.defineProperty(input, "files", { value: [{ name: "external.musicxml", text: async () => source }], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}

it("reports model progress and classic fallback when solving a repaired score", async () => {
  let finishRepair!: (reason: string) => void;
  const pending = new Promise<string>((resolve) => { finishRepair = resolve; });
  const solver: SolverClient = {
    async solve(slices, handSpan, options) {
      const solved = solveFingering(slices, handSpan, options);
      if (solved.repairSuggestions?.length) return solved;
      options?.onPriorProgress?.({ loadedBytes: 512, totalBytes: 1024 });
      return { ...solved, priorFallbackReason: await pending };
    },
    dispose() {},
  };
  const ui = await mount(createInMemoryStorage(), solver);
  const wideChord = xml.replace("</note>", `</note>
    <note><chord/><pitch><step>G</step><octave>5</octave></pitch><duration>1</duration><staff>1</staff></note>`);
  await openFile(ui.element, wideChord);
  const click = async (testId: string) => {
    await act(async () => ui.element.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click());
  };
  await click("score-repair-toggle-btn");
  await act(async () => [...ui.element.querySelectorAll<HTMLButtonElement>('[data-testid^="repair-opt-"]')]
    .find((button) => button.textContent?.includes("八度折叠"))!.click());
  await act(async () => ui.element.querySelector<HTMLButtonElement>('[data-testid^="repair-apply-"]')!.click());
  await click("header-midi-status-btn");
  expect(ui.element.querySelector('[data-testid="prior-download-progress"]')?.textContent).toContain("50%");
  await act(async () => finishRepair("模型离线"));
  expect(ui.element.querySelector('[data-testid="prior-fallback-alert"]')?.textContent).toContain("模型离线");
  expect(ui.element.textContent).toContain("已应用乐谱修复");
});

it("archives the old draft and practice time while reopening the same score as a fresh piece", async () => {
  const storage = createInMemoryStorage();
  const { identity, pieceId } = await seed(storage);
  const ui = await mount(storage);
  await act(async () => { await vi.waitFor(() => expect(ui.rendered()).toContain("First Étude")); });
  for (const id of ["practice-backup-open", "practice-archive-piece", "practice-archive-confirm"]) {
    await act(async () => ui.element.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click());
  }
  const profiles = await storage.findPieceProfiles(identity.fingerprint);
  const archived = profiles.find((row) => row.pieceId === pieceId);
  const restarted = profiles.find((row) => row.pieceId !== pieceId);
  expect(archived?.archivedAtMs).toEqual(expect.any(Number));
  expect((await storage.get("workspacePrefs", pieceId))?.freePracticeMinutes).toBe(1.5);
  expect(await storage.get("fingerAnchorDrafts", pieceId)).toMatchObject({ pieceId });
  expect(restarted?.archivedAtMs).toBeUndefined();
  const newPieceId = restarted!.pieceId;
  expect((await storage.get("workspacePrefs", "__global__"))?.lastOpenedPieceId).toBe(newPieceId);
  expect(await storage.get("workspacePrefs", newPieceId)).toMatchObject({ freePracticeMinutes: 0, speedMultiplier: 0.75 });
  await act(async () => { await vi.waitFor(async () =>
    expect((await storage.get("fingerAnchorDrafts", newPieceId))?.anchorsByCoord).toEqual({})); });
});

it.each([["accept", 4], ["decline", 5]] as const)("lets the user %s a local draft when external fingerings change", async (answer, finger) => {
  const storage = createInMemoryStorage();
  const seeded = await seed(storage, xml, false);
  const prefs = (await storage.get("workspacePrefs", seeded.pieceId))!;
  await storage.commit({ workspacePrefs: [{ ...prefs, ignoreExistingFingerings: true }] });
  const ui = await mount(storage);
  const edited = xml.replace("<staff>1</staff>", "<staff>1</staff><notations><technical><fingering>5</fingering></technical></notations>");
  await openFile(ui.element, edited);
  expect(ui.element.querySelector('[data-testid="practice-score-fingering-prompt"]')).not.toBeNull();
  await act(async () => { ui.element.querySelector<HTMLButtonElement>(`[data-testid="practice-score-choice-${answer}"]`)!.click(); });
  expect(ui.rendered()).toMatch(new RegExp(`<fingering[^>]*>${finger}</fingering>`));
  await act(async () => { await vi.waitFor(async () =>
    expect(await storage.get("workspacePrefs", seeded.pieceId)).toMatchObject({ ignoreExistingFingerings: answer === "accept" })); });
  expect((await storage.findPieceProfiles(seeded.identity.fingerprint)).map((row) => row.pieceId)).toEqual([seeded.pieceId]);
});

it("asks before linking a minor external score revision and retains the original alias", async () => {
  const measure = xml.match(/<measure number="1">[\s\S]*<\/measure>/)![0];
  const original = xml.replace(measure, Array.from({ length: 14 }, (_, i) =>
    measure.replace('number="1"', `number="${i + 1}"`)).join(""));
  const edited = original.replace("<step>C</step>", "<step>D</step>"); // 13 unchanged / 15 union = 86.7%
  const revised = getScoreIdentity(parseMusicXml(edited));
  const storage = createInMemoryStorage();
  const seeded = await seed(storage, original, false);
  const ui = await mount(storage);
  await openFile(ui.element, edited);
  expect(ui.element.querySelector('[data-testid="practice-score-link-prompt"]')).not.toBeNull();
  expect(await storage.findPieceProfiles(revised.fingerprint)).toEqual([]);
  await act(async () => { ui.element.querySelector<HTMLButtonElement>('[data-testid="practice-score-choice-accept"]')!.click(); });
  await act(async () => { await vi.waitFor(async () => {
    const [linked] = await storage.findPieceProfiles(revised.fingerprint);
    expect(linked).toMatchObject({ pieceId: seeded.pieceId, fingerprints: [seeded.identity.fingerprint, revised.fingerprint] });
  }); });
  expect(ui.rendered()).toContain("<step>D</step>");
});

it("stores elapsed Free Studio time separately without writing a Practice Event", async () => {
  const storage = createInMemoryStorage();
  const { pieceId } = await seed(storage);
  const ui = await mount(storage);
  await act(async () => { await vi.waitFor(() => expect(ui.rendered()).toContain("First Étude")); });
  const click = async (testId: string) => {
    await act(async () => { ui.element.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click(); });
  };
  const now = vi.spyOn(performance, "now").mockReturnValue(500);
  await click("waiting-mode-toggle-btn");
  await click("audio-play-btn");
  now.mockReturnValue(60500);
  await click("audio-pause-btn");
  expect((await storage.get("workspacePrefs", pieceId))?.freePracticeMinutes).toBe(2.5);
  expect(await storage.all("practiceEvents")).toEqual([]);
});

it("requests persistent browser storage at startup and does not repeat the reminder on immediate reload", async () => {
  const persist = vi.fn(async () => false);
  vi.stubGlobal("navigator", { storage: { persist } });
  const storage = createInMemoryStorage();
  const first = await mount(storage);
  expect(first.element.querySelector('[data-testid="practice-backup-reminder"]')).not.toBeNull();
  expect(await storage.get("meta", "storagePersisted")).toEqual({ key: "storagePersisted", value: false });
  const firstRoot = roots.pop()!;
  act(() => firstRoot.unmount());
  const second = await mount(storage);
  expect(second.element.querySelector('[data-testid="practice-backup-reminder"]')).toBeNull();
  expect(persist).toHaveBeenCalledTimes(2);
});

it("reminds again when a workbench left open is foregrounded after seven days", async () => {
  const persist = vi.fn(async () => false);
  vi.stubGlobal("navigator", { storage: { persist } });
  const day = 24 * 60 * 60 * 1000;
  const now = vi.spyOn(Date, "now").mockReturnValue(10 * day);
  const ui = await mount(createInMemoryStorage());
  const reminder = () => ui.element.querySelector('[data-testid="practice-backup-reminder"]');
  expect(reminder()).not.toBeNull();
  act(() => reminder()!.querySelectorAll<HTMLButtonElement>("button")[1].click());

  now.mockReturnValue(17 * day - 1);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(reminder()).toBeNull();
  now.mockReturnValue(17 * day);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(reminder()).not.toBeNull();
  expect(persist).toHaveBeenCalledTimes(1);
});

it("retries a failed workspace write before preparing a backup", async () => {
  const storage = createInMemoryStorage();
  const { pieceId } = await seed(storage);
  const ui = await mount(storage);
  await act(async () => { await vi.waitFor(() => expect(ui.rendered()).toContain("First Étude")); });
  const commit = storage.commit.bind(storage);
  let failOnce = true;
  vi.spyOn(storage, "commit").mockImplementation(async (write) => {
    if (failOnce && write.workspacePrefs?.some((row) => row.scopeKey === pieceId && row.speedMultiplier === 1)) {
      failOnce = false;
      throw new Error("transient storage failure");
    }
    await commit(write);
  });
  const click = async (testId: string) => {
    await act(async () => ui.element.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click());
  };
  await click("speed-preset-1");
  expect(ui.element.textContent).toContain("无法写入本地练习数据");
  expect((await storage.get("workspacePrefs", pieceId))?.speedMultiplier).toBe(0.75);
  await click("practice-backup-open");
  expect(ui.element.querySelector<HTMLButtonElement>('[data-testid="practice-backup-download"]')?.disabled).toBe(false);
  expect((await storage.get("workspacePrefs", pieceId))?.speedMultiplier).toBe(1);
});


it("keeps the active repair revision cached when only one score fits", async () => {
  vi.spyOn(Date, "now").mockReturnValue(100);
  const storage = createInMemoryStorage({ maxScoreCount: 1 });
  const changed = xml.replace("<step>C</step>", "<step>D</step>");
  // Reproduce the bad tie-break order: the main score's fingerprint sorts before the alternate's.
  const revisions = [xml, changed].map((source) => ({ source, score: parseMusicXml(source) }))
    .map((revision) => ({ ...revision, fingerprint: getScoreIdentity(revision.score).fingerprint }))
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  const [active, alternate] = revisions;
  const { pieceId } = await seed(storage, alternate.source);
  const ui = await mount(storage);
  await act(async () => { await vi.waitFor(() => expect(ui.rendered()).toContain("First Étude")); });
  await act(async () => {
    const state = useStudioStore.getState();
    state.applyScoreRepair({ scoreDoc: active.score, rawXmlText: active.source,
      solveResult: solveFingering(active.score.onsetSlices, state.handSpanProfile) });
  });
  await act(async () => { await vi.waitFor(async () =>
    expect(await storage.get("workspacePrefs", pieceId)).toMatchObject({ scoreFingerprint: active.fingerprint })); });
  expect((await storage.all("scoreBlobs")).map((blob) => blob.fingerprint)).toEqual([active.fingerprint]);
});

it("restores same-fingerprint repair Undo and Redo from a full backup without a noncanonical score fingerprint", async () => {
  const storage = createInMemoryStorage();
  const source = xml.replace("<duration>1</duration><staff>1", "<duration>2</duration><staff>1");
  const { identity, pieceId } = await seed(storage, source);
  const first = await mount(storage);
  await act(async () => { await vi.waitFor(() => expect(first.rendered()).toContain("First Étude")); });
  await act(async () => {
    const state = useStudioStore.getState();
    const original = state.scoreDoc!;
    const revisedXml = applyScoreRepairToXml(source, original, {
      edits: [{ kind: "clip-duration", noteUid: original.noteEvents[0].noteUid, newDurationTick: 1 }],
      optionId: "clip", strategy: "octave-fold-thin", label: "", fidelityScore: 0, description: "", previewSummary: "",
    });
    const revised = parseMusicXml(revisedXml);
    expect(getScoreIdentity(revised).fingerprint).toBe(identity.fingerprint);
    state.applyScoreRepair({ scoreDoc: revised, rawXmlText: revisedXml,
      solveResult: solveFingering(revised.onsetSlices, state.handSpanProfile) });
  });
  await act(async () => { await vi.waitFor(async () => expect((await storage.get("workspacePrefs", pieceId))?.repairEdge?.direction).toBe("undo")); });
  expect((await storage.all("scoreBlobs")).map((blob) => blob.fingerprint)).toEqual([identity.fingerprint]);
  const restored = createInMemoryStorage();
  const backup = await createPracticeBackup(storage);
  await importPracticeBackup(restored, backup.fullJson);
  const dataOnly = createInMemoryStorage();
  await importPracticeBackup(dataOnly, backup.metadataOnlyJson);
  expect(await dataOnly.all("scoreBlobs")).toEqual([]);

  const remount = async () => {
    act(() => roots.pop()!.unmount());
    return mount(restored);
  };
  const duration = () => useStudioStore.getState().scoreDoc?.noteEvents[0].durationTick;
  const repaired = await remount();
  await act(async () => { await vi.waitFor(() => expect(duration()).toBe(1)); });
  await act(async () => repaired.element.querySelector<HTMLButtonElement>('[data-testid="undo-btn"]')!.click());
  expect(duration()).toBe(2);
  expect(repaired.rendered()).toMatch(/<fingering[^>]*>4<\/fingering>/);
  await act(async () => { await vi.waitFor(async () => expect((await restored.get("workspacePrefs", pieceId))?.repairEdge?.direction).toBe("redo")); });
  const undone = await remount();
  await act(async () => { await vi.waitFor(() => expect(duration()).toBe(2)); });
  await act(async () => undone.element.querySelector<HTMLButtonElement>('[data-testid="redo-btn"]')!.click());
  expect(duration()).toBe(1);
  expect(undone.rendered()).toMatch(/<fingering[^>]*>4<\/fingering>/);
});
