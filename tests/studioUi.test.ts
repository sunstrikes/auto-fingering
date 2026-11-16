// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_HAND_SPAN_PROFILE, type OnsetSlice, type TransitionCue } from "../src/domain/types";
import {
  MarginRiskGutter,
  buildMeasureRiskSummaries,
} from "../src/components/MarginRiskGutter";
import { InspectorPanel } from "../src/components/InspectorPanel";
import {
  ScoreViewer,
  type AnchorMarkerInfo,
  type ScoreRendererHandle,
} from "../src/components/ScoreViewer";
import App from "../src/App";
import { solveFingering } from "../src/solver/solveFingering";
import { createSolverClient, type WorkerLike } from "../src/workers/solverClient";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeSlice(
  sliceId: string,
  hand: "RH" | "LH",
  measureIndex: number,
  onsetTick: number,
  midi = 60,
  anchorFinger?: 1 | 2 | 3 | 4 | 5
): OnsetSlice {
  return {
    sliceId,
    hand,
    measureIndex,
    onsetTick,
    onsetSec: onsetTick * 0.25,
    isGrace: false,
    phraseId: 0,
    notes: [
      {
        noteUid: `n-${sliceId}`,
        measureIndex,
        onsetTick,
        durationTick: 1,
        onsetSec: onsetTick * 0.25,
        durationSec: 0.25,
        midi,
        hand,
        voice: "1",
        staff: hand === "RH" ? 1 : 2,
        isGrace: false,
        isTieStop: false,
        isTieStart: false,
        anchorFinger,
      },
    ],
    heldNotes: [],
  };
}

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
});

describe("Slice 1: MarginRiskGutter & measure risk aggregation", () => {
  it("renders per-measure amber/red risk bars by highest cue severity and triggers measure selection on click", () => {
    const slices: OnsetSlice[] = [
      makeSlice("s0", "RH", 0, 0, 60),
      makeSlice("s1", "RH", 1, 4, 64),
      makeSlice("s2", "LH", 1, 6, 40),
      makeSlice("s3", "RH", 2, 8, 72),
    ];

    const warnings: TransitionCue[] = [
      {
        sliceId: "s1",
        hand: "RH",
        measureIndex: 1,
        type: "wide-stretch",
        severity: "warn",
        cost: 0.9,
        label: "Wide stretch",
      },
      {
        sliceId: "s2",
        hand: "LH",
        measureIndex: 1,
        type: "unreachable-span",
        severity: "danger",
        cost: 2.5,
        label: "Unreachable span",
      },
      {
        sliceId: "s3",
        hand: "RH",
        measureIndex: 2,
        type: "position-shift",
        severity: "warn",
        cost: 6.2,
        label: "Fast position shift",
      },
    ];

    const summaries = buildMeasureRiskSummaries(3, slices, warnings);
    expect(summaries).toHaveLength(3);
    expect(summaries[0]).toMatchObject({
      measureIndex: 0,
      highestSeverity: "none",
      warningCount: 0,
      firstWarningSliceId: null,
      firstSliceId: "s0",
    });
    expect(summaries[1]).toMatchObject({
      measureIndex: 1,
      highestSeverity: "danger",
      warningCount: 2,
      firstWarningSliceId: "s2",
    });
    expect(summaries[2]).toMatchObject({
      measureIndex: 2,
      highestSeverity: "warn",
      warningCount: 1,
      firstWarningSliceId: "s3",
    });

    const onSelectMeasure = vi.fn();
    const container = mount(
      createElement(MarginRiskGutter, {
        measures: summaries,
        selectedMeasureIndex: 2,
        onSelectMeasure,
      })
    );

    const bars = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-measure-index]"));
    expect(bars).toHaveLength(3);
    expect(bars[0].dataset.severity).toBe("none");
    expect(bars[1].dataset.severity).toBe("danger");
    expect(bars[1].className).toContain("bg-red");
    expect(bars[2].dataset.severity).toBe("warn");
    expect(bars[2].className).toContain("bg-amber");
    expect(bars[2].getAttribute("aria-pressed")).toBe("true");

    act(() => {
      bars[1].click();
    });
    expect(onSelectMeasure).toHaveBeenCalledTimes(1);
    expect(onSelectMeasure).toHaveBeenCalledWith(1);
  });
});

describe("Slice 2: InspectorPanel warning & TransitionCue navigation", () => {
  it("lists warn/danger cues ordered chronologically by measure and onset with metadata, and selects on click", () => {
    const slices: OnsetSlice[] = [
      makeSlice("s-lh-early", "LH", 0, 2, 43, 5),
      makeSlice("s-rh-m1", "RH", 0, 4, 76),
      makeSlice("s-rh-m2", "RH", 1, 8, 84),
      makeSlice("s-lh-m2", "LH", 1, 10, 40),
    ];

    // Intentionally unsorted (RH warnings before LH warnings, later measure before earlier)
    const cues: TransitionCue[] = [
      {
        sliceId: "s-rh-m2",
        hand: "RH",
        measureIndex: 1,
        type: "position-shift",
        severity: "warn",
        cost: 7.4,
        label: "Fast position shift",
      },
      {
        sliceId: "s-rh-m1",
        hand: "RH",
        measureIndex: 0,
        type: "wide-stretch",
        severity: "warn",
        cost: 0.92,
        label: "Wide stretch",
      },
      {
        sliceId: "s-lh-early",
        hand: "LH",
        measureIndex: 0,
        type: "anchor-conflict",
        severity: "danger",
        cost: 100,
        label: "Anchor conflict",
      },
      {
        sliceId: "s-lh-m2",
        hand: "LH",
        measureIndex: 1,
        type: "unreachable-span",
        severity: "danger",
        cost: 3.1,
        label: "Unreachable span",
      },
      {
        sliceId: "s-rh-m1",
        hand: "RH",
        measureIndex: 0,
        type: "thumb-under",
        severity: "info",
        cost: 1.5,
        label: "Thumb-under (2→1)",
      },
    ];

    const onSelectWarning = vi.fn();
    const container = mount(
      createElement(InspectorPanel, {
        warnings: cues,
        onsetSlices: slices,
        fingerByNoteUid: {
          "n-s-lh-early": 5,
          "n-s-rh-m1": 4,
          "n-s-rh-m2": 5,
          "n-s-lh-m2": 1,
        },
        handSpanProfile: DEFAULT_HAND_SPAN_PROFILE,
        selectedSliceId: "s-rh-m1",
        selectedMeasureIndex: 0,
        ignoreExistingFingerings: false,
        hasScore: true,
        onSelectWarning,
      })
    );

    const items = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-warning-item]"));
    // Info cue excluded; 4 warn/danger cues sorted by (measureIndex, onsetTick)
    expect(items).toHaveLength(4);
    expect(items.map((el) => el.dataset.sliceId)).toEqual([
      "s-lh-early", // m.1 tick 2
      "s-rh-m1",    // m.1 tick 4
      "s-rh-m2",    // m.2 tick 8
      "s-lh-m2",    // m.2 tick 10
    ]);

    // Check metadata rendered on items (1-based measure number, hand, severity, type/description, cost)
    expect(items[0].textContent).toContain("m.1");
    expect(items[0].textContent).toContain("LH");
    expect(items[0].textContent).toContain("danger");
    expect(items[0].textContent).toContain("Anchor conflict");
    expect(items[0].textContent).toContain("anchor-conflict");
    expect(items[0].textContent).toContain("100.0");

    expect(items[1].getAttribute("aria-pressed")).toBe("true");
    expect(items[2].textContent).toContain("m.2");
    expect(items[2].textContent).toContain("Fast position shift");
    expect(items[2].textContent).toContain("7.4");

    act(() => {
      items[3].click();
    });
    expect(onSelectWarning).toHaveBeenCalledTimes(1);
    expect(onSelectWarning).toHaveBeenCalledWith(
      expect.objectContaining({ sliceId: "s-lh-m2", measureIndex: 1, type: "unreachable-span" })
    );
  });
});

describe("Slice 3: ScoreViewer OSMD/scroll seam, anchor indicators & active measure highlight", () => {
  it("renders MarginRiskGutter + anchor indicators and highlights/scrolls on measure selection via OSMD seam", async () => {
    const highlightMeasure = vi.fn();
    const markAnchoredNotes = vi.fn();
    const scrollToMeasure = vi.fn();
    const dispose = vi.fn();

    const fakeRenderer: ScoreRendererHandle = {
      render: vi.fn(async () => ({
        measureCount: 2,
        measureGeometry: [
          { measureIndex: 0, top: 10, height: 120 },
          { measureIndex: 1, top: 140, height: 120 },
        ],
      })),
      highlightMeasure,
      markAnchoredNotes,
      scrollToMeasure,
      dispose,
    };

    const slices: OnsetSlice[] = [
      makeSlice("s0", "RH", 0, 0, 60, 1),
      makeSlice("s1", "RH", 1, 4, 76),
    ];
    const warnings: TransitionCue[] = [
      {
        sliceId: "s1",
        hand: "RH",
        measureIndex: 1,
        type: "wide-stretch",
        severity: "warn",
        cost: 0.9,
        label: "Wide stretch",
      },
    ];
    const measureRisks = buildMeasureRiskSummaries(2, slices, warnings);
    const anchoredNotes: AnchorMarkerInfo[] = [
      {
        noteUid: "n-s0",
        measureIndex: 0,
        midi: 60,
        hand: "RH",
        finger: 1,
        isConflict: false,
      },
    ];
    const onSelectMeasure = vi.fn();

    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    await act(async () => {
      mountedRoot!.render(
        createElement(ScoreViewer, {
          xmlString: "<score-partwise/>",
          measureRisks,
          anchoredNotes,
          selectedMeasureIndex: 1,
          selectedSliceId: "s1",
          onSelectMeasure,
          rendererFactory: () => fakeRenderer,
        })
      );
      await Promise.resolve();
    });

    expect(fakeRenderer.render).toHaveBeenCalledWith("<score-partwise/>");
    expect(markAnchoredNotes).toHaveBeenCalledWith(anchoredNotes);
    expect(highlightMeasure).toHaveBeenCalledWith(1);
    expect(scrollToMeasure).toHaveBeenCalledWith(1, expect.any(HTMLElement));

    const anchorStrip = mountedContainer.querySelector('[data-testid="anchor-indicators"]');
    expect(anchorStrip).not.toBeNull();
    expect(anchorStrip!.textContent).toContain("m.1");
    expect(anchorStrip!.textContent).toContain("1");

    const viewer = mountedContainer.querySelector('[data-testid="score-viewer"]') as HTMLElement;
    expect(viewer.dataset.activeMeasure).toBe("1");
    expect(viewer.dataset.selectedSlice).toBe("s1");

    const gutterBar0 = mountedContainer.querySelector('[data-measure-index="0"]') as HTMLButtonElement;
    act(() => {
      gutterBar0.click();
    });
    expect(onSelectMeasure).toHaveBeenCalledWith(0);
  });
});

describe("Slice 4: App Split Studio layout & Studio UI interaction seam", () => {
  it("renders two-column Split Studio, Margin Risk Gutter, anchor indicators, and syncs warning/gutter clicks to slice selection & scroll", async () => {
    const inProcessWorkerFactory = (): WorkerLike => {
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(msg: unknown) {
          const req = msg as WorkerRequest;
          queueMicrotask(() => {
            const result = solveFingering(req.onsetSlices, req.profile, {
              ignoreExistingFingerings: req.ignoreExistingFingerings,
            });
            const resp: WorkerResponse = { requestId: req.requestId, ok: true, result };
            worker.onmessage?.({ data: resp } as MessageEvent<WorkerResponse>);
          });
        },
        terminate() {},
      };
      return worker;
    };

    const highlightMeasure = vi.fn();
    const markAnchoredNotes = vi.fn();
    const scrollToMeasure = vi.fn();
    const rendererSpy: ScoreRendererHandle = {
      render: vi.fn(async () => ({
        measureCount: 3,
        measureGeometry: [
          { measureIndex: 0, top: 0, height: 100 },
          { measureIndex: 1, top: 0, height: 100 },
          { measureIndex: 2, top: 110, height: 100 },
        ],
      })),
      highlightMeasure,
      markAnchoredNotes,
      scrollToMeasure,
      dispose: vi.fn(),
    };

    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    await act(async () => {
      mountedRoot!.render(
        createElement(App, {
          solverClientFactory: () => createSolverClient(inProcessWorkerFactory),
          scoreRendererFactory: () => rendererSpy,
        })
      );
    });

    const workspace = mountedContainer.querySelector('[data-testid="split-studio-workspace"]');
    expect(workspace).not.toBeNull();
    expect(mountedContainer.querySelector('[data-testid="inspector-panel"]')).not.toBeNull();
    expect(mountedContainer.querySelector('[data-testid="score-viewer"]')).not.toBeNull();

    const multiMeasureXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note>
        <pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff>
        <notations><technical><fingering placement="above">2</fingering></technical></notations>
      </note>
      <backup><duration>1</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><chord/><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>1</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
    </measure>
    <measure number="3">
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>1</duration></backup>
      <note><pitch><step>C</step><octave>2</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>E</step><octave>3</octave></pitch><duration>1</duration><voice>2</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

    const fileInput = mountedContainer.querySelector('input[type="file"]') as HTMLInputElement;
    const fakeFile = {
      name: "studio-test.musicxml",
      text: async () => multiMeasureXml,
      arrayBuffer: async () => new TextEncoder().encode(multiMeasureXml).buffer,
    };
    Object.defineProperty(fileInput, "files", { value: [fakeFile], configurable: true });

    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });

    // Anchor indicator displayed for m.1 E4 finger 2
    const anchorIndicators = mountedContainer.querySelector('[data-testid="anchor-indicators"]');
    expect(anchorIndicators).not.toBeNull();
    expect(anchorIndicators!.textContent).toContain("m.1 E4 (RH): 2");
    expect(markAnchoredNotes).toHaveBeenCalledWith([
      expect.objectContaining({ measureIndex: 0, midi: 64, hand: "RH", finger: 2 }),
    ]);

    // Margin Risk Gutter shows 3 measures: m.1 none, m.2 warn/danger, m.3 danger
    const gutterBars = Array.from(
      mountedContainer.querySelectorAll<HTMLButtonElement>("[data-testid='margin-risk-gutter'] [data-measure-index]")
    );
    expect(gutterBars).toHaveLength(3);
    expect(gutterBars[0].dataset.severity).toBe("none");
    expect(["warn", "danger"]).toContain(gutterBars[1].dataset.severity);
    expect(gutterBars[2].dataset.severity).toBe("danger");

    // Inspector lists warnings chronologically (m.2 then m.3)
    const warningItems = Array.from(
      mountedContainer.querySelectorAll<HTMLButtonElement>("[data-warning-item]")
    );
    expect(warningItems.length).toBeGreaterThanOrEqual(2);
    expect(warningItems.map((w) => Number(w.dataset.measureIndex))).toEqual(
      warningItems.map((w) => Number(w.dataset.measureIndex)).slice().sort((a, b) => a - b)
    );

    // Click last warning (measureIndex = 2, LH unreachable-span) -> selects slice, highlights measure 2, scrolls
    const m3Warning = warningItems.find((w) => w.dataset.measureIndex === "2")!;
    await act(async () => {
      m3Warning.click();
      await Promise.resolve();
    });

    const viewer = mountedContainer.querySelector('[data-testid="score-viewer"]') as HTMLElement;
    expect(viewer.dataset.activeMeasure).toBe("2");
    expect(viewer.dataset.selectedSlice).toBe(m3Warning.dataset.sliceId);
    expect(gutterBars[2].getAttribute("aria-pressed")).toBe("true");
    expect(highlightMeasure).toHaveBeenLastCalledWith(2);
    expect(scrollToMeasure).toHaveBeenLastCalledWith(2, expect.any(HTMLElement));
    expect(
      mountedContainer.querySelector('[data-testid="selected-slice-summary"]')?.textContent
    ).toContain("m.3 · LH");

    // Click Margin Risk Gutter bar for m.2 (measureIndex = 1) -> selects slice in m.2, highlights matching warning, scrolls
    await act(async () => {
      gutterBars[1].click();
      await Promise.resolve();
    });

    expect(viewer.dataset.activeMeasure).toBe("1");
    expect(gutterBars[1].getAttribute("aria-pressed")).toBe("true");
    expect(highlightMeasure).toHaveBeenLastCalledWith(1);
    expect(scrollToMeasure).toHaveBeenLastCalledWith(1, expect.any(HTMLElement));

    const m2Warning = Array.from(
      mountedContainer.querySelectorAll<HTMLButtonElement>("[data-warning-item]")
    ).find((w) => w.dataset.measureIndex === "1")!;
    expect(m2Warning.getAttribute("aria-pressed")).toBe("true");
    expect(viewer.dataset.selectedSlice).toBe(m2Warning.dataset.sliceId);
  });
});
