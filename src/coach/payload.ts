import type { PracticeMode } from "../domain/types";
import type { AcousticProfileResult, AcousticStatus } from "../guided/acousticProfile";
import type {
  CoachEvidence,
  CoachEvidenceDimension,
  CoachEvidenceSeverity,
  CoachStrengthAnchor,
  CoachTelemetryPayload,
} from "./types";

export interface BuildCoachPayloadInput {
  profile: AcousticProfileResult;
  pieceTitle?: string;
  practiceMode: PracticeMode;
  speedMultiplier: number;
  /** 0-based start measure index. */
  startMeasureIndex: number;
  /** 0-based end measure index. */
  endMeasureIndex: number;
  timeSignature?: string;
  passIndexInSegment?: number;
  midiSource?: "midi" | "virtual" | "qwerty" | "mixed";
  transitionCues?: ReadonlyArray<{ measureIndex: number; kind: string }>;
}

function statusToTelemetry(status: AcousticStatus): "ok" | "watch" | "issue" {
  return status === "red" ? "issue" : status === "amber" ? "watch" : "ok";
}

function severityOf(status: AcousticStatus): CoachEvidenceSeverity {
  return status === "red" ? "issue" : "watch";
}

function clampOneBasedMeasure(measureIndex: number, minM: number, maxM: number): number {
  const m = Math.round(measureIndex) + 1;
  return Math.max(minM, Math.min(maxM, m));
}

function collectTransitionCues(
  measuresOneBased: readonly number[],
  transitionCues?: ReadonlyArray<{ measureIndex: number; kind: string }>,
): string[] {
  if (!transitionCues || transitionCues.length === 0) return [];
  const set = new Set<string>();
  const mSet = new Set(measuresOneBased);
  for (const cue of transitionCues) {
    if (mSet.has(cue.measureIndex + 1)) {
      set.add(cue.kind);
    }
  }
  return [...set].slice(0, 3);
}

function findTroubleMeasuresForReason(
  profile: AcousticProfileResult,
  keyword: string,
  minM: number,
  maxM: number,
): number[] {
  const found: number[] = [];
  for (const tm of profile.troubleMeasures) {
    if (tm.reasons.some((r) => r.includes(keyword))) {
      found.push(clampOneBasedMeasure(tm.measureIndex, minM, maxM));
    }
  }
  return [...new Set(found)].sort((a, b) => a - b).slice(0, 2);
}

function formatMeasureSpanLabel(measures: readonly number[], range: [number, number]): string {
  if (measures.length === 0) {
    return range[0] === range[1] ? `第 ${range[0]} 小节` : `第 ${range[0]}–${range[1]} 小节`;
  }
  if (measures.length === 1) return `第 ${measures[0]} 小节`;
  return `第 ${measures[0]}–${measures[measures.length - 1]} 小节`;
}

function makeEvidenceId(measures: readonly number[], dimension: CoachEvidenceDimension): string {
  const anchor = measures.length > 0 ? `m${measures[0]}` : "seg";
  return `ev-${anchor}-${dimension}`;
}

/**
 * Compresses local AcousticProfileResult into a ~250-500 token closed-world
 * CoachTelemetryPayload. Never includes raw MIDI event arrays or timestamps.
 */
export function buildCoachTelemetryPayload(input: BuildCoachPayloadInput): CoachTelemetryPayload {
  const {
    profile,
    pieceTitle = "当前乐曲",
    practiceMode,
    speedMultiplier,
    startMeasureIndex,
    endMeasureIndex,
    timeSignature = "4/4",
    passIndexInSegment = 1,
    midiSource = "midi",
    transitionCues,
  } = input;

  const minM = Math.max(1, Math.round(startMeasureIndex) + 1);
  const maxM = Math.max(minM, Math.round(endMeasureIndex) + 1);
  const measureRange: [number, number] = [minM, maxM];
  const segLabel = minM === maxM ? `第 ${minM} 小节` : `第 ${minM}–${maxM} 小节`;

  const evennessStatus = statusToTelemetry(profile.timingEvennessStatus);
  const worstTimingOneBased =
    profile.worstTimingMeasure !== undefined
      ? clampOneBasedMeasure(profile.worstTimingMeasure, minM, maxM)
      : undefined;

  const voicingMetric: CoachTelemetryPayload["metrics"]["voicing"] =
    profile.secondaryDimension === "voicing" && profile.voicingStatus
      ? {
          status: statusToTelemetry(profile.voicingStatus),
          ...(profile.voicingDeltaDb !== undefined ? { deltaDb: profile.voicingDeltaDb } : {}),
          ...(profile.melodyRankDominance !== undefined
            ? { melodyDominancePct: Math.round(profile.melodyRankDominance * 100) }
            : {}),
        }
      : {
          status: "skipped",
          reason:
            profile.secondaryDimension === "articulation"
              ? "single-line-passage"
              : "no-reliable-velocity",
        };

  const articulationMetric: CoachTelemetryPayload["metrics"]["articulation"] =
    profile.secondaryDimension === "articulation" && profile.articulationStatus
      ? {
          status: statusToTelemetry(profile.articulationStatus),
          ...(profile.articulationKor !== undefined ? { kor: profile.articulationKor } : {}),
        }
      : {
          status: "skipped",
          reason: profile.pedalHardware !== "none" ? "sustain-active" : "polyphonic-voicing",
        };

  const pedalMetric: CoachTelemetryPayload["metrics"]["pedalClarity"] =
    profile.tertiaryDimension === "pedal" && profile.pedalStatus
      ? {
          status: statusToTelemetry(profile.pedalStatus),
          ...(profile.pedalClarityRate !== undefined
            ? { cleanChangePct: Math.round(profile.pedalClarityRate * 100) }
            : {}),
        }
      : { status: "skipped", reason: "no-pedal-activity" };

  const handSyncMetric: CoachTelemetryPayload["metrics"]["handSync"] =
    profile.tertiaryDimension === "hand-sync" && profile.handSyncStatus
      ? {
          status: statusToTelemetry(profile.handSyncStatus),
          ...(profile.handSyncMedianEffOffsetMs !== undefined
            ? { medianEffOffsetMs: profile.handSyncMedianEffOffsetMs }
            : {}),
          ...(profile.handSyncHeavySplitPct !== undefined
            ? { heavySplitPct: Math.round(profile.handSyncHeavySplitPct * 100) }
            : {}),
        }
      : {
          status: "skipped",
          reason:
            profile.tertiaryDimension === "pedal"
              ? "pedal-priority"
              : practiceMode === "both"
                ? "insufficient-bimanual-steps"
                : "single-hand-mode",
        };

  const evidences: CoachEvidence[] = [];

  if (profile.timingEvennessStatus !== "green") {
    const measures =
      worstTimingOneBased !== undefined ? [worstTimingOneBased] : [minM];
    evidences.push({
      id: makeEvidenceId(measures, "evenness"),
      dimension: "evenness",
      severity: severityOf(profile.timingEvennessStatus),
      measures,
      fact: `${formatMeasureSpanLabel(measures, measureRange)}跑动时值微有起伏（nPVI ${profile.timingNormNpvi.toFixed(1)}）`,
      cues: collectTransitionCues(measures, transitionCues),
    });
  }

  if (profile.secondaryDimension === "voicing" && profile.voicingStatus && profile.voicingStatus !== "green") {
    const found = findTroubleMeasuresForReason(profile, "声部层次", minM, maxM);
    const measures = found.length > 0 ? found : [minM];
    const dbText =
      profile.voicingDeltaDb !== undefined
        ? `${profile.voicingDeltaDb >= 0 ? "+" : ""}${profile.voicingDeltaDb.toFixed(1)} dB`
        : "偏平";
    const domText =
      profile.melodyRankDominance !== undefined
        ? `，旋律占优率 ${Math.round(profile.melodyRankDominance * 100)}%`
        : "";
    evidences.push({
      id: makeEvidenceId(measures, "voicing"),
      dimension: "voicing",
      severity: severityOf(profile.voicingStatus),
      measures,
      fact: `${formatMeasureSpanLabel(measures, measureRange)}旋律与伴奏相对响度差 ${dbText}${domText}，层次偏平`,
      cues: collectTransitionCues(measures, transitionCues),
    });
  }

  if (
    profile.secondaryDimension === "articulation" &&
    profile.articulationStatus &&
    profile.articulationStatus !== "green"
  ) {
    const found = findTroubleMeasuresForReason(profile, "触键", minM, maxM);
    const measures = found.length > 0 ? found : [minM];
    const korVal = profile.articulationKor ?? 0;
    const detail = korVal < -0.2 ? "声音偏干断" : "音符衔接略粘连";
    evidences.push({
      id: makeEvidenceId(measures, "articulation"),
      dimension: "articulation",
      severity: severityOf(profile.articulationStatus),
      measures,
      fact: `${formatMeasureSpanLabel(measures, measureRange)}${detail}（KOR ${korVal >= 0 ? "+" : ""}${korVal.toFixed(2)}）`,
      cues: collectTransitionCues(measures, transitionCues),
    });
  }

  if (profile.tertiaryDimension === "pedal" && profile.pedalStatus && profile.pedalStatus !== "green") {
    const found = findTroubleMeasuresForReason(profile, "踏板", minM, maxM);
    const measures = found.length > 0 ? found : [minM];
    const pct =
      profile.pedalClarityRate !== undefined
        ? `${Math.round(profile.pedalClarityRate * 100)}%`
        : "偏低";
    evidences.push({
      id: makeEvidenceId(measures, "pedalClarity"),
      dimension: "pedalClarity",
      severity: severityOf(profile.pedalStatus),
      measures,
      fact: `${formatMeasureSpanLabel(measures, measureRange)}换和声时踏板清音率 ${pct}，旧和声略残留`,
      cues: collectTransitionCues(measures, transitionCues),
    });
  }

  if (profile.tertiaryDimension === "hand-sync" && profile.handSyncStatus && profile.handSyncStatus !== "green") {
    const found = findTroubleMeasuresForReason(profile, "双手", minM, maxM);
    const measures = found.length > 0 ? found : [minM];
    const offset = Math.round(profile.handSyncMedianEffOffsetMs ?? 0);
    evidences.push({
      id: makeEvidenceId(measures, "handSync"),
      dimension: "handSync",
      severity: severityOf(profile.handSyncStatus),
      measures,
      fact: `${formatMeasureSpanLabel(measures, measureRange)}双手纵向落点错开约 ${offset} ms`,
      cues: collectTransitionCues(measures, transitionCues),
    });
  }

  evidences.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "issue" ? -1 : 1;
    return a.measures[0] - b.measures[0];
  });

  let strengthAnchor: CoachStrengthAnchor;
  if (profile.timingEvennessStatus === "green") {
    strengthAnchor = {
      id: "ev-seg-evenness",
      measures: [minM, maxM],
      fact: `${segLabel}乐句跑动时值均匀稳定（nPVI ${profile.timingNormNpvi.toFixed(1)}）`,
    };
  } else if (profile.secondaryDimension === "voicing" && profile.voicingStatus === "green") {
    strengthAnchor = {
      id: "ev-seg-voicing",
      measures: [minM, maxM],
      fact: `${segLabel}旋律线条清晰浮于伴奏之上（+${(profile.voicingDeltaDb ?? 0).toFixed(1)} dB）`,
    };
  } else if (profile.tertiaryDimension === "pedal" && profile.pedalStatus === "green") {
    strengthAnchor = {
      id: "ev-seg-pedal",
      measures: [minM, maxM],
      fact: `${segLabel}踏板换音干脆清澈`,
    };
  } else if (profile.tertiaryDimension === "hand-sync" && profile.handSyncStatus === "green") {
    strengthAnchor = {
      id: "ev-seg-handSync",
      measures: [minM, maxM],
      fact: `${segLabel}合奏和声齐整融合`,
    };
  } else {
    strengthAnchor = {
      id: "ev-seg-continuity",
      measures: [minM, maxM],
      fact: `${segLabel}保持了完整的连贯流动感`,
    };
  }

  return {
    schemaVersion: "1.0",
    piece: {
      title: pieceTitle.slice(0, 64),
      practiceMode,
      speedMultiplier: Math.round(speedMultiplier * 100) / 100,
      measureRange,
      timeSignature,
      passIndexInSegment: Math.max(1, Math.round(passIndexInSegment)),
      midiSource,
      pedalHardware: profile.pedalHardware,
    },
    metrics: {
      evenness: {
        status: evennessStatus,
        nPVI: profile.timingNormNpvi,
        ...(worstTimingOneBased !== undefined ? { worstMeasure: worstTimingOneBased } : {}),
      },
      voicing: voicingMetric,
      handSync: handSyncMetric,
      articulation: articulationMetric,
      pedalClarity: pedalMetric,
    },
    evidences: evidences.slice(0, 4),
    strengthAnchor,
  };
}
