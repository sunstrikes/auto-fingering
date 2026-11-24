// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/App";
import type { ScoreRendererHandle } from "../src/components/ScoreViewer";
import type { PracticeStoragePort } from "../src/persistence/storagePort";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import { getScoreIdentity } from "../src/persistence/fingerprint";
import { buildNoteCoordIndex, hashSourceFingerings } from "../src/persistence/anchorDrafts";
import { exportMxlContainer } from "../src/musicxml/mxl";
import { parseMusicXml } from "../src/musicxml/parser";
import { solveFingering } from "../src/solver/solveFingering";
import { useStudioStore } from "../src/store/useStudioStore";

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

async function mount(practiceStorage: PracticeStoragePort) {
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
      solverClientFactory: () => ({ solve: async (slices, profile, options) => solveFingering(slices, profile, options), dispose() {} }),
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


async function openFile(element: HTMLElement, source: string) {
  const input = element.querySelector<HTMLInputElement>('input[accept=".musicxml,.xml,.mxl"]')!;
  Object.defineProperty(input, "files", { value: [{ name: "external.musicxml", text: async () => source }], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}

it.each([["accept", 4], ["decline", 2]] as const)("lets the user %s a local draft when external fingerings change", async (answer, finger) => {
  const storage = createInMemoryStorage();
  const seeded = await seed(storage, xml, false);
  const ui = await mount(storage);
  const edited = xml.replace("<staff>1</staff>", "<staff>1</staff><notations><technical><fingering>2</fingering></technical></notations>");
  await openFile(ui.element, edited);
  expect(ui.element.querySelector('[data-testid="practice-score-fingering-prompt"]')).not.toBeNull();
  await act(async () => { ui.element.querySelector<HTMLButtonElement>(`[data-testid="practice-score-choice-${answer}"]`)!.click(); });
  expect(ui.rendered()).toMatch(new RegExp(`<fingering[^>]*>${finger}</fingering>`));
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
