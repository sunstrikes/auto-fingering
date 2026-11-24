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

it("opens the cached score on startup and restores Free Studio preferences and coordinate anchors", async () => {
  const score = parseMusicXml(xml);
  const identity = getScoreIdentity(score);
  const storage = createInMemoryStorage();
  const bytes = await exportMxlContainer(xml);
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
    scoreBlobs: [{ fingerprint: identity.fingerprint, fileName: "first.mxl", bytes,
      byteLength: bytes.byteLength, lastAccessedAtMs: 1 }],
  });
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
