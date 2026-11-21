import {
  activeKeySigAt,
  activeTimeSigAt,
  buildMeasureSpans,
  durationToTypeAndDots,
  type MeasureSpan,
} from "./midiToScoreModel";
import type { ParsedSvgPage, SvgArc, SvgArpeggio, SvgFingering, SvgNotehead } from "./svgParser";
import type {
  BuildAttributes,
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
  globalMeasureIndex: number;
  staffSpace: number;
  stavesCount: 1 | 2;
  noteheads: SvgNotehead[];
  arcs: SvgArc[];
  fingerings: SvgFingering[];
  arpeggios: SvgArpeggio[];
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
      const sysFingerings = page.fingerings.filter((f) => f.systemIndex === sys.systemIndex);
      const sysArpeggios = page.arpeggios.filter((a) => a.systemIndex === sys.systemIndex);

      for (const m of sys.measures) {
        const mNotes = sysNotes.filter((n) => n.measureIndex === m.measureIndex);
        const mArcs = sysArcs.filter(
          (a) => a.endX >= m.minX - ss && a.startX <= m.maxX + ss
        );
        const mFingerings = sysFingerings.filter((f) => f.measureIndex === m.measureIndex);
        const mArpeggios = sysArpeggios.filter((a) => a.measureIndex === m.measureIndex);
        measures.push({
          globalMeasureIndex: measures.length,
          staffSpace: ss,
          stavesCount: sys.staves.length >= 2 ? 2 : 1,
          noteheads: mNotes,
          arcs: mArcs,
          fingerings: mFingerings,
          arpeggios: mArpeggios,
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
    const sameGrace = prev && prev.noteheads[0].isGrace === n.isGrace;
    const sameStem =
      prev && sameGrace && n.stemId !== null && prev.noteheads.some((p) => p.stemId === n.stemId);
    const closeX = prev && sameGrace && Math.abs(n.cx - prev.cx) <= staffSpace * 0.65;
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

function attachMeasureFingerings(
  visualCols: VisualColumn[],
  fingerings: SvgFingering[],
  staffSpace: number,
  pairedBySvgId: Map<number, { midi: RawMidiNote; buildNote: BuildNote }>
): void {
  if (fingerings.length === 0 || visualCols.length === 0) return;

  // Match each fingering to its horizontally nearest VisualColumn (within 1.8 * staffSpace)
  const colFingerings = new Map<VisualColumn, SvgFingering[]>();
  for (const f of fingerings) {
    let bestCol: VisualColumn | null = null;
    let bestDx = Infinity;
    for (const col of visualCols) {
      const dx = Math.abs(f.cx - col.cx);
      if (dx <= staffSpace * 1.8 && dx < bestDx) {
        bestDx = dx;
        bestCol = col;
      }
    }
    if (!bestCol) continue;
    const arr = colFingerings.get(bestCol) ?? [];
    arr.push(f);
    colFingerings.set(bestCol, arr);
  }

  for (const [col, fings] of colFingerings.entries()) {
    // Group by staff inside the column
    for (const staffNum of [1, 2] as const) {
      const staffNotes = col.noteheads
        .filter((n) => n.staff === staffNum && pairedBySvgId.has(n.id))
        .sort((a, b) => a.cy - b.cy); // top-to-bottom (highest pitch first)
      if (staffNotes.length === 0) continue;

      const staffFings = fings
        .filter((f) => {
          const hasOtherStaff = col.noteheads.some((n) => n.staff !== staffNum && pairedBySvgId.has(n.id));
          if (!hasOtherStaff) return true;
          return f.staff === staffNum;
        })
        .sort((a, b) => a.cy - b.cy); // top-to-bottom

      if (staffFings.length === 0) continue;

      if (staffFings.length >= staffNotes.length) {
        for (let i = 0; i < staffNotes.length; i++) {
          pairedBySvgId.get(staffNotes[i].id)!.buildNote.fingering = staffFings[i].value;
        }
      } else if (staffFings.length === 1) {
        // Single fingering on a chord: attach to the vertically closest notehead
        const f = staffFings[0];
        let bestNote = staffNotes[0];
        let bestDy = Math.abs(f.cy - bestNote.cy);
        for (let i = 1; i < staffNotes.length; i++) {
          const dy = Math.abs(f.cy - staffNotes[i].cy);
          if (dy < bestDy) {
            bestDy = dy;
            bestNote = staffNotes[i];
          }
        }
        pairedBySvgId.get(bestNote.id)!.buildNote.fingering = f.value;
      } else {
        // Partial stacked fingerings: if above chord -> top notes; if below chord -> bottom notes
        const allAbove = staffFings.every((f) => f.cy < staffNotes[0].cy);
        const startIdx = allAbove ? 0 : staffNotes.length - staffFings.length;
        for (let i = 0; i < staffFings.length; i++) {
          pairedBySvgId.get(staffNotes[startIdx + i].id)!.buildNote.fingering = staffFings[i].value;
        }
      }
    }
  }
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
          seenSvgInMeasure.push(svg);
          if (tieStart) activeTieOutByNote.set(midi, bn);
          else activeTieOutByNote.delete(midi);
        }
      }
    }

    // 2. Align remaining visual columns with MIDI onset slices linearly
    let sliceIdx = 0;
    let pendingGraceSnapStart: number | null = null;
    for (let cIdx = colOffset; cIdx < visualCols.length; cIdx++) {
      const col = visualCols[cIdx];
      const isGraceCol = col.noteheads.every((n) => n.isGrace);

      // Check if this column's noteheads are same-measure tie continuations via visual arc + no new NoteOn
      const remainingCols = visualCols.length - cIdx;
      const remainingSlices = midiSlices.length - sliceIdx;
      if (!isGraceCol && remainingCols > remainingSlices) {
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
      const colArpeggios = svgM.arpeggios.filter(
        (a) => a.cx <= col.cx && col.cx - a.cx <= svgM.staffSpace * 2.5
      );

      const slice = midiSlices[sliceIdx];
      let sliceNotesForCol = slice.notes;
      let arpeggioBaseStartTick: number | null = null;

      if (isGraceCol && slice.notes.length > col.noteheads.length) {
        // Simultaneous grace + principal note at same startTick: consume shortest note(s) for grace column
        const sortedByDur = [...slice.notes].sort((a, b) => a.durationTick - b.durationTick);
        sliceNotesForCol = sortedByDur.slice(0, col.noteheads.length);
        const consumed = new Set(sliceNotesForCol);
        slice.notes = slice.notes.filter((n) => !consumed.has(n));
      } else if (!isGraceCol && colArpeggios.length > 0) {
        // Collapse slightly staggered MIDI onset slices for an arpeggiated chord into a single Onset Slice
        arpeggioBaseStartTick = slice.startTick;
        const maxRollWindow = Math.round(ppq * 0.6);
        const collapsed = [...slice.notes];
        sliceIdx++;
        while (
          sliceIdx < midiSlices.length &&
          collapsed.length < col.noteheads.length &&
          midiSlices[sliceIdx].startTick - arpeggioBaseStartTick <= maxRollWindow
        ) {
          collapsed.push(...midiSlices[sliceIdx].notes);
          sliceIdx++;
        }
        sliceNotesForCol = collapsed;
      } else {
        sliceIdx++;
      }

      const pairs = pairColumnWithSlice(col.noteheads, sliceNotesForCol);

      // Determine next visual column's slice start if a tie splits a long MIDI note inside this measure
      const nextSliceStart =
        sliceIdx < midiSlices.length ? midiSlices[sliceIdx].startTick : span.endTick;

      if (isGraceCol && pairs.length > 0) {
        const graceStart = Math.min(...pairs.map((p) => p.midi.startTick));
        const graceEnd = Math.max(...pairs.map((p) => p.midi.endTick));
        const nextStart = sliceIdx < midiSlices.length ? midiSlices[sliceIdx].startTick : graceStart;
        if (
          graceEnd - graceStart <= ppq / 4 &&
          Math.abs(nextStart - graceEnd) <= Math.max(2, Math.round(ppq / 32))
        ) {
          pendingGraceSnapStart = graceStart;
        }
      }

      const snapStart = !isGraceCol ? pendingGraceSnapStart : null;
      if (!isGraceCol) pendingGraceSnapStart = null;

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

        if (isGraceCol || svg.isGrace) {
          const { type } = durationToTypeAndDots(Math.max(1, midi.durationTick), ppq);
          const bn: BuildNote = {
            kind: "note",
            onsetOffset: midi.startTick - span.startTick,
            isGrace: true,
            pitch: {
              step: svg.step,
              alter: alter !== 0 ? alter : undefined,
              octave: svg.octave,
            },
            duration: 0,
            voice: hv.voice,
            staff: hv.staff,
            type,
            stem: svg.stemDir ?? undefined,
          };
          buildNotes.push(bn);
          pairedBySvgId.set(svg.id, { midi, buildNote: bn });
          seenSvgInMeasure.push(svg);
          continue;
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

        const segStart =
          arpeggioBaseStartTick !== null
            ? arpeggioBaseStartTick
            : snapStart !== null
              ? snapStart
              : midi.startTick;
        const isArpeggiated = colArpeggios.some(
          (a) =>
            svg.cy >= a.minY - svgM.staffSpace * 0.8 &&
            svg.cy <= a.maxY + svgM.staffSpace * 0.8
        );
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
          arpeggiate: isArpeggiated || undefined,
        };
        buildNotes.push(bn);
        pairedBySvgId.set(svg.id, { midi, buildNote: bn });
        seenSvgInMeasure.push(svg);
        if (crossMeasureTie) {
          activeTieOutByNote.set(midi, bn);
        }
      }
    }

    attachMeasureFingerings(visualCols, svgM.fingerings, svgM.staffSpace, pairedBySvgId);

    // Mark chord notes sharing the same (voice, onsetOffset, grace-state)
    const seenOnsetByVoice = new Set<string>();
    buildNotes.sort(
      (a, b) =>
        (a.onsetOffset ?? 0) - (b.onsetOffset ?? 0) ||
        (a.isGrace ? 0 : 1) - (b.isGrace ? 0 : 1) ||
        a.voice.localeCompare(b.voice)
    );
    for (const bn of buildNotes) {
      const key = `${bn.voice}:${bn.onsetOffset ?? 0}:${bn.isGrace ? "g" : "n"}`;
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

    buildMeasures.push({
      number: span.number,
      implicit: span.implicit || undefined,
      duration: span.duration,
      attributes: attrs,
      tempos: tempos.length > 0 ? tempos : undefined,
      pedals: pedals.length > 0 ? pedals : undefined,
      notes: buildNotes,
    });
  }

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
