import type { PracticeStep, ScoreDocument } from "../../domain/types";
import type { MetronomeBeatEvent } from "../../audio/metronome";
import { buildMeasureBeatSpans, scoreSecToBeat, type MeasureBeatSpan } from "./ehsOsmdGeometry";
import type {
  EhsAdaptiveTelemetry,
  EhsConfig,
  EhsFrameSnapshot,
  EhsLookaheadPolicy,
  EhsPeekReason,
  EhsPeekState,
} from "./ehsPrototypeTypes";

export const EHS_MIN_ADAPTIVE_BEATS = 0.5;
export const EHS_DEFAULT_ADAPTIVE_BEATS = 1.5;
export const EHS_MAX_ADAPTIVE_BEATS = 4.0;

/**
 * Pure controller encapsulating Decision Point 2 (fixed vs hesitation-adaptive lookahead span)
 * and Decision Point 3 (B0/F flash/hold peek + automatic stall-triggered rescue reveal),
 * driven by steady-tempo playback clock + lightweight Bounded Window MIDI attribution.
 */
export interface EhsAdaptiveController {
  resetForBout(startScoreSec?: number): void;
  recordMidiNoteOn(args: {
    midi: number;
    nowMs: number;
    scoreSec: number;
    speedMultiplier: number;
    practiceSteps: PracticeStep[];
    config: EhsConfig;
  }): { matched: boolean; lagMs: number | null; triggeredAutoPeek: boolean };
  tick(args: {
    nowMs: number;
    scoreDoc: ScoreDocument | null;
    scoreSec: number;
    isPlaying: boolean;
    speedMultiplier: number;
    activeMetronomeBeat: MetronomeBeatEvent | null;
    practiceSteps: PracticeStep[];
    config: EhsConfig;
    hasReceivedMidiInBout: boolean;
  }): EhsFrameSnapshot;
  triggerPeek(reason: Exclude<EhsPeekReason, null>, config: EhsConfig, nowMs: number, rescueMeasure?: number | null): void;
  releaseHoldPeek(nowMs: number): void;
  simulateStall(config: EhsConfig, nowMs: number, currentMeasureIndex: number): void;
  simulateFluentStep(nowMs: number): void;
  getTelemetry(): EhsAdaptiveTelemetry;
}

export function resolveTargetLookaheadBeats(
  policy: EhsLookaheadPolicy,
  beatsInActiveMeasure: number,
  adaptiveBeats: number
): number {
  switch (policy) {
    case "fixed-0.5":
      return 0.5;
    case "fixed-1":
      return 1.0;
    case "fixed-2":
      return 2.0;
    case "fixed-bar":
      return Math.max(1, beatsInActiveMeasure);
    case "adaptive":
      return Math.max(
        EHS_MIN_ADAPTIVE_BEATS,
        Math.min(Math.max(EHS_MAX_ADAPTIVE_BEATS, beatsInActiveMeasure), adaptiveBeats)
      );
  }
}

export function createEhsAdaptiveController(): EhsAdaptiveController {
  let adaptiveBeats = EHS_DEFAULT_ADAPTIVE_BEATS;
  let trend: "steady" | "expanding" | "contracting" = "steady";
  let lastLagMs: number | null = null;
  let lagWindow: number[] = [];
  let matchedSteps = 0;
  let missedSteps = 0;
  let consecutiveCleanSteps = 0;
  let consecutiveMissedSteps = 0;
  let stallCount = 0;
  let lastEventLabel = "待命 · 准备视奏";
  let struckNoteUids = new Set<string>();
  let matchedStepIndices = new Set<number>();
  let checkedMissStepIndex = -1;
  let boutStartScoreSec = 0;
  let cachedDocRef: ScoreDocument | null = null;
  let cachedSpans: MeasureBeatSpan[] = [];

  let peek: EhsPeekState = {
    active: false,
    holding: false,
    reason: null,
    untilMs: 0,
    remainingMs: 0,
    rescueMeasureIndex: null,
  };

  const getSpans = (doc: ScoreDocument | null): MeasureBeatSpan[] => {
    if (doc !== cachedDocRef) {
      cachedDocRef = doc;
      cachedSpans = buildMeasureBeatSpans(doc);
    }
    return cachedSpans;
  };

  const computeRollingHesitation = (): number | null => {
    if (lagWindow.length === 0) return null;
    const sum = lagWindow.reduce((acc, v) => acc + Math.abs(v), 0);
    return Math.round(sum / lagWindow.length);
  };

  const expandAdaptive = (amount: number, label: string) => {
    const next = Math.min(EHS_MAX_ADAPTIVE_BEATS, Math.round((adaptiveBeats + amount) * 20) / 20);
    if (next > adaptiveBeats) {
      adaptiveBeats = next;
      trend = "expanding";
      lastEventLabel = label;
    } else {
      trend = "steady";
      lastEventLabel = label;
    }
  };

  const contractAdaptive = (amount: number, label: string) => {
    const next = Math.max(EHS_MIN_ADAPTIVE_BEATS, Math.round((adaptiveBeats - amount) * 20) / 20);
    adaptiveBeats = next;
    trend = "contracting";
    lastEventLabel = label;
  };

  const activatePeek = (
    reason: Exclude<EhsPeekReason, null>,
    config: EhsConfig,
    nowMs: number,
    rescueMeasure: number | null = null
  ) => {
    if (config.peekMode === "hold" && reason !== "auto-stall") {
      peek = {
        active: true,
        holding: true,
        reason,
        untilMs: Number.POSITIVE_INFINITY,
        remainingMs: config.flashDurationMs,
        rescueMeasureIndex: rescueMeasure,
      };
      lastEventLabel = reason === "b0-key" ? "B0 按住透视中" : "按住透视中";
      return;
    }

    const duration = Math.max(600, config.flashDurationMs);
    peek = {
      active: true,
      holding: false,
      reason,
      untilMs: nowMs + duration,
      remainingMs: duration,
      rescueMeasureIndex: rescueMeasure,
    };
    lastEventLabel =
      reason === "auto-stall"
        ? `检测到卡壳 · 自动闪现 ${(duration / 1000).toFixed(1)}s`
        : reason === "b0-key"
          ? `B0 闪现回看 ${(duration / 1000).toFixed(1)}s`
          : `闪现回看 ${(duration / 1000).toFixed(1)}s`;
  };

  const getTelemetry = (): EhsAdaptiveTelemetry => ({
    adaptiveBeats,
    trend,
    lastLagMs,
    rollingHesitationMs: computeRollingHesitation(),
    matchedSteps,
    missedSteps,
    consecutiveCleanSteps,
    consecutiveMissedSteps,
    stallCount,
    struckNoteUids,
    lastEventLabel,
  });

  return {
    resetForBout(startScoreSec = 0) {
      boutStartScoreSec = Math.max(0, startScoreSec);
      lastLagMs = null;
      lagWindow = [];
      matchedSteps = 0;
      missedSteps = 0;
      consecutiveCleanSteps = 0;
      consecutiveMissedSteps = 0;
      stallCount = 0;
      struckNoteUids = new Set<string>();
      matchedStepIndices = new Set<number>();
      checkedMissStepIndex = -1;
      trend = "steady";
      lastEventLabel = "连续视奏开始 · 前瞻追踪中";
      peek = {
        active: false,
        holding: false,
        reason: null,
        untilMs: 0,
        remainingMs: 0,
        rescueMeasureIndex: null,
      };
    },

    recordMidiNoteOn({ midi, nowMs, scoreSec, speedMultiplier, practiceSteps, config }) {
      const speed = Math.max(0.25, speedMultiplier || 1);
      // Lightweight Bounded Window Attribution (ADR-0008 asymmetric capture window)
      let bestStep: PracticeStep | null = null;
      let bestAbsDiffMs = Infinity;
      let bestSignedLagMs = 0;

      for (let i = 0; i < practiceSteps.length; i++) {
        const step = practiceSteps[i];
        if (!step.expectedMidis.includes(midi)) continue;
        const nextStep = practiceSteps[i + 1];
        const prevStep = practiceSteps[i - 1];
        const ioiRealMs =
          nextStep && nextStep.onsetSec > step.onsetSec
            ? ((nextStep.onsetSec - step.onsetSec) / speed) * 1000
            : prevStep && step.onsetSec > prevStep.onsetSec
              ? ((step.onsetSec - prevStep.onsetSec) / speed) * 1000
              : 500;

        const wEarly = Math.min(240, Math.max(110, 0.42 * ioiRealMs));
        const wLate = Math.min(340, Math.max(150, 0.52 * ioiRealMs));
        const signedLagMs = ((scoreSec - step.onsetSec) / speed) * 1000;

        if (signedLagMs >= -wEarly && signedLagMs <= wLate) {
          const absDiff = Math.abs(signedLagMs);
          if (absDiff < bestAbsDiffMs) {
            bestAbsDiffMs = absDiff;
            bestSignedLagMs = signedLagMs;
            bestStep = step;
          }
        }
      }

      if (!bestStep) {
        return { matched: false, lagMs: null, triggeredAutoPeek: false };
      }

      // Mark struck noteUids so Variant B can dissolve played notes immediately
      for (const n of bestStep.expectedNotes) {
        if (n.midi === midi) {
          struckNoteUids.add(n.noteUid);
        }
      }

      const lagMs = Math.round(bestSignedLagMs);
      lastLagMs = lagMs;
      lagWindow = [...lagWindow.slice(-5), lagMs];

      let triggeredAutoPeek = false;
      if (!matchedStepIndices.has(bestStep.stepIndex)) {
        matchedStepIndices.add(bestStep.stepIndex);
        matchedSteps += 1;
        consecutiveMissedSteps = 0;

        if (Math.abs(lagMs) <= 135) {
          consecutiveCleanSteps += 1;
          if (consecutiveCleanSteps >= 3) {
            consecutiveCleanSteps = 0;
            expandAdaptive(0.25, `流畅命中 (${lagMs >= 0 ? "+" : ""}${lagMs}ms) → 前瞻 +0.25拍`);
          } else {
            trend = "steady";
            lastEventLabel = `命中 (${lagMs >= 0 ? "+" : ""}${lagMs}ms)`;
          }
        } else if (lagMs > 200) {
          consecutiveCleanSteps = 0;
          contractAdaptive(0.5, `步间犹豫 (+${lagMs}ms) → 前瞻收缩 -0.5拍`);
          if (config.peekMode === "auto-stall" && lagMs > 280) {
            stallCount += 1;
            activatePeek("auto-stall", config, nowMs, bestStep.measureIndex);
            triggeredAutoPeek = true;
          }
        } else {
          lastEventLabel = `命中 (${lagMs >= 0 ? "+" : ""}${lagMs}ms)`;
        }
      }

      return { matched: true, lagMs, triggeredAutoPeek };
    },

    tick({
      nowMs,
      scoreDoc,
      scoreSec,
      isPlaying,
      speedMultiplier,
      activeMetronomeBeat,
      practiceSteps,
      config,
      hasReceivedMidiInBout,
    }) {
      const spans = getSpans(scoreDoc);
      const speed = Math.max(0.25, speedMultiplier || 1);
      const pos = scoreSecToBeat(spans, scoreSec);

      // Update flash peek expiry
      if (peek.active && !peek.holding) {
        const remaining = peek.untilMs - nowMs;
        if (remaining <= 0) {
          peek = {
            active: false,
            holding: false,
            reason: null,
            untilMs: 0,
            remainingMs: 0,
            rescueMeasureIndex: null,
          };
          lastEventLabel = "回看结束 · 已恢复前瞻遮罩";
        } else {
          peek = { ...peek, remainingMs: Math.round(remaining) };
        }
      }

      // Check missed steps during active MIDI continuous play (for adaptive contraction + auto-stall peek)
      const isCountIn = Boolean(isPlaying && activeMetronomeBeat?.isCountIn);
      if (isPlaying && !isCountIn && hasReceivedMidiInBout && practiceSteps.length > 0) {
        const missThresholdScoreSec = 0.34 * speed;
        for (let i = Math.max(0, checkedMissStepIndex + 1); i < practiceSteps.length; i++) {
          const step = practiceSteps[i];
          if (step.onsetSec < boutStartScoreSec - 0.05) {
            checkedMissStepIndex = i;
            continue;
          }
          if (step.onsetSec > scoreSec - missThresholdScoreSec) {
            break;
          }
          checkedMissStepIndex = i;
          if (!matchedStepIndices.has(step.stepIndex)) {
            missedSteps += 1;
            consecutiveMissedSteps += 1;
            consecutiveCleanSteps = 0;
            contractAdaptive(0.5, `第${step.measureIndex + 1}小节漏步 → 前瞻收缩 -0.5拍`);
            if (config.peekMode === "auto-stall" && consecutiveMissedSteps >= 2 && !peek.active) {
              stallCount += 1;
              consecutiveMissedSteps = 0;
              activatePeek("auto-stall", config, nowMs, step.measureIndex);
            }
          }
        }
      }

      // Compute target lookahead and smooth ramp-in
      const targetLookaheadBeats = resolveTargetLookaheadBeats(
        config.lookaheadPolicy,
        pos.beatsInMeasure,
        adaptiveBeats
      );

      let handBeat = pos.scoreBeat;
      let effectiveLookaheadBeats = targetLookaheadBeats;

      if (isCountIn && activeMetronomeBeat) {
        const countdownRemaining = activeMetronomeBeat.countdownRemaining ?? 1;
        // During Count-In, handBeat counts up negatively toward start beat
        handBeat = pos.scoreBeat - countdownRemaining;
        if (!config.preRollMaskDuringCountIn) {
          effectiveLookaheadBeats = 0;
        }
      } else if (isPlaying) {
        // Gentle ramp-in on first 1.5 beats when starting without count-in so beat 1 isn't hidden unseen
        const startBeatPos = scoreSecToBeat(spans, boutStartScoreSec).scoreBeat;
        const elapsedBeats = Math.max(0, handBeat - startBeatPos);
        if (!config.preRollMaskDuringCountIn && elapsedBeats < targetLookaheadBeats) {
          effectiveLookaheadBeats = Math.min(targetLookaheadBeats, 0.25 + elapsedBeats * 0.85);
        }
      }

      const frontierBeat = handBeat + effectiveLookaheadBeats;
      // Locate frontier measure index
      let frontierMeasureIndex = pos.measureIndex;
      for (let i = 0; i < spans.length; i++) {
        if (frontierBeat < spans[i].endBeat || i === spans.length - 1) {
          frontierMeasureIndex = spans[i].measureIndex;
          break;
        }
      }

      const isMasked = config.enabled && !peek.active;

      return {
        handBeat,
        handMeasureIndex: pos.measureIndex,
        handBeatInMeasure: pos.beatInMeasure,
        effectiveLookaheadBeats: Math.round(effectiveLookaheadBeats * 100) / 100,
        targetLookaheadBeats: Math.round(targetLookaheadBeats * 100) / 100,
        frontierBeat,
        frontierMeasureIndex,
        isCountIn,
        isMasked,
        peek,
        telemetry: getTelemetry(),
      };
    },

    triggerPeek(reason, config, nowMs, rescueMeasure = null) {
      activatePeek(reason, config, nowMs, rescueMeasure);
    },

    releaseHoldPeek() {
      if (peek.holding) {
        peek = {
          active: false,
          holding: false,
          reason: null,
          untilMs: 0,
          remainingMs: 0,
          rescueMeasureIndex: null,
        };
        lastEventLabel = "松开回看 · 已恢复前瞻遮罩";
      }
    },

    simulateStall(config, nowMs, currentMeasureIndex) {
      missedSteps += 1;
      stallCount += 1;
      consecutiveCleanSteps = 0;
      lastLagMs = 340;
      lagWindow = [...lagWindow.slice(-5), 340];
      contractAdaptive(0.75, `模拟卡壳 (+340ms) → 前瞻收缩至 ${Math.max(EHS_MIN_ADAPTIVE_BEATS, adaptiveBeats - 0.75).toFixed(2)}拍`);
      if (config.peekMode === "auto-stall") {
        activatePeek("auto-stall", config, nowMs, currentMeasureIndex);
      }
    },

    simulateFluentStep() {
      matchedSteps += 1;
      consecutiveMissedSteps = 0;
      lastLagMs = 45;
      lagWindow = [...lagWindow.slice(-5), 45];
      expandAdaptive(0.5, `模拟流畅推进 (+45ms) → 前瞻扩展至 ${Math.min(EHS_MAX_ADAPTIVE_BEATS, adaptiveBeats + 0.5).toFixed(2)}拍`);
    },

    getTelemetry,
  };
}
