// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { parseMusicXml } from "../src/musicxml/parser";
import { solveFingering } from "../src/solver/solveFingering";
import { DEFAULT_HAND_SPAN_PROFILE } from "../src/domain/types";
import {
  ScoreViewer,
  matchHitToNoteEvent,
  type ScoreRendererHandle,
} from "../src/components/ScoreViewer";
import { InspectorPanel } from "../src/components/InspectorPanel";
import App from "../src/App";
import { createSolverClient, type WorkerLike } from "../src/workers/solverClient";
import { handleWorkerRequest } from "../src/workers/fingering.worker";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let mountedRoot: Root | null = null;
let mountedContainer: HTMLElement | null = null;

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

const SCORE_WITH_TIE_AND_CHORD = `<?xml version="1.0" encoding="UTF-8"?>
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
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff><tie type="start"/></note>
      <backup><duration>3</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>3</duration><voice>2</voice><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff><tie type="stop"/></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>2</duration><voice>2</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

describe("Seam 3a: ScoreViewer OSMD note hit-testing & purple Diff badges", () => {
  it("maps OSMD hit-test coordinates to exact pitched NoteEvent and TieContinuation, and renders purple Diff badges", async () => {
    const { DOMParser } = new JSDOM("").window;
    const doc = parseMusicXml(SCORE_WITH_TIE_AND_CHORD, { DOMParser });
    const g4 = doc.noteEvents.find((n) => n.midi === 67 && n.measureIndex === 0)!;
    const tieF4 = doc.noteEvents.find((n) => n.midi === 65 && n.isTieStop)!;

    // Pure mapping check
    expect(
      matchHitToNoteEvent(
        { measureIndex: 0, midi: 67, staffId: 1, beatOffsetInMeasure: 0.25, measureDurationWholeNotes: 0.75, isTieContinuation: false },
        doc.noteEvents
      )?.noteUid
    ).toBe(g4.noteUid);
    expect(
      matchHitToNoteEvent(
        { measureIndex: 1, midi: 65, staffId: 1, beatOffsetInMeasure: 0, measureDurationWholeNotes: 0.5, isTieContinuation: true },
        doc.noteEvents
      )?.noteUid
    ).toBe(tieF4.noteUid);

    const markDiffNotes = vi.fn();
    const hitTestNoteAtClientPoint = vi
      .fn()
      .mockReturnValueOnce({
        measureIndex: 0,
        midi: 67,
        staffId: 1,
        beatOffsetInMeasure: 0.25,
        measureDurationWholeNotes: 0.75,
        isTieContinuation: false,
      })
      .mockReturnValueOnce({
        measureIndex: 1,
        midi: 65,
        staffId: 1,
        beatOffsetInMeasure: 0,
        measureDurationWholeNotes: 0.5,
        isTieContinuation: true,
      });

    const fakeRenderer: ScoreRendererHandle = {
      render: vi.fn(async () => ({
        measureCount: 2,
        measureGeometry: [
          { measureIndex: 0, top: 0, height: 100 },
          { measureIndex: 1, top: 110, height: 100 },
        ],
      })),
      highlightMeasure: vi.fn(),
      markAnchoredNotes: vi.fn(),
      markDiffNotes,
      scrollToMeasure: vi.fn(),
      hitTestNoteAtClientPoint,
      dispose: vi.fn(),
    };

    const onSelectNote = vi.fn();
    const diffNotes = [
      {
        noteUid: g4.noteUid,
        measureIndex: 0,
        pitchLabel: "G4",
        hand: "RH" as const,
        before: 4 as const,
        after: 5 as const,
      },
    ];

    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    await act(async () => {
      mountedRoot!.render(
        createElement(ScoreViewer, {
          xmlString: SCORE_WITH_TIE_AND_CHORD,
          noteEvents: doc.noteEvents,
          diffNotes,
          selectedNoteUid: g4.noteUid,
          onSelectNote,
          rendererFactory: () => fakeRenderer,
        })
      );
      await Promise.resolve();
    });

    // Purple Diff badge rendered in ScoreViewer and via renderer seam
    const diffStrip = mountedContainer.querySelector('[data-testid="diff-indicators"]');
    expect(diffStrip).not.toBeNull();
    expect(diffStrip!.textContent).toContain("Diff");
    expect(diffStrip!.textContent).toContain("G4");
    expect(diffStrip!.textContent).toContain("4 → 5");
    expect(markDiffNotes).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ noteUid: g4.noteUid, before: 4, after: 5 })])
    );

    // Click on OSMD canvas -> invokes hitTestNoteAtClientPoint -> selects G4, then TieContinuation F4
    const osmdSurface = mountedContainer.querySelector('[data-testid="osmd-canvas-surface"]') as HTMLElement;
    expect(osmdSurface).not.toBeNull();

    act(() => {
      osmdSurface.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 120, clientY: 80 }));
    });
    expect(onSelectNote).toHaveBeenNthCalledWith(1, g4.noteUid);

    act(() => {
      osmdSurface.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 240, clientY: 85 }));
    });
    expect(onSelectNote).toHaveBeenNthCalledWith(2, tieF4.noteUid);
  });
});

describe("Seam 3b: InspectorPanel note editor (1-5, pinOnly, remove, TieContinuation, Diff card)", () => {
  it("supports 1-5 phrase overrides, pinOnly toggle, Remove Anchor, Before -> After Diff card, and TieContinuation explanation", () => {
    const { DOMParser } = new JSDOM("").window;
    const doc = parseMusicXml(SCORE_WITH_TIE_AND_CHORD, { DOMParser });
    const res = solveFingering(doc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);

    const e4 = doc.noteEvents.find((n) => n.midi === 64 && n.measureIndex === 0)!;
    const tieF4 = doc.noteEvents.find((n) => n.midi === 65 && n.isTieStop)!;

    const onSetAnchor = vi.fn();
    const onRemoveAnchor = vi.fn();
    const onUndo = vi.fn();
    const onRedo = vi.fn();

    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    act(() => {
      mountedRoot!.render(
        createElement(InspectorPanel, {
          warnings: res.warnings,
          onsetSlices: doc.onsetSlices,
          noteEvents: doc.noteEvents,
          fingerByNoteUid: res.fingerByNoteUid,
          handSpanProfile: DEFAULT_HAND_SPAN_PROFILE,
          selectedSliceId: doc.onsetSlices[1].sliceId,
          selectedMeasureIndex: 0,
          selectedNoteUid: e4.noteUid,
          anchors: { [e4.noteUid]: { finger: 3, mode: "phrase" } },
          lastDiff: [
            {
              noteUid: e4.noteUid,
              measureIndex: 0,
              pitchLabel: "E4",
              hand: "RH",
              before: 2,
              after: 3,
            },
          ],
          canUndo: true,
          canRedo: false,
          ignoreExistingFingerings: false,
          hasScore: true,
          onSelectWarning: vi.fn(),
          onSetAnchor,
          onRemoveAnchor,
          onUndo,
          onRedo,
        })
      );
    });

    const editor = mountedContainer.querySelector('[data-testid="selected-note-editor"]')!;
    expect(editor.textContent).toContain("E4");

    // Default mode is phrase: clicking finger 4 sends mode="phrase"
    const btn4 = mountedContainer.querySelector('[data-testid="finger-btn-4"]') as HTMLButtonElement;
    act(() => {
      btn4.click();
    });
    expect(onSetAnchor).toHaveBeenLastCalledWith(e4.noteUid, 4, "phrase");

    // Clicking pinOnly toggle switches mode to pinOnly (and updates active phrase anchor to pinOnly)
    const pinBtn = mountedContainer.querySelector('[data-testid="pin-only-toggle"]') as HTMLButtonElement;
    act(() => {
      pinBtn.click();
    });
    expect(pinBtn.getAttribute("aria-pressed")).toBe("true");
    expect(onSetAnchor).toHaveBeenLastCalledWith(e4.noteUid, 3, "pinOnly");

    // Clicking finger 5 now sends mode="pinOnly"
    const btn5 = mountedContainer.querySelector('[data-testid="finger-btn-5"]') as HTMLButtonElement;
    act(() => {
      btn5.click();
    });
    expect(onSetAnchor).toHaveBeenLastCalledWith(e4.noteUid, 5, "pinOnly");

    // Remove Anchor button
    const removeBtn = mountedContainer.querySelector('[data-testid="remove-anchor-btn"]') as HTMLButtonElement;
    expect(removeBtn.disabled).toBe(false);
    act(() => {
      removeBtn.click();
    });
    expect(onRemoveAnchor).toHaveBeenCalledWith(e4.noteUid);

    // Before -> After Diff card
    const diffCard = mountedContainer.querySelector('[data-testid="diff-card"]')!;
    expect(diffCard.textContent).toContain("E4");
    expect(diffCard.textContent).toContain("2 → 3");

    // Re-render with TieContinuation selected -> explains no independent <fingering>
    act(() => {
      mountedRoot!.render(
        createElement(InspectorPanel, {
          warnings: res.warnings,
          onsetSlices: doc.onsetSlices,
          noteEvents: doc.noteEvents,
          fingerByNoteUid: res.fingerByNoteUid,
          handSpanProfile: DEFAULT_HAND_SPAN_PROFILE,
          selectedSliceId: doc.onsetSlices[3].sliceId,
          selectedMeasureIndex: 1,
          selectedNoteUid: tieF4.noteUid,
          anchors: {},
          lastDiff: [],
          canUndo: false,
          canRedo: false,
          ignoreExistingFingerings: false,
          hasScore: true,
          onSelectWarning: vi.fn(),
          onSetAnchor,
          onRemoveAnchor,
        })
      );
    });

    const tieNotice = mountedContainer.querySelector('[data-testid="tie-continuation-notice"]')!;
    expect(tieNotice.textContent).toMatch(/Tie Continuation/i);
    expect(tieNotice.textContent).toContain("<fingering>");
    expect(mountedContainer.querySelector('[data-testid="finger-btn-1"]')).toBeNull();
  });
});

describe("Seam 3c: Full App integration (OSMD click -> local resolve -> Diff/Keyboard/XML -> Undo/Redo)", () => {
  it("connects OSMD note click, phrase/pinOnly/remove overrides, purple Diff badges, DualTrackKeyboard, XML export, and Undo/Redo", async () => {
    const inProcessWorkerFactory = (): WorkerLike => {
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(msg: unknown) {
          const req = msg as WorkerRequest;
          queueMicrotask(() => {
            const resp = handleWorkerRequest(req);
            worker.onmessage?.({ data: resp } as MessageEvent<WorkerResponse>);
          });
        },
        terminate() {},
      };
      return worker;
    };

    const renderedXmlHistory: string[] = [];
    const hitQueue = [
      // 1st click: E4 in m.1 (midi 64, beat 0.25)
      { measureIndex: 0, midi: 64, staffId: 1, beatOffsetInMeasure: 0.25, measureDurationWholeNotes: 0.75, isTieContinuation: false },
      // 2nd click: C4 in m.1 (midi 60, beat 0)
      { measureIndex: 0, midi: 60, staffId: 1, beatOffsetInMeasure: 0, measureDurationWholeNotes: 0.75, isTieContinuation: false },
      // 3rd click: TieContinuation F4 in m.2 (midi 65)
      { measureIndex: 1, midi: 65, staffId: 1, beatOffsetInMeasure: 0, measureDurationWholeNotes: 0.5, isTieContinuation: true },
    ];
    let hitCursor = 0;

    const fakeRenderer: ScoreRendererHandle = {
      render: vi.fn(async (xml: string) => {
        renderedXmlHistory.push(xml);
        return {
          measureCount: 2,
          measureGeometry: [
            { measureIndex: 0, top: 0, height: 100 },
            { measureIndex: 1, top: 110, height: 100 },
          ],
        };
      }),
      highlightMeasure: vi.fn(),
      markAnchoredNotes: vi.fn(),
      markDiffNotes: vi.fn(),
      highlightSelectedNote: vi.fn(),
      hitTestNoteAtClientPoint: vi.fn(() => hitQueue[hitCursor++] ?? null),
      scrollToMeasure: vi.fn(),
      dispose: vi.fn(),
    };

    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    await act(async () => {
      mountedRoot!.render(
        createElement(App, {
          solverClientFactory: () => createSolverClient(inProcessWorkerFactory),
          scoreRendererFactory: () => fakeRenderer,
        })
      );
    });

    const fileInput = mountedContainer.querySelector('input[type="file"]') as HTMLInputElement;
    const fakeFile = {
      name: "interactive-test.musicxml",
      text: async () => SCORE_WITH_TIE_AND_CHORD,
      arrayBuffer: async () => new TextEncoder().encode(SCORE_WITH_TIE_AND_CHORD).buffer,
    };
    Object.defineProperty(fileInput, "files", { value: [fakeFile], configurable: true });

    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 25));
    });

    // Click E4 on OSMD surface
    const osmdSurface = mountedContainer.querySelector('[data-testid="osmd-canvas-surface"]') as HTMLElement;
    await act(async () => {
      osmdSurface.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 100, clientY: 60 }));
      await Promise.resolve();
    });

    expect(mountedContainer.querySelector('[data-testid="selected-note-editor"]')?.textContent).toContain("E4");

    // Apply phrase override: E4 -> finger 4
    await act(async () => {
      (mountedContainer!.querySelector('[data-testid="finger-btn-4"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 25));
    });

    // Purple Diff badge & Inspector Diff card updated
    expect(mountedContainer.querySelector('[data-testid="diff-indicators"]')?.textContent).toContain("E4");
    expect(mountedContainer.querySelector('[data-testid="diff-card"]')?.textContent).toContain("→ 4");
    // DualTrackKeyboard RH track reflects updated finger 4 on midi 64
    const rhTrack = mountedContainer.querySelector('[data-testid="keyboard-track-RH"]')!;
    expect(rhTrack.querySelector('[data-midi="64"]')?.textContent).toContain("4");
    // Exported/rendered XML updated immediately
    const xmlAfterPhrase = renderedXmlHistory[renderedXmlHistory.length - 1];
    expect(xmlAfterPhrase).toContain("<fingering placement=\"above\">4</fingering>");

    // Click C4 on OSMD surface, toggle pinOnly, set C4 -> finger 2
    await act(async () => {
      osmdSurface.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 50, clientY: 60 }));
      await Promise.resolve();
    });
    expect(mountedContainer.querySelector('[data-testid="selected-note-editor"]')?.textContent).toContain("C4");

    await act(async () => {
      (mountedContainer!.querySelector('[data-testid="pin-only-toggle"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (mountedContainer!.querySelector('[data-testid="finger-btn-2"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 25));
    });

    expect(mountedContainer.querySelector('[data-testid="diff-card"]')?.textContent).toContain("C4");
    expect(mountedContainer.querySelector('[data-testid="diff-card"]')?.textContent).toContain("1 → 2");

    // Remove anchor on C4 -> restores solver freedom
    await act(async () => {
      (mountedContainer!.querySelector('[data-testid="remove-anchor-btn"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 25));
    });

    // Undo -> back to C4 = 2, Undo again -> back to E4 = 4, Redo -> C4 = 2
    const undoBtn = mountedContainer.querySelector('[data-testid="undo-btn"]') as HTMLButtonElement;
    const redoBtn = mountedContainer.querySelector('[data-testid="redo-btn"]') as HTMLButtonElement;
    expect(undoBtn).not.toBeNull();
    expect(redoBtn).not.toBeNull();
    expect(undoBtn.disabled).toBe(false);

    await act(async () => {
      undoBtn.click();
      await Promise.resolve();
    });
    expect(mountedContainer.querySelector('[data-testid="diff-card"]')?.textContent).toContain("C4");
    expect(mountedContainer.querySelector('[data-testid="diff-card"]')?.textContent).toContain("1 → 2");

    await act(async () => {
      redoBtn.click();
      await Promise.resolve();
    });
    expect(mountedContainer.querySelector('[data-testid="diff-card"]')?.textContent).toContain("2 → 1");

    // Click TieContinuation F4 -> Inspector explains no independent <fingering>
    await act(async () => {
      osmdSurface.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 200, clientY: 60 }));
      await Promise.resolve();
    });
    const tieNotice = mountedContainer.querySelector('[data-testid="tie-continuation-notice"]');
    expect(tieNotice).not.toBeNull();
    expect(tieNotice!.textContent).toContain("<fingering>");
  });
});
