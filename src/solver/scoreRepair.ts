import {
  DEFAULT_HAND_SPAN_PROFILE,
  type Hand,
  type HandSpanProfile,
  type NoteEvent,
  type OnsetSlice,
  type ScoreRepairNoteEdit,
  type ScoreRepairOption,
  type ScoreRepairSuggestion,
} from "../domain/types";
import { analyzeHandHeldNotes } from "./heldNotes";
import {
  MAX_OCTAVE_SPAN,
  getMaxSpan,
  getSpanScale,
  keyPos,
  midiToPitchLabel,
} from "./keyboard";

/**
 * Maximum span (in white-key units) a hand may hold for a chord / held group.
 * Tuned for small-to-medium hands: never above a pure octave, and for 3+ voices
 * further bounded by the profile's thumb–pinky limit (S profile excludes
 * octave triads; a bare octave dyad stays playable for every profile).
 */
export function getRepairSpanLimit(
  profile: HandSpanProfile,
  voiceCount = 3
): number {
  if (voiceCount <= 2) return MAX_OCTAVE_SPAN;
  return Math.min(getMaxSpan(1, 5, getSpanScale(profile)), MAX_OCTAVE_SPAN);
}

function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

function posSpanOfMidis(midis: number[]): number {
  if (midis.length <= 1) return 0;
  let minPos = Infinity;
  let maxPos = -Infinity;
  for (const m of midis) {
    const p = keyPos(m);
    if (p < minPos) minPos = p;
    if (p > maxPos) maxPos = p;
  }
  return maxPos - minPos;
}

function formatChordPreview(midis: number[]): string {
  return [...midis]
    .sort((a, b) => a - b)
    .map(midiToPitchLabel)
    .join("+");
}

function chordExceedsPlayableCount(notes: NoteEvent[], hand: Hand): boolean {
  const k = notes.length;
  if (k <= 5) return false;
  if (k > 6) return true;
  // 6 notes is only playable if the thumb or pinky end forms an adjacent 2nd (<= 2 semitones)
  const ordered = hand === "LH" ? [...notes].reverse() : notes;
  const lowPairAdjacent = Math.abs(ordered[1].midi - ordered[0].midi) <= 2;
  const highPairAdjacent = Math.abs(ordered[5].midi - ordered[4].midi) <= 2;
  return !lowPairAdjacent && !highPairAdjacent;
}

function isPlayableCount(midis: number[], hand: Hand): boolean {
  if (midis.length <= 5) return true;
  if (midis.length > 6) return false;
  const sorted = [...midis].sort((a, b) => a - b);
  const ordered = hand === "LH" ? [...sorted].reverse() : sorted;
  return (
    Math.abs(ordered[1] - ordered[0]) <= 2 ||
    Math.abs(ordered[5] - ordered[4]) <= 2
  );
}

interface ActiveNoteInterval {
  noteUid: string;
  hand: Hand;
  midi: number;
  onsetTick: number;
  endTick: number;
}

function buildHandRedistributionOption(
  repairId: string,
  slice: OnsetSlice,
  sourceActiveHeld: OnsetSlice["heldNotes"],
  otherHandSlicesByTick: Map<number, OnsetSlice>,
  otherHandActiveIntervals: ActiveNoteInterval[],
  otherHandHeldReleasedUidsAtTick: Set<string>,
  profile: HandSpanProfile
): ScoreRepairOption | null {
  if (slice.isGrace || slice.notes.length < 2) return null;

  const sourceHand = slice.hand;
  const limit = getRepairSpanLimit(profile);
  const targetHand: Hand = sourceHand === "RH" ? "LH" : "RH";
  const oppSlice = otherHandSlicesByTick.get(slice.onsetTick);
  const oppStruckNotes = oppSlice && !oppSlice.isGrace ? oppSlice.notes : [];

  // Active held notes on the opposite hand at this exact onsetTick
  const oppHeldMidis: number[] = [];
  if (oppSlice) {
    for (const h of oppSlice.heldNotes) {
      if (!h.pedalSustained && !otherHandHeldReleasedUidsAtTick.has(h.noteUid)) {
        oppHeldMidis.push(h.midi);
      }
    }
  } else {
    for (const iv of otherHandActiveIntervals) {
      if (iv.onsetTick < slice.onsetTick && iv.endTick > slice.onsetTick) {
        oppHeldMidis.push(iv.midi);
      }
    }
  }

  const sourceHeldMidis = sourceActiveHeld
    .filter((h) => !h.pedalSustained)
    .map((h) => h.midi);

  const notes = slice.notes; // sorted ascending by midi

  for (let moveCount = 1; moveCount < notes.length; moveCount++) {
    const moved =
      sourceHand === "LH"
        ? notes.slice(notes.length - moveCount)
        : notes.slice(0, moveCount);
    const remaining =
      sourceHand === "LH"
        ? notes.slice(0, notes.length - moveCount)
        : notes.slice(moveCount);

    if (moved.some((n) => n.isGrace || n.isTieStart || n.isTieStop)) {
      continue;
    }

    const remMidis = remaining.map((n) => n.midi);
    const sourceAllMidis = [...remMidis, ...sourceHeldMidis];
    if (
      posSpanOfMidis(sourceAllMidis) > limit + 1e-6 ||
      !isPlayableCount(remMidis, sourceHand)
    ) {
      continue;
    }

    const movedMidis = moved.map((n) => n.midi);
    const oppCombinedStruck = [...oppStruckNotes.map((n) => n.midi), ...movedMidis];
    const oppAllMidis = [...oppCombinedStruck, ...oppHeldMidis];
    if (
      posSpanOfMidis(oppAllMidis) > limit + 1e-6 ||
      !isPlayableCount(oppCombinedStruck, targetHand) ||
      oppAllMidis.length > 6
    ) {
      continue;
    }

    // Preserve natural LH <= RH hand pitch order
    const minMoved = Math.min(...movedMidis);
    const maxMoved = Math.max(...movedMidis);
    const maxRem = Math.max(...remMidis);
    const minRem = Math.min(...remMidis);
    const oppMidisAll = [...oppStruckNotes.map((n) => n.midi), ...oppHeldMidis];

    if (sourceHand === "LH") {
      if (maxRem > minMoved) continue;
      if (oppMidisAll.length > 0 && maxRem > Math.min(...oppMidisAll)) continue;
    } else {
      if (minRem < maxMoved) continue;
      if (oppMidisAll.length > 0 && minRem < Math.max(...oppMidisAll)) continue;
    }

    const edits: ScoreRepairNoteEdit[] = moved.map((n) => ({
      kind: "reassign-hand",
      noteUid: n.noteUid,
      targetHand,
    }));

    const lhLabel =
      sourceHand === "LH"
        ? formatChordPreview(remMidis)
        : formatChordPreview(oppCombinedStruck);
    const rhLabel =
      sourceHand === "RH"
        ? formatChordPreview(remMidis)
        : formatChordPreview(oppCombinedStruck);

    return {
      optionId: `${repairId}:hand-redistribution:0`,
      strategy: "hand-redistribution",
      label: "跨手分担",
      description: `将 ${moved.map((n) => midiToPitchLabel(n.midi)).join("+")} 移交${
        targetHand === "RH" ? "右手" : "左手"
      }同拍弹奏，完整保留全部原音高。`,
      fidelityScore: 98 - moveCount * 2,
      previewSummary: `LH ${lhLabel} | RH ${rhLabel}`,
      edits,
    };
  }

  return null;
}

function buildOctaveFoldOption(
  repairId: string,
  slice: OnsetSlice,
  profile: HandSpanProfile
): ScoreRepairOption | null {
  const notes = slice.notes;
  if (notes.length < 2) return null;
  const limit = getRepairSpanLimit(profile, notes.length);

  const isLH = slice.hand === "LH";
  const anchorMidi = isLH ? notes[0].midi : notes[notes.length - 1].midi;
  const lowBound = isLH ? anchorMidi : anchorMidi - 12;
  const highBound = isLH ? anchorMidi + 12 : anchorMidi;

  interface FoldTarget {
    note: NoteEvent;
    targetMidi: number;
    moved: boolean;
  }

  const targets: FoldTarget[] = notes.map((n) => {
    let m = n.midi;
    while (m > highBound) m -= 12;
    while (m < lowBound) m += 12;
    return {
      note: n,
      targetMidi: m,
      moved: m !== n.midi,
    };
  });

  // Deduplicate colliding target MIDIs, preferring unmoved notes first
  const keptByMidi = new Map<number, FoldTarget>();
  const removedUids = new Set<string>();

  const orderedForDedup = [...targets].sort((a, b) => {
    if (a.moved !== b.moved) return a.moved ? 1 : -1;
    return isLH ? a.note.midi - b.note.midi : b.note.midi - a.note.midi;
  });

  for (const item of orderedForDedup) {
    if (!keptByMidi.has(item.targetMidi)) {
      keptByMidi.set(item.targetMidi, item);
    } else {
      removedUids.add(item.note.noteUid);
    }
  }

  // If still > 5 notes (e.g. dense 6+ note cluster), thin inner notes to <= 5
  let keptList = Array.from(keptByMidi.values()).sort((a, b) => a.targetMidi - b.targetMidi);
  if (keptList.length > 5) {
    while (keptList.length > 5) {
      const innerIdx = Math.floor(keptList.length / 2);
      const [dropped] = keptList.splice(innerIdx, 1);
      removedUids.add(dropped.note.noteUid);
    }
  }

  const finalMidis = keptList.map((t) => t.targetMidi);
  const distinctPcs = new Set(finalMidis.map(pitchClass));
  if (distinctPcs.size < 2) return null;
  if (posSpanOfMidis(finalMidis) > limit + 1e-6) return null;

  const edits: ScoreRepairNoteEdit[] = [];
  for (const item of keptList) {
    if (item.moved) {
      edits.push({
        kind: "change-pitch",
        noteUid: item.note.noteUid,
        oldMidi: item.note.midi,
        newMidi: item.targetMidi,
      });
    }
  }
  for (const uid of removedUids) {
    edits.push({ kind: "remove-note", noteUid: uid });
  }

  if (edits.length === 0) return null;

  const origPcs = new Set(notes.map((n) => pitchClass(n.midi)));
  const keepsAllPcs = distinctPcs.size === origPcs.size;

  return {
    optionId: `${repairId}:octave-fold-thin:fold`,
    strategy: "octave-fold-thin",
    label: "八度折叠",
    description: isLH
      ? "保留最低根音，将超八度音高向下折叠至纯八度内并去重，完整保留和声色彩。"
      : "保留最高旋律音，将超八度低音向上折叠至纯八度内并去重，完整保留旋律骨架。",
    fidelityScore: keepsAllPcs ? 92 : 82,
    previewSummary: formatChordPreview(finalMidis),
    edits,
  };
}

function buildDuplicateThinOption(
  repairId: string,
  slice: OnsetSlice,
  profile: HandSpanProfile,
  foldPreview?: string
): ScoreRepairOption | null {
  const notes = slice.notes;
  if (notes.length < 3) return null;
  const limit = getRepairSpanLimit(profile);

  const pcCount = new Map<number, number>();
  for (const n of notes) {
    const pc = pitchClass(n.midi);
    pcCount.set(pc, (pcCount.get(pc) ?? 0) + 1);
  }

  const removableIndices: number[] = [];
  for (let i = 0; i < notes.length; i++) {
    const pc = pitchClass(notes[i].midi);
    if ((pcCount.get(pc) ?? 0) >= 2) {
      removableIndices.push(i);
    }
  }
  if (removableIndices.length === 0) return null;

  // Prefer keeping top melody on RH, or removing outer/duplicate note cleanly for single-removal solutions
  const candidateOrder = [...removableIndices].sort((a, b) => {
    const aIsTop = a === notes.length - 1;
    const bIsTop = b === notes.length - 1;
    if (slice.hand === "RH" && aIsTop !== bIsTop) return aIsTop ? 1 : -1;
    return a - b;
  });

  for (const idx of candidateOrder) {
    const remaining = notes.filter((_, i) => i !== idx);
    const remMidis = remaining.map((n) => n.midi);
    const remPcs = new Set(remMidis.map(pitchClass));
    if (remPcs.size < 2) continue;
    if (posSpanOfMidis(remMidis) > limit + 1e-6) continue;
    if (!isPlayableCount(remMidis, slice.hand)) continue;

    const preview = formatChordPreview(remMidis);
    if (preview === foldPreview) continue;

    const dropped = notes[idx];
    return {
      optionId: `${repairId}:octave-fold-thin:thin`,
      strategy: "octave-fold-thin",
      label: "去冗余八度",
      description: `移除重复八度音 ${midiToPitchLabel(dropped.midi)}，保留全部和声级并缩回纯八度内。`,
      fidelityScore: 86,
      previewSummary: preview,
      edits: [{ kind: "remove-note", noteUid: dropped.noteUid }],
    };
  }

  return null;
}

function buildArpeggiateOption(
  repairId: string,
  slice: OnsetSlice,
  fidelityScore: number
): ScoreRepairOption | null {
  const unarpeggiated = slice.notes.filter((n) => !n.isArpeggiated);
  if (unarpeggiated.length === 0) return null;

  return {
    optionId: `${repairId}:arpeggiate:0`,
    strategy: "arpeggiate",
    label: "标记琶音滚奏",
    description: "保留 100% 原音高，为同拍和弦写入 <arpeggiate/> 琶音记号按滚奏处理。",
    fidelityScore,
    previewSummary: `琶音 ${formatChordPreview(slice.notes.map((n) => n.midi))}`,
    edits: unarpeggiated.map((n) => ({
      kind: "add-arpeggiate",
      noteUid: n.noteUid,
    })),
  };
}

/**
 * Pure TypeScript analyzer (zero DOM dependencies) that detects unplayable chords
 * and over-octave held-note collisions, returning fidelity-ranked MusicXML repair options.
 */
export function analyzeScoreRepairSuggestions(
  onsetSlices: OnsetSlice[],
  profile: HandSpanProfile = DEFAULT_HAND_SPAN_PROFILE
): ScoreRepairSuggestion[] {
  if (onsetSlices.length === 0) return [];

  const rhSlices = onsetSlices.filter((s) => s.hand === "RH");
  const lhSlices = onsetSlices.filter((s) => s.hand === "LH");
  const isDualHandScore = rhSlices.length > 0 && lhSlices.length > 0;

  const rhHeldAnalysis = analyzeHandHeldNotes(rhSlices, profile);
  const lhHeldAnalysis = analyzeHandHeldNotes(lhSlices, profile);

  const activeHeldBySliceId = new Map<string, OnsetSlice["heldNotes"]>();
  const releasedUidsBySliceId = new Map<string, Set<string>>();
  rhSlices.forEach((s, idx) => {
    activeHeldBySliceId.set(s.sliceId, rhHeldAnalysis.activeHeldBySlice[idx] ?? []);
    releasedUidsBySliceId.set(
      s.sliceId,
      new Set((rhHeldAnalysis.releasedHeldBySlice[idx] ?? []).map((r) => r.noteUid))
    );
  });
  lhSlices.forEach((s, idx) => {
    activeHeldBySliceId.set(s.sliceId, lhHeldAnalysis.activeHeldBySlice[idx] ?? []);
    releasedUidsBySliceId.set(
      s.sliceId,
      new Set((lhHeldAnalysis.releasedHeldBySlice[idx] ?? []).map((r) => r.noteUid))
    );
  });

  const slicesByHandAndTick: Record<Hand, Map<number, OnsetSlice>> = {
    RH: new Map(),
    LH: new Map(),
  };
  const activeIntervalsByHand: Record<Hand, ActiveNoteInterval[]> = {
    RH: [],
    LH: [],
  };
  const rootEventByUid = new Map<string, NoteEvent>();

  for (const slice of onsetSlices) {
    if (!slice.isGrace) {
      slicesByHandAndTick[slice.hand].set(slice.onsetTick, slice);
    }
    for (const n of slice.notes) {
      rootEventByUid.set(n.noteUid, n);
      if (n.durationTick > 0) {
        activeIntervalsByHand[slice.hand].push({
          noteUid: n.noteUid,
          hand: slice.hand,
          midi: n.midi,
          onsetTick: n.onsetTick,
          endTick: n.onsetTick + n.durationTick,
        });
      }
    }
  }

  const orderedSlices = [...onsetSlices].sort((a, b) => {
    if (a.onsetTick !== b.onsetTick) return a.onsetTick - b.onsetTick;
    if (a.hand !== b.hand) return a.hand === "RH" ? -1 : 1;
    return 0;
  });

  const suggestions: ScoreRepairSuggestion[] = [];
  const seenHeldConflictUids = new Set<string>();

  for (const slice of orderedSlices) {
    const allArpeggiated =
      slice.notes.length >= 2 && slice.notes.every((n) => Boolean(n.isArpeggiated));
    const midis = slice.notes.map((n) => n.midi);
    const chordSpan = posSpanOfMidis(midis);
    const maxChordSemitones =
      midis.length >= 2 ? midis[midis.length - 1] - midis[0] : 0;
    const handLabel = slice.hand === "RH" ? "右手" : "左手";
    const limit = getRepairSpanLimit(profile, slice.notes.length);

    // 1. chord-over-octave
    if (!allArpeggiated && chordSpan > limit + 1e-6) {
      const repairId = `repair:${slice.sliceId}:chord-over-octave`;
      const options: ScoreRepairOption[] = [];

      if (isDualHandScore) {
        const otherHand: Hand = slice.hand === "RH" ? "LH" : "RH";
        const otherSlice = slicesByHandAndTick[otherHand].get(slice.onsetTick);
        const redist = buildHandRedistributionOption(
          repairId,
          slice,
          activeHeldBySliceId.get(slice.sliceId) ?? [],
          slicesByHandAndTick[otherHand],
          activeIntervalsByHand[otherHand],
          otherSlice ? releasedUidsBySliceId.get(otherSlice.sliceId) ?? new Set() : new Set(),
          profile
        );
        if (redist) options.push(redist);
      }

      const foldOpt = buildOctaveFoldOption(repairId, slice, profile);
      if (foldOpt) options.push(foldOpt);

      const thinOpt = buildDuplicateThinOption(repairId, slice, profile, foldOpt?.previewSummary);
      if (thinOpt) options.push(thinOpt);

      const arpOpt = buildArpeggiateOption(repairId, slice, 84);
      if (arpOpt) options.push(arpOpt);

      options.sort((a, b) => b.fidelityScore - a.fidelityScore);
      if (options.length > 0) {
        suggestions.push({
          repairId,
          measureIndex: slice.measureIndex,
          sliceId: slice.sliceId,
          hand: slice.hand,
          onsetTick: slice.onsetTick,
          issueKind: "chord-over-octave",
          summary: `第${slice.measureIndex + 1}小节 · ${handLabel} · ${formatChordPreview(midis)}（超八度 ${maxChordSemitones} 半音）`,
          maxSemitones: maxChordSemitones,
          options,
        });
      }
    } else if (!allArpeggiated && chordExceedsPlayableCount(slice.notes, slice.hand)) {
      // 2. chord-exceeds-5
      const repairId = `repair:${slice.sliceId}:chord-exceeds-5`;
      const options: ScoreRepairOption[] = [];

      if (isDualHandScore) {
        const otherHand: Hand = slice.hand === "RH" ? "LH" : "RH";
        const otherSlice = slicesByHandAndTick[otherHand].get(slice.onsetTick);
        const redist = buildHandRedistributionOption(
          repairId,
          slice,
          activeHeldBySliceId.get(slice.sliceId) ?? [],
          slicesByHandAndTick[otherHand],
          activeIntervalsByHand[otherHand],
          otherSlice ? releasedUidsBySliceId.get(otherSlice.sliceId) ?? new Set() : new Set(),
          profile
        );
        if (redist) options.push(redist);
      }

      const thinOpt = buildDuplicateThinOption(repairId, slice, profile);
      if (thinOpt) options.push(thinOpt);

      const foldOpt = buildOctaveFoldOption(repairId, slice, profile);
      if (foldOpt) options.push(foldOpt);

      const arpOpt = buildArpeggiateOption(repairId, slice, 88);
      if (arpOpt) options.push(arpOpt);

      options.sort((a, b) => b.fidelityScore - a.fidelityScore);
      if (options.length > 0) {
        suggestions.push({
          repairId,
          measureIndex: slice.measureIndex,
          sliceId: slice.sliceId,
          hand: slice.hand,
          onsetTick: slice.onsetTick,
          issueKind: "chord-exceeds-5",
          summary: `第${slice.measureIndex + 1}小节 · ${handLabel} · ${formatChordPreview(midis)}（${slice.notes.length} 音超五指）`,
          maxSemitones: maxChordSemitones,
          options,
        });
      }
    }

    // 3. held-over-octave (non-pedal held note colliding over octave with subsequent slice)
    for (const held of slice.heldNotes) {
      if (held.pedalSustained || seenHeldConflictUids.has(held.noteUid)) continue;
      const heldPos = keyPos(held.midi);
      const heldLimit = getRepairSpanLimit(profile, 2);
      let maxHeldDist = 0;
      let maxHeldSemitones = 0;
      for (const n of slice.notes) {
        const d = Math.abs(keyPos(n.midi) - heldPos);
        if (d > maxHeldDist) {
          maxHeldDist = d;
          maxHeldSemitones = Math.abs(n.midi - held.midi);
        }
      }
      if (maxHeldDist <= heldLimit + 1e-6) continue;

      const rootEv = rootEventByUid.get(held.noteUid);
      const heldOnsetTick = held.onsetTick ?? rootEv?.onsetTick;
      if (heldOnsetTick === undefined) continue;

      const newDurationTick = slice.onsetTick - heldOnsetTick;
      const origTotalTick = held.endTick - heldOnsetTick;
      if (newDurationTick <= 0 || newDurationTick >= origTotalTick) continue;

      seenHeldConflictUids.add(held.noteUid);
      const heldLabel = midiToPitchLabel(held.midi);
      const repairId = `repair:${slice.sliceId}:held-over-octave:${held.noteUid}`;
      const option: ScoreRepairOption = {
        optionId: `${repairId}:clip-duration:0`,
        strategy: "clip-duration",
        label: "裁剪异常延音",
        description: `将长保留音 ${heldLabel} 裁剪至第${slice.measureIndex + 1}小节冲突拍前抬指，避免超八度硬撑。`,
        fidelityScore: 90,
        previewSummary: `${heldLabel} 时值裁剪为 ${newDurationTick} ticks`,
        edits: [
          {
            kind: "clip-duration",
            noteUid: held.noteUid,
            newDurationTick,
          },
        ],
      };

      suggestions.push({
        repairId,
        measureIndex: slice.measureIndex,
        sliceId: slice.sliceId,
        hand: slice.hand,
        onsetTick: slice.onsetTick,
        issueKind: "held-over-octave",
        summary: `第${slice.measureIndex + 1}小节 · ${handLabel} · 保持音 ${heldLabel} 与 ${formatChordPreview(midis)}（超八度 ${maxHeldSemitones} 半音）`,
        maxSemitones: maxHeldSemitones,
        options: [option],
      });
    }
  }

  return suggestions;
}
