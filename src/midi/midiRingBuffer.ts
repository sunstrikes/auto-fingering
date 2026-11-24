import type { MidiInputEvent } from "./webMidi";

export interface MidiRingBuffer<T extends MidiInputEvent = MidiInputEvent> {
  push(event: T): void;
  /** Inclusive bounds; results are in arrival order, including packets that arrived out of order. */
  sliceWindow(fromMs: number, toMs: number): T[];
  clear(): void;
  size(): number;
}

/** Fixed-capacity, session-local storage. Nothing is published or persisted on write. */
export function createMidiRingBuffer<T extends MidiInputEvent = MidiInputEvent>(capacity = 32_768): MidiRingBuffer<T> {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError("MIDI ring buffer capacity must be a positive integer");
  }
  const events = new Array<T | undefined>(capacity);
  let next = 0;
  let count = 0;

  return {
    push(event) {
      if (!Number.isFinite(event.timeStampMs)) return;
      events[next] = { ...event };
      next = (next + 1) % capacity;
      count = Math.min(count + 1, capacity);
    },
    sliceWindow(fromMs, toMs) {
      const result: T[] = [];
      const first = (next - count + capacity) % capacity;
      for (let i = 0; i < count; i++) {
        const event = events[(first + i) % capacity];
        if (event && event.timeStampMs >= fromMs && event.timeStampMs <= toMs) {
          result.push({ ...event });
        }
      }
      return result;
    },
    clear() {
      events.fill(undefined);
      next = 0;
      count = 0;
    },
    size: () => count,
  };
}
