import { scoreCoordToTick } from "../domain/scoreCoord";
import { computeHandRoot } from "../solver/costModel";
import type {
  Finger,
  Hand,
  NoteEvent,
  OnsetSlice,
  PracticeMode,
  SolveResult,
  TransitionCue,
} from "../domain/types";
import type {
  ChunkJunction,
  MotorOverlayOptions,
  MotorOverlayResult,
  PassageCluster,
  PassageInstance,
  PerformanceCue,
  PerformanceCueKind,
  StaticChunkingResult,
  StaticScoreInput,
  SwitchPoint,
  VariantDiffCoord,
} from "./types";

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isTargetHand(hand: Hand, practiceMode: PracticeMode): boolean {
  if (practiceMode === "both") return true;
  if (practiceMode === "rh-only") return hand === "RH";
  return hand === "LH";
}

function buildCompactStepTicks(
  onsetSlices: OnsetSlice[],
  noteEvents: NoteEvent[],
  practiceMode: PracticeMode,
): number[] {
  // Fast zero-string-allocation path using already-ordered onsetSlices when no grace ambiguity exists
  if (onsetSlices.length > 0) {
    const stepTicks: number[] = [];
    let lastTick = -1;
    let lastIsGrace = false;
    let lastGraceOrder = -1;
    for (let i = 0; i < onsetSlices.length; i++) {
      const s = onsetSlices[i];
      if (!isTargetHand(s.hand, practiceMode) || s.notes.length === 0) continue;
      const gOrder = s.isGrace ? (s.notes[0].graceOrder ?? 0) : -1;
      if (s.onsetTick !== lastTick || s.isGrace !== lastIsGrace || gOrder !== lastGraceOrder) {
        stepTicks.push(s.onsetTick);
        lastTick = s.onsetTick;
        lastIsGrace = s.isGrace;
        lastGraceOrder = gOrder;
      }
    }
    return stepTicks;
  }

  // Fallback for slice-less synthetic inputs
  const raw: number[] = [];
  for (let i = 0; i < noteEvents.length; i++) {
    const ev = noteEvents[i];
    if (ev.isTieStop || !isTargetHand(ev.hand, practiceMode)) continue;
    raw.push(ev.onsetTick);
  }
  raw.sort((a, b) => a - b);
  const deduped: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (i === 0 || raw[i] !== raw[i - 1]) deduped.push(raw[i]);
  }
  return deduped;
}

function findFirstStepAtOrAfterTick(stepTicks: number[], targetTick: number): number {
  if (stepTicks.length === 0) return 0;
  let lo = 0;
  let hi = stepTicks.length - 1;
  let ans = stepTicks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (stepTicks[mid] >= targetTick) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

function buildSlicesByHandMeasure(
  onsetSlices: OnsetSlice[],
  measureCount: number,
): { rhSlicesByMeasure: OnsetSlice[][]; lhSlicesByMeasure: OnsetSlice[][] } {
  const rhSlicesByMeasure: OnsetSlice[][] = new Array(measureCount);
  const lhSlicesByMeasure: OnsetSlice[][] = new Array(measureCount);
  for (let m = 0; m < measureCount; m++) {
    rhSlicesByMeasure[m] = [];
    lhSlicesByMeasure[m] = [];
  }
  for (let i = 0; i < onsetSlices.length; i++) {
    const s = onsetSlices[i];
    if (s.measureIndex < 0 || s.measureIndex >= measureCount) continue;
    if (s.hand === "RH") rhSlicesByMeasure[s.measureIndex].push(s);
    else lhSlicesByMeasure[s.measureIndex].push(s);
  }
  return { rhSlicesByMeasure, lhSlicesByMeasure };
}

function recomputeClusterMotorReuse(
  staticClusters: PassageCluster[],
  scoreDoc: StaticScoreInput,
  solveResult: SolveResult,
  practiceMode: PracticeMode,
  rhSlicesByMeasure: OnsetSlice[][],
  lhSlicesByMeasure: OnsetSlice[][],
): PassageCluster[] {
  if (staticClusters.length === 0) return [];

  const activeHands: Hand[] =
    practiceMode === "both" ? ["RH", "LH"] : practiceMode === "rh-only" ? ["RH"] : ["LH"];

  return staticClusters.map((cluster) => {
    const proto =
      cluster.instances.find((inst) => inst.instanceId === cluster.prototypeInstanceId) ??
      cluster.instances[0];
    if (!proto) return cluster;

    const updatedInstances: PassageInstance[] = cluster.instances.map((inst) => {
      if (inst.instanceId === proto.instanceId) {
        return {
          ...inst,
          fingeringIsomorphism: 1.0,
          motorReuse: 1.0,
        };
      }

      const lenM = Math.min(
        proto.endMeasureIndex - proto.startMeasureIndex + 1,
        inst.endMeasureIndex - inst.startMeasureIndex + 1,
      );
      const fingerDiffs: VariantDiffCoord[] = [];
      let matchedFingers = 0;
      let comparedFingers = 0;

      for (const hand of activeHands) {
        const byMeasure = hand === "RH" ? rhSlicesByMeasure : lhSlicesByMeasure;
        for (let off = 0; off < lenM; off++) {
          const pRaw = byMeasure[proto.startMeasureIndex + off];
          const iRaw = byMeasure[inst.startMeasureIndex + off];
          if (!pRaw || !iRaw || pRaw.length === 0 || iRaw.length === 0) continue;
          let pi = 0;
          let ii = 0;
          while (pi < pRaw.length && ii < iRaw.length) {
            while (pi < pRaw.length && pRaw[pi].isGrace) pi++;
            while (ii < iRaw.length && iRaw[ii].isGrace) ii++;
            if (pi >= pRaw.length || ii >= iRaw.length) break;
            const pNotes = pRaw[pi].notes;
            const iNotes = iRaw[ii].notes;
            const noteCount = Math.min(pNotes.length, iNotes.length);
            for (let nIdx = 0; nIdx < noteCount; nIdx++) {
              const pNote = pNotes[nIdx];
              const iNote = iNotes[nIdx];
              const fProto = solveResult.fingerByNoteUid[pNote.noteUid];
              const fInst = solveResult.fingerByNoteUid[iNote.noteUid];
              if (!fProto || !fInst) continue;
              comparedFingers++;
              if (fProto === fInst) {
                matchedFingers++;
              } else {
                const tl = scoreDoc.measureTimelines[iNote.measureIndex];
                const coord =
                  iNote.scoreCoord ??
                  {
                    measureIndex: iNote.measureIndex,
                    beatNum: iNote.onsetTick - (tl?.startTick ?? 0),
                    beatDen: Math.max(1, scoreDoc.ticksPerQuarter),
                  };
                fingerDiffs.push({
                  coord,
                  measureIndex: iNote.measureIndex,
                  kind: "fingering",
                  hand,
                  noteUid: iNote.noteUid,
                  prototypeMidi: pNote.midi,
                  instanceMidi: iNote.midi,
                  description: `m.${iNote.measureIndex + 1} ${hand} 指法差异 (${fProto} vs ${fInst})`,
                });
              }
            }
            pi++;
            ii++;
          }
        }
      }

      const fingeringIsomorphism =
        comparedFingers > 0 ? clamp01(matchedFingers / comparedFingers) : 1.0;

      const motorReuse = clamp01(0.4 * inst.musicSimilarity + 0.6 * fingeringIsomorphism);
      const mergedDiffs =
        fingerDiffs.length > 0
          ? [...inst.diffCoords.filter((d) => d.kind !== "fingering"), ...fingerDiffs]
          : inst.diffCoords;

      return {
        ...inst,
        fingeringIsomorphism,
        motorReuse,
        diffCoords: mergedDiffs,
      };
    });

    const nonProtoWeighted = updatedInstances
      .slice(1)
      .reduce(
        (acc, inst) => acc + (inst.endMeasureIndex - inst.startMeasureIndex + 1) * inst.motorReuse,
        0,
      );

    return {
      ...cluster,
      instances: updatedInstances,
      leverageRatio: clamp01(nonProtoWeighted / Math.max(1, staticClusters[0] ? scoreDoc.measureCount : 1)),
    };
  });
}

function cueHazardScore(cue: TransitionCue, dt: number): number {
  switch (cue.type) {
    case "unreachable-span":
    case "anchor-conflict":
      return 1.0;
    case "position-shift":
      return cue.severity === "danger" ? 0.9 : cue.severity === "warn" ? 0.6 : 0.25;
    case "wide-stretch":
      return cue.severity === "warn" ? 0.6 : 0.3;
    case "thumb-under":
    case "cross-over":
      return dt < 0.22 ? 0.45 : 0.15;
  }
}

function fillSliceFingers(
  slice: OnsetSlice,
  fingerByNoteUid: Record<string, Finger>,
  out: Finger[],
): Finger[] {
  const len = slice.notes.length;
  out.length = len;
  for (let i = 0; i < len; i++) {
    out[i] = fingerByNoteUid[slice.notes[i].noteUid] ?? 1;
  }
  return out;
}

function getMinMidi(slice: OnsetSlice): number {
  let min = Infinity;
  for (let i = 0; i < slice.notes.length; i++) {
    const m = slice.notes[i].midi;
    if (m < min) min = m;
  }
  return min;
}

function getMaxMidi(slice: OnsetSlice): number {
  let max = -Infinity;
  for (let i = 0; i < slice.notes.length; i++) {
    const m = slice.notes[i].midi;
    if (m > max) max = m;
  }
  return max;
}

function fillWindowSlices(
  byMeasure: OnsetSlice[][],
  M: number,
  boundaryTick: number,
  boundaryMeasure: number,
  out: OnsetSlice[],
): void {
  out.length = 0;
  let before1: OnsetSlice | null = null;
  let before2: OnsetSlice | null = null;
  let after1: OnsetSlice | null = null;
  let after2: OnsetSlice | null = null;

  const loM = boundaryMeasure > 0 ? boundaryMeasure - 1 : 0;
  const hiM = boundaryMeasure + 1 < M ? boundaryMeasure + 1 : M - 1;
  for (let m = loM; m <= hiM; m++) {
    const arr = byMeasure[m];
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (s.onsetTick < boundaryTick) {
        before1 = before2;
        before2 = s;
      } else if (!after1) {
        after1 = s;
      } else if (!after2) {
        after2 = s;
      }
    }
  }
  if (before1) out.push(before1);
  if (before2) out.push(before2);
  if (after1) out.push(after1);
  if (after2) out.push(after2);
}

function computeChunkJunctions(
  staticResult: StaticChunkingResult,
  scoreDoc: StaticScoreInput,
  solveResult: SolveResult,
  practiceMode: PracticeMode,
  clusters: PassageCluster[],
  rhSlicesByMeasure: OnsetSlice[][],
  lhSlicesByMeasure: OnsetSlice[][],
  options?: MotorOverlayOptions,
): ChunkJunction[] {
  const chunks = staticResult.motorChunks;
  const M = scoreDoc.measureCount;
  if (chunks.length < 2 || M <= 0) return [];

  const compactStepTicks = buildCompactStepTicks(
    scoreDoc.onsetSlices,
    scoreDoc.noteEvents,
    practiceMode,
  );

  const cuesBySliceId = new Map<string, TransitionCue[]>();
  for (let i = 0; i < solveResult.transitionCues.length; i++) {
    const cue = solveResult.transitionCues[i];
    if (!isTargetHand(cue.hand, practiceMode)) continue;
    let list = cuesBySliceId.get(cue.sliceId);
    if (!list) {
      list = [];
      cuesBySliceId.set(cue.sliceId, list);
    }
    list.push(cue);
  }

  const hpStartSliceIds = new Set<string>();
  let seenRhHp = false;
  let seenLhHp = false;
  for (let i = 0; i < solveResult.handPositions.length; i++) {
    const hp = solveResult.handPositions[i];
    if (hp.hand === "RH") {
      if (!seenRhHp) {
        seenRhHp = true;
        continue;
      }
    } else if (!seenLhHp) {
      seenLhHp = true;
      continue;
    }
    hpStartSliceIds.add(hp.startSliceId);
  }

  const switchByMeasure = new Map<number, SwitchPoint[]>();
  for (let i = 0; i < clusters.length; i++) {
    const cl = clusters[i];
    for (let k = 0; k < cl.switchPoints.length; k++) {
      const sp = cl.switchPoints[k];
      let list = switchByMeasure.get(sp.measureIndex);
      if (!list) {
        list = [];
        switchByMeasure.set(sp.measureIndex, list);
      }
      list.push(sp);
    }
  }

  const junctions: ChunkJunction[] = [];
  const rhWin: OnsetSlice[] = [];
  const lhWin: OnsetSlice[] = [];
  const scratchCurrF: Finger[] = [];
  const rhShiftTimes: number[] = [];
  const lhShiftTimes: number[] = [];
  const rhShiftDeltas: number[] = [];
  const lhShiftDeltas: number[] = [];

  for (let i = 0; i < chunks.length - 1; i++) {
    const leftChunk = chunks[i];
    const rightChunk = chunks[i + 1];
    const boundaryCoord = rightChunk.startCoord;
    const boundaryMeasure = Math.min(M - 1, Math.max(0, boundaryCoord.measureIndex));
    const boundaryTick = scoreCoordToTick(scoreDoc, boundaryCoord);

    const junctionStepIndex = findFirstStepAtOrAfterTick(compactStepTicks, boundaryTick);
    const startStepIndex = Math.max(0, junctionStepIndex - 2);
    const endStepIndex =
      compactStepTicks.length > 0
        ? Math.min(compactStepTicks.length - 1, junctionStepIndex + 1)
        : 0;

    if (practiceMode === "lh-only") {
      rhWin.length = 0;
    } else {
      fillWindowSlices(rhSlicesByMeasure, M, boundaryTick, boundaryMeasure, rhWin);
    }
    if (practiceMode === "rh-only") {
      lhWin.length = 0;
    } else {
      fillWindowSlices(lhSlicesByMeasure, M, boundaryTick, boundaryMeasure, lhWin);
    }

    let d1 = 0;
    let d2 = 0;
    let d4 = 0;
    const reasonTags: string[] = [];

    rhShiftTimes.length = 0;
    lhShiftTimes.length = 0;
    rhShiftDeltas.length = 0;
    lhShiftDeltas.length = 0;

    for (let handPass = 0; handPass < 2; handPass++) {
      const win = handPass === 0 ? rhWin : lhWin;
      if (win.length === 0) continue;
      const shiftTimes = handPass === 0 ? rhShiftTimes : lhShiftTimes;
      const shiftDeltas = handPass === 0 ? rhShiftDeltas : lhShiftDeltas;
      let maxHeld = 0;
      let prevOnsetSec = 0;
      let prevHasNotes = false;
      let prevRoot = 0;
      let prevMin = 0;
      let prevMax = 0;

      for (let k = 0; k < win.length; k++) {
        const curr = win[k];
        const hasPrev = k > 0;
        const dt = hasPrev ? Math.max(0.05, curr.onsetSec - prevOnsetSec) : 0.5;

        const cues = cuesBySliceId.size > 0 ? cuesBySliceId.get(curr.sliceId) : undefined;
        if (cues) {
          for (let c = 0; c < cues.length; c++) {
            const h = cueHazardScore(cues[c], dt);
            if (h > d1) d1 = h;
            if (cues[c].type === "unreachable-span" && !reasonTags.includes("unreachable-span")) {
              reasonTags.push("unreachable-span");
            }
            if (cues[c].type === "position-shift") {
              shiftTimes.push(curr.onsetSec);
            }
          }
        }

        const currHasNotes = curr.notes.length > 0;
        if (currHasNotes) {
          const currF = fillSliceFingers(curr, solveResult.fingerByNoteUid, scratchCurrF);
          const currRoot = computeHandRoot(curr.notes, currF, curr.hand);
          const currMin = getMinMidi(curr);
          const currMax = getMaxMidi(curr);

          if (hasPrev && prevHasNotes) {
            const signedShift = currRoot - prevRoot;
            const absShift = Math.abs(signedShift);
            const vel = absShift / dt;

            const noOverlap = currMin > prevMax || currMax < prevMin;
            const isHpBoundary = hpStartSliceIds.has(curr.sliceId);
            const leapScore = clamp01(
              vel / 35 + ((noOverlap || isHpBoundary) && absShift >= 2 ? 0.25 : 0),
            );
            if (leapScore > d2) d2 = leapScore;

            if (absShift >= 2.5) {
              shiftTimes.push(curr.onsetSec);
              shiftDeltas.push(signedShift);
            }
          }

          prevRoot = currRoot;
          prevMin = currMin;
          prevMax = currMax;
        }
        prevHasNotes = currHasNotes;
        prevOnsetSec = curr.onsetSec;

        let physicalHeld = 0;
        for (let hIdx = 0; hIdx < curr.heldNotes.length; hIdx++) {
          if (!curr.heldNotes[hIdx].pedalSustained) physicalHeld++;
        }
        if (physicalHeld > maxHeld) maxHeld = physicalHeld;
      }
      const handD4 = clamp01(maxHeld * 0.35);
      if (handD4 > d4) d4 = handD4;
    }

    // D3: Bimanual coupling (strictly 0 in single-hand PracticeMode)
    let d3 = 0;
    if (practiceMode === "both") {
      let dualShift = false;
      for (let r = 0; r < rhShiftTimes.length && !dualShift; r++) {
        const tR = rhShiftTimes[r];
        for (let l = 0; l < lhShiftTimes.length; l++) {
          if (Math.abs(tR - lhShiftTimes[l]) <= 0.25) {
            dualShift = true;
            break;
          }
        }
      }
      if (dualShift) {
        d3 += 0.7;
        reasonTags.push("simultaneous-dual-shift");
      }

      // Check polyrhythm / non-integer beat onset ratio at boundary measure
      const rCount = rhSlicesByMeasure[boundaryMeasure].length;
      const lCount = lhSlicesByMeasure[boundaryMeasure].length;
      if (rCount >= 2 && lCount >= 2 && Math.max(rCount, lCount) % Math.min(rCount, lCount) !== 0) {
        d3 += 0.3;
        reasonTags.push("polyrhythm-coupling");
      }

      // Asymmetric parallel leap
      if (rhShiftDeltas.length > 0 && lhShiftDeltas.length > 0) {
        const dR = rhShiftDeltas[0];
        const dL = lhShiftDeltas[0];
        if (dR * dL > 0 && Math.abs(Math.abs(dR) - Math.abs(dL)) >= 2) {
          d3 += 0.2;
        }
      }
      d3 = clamp01(d3);
    }

    // D5: SwitchPoint interference
    let d5 = 0;
    if (switchByMeasure.size > 0) {
      const spListA = switchByMeasure.get(boundaryMeasure);
      const spListB =
        rightChunk.hasAnacrusisLeadIn && boundaryMeasure + 1 < M
          ? switchByMeasure.get(boundaryMeasure + 1)
          : undefined;
      const sp = spListA?.[0] ?? spListB?.[0];
      if (sp) {
        d5 = clamp01(
          0.65 + 0.08 * sp.priorSharedMeasures + 0.05 * sp.alternateBranchLabels.length,
        );
        reasonTags.push("switch-point");
      }
    }

    const rawPrior = clamp01(0.28 * d1 + 0.2 * d2 + 0.22 * d3 + 0.1 * d4 + 0.2 * d5);
    const hitFloor =
      d1 >= 1.0 || (practiceMode === "both" && d3 >= 0.65) || d5 >= 0.8;
    const priorRisk = hitFloor ? Math.max(rawPrior, 0.75) : rawPrior;

    const junctionId = `junc-${leftChunk.chunkId}-${rightChunk.chunkId}`;
    const emp = options?.empiricalByJunctionId?.[junctionId];
    let d6 = 0;
    let posteriorRisk = priorRisk;
    if (emp && emp.attempts > 0) {
      const alpha = emp.attempts / (emp.attempts + 3);
      d6 = clamp01((emp.faultCount + emp.hesitationCount * 0.7) / emp.attempts);
      posteriorRisk = clamp01((1 - alpha) * priorRisk + alpha * d6);
    }

    if (d2 >= 0.5 && !reasonTags.includes("position-leap")) {
      reasonTags.push("position-leap");
    }

    const prepCueLabel = reasonTags.includes("switch-point")
      ? `m.${boundaryMeasure + 1} Switch 分叉口`
      : reasonTags.includes("simultaneous-dual-shift")
        ? `m.${boundaryMeasure + 1} 双手同步移把`
        : reasonTags.includes("unreachable-span")
          ? `m.${boundaryMeasure + 1} 不可达跨度接缝`
          : d2 >= 0.5
            ? `m.${boundaryMeasure + 1} 手位大跳过渡`
            : `m.${boundaryMeasure + 1} 接缝过渡`;

    junctions.push({
      junctionId,
      leftChunkId: leftChunk.chunkId,
      rightChunkId: rightChunk.chunkId,
      boundaryCoord,
      measureIndex: boundaryMeasure,
      bridgeWindowSteps: {
        startStepIndex,
        endStepIndex,
        junctionStepIndex,
      },
      dimensions: {
        d1TransitionHazard: d1,
        d2PositionLeapVelocity: d2,
        d3BimanualCoupling: d3,
        d4HeldFingerLoad: d4,
        d5SwitchPointInterference: d5,
        d6EmpiricalPosterior: d6,
      },
      priorRisk,
      posteriorRisk,
      isHighRisk: priorRisk >= 0.65,
      reasonTags,
      prepCueLabel,
    });
  }

  return junctions;
}

const ROLE_ORDER: Record<PerformanceCueKind, number> = {
  switch: 0,
  structural: 1,
  technical: 2,
  expressive: 3,
};

function mergeRoles(a: PerformanceCueKind[], b: PerformanceCueKind[]): PerformanceCueKind[] {
  const set = new Set<PerformanceCueKind>([...a, ...b]);
  return Array.from(set).sort((x, y) => ROLE_ORDER[x] - ROLE_ORDER[y]);
}

function buildSparsePerformanceCues(
  staticResult: StaticChunkingResult,
  junctions: ChunkJunction[],
): PerformanceCue[] {
  const M = staticResult.measureCount;
  if (M <= 0) return [];

  const expressiveCues: PerformanceCue[] = [];
  const primaryCandidates: PerformanceCue[] = [];

  for (const cue of staticResult.candidateCues) {
    if (cue.kind === "expressive") {
      expressiveCues.push({ ...cue, collapsed: true, isPrimary: false });
    } else {
      primaryCandidates.push({ ...cue, roles: [...cue.roles], collapsed: false, isPrimary: true });
    }
  }

  for (const junc of junctions) {
    if (junc.priorRisk >= 0.7) {
      primaryCandidates.push({
        cueId: `cue-tech-${junc.junctionId}`,
        kind: "technical",
        roles: ["technical"],
        priorityWeight: 1.0 + Math.min(0.4, (junc.priorRisk - 0.7) * 1.2),
        coord: junc.boundaryCoord,
        measureIndex: junc.measureIndex,
        label: junc.prepCueLabel,
        collapsed: false,
        isPrimary: true,
        junctionId: junc.junctionId,
      });
    }
  }

  // Sort by priorityWeight desc (Switch 2.0 > Structural 1.5 > Technical 1.0..1.4)
  primaryCandidates.sort(
    (a, b) => b.priorityWeight - a.priorityWeight || a.measureIndex - b.measureIndex,
  );

  // Stage 1: 2-measure NMS merging within |mA - mB| < 2
  const nmsMerged: PerformanceCue[] = [];
  for (const cand of primaryCandidates) {
    const neighbor = nmsMerged.find((k) => Math.abs(k.measureIndex - cand.measureIndex) < 2);
    if (neighbor) {
      neighbor.roles = mergeRoles(neighbor.roles, cand.roles);
      if (!neighbor.label.includes(cand.label)) {
        neighbor.label = `${neighbor.label} · ${cand.label}`;
      }
      neighbor.switchPointId ??= cand.switchPointId;
      neighbor.junctionId ??= cand.junctionId;
      neighbor.sectionId ??= cand.sectionId;
    } else {
      nmsMerged.push({ ...cand });
    }
  }

  // Stage 2: Density cap <= 1 primary cue per 4–8 measures (no two within < 4 measures)
  const maxPrimary = M < 4 ? 1 : Math.max(1, Math.floor(M / 4));
  const selectedPrimary: PerformanceCue[] = [];
  for (const cue of nmsMerged) {
    if (selectedPrimary.length >= maxPrimary) break;
    const tooClose = selectedPrimary.some(
      (s) => Math.abs(s.measureIndex - cue.measureIndex) < 4,
    );
    if (!tooClose) {
      selectedPrimary.push(cue);
    }
  }

  selectedPrimary.sort((a, b) => a.measureIndex - b.measureIndex);
  expressiveCues.sort((a, b) => a.measureIndex - b.measureIndex);

  return [...selectedPrimary, ...expressiveCues].sort(
    (a, b) =>
      a.measureIndex - b.measureIndex ||
      Number(b.isPrimary) - Number(a.isPrimary),
  );
}

/**
 * Synchronous (< 2 ms) main-thread motor overlay combining static chunking output
 * with SolveResult FingerAssignments, HandPositions, TransitionCues, and PracticeMode.
 */
export function analyzeMotorOverlay(
  staticResult: StaticChunkingResult,
  scoreDoc: StaticScoreInput,
  solveResult: SolveResult,
  practiceMode: PracticeMode = "both",
  options?: MotorOverlayOptions,
): MotorOverlayResult {
  const t0 = performance.now();

  const needMeasureSlices =
    scoreDoc.measureCount > 0 &&
    (staticResult.passageClusters.length > 0 || staticResult.motorChunks.length >= 2);
  const { rhSlicesByMeasure, lhSlicesByMeasure } = needMeasureSlices
    ? buildSlicesByHandMeasure(scoreDoc.onsetSlices, scoreDoc.measureCount)
    : { rhSlicesByMeasure: [], lhSlicesByMeasure: [] };

  const passageClusters = recomputeClusterMotorReuse(
    staticResult.passageClusters,
    scoreDoc,
    solveResult,
    practiceMode,
    rhSlicesByMeasure,
    lhSlicesByMeasure,
  );
  const chunkJunctions = computeChunkJunctions(
    staticResult,
    scoreDoc,
    solveResult,
    practiceMode,
    passageClusters,
    rhSlicesByMeasure,
    lhSlicesByMeasure,
    options,
  );
  const performanceCues = buildSparsePerformanceCues(staticResult, chunkJunctions);

  return {
    practiceMode,
    passageClusters,
    chunkJunctions,
    performanceCues,
    overlayTimeMs: performance.now() - t0,
  };
}
