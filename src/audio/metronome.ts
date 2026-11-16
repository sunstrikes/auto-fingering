import type { ScoreDocument } from "../domain/types";
import { buildTickToSecMapper } from "../musicxml/parser";

export interface MetronomeBeatEvent {
  measureIndex: number;
  beatIndex: number;
  beatNumber: number;
  totalBeats: number;
  isAccent: boolean;
  isCountIn: boolean;
  countdownRemaining?: number;
}

export interface MetronomeAudio {
  getVolume(): number;
  setVolume(volume: number): void;
  triggerClick(params: { time: number; isAccent: boolean }): void;
  cancelPending(): void;
  stopAll(): void;
}

export function clampMetronomeVolume(value: number): number {
  if (!Number.isFinite(value)) return 0.7;
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

interface ActiveClickVoice {
  osc: OscillatorNode;
  gain: GainNode;
  startTime: number;
  stopTime: number;
}

/**
 * Synthesizes accented downbeat and unaccented sub-beat clicks on dedicated
 * Web Audio oscillator/gain nodes isolated from `PianoAudioEngine.stopAll()`.
 */
export function createMetronomeAudio(getAudioContext: () => AudioContext): MetronomeAudio {
  let volume = 0.7;
  let masterGain: GainNode | null = null;
  let masterCtx: AudioContext | null = null;
  const activeClicks = new Set<ActiveClickVoice>();

  const ensureMasterGain = (ctx: AudioContext): GainNode => {
    if (!masterGain || masterCtx !== ctx) {
      masterGain = ctx.createGain();
      masterGain.gain.value = volume;
      masterGain.connect(ctx.destination);
      masterCtx = ctx;
    }
    return masterGain;
  };

  const pruneFinished = (now: number) => {
    for (const click of activeClicks) {
      if (click.stopTime <= now) {
        activeClicks.delete(click);
      }
    }
  };

  const stopVoice = (voice: ActiveClickVoice, now: number) => {
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(0.0001, now);
    } catch {
      // ignore closed or mock node errors
    }
    try {
      voice.osc.stop(now + 0.005);
    } catch {
      // ignore already stopped oscillator
    }
  };

  return {
    getVolume: () => volume,

    setVolume(nextVolume: number) {
      volume = clampMetronomeVolume(nextVolume);
      if (masterGain && masterCtx) {
        masterGain.gain.value = volume;
        try {
          masterGain.gain.setValueAtTime(volume, masterCtx.currentTime);
        } catch {
          // ignore mock node without setValueAtTime
        }
      }
    },

    triggerClick({ time, isAccent }: { time: number; isAccent: boolean }) {
      const ctx = getAudioContext();
      const master = ensureMasterGain(ctx);
      pruneFinished(ctx.currentTime);

      const startTime = Math.max(ctx.currentTime, time);
      const stopTime = startTime + 0.05;
      const freq = isAccent ? 1200 : 800;
      const peakGain = isAccent ? 0.55 : 0.3;

      const osc = ctx.createOscillator();
      osc.type = isAccent ? "triangle" : "sine";
      osc.frequency.setValueAtTime(freq, startTime);

      const clickGain = ctx.createGain();
      clickGain.gain.setValueAtTime(0.0001, startTime);
      clickGain.gain.linearRampToValueAtTime(peakGain, startTime + 0.003);
      clickGain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.045);

      osc.connect(clickGain);
      clickGain.connect(master);

      osc.start(startTime);
      osc.stop(stopTime);

      activeClicks.add({ osc, gain: clickGain, startTime, stopTime });
    },

    cancelPending() {
      if (!masterCtx) return;
      const now = masterCtx.currentTime;
      for (const click of activeClicks) {
        if (click.startTime > now + 0.005) {
          stopVoice(click, now);
          activeClicks.delete(click);
        }
      }
    },

    stopAll() {
      if (!masterCtx) {
        activeClicks.clear();
        return;
      }
      const now = masterCtx.currentTime;
      for (const click of activeClicks) {
        stopVoice(click, now);
      }
      activeClicks.clear();
    },
  };
}

export interface ScheduledMetronomeBeat {
  measureIndex: number;
  beatIndex: number;
  beatNumber: number;
  totalBeats: number;
  tick: number;
  scoreSec: number;
  isAccent: boolean;
}

export interface CountInBeat {
  measureIndex: number;
  beatIndex: number;
  beatNumber: number;
  totalBeats: number;
  offsetRealSec: number;
  isAccent: boolean;
  countdownRemaining: number;
}

export interface CountInSchedule {
  beats: CountInBeat[];
  totalDurationRealSec: number;
}

/**
 * Generates beat events from each measure's `MeasureTimeline`, honoring
 * mid-piece time signature changes, `<sound tempo>` changes, and pickup
 * measure tick bounds (emitting only beats within `[startTick, endTick)`).
 */
export function buildMetronomeBeats(scoreDoc: ScoreDocument): ScheduledMetronomeBeat[] {
  if (!scoreDoc.measureTimelines.length || scoreDoc.ticksPerQuarter <= 0) {
    return [];
  }

  const tickToSec = buildTickToSecMapper(
    scoreDoc.tempoPoints.length > 0 ? scoreDoc.tempoPoints : [{ tick: 0, bpm: 100 }],
    scoreDoc.ticksPerQuarter
  );

  const beats: ScheduledMetronomeBeat[] = [];
  for (const measure of scoreDoc.measureTimelines) {
    if (measure.endTick <= measure.startTick || measure.timeBeatType <= 0) continue;
    const ticksPerBeat = (4 * scoreDoc.ticksPerQuarter) / measure.timeBeatType;
    if (ticksPerBeat <= 0) continue;

    for (let beatIndex = 0; ; beatIndex++) {
      const beatTick = measure.startTick + beatIndex * ticksPerBeat;
      if (beatTick >= measure.endTick - 1e-6) break;
      beats.push({
        measureIndex: measure.measureIndex,
        beatIndex,
        beatNumber: beatIndex + 1,
        totalBeats: measure.timeBeats,
        tick: beatTick,
        scoreSec: tickToSec(beatTick),
        isAccent: beatIndex === 0,
      });
    }
  }
  return beats;
}

function getBpmAtTick(scoreDoc: ScoreDocument, tick: number): number {
  const points = scoreDoc.tempoPoints;
  if (!points || points.length === 0) return 100;
  let bpm = points[0].bpm;
  for (const pt of points) {
    if (pt.tick <= tick) {
      bpm = pt.bpm;
    } else {
      break;
    }
  }
  return bpm > 0 ? bpm : 100;
}

/**
 * Generates a one-measure Count-In schedule at the starting measure's time signature
 * and active tempo, scaled by the active `SpeedMultiplier`.
 */
export function buildCountInBeats(
  scoreDoc: ScoreDocument,
  startMeasureIndex: number,
  speed: number
): CountInSchedule {
  const measure =
    scoreDoc.measureTimelines[startMeasureIndex] ?? scoreDoc.measureTimelines[0];
  const timeBeats = Math.max(1, measure?.timeBeats ?? 4);
  const timeBeatType = Math.max(1, measure?.timeBeatType ?? 4);
  const startTick = measure?.startTick ?? 0;
  const measureIndex = measure?.measureIndex ?? 0;

  const bpm = getBpmAtTick(scoreDoc, startTick);
  const safeSpeed = speed > 0 ? speed : 1.0;
  const beatRealSec = ((60 / bpm) * (4 / timeBeatType)) / safeSpeed;

  const beats: CountInBeat[] = [];
  for (let beatIndex = 0; beatIndex < timeBeats; beatIndex++) {
    beats.push({
      measureIndex,
      beatIndex,
      beatNumber: beatIndex + 1,
      totalBeats: timeBeats,
      offsetRealSec: beatIndex * beatRealSec,
      isAccent: beatIndex === 0,
      countdownRemaining: timeBeats - beatIndex,
    });
  }

  return {
    beats,
    totalDurationRealSec: timeBeats * beatRealSec,
  };
}
