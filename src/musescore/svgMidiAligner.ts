import {
  activeKeySigAt,
  activeTimeSigAt,
  assignStaffByTrack,
  buildMeasureSpans,
  buildStaffVoicesForMeasure,
  durationToTypeAndDots,
  type MeasureSpan,
  type NoteSegment,
} from "./midiToScoreModel";
import type {
  ParsedSvgPage,
  SvgArc,
  SvgNavMarker,
  SvgNotehead,
  SvgVolta,
} from "./svgParser";
import type {
  BuildAttributes,
  BuildMeasure,
  BuildNavMarker,
  BuildNote,
  BuildPitch,
  ConversionDiagnostic,
  ConversionOptions,
  RawMidiData,
  RawMidiNote,
  ScoreBuildModel,
} from "./types";

const DIATONIC_SEMITONES: Record<BuildPitch["step"], number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

export function diatonicToMidi(step: BuildPitch["step"], octave: number): number {
  return (octave + 1) * 12 + DIATONIC_SEMITONES[step];
}

interface SvgMeasureData {
  globalMeasureIndex: number;
  staffSpace: number;
  stavesCount: 1 | 2;
  noteheads: SvgNotehead[];
  arcs: SvgArc[];
  repeatStart?: boolean;
  repeatStop?: boolean;
  volta?: SvgVolta;
  navMarkers?: SvgNavMarker[];
}

interface VisualColumn {
  cx: number;
  noteheads: SvgNotehead[];
}

interface MidiOnsetSlice {
  startTick: number;
  notes: RawMidiNote[];
}

interface ResolvedHandVoice {
  staff: 1 | 2;
  voice: string;
}

function collectSvgMeasures(pages: ParsedSvgPage[]): {
  measures: SvgMeasureData[];
  maxStaves: 1 | 2;
} {
  const measures: SvgMeasureData[] = [];
  let maxStaves: 1 | 2 = 1;

  for (const page of pages) {
    for (const sys of page.systems) {
      if (sys.staves.length >= 2) maxStaves = 2;
      const ss = sys.staves[0]?.staffSpace ?? 80;
      const sysNotes = page.noteheads.filter((n) => n.systemIndex === sys.systemIndex);
      const sysArcs = page.arcs.filter((a) => a.systemIndex === sys.systemIndex);

      for (const m of sys.measures) {
        const mNotes = sysNotes.filter((n) => n.measureIndex === m.measureIndex);
        const mArcs = sysArcs.filter(
          (a) => a.endX >= m.minX - ss && a.startX <= m.maxX + ss
        );
        measures.push({
          globalMeasureIndex: measures.length,
          staffSpace: ss,
          stavesCount: sys.staves.length >= 2 ? 2 : 1,
          noteheads: mNotes,
          arcs: mArcs,
          repeatStart: m.repeatStart,
          repeatStop: m.repeatStop,
          volta: m.volta,
          navMarkers: m.navMarkers,
        });
      }
    }
  }

  return { measures, maxStaves };
}

function computeHandAndVoiceMap(
  noteheads: SvgNotehead[],
  staffSpace: number
): Map<number, ResolvedHandVoice> {
  const map = new Map<number, ResolvedHandVoice>();

  // 1. Determine dominant hand per beamGroupId
  const beamStats = new Map<number, { s1: number; s2: number; firstStaff: 1 | 2 }>();
  const ordered = [...noteheads].sort((a, b) => a.cx - b.cx || a.cy - b.cy);
  for (const n of ordered) {
    if (n.beamGroupId === null) continue;
    let st = beamStats.get(n.beamGroupId);
    if (!st) {
      st = { s1: 0, s2: 0, firstStaff: n.staff };
      beamStats.set(n.beamGroupId, st);
    }
    if (n.staff === 1) st.s1 += 1;
    else st.s2 += 1;
  }

  const beamVoice = new Map<number, string>();
  for (const [bgId, st] of beamStats.entries()) {
    const domStaff: 1 | 2 =
      st.s1 > st.s2 ? 1 : st.s2 > st.s1 ? 2 : st.firstStaff;
    beamVoice.set(bgId, domStaff === 1 ? "1" : "2");
  }

  // 2. Group by stemId (if present) so chord notes on the same stem share voice
  const stemNotes = new Map<number, SvgNotehead[]>();
  for (const n of ordered) {
    if (n.stemId !== null) {
      const arr = stemNotes.get(n.stemId) ?? [];
      arr.push(n);
      stemNotes.set(n.stemId, arr);
    }
  }

  // Detect same-staff simultaneous stems (polyphony) to assign voice 1/3 on staff 1, 2/4 on staff 2
  const columns: SvgNotehead[][] = [];
  for (const n of ordered) {
    const last = columns[columns.length - 1];
    if (last && Math.abs(n.cx - last[0].cx) <= staffSpace * 0.75) {
      last.push(n);
    } else {
      columns.push([n]);
    }
  }

  for (const col of columns) {
    for (const staffNum of [1, 2] as const) {
      const staffCol = col.filter((n) => n.staff === staffNum);
      if (staffCol.length === 0) continue;
      const distinctStems = Array.from(
        new Set(staffCol.map((n) => n.stemId).filter((id): id is number => id !== null))
      );

      for (const n of staffCol) {
        if (n.beamGroupId !== null && beamVoice.has(n.beamGroupId)) {
          map.set(n.id, { staff: n.staff, voice: beamVoice.get(n.beamGroupId)! });
          continue;
        }
        if (distinctStems.length >= 2) {
          // Polyphonic column: stem-up / higher pitch gets primary voice, stem-down / lower gets secondary
          const isLower = n.stemDir === "down";
          const voice =
            staffNum === 1 ? (isLower ? "3" : "1") : isLower ? "4" : "2";
          map.set(n.id, { staff: n.staff, voice });
        } else {
          map.set(n.id, { staff: n.staff, voice: staffNum === 1 ? "1" : "2" });
        }
      }
    }
  }

  return map;
}

function groupVisualColumns(noteheads: SvgNotehead[], staffSpace: number): VisualColumn[] {
  const sorted = [...noteheads].sort((a, b) => a.cx - b.cx || a.cy - b.cy);
  const cols: VisualColumn[] = [];
  for (const n of sorted) {
    const prev = cols[cols.length - 1];
    const sameStem =
      prev && n.stemId !== null && prev.noteheads.some((p) => p.stemId === n.stemId);
    const closeX = prev && Math.abs(n.cx - prev.cx) <= staffSpace * 0.65;
    if (prev && (sameStem || closeX)) {
      prev.noteheads.push(n);
      prev.cx =
        prev.noteheads.reduce((s, item) => s + item.cx, 0) / prev.noteheads.length;
    } else {
      cols.push({ cx: n.cx, noteheads: [n] });
    }
  }
  return cols;
}

function groupMidiSlices(notes: RawMidiNote[], ppq: number): MidiOnsetSlice[] {
  const sorted = [...notes].sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  const tol = Math.max(1, Math.round(ppq / 32));
  const slices: MidiOnsetSlice[] = [];
  for (const n of sorted) {
    const prev = slices[slices.length - 1];
    if (prev && Math.abs(n.startTick - prev.startTick) <= tol) {
      prev.notes.push(n);
    } else {
      slices.push({ startTick: n.startTick, notes: [n] });
    }
  }
  return slices;
}

function findIncomingArc(
  target: SvgNotehead,
  prevNotes: SvgNotehead[],
  arcs: SvgArc[],
  staffSpace: number
): SvgNotehead | null {
  for (const arc of arcs) {
    const nearEnd =
      Math.abs(arc.endX - target.cx) <= staffSpace * 1.6 &&
      Math.abs(arc.endY - target.cy) <= staffSpace * 2.5;
    if (!nearEnd) continue;

    for (const src of prevNotes) {
      if (src.id === target.id) continue;
      if (src.step !== target.step || src.octave !== target.octave) continue;
      const nearStart =
        Math.abs(arc.startX - src.cx) <= staffSpace * 1.6 &&
        Math.abs(arc.startY - src.cy) <= staffSpace * 2.5;
      if (nearStart) return src;
    }
  }
  return null;
}

function pairColumnWithSlice(
  svgNotes: SvgNotehead[],
  midiNotes: RawMidiNote[]
): Array<{ svg: SvgNotehead; midi: RawMidiNote }> {
  const remainingMidi = [...midiNotes];
  const pairs: Array<{ svg: SvgNotehead; midi: RawMidiNote }> = [];

  // Greedy bipartite match minimizing |diatonicMidi - midi.pitch|
  const candidates: Array<{
    svg: SvgNotehead;
    midi: RawMidiNote;
    diff: number;
  }> = [];
  for (const s of svgNotes) {
    const dMidi = diatonicToMidi(s.step, s.octave);
    for (const m of remainingMidi) {
      candidates.push({ svg: s, midi: m, diff: Math.abs(dMidi - m.pitch) });
    }
  }
  candidates.sort((a, b) => a.diff - b.diff);

  const usedSvg = new Set<number>();
  const usedMidi = new Set<RawMidiNote>();
  for (const c of candidates) {
    if (usedSvg.has(c.svg.id) || usedMidi.has(c.midi)) continue;
    usedSvg.add(c.svg.id);
    usedMidi.add(c.midi);
    pairs.push({ svg: c.svg, midi: c.midi });
  }

  return pairs;
}

/**
 * Synthesizes a single measure's BuildNotes from raw MIDI truth events.
 */
function synthesizeMeasureFromMidi(
  span: MeasureSpan,
  rawMidi: RawMidiData,
  staffOf: (note: RawMidiNote) => 1 | 2,
  keyFifths: number,
  stavesCount: 1 | 2
): { notes: BuildNote[]; hasStaff2: boolean } {
  const segs1: NoteSegment[] = [];
  const segs2: NoteSegment[] = [];

  for (const note of rawMidi.notes) {
    if (note.endTick <= span.startTick || note.startTick >= span.endTick) continue;
    const segStart = Math.max(note.startTick, span.startTick);
    const segEnd = Math.min(note.endTick, span.endTick);
    if (segEnd <= segStart) continue;
    const staff = staffOf(note);
    const seg: NoteSegment = {
      pitch: note.pitch,
      startTick: segStart,
      endTick: segEnd,
      staff,
      tieStart: segEnd < note.endTick,
      tieStop: segStart > note.startTick,
    };
    if (staff === 1) segs1.push(seg);
    else segs2.push(seg);
  }

  const rhNotes = buildStaffVoicesForMeasure(
    segs1,
    span.startTick,
    span.duration,
    1,
    rawMidi.ppq,
    keyFifths
  );
  const useTwoStaves = stavesCount === 2 || segs2.length > 0;
  const lhNotes = useTwoStaves
    ? buildStaffVoicesForMeasure(segs2, span.startTick, span.duration, 2, rawMidi.ppq, keyFifths)
    : [];

  return { notes: [...rhNotes, ...lhNotes], hasStaff2: segs2.length > 0 };
}

export interface AlignSvgsResult {
  model: ScoreBuildModel;
  diagnostics: ConversionDiagnostic[];
  measuresAligned: number;
  fallbackMeasures: number;
  alignmentConfidence: number;
}

function pitchKey(p?: BuildPitch): string | null {
  if (!p) return null;
  return `${p.step}:${p.alter ?? 0}:${p.octave}`;
}

/**
 * Explicitly closes any open cross-boundary `<tie>`, `<slur>`, `<wedge>`, and `<pedal>`
 * spanners at SVG/fallback boundaries (and at the end of the score).
 */
export function closeBoundarySpanners(
  measures: BuildMeasure[],
  isFallback: boolean[]
): void {
  if (measures.length === 0) return;

  // 1. <tie> reconciliation across SVG/fallback boundaries & end of score
  for (let mIdx = 0; mIdx < measures.length; mIdx++) {
    const curr = measures[mIdx];
    const isLast = mIdx === measures.length - 1;
    const nextIsBoundary = !isLast && isFallback[mIdx] !== isFallback[mIdx + 1];

    if (isLast) {
      const openInLast = new Map<string, BuildNote[]>();
      for (const n of curr.notes) {
        const k = pitchKey(n.pitch);
        if (!k) continue;
        if (n.tieStop) {
          const stack = openInLast.get(k);
          if (stack && stack.length > 0) stack.shift();
        }
        if (n.tieStart) {
          const stack = openInLast.get(k) ?? [];
          stack.push(n);
          openInLast.set(k, stack);
        }
      }
      for (const stack of openInLast.values()) {
        for (const unclosed of stack) {
          unclosed.tieStart = undefined;
        }
      }
    } else if (nextIsBoundary) {
      const next = measures[mIdx + 1];
      const nextStopKeys = new Set<string>();
      for (const n of next.notes) {
        const k = pitchKey(n.pitch);
        if (n.tieStop && k) nextStopKeys.add(k);
      }
      const currStartKeys = new Set<string>();
      for (const n of curr.notes) {
        const k = pitchKey(n.pitch);
        if (n.tieStart && k) {
          if (nextStopKeys.has(k)) {
            currStartKeys.add(k);
          } else {
            n.tieStart = undefined;
          }
        }
      }
      for (const n of next.notes) {
        const k = pitchKey(n.pitch);
        if (n.tieStop && (!k || !currStartKeys.has(k))) {
          n.tieStop = undefined;
        }
      }
    }
  }

  // 2. <slur> closure at SVG/fallback boundaries & end of score
  const openSlurs = new Map<number, { startNote: BuildNote; lastNote: BuildNote }>();
  const closeAllSlurs = () => {
    for (const [, state] of openSlurs.entries()) {
      if (state.lastNote === state.startNote) {
        state.startNote.slurStart = undefined;
      } else {
        state.lastNote.slurStop = true;
      }
    }
    openSlurs.clear();
  };

  for (let mIdx = 0; mIdx < measures.length; mIdx++) {
    if (mIdx > 0 && isFallback[mIdx - 1] !== isFallback[mIdx] && openSlurs.size > 0) {
      closeAllSlurs();
    }
    for (const n of measures[mIdx].notes) {
      if (n.kind !== "note") continue;
      const num = n.slurNumber ?? 1;
      for (const state of openSlurs.values()) {
        state.lastNote = n;
      }
      if (n.slurStop) {
        if (openSlurs.has(num)) {
          openSlurs.delete(num);
        } else {
          n.slurStop = undefined;
        }
      }
      if (n.slurStart) {
        openSlurs.set(num, { startNote: n, lastNote: n });
      }
    }
  }
  if (openSlurs.size > 0) {
    closeAllSlurs();
  }

  // 3. <wedge> closure at SVG/fallback boundaries & end of score
  let openWedge: { staff: 1 | 2 } | null = null;
  for (let mIdx = 0; mIdx < measures.length; mIdx++) {
    if (mIdx > 0 && isFallback[mIdx - 1] !== isFallback[mIdx] && openWedge !== null) {
      const prev = measures[mIdx - 1];
      prev.wedges = prev.wedges ?? [];
      prev.wedges.push({ tickOffset: prev.duration, type: "stop", staff: openWedge.staff });
      openWedge = null;
    }
    const wedges = measures[mIdx].wedges;
    if (!wedges || wedges.length === 0) continue;
    wedges.sort((a, b) => a.tickOffset - b.tickOffset);
    const kept = [];
    for (const w of wedges) {
      if (w.type === "crescendo" || w.type === "diminuendo") {
        openWedge = { staff: w.staff ?? 1 };
        kept.push(w);
      } else if (w.type === "stop") {
        if (openWedge !== null) {
          openWedge = null;
          kept.push(w);
        }
      }
    }
    measures[mIdx].wedges = kept.length > 0 ? kept : undefined;
  }
  if (openWedge !== null) {
    const last = measures[measures.length - 1];
    last.wedges = last.wedges ?? [];
    last.wedges.push({ tickOffset: last.duration, type: "stop", staff: openWedge.staff });
  }

  // 4. <pedal> closure at SVG/fallback boundaries & end of score
  let openPedal: { staff: 1 | 2 } | null = null;
  for (let mIdx = 0; mIdx < measures.length; mIdx++) {
    if (mIdx > 0 && isFallback[mIdx - 1] !== isFallback[mIdx] && openPedal !== null) {
      const prev = measures[mIdx - 1];
      prev.pedals = prev.pedals ?? [];
      prev.pedals.push({ tickOffset: prev.duration, type: "stop", staff: openPedal.staff });
      openPedal = null;
    }
    const pedals = measures[mIdx].pedals;
    if (!pedals || pedals.length === 0) continue;
    pedals.sort((a, b) => a.tickOffset - b.tickOffset);
    const kept = [];
    for (const p of pedals) {
      if (p.type === "start") {
        openPedal = { staff: p.staff ?? 2 };
        kept.push(p);
      } else if (p.type === "change") {
        if (openPedal === null) {
          openPedal = { staff: p.staff ?? 2 };
          kept.push({ ...p, type: "start" as const });
        } else {
          kept.push(p);
        }
      } else if (p.type === "stop") {
        if (openPedal !== null) {
          openPedal = null;
          kept.push(p);
        }
      }
    }
    measures[mIdx].pedals = kept.length > 0 ? kept : undefined;
  }
  if (openPedal !== null) {
    const last = measures[measures.length - 1];
    last.pedals = last.pedals ?? [];
    last.pedals.push({ tickOffset: last.duration, type: "stop", staff: openPedal.staff });
  }
}

/**
 * Computes the unfolded playback order of printed measure indices (0-based)
 * by executing repeat barlines, volta brackets, and D.C./D.S./Coda/Fine jumps.
 */
export function computeUnfoldedPlaybackOrder(svgMeasures: SvgMeasureData[]): number[] {
  const n = svgMeasures.length;
  if (n === 0) return [];

  const segnoIdx = svgMeasures.findIndex((m) =>
    m.navMarkers?.some((nm) => nm.kind === "segno")
  );
  const codaIdx = svgMeasures.findIndex((m) =>
    m.navMarkers?.some((nm) => nm.kind === "coda")
  );

  const order: number[] = [];
  const maxSteps = n * 8 + 16;
  let i = 0;
  let repeatStartIdx = 0;
  let pass = 1;
  let hasTakenJump = false;
  let ignoreRepeats = false;

  while (i >= 0 && i < n && order.length < maxSteps) {
    const m = svgMeasures[i];

    if (!ignoreRepeats && m.repeatStart && pass === 1) {
      repeatStartIdx = i;
    }

    if (!ignoreRepeats && m.volta && !m.volta.numbers.includes(pass)) {
      // Skip forward to the first measure matching the current pass
      let nextMatch = -1;
      for (let j = i + 1; j < n; j++) {
        if (svgMeasures[j].volta?.numbers.includes(pass)) {
          nextMatch = j;
          break;
        }
        if (!svgMeasures[j].volta && j > i + 1) {
          break;
        }
      }
      if (nextMatch !== -1) {
        i = nextMatch;
        continue;
      }
    }

    order.push(i);

    const markers = m.navMarkers ?? [];
    if (hasTakenJump && markers.some((nm) => nm.kind === "fine")) {
      break;
    }
    if (hasTakenJump && markers.some((nm) => nm.kind === "to-coda") && codaIdx >= 0) {
      i = codaIdx;
      continue;
    }

    if (!hasTakenJump) {
      const dc = markers.find(
        (nm) => nm.kind === "dc" || nm.kind === "dc-al-fine" || nm.kind === "dc-al-coda"
      );
      if (dc) {
        hasTakenJump = true;
        ignoreRepeats = true;
        i = 0;
        continue;
      }
      const ds = markers.find(
        (nm) => nm.kind === "ds" || nm.kind === "ds-al-fine" || nm.kind === "ds-al-coda"
      );
      if (ds) {
        hasTakenJump = true;
        ignoreRepeats = true;
        i = segnoIdx >= 0 ? segnoIdx : 0;
        continue;
      }
    }

    if (!ignoreRepeats && m.repeatStop) {
      // Determine max passes in this repeat section
      let maxPass = 2;
      for (let j = repeatStartIdx; j < n; j++) {
        const v = svgMeasures[j].volta;
        if (v) {
          for (const num of v.numbers) {
            if (num > maxPass) maxPass = num;
          }
        } else if (j > i) {
          break;
        }
      }

      if (pass < maxPass) {
        pass += 1;
        i = repeatStartIdx;
        continue;
      } else {
        pass = 1;
        repeatStartIdx = i + 1;
      }
    }

    i += 1;
  }

  return order;
}

/**
 * Aligns parsed MS4 SVG pages with raw MIDI truth events to produce a unified ScoreBuildModel.
 */
export function alignSvgsAndMidi(
  pages: ParsedSvgPage[],
  rawMidi: RawMidiData,
  options?: ConversionOptions
): AlignSvgsResult {
  const diagnostics: ConversionDiagnostic[] = [];
  const ppq = rawMidi.ppq;
  const splitPitch = options?.splitPitch ?? 60;
  const staffOf = assignStaffByTrack(rawMidi, splitPitch);
  const spans: MeasureSpan[] = buildMeasureSpans(rawMidi, options);
  const { measures: svgMeasures, maxStaves: svgMaxStaves } = collectSvgMeasures(pages);
  let maxStaves: 1 | 2 = svgMaxStaves;

  const unfoldedOrder = computeUnfoldedPlaybackOrder(svgMeasures);
  const hasFoldedStructure = unfoldedOrder.length !== svgMeasures.length;

  let alignmentPairs: Array<{ spanIdx: number; printedIdx: number }>;
  if (hasFoldedStructure && unfoldedOrder.length === spans.length) {
    alignmentPairs = unfoldedOrder.map((printedIdx, spanIdx) => ({
      spanIdx,
      printedIdx,
    }));
  } else if (svgMeasures.length === spans.length) {
    if (hasFoldedStructure) {
      diagnostics.push({
        level: "info",
        code: "REPEAT_NOT_UNFOLDED_IN_MIDI",
        message: `SVG has repeat/navigation structure (${unfoldedOrder.length} unfolded measures) but MIDI has ${spans.length} measures matching printed count; aligning 1:1.`,
      });
    }
    alignmentPairs = spans.map((_, idx) => ({ spanIdx: idx, printedIdx: idx }));
  } else if (hasFoldedStructure) {
    const count = Math.min(unfoldedOrder.length, spans.length);
    diagnostics.push({
      level: "warning",
      code: "MEASURE_COUNT_MISMATCH",
      message: `Unfolded SVG measure count (${unfoldedOrder.length}) differs from MIDI measure count (${spans.length}); aligning over ${count} unfolded measures.`,
    });
    alignmentPairs = Array.from({ length: count }, (_, idx) => ({
      spanIdx: idx,
      printedIdx: unfoldedOrder[idx],
    }));
  } else {
    diagnostics.push({
      level: "warning",
      code: "MEASURE_COUNT_MISMATCH",
      message: `SVG measure count (${svgMeasures.length}) differs from MIDI measure count (${spans.length}); synthesizing uncovered measures from MIDI.`,
    });
    alignmentPairs = spans.map((_, idx) => ({
      spanIdx: idx,
      printedIdx: idx,
    }));
  }

  let measuresAligned = 0;
  let fallbackMeasures = 0;
  let confidenceSum = 0;
  const confidenceThreshold = options?.alignmentConfidenceThreshold ?? 0.5;

  const builtByPrintedIdx = new Map<
    number,
    {
      measure: BuildMeasure;
      isFallback: boolean;
      keyFifths: number;
      mode: "major" | "minor";
      beats: number;
      beatType: number;
    }
  >();

  // Track active MIDI notes crossing measure boundaries
  const activeTieOutByNote = new Map<RawMidiNote, BuildNote>();

  for (const { spanIdx, printedIdx } of alignmentPairs) {
    const span = spans[spanIdx];
    const svgM = printedIdx < svgMeasures.length ? svgMeasures[printedIdx] : undefined;
    const measureNumber = printedIdx + 1;

    const ks = activeKeySigAt(rawMidi.keySigs, span.startTick);
    const ts = activeTimeSigAt(rawMidi.timeSigs, span.startTick);

    if (!svgM) {
      const synth = synthesizeMeasureFromMidi(span, rawMidi, staffOf, ks.fifths, maxStaves);
      if (synth.hasStaff2) maxStaves = 2;
      fallbackMeasures++;

      const tempos = rawMidi.tempos
        .filter((t) => t.tick >= span.startTick && t.tick < span.endTick)
        .map((t) => ({ tickOffset: t.tick - span.startTick, bpm: t.bpm }));

      const pedals = rawMidi.pedals
        .filter((p) => p.tick >= span.startTick && p.tick < span.endTick)
        .map((p) => ({
          tickOffset: p.tick - span.startTick,
          type: p.type,
          staff: maxStaves,
        }));

      if (!builtByPrintedIdx.has(printedIdx)) {
        builtByPrintedIdx.set(printedIdx, {
          measure: {
            number: span.number,
            implicit: span.implicit || undefined,
            duration: span.duration,
            tempos: tempos.length > 0 ? tempos : undefined,
            pedals: pedals.length > 0 ? pedals : undefined,
            notes: synth.notes,
          },
          isFallback: true,
          keyFifths: ks.fifths,
          mode: ks.mode,
          beats: ts.numerator,
          beatType: ts.denominator,
        });
      }
      continue;
    }

    const handVoiceMap = computeHandAndVoiceMap(svgM.noteheads, svgM.staffSpace);
    const visualCols = groupVisualColumns(svgM.noteheads, svgM.staffSpace);

    const newMidiNotes = rawMidi.notes.filter(
      (n) => n.startTick >= span.startTick && n.startTick < span.endTick
    );
    const continuingMidiNotes = rawMidi.notes.filter(
      (n) => n.startTick < span.startTick && n.endTick > span.startTick
    );
    const midiSlices = groupMidiSlices(newMidiNotes, ppq);

    const buildNotes: BuildNote[] = [];
    const pairedBySvgId = new Map<number, { midi: RawMidiNote; buildNote: BuildNote }>();
    const seenSvgInMeasure: SvgNotehead[] = [];
    let alterAnomalyCount = 0;

    // 1. Handle cross-measure continuing MIDI notes at the start of the measure
    let colOffset = 0;
    if (continuingMidiNotes.length > 0 && visualCols.length > 0) {
      // Check if first visual column contains tied continuations of continuingMidiNotes
      const firstCol = visualCols[0];
      const matches = pairColumnWithSlice(firstCol.noteheads, continuingMidiNotes);
      const allValid =
        matches.length === continuingMidiNotes.length &&
        matches.every((p) => Math.abs(p.midi.pitch - diatonicToMidi(p.svg.step, p.svg.octave)) <= 2);

      if (allValid && visualCols.length > midiSlices.length) {
        colOffset = 1;
        for (const { svg, midi } of matches) {
          const hv = handVoiceMap.get(svg.id) ?? { staff: svg.staff, voice: svg.staff === 1 ? "1" : "2" };
          const dMidi = diatonicToMidi(svg.step, svg.octave);
          const alter = midi.pitch - dMidi;
          const segEnd = Math.min(span.endTick, midi.endTick);
          const dur = Math.max(1, segEnd - span.startTick);
          const { type, dots } = durationToTypeAndDots(dur, ppq);
          const tieStart = midi.endTick > span.endTick;

          const prevBuild = activeTieOutByNote.get(midi);
          if (prevBuild) prevBuild.tieStart = true;

          const bn: BuildNote = {
            kind: "note",
            onsetOffset: 0,
            pitch: {
              step: svg.step,
              alter: alter !== 0 ? alter : undefined,
              octave: svg.octave,
            },
            duration: dur,
            voice: hv.voice,
            staff: hv.staff,
            type,
            dots: dots > 0 ? dots : undefined,
            tieStop: true,
            tieStart: tieStart || undefined,
            stem: svg.stemDir ?? undefined,
          };
          buildNotes.push(bn);
          pairedBySvgId.set(svg.id, { midi, buildNote: bn });
          seenSvgInMeasure.push(svg);
          if (tieStart) activeTieOutByNote.set(midi, bn);
          else activeTieOutByNote.delete(midi);
        }
      }
    }

    // 2. Align remaining visual columns with MIDI onset slices linearly
    let sliceIdx = 0;
    for (let cIdx = colOffset; cIdx < visualCols.length; cIdx++) {
      const col = visualCols[cIdx];

      // Check if this column's noteheads are same-measure tie continuations via visual arc + no new NoteOn
      const remainingCols = visualCols.length - cIdx;
      const remainingSlices = midiSlices.length - sliceIdx;
      if (remainingCols > remainingSlices) {
        let handledAsTie = false;
        for (const svg of col.noteheads) {
          const srcSvg = findIncomingArc(svg, seenSvgInMeasure, svgM.arcs, svgM.staffSpace);
          if (srcSvg) {
            const prevPair = pairedBySvgId.get(srcSvg.id);
            if (prevPair && prevPair.midi.endTick > span.startTick + (prevPair.buildNote.onsetOffset ?? 0) + prevPair.buildNote.duration) {
              // No new NoteOn; this is a Tie Continuation of prevPair.midi!
              const hv = handVoiceMap.get(svg.id) ?? { staff: svg.staff, voice: svg.staff === 1 ? "1" : "2" };
              const prevEndOffset = (prevPair.buildNote.onsetOffset ?? 0) + prevPair.buildNote.duration;
              const segEnd = Math.min(span.endTick, prevPair.midi.endTick);
              const dur = Math.max(1, segEnd - (span.startTick + prevEndOffset));
              const { type, dots } = durationToTypeAndDots(dur, ppq);
              const dMidi = diatonicToMidi(svg.step, svg.octave);
              const alter = prevPair.midi.pitch - dMidi;

              prevPair.buildNote.tieStart = true;
              const bn: BuildNote = {
                kind: "note",
                onsetOffset: prevEndOffset,
                pitch: {
                  step: svg.step,
                  alter: alter !== 0 ? alter : undefined,
                  octave: svg.octave,
                },
                duration: dur,
                voice: hv.voice,
                staff: hv.staff,
                type,
                dots: dots > 0 ? dots : undefined,
                tieStop: true,
                stem: svg.stemDir ?? undefined,
              };
              buildNotes.push(bn);
              pairedBySvgId.set(svg.id, { midi: prevPair.midi, buildNote: bn });
              seenSvgInMeasure.push(svg);
              handledAsTie = true;
            }
          }
        }
        if (handledAsTie) continue;
      }

      if (sliceIdx >= midiSlices.length) break;
      const slice = midiSlices[sliceIdx++];
      const pairs = pairColumnWithSlice(col.noteheads, slice.notes);

      // Determine next visual column's slice start if a tie splits a long MIDI note inside this measure
      const nextSliceStart =
        sliceIdx < midiSlices.length ? midiSlices[sliceIdx].startTick : span.endTick;

      for (const { svg, midi } of pairs) {
        const hv = handVoiceMap.get(svg.id) ?? { staff: svg.staff, voice: svg.staff === 1 ? "1" : "2" };
        const dMidi = diatonicToMidi(svg.step, svg.octave);
        const alter = midi.pitch - dMidi;
        if (Math.abs(alter) > 2) {
          alterAnomalyCount++;
          diagnostics.push({
            level: "warning",
            code: "ALIGNMENT_ALTER_OUT_OF_RANGE",
            measureNumber,
            message: `Alignment anomaly in measure ${measureNumber}: visual ${svg.step}${svg.octave} paired with MIDI ${midi.pitch} yields alter=${alter}.`,
          });
        }

        // Check if this note has an outgoing same-measure visual arc to a later notehead in this measure
        const hasOutgoingSameMeasureArc = svgM.arcs.some(
          (a) =>
            Math.abs(a.startX - svg.cx) <= svgM.staffSpace * 1.6 &&
            Math.abs(a.startY - svg.cy) <= svgM.staffSpace * 2.5 &&
            svgM.noteheads.some(
              (n2) =>
                n2.id !== svg.id &&
                n2.step === svg.step &&
                n2.octave === svg.octave &&
                Math.abs(a.endX - n2.cx) <= svgM.staffSpace * 1.6
            )
        );

        const segStart = midi.startTick;
        const maxSegEnd = Math.min(span.endTick, midi.endTick);
        // If there's an outgoing tie arc inside the measure and no new NoteOn, split duration before nextSliceStart/maxSegEnd
        let segEnd = maxSegEnd;
        if (hasOutgoingSameMeasureArc && visualCols.length > midiSlices.length) {
          const upperBound = Math.min(maxSegEnd, nextSliceStart > segStart ? nextSliceStart : maxSegEnd);
          segEnd = Math.max(segStart + 1, Math.round((segStart + upperBound) / 2));
        }
        const dur = Math.max(1, segEnd - segStart);
        const { type, dots } = durationToTypeAndDots(dur, ppq);
        const crossMeasureTie = midi.endTick > span.endTick;

        const bn: BuildNote = {
          kind: "note",
          onsetOffset: segStart - span.startTick,
          pitch: {
            step: svg.step,
            alter: alter !== 0 ? alter : undefined,
            octave: svg.octave,
          },
          duration: dur,
          voice: hv.voice,
          staff: hv.staff,
          type,
          dots: dots > 0 ? dots : undefined,
          tieStart: crossMeasureTie || undefined,
          stem: svg.stemDir ?? undefined,
        };
        buildNotes.push(bn);
        pairedBySvgId.set(svg.id, { midi, buildNote: bn });
        seenSvgInMeasure.push(svg);
        if (crossMeasureTie) {
          activeTieOutByNote.set(midi, bn);
        }
      }
    }

    // Mark chord notes sharing the same (voice, onsetOffset)
    const seenOnsetByVoice = new Set<string>();
    buildNotes.sort((a, b) => (a.onsetOffset ?? 0) - (b.onsetOffset ?? 0) || a.voice.localeCompare(b.voice));
    for (const bn of buildNotes) {
      const key = `${bn.voice}:${bn.onsetOffset ?? 0}`;
      if (seenOnsetByVoice.has(key)) {
        bn.isChord = true;
      } else {
        seenOnsetByVoice.add(key);
      }
    }

    const tempos = rawMidi.tempos
      .filter((t) => t.tick >= span.startTick && t.tick < span.endTick)
      .map((t) => ({ tickOffset: t.tick - span.startTick, bpm: t.bpm }));

    const pedals = rawMidi.pedals
      .filter((p) => p.tick >= span.startTick && p.tick < span.endTick)
      .map((p) => ({
        tickOffset: p.tick - span.startTick,
        type: p.type,
        staff: maxStaves,
      }));

    const expectedMidiCount = newMidiNotes.length + continuingMidiNotes.length;
    const svgCount = svgM.noteheads.length;
    const pairedCount = buildNotes.filter((n) => n.kind === "note").length;
    let measureConfidence = 1;
    if (expectedMidiCount === 0 && svgCount === 0) {
      measureConfidence = 1;
    } else if (expectedMidiCount === 0 || svgCount === 0) {
      measureConfidence = 0;
    } else {
      const coverage = pairedCount / Math.max(expectedMidiCount, svgCount);
      const alterPenalty = alterAnomalyCount / Math.max(1, pairedCount);
      measureConfidence = Math.max(0, coverage * (1 - 0.8 * alterPenalty));
    }

    const endingNum = svgM.volta?.numbers.join(",");
    const navMarkers: BuildNavMarker[] | undefined = svgM.navMarkers?.map((nm) => ({
      kind: nm.kind,
      text: nm.text,
    }));

    if (measureConfidence < confidenceThreshold) {
      diagnostics.push({
        level: "warning",
        code: "LOW_CONFIDENCE_MEASURE_FALLBACK",
        measureNumber,
        message: `Measure ${measureNumber} alignment confidence (${measureConfidence.toFixed(2)}) below threshold (${confidenceThreshold}); falling back to raw MIDI.`,
      });
      const synth = synthesizeMeasureFromMidi(span, rawMidi, staffOf, ks.fifths, maxStaves);
      if (synth.hasStaff2) maxStaves = 2;
      fallbackMeasures++;
      confidenceSum += measureConfidence;

      if (!builtByPrintedIdx.has(printedIdx)) {
        builtByPrintedIdx.set(printedIdx, {
          measure: {
            number: span.implicit && printedIdx === 0 ? "0" : String(printedIdx + 1),
            implicit: (span.implicit && printedIdx === 0) || undefined,
            duration: span.duration,
            tempos: tempos.length > 0 ? tempos : undefined,
            pedals: pedals.length > 0 ? pedals : undefined,
            notes: synth.notes,
            repeatStart: svgM.repeatStart || undefined,
            repeatStop: svgM.repeatStop || undefined,
            endingStart: svgM.volta?.isStart && endingNum ? endingNum : undefined,
            endingStop:
              svgM.volta?.isStop && endingNum
                ? {
                    number: endingNum,
                    type: svgM.repeatStop ? "stop" : "stop",
                  }
                : undefined,
            navMarkers: navMarkers && navMarkers.length > 0 ? navMarkers : undefined,
          },
          isFallback: true,
          keyFifths: ks.fifths,
          mode: ks.mode,
          beats: ts.numerator,
          beatType: ts.denominator,
        });
      }
      continue;
    }

    measuresAligned++;
    confidenceSum += measureConfidence;

    if (!builtByPrintedIdx.has(printedIdx)) {
      builtByPrintedIdx.set(printedIdx, {
        measure: {
          number: span.implicit && printedIdx === 0 ? "0" : String(printedIdx + 1),
          implicit: (span.implicit && printedIdx === 0) || undefined,
          duration: span.duration,
          tempos: tempos.length > 0 ? tempos : undefined,
          pedals: pedals.length > 0 ? pedals : undefined,
          notes: buildNotes,
          repeatStart: svgM.repeatStart || undefined,
          repeatStop: svgM.repeatStop || undefined,
          endingStart: svgM.volta?.isStart && endingNum ? endingNum : undefined,
          endingStop:
            svgM.volta?.isStop && endingNum
              ? {
                  number: endingNum,
                  type: svgM.repeatStop ? "stop" : "stop",
                }
              : undefined,
          navMarkers: navMarkers && navMarkers.length > 0 ? navMarkers : undefined,
        },
        isFallback: false,
        keyFifths: ks.fifths,
        mode: ks.mode,
        beats: ts.numerator,
        beatType: ts.denominator,
      });
    }
  }

  // Emit printed measures in score order with attributes assigned cleanly
  const buildMeasures: BuildMeasure[] = [];
  const isFallback: boolean[] = [];
  let prevKeyFifths: number | undefined;
  let prevBeats: number | undefined;
  let prevBeatType: number | undefined;
  const sortedPrintedIndices = Array.from(builtByPrintedIdx.keys()).sort((a, b) => a - b);

  for (let idx = 0; idx < sortedPrintedIndices.length; idx++) {
    const pIdx = sortedPrintedIndices[idx];
    const entry = builtByPrintedIdx.get(pIdx)!;
    let attrs: BuildAttributes | undefined;
    if (
      idx === 0 ||
      entry.keyFifths !== prevKeyFifths ||
      entry.beats !== prevBeats ||
      entry.beatType !== prevBeatType
    ) {
      attrs = {};
      if (idx === 0) {
        attrs.divisions = ppq;
        attrs.staves = maxStaves;
      }
      if (idx === 0 || entry.keyFifths !== prevKeyFifths) {
        attrs.fifths = entry.keyFifths;
        attrs.mode = entry.mode;
      }
      if (idx === 0 || entry.beats !== prevBeats || entry.beatType !== prevBeatType) {
        attrs.beats = entry.beats;
        attrs.beatType = entry.beatType;
      }
    }
    prevKeyFifths = entry.keyFifths;
    prevBeats = entry.beats;
    prevBeatType = entry.beatType;

    isFallback.push(entry.isFallback);

    buildMeasures.push({
      ...entry.measure,
      attributes: attrs,
    });
  }

  closeBoundarySpanners(buildMeasures, isFallback);

  if (buildMeasures.length > 0 && buildMeasures[0].attributes) {
    buildMeasures[0].attributes.staves = maxStaves;
  }

  const totalMeasures = spans.length;
  const alignmentConfidence = totalMeasures > 0 ? confidenceSum / totalMeasures : 0;

  return {
    model: {
      title: options?.title ?? "MuseScore Import",
      divisions: ppq,
      staves: maxStaves,
      measures: buildMeasures,
    },
    diagnostics,
    measuresAligned,
    fallbackMeasures,
    alignmentConfidence,
  };
}
