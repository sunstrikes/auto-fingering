// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../src/App";
import { createMidiRingBuffer } from "../src/midi/midiRingBuffer";
import type { ScoreRendererHandle } from "../src/components/ScoreViewer";
import { solveFingering } from "../src/solver/solveFingering";
import { createSolverClient, type WorkerLike } from "../src/workers/solverClient";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";
import {
  parseMidiMessage,
  createWebMidiController,
  type MIDIAccessLike,
  type MIDIInputLike,
  type MidiInputEvent,
  type MidiConnectionState,
} from "../src/midi/webMidi";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function createInProcessWorker(): WorkerLike {
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(req: WorkerRequest) {
      queueMicrotask(() => {
        if (req.type === undefined || req.type === "solve") {
          const result = solveFingering(req.onsetSlices, req.profile, {
            ignoreExistingFingerings: req.ignoreExistingFingerings,
          });
          worker.onmessage?.(
            new MessageEvent("message", {
              data: { requestId: req.requestId, ok: true, result },
            }) as MessageEvent<WorkerResponse>
          );
        }
      });
    },
    terminate() {},
  };
  return worker;
}

function createNoopRenderer(): ScoreRendererHandle {
  return {
    render: vi.fn().mockResolvedValue({ measures: [] }),
    syncCursor: vi.fn(),
    highlightMeasure: vi.fn(),
    markAnchoredNotes: vi.fn(),
    scrollToMeasure: vi.fn(),
    hitTestNoteAtClientPoint: () => null,
    dispose: vi.fn(),
  };
}

function createSpyAudioDeps() {
  const startedNotes: Array<{ note: number; velocity?: number }> = [];
  const fakeCtx = {
    currentTime: 0,
    state: "running",
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    createGain: () => ({
      gain: {
        value: 1,
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    createOscillator: () => ({
      type: "sine",
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }),
    createBiquadFilter: () => ({
      type: "lowpass",
      frequency: { setValueAtTime: vi.fn() },
      Q: { value: 0.7 },
      connect: vi.fn(),
    }),
  } as unknown as AudioContext;

  return {
    startedNotes,
    audioDeps: {
      getAudioContext: () => fakeCtx,
      loadSmplrPiano: async () => ({
        start: (ev: { note: number; velocity?: number }) => {
          startedNotes.push({ note: ev.note, velocity: ev.velocity });
        },
        stop: vi.fn(),
      }),
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
    },
  };
}

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

function makeMockInput(id: string, name: string, state: "connected" | "disconnected" = "connected"): MIDIInputLike & {
  emitMessage: (data: number[]) => void;
} {
  const input: MIDIInputLike & { emitMessage: (data: number[]) => void } = {
    id,
    name,
    manufacturer: "MockCorp",
    state,
    onmidimessage: null,
    emitMessage(data: number[]) {
      this.onmidimessage?.({ data: new Uint8Array(data), timeStamp: performance.now() });
    },
  };
  return input;
}

function makeMockMidiAccess(initialInputs: MIDIInputLike[] = []): MIDIAccessLike & {
  addInput: (input: MIDIInputLike) => void;
  removeInput: (id: string) => void;
} {
  const inputs = new Map<string, MIDIInputLike>();
  for (const inp of initialInputs) {
    inputs.set(inp.id, inp);
  }
  const access: MIDIAccessLike & {
    addInput: (input: MIDIInputLike) => void;
    removeInput: (id: string) => void;
  } = {
    inputs,
    onstatechange: null,
    addInput(input: MIDIInputLike) {
      inputs.set(input.id, input);
      this.onstatechange?.({ port: input });
    },
    removeInput(id: string) {
      const existing = inputs.get(id);
      if (!existing) return;
      existing.state = "disconnected";
      inputs.delete(id);
      this.onstatechange?.({ port: existing });
    },
  };
  return access;
}

describe("Web MIDI packet parsing & hot-plug controller", () => {
  it("parses NoteOn, NoteOff (0x80 and zero-velocity 0x90), CC 64 sustain, and ignores other messages", () => {
    expect(parseMidiMessage(new Uint8Array([0x90, 60, 100]), "p1")).toEqual({
      type: "noteon",
      midi: 60,
      velocity: 100,
      channel: 0,
      portId: "p1",
      source: "midi",
    });

    expect(parseMidiMessage(new Uint8Array([0x82, 60, 64]), "p1")).toEqual({
      type: "noteoff",
      midi: 60,
      velocity: 0,
      channel: 2,
      portId: "p1",
      source: "midi",
    });

    expect(parseMidiMessage(new Uint8Array([0x91, 64, 0]), "p1")).toEqual({
      type: "noteoff",
      midi: 64,
      velocity: 0,
      channel: 1,
      portId: "p1",
      source: "midi",
    });

    expect(parseMidiMessage(new Uint8Array([0xb0, 64, 127]), "p1")).toEqual({
      type: "sustain",
      value: 127,
      pressed: true,
      channel: 0,
      portId: "p1",
      source: "midi",
    });

    expect(parseMidiMessage(new Uint8Array([0xb0, 64, 0]), "p1")).toEqual({
      type: "sustain",
      value: 0,
      pressed: false,
      channel: 0,
      portId: "p1",
      source: "midi",
    });

    expect(parseMidiMessage(new Uint8Array([0xfe]), "p1")).toBeNull();
    expect(parseMidiMessage(new Uint8Array([0xb0, 1, 64]), "p1")).toBeNull();
  });

  it("discovers devices, hot-plugs onstatechange, merges all inputs, and filters by selectedDeviceId", async () => {
    const p1 = makeMockInput("dev-1", "Roland FP-30X");
    const access = makeMockMidiAccess([p1]);

    const states: MidiConnectionState[] = [];
    const events: MidiInputEvent[] = [];

    const controller = createWebMidiController({
      requestMIDIAccess: async () => access,
      onStateChange: (s) => states.push(s),
      onMidiEvent: (ev) => events.push(ev),
    });

    await controller.connect();

    expect(states[states.length - 1]?.status).toBe("connected");
    expect(states[states.length - 1]?.devices.map((d) => d.name)).toEqual(["Roland FP-30X"]);

    // Hot-plug second device
    const p2 = makeMockInput("dev-2", "Yamaha P-125");
    access.addInput(p2);
    expect(states[states.length - 1]?.devices.map((d) => d.id)).toEqual(["dev-1", "dev-2"]);

    // Merged listening receives from both
    p1.emitMessage([0x90, 60, 90]);
    p2.emitMessage([0x90, 64, 80]);
    expect(events.map((e) => (e.type === "noteon" ? `${e.portId}:${e.midi}` : ""))).toEqual([
      "dev-1:60",
      "dev-2:64",
    ]);

    // Pin single port
    controller.setSelectedDeviceId("dev-2");
    p1.emitMessage([0x90, 62, 90]);
    p2.emitMessage([0x90, 67, 85]);
    expect(events.length).toBe(3);
    expect(events[2]).toMatchObject({ type: "noteon", portId: "dev-2", midi: 67 });

    // Disconnect pinned device -> status updates
    access.removeInput("dev-2");
    expect(states[states.length - 1]?.devices.map((d) => d.id)).toEqual(["dev-1"]);

    controller.dispose();
  });

  it("preserves hardware timestamps (including zero), strike velocity and every CC64 value", async () => {
    const input = makeMockInput("piano", "Digital piano");
    const events: MidiInputEvent[] = [];
    const controller = createWebMidiController({
      requestMIDIAccess: async () => makeMockMidiAccess([input]),
      onStateChange: () => {},
      onMidiEvent: (event) => events.push(event),
    });
    await controller.connect();

    input.onmidimessage?.({ data: [0x93, 60, 127], timeStamp: 0 });
    input.onmidimessage?.({ data: [0xb3, 64, 37], timeStamp: 1.125 });
    input.onmidimessage?.({ data: [0xb3, 64, 63], timeStamp: 1.25 });
    input.onmidimessage?.({ data: [0xb3, 64, 64], timeStamp: 1.375 });
    input.onmidimessage?.({ data: [0x83, 60, 0], timeStamp: 2.0625 });
    input.onmidimessage?.({ data: [0x93, 62, 1] }); // Legacy MIDIInputLike has no clock.
    controller.dispose();

    expect(events).toMatchObject([
      { type: "noteon", midi: 60, velocity: 127, timeStampMs: 0, source: "midi", channel: 3 },
      { type: "sustain", value: 37, pressed: false, timeStampMs: 1.125 },
      { type: "sustain", value: 63, pressed: false, timeStampMs: 1.25 },
      { type: "sustain", value: 64, pressed: true, timeStampMs: 1.375 },
      { type: "noteoff", midi: 60, timeStampMs: 2.0625 },
      { type: "noteon", midi: 62, velocity: 1 },
    ]);
    expect(events[5]).not.toHaveProperty("timeStampMs");
  });

  it("handles unsupported browser and denied permission cleanly", async () => {
    const unsupportedStates: MidiConnectionState[] = [];
    const c1 = createWebMidiController({
      requestMIDIAccess: undefined,
      onStateChange: (s) => unsupportedStates.push(s),
      onMidiEvent: () => {},
    });
    await c1.connect();
    expect(unsupportedStates[unsupportedStates.length - 1]?.status).toBe("unsupported");
    c1.dispose();

    const deniedStates: MidiConnectionState[] = [];
    const c2 = createWebMidiController({
      requestMIDIAccess: async () => {
        const err = new Error("Permission denied");
        err.name = "SecurityError";
        throw err;
      },
      onStateChange: (s) => deniedStates.push(s),
      onMidiEvent: () => {},
    });
    await c2.connect();
    expect(deniedStates[deniedStates.length - 1]?.status).toBe("denied");
    c2.dispose();
  });
});

describe("<App /> Web MIDI integration, Practice Settings & local sound", () => {
  it("updates header status and Practice Settings device list on hot-plug, highlights keys on NoteOn/NoteOff/CC64, and gates audio by MIDI Local Sound", async () => {
    const dev1 = makeMockInput("dev-1", "Roland FP-30X");
    const access = makeMockMidiAccess([dev1]);
    const { startedNotes, audioDeps } = createSpyAudioDeps();

    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    await act(async () => {
      mountedRoot!.render(
        createElement(App, {
          solverClientFactory: () => createSolverClient(createInProcessWorker),
          scoreRendererFactory: createNoopRenderer,
          audioDeps,
          midiDeps: {
            requestMIDIAccess: async () => access,
          },
        })
      );
    });

    const settingsBtn = mountedContainer.querySelector('[data-testid="practice-settings-btn"]') as HTMLButtonElement;
    expect(settingsBtn).not.toBeNull();
    expect(settingsBtn.textContent).toContain("已连接 1 台");

    // Open Practice Settings modal
    await act(async () => {
      settingsBtn.click();
    });

    const modal = mountedContainer.querySelector('[data-testid="practice-settings-modal"]');
    expect(modal).not.toBeNull();

    const select = mountedContainer.querySelector('[data-testid="midi-device-select"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["all", "dev-1"]);

    // Hot-plug a second device
    const dev2 = makeMockInput("dev-2", "Kawai ES920");
    await act(async () => {
      access.addInput(dev2);
    });
    expect(settingsBtn.textContent).toContain("已连接 2 台");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["all", "dev-1", "dev-2"]);

    // MIDI Local Sound defaults to OFF -> NoteOn highlights key 60 without triggering audio
    await act(async () => {
      dev1.emitMessage([0x90, 60, 100]);
    });
    const key60 = mountedContainer.querySelector('[data-testid="piano-key-60"]')!;
    expect(key60.getAttribute("data-key-pressed")).toBe("true");
    expect(startedNotes.length).toBe(0);

    // CC 64 Sustain pressed
    await act(async () => {
      dev1.emitMessage([0xb0, 64, 127]);
    });
    expect(mountedContainer.querySelector('[data-testid="midi-sustain-indicator"]')).not.toBeNull();

    // NoteOff via 0x90 velocity 0
    await act(async () => {
      dev1.emitMessage([0x90, 60, 0]);
      dev1.emitMessage([0xb0, 64, 0]);
    });
    expect(key60.getAttribute("data-key-pressed")).not.toBe("true");
    expect(mountedContainer.querySelector('[data-testid="midi-sustain-indicator"]')).toBeNull();

    // Enable MIDI Local Sound -> NoteOn triggers PianoAudioEngine
    const localSoundToggle = mountedContainer.querySelector('[data-testid="midi-local-sound-toggle"]') as HTMLInputElement;
    expect(localSoundToggle.checked).toBe(false);
    await act(async () => {
      localSoundToggle.click();
    });
    expect(localSoundToggle.checked).toBe(true);

    await act(async () => {
      dev2.emitMessage([0x90, 64, 95]);
    });
    expect(startedNotes.some((n) => n.note === 64)).toBe(true);
  });

  it("shows non-blocking unsupported explanation and USB connection guide when Web MIDI is unavailable", async () => {
    const { audioDeps } = createSpyAudioDeps();

    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    await act(async () => {
      mountedRoot!.render(
        createElement(App, {
          solverClientFactory: () => createSolverClient(createInProcessWorker),
          scoreRendererFactory: createNoopRenderer,
          audioDeps,
          midiDeps: {
            requestMIDIAccess: undefined,
          },
        })
      );
    });

    const settingsBtn = mountedContainer.querySelector('[data-testid="practice-settings-btn"]') as HTMLButtonElement;
    expect(settingsBtn.textContent).toContain("不支持");

    await act(async () => {
      settingsBtn.click();
    });

    const guide = mountedContainer.querySelector('[data-testid="midi-usb-guide"]');
    expect(guide).not.toBeNull();
    expect(guide!.textContent).toContain("USB");
    expect(guide!.textContent).toContain("不可用");
  });

  it("filters single-port events and captures local keyboard events with their own source and performance timestamps", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    try {
      const dev1 = makeMockInput("dev-1", "Roland FP-30X");
      const dev2 = makeMockInput("dev-2", "Yamaha P-125");
      const access = makeMockMidiAccess([dev1, dev2]);
      const { startedNotes, audioDeps } = createSpyAudioDeps();
      const ringBuffer = createMidiRingBuffer(8);

      mountedContainer = document.createElement("div");
      document.body.appendChild(mountedContainer);
      mountedRoot = createRoot(mountedContainer);

      await act(async () => {
        mountedRoot!.render(
          createElement(App, {
            solverClientFactory: () => createSolverClient(createInProcessWorker),
            scoreRendererFactory: createNoopRenderer,
            audioDeps,
            midiDeps: {
              requestMIDIAccess: async () => access,
              ringBuffer,
            },
          })
        );
      });

      // Top header MIDI status button opens Practice Settings modal
      const headerBtn = mountedContainer.querySelector('[data-testid="header-midi-status-btn"]') as HTMLButtonElement;
      expect(headerBtn).not.toBeNull();
      expect(headerBtn.textContent).toContain("MIDI: 已连接 2 台");

      await act(async () => {
        headerBtn.click();
      });

      const select = mountedContainer.querySelector('[data-testid="midi-device-select"]') as HTMLSelectElement;
      await act(async () => {
        select.value = "dev-2";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });

      // dev-1 is filtered out, dev-2 passes through
      await act(async () => {
        dev1.emitMessage([0x90, 62, 100]);
        dev2.emitMessage([0x90, 65, 100]);
      });
      expect(mountedContainer.querySelector('[data-testid="piano-key-62"]')!.getAttribute("data-key-pressed")).not.toBe("true");
      expect(mountedContainer.querySelector('[data-testid="piano-key-65"]')!.getAttribute("data-key-pressed")).toBe("true");

      // Release dev-2
      await act(async () => {
        dev2.emitMessage([0x80, 65, 0]);
      });
      expect(mountedContainer.querySelector('[data-testid="piano-key-65"]')!.getAttribute("data-key-pressed")).not.toBe("true");

      // Close modal via Escape
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(mountedContainer.querySelector('[data-testid="practice-settings-modal"]')).toBeNull();

      // Click on-screen UnifiedPiano88 key 60 -> synthetic NoteOn, audio audition, and NoteOff after 180ms
      const key60 = mountedContainer.querySelector('[data-testid="piano-key-60"]')!;
      await act(async () => {
        key60.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(key60.getAttribute("data-key-pressed")).toBe("true");
      expect(startedNotes.some((n) => n.note === 60)).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(key60.getAttribute("data-key-pressed")).not.toBe("true");

      // QWERTY key 'q' -> MIDI 72 NoteOn on keydown, NoteOff on keyup
      const key72 = mountedContainer.querySelector('[data-testid="piano-key-72"]')!;
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
      });
      expect(key72.getAttribute("data-key-pressed")).toBe("true");
      expect(startedNotes.some((n) => n.note === 72)).toBe(true);

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keyup", { key: "q", bubbles: true }));
      });
      expect(key72.getAttribute("data-key-pressed")).not.toBe("true");

      expect(ringBuffer.sliceWindow(0, 200)).toMatchObject([
        { type: "noteon", source: "midi", midi: 65, timeStampMs: 0 },
        { type: "noteoff", source: "midi", midi: 65, timeStampMs: 0 },
        { type: "noteon", source: "virtual", midi: 60, timeStampMs: 0 },
        { type: "noteoff", source: "virtual", midi: 60, timeStampMs: 180 },
        { type: "noteon", source: "qwerty", midi: 72, timeStampMs: 200 },
        { type: "noteoff", source: "qwerty", midi: 72, timeStampMs: 200 },
      ]);
      act(() => mountedRoot!.unmount());
      mountedRoot = null;
      expect(ringBuffer.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("only mounts the simulated MIDI toolbar for simMidi=1 and routes its pitch strikes as MIDI", async () => {
    const originalUrl = window.location.href;
    const { audioDeps, startedNotes } = createSpyAudioDeps();
    const ringBuffer = createMidiRingBuffer(8);
    const midiDeps = { ringBuffer, requestMIDIAccess: async () => makeMockMidiAccess() };
    const props = {
      solverClientFactory: () => createSolverClient(createInProcessWorker),
      scoreRendererFactory: createNoopRenderer,
      audioDeps,
      midiDeps,
    };
    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);
    const bar = () => mountedContainer?.querySelector('[data-testid="sim-midi-bar"]');

    try {
      window.history.replaceState(null, "", "/");
      await act(async () => mountedRoot!.render(createElement(App, props)));
      expect(bar()).toBeNull();

      window.history.replaceState(null, "", "/?simMidi=0");
      await act(async () => mountedRoot!.render(createElement(App, props)));
      expect(bar()).toBeNull();

      window.history.replaceState(null, "", "/?simMidi=1");
      await act(async () => mountedRoot!.render(createElement(App, props)));
      const strike = bar()?.querySelector<HTMLButtonElement>('[data-testid="sim-midi-strike"]');
      expect(strike).toBeInstanceOf(HTMLButtonElement);
      await act(async () => strike?.click());
      expect(mountedContainer.querySelector('[data-testid="piano-key-60"]')?.getAttribute("data-key-pressed")).toBe("true");
      expect(ringBuffer.sliceWindow(0, performance.now())).toMatchObject([
        { type: "noteon", portId: "simulated-midi", midi: 60, source: "midi" },
      ]);
      expect(startedNotes).toEqual([]); // Hardware Local Sound is off, unlike a virtual click.
    } finally {
      window.history.replaceState(null, "", originalUrl);
    }
  });


  it("clears session capture and cancels outstanding simulated packets on transport Stop", async () => {
    const originalUrl = window.location.href;
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const ringBuffer = createMidiRingBuffer(8);
    const { audioDeps } = createSpyAudioDeps();
    const xml = `<score-partwise version="3.1">
      <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
      <part id="P1"><measure number="1">
        <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
        <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      </measure></part>
    </score-partwise>`;
    try {
      window.history.replaceState(null, "", "/?simMidi=1");
      const container = document.createElement("div");
      document.body.appendChild(container);
      mountedContainer = container;
      mountedRoot = createRoot(container);
      const button = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
      await act(async () => mountedRoot!.render(createElement(App, {
        solverClientFactory: () => createSolverClient(createInProcessWorker),
        scoreRendererFactory: createNoopRenderer,
        audioDeps,
        midiDeps: { ringBuffer },
      })));
      const upload = container.querySelector('input[type="file"]')!;
      Object.defineProperty(upload, "files", {
        value: [{ name: "duet.musicxml", text: async () => xml }],
      });
      await act(async () => upload.dispatchEvent(new Event("change", { bubbles: true })));
      expect(button("audio-play-btn").disabled, container.textContent ?? "").toBe(false);
      await act(async () => button("waiting-mode-toggle-btn").click());
      await act(async () => button("audio-play-btn").click());
      await act(async () => button("sim-midi-play").click());
      expect(ringBuffer.sliceWindow(0, 0)).toMatchObject([{ type: "noteon", midi: 60 }]);
      expect(button("audio-stop-btn").disabled).toBe(false);

      await act(async () => button("audio-stop-btn").click());
      await act(async () => vi.advanceTimersByTime(3_000));
      expect(ringBuffer.size()).toBe(0);
      expect(container.querySelector('[data-testid="piano-key-60"]')?.getAttribute("data-key-pressed")).not.toBe("true");
    } finally {
      window.history.replaceState(null, "", originalUrl);
      vi.useRealTimers();
    }
  });

});
