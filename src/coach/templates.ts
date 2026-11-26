import type { PerformanceCueKind } from "../chunking/types";
import type {
  CoachEvidence,
  CoachFocusCue,
  CoachResponse,
  CoachTelemetryPayload,
} from "./types";

function formatMeasureRef(measures: readonly number[]): string {
  if (measures.length === 0) return "本段";
  if (measures.length === 1) return `第${measures[0]}小节`;
  return `第${measures[0]}-${measures[1]}小节`;
}

function buildPraise(payload: CoachTelemetryPayload): string {
  const [startM, endM] = payload.piece.measureRange;
  const span = startM === endM ? `第${startM}小节` : `第${startM}-${endM}小节`;
  switch (payload.strengthAnchor.id) {
    case "ev-seg-evenness":
      return `${span}流动均匀稳健，乐句自然推进。`;
    case "ev-seg-voicing":
      return `${span}主旋律线条清亮浮出，声部层次分明。`;
    case "ev-seg-pedal":
      return `${span}踏板换音干净清澈，和声空间通透。`;
    case "ev-seg-handSync":
      return `${span}合奏和声齐整融合，音色饱满凝聚。`;
    default:
      return `${span}保持了完整的音乐连贯流动感。`;
  }
}

function mapEvidenceToCue(evidence: CoachEvidence, payload: CoachTelemetryPayload): CoachFocusCue {
  const mRef = formatMeasureRef(evidence.measures);
  let soundCue: string;
  switch (evidence.dimension) {
    case "voicing":
      soundCue = `${mRef}把伴奏化作轻柔背景雾气，让旋律像独唱清亮浮出。`;
      break;
    case "evenness":
      soundCue = `${mRef}想象成大小一致的珍珠滚过琴键，保持声流平稳呼吸。`;
      break;
    case "handSync":
      soundCue = `${mRef}聆听高低音齐鸣融为一体，避免声响前后错开。`;
      break;
    case "pedalClarity":
      soundCue = `${mRef}新和声落定瞬间听见旧共鸣切净，留出清澈空气。`;
      break;
    case "articulation": {
      const kor = payload.metrics.articulation.kor ?? 0;
      soundCue =
        kor < -0.2
          ? `${mRef}让长音的共鸣气息充分延伸到下一个音亮起。`
          : `${mRef}让相邻乐音留出干爽颗粒边界，避免余音粘连。`;
      break;
    }
  }
  return {
    evidenceId: evidence.id,
    measures: evidence.measures.slice(0, 2),
    soundCue,
  };
}

function buildNextPassGoal(topEvidence: CoachEvidence | undefined): string {
  if (!topEvidence) {
    return "下一遍闭眼聆听整句音色呼吸，准备提速巩固。";
  }
  switch (topEvidence.dimension) {
    case "voicing":
      return "下一遍只听高声部歌唱线条是否持续领先伴奏。";
    case "evenness":
      return "下一遍听每个音符颗粒是否像节拍波浪般均匀前进。";
    case "handSync":
      return "下一遍专注和弦声响是否融合成干净的一声。";
    case "pedalClarity":
      return "下一遍在每个新和声出现时确认旧余音瞬间清空。";
    case "articulation":
      return "下一遍聆听音粒之间是否既有连贯度又不糊成一团。";
  }
}

/**
 * 0 ms deterministic offline Chinese external-focus coach template generator.
 * Focuses strictly on sound, balance, phrasing, and acoustic outcomes with
 * zero body-mechanics instructions and <= 140 Chinese characters total.
 */
export function generateOfflineCoachFeedback(payload: CoachTelemetryPayload): CoachResponse {
  const praise = buildPraise(payload);
  const topEvidences = payload.evidences.slice(0, 2);
  const focusCues = topEvidences.map((ev) => mapEvidenceToCue(ev, payload));
  const nextPassListeningGoal = buildNextPassGoal(topEvidences[0]);
  return {
    praise,
    focusCues,
    nextPassListeningGoal,
  };
}

/**
 * Single-line offline external-focus acoustic tip for Free Studio's badge popover.
 */
export function buildFreeStudioOfflineTip(payload: CoachTelemetryPayload): string {
  const resp = generateOfflineCoachFeedback(payload);
  return resp.focusCues[0]?.soundCue ?? resp.praise;
}

/**
 * Deterministic offline external-focus imagery label for a sparse PerformanceCue.
 */
export function buildOfflineExternalFocusCueLabel(
  kind: PerformanceCueKind,
  measureIndex: number,
  rawLabel?: string,
): string {
  const m = measureIndex + 1;
  switch (kind) {
    case "switch":
      return `m.${m} 听清分叉新声部`;
    case "structural":
      return `m.${m} 新乐句呼吸起点`;
    case "expressive":
      return `m.${m} 歌唱线条浮出`;
    case "technical":
    default:
      if (rawLabel && rawLabel.includes("跳")) return `m.${m} 落点清亮对齐`;
      return `m.${m} 颗粒均匀透亮`;
  }
}
