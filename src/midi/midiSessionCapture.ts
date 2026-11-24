import { createMidiRingBuffer } from "./midiRingBuffer";
import type { MidiInputEvent } from "./webMidi";

type CaptureMode = "continuous" | "waiting";
type ActiveTransport = "playing" | "paused";
type CaptureContext = { mode: CaptureMode; transport: ActiveTransport };

/** A paused transport is still the same bout, but never contributes to a playing window. */
export function createMidiSessionCapture(now = () => performance.now()) {
  const buffer = createMidiRingBuffer<MidiInputEvent & CaptureContext>();
  let mode: CaptureMode = "continuous";
  let transport: ActiveTransport | undefined;
  return {
    setMode(next: CaptureMode) {
      mode = next;
    },
    setTransport(state: "stopped" | ActiveTransport, hasScore: boolean) {
      const next = hasScore && state !== "stopped" ? state : undefined;
      if (transport && !next) buffer.clear();
      transport = next;
    },
    record(event: MidiInputEvent) {
      if (!transport) return;
      const timeStampMs = event.timeStampMs ?? (event.source === "midi" ? undefined : now());
      buffer.push({ ...event, timeStampMs, mode, transport });
    },
    /** A caller must choose a mode; paused telemetry requires an explicit opt-in. */
    sliceWindow(fromMs: number, toMs: number, { mode, transport = "playing" }: {
      mode: CaptureMode; transport?: ActiveTransport;
    }) {
      return buffer.sliceWindow(fromMs, toMs)
        .filter((packet) => packet.mode === mode && packet.transport === transport)
        .map(({ mode: _mode, transport: _transport, ...packet }) => packet);
    },
  };
}
