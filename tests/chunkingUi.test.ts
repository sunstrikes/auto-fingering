// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TransportPracticeBar } from "../src/components/TransportPracticeBar";
import { ScoreViewer, type ScoreRendererHandle } from "../src/components/ScoreViewer";
import App from "../src/App";
import { solveFingering } from "../src/solver/solveFingering";
import { createSolverClient, type WorkerLike } from "../src/workers/solverClient";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";
import { createChunkingClient, type ChunkingWorkerLike } from "../src/workers/chunkingClient";
import { handleChunkingWorkerRequest } from "../src/workers/chunkingHandler";
import type { ChunkingWorkerRequest, ChunkingWorkerResponse } from "../src/workers/chunkingProtocol";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import { useStudioStore } from "../src/store/useStudioStore";
import type { MeasureTimeline } from "../src/domain/types";
import type {
  ChunkJunction,
  MotorChunk,
  PassageCluster,
  PerformanceCue,
} from "../src/chunking/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let mountedRoot: Root | null = null;
let mountedContainer: HTMLElement | null = null;

function mount(element: ReturnType<typeof createElement>): HTMLElement {
  mountedContainer = document.createElement("div");
  document.body.appendChild(mountedContainer);
  mountedRoot = createRoot(mountedContainer);
  act(() => {
    mountedRoot!.render(element);
  });
  return mountedContainer;
}

function openChunkCueEditor(container: HTMLElement) {
  const dialog = container.querySelector<HTMLDialogElement>('[data-testid="chunk-cue-editor-panel"]')!;
  // jsdom does not implement the native top-layer dialog methods.
  dialog.showModal = vi.fn(() => { dialog.open = true; });
  dialog.close = vi.fn(() => { dialog.open = false; });
  act(() => {
    container.querySelector<HTMLButtonElement>('[data-testid="chunk-cue-editor-toggle"]')!.click();
  });
  expect(dialog.open).toBe(true);
  return dialog;
}

afterEach(() => {
  if (mountedRoot) {
    act(() => {
      mountedRoot!.unmount();
    });
    mountedRoot = null;
  }
  if (mountedContainer) {
    mountedContainer.remove();
    mountedContainer = null;
  }
  vi.restoreAllMocks();
});

function makeTimelines(count: number): MeasureTimeline[] {
  return Array.from({ length: count }, (_, m) => ({
    measureIndex: m,
    startTick: m * 1920,
    endTick: (m + 1) * 1920,
    startSec: m * 2,
    endSec: (m + 1) * 2,
    timeBeats: 4,
    timeBeatType: 4,
    isPickup: false,
  }));
}

function makeSampleClusters(): PassageCluster[] {
  return [
    {
      clusterId: "cluster-0",
      label: "Cluster A",
      prototypeInstanceId: "inst-0",
      leverageRatio: 0.5,
      totalCoveredMeasures: 6,
      switchPoints: [],
      instances: [
        {
          instanceId: "inst-0",
          clusterId: "cluster-0",
          startMeasureIndex: 0,
          endMeasureIndex: 1,
          startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
          endCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
          isPrototype: true,
          transpositionSemitones: 0,
          musicSimilarity: 1,
          fingeringIsomorphism: 1,
          motorReuse: 1,
          variantKind: "exact",
          diffCoords: [],
        },
        {
          instanceId: "inst-1",
          clusterId: "cluster-0",
          startMeasureIndex: 2,
          endMeasureIndex: 3,
          startCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
          endCoord: { measureIndex: 4, beatNum: 0, beatDen: 1 },
          isPrototype: false,
          transpositionSemitones: 0,
          musicSimilarity: 1,
          fingeringIsomorphism: 1,
          motorReuse: 0.96,
          variantKind: "exact",
          diffCoords: [],
        },
        {
          instanceId: "inst-2",
          clusterId: "cluster-0",
          startMeasureIndex: 4,
          endMeasureIndex: 5,
          startCoord: { measureIndex: 4, beatNum: 0, beatDen: 1 },
          endCoord: { measureIndex: 6, beatNum: 0, beatDen: 1 },
          isPrototype: false,
          transpositionSemitones: 2,
          musicSimilarity: 0.78,
          fingeringIsomorphism: 0.7,
          motorReuse: 0.73,
          variantKind: "ornamented",
          diffCoords: [
            {
              coord: { measureIndex: 4, beatNum: 1, beatDen: 1 },
              measureIndex: 4,
              kind: "pitch",
              hand: "RH",
              prototypeMidi: 62,
              instanceMidi: 63,
              description: "m.5 RH pitch variant",
            },
          ],
        },
      ],
    },
  ];
}

describe("Slice 3: TransportPracticeBar 4px Passage Cluster ribbon", () => {
  it("renders a 4px Passage Cluster ribbon with A1 / A2 / A3' labels, non-conflicting palette, and click-to-inspect toggle", () => {
    const onToggleInspectClusterInstance = vi.fn();
    const clusters = makeSampleClusters();
    const container = mount(
      createElement(TransportPracticeBar, {
        hasScore: true,
        hasSelectedSlice: false,
        playbackState: "stopped",
        speedMultiplier: 1,
        baseBpm: 120,
        audioStatus: "idle",
        measureCount: 6,
        measureTimelines: makeTimelines(6),
        activeMeasureIndex: 0,
        passageClusters: clusters,
        inspectedClusterInstanceId: "inst-2",
        onToggleInspectClusterInstance,
        onPlay: vi.fn(),
        onPlayFromSlice: vi.fn(),
        onPause: vi.fn(),
        onStop: vi.fn(),
        onJumpToStart: vi.fn(),
        onJumpToMeasure: vi.fn(),
        onChangeSpeed: vi.fn(),
      }),
    );

    const ribbon = container.querySelector('[data-testid="passage-cluster-ribbon"]');
    const track = container.querySelector('[data-testid="passage-cluster-track"]');
    expect(ribbon).not.toBeNull();
    expect(track).not.toBeNull();
    expect(track!.className).toContain("h-[4px]");
    const list = container.querySelector('[data-testid="passage-cluster-list"]')!;
    expect(list.className).toContain("overflow-x-auto");
    expect(list.className).not.toContain("flex-wrap");

    // Verify instance labels A1 / A2 / A3'
    const chip0 = container.querySelector<HTMLButtonElement>('[data-testid="passage-cluster-instance-inst-0"]')!;
    const chip1 = container.querySelector<HTMLButtonElement>('[data-testid="passage-cluster-instance-inst-1"]')!;
    const chip2 = container.querySelector<HTMLButtonElement>('[data-testid="passage-cluster-instance-inst-2"]')!;
    expect(chip0.textContent).toContain("A1");
    expect(chip1.textContent).toContain("A2");
    expect(chip2.textContent).toContain("A3'");
    expect(chip2.getAttribute("aria-pressed")).toBe("true");
    expect(chip0.getAttribute("aria-pressed")).toBe("false");

    // Non-conflicting color palette (no amber/red/rose/emerald/indigo/violet/blue)
    const ribbonCell0 = container.querySelector<HTMLButtonElement>('[data-testid="passage-ribbon-cell-0"]')!;
    expect(ribbonCell0.className).toMatch(/bg-(teal|cyan|sky|pink|lime)-/);
    expect(ribbonCell0.className).not.toMatch(/bg-(amber|red|rose|emerald|indigo|violet|blue)-/);

    act(() => {
      chip1.click();
      ribbonCell0.click();
    });
    expect(onToggleInspectClusterInstance).toHaveBeenNthCalledWith(1, "inst-1");
    expect(onToggleInspectClusterInstance).toHaveBeenNthCalledWith(2, "inst-0");
  });

  it("collapses Passage Cluster ribbon by default and toggles it open/closed via passage-cluster-toggle", () => {
    const onToggleInspectClusterInstance = vi.fn();
    const clusters = makeSampleClusters();
    const container = mount(
      createElement(TransportPracticeBar, {
        hasScore: true,
        hasSelectedSlice: false,
        playbackState: "stopped",
        speedMultiplier: 1,
        baseBpm: 120,
        audioStatus: "idle",
        measureCount: 6,
        measureTimelines: makeTimelines(6),
        activeMeasureIndex: 0,
        passageClusters: clusters,
        inspectedClusterInstanceId: null,
        onToggleInspectClusterInstance,
        onPlay: vi.fn(),
        onPlayFromSlice: vi.fn(),
        onPause: vi.fn(),
        onStop: vi.fn(),
        onJumpToStart: vi.fn(),
        onJumpToMeasure: vi.fn(),
        onChangeSpeed: vi.fn(),
      }),
    );

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="passage-cluster-toggle"]')!;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("重复簇 (1)");
    expect(container.querySelector('[data-testid="passage-cluster-ribbon"]')).toBeNull();

    act(() => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="passage-cluster-ribbon"]')).not.toBeNull();

    act(() => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="passage-cluster-ribbon"]')).toBeNull();
  });

  it("omits Passage Cluster ribbon when there are no clusters", () => {
    const container = mount(
      createElement(TransportPracticeBar, {
        hasScore: true,
        hasSelectedSlice: false,
        playbackState: "stopped",
        speedMultiplier: 1,
        baseBpm: 120,
        audioStatus: "idle",
        measureCount: 4,
        measureTimelines: makeTimelines(4),
        activeMeasureIndex: 0,
        onPlay: vi.fn(),
        onPlayFromSlice: vi.fn(),
        onPause: vi.fn(),
        onStop: vi.fn(),
        onJumpToStart: vi.fn(),
        onJumpToMeasure: vi.fn(),
        onChangeSpeed: vi.fn(),
      }),
    );
    expect(container.querySelector('[data-testid="passage-cluster-toggle"]')).toBeNull();
    expect(container.querySelector('[data-testid="passage-cluster-ribbon"]')).toBeNull();
  });
});

describe("Slice 4: ScoreViewer barline Split/Merge, PerformanceCue editor, and on-demand Variant Diff", () => {
  const sampleChunks: MotorChunk[] = [
    {
      chunkId: "chunk-0",
      index: 0,
      sectionId: "sec-0",
      startMeasureIndex: 0,
      endMeasureIndex: 1,
      startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
      endCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
      measureCount: 2,
      stepCount: 8,
      densityStepsPerMeasure: 4,
      hasAnacrusisLeadIn: false,
      anacrusisBeats: 0,
      overlapFlag: false,
      boundaryConfidence: 1,
      userPinned: true,
    },
    {
      chunkId: "chunk-1",
      index: 1,
      sectionId: "sec-0",
      startMeasureIndex: 2,
      endMeasureIndex: 3,
      startCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
      endCoord: { measureIndex: 4, beatNum: 0, beatDen: 1 },
      measureCount: 2,
      stepCount: 8,
      densityStepsPerMeasure: 4,
      hasAnacrusisLeadIn: false,
      anacrusisBeats: 0,
      overlapFlag: false,
      boundaryConfidence: 0.7,
    },
  ];

  const sampleJunctions: ChunkJunction[] = [
    {
      junctionId: "junc-chunk-0-chunk-1",
      leftChunkId: "chunk-0",
      rightChunkId: "chunk-1",
      boundaryCoord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
      measureIndex: 2,
      bridgeWindowSteps: { startStepIndex: 6, endStepIndex: 9, junctionStepIndex: 8 },
      dimensions: {
        d1TransitionHazard: 0.6,
        d2PositionLeapVelocity: 0.5,
        d3BimanualCoupling: 0.7,
        d4HeldFingerLoad: 0,
        d5SwitchPointInterference: 0,
        d6EmpiricalPosterior: 0,
      },
      priorRisk: 0.75,
      posteriorRisk: 0.75,
      isHighRisk: true,
      reasonTags: ["simultaneous-dual-shift"],
      prepCueLabel: "m.3 双手同步移把",
    },
  ];

  const sampleCues: PerformanceCue[] = [
    {
      cueId: "cue-struct-sec-0",
      kind: "structural",
      roles: ["structural"],
      priorityWeight: 1.5,
      coord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
      measureIndex: 0,
      label: "Section A (m.1–4)",
      collapsed: false,
      isPrimary: true,
    },
    {
      cueId: "cue-exp-m2",
      kind: "expressive",
      roles: ["expressive"],
      priorityWeight: 0.5,
      coord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
      measureIndex: 2,
      label: "m.3 延长号/气口",
      collapsed: true,
      isPrimary: false,
    },
  ];

  it("keeps long-score editors closed by default and bounds the modal instead of shrinking the canvas", async () => {
    const props = {
      xmlString: "<score-partwise/>",
      motorChunks: Array.from({ length: 84 }, (_, index) => ({
        ...sampleChunks[0],
        chunkId: `long-chunk-${index}`,
        index,
      })),
      performanceCues: Array.from({ length: 34 }, (_, index) => ({
        ...sampleCues[0],
        cueId: `long-cue-${index}`,
      })),
      chunkEditingEnabled: true,
      rendererFactory: () => ({
        async render() {
          return { measureCount: 168, measureGeometry: [] };
        },
        highlightMeasure() {},
        markAnchoredNotes() {},
        scrollToMeasure() {},
        dispose() {},
      }),
    };
    const container = mount(createElement(ScoreViewer, props));
    await act(async () => { await Promise.resolve(); });

    const viewer = container.querySelector('[data-testid="score-viewer"]')!;
    expect(viewer.className).toContain("overflow-hidden");
    const viewerHeader = container.querySelector('[data-testid="score-viewer-header"]')!;
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="chunk-cue-editor-toggle"]')!;
    expect(toggle).not.toBeNull();
    expect(viewerHeader.contains(toggle)).toBe(true);
    expect(viewerHeader.textContent).toContain("乐谱画布");
    expect(viewer.textContent).not.toContain("展开后编辑，不占用乐谱空间");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("84");
    expect(toggle.textContent).toContain("34");
    const dialog = container.querySelector<HTMLDialogElement>('[data-testid="chunk-cue-editor-panel"]')!;
    expect(dialog.open).toBe(false);
    expect(dialog.className).toContain("max-h-[80dvh]");
    expect(container.querySelector('[data-testid="chunk-cue-editor-scroll"]')!.className).toContain("overflow-y-auto");

    openChunkCueEditor(container);
    expect(dialog.showModal).toHaveBeenCalledTimes(1);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="chunk-cue-editor-close"]')!.click();
    });
    expect(dialog.open).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    // Playback / Guided Session disables editing and must not leave the modal open.
    act(() => { toggle.click(); });
    act(() => {
      mountedRoot!.render(createElement(ScoreViewer, { ...props, chunkEditingEnabled: false }));
    });
    expect(container.querySelector('[data-testid="chunk-cue-editor-panel"]')).toBeNull();
    act(() => {
      mountedRoot!.render(createElement(ScoreViewer, props));
    });
    expect(container.querySelector<HTMLDialogElement>('[data-testid="chunk-cue-editor-panel"]')!.open).toBe(false);
    expect(container.querySelector('[data-testid="chunk-cue-editor-toggle"]')!.getAttribute("aria-expanded")).toBe("false");
  });

  it("supports barline Split/Merge, PerformanceCue Pin/Add/Hide/Edit label, and reset-to-auto", async () => {
    const onSplitChunkAtMeasure = vi.fn();
    const onMergeChunkBoundary = vi.fn();
    const onResetChunkOverrides = vi.fn();
    const onUpsertCueOverride = vi.fn();
    const onResetCueOverrides = vi.fn();
    const highlightVariantDiffs = vi.fn();

    const rendererFactory = (): ScoreRendererHandle => ({
      async render() {
        return { measureCount: 4, measureGeometry: [] };
      },
      highlightMeasure() {},
      markAnchoredNotes() {},
      highlightVariantDiffs,
      scrollToMeasure() {},
      dispose() {},
    });

    const container = mount(
      createElement(ScoreViewer, {
        xmlString: "<score-partwise/>",
        motorChunks: sampleChunks,
        chunkJunctions: sampleJunctions,
        performanceCues: sampleCues,
        chunkEditingEnabled: true,
        hasChunkOverrides: true,
        hasCueOverrides: true,
        onSplitChunkAtMeasure,
        onMergeChunkBoundary,
        onResetChunkOverrides,
        onUpsertCueOverride,
        onResetCueOverrides,
        rendererFactory,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    openChunkCueEditor(container);

    // No variant diff highlights during default / non-inspected view
    expect(container.querySelector('[data-testid="variant-diff-banner"]')).toBeNull();
    expect(highlightVariantDiffs).toHaveBeenLastCalledWith(null);

    // Split inside chunk-0 at barline m=1, Merge between chunk-0 and chunk-1 at barline m=2
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="chunk-barline-split-1"]')!.click();
      container.querySelector<HTMLButtonElement>('[data-testid="chunk-barline-merge-2"]')!.click();
      container.querySelector<HTMLButtonElement>('[data-testid="reset-chunk-overrides-btn"]')!.click();
    });
    expect(onSplitChunkAtMeasure).toHaveBeenCalledWith(1);
    expect(onMergeChunkBoundary).toHaveBeenCalledWith({ measureIndex: 2, beatNum: 0, beatDen: 1 });
    expect(onResetChunkOverrides).toHaveBeenCalledTimes(1);

    // Edit label on primary structural cue + Hide it
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="cue-edit-label-btn-cue-struct-sec-0"]')!.click();
    });
    const labelInput = container.querySelector<HTMLInputElement>('[data-testid="cue-label-input-cue-struct-sec-0"]')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(labelInput, "风铃声部起");
      labelInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="cue-label-save-btn-cue-struct-sec-0"]')!.click();
      container.querySelector<HTMLButtonElement>('[data-testid="cue-hide-btn-cue-struct-sec-0"]')!.click();
    });
    expect(onUpsertCueOverride).toHaveBeenCalledWith({
      coord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
      kind: "structural",
      pinned: true,
      customLabel: "风铃声部起",
    });
    expect(onUpsertCueOverride).toHaveBeenCalledWith({
      coord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
      kind: "structural",
      hidden: true,
    });

    // Reveal collapsed expressive cue and Pin it
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="cue-show-collapsed-btn"]')!.click();
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="cue-pin-btn-cue-exp-m2"]')!.click();
    });
    expect(onUpsertCueOverride).toHaveBeenCalledWith({
      coord: { measureIndex: 2, beatNum: 0, beatDen: 1 },
      kind: "expressive",
      pinned: true,
    });

    // Add a new PerformanceCue
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="cue-add-toggle-btn"]')!.click();
    });
    const addLabel = container.querySelector<HTMLInputElement>('[data-testid="cue-add-label-input"]')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(addLabel, "左手提前准备");
      addLabel.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="cue-add-submit-btn"]')!.click();
      container.querySelector<HTMLButtonElement>('[data-testid="reset-cue-overrides-btn"]')!.click();
    });
    expect(onUpsertCueOverride).toHaveBeenCalledWith({
      coord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
      kind: "technical",
      pinned: true,
      customLabel: "左手提前准备",
    });
    expect(onResetCueOverrides).toHaveBeenCalledTimes(1);
  });

  it("shows Variant Diff highlights only on demand when inspecting a PassageInstance", async () => {
    const highlightVariantDiffs = vi.fn();
    const rendererFactory = (): ScoreRendererHandle => ({
      async render() {
        return { measureCount: 6, measureGeometry: [] };
      },
      highlightMeasure() {},
      markAnchoredNotes() {},
      highlightVariantDiffs,
      scrollToMeasure() {},
      dispose() {},
    });

    const cluster = makeSampleClusters()[0];
    const variant = cluster.instances[2];
    const onCloseInspectCluster = vi.fn();

    const container = mount(
      createElement(ScoreViewer, {
        xmlString: "<score-partwise/>",
        inspectedClusterInstance: variant,
        inspectedClusterLabel: "A3'",
        onCloseInspectCluster,
        rendererFactory,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    const banner = container.querySelector('[data-testid="variant-diff-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("A3'");
    expect(banner!.textContent).toContain("73%");
    expect(highlightVariantDiffs).toHaveBeenLastCalledWith(variant.diffCoords);

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="variant-diff-close-btn"]')!.click();
    });
    expect(onCloseInspectCluster).toHaveBeenCalledTimes(1);
  });
});

function buildRepeatedScoreXml(): string {
  const measureBlock = (
    num: number,
    rhSteps: Array<[string, number]>,
    lhSteps: Array<[string, number]>,
    opts?: { withHeader?: boolean; withFermata?: boolean },
  ) => `
    <measure number="${num}">
      ${
        opts?.withHeader
          ? `<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>
             <direction placement="above"><sound tempo="120"/></direction>`
          : ""
      }
      ${rhSteps
        .map(
          ([step, oct], idx) =>
            `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff>${
              opts?.withFermata && idx === rhSteps.length - 1 ? "<notations><fermata/></notations>" : ""
            }</note>`,
        )
        .join("")}
      <backup><duration>16</duration></backup>
      ${lhSteps
        .map(
          ([step, oct]) =>
            `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>8</duration><type>half</type><staff>2</staff></note>`,
        )
        .join("")}
    </measure>`;

  const pat1Rh: Array<[string, number]> = [["C", 4], ["D", 4], ["E", 4], ["F", 4]];
  const pat2Rh: Array<[string, number]> = [["G", 4], ["E", 4], ["D", 4], ["C", 4]];
  const pat3Rh: Array<[string, number]> = [["D", 4], ["F", 4], ["E", 4], ["D", 4]];
  const pat3VarRh: Array<[string, number]> = [["D", 4], ["A", 4], ["G", 4], ["D", 4]];
  const bridgeBRh: Array<[string, number]> = [["A", 5], ["B", 5], ["A", 5], ["G", 5]];
  const bridgeCRh: Array<[string, number]> = [["F", 5], ["G", 5], ["F", 5], ["E", 5]];

  const patLh: Array<[string, number]> = [["C", 3], ["G", 3]];
  const bridgeBLh: Array<[string, number]> = [["A", 2], ["E", 3]];
  const bridgeCLh: Array<[string, number]> = [["F", 2], ["C", 3]];

  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>Repeated Etude</work-title></work>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    ${measureBlock(1, pat1Rh, patLh, { withHeader: true })}
    ${measureBlock(2, pat2Rh, patLh)}
    ${measureBlock(3, pat3Rh, patLh)}
    ${measureBlock(4, bridgeBRh, bridgeBLh)}
    ${measureBlock(5, pat1Rh, patLh, { withFermata: true })}
    ${measureBlock(6, pat2Rh, patLh)}
    ${measureBlock(7, pat3Rh, patLh)}
    ${measureBlock(8, bridgeCRh, bridgeCLh)}
    ${measureBlock(9, pat1Rh, patLh)}
    ${measureBlock(10, pat2Rh, patLh)}
    ${measureBlock(11, pat3VarRh, patLh)}
  </part>
</score-partwise>`;
}

function createInProcessSolverFactory() {
  return () => {
    const fakeWorker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(rawMsg: unknown) {
        const msg = rawMsg as WorkerRequest;
        if (msg.type === "local-resolve") return;
        const result = solveFingering(msg.onsetSlices, msg.profile, {
          ignoreExistingFingerings: msg.ignoreExistingFingerings,
        });
        const response: WorkerResponse = { requestId: msg.requestId, ok: true, result };
        queueMicrotask(() => {
          fakeWorker.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
        });
      },
      terminate() {},
    };
    return createSolverClient(() => fakeWorker);
  };
}

function createInProcessChunkingFactory(analyzeSpy: (measureCount: number) => void) {
  return () => {
    const fakeWorker: ChunkingWorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(rawMsg: unknown) {
        const req = rawMsg as ChunkingWorkerRequest;
        analyzeSpy(req.input.measureCount);
        const resp = handleChunkingWorkerRequest(req);
        queueMicrotask(() => {
          fakeWorker.onmessage?.({ data: resp } as MessageEvent<ChunkingWorkerResponse>);
        });
      },
      terminate() {},
    };
    return createChunkingClient(() => fakeWorker);
  };
}

function createFakeAudioDeps() {
  const rawCtx = {
    currentTime: 0,
    state: "running",
    destination: {} as AudioDestinationNode,
    resume: vi.fn(async () => {}),
    createGain: vi.fn(() => ({
      gain: {
        value: 1,
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
      },
      connect: vi.fn(),
    })),
    createOscillator: vi.fn(() => ({
      type: "sine",
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    })),
  };
  return {
    getAudioContext: () => rawCtx as unknown as AudioContext,
    loadSmplrPiano: async () => ({
      load: Promise.resolve(),
      start: vi.fn(),
      stop: vi.fn(),
    }),
  };
}

async function uploadMusicXml(container: HTMLElement, xml: string, fileName = "etude.musicxml") {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const fakeFile = {
    name: fileName,
    text: async () => xml,
    arrayBuffer: async () => new TextEncoder().encode(xml).buffer,
  };
  Object.defineProperty(input, "files", { value: [fakeFile], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
  });
}

describe("Slice 5: App root chunking integration (worker + persistence + cross-mode + MotorReuse)", () => {
  it("runs static chunking worker, persists Split/Merge & Cue overrides across reload/HandSpanProfile/FingerAnchor, keeps boundaries invariant across PracticeMode, and refreshes MotorReuse without cross-instance overwrite", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const storage = createInMemoryStorage();
    const analyzeSpy = vi.fn();
    const highlightVariantDiffs = vi.fn();

    const mountApp = () =>
      mount(
        createElement(App, {
          practiceStorage: storage,
          audioDeps: createFakeAudioDeps(),
          solverClientFactory: createInProcessSolverFactory(),
          chunkingClientFactory: createInProcessChunkingFactory(analyzeSpy),
          scoreRendererFactory: () => ({
            async render() {
              return { measureCount: 11, measureGeometry: [] };
            },
            highlightMeasure() {},
            markAnchoredNotes() {},
            highlightVariantDiffs,
            syncCursor() {},
            hitTestNoteAtClientPoint: () => null,
            scrollToMeasure() {},
            dispose() {},
          }),
        }),
      );

    const container = mountApp();
    await uploadMusicXml(container, buildRepeatedScoreXml());

    await vi.waitFor(() => {
      expect(analyzeSpy).toHaveBeenCalledWith(11);
      expect(container.querySelector('[data-testid="motor-chunk-strip"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="passage-cluster-toggle"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="passage-cluster-ribbon"]')).toBeNull();

    // Normal state must NOT lay down Variant Diff tint
    expect(container.querySelector('[data-testid="variant-diff-banner"]')).toBeNull();
    expect(highlightVariantDiffs).toHaveBeenLastCalledWith(null);

    // 1. Split or Merge a chunk + edit a PerformanceCue label
    openChunkCueEditor(container);
    const splitBtn = container.querySelector<HTMLButtonElement>('[data-testid^="chunk-barline-split-"]');
    const mergeBtn = container.querySelector<HTMLButtonElement>('[data-testid^="chunk-barline-merge-"]');
    expect(splitBtn ?? mergeBtn).not.toBeNull();

    await act(async () => {
      if (splitBtn) splitBtn.click();
      else mergeBtn!.click();
      await new Promise((r) => setTimeout(r, 30));
    });

    const editCueBtn = container.querySelector<HTMLButtonElement>('[data-testid^="cue-edit-label-btn-"]')!;
    const cueId = editCueBtn.getAttribute("data-testid")!.replace("cue-edit-label-btn-", "");
    act(() => {
      editCueBtn.click();
    });
    const cueInput = container.querySelector<HTMLInputElement>(`[data-testid="cue-label-input-${cueId}"]`)!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(cueInput, "呼吸落键");
      cueInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(`[data-testid="cue-label-save-btn-${cueId}"]`)!.click();
      await new Promise((r) => setTimeout(r, 40));
    });

    const pinnedChunkCountAfterEdit = container.querySelectorAll('[data-testid^="chunk-pinned-badge-"]').length;
    expect(pinnedChunkCountAfterEdit).toBeGreaterThanOrEqual(1);
    const chunkLabelsBeforeModeSwitch = Array.from(
      container.querySelectorAll('[data-testid^="motor-chunk-pill-"]'),
    ).map((el) => el.textContent);
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="chunk-cue-editor-close"]')!.click();
    });

    // 2. Switch PracticeMode (both -> rh-only -> lh-only): boundaries invariant, junctions recompute
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="practice-mode-rh-only"]')!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    const chunkLabelsInRh = Array.from(
      container.querySelectorAll('[data-testid^="motor-chunk-pill-"]'),
    ).map((el) => el.textContent);
    expect(chunkLabelsInRh).toEqual(chunkLabelsBeforeModeSwitch);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="practice-mode-both"]')!.click();
      await new Promise((r) => setTimeout(r, 20));
    });

    // 3. Change HandSpanProfile via Settings modal -> userPinned chunks & cue label survive
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="practice-settings-btn"]')!.click();
    });
    const settingsModal = container.querySelector('[data-testid="practice-settings-modal"]')!;
    const smallHandBtn = Array.from(settingsModal.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "S",
    );
    expect(smallHandBtn).toBeDefined();
    await act(async () => {
      smallHandBtn!.click();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(
      container.querySelectorAll('[data-testid^="chunk-pinned-badge-"]').length,
    ).toBeGreaterThanOrEqual(1);
    expect(container.querySelector('[data-testid="performance-cue-bar"]')?.textContent).toContain("呼吸落键");

    // 4. Inspect cluster instance -> expand cluster toggle -> on-demand Variant Diff appears; edit FingerAnchor on one instance -> updates MotorReuse without overwriting sibling instance fingering
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="passage-cluster-toggle"]')!.click();
    });
    const instanceChips = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid^="passage-cluster-instance-"]'),
    );
    expect(instanceChips.length).toBeGreaterThanOrEqual(2);
    const secondInstanceChip = instanceChips[1];
    const secondInstanceTestId = secondInstanceChip.getAttribute("data-testid")!;
    const secondInstanceTextBefore = secondInstanceChip.textContent;

    act(() => {
      secondInstanceChip.click();
    });
    expect(container.querySelector('[data-testid="variant-diff-banner"]')).not.toBeNull();

    // Check a note in instance 1 vs instance 2
    const firstMatch = instanceChips[0].textContent?.match(/m\.(\d+)-/);
    const secondMatch = secondInstanceTextBefore?.match(/m\.(\d+)-/);
    const firstStartM = Number(firstMatch?.[1] ?? 1) - 1;
    const secondStartM = Number(secondMatch?.[1] ?? 4) - 1;
    const store = useStudioStore.getState();
    const inst1RhNote = store.scoreDoc!.noteEvents.find((n) => n.measureIndex === firstStartM && n.hand === "RH" && !n.isTieStop)!;
    const inst2RhNote = store.scoreDoc!.noteEvents.find((n) => n.measureIndex === secondStartM && n.hand === "RH" && !n.isTieStop)!;
    const inst1OriginalFinger = store.fingerByNoteUid[inst1RhNote.noteUid];
    const inst2OriginalFinger = store.fingerByNoteUid[inst2RhNote.noteUid];

    // Pin a distinct finger on inst2RhNote
    const altFinger = inst2OriginalFinger === 5 ? 4 : 5;
    await act(async () => {
      useStudioStore.getState().commitAnchorResolution({
        targetNoteUid: inst2RhNote.noteUid,
        override: { finger: altFinger, mode: "pinOnly" },
        result: {
          ...useStudioStore.getState().solveResult!,
          fingerByNoteUid: {
            ...useStudioStore.getState().fingerByNoteUid,
            [inst2RhNote.noteUid]: altFinger,
          },
        },
      });
      await new Promise((r) => setTimeout(r, 40));
    });

    // Instance 1 fingering must NOT be silently overwritten by editing instance 2!
    expect(useStudioStore.getState().fingerByNoteUid[inst1RhNote.noteUid]).toBe(inst1OriginalFinger);
    // MotorReuse percentage on instance 2 chip refreshed
    const refreshedChip = container.querySelector<HTMLButtonElement>(`[data-testid="${secondInstanceTestId}"]`)!;
    expect(refreshedChip.textContent).not.toBe(secondInstanceTextBefore);

    // 5. Reload (unmount + remount with same storage) -> PieceProfile overrides survive reload
    const profilesBeforeReload = await storage.all("pieceProfiles");
    expect(profilesBeforeReload[0]?.chunkOverrides).toBeDefined();
    expect(profilesBeforeReload[0]?.performanceCueOverrides).toBeDefined();

    act(() => {
      mountedRoot!.unmount();
      mountedRoot = null;
      mountedContainer?.remove();
      mountedContainer = null;
    });

    const reloaded = mountApp();
    await vi.waitFor(() => {
      expect(reloaded.querySelector('[data-testid="motor-chunk-strip"]')).not.toBeNull();
      expect(reloaded.querySelector('[data-testid="performance-cue-bar"]')?.textContent).toContain("呼吸落键");
    });
    expect(
      reloaded.querySelectorAll('[data-testid^="chunk-pinned-badge-"]').length,
    ).toBeGreaterThanOrEqual(1);

    // 6. Re-import same score with changed <divisions> (4 -> 96): ScoreCoord overrides remain invariant
    const divisions96Xml = buildRepeatedScoreXml()
      .replace("<divisions>4</divisions>", "<divisions>96</divisions>")
      .replaceAll("<duration>4</duration>", "<duration>96</duration>")
      .replaceAll("<duration>8</duration>", "<duration>192</duration>")
      .replaceAll("<duration>16</duration>", "<duration>384</duration>");
    await uploadMusicXml(reloaded, divisions96Xml, "etude-div96.musicxml");
    await vi.waitFor(() => {
      expect(
        reloaded.querySelectorAll('[data-testid^="chunk-pinned-badge-"]').length,
      ).toBeGreaterThanOrEqual(1);
      expect(reloaded.querySelector('[data-testid="performance-cue-bar"]')?.textContent).toContain("呼吸落键");
    });

    // 7. Normal playback suppresses Variant Diff tint & chunk editing UI
    act(() => {
      reloaded.querySelector<HTMLButtonElement>('[data-testid="passage-cluster-toggle"]')!.click();
    });
    const instanceChip = reloaded.querySelector<HTMLButtonElement>('[data-testid^="passage-cluster-instance-"]')!;
    act(() => {
      instanceChip.click();
    });
    expect(reloaded.querySelector('[data-testid="variant-diff-banner"]')).not.toBeNull();
    await act(async () => {
      reloaded.querySelector<HTMLButtonElement>('[data-testid="audio-play-btn"]')!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(reloaded.querySelector('[data-testid="variant-diff-banner"]')).toBeNull();
    expect(reloaded.querySelector('[data-testid="motor-chunk-strip"]')).toBeNull();
    expect(highlightVariantDiffs).toHaveBeenLastCalledWith(null);
  });
});


