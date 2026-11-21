import type {
  BuildAttributes,
  BuildMeasure,
  BuildNote,
  BuildPitch,
  ConversionOptions,
  NoteTypeName,
  RawMidiData,
  RawMidiKeySig,
  RawMidiNote,
  RawMidiTimeSig,
  ScoreBuildModel,
} from "./types";

export interface MeasureSpan {
  index: number;
  number: string;
  implicit: boolean;
  startTick: number;
  endTick: number;
  duration: number;
  numerator: number;
  denominator: number;
}

interface NoteSegment {
  pitch: number;
  startTick: number;
  endTick: number;
  staff: 1 | 2;
  tieStart: boolean;
  tieStop: boolean;
}

const DURATION_TABLE: Array<{ quarters: number; type: NoteTypeName; dots: number }> = [
  { quarters: 4, type: "whole", dots: 0 },
  { quarters: 3, type: "half", dots: 1 },
  { quarters: 2, type: "half", dots: 0 },
  { quarters: 1.5, type: "quarter", dots: 1 },
  { quarters: 1, type: "quarter", dots: 0 },
  { quarters: 0.75, type: "eighth", dots: 1 },
  { quarters: 0.5, type: "eighth", dots: 0 },
  { quarters: 0.375, type: "16th", dots: 1 },
  { quarters: 0.25, type: "16th", dots: 0 },
  { quarters: 0.1875, type: "32nd", dots: 1 },
  { quarters: 0.125, type: "32nd", dots: 0 },
  { quarters: 0.0625, type: "64th", dots: 0 },
];

export function durationToTypeAndDots(
  durationTicks: number,
  ppq: number
): { type: NoteTypeName; dots: number } {
  const q = durationTicks / ppq;
  let best = DURATION_TABLE[DURATION_TABLE.length - 1];
  let bestDiff = Infinity;
  for (const entry of DURATION_TABLE) {
    const diff = Math.abs(entry.quarters - q);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = entry;
    }
  }
  return { type: best.type, dots: best.dots };
}

const SHARP_SPELLINGS: Array<{ step: BuildPitch["step"]; alter: number }> = [
  { step: "C", alter: 0 },
  { step: "C", alter: 1 },
  { step: "D", alter: 0 },
  { step: "D", alter: 1 },
  { step: "E", alter: 0 },
  { step: "F", alter: 0 },
  { step: "F", alter: 1 },
  { step: "G", alter: 0 },
  { step: "G", alter: 1 },
  { step: "A", alter: 0 },
  { step: "A", alter: 1 },
  { step: "B", alter: 0 },
];

const FLAT_SPELLINGS: Array<{ step: BuildPitch["step"]; alter: number }> = [
  { step: "C", alter: 0 },
  { step: "D", alter: -1 },
  { step: "D", alter: 0 },
  { step: "E", alter: -1 },
  { step: "E", alter: 0 },
  { step: "F", alter: 0 },
  { step: "G", alter: -1 },
  { step: "G", alter: 0 },
  { step: "A", alter: -1 },
  { step: "A", alter: 0 },
  { step: "B", alter: -1 },
  { step: "B", alter: 0 },
];

function midiToBuildPitch(midi: number, fifths: number): BuildPitch {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const table = fifths < 0 ? FLAT_SPELLINGS : SHARP_SPELLINGS;
  const chosen = table[pc];
  return {
    step: chosen.step,
    alter: chosen.alter !== 0 ? chosen.alter : undefined,
    octave,
  };
}

export function activeTimeSigAt(timeSigs: RawMidiTimeSig[], tick: number): RawMidiTimeSig {
  let active: RawMidiTimeSig = { tick: 0, numerator: 4, denominator: 4 };
  for (const ts of timeSigs) {
    if (ts.tick <= tick) {
      active = ts;
    } else {
      break;
    }
  }
  return active;
}

export function activeKeySigAt(keySigs: RawMidiKeySig[], tick: number): RawMidiKeySig {
  let active: RawMidiKeySig = { tick: 0, fifths: 0, mode: "major" };
  for (const ks of keySigs) {
    if (ks.tick <= tick) {
      active = ks;
    } else {
      break;
    }
  }
  return active;
}

export function buildMeasureSpans(
  rawMidi: RawMidiData,
  options?: ConversionOptions
): MeasureSpan[] {
  const ppq = rawMidi.ppq;
  const timeSigs =
    rawMidi.timeSigs.length > 0
      ? rawMidi.timeSigs
      : [{ tick: 0, numerator: 4, denominator: 4 }];

  let maxTick = 0;
  for (const n of rawMidi.notes) maxTick = Math.max(maxTick, n.endTick);
  for (const p of rawMidi.pedals) maxTick = Math.max(maxTick, p.tick);
  for (const t of rawMidi.tempos) maxTick = Math.max(maxTick, t.tick);
  for (const ts of timeSigs) maxTick = Math.max(maxTick, ts.tick);
  if (maxTick === 0) {
    const ts0 = activeTimeSigAt(timeSigs, 0);
    maxTick = Math.round((ts0.numerator * 4 * ppq) / ts0.denominator);
  }

  const spans: MeasureSpan[] = [];
  let cursor = 0;
  let measureNum = 1;

  // Detect pickup measure: explicit option OR timeSig change before first full measure
  const firstTs = activeTimeSigAt(timeSigs, 0);
  const firstNominal = Math.round((firstTs.numerator * 4 * ppq) / firstTs.denominator);
  const earlyTs = timeSigs.find((ts) => ts.tick > 0 && ts.tick < firstNominal);
  const pickupEnd =
    options?.pickupTicks && options.pickupTicks > 0 && options.pickupTicks < firstNominal
      ? options.pickupTicks
      : earlyTs
        ? earlyTs.tick
        : 0;

  if (pickupEnd > 0) {
    spans.push({
      index: 0,
      number: "0",
      implicit: true,
      startTick: 0,
      endTick: pickupEnd,
      duration: pickupEnd,
      numerator: firstTs.numerator,
      denominator: firstTs.denominator,
    });
    cursor = pickupEnd;
  }

  while (cursor < maxTick) {
    const ts = activeTimeSigAt(timeSigs, cursor);
    const nominal = Math.max(1, Math.round((ts.numerator * 4 * ppq) / ts.denominator));
    const nextTs = timeSigs.find((t) => t.tick > cursor && t.tick < cursor + nominal);
    const endTick = nextTs ? nextTs.tick : cursor + nominal;
    const dur = endTick - cursor;
    spans.push({
      index: spans.length,
      number: String(measureNum++),
      implicit: dur < nominal && spans.length === 0,
      startTick: cursor,
      endTick,
      duration: dur,
      numerator: ts.numerator,
      denominator: ts.denominator,
    });
    cursor = endTick;
  }

  return spans;
}

function assignStaffByTrack(rawMidi: RawMidiData, splitPitch: number): (note: RawMidiNote) => 1 | 2 {
  const tracksWithNotes = new Set(rawMidi.notes.map((n) => n.track));
  if (tracksWithNotes.size >= 2) {
    const staffByTrack = new Map<number, 1 | 2>();
    const avgByTrack: Array<{ track: number; avg: number }> = [];
    for (const track of tracksWithNotes) {
      const name = rawMidi.trackNames[track] ?? "";
      if (/left|lh|bass/i.test(name)) {
        staffByTrack.set(track, 2);
      } else if (/right|rh|treble/i.test(name)) {
        staffByTrack.set(track, 1);
      } else {
        const trackNotes = rawMidi.notes.filter((n) => n.track === track);
        const avg = trackNotes.reduce((sum, n) => sum + n.pitch, 0) / trackNotes.length;
        avgByTrack.push({ track, avg });
      }
    }
    if (avgByTrack.length >= 2) {
      avgByTrack.sort((a, b) => b.avg - a.avg);
      staffByTrack.set(avgByTrack[0].track, 1);
      for (let i = 1; i < avgByTrack.length; i++) {
        staffByTrack.set(avgByTrack[i].track, 2);
      }
    }
    if (staffByTrack.size >= 2) {
      return (note) => staffByTrack.get(note.track) ?? (note.pitch >= splitPitch ? 1 : 2);
    }
  }
  return (note) => (note.pitch >= splitPitch ? 1 : 2);
}

function buildStaffVoicesForMeasure(
  segments: NoteSegment[],
  measureStart: number,
  measureDuration: number,
  staff: 1 | 2,
  ppq: number,
  fifths: number
): BuildNote[] {
  const baseVoice = staff === 1 ? 1 : 5;
  if (segments.length === 0) {
    return [
      {
        kind: "rest",
        onsetOffset: 0,
        duration: measureDuration,
        voice: String(baseVoice),
        staff,
        measureRest: true,
      },
    ];
  }

  // Group simultaneous notes with identical (startTick, endTick) into chords
  const sorted = [...segments].sort(
    (a, b) => a.startTick - b.startTick || a.endTick - b.endTick || a.pitch - b.pitch
  );
  const groups: NoteSegment[][] = [];
  for (const seg of sorted) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last[0].startTick === seg.startTick &&
      last[0].endTick === seg.endTick
    ) {
      last.push(seg);
    } else {
      groups.push([seg]);
    }
  }

  // Greedy voice allocation (up to 4 voices per staff)
  const voices: Array<{ endTick: number; groups: NoteSegment[][] }> = [];
  for (const group of groups) {
    const segStart = group[0].startTick;
    let placed = false;
    for (const v of voices) {
      if (v.endTick <= segStart) {
        v.groups.push(group);
        v.endTick = group[0].endTick;
        placed = true;
        break;
      }
    }
    if (!placed) {
      if (voices.length < 4) {
        voices.push({ endTick: group[0].endTick, groups: [group] });
      } else {
        // Fallback: attach to earliest-ending voice
        let best = voices[0];
        for (const v of voices) {
          if (v.endTick < best.endTick) best = v;
        }
        best.groups.push(group);
        best.endTick = Math.max(best.endTick, group[0].endTick);
      }
    }
  }

  const out: BuildNote[] = [];
  for (let vIdx = 0; vIdx < voices.length; vIdx++) {
    const voiceId = String(baseVoice + vIdx);
    let cursor = measureStart;
    for (const group of voices[vIdx].groups) {
      const segStart = group[0].startTick;
      const segEnd = group[0].endTick;
      if (segStart > cursor) {
        const gap = segStart - cursor;
        const { type, dots } = durationToTypeAndDots(gap, ppq);
        out.push({
          kind: "rest",
          onsetOffset: cursor - measureStart,
          duration: gap,
          voice: voiceId,
          staff,
          type,
          dots,
        });
        cursor = segStart;
      }
      const dur = Math.max(1, segEnd - Math.max(segStart, cursor));
      const { type, dots } = durationToTypeAndDots(dur, ppq);
      group.forEach((seg, idx) => {
        out.push({
          kind: "note",
          onsetOffset: cursor - measureStart,
          isChord: idx > 0,
          pitch: midiToBuildPitch(seg.pitch, fifths),
          duration: dur,
          voice: voiceId,
          staff,
          type,
          dots,
          tieStart: seg.tieStart,
          tieStop: seg.tieStop,
        });
      });
      cursor += dur;
    }
    const measureEnd = measureStart + measureDuration;
    if (cursor < measureEnd) {
      const gap = measureEnd - cursor;
      const { type, dots } = durationToTypeAndDots(gap, ppq);
      out.push({
        kind: "rest",
        onsetOffset: cursor - measureStart,
        duration: gap,
        voice: voiceId,
        staff,
        type,
        dots,
      });
    }
  }

  return out;
}

/**
 * Converts a non-destructive `RawMidiData` into a `ScoreBuildModel` for the unified MusicXML 4.0 builder.
 */
export function rawMidiToScoreModel(
  rawMidi: RawMidiData,
  options?: ConversionOptions
): ScoreBuildModel {
  const ppq = rawMidi.ppq;
  const splitPitch = options?.splitPitch ?? 60;
  const spans = buildMeasureSpans(rawMidi, options);
  const staffOf = assignStaffByTrack(rawMidi, splitPitch);

  const segmentsByMeasure = spans.map(() => ({
    1: [] as NoteSegment[],
    2: [] as NoteSegment[],
  }));

  for (const note of rawMidi.notes) {
    const staff = staffOf(note);
    for (let mIdx = 0; mIdx < spans.length; mIdx++) {
      const m = spans[mIdx];
      if (note.endTick <= m.startTick) break;
      if (note.startTick >= m.endTick) continue;
      const segStart = Math.max(note.startTick, m.startTick);
      const segEnd = Math.min(note.endTick, m.endTick);
      if (segEnd > segStart) {
        segmentsByMeasure[mIdx][staff].push({
          pitch: note.pitch,
          startTick: segStart,
          endTick: segEnd,
          staff,
          tieStart: segEnd < note.endTick,
          tieStop: segStart > note.startTick,
        });
      }
    }
  }

  const tempos =
    rawMidi.tempos.length > 0
      ? rawMidi.tempos
      : [{ tick: 0, usPerQuarter: 500_000, bpm: 120 }];

  const measures: BuildMeasure[] = [];
  let prevKeySig: RawMidiKeySig | null = null;
  let prevTimeSig: { numerator: number; denominator: number } | null = null;

  for (let mIdx = 0; mIdx < spans.length; mIdx++) {
    const m = spans[mIdx];
    const ks = activeKeySigAt(rawMidi.keySigs, m.startTick);

    let attributes: BuildAttributes | undefined;
    const keyChanged =
      !prevKeySig || prevKeySig.fifths !== ks.fifths || prevKeySig.mode !== ks.mode;
    const timeChanged =
      !prevTimeSig ||
      prevTimeSig.numerator !== m.numerator ||
      prevTimeSig.denominator !== m.denominator;

    if (mIdx === 0 || keyChanged || timeChanged) {
      attributes = {};
      if (mIdx === 0) {
        attributes.divisions = ppq;
        attributes.staves = 2;
      }
      if (mIdx === 0 || keyChanged) {
        attributes.fifths = ks.fifths;
        attributes.mode = ks.mode;
      }
      if (mIdx === 0 || timeChanged) {
        attributes.beats = m.numerator;
        attributes.beatType = m.denominator;
      }
    }
    prevKeySig = ks;
    prevTimeSig = { numerator: m.numerator, denominator: m.denominator };

    const measureTempos = tempos
      .filter((t) =>
        mIdx === spans.length - 1
          ? t.tick >= m.startTick && t.tick <= m.endTick
          : t.tick >= m.startTick && t.tick < m.endTick
      )
      .map((t) => ({
        tickOffset: Math.max(0, Math.min(m.duration, t.tick - m.startTick)),
        bpm: t.bpm,
      }));

    const measurePedals = rawMidi.pedals
      .filter((p) =>
        mIdx === spans.length - 1
          ? p.tick >= m.startTick && p.tick <= m.endTick
          : p.tick >= m.startTick && p.tick < m.endTick
      )
      .map((p) => ({
        tickOffset: Math.max(0, Math.min(m.duration, p.tick - m.startTick)),
        type: p.type,
        staff: 2 as const,
      }));

    const rhNotes = buildStaffVoicesForMeasure(
      segmentsByMeasure[mIdx][1],
      m.startTick,
      m.duration,
      1,
      ppq,
      ks.fifths
    );
    const lhNotes = buildStaffVoicesForMeasure(
      segmentsByMeasure[mIdx][2],
      m.startTick,
      m.duration,
      2,
      ppq,
      ks.fifths
    );

    measures.push({
      number: m.number,
      implicit: m.implicit,
      duration: m.duration,
      attributes,
      tempos: measureTempos.length > 0 ? measureTempos : undefined,
      pedals: measurePedals.length > 0 ? measurePedals : undefined,
      notes: [...rhNotes, ...lhNotes],
    });
  }

  return {
    title: options?.title ?? "Untitled MIDI Score",
    divisions: ppq,
    staves: 2,
    measures,
  };
}
