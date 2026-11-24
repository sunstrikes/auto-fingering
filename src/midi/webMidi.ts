export type MidiInputSource = "midi" | "virtual" | "qwerty";

export type MidiInputEvent = {
  /** Monotonic milliseconds in the performance.now() time domain, when provided by the input. */
  timeStampMs?: number;
} & (
  | {
      type: "noteon";
      midi: number;
      velocity: number;
      channel: number;
      portId: string;
      source: MidiInputSource;
    }
  | {
      type: "noteoff";
      midi: number;
      velocity: 0;
      channel: number;
      portId: string;
      source: MidiInputSource;
    }
  | {
      type: "sustain";
      value: number;
      pressed: boolean;
      channel: number;
      portId: string;
      source: MidiInputSource;
    });

export interface MIDIMessageEventLike {
  data: Uint8Array | number[] | null;
  timeStamp?: number;
}

export interface MIDIInputLike {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  state?: "connected" | "disconnected" | string;
  onmidimessage: ((event: MIDIMessageEventLike) => void) | null;
}

export interface MIDIConnectionEventLike {
  port?: MIDIInputLike | { id?: string; type?: string; state?: string } | null;
}

export interface MIDIAccessLike {
  inputs: {
    values(): IterableIterator<MIDIInputLike>;
  };
  onstatechange: ((event: MIDIConnectionEventLike) => void) | null;
}

export interface MidiDeviceInfo {
  id: string;
  name: string;
  manufacturer: string;
  state: string;
}

export type MidiConnectionStatus =
  | "unsupported"
  | "requesting"
  | "no-devices"
  | "connected"
  | "denied"
  | "error";

export interface MidiConnectionState {
  status: MidiConnectionStatus;
  devices: MidiDeviceInfo[];
  selectedDeviceId: string | null;
  errorMessage: string | null;
}

export interface WebMidiControllerDeps {
  requestMIDIAccess?: () => Promise<MIDIAccessLike>;
  onStateChange: (state: MidiConnectionState) => void;
  onMidiEvent: (event: MidiInputEvent) => void;
}

export interface WebMidiController {
  connect(): Promise<void>;
  setSelectedDeviceId(deviceId: string | null): void;
  getState(): MidiConnectionState;
  dispose(): void;
}

/**
 * Standard 2-octave QWERTY computer-keyboard to MIDI pitch mapping
 * (Z–M / , for C4–C5, Q–I / 2–7 for C5–C6).
 */
export const QWERTY_TO_MIDI: Readonly<Record<string, number>> = {
  z: 60, // C4
  s: 61, // C#4
  x: 62, // D4
  d: 63, // D#4
  c: 64, // E4
  v: 65, // F4
  g: 66, // F#4
  b: 67, // G4
  h: 68, // G#4
  n: 69, // A4
  j: 70, // A#4
  m: 71, // B4
  ",": 72, // C5
  q: 72, // C5
  "2": 73, // C#5
  w: 74, // D5
  "3": 75, // D#5
  e: 76, // E5
  r: 77, // F5
  "5": 78, // F#5
  t: 79, // G5
  "6": 80, // G#5
  y: 81, // A5
  "7": 82, // A#5
  u: 83, // B5
  i: 84, // C6
};

/**
 * Normalizes a raw Web MIDI packet into NoteOn, NoteOff, or Sustain (CC 64).
 */
export function parseMidiMessage(
  data: Uint8Array | number[] | null | undefined,
  portId: string,
  source: MidiInputSource = "midi",
  timeStampMs?: number,
): MidiInputEvent | null {
  if (!data || data.length < 2) return null;
  const status = data[0];
  const data1 = data[1];
  const data2 = data.length >= 3 ? data[2] : 0;

  // Ignore system realtime / sysex messages (>= 0xf0)
  if (status >= 0xf0) return null;

  const command = status & 0xf0;
  const channel = status & 0x0f;
  const context = {
    channel, portId, source,
    ...(timeStampMs !== undefined && Number.isFinite(timeStampMs) ? { timeStampMs } : {}),
  };

  if (command === 0x90) {
    if (data2 > 0) {
      return {
        type: "noteon",
        midi: data1,
        velocity: data2,
        ...context,
      };
    }
    return {
      type: "noteoff",
      midi: data1,
      velocity: 0,
      ...context,
    };
  }

  if (command === 0x80) {
    return {
      type: "noteoff",
      midi: data1,
      velocity: 0,
      ...context,
    };
  }

  if (command === 0xb0 && data1 === 64) {
    return {
      type: "sustain",
      value: data2,
      pressed: data2 >= 64,
      ...context,
    };
  }

  return null;
}

export function getDefaultRequestMIDIAccess():
  | (() => Promise<MIDIAccessLike>)
  | undefined {
  if (
    typeof navigator !== "undefined" &&
    typeof (navigator as unknown as { requestMIDIAccess?: unknown }).requestMIDIAccess === "function"
  ) {
    return () =>
      (navigator as unknown as { requestMIDIAccess: () => Promise<MIDIAccessLike> }).requestMIDIAccess();
  }
  return undefined;
}

export function createWebMidiController(deps: WebMidiControllerDeps): WebMidiController {
  let disposed = false;
  let midiAccess: MIDIAccessLike | null = null;
  const boundInputs = new Set<MIDIInputLike>();

  let state: MidiConnectionState = {
    status: deps.requestMIDIAccess ? "requesting" : "unsupported",
    devices: [],
    selectedDeviceId: null,
    errorMessage: null,
  };

  const emitState = (next: MidiConnectionState) => {
    state = next;
    if (!disposed) {
      deps.onStateChange(state);
    }
  };

  const detachAllInputs = () => {
    for (const input of boundInputs) {
      input.onmidimessage = null;
    }
    boundInputs.clear();
  };

  const syncInputs = () => {
    if (!midiAccess || disposed) return;
    detachAllInputs();

    const devices: MidiDeviceInfo[] = [];
    for (const input of midiAccess.inputs.values()) {
      if (input.state === "disconnected") continue;
      const deviceInfo: MidiDeviceInfo = {
        id: input.id,
        name: input.name?.trim() || `MIDI Input (${input.id})`,
        manufacturer: input.manufacturer?.trim() || "",
        state: input.state ?? "connected",
      };
      devices.push(deviceInfo);

      input.onmidimessage = (msgEvent) => {
        if (disposed) return;
        if (state.selectedDeviceId !== null && state.selectedDeviceId !== input.id) {
          return;
        }
        const parsed = parseMidiMessage(msgEvent.data, input.id, "midi", msgEvent.timeStamp);
        if (parsed) deps.onMidiEvent(parsed);
      };
      boundInputs.add(input);
    }

    const nextSelectedId =
      state.selectedDeviceId !== null && devices.some((d) => d.id === state.selectedDeviceId)
        ? state.selectedDeviceId
        : null;

    emitState({
      status: devices.length > 0 ? "connected" : "no-devices",
      devices,
      selectedDeviceId: nextSelectedId,
      errorMessage: null,
    });
  };

  return {
    async connect() {
      if (disposed) return;
      if (!deps.requestMIDIAccess) {
        emitState({
          status: "unsupported",
          devices: [],
          selectedDeviceId: null,
          errorMessage: "Web MIDI API is not available in this browser or context.",
        });
        return;
      }

      emitState({
        ...state,
        status: "requesting",
        errorMessage: null,
      });

      try {
        const access = await deps.requestMIDIAccess();
        if (disposed) return;
        midiAccess = access;
        midiAccess.onstatechange = () => {
          syncInputs();
        };
        syncInputs();
      } catch (err) {
        if (disposed) return;
        const name = err instanceof Error ? err.name : "";
        const message = err instanceof Error ? err.message : String(err);
        const isDenied = name === "SecurityError" || name === "NotAllowedError";
        emitState({
          status: isDenied ? "denied" : "error",
          devices: [],
          selectedDeviceId: null,
          errorMessage: message || "Failed to access MIDI devices.",
        });
      }
    },

    setSelectedDeviceId(deviceId: string | null) {
      const normalized = deviceId === "all" || deviceId === "" ? null : deviceId;
      emitState({
        ...state,
        selectedDeviceId: normalized,
      });
    },

    getState() {
      return state;
    },

    dispose() {
      disposed = true;
      detachAllInputs();
      if (midiAccess) {
        midiAccess.onstatechange = null;
        midiAccess = null;
      }
    },
  };
}
