import { computeHandRoot } from "../solver/costModel";
import type {
  Finger,
  Hand,
  MeasureTimeline,
  NoteEvent,
  OnsetSlice,
  PracticeMode,
  ScoreCoord,
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

function coordToTick(
  coord: ScoreCoord,
  timelines: MeasureTimeline[],
  ticksPerQuarter: number,
): number {
  const tl = timelines[coord.measureIndex];
  const base = tl?.startTick ?? coord.measureIndex * ticksPerQuarter * 4;
  return base + (coord.beatNum * ticksPerQuarter) / Math.max(1, coord.beatDen);
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

function recomputeClusterMotorReuse(
  staticClusters: PassageCluster[],
  scoreDoc: StaticScoreInput,
  solveResult: SolveResult,
  practiceMode: PracticeMode,
): PassageCluster[] {
  if (staticClusters.length === 0) return [];

  const slicesByHandMeasure = new Map<string, OnsetSlice[]>();
  for (let i = 0; i < scoreDoc.onsetSlices.length; i++) {
    const s = scoreDoc.onsetSlices[i];
    if (s.isGrace || !isTargetHand(s.hand, practiceMode)) continue;
    const key = `${s.hand}:${s.measureIndex}`;
    let list = slicesByHandMeasure.get(key);
    if (!list) {
      list = [];
      slicesByHandMeasure.set(key, list);
    }
    list.push(s);
  }

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
        for (let off = 0; off < lenM; off++) {
          const pSlices = slicesByHandMeasure.get(`${hand}:${proto.startMeasureIndex + off}`) ?? [];
          const iSlices = slicesByHandMeasure.get(`${hand}:${inst.startMeasureIndex + off}`) ?? [];
          const pairLen = Math.min(pSlices.length, iSlices.length);
          for (let sIdx = 0; sIdx < pairLen; sIdx++) {
            const pNotes = pSlices[sIdx].notes;
            const iNotes = iSlices[sIdx].notes;
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

function getSliceFingers(slice: OnsetSlice, fingerByNoteUid: Record<string, Finger>): Finger[] {
  const out: Finger[] = [];
  for (let i = 0; i < slice.notes.length; i++) {
    out.push(fingerByNoteUid[slice.notes[i].noteUid] ?? 1);
  }
  return out;
}

function computeSliceBounds(slice: OnsetSlice): { minMidi: number; maxMidi: number } {
  let minMidi = Infinity;
  let maxMidi = -Infinity;
  for (let i = 0; i < slice.notes.length; i++) {
    const midi = slice.notes[i].midi;
    if (midi < minMidi) minMidi = midi;
    if (midi > maxMidi) maxMidi = midi;
  }
  return { minMidi, maxMidi };
}

function computeChunkJunctions(
  staticResult: StaticChunkingResult,
  scoreDoc: StaticScoreInput,
  solveResult: SolveResult,
  practiceMode: PracticeMode,
  clusters: PassageCluster[],
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

  // Fast O(N + S) pre-indexing by measureIndex
  const rhSlicesByMeasure: OnsetSlice[][] = Array.from({ length: M }, () => []);
  const lhSlicesByMeasure: OnsetSlice[][] = Array.from({ length: M }, () => []);
  for (let i = 0; i < scoreDoc.onsetSlices.length; i++) {
    const s = scoreDoc.onsetSlices[i];
    if (s.measureIndex < 0 || s.measureIndex >= M) continue;
    if (s.hand === "RH") rhSlicesByMeasure[s.measureIndex].push(s);
    else lhSlicesByMeasure[s.measureIndex].push(s);
  }

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
  const seenHandHp = new Set<Hand>();
  for (let i = 0; i < solveResult.handPositions.length; i++) {
    const hp = solveResult.handPositions[i];
    if (!seenHandHp.has(hp.hand)) {
      seenHandHp.add(hp.hand);
      continue; // initial position at start of hand track is not a shift
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

  const collectWindowSlices = (
    byMeasure: OnsetSlice[][],
    boundaryTick: number,
    boundaryMeasure: number,
  ): OnsetSlice[] => {
    const before: OnsetSlice[] = [];
    const after: OnsetSlice[] = [];
    const loM = Math.max(0, boundaryMeasure - 1);
    const hiM = Math.min(M - 1, boundaryMeasure + 1);
    for (let m = loM; m <= hiM; m++) {
      const arr = byMeasure[m];
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (s.onsetTick < boundaryTick) {
          before.push(s);
        } else {
          if (after.length < 2) after.push(s);
        }
      }
    }
    const tailBefore = before.length > 2 ? before.slice(before.length - 2) : before;
    return [...tailBefore, ...after];
  };

  const junctions: ChunkJunction[] = [];

  for (let i = 0; i < chunks.length - 1; i++) {
    const leftChunk = chunks[i];
    const rightChunk = chunks[i + 1];
    const boundaryCoord = rightChunk.startCoord;
    const boundaryMeasure = Math.min(M - 1, Math.max(0, boundaryCoord.measureIndex));
    const boundaryTick = coordToTick(
      boundaryCoord,
      scoreDoc.measureTimelines,
      scoreDoc.ticksPerQuarter,
    );

    const junctionStepIndex = findFirstStepAtOrAfterTick(compactStepTicks, boundaryTick);
    const startStepIndex = Math.max(0, junctionStepIndex - 2);
    const endStepIndex =
      compactStepTicks.length > 0
        ? Math.min(compactStepTicks.length - 1, junctionStepIndex + 1)
        : 0;

    const rhWindow =
      practiceMode === "lh-only"
        ? []
        : collectWindowSlices(rhSlicesByMeasure, boundaryTick, boundaryMeasure);
    const lhWindow =
      practiceMode === "rh-only"
        ? []
        : collectWindowSlices(lhSlicesByMeasure, boundaryTick, boundaryMeasure);

    const handWindows: OnsetSlice[][] = [];
    if (rhWindow.length > 0) handWindows.push(rhWindow);
    if (lhWindow.length > 0) handWindows.push(lhWindow);

    let d1 = 0;
    let d2 = 0;
    let d4 = 0;
    const reasonTags: string[] = [];

    const shiftTimesByHand: { RH: number[]; LH: number[] } = { RH: [], LH: [] };
    const shiftDeltasByHand: { RH: number[]; LH: number[] } = { RH: [], LH: [] };

    for (const win of handWindows) {
      let maxHeld = 0;
      for (let k = 0; k < win.length; k++) {
        const curr = win[k];
        const prev = k > 0 ? win[k - 1] : null;
        const dt = prev ? Math.max(0.05, curr.onsetSec - prev.onsetSec) : 0.5;

        const cues = cuesBySliceId.get(curr.sliceId);
        if (cues) {
          for (let c = 0; c < cues.length; c++) {
            const h = cueHazardScore(cues[c], dt);
            if (h > d1) d1 = h;
            if (cues[c].type === "unreachable-span" && !reasonTags.includes("unreachable-span")) {
              reasonTags.push("unreachable-span");
            }
            if (cues[c].type === "position-shift") {
              shiftTimesByHand[curr.hand].push(curr.onsetSec);
            }
          }
        }

        if (prev && curr.notes.length > 0 && prev.notes.length > 0) {
          const prevF = getSliceFingers(prev, solveResult.fingerByNoteUid);
          const currF = getSliceFingers(curr, solveResult.fingerByNoteUid);
          const prevRoot = computeHandRoot(prev.notes, prevF, curr.hand);
          const currRoot = computeHandRoot(curr.notes, currF, curr.hand);
          const signedShift = currRoot - prevRoot;
          const absShift = Math.abs(signedShift);
          const vel = absShift / dt;

          const prevB = computeSliceBounds(prev);
          const currB = computeSliceBounds(curr);
          const noOverlap = currB.minMidi > prevB.maxMidi || currB.maxMidi < prevB.minMidi;
          const isHpBoundary = hpStartSliceIds.has(curr.sliceId);
          const leapScore = clamp01(vel / 35 + ((noOverlap || isHpBoundary) && absShift >= 2 ? 0.25 : 0));
          if (leapScore > d2) d2 = leapScore;

          if (absShift >= 2.5) {
            shiftTimesByHand[curr.hand].push(curr.onsetSec);
            shiftDeltasByHand[curr.hand].push(signedShift);
          }
        }

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
      for (const tR of shiftTimesByHand.RH) {
        for (const tL of shiftTimesByHand.LH) {
          if (Math.abs(tR - tL) <= 0.25) {
            dualShift = true;
            break;
          }
        }
        if (dualShift) break;
      }
      if (dualShift) {
        d3 += 0.7;
        reasonTags.push("simultaneous-dual-shift");
      }

      // Check polyrhythm / non-integer beat onset ratio at boundary measure
      const rCount = rhSlicesByMeasure[boundaryMeasure]?.length ?? 0;
      const lCount = lhSlicesByMeasure[boundaryMeasure]?.length ?? 0;
      if (rCount >= 2 && lCount >= 2 && Math.max(rCount, lCount) % Math.min(rCount, lCount) !== 0) {
        d3 += 0.3;
        reasonTags.push("polyrhythm-coupling");
      }

      // Asymmetric parallel leap
      if (shiftDeltasByHand.RH.length > 0 && shiftDeltasByHand.LH.length > 0) {
        const dR = shiftDeltasByHand.RH[0];
        const dL = shiftDeltasByHand.LH[0];
        if (dR * dL > 0 && Math.abs(Math.abs(dR) - Math.abs(dL)) >= 2) {
          d3 += 0.2;
        }
      }
      d3 = clamp01(d3);
    }

    // D5: SwitchPoint interference
    let d5 = 0;
    const spMatches = [
      ...(switchByMeasure.get(boundaryMeasure) ?? []),
      ...(rightChunk.hasAnacrusisLeadIn && boundaryMeasure + 1 < M
        ? (switchByMeasure.get(boundaryMeasure + 1) ?? [])
        : []),
    ];
    if (spMatches.length > 0) {
      const sp = spMatches[0];
      d5 = clamp01(
        0.65 + 0.08 * sp.priorSharedMeasures + 0.05 * sp.alternateBranchLabels.length,
      );
      reasonTags.push("switch-point");
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

  const passageClusters = recomputeClusterMotorReuse(
    staticResult.passageClusters,
    scoreDoc,
    solveResult,
    practiceMode,
  );
  const chunkJunctions = computeChunkJunctions(
    staticResult,
    scoreDoc,
    solveResult,
    practiceMode,
    passageClusters,
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
