import { createMidiRingBuffer } from "./midiRingBuffer";
import type { MidiInputEvent } from "./webMidi";

/** A paused transport is still the same bout: its first matching strike can resume it. */
export function createMidiSessionCapture(now = () => performance.now()) {
  const buffer = createMidiRingBuffer();
  let active = false;
  return {
    setTransport(state: "stopped" | "playing" | "paused", hasScore: boolean) {
      const next = hasScore && state !== "stopped";
      if (active && !next) buffer.clear();
      active = next;
    },
    record(event: MidiInputEvent) {
      if (!active) return;
      buffer.push(event.source !== "midi" && event.timeStampMs === undefined
        ? { ...event, timeStampMs: now() } : event);
    },
    sliceWindow: buffer.sliceWindow,
  };
}
