import { makeScoreCoord } from "../domain/scoreCoord";
import type {
  Hand,
  MeasureTimeline,
  NoteEvent,
  OnsetSlice,
  ScoreCoord,
} from "../domain/types";
import type {
  MacroBoundaryReason,
  MacroSection,
  MotorChunk,
  PassageCluster,
  PassageInstance,
  PassageVariantKind,
  PerformanceCue,
  StaticChunkingResult,
  StaticScoreInput,
  SwitchPoint,
  VariantDiffCoord,
} from "./types";

interface StepBucket {
  onsetTick: number;
  measureIndex: number;
  isGrace: boolean;
  graceOrder: number;
  midis: number[];
}

interface RawDiagonalMatch {
  aStartM: number;
  aEndM: number;
  bStartM: number;
  bEndM: number;
  deltaSemitones: number;
  meanSim: number;
}

const CHROMA_SIZE = 12;
const INTERVAL_BINS = 25; // [-12..+12] -> [0..24]
const RHYTHM_SUBDIVS = 12;
const RHYTHM_SIZE = RHYTHM_SUBDIVS * 2; // RH (0..11) + LH (12..23)

// HarmAn 24 major/minor triad templates (12 major + 12 minor)
const TRIAD_TEMPLATES: Float32Array[] = (() => {
  const out: Float32Array[] = [];
  for (let root = 0; root < 12; root++) {
    const maj = new Float32Array(12);
    maj[root] = 1.0;
    maj[(root + 4) % 12] = 0.7;
    maj[(root + 7) % 12] = 0.85;
    const majNorm = Math.hypot(1.0, 0.7, 0.85);
    maj[root] /= majNorm;
    maj[(root + 4) % 12] /= majNorm;
    maj[(root + 7) % 12] /= majNorm;
    out.push(maj);

    const min = new Float32Array(12);
    min[root] = 1.0;
    min[(root + 3) % 12] = 0.7;
    min[(root + 7) % 12] = 0.85;
    const minNorm = Math.hypot(1.0, 0.7, 0.85);
    min[root] /= minNorm;
    min[(root + 3) % 12] /= minNorm;
    min[(root + 7) % 12] /= minNorm;
    out.push(min);
  }
  return out;
})();

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function l2NormalizeSlice(arr: Float32Array, offset: number, length: number): boolean {
  let sumSq = 0;
  for (let i = 0; i < length; i++) {
    const v = arr[offset + i];
    sumSq += v * v;
  }
  if (sumSq <= 1e-12) return false;
  const inv = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < length; i++) {
    arr[offset + i] *= inv;
  }
  return true;
}

function dotSlice(arr: Float32Array, offA: number, offB: number, length: number): number {
  let sum = 0;
  for (let i = 0; i < length; i++) {
    sum += arr[offA + i] * arr[offB + i];
  }
  return sum;
}

function toSignedSemitoneShift(shiftMod12: number): number {
  const norm = ((shiftMod12 % 12) + 12) % 12;
  return norm <= 6 ? norm : norm - 12;
}

function getMeasureQuarterLength(tl: MeasureTimeline | undefined): number {
  if (!tl) return 4;
  return (tl.timeBeats * 4) / Math.max(1, tl.timeBeatType);
}

function getActualMeasureQuarterLength(
  tl: MeasureTimeline | undefined,
  ticksPerQuarter: number,
): number {
  if (!tl) return 4;
  if (tl.endTick > tl.startTick && ticksPerQuarter > 0) {
    return (tl.endTick - tl.startTick) / ticksPerQuarter;
  }
  return getMeasureQuarterLength(tl);
}

function buildCrossHandSteps(noteEvents: NoteEvent[]): StepBucket[] {
  const buckets = new Map<string, StepBucket>();
  for (let i = 0; i < noteEvents.length; i++) {
    const ev = noteEvents[i];
    if (ev.isTieStop) continue;
    const graceOrder = ev.isGrace ? (ev.graceOrder ?? 0) : 0;
    const key = `${ev.onsetTick}|${ev.isGrace ? 1 : 0}|${graceOrder}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        onsetTick: ev.onsetTick,
        measureIndex: ev.measureIndex,
        isGrace: ev.isGrace,
        graceOrder,
        midis: [],
      };
      buckets.set(key, b);
    }
    b.midis.push(ev.midi);
  }
  const list = Array.from(buckets.values()).sort((a, b) => {
    if (a.onsetTick !== b.onsetTick) return a.onsetTick - b.onsetTick;
    if (a.isGrace !== b.isGrace) return a.isGrace ? -1 : 1;
    return a.graceOrder - b.graceOrder;
  });
  for (let i = 0; i < list.length; i++) {
    list[i].midis.sort((a, b) => a - b);
  }
  return list;
}

function computeHandLbdmBoundaryStrength(
  slices: OnsetSlice[],
  measureTimelines: MeasureTimeline[],
  hand: Hand,
): Float32Array {
  const M = measureTimelines.length;
  const boundaryStrength = new Float32Array(M + 1);
  const handSlices = slices.filter((s) => s.hand === hand && !s.isGrace && s.notes.length > 0);
  if (handSlices.length < 3) return boundaryStrength;

  const n = handSlices.length;
  const pitches = new Int16Array(n);
  const iois = new Float32Array(n);
  const rests = new Float32Array(n);
  const pitchIntervals = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const s = handSlices[i];
    let targetMidi = s.notes[0].midi;
    let maxDur = s.notes[0].durationSec;
    for (let k = 1; k < s.notes.length; k++) {
      const m = s.notes[k].midi;
      if (hand === "RH" ? m > targetMidi : m < targetMidi) {
        targetMidi = m;
      }
      if (s.notes[k].durationSec > maxDur) {
        maxDur = s.notes[k].durationSec;
      }
    }
    pitches[i] = targetMidi;
    const nextOnset = i + 1 < n ? handSlices[i + 1].onsetSec : s.onsetSec + maxDur;
    const ioi = Math.max(0.02, nextOnset - s.onsetSec);
    iois[i] = ioi;
    rests[i] = Math.max(0, ioi - maxDur);
  }

  for (let i = 0; i < n - 1; i++) {
    pitchIntervals[i] = Math.abs(pitches[i + 1] - pitches[i]);
  }
  pitchIntervals[n - 1] = 0;

  // Detect Alberti / broken-chord regions to suppress spurious pitch-interval peaks
  const isBrokenChord = new Uint8Array(n);
  for (let i = 2; i < n - 1; i++) {
    const pcs = new Set<number>([
      pitches[i - 2] % 12,
      pitches[i - 1] % 12,
      pitches[i] % 12,
      pitches[i + 1] % 12,
    ]);
    const ioiRatio =
      Math.max(iois[i - 1], iois[i]) / Math.max(0.02, Math.min(iois[i - 1], iois[i]));
    if (pcs.size <= 3 && ioiRatio <= 1.25 && rests[i] < 0.02) {
      isBrokenChord[i] = 1;
    }
  }

  const lbdmCurve = (x: Float32Array): Float32Array => {
    const s = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n - 1; i++) {
      const denom = x[i] + x[i + 1];
      r[i] = denom > 1e-6 ? Math.abs(x[i] - x[i + 1]) / denom : 0;
    }
    let maxVal = 0;
    for (let i = 1; i < n - 1; i++) {
      const val = x[i] * (r[i - 1] + r[i]);
      s[i] = val;
      if (val > maxVal) maxVal = val;
    }
    if (maxVal > 1e-6) {
      for (let i = 0; i < n; i++) s[i] /= maxVal;
    }
    return s;
  };

  const sPitch = lbdmCurve(pitchIntervals);
  const sIoi = lbdmCurve(iois);
  const sRest = lbdmCurve(rests);

  for (let i = 1; i < n - 1; i++) {
    const wPitch = isBrokenChord[i] ? 0.05 : 0.25;
    const score = wPitch * sPitch[i] + 0.5 * sIoi[i] + 0.25 * sRest[i];
    // Map boundary after slice[i] to the nearest measure boundary (end of slice[i]'s measure if near end, or start of slice[i+1]'s measure)
    const currM = handSlices[i].measureIndex;
    const nextM = handSlices[i + 1].measureIndex;
    if (nextM > currM && nextM <= M) {
      if (score > boundaryStrength[nextM]) {
        boundaryStrength[nextM] = score;
      }
    } else if (currM + 1 <= M) {
      const tl = measureTimelines[currM];
      if (tl) {
        const progress =
          (handSlices[i].onsetTick - tl.startTick) / Math.max(1, tl.endTick - tl.startTick);
        if (progress >= 0.7 && score * 0.7 > boundaryStrength[currM + 1]) {
          boundaryStrength[currM + 1] = score * 0.7;
        }
      }
    }
  }

  return boundaryStrength;
}

function computeFrameFeatures(
  input: StaticScoreInput,
  framesPerMeasure: number,
): {
  frameCount: number;
  chroma: Float32Array;
  intervalHist: Float32Array;
  rhythm: Float32Array;
  hasNotes: Uint8Array;
  frameStartTick: Float64Array;
  frameEndTick: Float64Array;
} {
  const M = input.measureCount;
  const frameCount = M * framesPerMeasure;
  const chroma = new Float32Array(frameCount * CHROMA_SIZE);
  const intervalHist = new Float32Array(frameCount * INTERVAL_BINS);
  const rhythm = new Float32Array(frameCount * RHYTHM_SIZE);
  const hasNotes = new Uint8Array(frameCount);
  const frameStartTick = new Float64Array(frameCount);
  const frameEndTick = new Float64Array(frameCount);

  for (let m = 0; m < M; m++) {
    const tl = input.measureTimelines[m];
    const start = tl?.startTick ?? m * input.ticksPerQuarter * 4;
    const end = tl?.endTick ?? start + input.ticksPerQuarter * 4;
    const span = Math.max(1, end - start);
    for (let f = 0; f < framesPerMeasure; f++) {
      const idx = m * framesPerMeasure + f;
      frameStartTick[idx] = start + (span * f) / framesPerMeasure;
      frameEndTick[idx] = start + (span * (f + 1)) / framesPerMeasure;
    }
  }

  // View 1 (Chroma) & View 3 (Rhythm grid)
  for (let i = 0; i < input.noteEvents.length; i++) {
    const ev = input.noteEvents[i];
    const m = ev.measureIndex;
    if (m < 0 || m >= M) continue;
    const tl = input.measureTimelines[m];
    if (!tl) continue;

    const noteStart = ev.onsetTick;
    const noteEnd = ev.onsetTick + Math.max(1, ev.durationTick);

    // Map onset to frame for rhythm grid
    if (!ev.isTieStop && !ev.isGrace) {
      const mSpan = Math.max(1, tl.endTick - tl.startTick);
      const relMeasure = clamp01((noteStart - tl.startTick) / mSpan);
      const subFrame = Math.min(framesPerMeasure - 1, Math.floor(relMeasure * framesPerMeasure));
      const frameIdx = m * framesPerMeasure + subFrame;
      const fStart = frameStartTick[frameIdx];
      const fSpan = Math.max(1, frameEndTick[frameIdx] - fStart);
      const phase = clamp01((noteStart - fStart) / fSpan);
      const bin = Math.min(RHYTHM_SUBDIVS - 1, Math.floor(phase * RHYTHM_SUBDIVS));
      const handOffset = ev.hand === "RH" ? 0 : RHYTHM_SUBDIVS;
      const base = frameIdx * RHYTHM_SIZE + handOffset;
      rhythm[base + bin] += 1.0;
      if (bin > 0) rhythm[base + bin - 1] += 0.25;
      if (bin + 1 < RHYTHM_SUBDIVS) rhythm[base + bin + 1] += 0.25;
    }

    // Chroma across overlapping frames (including tie duration)
    const pc = ((ev.midi % 12) + 12) % 12;
    let frameCursor = m * framesPerMeasure;
    while (frameCursor < frameCount && frameStartTick[frameCursor] < noteEnd) {
      const overlap =
        Math.min(noteEnd, frameEndTick[frameCursor]) -
        Math.max(noteStart, frameStartTick[frameCursor]);
      if (overlap > 0) {
        chroma[frameCursor * CHROMA_SIZE + pc] += overlap;
      }
      frameCursor++;
    }
  }

  // View 2 (RH Skyline pitch-interval bag per frame)
  let prevRhSkyMidi: number | null = null;
  for (let i = 0; i < input.onsetSlices.length; i++) {
    const slice = input.onsetSlices[i];
    if (slice.hand !== "RH" || slice.isGrace || slice.notes.length === 0) continue;
    let skyMidi = slice.notes[0].midi;
    for (let k = 1; k < slice.notes.length; k++) {
      if (slice.notes[k].midi > skyMidi) skyMidi = slice.notes[k].midi;
    }
    if (prevRhSkyMidi !== null) {
      const diff = Math.max(-12, Math.min(12, skyMidi - prevRhSkyMidi));
      const m = slice.measureIndex;
      if (m >= 0 && m < M) {
        const tl = input.measureTimelines[m];
        const mSpan = tl ? Math.max(1, tl.endTick - tl.startTick) : input.ticksPerQuarter * 4;
        const mStart = tl?.startTick ?? 0;
        const rel = clamp01((slice.onsetTick - mStart) / mSpan);
        const f = Math.min(framesPerMeasure - 1, Math.floor(rel * framesPerMeasure));
        const frameIdx = m * framesPerMeasure + f;
        intervalHist[frameIdx * INTERVAL_BINS + (diff + 12)] += 1.0;
      }
    }
    prevRhSkyMidi = skyMidi;
  }

  for (let t = 0; t < frameCount; t++) {
    const hasC = l2NormalizeSlice(chroma, t * CHROMA_SIZE, CHROMA_SIZE);
    l2NormalizeSlice(intervalHist, t * INTERVAL_BINS, INTERVAL_BINS);
    const hasR = l2NormalizeSlice(rhythm, t * RHYTHM_SIZE, RHYTHM_SIZE);
    if (hasC || hasR) hasNotes[t] = 1;
  }

  return {
    frameCount,
    chroma,
    intervalHist,
    rhythm,
    hasNotes,
    frameStartTick,
    frameEndTick,
  };
}

function computeSsmAndNovelty(
  features: ReturnType<typeof computeFrameFeatures>,
  framesPerMeasure: number,
): {
  ssmSim: Float32Array;
  ssmDelta: Int8Array;
  noveltyByMeasure: Float32Array;
} {
  const T = features.frameCount;
  const ssmSim = new Float32Array(T * T);
  const ssmDelta = new Int8Array(T * T);
  const { chroma, intervalHist, rhythm, hasNotes } = features;

  const intervalHasEnergy = new Uint8Array(T);
  for (let t = 0; t < T; t++) {
    let sum = 0;
    const off = t * INTERVAL_BINS;
    for (let k = 0; k < INTERVAL_BINS; k++) sum += intervalHist[off + k];
    if (sum > 0) intervalHasEnergy[t] = 1;
  }

  const noveltyRadius = 4; // 4 half-measure frames (or 4 measures if degraded)

  for (let i = 0; i < T; i++) {
    ssmSim[i * T + i] = hasNotes[i] ? 1 : 0;
    if (!hasNotes[i]) continue;
    const ci = i * CHROMA_SIZE;
    const ii = i * INTERVAL_BINS;
    const ri = i * RHYTHM_SIZE;

    for (let j = i + 1; j < T; j++) {
      if (!hasNotes[j]) continue;
      const cj = j * CHROMA_SIZE;

      // Best circular transposition over 12 pitch classes
      let bestChroma = -1;
      let bestShift = 0;
      for (let shift = 0; shift < 12; shift++) {
        let dot = 0;
        for (let pc = 0; pc < 12; pc++) {
          dot += chroma[ci + ((pc + shift) % 12)] * chroma[cj + pc];
        }
        if (dot > bestChroma) {
          bestChroma = dot;
          bestShift = shift;
        }
      }

      // Skip full multi-view work far from diagonal when chroma alone cannot reach threshold
      const nearDiag = j - i <= noveltyRadius * 2;
      if (!nearDiag && bestChroma < 0.45) {
        ssmSim[i * T + j] = bestChroma * 0.5;
        ssmSim[j * T + i] = bestChroma * 0.5;
        const signed = toSignedSemitoneShift(bestShift);
        ssmDelta[i * T + j] = signed;
        ssmDelta[j * T + i] = -signed;
        continue;
      }

      const simRhythm = dotSlice(rhythm, ri, j * RHYTHM_SIZE, RHYTHM_SIZE);
      let simTotal: number;
      if (intervalHasEnergy[i] && intervalHasEnergy[j]) {
        const simInterval = dotSlice(intervalHist, ii, j * INTERVAL_BINS, INTERVAL_BINS);
        simTotal = 0.5 * bestChroma + 0.25 * simInterval + 0.25 * simRhythm;
      } else {
        simTotal = 0.65 * bestChroma + 0.35 * simRhythm;
      }

      const signed = toSignedSemitoneShift(bestShift);
      ssmSim[i * T + j] = simTotal;
      ssmSim[j * T + i] = simTotal;
      ssmDelta[i * T + j] = signed;
      ssmDelta[j * T + i] = -signed;
    }
  }

  // Foote (2000) checkerboard novelty at measure boundaries
  const M = Math.floor(T / framesPerMeasure);
  const noveltyByMeasure = new Float32Array(M + 1);
  let maxNov = 0;
  for (let m = 1; m < M; m++) {
    const center = m * framesPerMeasure;
    const rad = Math.min(noveltyRadius, center, T - center);
    if (rad < 1) continue;
    let same = 0;
    let cross = 0;
    let countSame = 0;
    let countCross = 0;
    for (let a = center - rad; a < center; a++) {
      for (let b = center - rad; b < center; b++) {
        same += ssmSim[a * T + b];
        countSame++;
      }
      for (let b = center; b < center + rad; b++) {
        cross += ssmSim[a * T + b];
        countCross++;
      }
    }
    for (let a = center; a < center + rad; a++) {
      for (let b = center; b < center + rad; b++) {
        same += ssmSim[a * T + b];
        countSame++;
      }
    }
    const nov = Math.max(
      0,
      same / Math.max(1, countSame) - cross / Math.max(1, countCross),
    );
    noveltyByMeasure[m] = nov;
    if (nov > maxNov) maxNov = nov;
  }
  if (maxNov > 1e-6) {
    for (let m = 0; m <= M; m++) noveltyByMeasure[m] /= maxNov;
  }

  return { ssmSim, ssmDelta, noveltyByMeasure };
}

function computeHarmAnCadenceScores(
  features: ReturnType<typeof computeFrameFeatures>,
  framesPerMeasure: number,
): Float32Array {
  const T = features.frameCount;
  const M = Math.floor(T / framesPerMeasure);
  const cadenceByMeasure = new Float32Array(M + 1);
  if (T < 2) return cadenceByMeasure;

  const bestRoots = new Int8Array(T);
  const bestScores = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    if (!features.hasNotes[t]) {
      bestRoots[t] = -1;
      continue;
    }
    let bestIdx = 0;
    let bestScore = -1;
    const cOff = t * CHROMA_SIZE;
    for (let k = 0; k < TRIAD_TEMPLATES.length; k++) {
      const tpl = TRIAD_TEMPLATES[k];
      let dot = 0;
      for (let pc = 0; pc < 12; pc++) {
        dot += features.chroma[cOff + pc] * tpl[pc];
      }
      if (dot > bestScore) {
        bestScore = dot;
        bestIdx = k;
      }
    }
    bestRoots[t] = Math.floor(bestIdx / 2);
    bestScores[t] = bestScore;
  }

  for (let m = 1; m < M; m++) {
    const prevFrame = m * framesPerMeasure - 1;
    const currFrame = m * framesPerMeasure;
    const rPrev = bestRoots[prevFrame];
    const rCurr = bestRoots[currFrame];
    if (rPrev >= 0 && rCurr >= 0) {
      const diff = (rPrev - rCurr + 12) % 12;
      if (diff === 7) {
        // V -> I root motion across barline
        cadenceByMeasure[m] = clamp01(0.5 * (bestScores[prevFrame] + bestScores[currFrame]));
      }
    }
  }
  return cadenceByMeasure;
}

function extractSkylineByMeasure(
  input: StaticScoreInput,
  hand: Hand,
): Map<number, Array<{ relPhase: number; midi: number; durationTick: number; coord: ScoreCoord }>> {
  const byMeasure = new Map<
    number,
    Array<{ relPhase: number; midi: number; durationTick: number; coord: ScoreCoord }>
  >();

  for (let i = 0; i < input.onsetSlices.length; i++) {
    const slice = input.onsetSlices[i];
    if (slice.hand !== hand || slice.isGrace || slice.notes.length === 0) continue;
    const m = slice.measureIndex;
    const tl = input.measureTimelines[m];
    if (!tl) continue;

    let chosen = slice.notes[0];
    for (let k = 1; k < slice.notes.length; k++) {
      if (hand === "RH" ? slice.notes[k].midi > chosen.midi : slice.notes[k].midi < chosen.midi) {
        chosen = slice.notes[k];
      }
    }
    const mSpan = Math.max(1, tl.endTick - tl.startTick);
    const relPhase = (slice.onsetTick - tl.startTick) / mSpan;
    const coord =
      chosen.scoreCoord ?? makeScoreCoord(m, slice.onsetTick - tl.startTick, input.ticksPerQuarter);
    let list = byMeasure.get(m);
    if (!list) {
      list = [];
      byMeasure.set(m, list);
    }
    list.push({
      relPhase,
      midi: chosen.midi,
      durationTick: chosen.durationTick,
      coord,
    });
  }
  return byMeasure;
}

function alignMeasurePairDiffs(
  input: StaticScoreInput,
  protoStart: number,
  instStart: number,
  lengthMeasures: number,
  transposeSemitones: number,
  rhSky: ReturnType<typeof extractSkylineByMeasure>,
): { diffCoords: VariantDiffCoord[]; similarityPenalty: number } {
  const diffCoords: VariantDiffCoord[] = [];
  let matchedCount = 0;
  let totalCount = 0;

  for (let offset = 0; offset < lengthMeasures; offset++) {
    const pList = rhSky.get(protoStart + offset) ?? [];
    const iList = rhSky.get(instStart + offset) ?? [];
    totalCount += Math.max(pList.length, iList.length);

    if (pList.length === 0 && iList.length === 0) continue;

    // Mongeau-Sankoff style phase-paired matching within the measure
    const usedI = new Uint8Array(iList.length);
    for (let pIdx = 0; pIdx < pList.length; pIdx++) {
      const pNote = pList[pIdx];
      let bestJ = -1;
      let bestDist = Infinity;
      for (let jIdx = 0; jIdx < iList.length; jIdx++) {
        if (usedI[jIdx]) continue;
        const d = Math.abs(iList[jIdx].relPhase - pNote.relPhase);
        if (d <= 0.12 && d < bestDist) {
          bestDist = d;
          bestJ = jIdx;
        }
      }
      if (bestJ >= 0) {
        usedI[bestJ] = 1;
        const iNote = iList[bestJ];
        const expectedMidi = pNote.midi + transposeSemitones;
        // Check mod-12 octave equivalence or exact transposed pitch
        const diffMod12 = (((iNote.midi - expectedMidi) % 12) + 12) % 12;
        if (diffMod12 === 0 && Math.abs(iNote.midi - expectedMidi) <= 12) {
          matchedCount++;
        } else {
          diffCoords.push({
            coord: iNote.coord,
            measureIndex: instStart + offset,
            kind: "pitch",
            hand: "RH",
            prototypeMidi: pNote.midi,
            instanceMidi: iNote.midi,
            description: `m.${instStart + offset + 1} RH pitch variant (${pNote.midi} -> ${iNote.midi})`,
          });
        }
      } else {
        const fallbackCoord =
          iList[0]?.coord ?? makeScoreCoord(instStart + offset, 0, input.ticksPerQuarter);
        diffCoords.push({
          coord: fallbackCoord,
          measureIndex: instStart + offset,
          kind: "rhythm",
          hand: "RH",
          prototypeMidi: pNote.midi,
          description: `m.${instStart + offset + 1} omitted/rhythm shift vs prototype`,
        });
      }
    }

    for (let jIdx = 0; jIdx < iList.length; jIdx++) {
      if (!usedI[jIdx]) {
        diffCoords.push({
          coord: iList[jIdx].coord,
          measureIndex: instStart + offset,
          kind: "ornament",
          hand: "RH",
          instanceMidi: iList[jIdx].midi,
          description: `m.${instStart + offset + 1} added/ornamented RH note (midi ${iList[jIdx].midi})`,
        });
      }
    }
  }

  const ratio = totalCount > 0 ? matchedCount / totalCount : 1;
  return { diffCoords, similarityPenalty: clamp01(1 - ratio) };
}

function extractPassageClusters(
  input: StaticScoreInput,
  framesPerMeasure: number,
  features: ReturnType<typeof computeFrameFeatures>,
  ssmSim: Float32Array,
  ssmDelta: Int8Array,
  steps: StepBucket[],
): PassageCluster[] {
  const M = input.measureCount;
  const T = features.frameCount;
  if (M < 4 || T < 4) return [];

  const minFrames = 2 * framesPerMeasure; // >= 2 measures
  const rawMatches: RawDiagonalMatch[] = [];

  for (let d = minFrames; d < T; d++) {
    let runStart = -1;
    let dipCount = 0;
    let sumSim = 0;
    let countSim = 0;
    let deltaCounts: Map<number, number> | null = null;

    const flushRun = (runEnd: number) => {
      if (runStart < 0) return;
      const runLen = runEnd - runStart + 1;
      if (runLen >= minFrames && countSim > 0) {
        const aStartM = Math.floor(runStart / framesPerMeasure);
        const aEndM = Math.floor(runEnd / framesPerMeasure);
        const bStartM = Math.floor((runStart + d) / framesPerMeasure);
        const bEndM = Math.floor((runEnd + d) / framesPerMeasure);
        const lenA = aEndM - aStartM + 1;
        const lenB = bEndM - bStartM + 1;
        const lenM = Math.min(lenA, lenB);
        if (lenM >= 2 && bStartM > aStartM + lenM - 1) {
          let domDelta = 0;
          let maxC = -1;
          if (deltaCounts) {
            for (const [k, c] of deltaCounts.entries()) {
              if (c > maxC) {
                maxC = c;
                domDelta = k;
              }
            }
          }
          rawMatches.push({
            aStartM,
            aEndM: aStartM + lenM - 1,
            bStartM,
            bEndM: bStartM + lenM - 1,
            deltaSemitones: domDelta,
            meanSim: sumSim / countSim,
          });
        }
      }
      runStart = -1;
      dipCount = 0;
      sumSim = 0;
      countSim = 0;
      deltaCounts = null;
    };

    for (let i = 0; i + d < T; i++) {
      const j = i + d;
      if (!features.hasNotes[i] || !features.hasNotes[j]) {
        flushRun(i - 1);
        continue;
      }

      // 4-frame diagonal path enhancement requiring consistent transposition shift
      const refDelta = ssmDelta[i * T + j];
      const win = Math.min(4, T - j);
      let enh = 0;
      for (let k = 0; k < win; k++) {
        const sim = ssmSim[(i + k) * T + (j + k)];
        const dK = ssmDelta[(i + k) * T + (j + k)];
        enh += dK === refDelta ? sim : sim * 0.5;
      }
      enh /= Math.max(1, win);

      if (enh >= 0.78) {
        if (runStart < 0) {
          runStart = i;
          deltaCounts = new Map();
        }
        dipCount = 0;
        sumSim += enh;
        countSim++;
        deltaCounts!.set(refDelta, (deltaCounts!.get(refDelta) ?? 0) + 1);
      } else if (runStart >= 0 && enh >= 0.55 && dipCount === 0) {
        dipCount = 1;
        sumSim += enh;
        countSim++;
      } else {
        flushRun(i - 1);
      }
    }
    flushRun(T - d - 1);
  }

  if (rawMatches.length === 0) return [];

  // Sort by span length descending then similarity descending to keep strongest canonical passages
  rawMatches.sort((a, b) => {
    const lenDiff = b.aEndM - b.aStartM - (a.aEndM - a.aStartM);
    if (lenDiff !== 0) return lenDiff;
    return b.meanSim - a.meanSim;
  });

  interface RangeNode {
    startM: number;
    endM: number;
  }

  const nodes: RangeNode[] = [];
  const parent: number[] = [];

  const find = (x: number): number => {
    let cur = x;
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur]];
      cur = parent[cur];
    }
    return cur;
  };

  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const getOrCreateRangeNode = (startM: number, endM: number): number => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const inter = Math.max(0, Math.min(n.endM, endM) - Math.max(n.startM, startM) + 1);
      const uni = Math.max(n.endM, endM) - Math.min(n.startM, startM) + 1;
      if (inter / Math.max(1, uni) >= 0.7) {
        return i;
      }
    }
    const idx = nodes.length;
    nodes.push({ startM, endM });
    parent.push(idx);
    return idx;
  };

  const pairRecords: Array<{
    idxA: number;
    idxB: number;
    delta: number;
    sim: number;
  }> = [];

  for (const m of rawMatches) {
    const idxA = getOrCreateRangeNode(m.aStartM, m.aEndM);
    const idxB = getOrCreateRangeNode(m.bStartM, m.bEndM);
    if (idxA === idxB) continue;
    union(idxA, idxB);
    pairRecords.push({ idxA, idxB, delta: m.deltaSemitones, sim: m.meanSim });
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const r = find(i);
    const list = groups.get(r) ?? [];
    list.push(i);
    groups.set(r, list);
  }

  const rhSky = extractSkylineByMeasure(input, "RH");
  const stepsByMeasure = new Map<number, StepBucket[]>();
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    let arr = stepsByMeasure.get(st.measureIndex);
    if (!arr) {
      arr = [];
      stepsByMeasure.set(st.measureIndex, arr);
    }
    arr.push(st);
  }

  const clusters: PassageCluster[] = [];
  let clusterCounter = 0;

  // Sort groups deterministically by earliest startM
  const sortedGroups = Array.from(groups.values())
    .map((nodeIndices) =>
      nodeIndices
        .map((idx) => ({ idx, ...nodes[idx] }))
        .sort((a, b) => a.startM - b.startM || b.endM - a.endM),
    )
    .filter((g) => g.length >= 2)
    .sort((a, b) => a[0].startM - b[0].startM);

  for (const group of sortedGroups) {
    // Filter out overlapping instances within the same cluster
    const nonOverlapping: Array<{ idx: number; startM: number; endM: number }> = [];
    for (const item of group) {
      const overlaps = nonOverlapping.some(
        (prev) => !(item.endM < prev.startM || item.startM > prev.endM),
      );
      if (!overlaps) nonOverlapping.push(item);
    }
    if (nonOverlapping.length < 2) continue;

    const clusterId = `cluster-${clusterCounter}`;
    const labelChar = String.fromCharCode(65 + (clusterCounter % 26));
    const label = clusterCounter < 26 ? labelChar : `${labelChar}${Math.floor(clusterCounter / 26)}`;
    clusterCounter++;

    const protoNode = nonOverlapping[0];
    const protoInstanceId = `${clusterId}-inst-0`;

    const instances: PassageInstance[] = [];
    for (let k = 0; k < nonOverlapping.length; k++) {
      const node = nonOverlapping[k];
      const instanceId = `${clusterId}-inst-${k}`;
      const isPrototype = k === 0;
      const lenM = Math.min(protoNode.endM - protoNode.startM + 1, node.endM - node.startM + 1);

      let delta = 0;
      let musicSim = 1.0;

      if (!isPrototype) {
        // Compute direct measure-aligned similarity & dominant transposition vs prototype
        let simSum = 0;
        const deltaVotes = new Map<number, number>();
        for (let off = 0; off < lenM; off++) {
          for (let f = 0; f < framesPerMeasure; f++) {
            const fa = (protoNode.startM + off) * framesPerMeasure + f;
            const fb = (node.startM + off) * framesPerMeasure + f;
            simSum += ssmSim[fa * T + fb];
            const df = ssmDelta[fa * T + fb];
            deltaVotes.set(df, (deltaVotes.get(df) ?? 0) + 1);
          }
        }
        musicSim = clamp01(simSum / Math.max(1, lenM * framesPerMeasure));
        let bestCount = -1;
        for (const [dVal, cnt] of deltaVotes.entries()) {
          if (cnt > bestCount) {
            bestCount = cnt;
            delta = dVal;
          }
        }
        // Also check direct pair records if needed
        if (bestCount <= 0) {
          const rec = pairRecords.find(
            (r) =>
              (r.idxA === protoNode.idx && r.idxB === node.idx) ||
              (r.idxB === protoNode.idx && r.idxA === node.idx),
          );
          if (rec) {
            delta = rec.idxA === protoNode.idx ? rec.delta : -rec.delta;
            musicSim = rec.sim;
          }
        }
      }

      const align = isPrototype
        ? { diffCoords: [] as VariantDiffCoord[], similarityPenalty: 0 }
        : alignMeasurePairDiffs(input, protoNode.startM, node.startM, lenM, delta, rhSky);

      const finalSim = isPrototype
        ? 1.0
        : clamp01(Math.min(musicSim, 1 - align.similarityPenalty * 0.5));

      let variantKind: PassageVariantKind = "exact";
      if (!isPrototype) {
        if (delta !== 0) {
          variantKind = "transposed";
        } else if (finalSim < 0.92 || align.diffCoords.length > 0) {
          variantKind = "ornamented";
        }
      }

      instances.push({
        instanceId,
        clusterId,
        startMeasureIndex: node.startM,
        endMeasureIndex: node.endM,
        startCoord: { measureIndex: node.startM, beatNum: 0, beatDen: 1 },
        endCoord: { measureIndex: node.endM + 1, beatNum: 0, beatDen: 1 },
        isPrototype,
        transpositionSemitones: delta,
        musicSimilarity: finalSim,
        fingeringIsomorphism: 1.0,
        motorReuse: isPrototype ? 1.0 : finalSim >= 0.92 && delta === 0 ? 0.95 : finalSim * 0.85,
        variantKind,
        diffCoords: align.diffCoords,
      });
    }

    // Detect Chaffin SwitchPoints where continuations immediately following two instances diverge
    const switchPoints: SwitchPoint[] = [];
    for (let aIdx = 0; aIdx < instances.length; aIdx++) {
      const instA = instances[aIdx];
      const nextA = instA.endMeasureIndex + 1;
      if (nextA >= M) continue;

      const altMidis: number[][] = [];
      const altLabels: string[] = [];
      let bestMinSim = 1.0;

      for (let bIdx = 0; bIdx < instances.length; bIdx++) {
        if (aIdx === bIdx) continue;
        const instB = instances[bIdx];
        const nextB = instB.endMeasureIndex + 1;
        if (nextB >= M) continue;

        const contMeasures = Math.min(2, M - nextA, M - nextB);
        if (contMeasures < 1) continue;

        let contSimSum = 0;
        let contFrames = 0;
        const expectedShift =
          (((instB.transpositionSemitones - instA.transpositionSemitones) % 12) + 12) % 12;
        for (let off = 0; off < contMeasures; off++) {
          for (let f = 0; f < framesPerMeasure; f++) {
            const fa = (nextA + off) * framesPerMeasure + f;
            const fb = (nextB + off) * framesPerMeasure + f;
            if (!features.hasNotes[fa] && !features.hasNotes[fb]) continue;
            let chromaDot = 0;
            for (let pc = 0; pc < 12; pc++) {
              chromaDot +=
                features.chroma[fa * CHROMA_SIZE + ((pc + expectedShift) % 12)] *
                features.chroma[fb * CHROMA_SIZE + pc];
            }
            const intervalDot = dotSlice(
              features.intervalHist,
              fa * INTERVAL_BINS,
              fb * INTERVAL_BINS,
              INTERVAL_BINS,
            );
            const rhythmDot = dotSlice(
              features.rhythm,
              fa * RHYTHM_SIZE,
              fb * RHYTHM_SIZE,
              RHYTHM_SIZE,
            );
            contSimSum += 0.5 * chromaDot + 0.3 * intervalDot + 0.2 * rhythmDot;
            contFrames++;
          }
        }
        const contSim = contFrames > 0 ? contSimSum / contFrames : 1.0;
        if (contSim < 0.55) {
          if (contSim < bestMinSim) bestMinSim = contSim;
          altLabels.push(`${label}${bIdx + 1} (m.${nextB + 1})`);
          // Prefer populating alternateBranchMidis from same-key instance first
          if (
            altMidis.length === 0 ||
            instB.transpositionSemitones === instA.transpositionSemitones
          ) {
            altMidis.length = 0;
            for (let off = 0; off < contMeasures; off++) {
              const mSteps = stepsByMeasure.get(nextB + off) ?? [];
              for (let s = 0; s < mSteps.length; s++) {
                altMidis.push(mSteps[s].midis.slice());
              }
            }
          }
        }
      }

      if (altLabels.length > 0 && altMidis.length > 0) {
        const sp: SwitchPoint = {
          switchId: `sw-${clusterId}-${aIdx}`,
          clusterId,
          instanceId: instA.instanceId,
          coord: { measureIndex: nextA, beatNum: 0, beatDen: 1 },
          measureIndex: nextA,
          priorSharedMeasures: instA.endMeasureIndex - instA.startMeasureIndex + 1,
          alternateBranchMidis: altMidis,
          alternateBranchLabels: altLabels,
          description: `${label}${aIdx + 1} 分叉口 (m.${nextA + 1}, 异于 ${altLabels[0]})`,
        };
        instA.switchPoint = sp;
        switchPoints.push(sp);
      }
    }

    const nonProtoMeasures = instances
      .slice(1)
      .reduce((acc, inst) => acc + (inst.endMeasureIndex - inst.startMeasureIndex + 1) * inst.motorReuse, 0);
    const totalCoveredMeasures = instances.reduce(
      (acc, inst) => acc + (inst.endMeasureIndex - inst.startMeasureIndex + 1),
      0,
    );

    clusters.push({
      clusterId,
      label,
      prototypeInstanceId: protoInstanceId,
      instances,
      leverageRatio: clamp01(nonProtoMeasures / Math.max(1, M)),
      totalCoveredMeasures,
      switchPoints,
    });
  }

  // Sort clusters by leverageRatio descending
  clusters.sort((a, b) => b.leverageRatio - a.leverageRatio || a.instances[0].startMeasureIndex - b.instances[0].startMeasureIndex);
  return clusters;
}

function getMacroBoundaryInfo(
  m: number,
  input: StaticScoreInput,
  noveltyByMeasure: Float32Array,
  cadenceByMeasure: Float32Array,
): { score: number; reason: MacroBoundaryReason; isHard: boolean } {
  const M = input.measureCount;
  if (m <= 0 || m >= M) return { score: 0, reason: "start", isHard: true };

  const metaCurr = input.measureStructuralMeta?.[m];
  const metaPrev = input.measureStructuralMeta?.[m - 1];

  if (metaCurr?.rehearsalMark) {
    return { score: 1.0, reason: "rehearsal", isHard: true };
  }
  if (
    metaCurr?.barlineLeft === "repeat-forward" ||
    metaPrev?.barlineRight === "repeat-backward" ||
    metaPrev?.barlineRight === "repeat-both" ||
    metaCurr?.endings?.some((e) => e.type === "start")
  ) {
    return { score: 1.0, reason: "repeat", isHard: true };
  }
  if (metaCurr?.barlineLeft === "double" || metaPrev?.barlineRight === "double") {
    return { score: 0.95, reason: "double-bar", isHard: true };
  }
  if (
    metaCurr?.keyFifths !== undefined &&
    metaPrev?.keyFifths !== undefined &&
    metaCurr.keyFifths !== metaPrev.keyFifths
  ) {
    return { score: 0.92, reason: "key-change", isHard: true };
  }
  if (metaCurr?.hasTimeSigChange) {
    const tlCurr = input.measureTimelines[m];
    const tlPrev = input.measureTimelines[m - 1];
    if (
      tlCurr &&
      tlPrev &&
      (tlCurr.timeBeats !== tlPrev.timeBeats || tlCurr.timeBeatType !== tlPrev.timeBeatType)
    ) {
      return { score: 0.88, reason: "time-change", isHard: true };
    }
  }
  if (metaCurr?.hasTempoChange) {
    return { score: 0.78, reason: "tempo-change", isHard: false };
  }

  const cad = cadenceByMeasure[m] ?? 0;
  const nov = noveltyByMeasure[m] ?? 0;
  const fermataBonus = metaPrev?.hasFermata ? 0.3 : 0;
  const restBonus = metaPrev?.isFullMeasureRest ? 0.25 : 0;
  const softScore = clamp01(0.45 * nov + 0.35 * cad + fermataBonus + restBonus);
  const reason: MacroBoundaryReason =
    cad >= nov && cad > 0.2 ? "cadence" : nov > 0.2 ? "novelty" : "length-cap";
  return { score: softScore, reason, isHard: false };
}

function segmentMacroSections(
  input: StaticScoreInput,
  noveltyByMeasure: Float32Array,
  cadenceByMeasure: Float32Array,
  clusters: PassageCluster[],
): MacroSection[] {
  const M = input.measureCount;
  if (M === 0) return [];

  // Cluster instance start points boost macro boundary alignment
  const clusterStartBoost = new Float32Array(M + 1);
  for (const cl of clusters) {
    for (const inst of cl.instances) {
      if (inst.startMeasureIndex > 0 && inst.startMeasureIndex < M) {
        clusterStartBoost[inst.startMeasureIndex] = Math.max(
          clusterStartBoost[inst.startMeasureIndex],
          0.35,
        );
      }
    }
  }

  if (M < 4) {
    return [
      {
        sectionId: "sec-0",
        index: 0,
        startMeasureIndex: 0,
        endMeasureIndex: M - 1,
        startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
        endCoord: { measureIndex: M, beatNum: 0, beatDen: 1 },
        measureCount: M,
        label: input.measureStructuralMeta?.[0]?.rehearsalMark
          ? `Section [${input.measureStructuralMeta[0].rehearsalMark}] (m.1–${M})`
          : `Section A (m.1–${M})`,
        boundaryReason: "start",
        chunkIds: [],
      },
    ];
  }

  // DP partitioning into [4..16] measure sections
  const dp = new Float64Array(M + 1).fill(-Infinity);
  const back = new Int16Array(M + 1).fill(-1);
  const backReason: MacroBoundaryReason[] = new Array(M + 1).fill("length-cap");
  dp[0] = 0;

  const boundaryInfo = Array.from({ length: M + 1 }, (_, m) =>
    getMacroBoundaryInfo(m, input, noveltyByMeasure, cadenceByMeasure),
  );

  for (let end = 4; end <= M; end++) {
    const minStart = Math.max(0, end - 16);
    const maxStart = end - 4;
    for (let start = minStart; start <= maxStart; start++) {
      if (!Number.isFinite(dp[start])) continue;
      const len = end - start;
      const info = boundaryInfo[end];
      const bScore =
        end === M
          ? 0.5
          : (info.isHard ? 2.5 * info.score : info.score) + clusterStartBoost[end];
      // Prefer balanced 8-measure sections and power-of-2 phrases (4, 8, 12, 16)
      const lenDev = Math.log2(len / 8);
      const lenPenalty = 0.35 * lenDev * lenDev;
      const symBonus = len === 8 || len === 4 || len === 16 ? 0.12 : len % 2 === 0 ? 0.05 : 0;
      const candidate = dp[start] + bScore - lenPenalty + symBonus;
      if (candidate > dp[end]) {
        dp[end] = candidate;
        back[end] = start;
        backReason[end] = start === 0 ? "start" : boundaryInfo[start].reason;
      }
    }
  }

  const bounds: Array<{ start: number; end: number; reason: MacroBoundaryReason }> = [];
  let cur = M;
  while (cur > 0) {
    const prev = back[cur];
    if (prev < 0) {
      // Defensive fallback (unreachable for M >= 4)
      bounds.unshift({ start: 0, end: cur - 1, reason: "start" });
      break;
    }
    bounds.unshift({
      start: prev,
      end: cur - 1,
      reason: prev === 0 ? "start" : boundaryInfo[prev].reason,
    });
    cur = prev;
  }

  return bounds.map((b, idx) => {
    const mark = input.measureStructuralMeta?.[b.start]?.rehearsalMark;
    const alpha = String.fromCharCode(65 + (idx % 26));
    const rangeStr = `m.${b.start + 1}–${b.end + 1}`;
    const label = mark ? `Section [${mark}] (${rangeStr})` : `Section ${alpha} (${rangeStr})`;
    return {
      sectionId: `sec-${idx}`,
      index: idx,
      startMeasureIndex: b.start,
      endMeasureIndex: b.end,
      startCoord: { measureIndex: b.start, beatNum: 0, beatDen: 1 },
      endCoord: { measureIndex: b.end + 1, beatNum: 0, beatDen: 1 },
      measureCount: b.end - b.start + 1,
      label,
      boundaryReason: b.reason,
      chunkIds: [],
    };
  });
}

function segmentMotorChunks(
  input: StaticScoreInput,
  macroSections: MacroSection[],
  steps: StepBucket[],
  clusters: PassageCluster[],
  cadenceByMeasure: Float32Array,
): MotorChunk[] {
  const M = input.measureCount;
  if (M === 0) return [];

  const rhLbdm = computeHandLbdmBoundaryStrength(input.onsetSlices, input.measureTimelines, "RH");
  const lhLbdm = computeHandLbdmBoundaryStrength(input.onsetSlices, input.measureTimelines, "LH");

  // Step count & polyphony stats per measure
  const stepsPerMeasure = new Int32Array(M);
  const notesPerMeasure = new Int32Array(M);
  const avgMidiByMeasure = new Float32Array(M);
  for (let i = 0; i < steps.length; i++) {
    const m = steps[i].measureIndex;
    if (m >= 0 && m < M) stepsPerMeasure[m]++;
  }
  for (let i = 0; i < input.noteEvents.length; i++) {
    const ev = input.noteEvents[i];
    if (ev.isTieStop) continue;
    const m = ev.measureIndex;
    if (m >= 0 && m < M) {
      notesPerMeasure[m]++;
      avgMidiByMeasure[m] += ev.midi;
    }
  }
  for (let m = 0; m < M; m++) {
    if (notesPerMeasure[m] > 0) avgMidiByMeasure[m] /= notesPerMeasure[m];
  }

  // Parallelism (GPR 6) from PassageCluster starts
  const parallelBoost = new Float32Array(M + 1);
  for (const cl of clusters) {
    for (const inst of cl.instances) {
      parallelBoost[inst.startMeasureIndex] = Math.max(
        parallelBoost[inst.startMeasureIndex],
        0.4,
      );
    }
  }

  // Slur boundary & cross-barline slur detection
  const slurBreakAtBar = new Float32Array(M + 1);
  const crossBarlineAnacrusis = new Map<
    number,
    { startCoord: ScoreCoord; leadInQuarterBeats: number }
  >();

  for (const slur of input.slurSpans ?? []) {
    const endM = slur.endCoord.measureIndex;
    const endBeats = slur.endCoord.beatNum / slur.endCoord.beatDen;
    const tlEnd = input.measureTimelines[endM];
    const endMeasureBeats = getMeasureQuarterLength(tlEnd);
    if (endBeats >= endMeasureBeats * 0.65 && endM + 1 <= M) {
      slurBreakAtBar[endM + 1] = Math.max(slurBreakAtBar[endM + 1], 0.55);
    }

    if (slur.crossesBarline && slur.startCoord.measureIndex < slur.endCoord.measureIndex) {
      const startM = slur.startCoord.measureIndex;
      const targetBarM = startM + 1;
      const tlStart = input.measureTimelines[startM];
      const mQuarterLen = getMeasureQuarterLength(tlStart);
      const startQuarterOffset = slur.startCoord.beatNum / slur.startCoord.beatDen;
      const leadInBeats = mQuarterLen - startQuarterOffset;
      if (
        startQuarterOffset > 0 &&
        leadInBeats > 0 &&
        leadInBeats <= mQuarterLen * 0.5 + 1e-6
      ) {
        const existing = crossBarlineAnacrusis.get(targetBarM);
        if (!existing || leadInBeats < existing.leadInQuarterBeats) {
          crossBarlineAnacrusis.set(targetBarM, {
            startCoord: slur.startCoord,
            leadInQuarterBeats: leadInBeats,
          });
        }
      }
    }
  }

  const measureBoundaryScore = new Float32Array(M + 1);
  for (let m = 1; m < M; m++) {
    const lbdm = 0.7 * rhLbdm[m] + 0.3 * lhLbdm[m];
    const cad = cadenceByMeasure[m] ?? 0;
    const densityDiff =
      Math.abs(stepsPerMeasure[m] - stepsPerMeasure[m - 1]) /
      Math.max(1, stepsPerMeasure[m] + stepsPerMeasure[m - 1]);
    const regDiff =
      notesPerMeasure[m] > 0 && notesPerMeasure[m - 1] > 0
        ? Math.min(1, Math.abs(avgMidiByMeasure[m] - avgMidiByMeasure[m - 1]) / 12)
        : 0;
    const texChange = 0.6 * densityDiff + 0.4 * regDiff;
    const fermata = input.measureStructuralMeta?.[m - 1]?.hasFermata ? 0.6 : 0;

    measureBoundaryScore[m] = clamp01(
      0.3 * slurBreakAtBar[m] +
        0.28 * lbdm +
        0.18 * cad +
        0.14 * texChange +
        0.25 * parallelBoost[m] +
        fermata,
    );
  }

  const chunks: MotorChunk[] = [];
  let chunkCounter = 0;

  for (const sec of macroSections) {
    const sStart = sec.startMeasureIndex;
    const sEnd = sec.endMeasureIndex;
    const secLen = sEnd - sStart + 1;

    // DP inside [sStart .. sEnd] with chunk lengths in [1..4]
    const dp = new Float64Array(secLen + 1).fill(-Infinity);
    const back = new Int16Array(secLen + 1).fill(-1);
    dp[0] = 0;

    const firstIsPickup =
      sStart === 0 &&
      Boolean(input.measureTimelines[0]?.isPickup) &&
      getActualMeasureQuarterLength(input.measureTimelines[0], input.ticksPerQuarter) <=
        getMeasureQuarterLength(input.measureTimelines[1] ?? input.measureTimelines[0]) * 0.5 + 1e-6;

    for (let end = 1; end <= secLen; end++) {
      const minStart = Math.max(0, end - 4);
      for (let start = minStart; start < end; start++) {
        if (!Number.isFinite(dp[start])) continue;
        // Avoid leaving an explicit pickup measure 0 isolated as a 1-measure orphan when secLen >= 2
        if (firstIsPickup && start === 0 && end === 1 && secLen >= 2) {
          continue;
        }
        const len = end - start;
        const absStart = sStart + start;
        const absEnd = sStart + end - 1;

        let spanSteps = 0;
        for (let m = absStart; m <= absEnd; m++) {
          spanSteps += stepsPerMeasure[m];
        }
        const avgSteps = spanSteps / len;

        // Density-adapted target chunk length (in measures)
        const targetLen = avgSteps > 12 ? 1.5 : avgSteps >= 4 ? 2.5 : 3.5;
        const lenDev = Math.log2(len / targetLen);
        const lenPenalty = 0.65 * lenDev * lenDev;
        const symBonus = len === 2 || len === 4 ? 0.14 : 0;
        const bScore = end === secLen ? 0.4 : measureBoundaryScore[sStart + end];

        const score = dp[start] + bScore - lenPenalty + symBonus;
        if (score > dp[end]) {
          dp[end] = score;
          back[end] = start;
        }
      }
    }

    const secSpans: Array<{ startM: number; endM: number }> = [];
    let cur = secLen;
    while (cur > 0) {
      const prev = back[cur];
      if (prev < 0) {
        secSpans.unshift({ startM: sStart, endM: sStart + cur - 1 });
        break;
      }
      secSpans.unshift({ startM: sStart + prev, endM: sStart + cur - 1 });
      cur = prev;
    }

    for (const span of secSpans) {
      let stepCount = 0;
      for (let m = span.startM; m <= span.endM; m++) {
        stepCount += stepsPerMeasure[m];
      }
      const mCount = span.endM - span.startM + 1;
      const isInitialPickup =
        span.startM === 0 && Boolean(input.measureTimelines[0]?.isPickup);
      const pickupBeats = isInitialPickup
        ? Math.min(
            getMeasureQuarterLength(input.measureTimelines[0]) * 0.5,
            getActualMeasureQuarterLength(input.measureTimelines[0], input.ticksPerQuarter),
          )
        : 0;

      // Check polyphonic overlap at end boundary (notes sustaining across barline)
      const endBarTick = input.measureTimelines[span.endM]?.endTick ?? Infinity;
      let overlapFlag = false;
      for (let i = 0; i < input.noteEvents.length; i++) {
        const ev = input.noteEvents[i];
        if (
          ev.measureIndex === span.endM &&
          ev.onsetTick < endBarTick &&
          ev.onsetTick + ev.durationTick > endBarTick
        ) {
          overlapFlag = true;
          break;
        }
      }

      const chunkId = `chunk-${chunkCounter++}`;
      sec.chunkIds.push(chunkId);

      chunks.push({
        chunkId,
        index: chunks.length,
        sectionId: sec.sectionId,
        startMeasureIndex: span.startM,
        endMeasureIndex: span.endM,
        startCoord: { measureIndex: span.startM, beatNum: 0, beatDen: 1 },
        endCoord: { measureIndex: span.endM + 1, beatNum: 0, beatDen: 1 },
        measureCount: mCount,
        stepCount,
        densityStepsPerMeasure: stepCount / Math.max(1, mCount),
        hasAnacrusisLeadIn: isInitialPickup,
        anacrusisBeats: pickupBeats,
        overlapFlag,
        boundaryConfidence:
          span.startM === 0 ? 1.0 : Math.max(0.4, measureBoundaryScore[span.startM]),
      });
    }
  }

  // Apply cross-barline anacrusis lead-in snap (<= 0.5 measure) seamlessly across adjacent chunks
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const curr = chunks[i];
    const boundaryBar = curr.startCoord.measureIndex;
    const anacrusis = crossBarlineAnacrusis.get(boundaryBar);
    if (!anacrusis) continue;
    // Ensure prev chunk retains at least its opening half-measure
    if (prev.endMeasureIndex === boundaryBar - 1) {
      prev.endCoord = anacrusis.startCoord;
      curr.startCoord = anacrusis.startCoord;
      curr.startMeasureIndex = anacrusis.startCoord.measureIndex;
      curr.hasAnacrusisLeadIn = true;
      curr.anacrusisBeats = anacrusis.leadInQuarterBeats;
    }
  }

  return chunks;
}

function buildStaticCandidateCues(
  input: StaticScoreInput,
  macroSections: MacroSection[],
  passageClusters: PassageCluster[],
): PerformanceCue[] {
  const cues: PerformanceCue[] = [];

  for (const sec of macroSections) {
    cues.push({
      cueId: `cue-struct-${sec.sectionId}`,
      kind: "structural",
      roles: ["structural"],
      priorityWeight: 1.5,
      coord: sec.startCoord,
      measureIndex: sec.startMeasureIndex,
      label: sec.label,
      collapsed: false,
      isPrimary: true,
      sectionId: sec.sectionId,
    });
  }

  for (const cl of passageClusters) {
    for (const sp of cl.switchPoints) {
      cues.push({
        cueId: `cue-${sp.switchId}`,
        kind: "switch",
        roles: ["switch"],
        priorityWeight: 2.0,
        coord: sp.coord,
        measureIndex: sp.measureIndex,
        label: sp.description,
        collapsed: false,
        isPrimary: true,
        switchPointId: sp.switchId,
      });
    }
  }

  for (let m = 0; m < input.measureCount; m++) {
    const meta = input.measureStructuralMeta?.[m];
    if (!meta) continue;
    const tags: string[] = [];
    if (meta.hasFermata) tags.push("延长号/气口");
    if (meta.hasTempoChange && m > 0) tags.push("速度变化");
    if (meta.hasTimeSigChange && m > 0) tags.push("拍号变化");
    if (tags.length > 0) {
      cues.push({
        cueId: `cue-exp-m${m}`,
        kind: "expressive",
        roles: ["expressive"],
        priorityWeight: 0.5,
        coord: { measureIndex: m, beatNum: 0, beatDen: 1 },
        measureIndex: m,
        label: `m.${m + 1} ${tags.join(" · ")}`,
        collapsed: true,
        isPrimary: false,
      });
    }
  }

  return cues;
}

/**
 * Pure TypeScript 4-stage symbolic chunking pipeline (zero XML DOM access).
 * Computes MacroSections (4–16m), density-adapted ScoreCoord-anchored MotorChunks (1–4m),
 * transposition-invariant SSM PassageClusters with SwitchPoint pitch skeletons,
 * and initial candidate PerformanceCues.
 */
export function analyzeScoreStatic(input: StaticScoreInput): StaticChunkingResult {
  const t0 = performance.now();
  const M = input.measureCount;

  if (M <= 0 || input.noteEvents.length === 0) {
    return {
      measureCount: Math.max(0, M),
      macroSections: [],
      motorChunks: [],
      passageClusters: [],
      candidateCues: [],
      staticTimeMs: performance.now() - t0,
      degradedToWholeMeasureSsm: M > 250,
    };
  }

  const degradedToWholeMeasureSsm = M > 250;
  const framesPerMeasure = degradedToWholeMeasureSsm ? 1 : 2;

  const steps = buildCrossHandSteps(input.noteEvents);
  const features = computeFrameFeatures(input, framesPerMeasure);
  const { ssmSim, ssmDelta, noveltyByMeasure } = computeSsmAndNovelty(
    features,
    framesPerMeasure,
  );
  const cadenceByMeasure = computeHarmAnCadenceScores(features, framesPerMeasure);

  const passageClusters = extractPassageClusters(
    input,
    framesPerMeasure,
    features,
    ssmSim,
    ssmDelta,
    steps,
  );
  const macroSections = segmentMacroSections(
    input,
    noveltyByMeasure,
    cadenceByMeasure,
    passageClusters,
  );
  const motorChunks = segmentMotorChunks(
    input,
    macroSections,
    steps,
    passageClusters,
    cadenceByMeasure,
  );
  const candidateCues = buildStaticCandidateCues(input, macroSections, passageClusters);

  return {
    measureCount: M,
    macroSections,
    motorChunks,
    passageClusters,
    candidateCues,
    staticTimeMs: performance.now() - t0,
    degradedToWholeMeasureSsm,
  };
}
