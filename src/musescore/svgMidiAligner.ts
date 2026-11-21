import {
  activeKeySigAt,
  activeTimeSigAt,
  buildMeasureSpans,
  durationToTypeAndDots,
  type MeasureSpan,
} from "./midiToScoreModel";
import type { ParsedSvgPage, SvgArc, SvgArticulation, SvgDynamic, SvgNotehead } from "./svgParser";
import type {
  BuildAttributes,
  BuildDynamicEvent,
  BuildMeasure,
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
  pageIndex: number;
  systemIndex: number;
  globalMeasureIndex: number;
  staffSpace: number;
  stavesCount: 1 | 2;
  minX: number;
  maxX: number;
  noteheads: SvgNotehead[];
  arcs: SvgArc[];
  articulations: SvgArticulation[];
  dynamics: SvgDynamic[];
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
      const sysArticulations = page.articulations.filter(
        (a) => a.systemIndex === sys.systemIndex
      );
      const sysDynamics = page.dynamics.filter(
        (d) => d.systemIndex === sys.systemIndex
      );

      for (const m of sys.measures) {
        const mNotes = sysNotes.filter((n) => n.measureIndex === m.measureIndex);
        const mArcs = sysArcs.filter(
          (a) => a.endX >= m.minX - ss && a.startX <= m.maxX + ss
        );
        const mArticulations = sysArticulations.filter(
          (a) => a.measureIndex === m.measureIndex
        );
        const mDynamics = sysDynamics.filter(
          (d) => d.measureIndex === m.measureIndex
        );
        measures.push({
          pageIndex: page.pageIndex,
          systemIndex: sys.systemIndex,
          globalMeasureIndex: measures.length,
          staffSpace: ss,
          stavesCount: sys.staves.length >= 2 ? 2 : 1,
          minX: m.minX,
          maxX: m.maxX,
          noteheads: mNotes,
          arcs: mArcs,
          articulations: mArticulations,
          dynamics: mDynamics,
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

function findIncomingTieArc(
  target: SvgNotehead,
  prevNotes: SvgNotehead[],
  arcs: SvgArc[],
  staffSpace: number
): { src: SvgNotehead; arc: SvgArc } | null {
  for (const arc of arcs) {
    if (arc.kind !== "tie") continue;
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
      if (nearStart) return { src, arc };
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
 * Aligns parsed MS4 SVG pages with raw MIDI truth events to produce a unified ScoreBuildModel.
 */
export function alignSvgsAndMidi(
  pages: ParsedSvgPage[],
  rawMidi: RawMidiData,
  options?: ConversionOptions
): { model: ScoreBuildModel; diagnostics: ConversionDiagnostic[] } {
  const diagnostics: ConversionDiagnostic[] = [];
  const ppq = rawMidi.ppq;
  const spans: MeasureSpan[] = buildMeasureSpans(rawMidi, options);
  const { measures: svgMeasures, maxStaves } = collectSvgMeasures(pages);

  if (svgMeasures.length !== spans.length) {
    diagnostics.push({
      level: "warning",
      code: "MEASURE_COUNT_MISMATCH",
      message: `SVG measure count (${svgMeasures.length}) differs from MIDI measure count (${spans.length}); aligning linearly over ${Math.min(svgMeasures.length, spans.length)} measures.`,
    });
  }

  const measureCount = Math.min(svgMeasures.length, spans.length);
  const buildMeasures: BuildMeasure[] = [];
  let prevKeyFifths: number | undefined;
  let prevBeats: number | undefined;
  let prevBeatType: number | undefined;

  // Track active MIDI notes crossing measure boundaries: key = `${pitch}:${voice}` -> last BuildNote
  const activeTieOutByNote = new Map<RawMidiNote, BuildNote>();
  const svgNoteToBuildNote = new Map<string, BuildNote>();
  const consumedTieArcs = new Set<string>();

  for (let mIdx = 0; mIdx < measureCount; mIdx++) {
    const span = spans[mIdx];
    const svgM = svgMeasures[mIdx];
    const measureNumber = Number.parseInt(span.number, 10) || mIdx + 1;

    const ks = activeKeySigAt(rawMidi.keySigs, span.startTick);
    const ts = activeTimeSigAt(rawMidi.timeSigs, span.startTick);
    let attrs: BuildAttributes | undefined;
    if (
      mIdx === 0 ||
      ks.fifths !== prevKeyFifths ||
      ts.numerator !== prevBeats ||
      ts.denominator !== prevBeatType
    ) {
      attrs = {};
      if (mIdx === 0) {
        attrs.divisions = ppq;
        attrs.staves = maxStaves;
      }
      if (mIdx === 0 || ks.fifths !== prevKeyFifths) {
        attrs.fifths = ks.fifths;
        attrs.mode = ks.mode;
      }
      if (mIdx === 0 || ts.numerator !== prevBeats || ts.denominator !== prevBeatType) {
        attrs.beats = ts.numerator;
        attrs.beatType = ts.denominator;
      }
    }
    prevKeyFifths = ks.fifths;
    prevBeats = ts.numerator;
    prevBeatType = ts.denominator;

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
          svgNoteToBuildNote.set(`${svgM.pageIndex}:${svg.id}`, bn);
          seenSvgInMeasure.push(svg);
          for (const arc of svgM.arcs) {
            if (
              arc.kind === "tie" &&
              Math.abs(arc.endX - svg.cx) <= svgM.staffSpace * 1.6 &&
              Math.abs(arc.endY - svg.cy) <= svgM.staffSpace * 2.5
            ) {
              consumedTieArcs.add(`${svgM.pageIndex}:${arc.id}`);
            }
          }
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
          const tieMatch = findIncomingTieArc(svg, seenSvgInMeasure, svgM.arcs, svgM.staffSpace);
          if (tieMatch) {
            const { src: srcSvg, arc: tieArc } = tieMatch;
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
              svgNoteToBuildNote.set(`${svgM.pageIndex}:${svg.id}`, bn);
              consumedTieArcs.add(`${svgM.pageIndex}:${tieArc.id}`);
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
          diagnostics.push({
            level: "warning",
            code: "ALIGNMENT_ALTER_OUT_OF_RANGE",
            measureNumber,
            message: `Alignment anomaly in measure ${measureNumber}: visual ${svg.step}${svg.octave} paired with MIDI ${midi.pitch} yields alter=${alter}.`,
          });
        }

        // Check if this note has an outgoing same-measure tie arc to a later notehead in this measure
        const hasOutgoingSameMeasureArc = svgM.arcs.some(
          (a) =>
            a.kind === "tie" &&
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
        svgNoteToBuildNote.set(`${svgM.pageIndex}:${svg.id}`, bn);
        seenSvgInMeasure.push(svg);
        if (crossMeasureTie) {
          activeTieOutByNote.set(midi, bn);
        }
      }
    }

    // Attach articulations to their nearest aligned noteheads
    for (const art of svgM.articulations) {
      let bestNote: SvgNotehead | null = null;
      let bestScore = Infinity;
      for (const n of svgM.noteheads) {
        const dx = Math.abs(n.cx - art.cx);
        if (dx > svgM.staffSpace * 1.4) continue;
        const dy = Math.abs(n.cy - art.cy);
        const staffPenalty = n.staff === art.staff ? 0 : svgM.staffSpace * 4;
        const score = dx + dy * 0.1 + staffPenalty;
        if (score < bestScore) {
          bestScore = score;
          bestNote = n;
        }
      }
      if (bestNote) {
        const bn = svgNoteToBuildNote.get(`${svgM.pageIndex}:${bestNote.id}`);
        if (bn) {
          const existing = bn.articulations ?? [];
          if (!existing.includes(art.kind)) {
            bn.articulations = [...existing, art.kind];
          }
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

    const dynamics: BuildDynamicEvent[] = svgM.dynamics.map((d) => ({
      tickOffset: resolveTickOffsetForX(d.cx, svgM, span.duration, svgNoteToBuildNote),
      kind: d.kind,
      staff: d.staff,
    }));

    buildMeasures.push({
      number: span.number,
      implicit: span.implicit || undefined,
      duration: span.duration,
      attributes: attrs,
      tempos: tempos.length > 0 ? tempos : undefined,
      pedals: pedals.length > 0 ? pedals : undefined,
      dynamics: dynamics.length > 0 ? dynamics : undefined,
      notes: buildNotes,
    });
  }

  attachSlursFromUnconsumedArcs(pages, svgNoteToBuildNote, consumedTieArcs);
  attachWedgesFromHairpins(pages, svgMeasures, buildMeasures, svgNoteToBuildNote);

  return {
    model: {
      title: options?.title ?? "MuseScore Import",
      divisions: ppq,
      staves: maxStaves,
      measures: buildMeasures,
    },
    diagnostics,
  };
}

function resolveTickOffsetForX(
  x: number,
  svgM: SvgMeasureData,
  measureDuration: number,
  svgNoteToBuildNote: Map<string, BuildNote>
): number {
  let bestNote: SvgNotehead | null = null;
  let bestDx = Infinity;
  for (const n of svgM.noteheads) {
    const dx = Math.abs(n.cx - x);
    if (dx <= svgM.staffSpace * 1.8 && dx < bestDx) {
      bestDx = dx;
      bestNote = n;
    }
  }
  if (bestNote) {
    const bn = svgNoteToBuildNote.get(`${svgM.pageIndex}:${bestNote.id}`);
    if (bn && bn.onsetOffset !== undefined) {
      return Math.max(0, Math.min(measureDuration, bn.onsetOffset));
    }
  }
  const width = Math.max(1, svgM.maxX - svgM.minX);
  const ratio = Math.max(0, Math.min(1, (x - svgM.minX) / width));
  return Math.round(ratio * measureDuration);
}

function findSystemMeasureForX(
  x: number,
  sysMeasures: SvgMeasureData[]
): SvgMeasureData {
  for (const m of sysMeasures) {
    if (x >= m.minX && x <= m.maxX) return m;
  }
  return x < sysMeasures[0].minX ? sysMeasures[0] : sysMeasures[sysMeasures.length - 1];
}

function attachWedgesFromHairpins(
  pages: ParsedSvgPage[],
  svgMeasures: SvgMeasureData[],
  buildMeasures: BuildMeasure[],
  svgNoteToBuildNote: Map<string, BuildNote>
): void {
  const alignedCount = buildMeasures.length;
  for (const page of pages) {
    for (const sys of page.systems) {
      const sysMs = svgMeasures.filter(
        (m) =>
          m.pageIndex === page.pageIndex &&
          m.systemIndex === sys.systemIndex &&
          m.globalMeasureIndex < alignedCount
      );
      if (sysMs.length === 0) continue;

      const sysHairpins = page.hairpins
        .filter((h) => h.systemIndex === sys.systemIndex)
        .sort((a, b) => a.startX - b.startX || a.endX - b.endX);

      let nextWedgeNum = 1;
      for (const hp of sysHairpins) {
        const startSvgM = findSystemMeasureForX(hp.startX, sysMs);
        const endSvgM = findSystemMeasureForX(hp.endX, sysMs);
        const startBm = buildMeasures[startSvgM.globalMeasureIndex];
        const endBm = buildMeasures[endSvgM.globalMeasureIndex];
        if (!startBm || !endBm) continue;

        let startOffset = resolveTickOffsetForX(
          hp.startX,
          startSvgM,
          startBm.duration,
          svgNoteToBuildNote
        );
        let stopOffset = resolveTickOffsetForX(
          hp.endX,
          endSvgM,
          endBm.duration,
          svgNoteToBuildNote
        );

        if (startSvgM.globalMeasureIndex === endSvgM.globalMeasureIndex && stopOffset <= startOffset) {
          if (startOffset < endBm.duration) {
            stopOffset = endBm.duration;
          } else {
            startOffset = Math.max(0, stopOffset - 1);
          }
        }

        const num = nextWedgeNum;
        nextWedgeNum = nextWedgeNum >= 6 ? 1 : nextWedgeNum + 1;

        startBm.wedges = [
          ...(startBm.wedges ?? []),
          { tickOffset: startOffset, type: hp.kind, number: num, staff: hp.staff },
        ];
        endBm.wedges = [
          ...(endBm.wedges ?? []),
          { tickOffset: stopOffset, type: "stop", number: num, staff: hp.staff },
        ];
      }
    }
  }
}

function findArcEndpointNotehead(
  x: number,
  y: number,
  arcStaff: 1 | 2,
  candidates: SvgNotehead[],
  staffSpace: number,
  excludeId?: number,
  minCx?: number
): SvgNotehead | null {
  let best: SvgNotehead | null = null;
  let bestScore = Infinity;
  for (const n of candidates) {
    if (excludeId !== undefined && n.id === excludeId) continue;
    if (minCx !== undefined && n.cx < minCx) continue;
    const dx = Math.abs(n.cx - x);
    if (dx > staffSpace * 2.2) continue;
    const dy = Math.abs(n.cy - y);
    const staffPenalty = n.staff === arcStaff ? 0 : staffSpace * 4;
    const score = dx + dy * 0.25 + staffPenalty;
    if (score < bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return best;
}

function attachSlursFromUnconsumedArcs(
  pages: ParsedSvgPage[],
  svgNoteToBuildNote: Map<string, BuildNote>,
  consumedTieArcs: Set<string>
): void {
  for (const page of pages) {
    for (const sys of page.systems) {
      const ss = sys.staves[0]?.staffSpace ?? 80;
      const sysNotes = page.noteheads.filter((n) => n.systemIndex === sys.systemIndex);
      const sysArcs = page.arcs
        .filter((a) => a.systemIndex === sys.systemIndex)
        .sort((a, b) => a.startX - b.startX || a.endX - b.endX);

      for (const arc of sysArcs) {
        if (consumedTieArcs.has(`${page.pageIndex}:${arc.id}`)) continue;
        const startNote = findArcEndpointNotehead(arc.startX, arc.startY, arc.staff, sysNotes, ss);
        if (!startNote) continue;
        const endNote = findArcEndpointNotehead(
          arc.endX,
          arc.endY,
          arc.staff,
          sysNotes,
          ss,
          startNote.id,
          startNote.cx - ss * 0.5
        );
        if (!endNote) continue;

        const startBn = svgNoteToBuildNote.get(`${page.pageIndex}:${startNote.id}`);
        const stopBn = svgNoteToBuildNote.get(`${page.pageIndex}:${endNote.id}`);
        if (!startBn || !stopBn || startBn === stopBn) continue;

        // If this arc was a tieStop/tieStart pair on the same sustaining note, skip
        if (startBn.tieStart && stopBn.tieStop && startNote.step === endNote.step && startNote.octave === endNote.octave && arc.kind === "tie") {
          continue;
        }

        const slurNumber = 1;
        startBn.slurStarts = [...(startBn.slurStarts ?? []), slurNumber];
        stopBn.slurStops = [...(stopBn.slurStops ?? []), slurNumber];
      }
    }
  }
}
