// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/App";
import type { ScoreRendererHandle } from "../src/components/ScoreViewer";
import { solveFingering } from "../src/solver/solveFingering";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const url = window.location.href;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, "", url);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function studio() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const element = document.createElement("div");
  document.body.append(element);
  const app = root = createRoot(element);
  const getAudioContext = vi.fn(() => { throw new Error("MIDI Local Sound should be off"); });
  const scoreRendererFactory = (): ScoreRendererHandle => ({
    async render() { return { measureCount: 1, measureGeometry: [] }; },
    highlightMeasure() {}, markAnchoredNotes() {}, syncCursor() {}, hitTestNoteAtClientPoint: () => null,
    scrollToMeasure() {}, dispose() {},
  });
  const props: React.ComponentProps<typeof App> = {
    practiceStorage: null,
    midiDeps: {},
    audioDeps: { getAudioContext },
    solverClientFactory: () => ({ solve: async (slices, profile, options) => solveFingering(slices, profile, options), dispose() {} }),
    scoreRendererFactory,
  };
  return {
    element, getAudioContext,
    render: async (path: string) => {
      window.history.replaceState(null, "", path);
      await act(async () => app.render(createElement(App, props)));
    },
    click: async (testId: string) => {
      const button = element.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
      expect(button).not.toBeNull();
      await act(async () => button!.click());
    },
    pressed: (midi: number) => element.querySelector(`[data-testid="piano-key-${midi}"]`)?.getAttribute("data-key-pressed"),
  };
}

it("exposes simulated MIDI only on explicit opt-in and shows the idle strike without local audio", async () => {
  const ui = studio();
  const bar = () => ui.element.querySelector('[data-testid="sim-midi-bar"]');
  await ui.render("/");
  expect(bar()).toBeNull();
  await ui.render("/?simMidi=0");
  expect(bar()).toBeNull();
  await ui.render("/?simMidi=1");
  expect(bar()).not.toBeNull();
  await ui.click("sim-midi-strike");
  expect(ui.pressed(60)).toBe("true");
  expect(ui.getAudioContext).not.toHaveBeenCalled();
});

it("releases active simulated keys and cancels upcoming strikes on transport Stop", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  const xml = `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
    <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration></note>
    </measure></part></score-partwise>`;
  const ui = studio();
  await ui.render("/?simMidi=1");
  const input = ui.element.querySelector('input[accept=".musicxml,.xml,.mxl"]')!;
  Object.defineProperty(input, "files", { value: [{ name: "duet.musicxml", text: async () => xml }] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await ui.click("waiting-mode-toggle-btn");
  await ui.click("audio-play-btn");
  await ui.click("sim-midi-play");
  expect(ui.pressed(60)).toBe("true");

  await ui.click("audio-stop-btn");
  expect(ui.pressed(60)).not.toBe("true");
  await act(async () => vi.advanceTimersByTime(600));
  expect(ui.pressed(62)).not.toBe("true");
});
