import type {
  RawMidiData,
  RawMidiKeySig,
  RawMidiNote,
  RawMidiPedalEvent,
  RawMidiTempo,
  RawMidiTimeSig,
} from "./types";

function toUint8Array(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function readUint24BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function readInt8(byte: number): number {
  return byte >= 128 ? byte - 256 : byte;
}

function readVlq(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let pos = offset;
  while (pos < bytes.length) {
    const b = bytes[pos++];
    value = (value << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return [value, pos];
}

interface OpenNoteOn {
  startTick: number;
  velocity: number;
}

/**
 * Parses a Standard MIDI File (SMF) buffer into a non-destructive raw MIDI truth layer.
 * Preserves exact onset ticks, durations, velocities, track/channel metadata,
 * simultaneous same-pitch NoteOn overlaps via per-(track, channel, pitch) FIFO queues,
 * and all tempo, key signature, time signature, and CC64 sustain pedal events.
 */
export function parseRawMidi(midiBuffer: ArrayBuffer | Uint8Array): RawMidiData {
  const bytes = toUint8Array(midiBuffer);
  if (bytes.length < 14 || readAscii(bytes, 0, 4) !== "MThd") {
    throw new Error("Invalid MIDI file: missing MThd header");
  }

  const headerLen = readUint32BE(bytes, 4);
  if (headerLen < 6) {
    throw new Error(`Invalid MIDI header length: ${headerLen}`);
  }

  const format = readUint16BE(bytes, 8);
  const trackCount = readUint16BE(bytes, 10);
  const division = readUint16BE(bytes, 12);
  if ((division & 0x8000) !== 0) {
    throw new Error("Unsupported SMPTE MIDI time division");
  }
  const ppq = division;

  const trackChunks: Uint8Array[] = [];
  let offset = 8 + headerLen;
  while (offset + 8 <= bytes.length && readAscii(bytes, offset, 4) === "MTrk") {
    const len = readUint32BE(bytes, offset + 4);
    const start = offset + 8;
    const end = Math.min(bytes.length, start + len);
    trackChunks.push(bytes.subarray(start, end));
    offset = start + len;
  }

  const notes: RawMidiNote[] = [];
  const tempos: RawMidiTempo[] = [];
  const timeSigs: RawMidiTimeSig[] = [];
  const keySigs: RawMidiKeySig[] = [];
  const pedals: RawMidiPedalEvent[] = [];
  const trackNames: string[] = [];

  for (let trackIdx = 0; trackIdx < trackChunks.length; trackIdx++) {
    const track = trackChunks[trackIdx];
    let pos = 0;
    let tick = 0;
    let runningStatus = 0;
    let trackName = "";

    // Per-(track, channel, pitch) FIFO queue for overlapping NoteOns
    const openQueues = new Map<string, OpenNoteOn[]>();
    // Per-(track, channel) CC64 sustain state
    const pedalDownByChannel = new Map<number, boolean>();

    while (pos < track.length) {
      const [delta, nextPos] = readVlq(track, pos);
      tick += delta;
      pos = nextPos;
      if (pos >= track.length) break;

      const peek = track[pos];

      if (peek === 0xff) {
        runningStatus = 0;
        pos++;
        if (pos >= track.length) break;
        const metaType = track[pos++];
        const [metaLen, dataStart] = readVlq(track, pos);
        const dataEnd = Math.min(track.length, dataStart + metaLen);
        const data = track.subarray(dataStart, dataEnd);
        pos = dataEnd;

        if (metaType === 0x58 && data.length >= 2) {
          timeSigs.push({
            tick,
            numerator: data[0],
            denominator: 2 ** data[1],
          });
        } else if (metaType === 0x59 && data.length >= 1) {
          keySigs.push({
            tick,
            fifths: readInt8(data[0]),
            mode: data.length >= 2 && data[1] === 1 ? "minor" : "major",
          });
        } else if (metaType === 0x51 && data.length >= 3) {
          const usPerQuarter = readUint24BE(data, 0);
          if (usPerQuarter > 0) {
            tempos.push({
              tick,
              usPerQuarter,
              bpm: 60_000_000 / usPerQuarter,
            });
          }
        } else if (metaType === 0x03 && !trackName) {
          trackName = readAscii(data, 0, data.length).trim();
        }
        continue;
      }

      if (peek === 0xf0 || peek === 0xf7) {
        runningStatus = 0;
        pos++;
        const [sysexLen, dataStart] = readVlq(track, pos);
        pos = Math.min(track.length, dataStart + sysexLen);
        continue;
      }

      if ((peek & 0x80) !== 0) {
        runningStatus = peek;
        pos++;
      }

      if (runningStatus === 0) {
        pos++;
        continue;
      }

      const eventType = runningStatus & 0xf0;
      const channel = runningStatus & 0x0f;

      if (eventType === 0x90 || eventType === 0x80) {
        if (pos + 1 >= track.length) break;
        const pitch = track[pos];
        const velocity = track[pos + 1];
        pos += 2;
        const queueKey = `${channel}:${pitch}`;

        if (eventType === 0x90 && velocity > 0) {
          let queue = openQueues.get(queueKey);
          if (!queue) {
            queue = [];
            openQueues.set(queueKey, queue);
          }
          queue.push({ startTick: tick, velocity });
        } else {
          const queue = openQueues.get(queueKey);
          const open = queue?.shift();
          if (open && tick > open.startTick) {
            notes.push({
              pitch,
              startTick: open.startTick,
              endTick: tick,
              durationTick: tick - open.startTick,
              velocity: open.velocity,
              track: trackIdx,
              channel,
            });
          }
        }
      } else if (eventType === 0xb0) {
        if (pos + 1 >= track.length) break;
        const controller = track[pos];
        const value = track[pos + 1];
        pos += 2;
        if (controller === 64) {
          const wasDown = pedalDownByChannel.get(channel) ?? false;
          const isDown = value >= 64;
          if (!wasDown && isDown) {
            pedalDownByChannel.set(channel, true);
            pedals.push({ tick, type: "start", value, track: trackIdx, channel });
          } else if (wasDown && isDown) {
            pedals.push({ tick, type: "change", value, track: trackIdx, channel });
          } else if (wasDown && !isDown) {
            pedalDownByChannel.set(channel, false);
            pedals.push({ tick, type: "stop", value, track: trackIdx, channel });
          }
        }
      } else if (eventType === 0xa0 || eventType === 0xe0) {
        pos += 2;
      } else if (eventType === 0xc0 || eventType === 0xd0) {
        pos += 1;
      } else {
        pos += 1;
      }
    }

    trackNames.push(trackName);
  }

  notes.sort(
    (a, b) =>
      a.startTick - b.startTick ||
      a.pitch - b.pitch ||
      a.track - b.track ||
      a.channel - b.channel
  );
  tempos.sort((a, b) => a.tick - b.tick);
  timeSigs.sort((a, b) => a.tick - b.tick);
  keySigs.sort((a, b) => a.tick - b.tick);
  pedals.sort((a, b) => a.tick - b.tick);

  return {
    format,
    trackCount: trackChunks.length || trackCount,
    ppq,
    trackNames,
    notes,
    tempos,
    timeSigs,
    keySigs,
    pedals,
  };
}
