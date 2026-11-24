import type { MIDIAccessLike, MIDIInputLike } from "./webMidi";

export interface SimulatedMidiStep {
  stepIndex: number;
  /** Offset into the requested score excerpt, at the score's native tempo. */
  onsetMs: number;
  notes: readonly { midi: number; hand: "LH" | "RH"; durationMs?: number }[];
}

export interface SimulatedPerformanceProfile {
  speedMultiplier: number;
  baseVelocityRh?: number;
  baseVelocityLh?: number;
  velocityJitter?: number;
  timingJitterMs?: number;
  /** Optional receive-time quantization; packets in a BLE burst share a timestamp. */
  bleBurstIntervalMs?: number;
  entryLatencyMs?: number;
  wrongNoteAtSteps?: Readonly<Record<number, number>>;
  missedStepIndices?: readonly number[];
  hesitationAtSteps?: Readonly<Record<number, number>>;
  /** Pedal offsets in milliseconds after entry latency (not multiplied by score speed). */
  sustainEvents?: readonly { offsetMs: number; value: number }[];
  switchBranchOverrideMidis?: readonly { stepIndex: number; midis: readonly number[] }[];
}

interface MidiPacket {
  offsetMs: number;
  data: [status: number, data1: number, data2: number];
}

const TIMING_VARIATIONS = [0, 0.5, -0.5, 1, -1, 0.25, -0.25];
const VELOCITY_VARIATIONS = [0, -1, 1, -0.5, 0.5, -0.75, 0.75, -0.25, 0.25];

function planPerformance(steps: readonly SimulatedMidiStep[], profile: SimulatedPerformanceProfile): MidiPacket[] {
  const packets: MidiPacket[] = [];
  const speed = profile.speedMultiplier > 0 ? profile.speedMultiplier : 1;
  const entryLatencyMs = Math.max(0, profile.entryLatencyMs ?? 0);
  const timingJitterMs = Math.max(0, profile.timingJitterMs ?? 0);
  const missedSteps = new Set(profile.missedStepIndices);
  const branchOverrides = new Map(profile.switchBranchOverrideMidis?.map(({ stepIndex, midis }) => [stepIndex, midis]));
  const strikes = { RH: 0, LH: 0 };
  let timingIndex = 0;
  let hesitationMs = 0;

  function addNote(midi: number, hand: "LH" | "RH", offsetMs: number, durationMs: number) {
    if (!Number.isInteger(midi) || midi < 0 || midi > 127) return;
    const variation = VELOCITY_VARIATIONS[strikes[hand]++ % VELOCITY_VARIATIONS.length];
    const base = hand === "RH" ? profile.baseVelocityRh ?? 86 : profile.baseVelocityLh ?? 64;
    const velocity = Math.max(1, Math.min(127, Math.round(base + variation * (profile.velocityJitter ?? 6))));
    packets.push(
      { offsetMs, data: [0x90, midi, velocity] },
      { offsetMs: offsetMs + Math.max(1, durationMs), data: [0x80, midi, 0] }
    );
  }

  for (const step of steps) {
    hesitationMs += Math.max(0, profile.hesitationAtSteps?.[step.stepIndex] ?? 0);
    if (missedSteps.has(step.stepIndex)) continue;
    const offsetMs = entryLatencyMs + step.onsetMs / speed + hesitationMs;
    const wrongNote = profile.wrongNoteAtSteps?.[step.stepIndex];
    if (wrongNote !== undefined) {
      addNote(wrongNote, "RH", Math.max(entryLatencyMs, offsetMs - timingJitterMs), 70);
    }
    const overridden = branchOverrides.get(step.stepIndex);
    const noteCount = overridden?.length ?? step.notes.length;
    for (let i = 0; i < noteCount; i++) {
      const { hand = "RH", durationMs = 90 } = step.notes[i] ?? {};
      const variation = TIMING_VARIATIONS[timingIndex++ % TIMING_VARIATIONS.length];
      addNote(
        overridden?.[i] ?? step.notes[i].midi,
        hand,
        Math.max(entryLatencyMs, offsetMs + variation * timingJitterMs),
        durationMs / speed
      );
    }
  }
  for (const { offsetMs, value } of profile.sustainEvents ?? []) {
    packets.push({
      offsetMs: entryLatencyMs + Math.max(0, offsetMs),
      data: [0xb0, 64, Math.max(0, Math.min(127, Math.round(value)))],
    });
  }
  // Keep the original strike/release ordering when BLE quantization makes times equal.
  packets.sort((a, b) => a.offsetMs - b.offsetMs);
  const burstMs = profile.bleBurstIntervalMs;
  if (burstMs !== undefined && Number.isFinite(burstMs) && burstMs > 0) {
    for (const packet of packets) {
      packet.offsetMs = entryLatencyMs + Math.ceil((packet.offsetMs - entryLatencyMs) / burstMs) * burstMs;
    }
  }
  return packets;
}

const COMMAND_MIDIS = { a0: [21], b0: [23], c8: [108], pause: [21, 22] } as const;
export type SimulatedPianoCommand = keyof typeof COMMAND_MIDIS;

export interface SimulatedMidiHarness {
  requestMIDIAccess(): Promise<MIDIAccessLike>;
  play(steps: readonly SimulatedMidiStep[], profile?: SimulatedPerformanceProfile): void;
  stop(): void;
  strike(midi: number): void;
  sendCommand(command: SimulatedPianoCommand): void;
}

export function createSimulatedMidiHarness(): SimulatedMidiHarness {
  const input: MIDIInputLike = {
    id: "simulated-midi",
    name: "Simulated MIDI",
    state: "connected",
    onmidimessage: null,
  };
  const access: MIDIAccessLike = { inputs: new Map([[input.id, input]]), onstatechange: null };
  let queue: { timeStamp: number; data: MidiPacket["data"] }[] = [];
  let next = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = new Set<number>();
  let pedalValue = 0;

  function emit(data: MidiPacket["data"], timeStamp: number) {
    const [status, key, value] = data;
    if (status === 0x90) active.add(key);
    if (status === 0x80) active.delete(key);
    if (status === 0xb0) pedalValue = value;
    input.onmidimessage?.({ data: new Uint8Array(data), timeStamp });
  }

  function stop() {
    clearTimeout(timer);
    timer = undefined;
    queue = [];
    next = 0;
    const timeStamp = performance.now();
    for (const midi of active) emit([0x80, midi, 0], timeStamp);
    if (pedalValue !== 0) emit([0xb0, 64, 0], timeStamp);
  }

  function pump() {
    timer = undefined;
    const nowMs = performance.now();
    while (next < queue.length) {
      const { timeStamp, data } = queue[next];
      if (timeStamp > nowMs) {
        timer = setTimeout(pump, Math.min(2_147_483_647, Math.ceil(timeStamp - nowMs)));
        return;
      }
      next++;
      emit(data, timeStamp);
    }
    queue = [];
    next = 0;
  }

  function schedule(packets: MidiPacket[]) {
    clearTimeout(timer);
    const startMs = performance.now();
    const upcoming = packets
      .map(({ offsetMs, data }) => ({ timeStamp: startMs + offsetMs, data }))
      .filter(({ timeStamp }) => Number.isFinite(timeStamp));
    queue = queue.slice(next).concat(upcoming);
    queue.sort((a, b) => a.timeStamp - b.timeStamp);
    next = 0;
    pump();
  }

  function strikeNotes(midis: readonly number[]) {
    const packets: MidiPacket[] = [];
    for (const midi of midis) {
      if (!Number.isInteger(midi) || midi < 0 || midi > 127) continue;
      packets.push(
        { offsetMs: 0, data: [0x90, midi, 86] },
        { offsetMs: 85, data: [0x80, midi, 0] }
      );
    }
    schedule(packets);
  }

  return {
    requestMIDIAccess: async () => access,
    play(steps, profile = { speedMultiplier: 1 }) {
      stop();
      schedule(planPerformance(steps, profile));
    },
    stop,
    strike(midi) {
      strikeNotes([midi]);
    },
    sendCommand(command) {
      strikeNotes(COMMAND_MIDIS[command]);
    },
  };
}
