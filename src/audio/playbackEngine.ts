import { computeTieChainEndByRoot } from "../domain/tieUtils";
import {
  createDefaultAbLoopBounds,
  normalizeAbLoopBounds,
  type AbLoopBounds,
  type Hand,
  type OnsetSlice,
  type ScoreDocument,
} from "../domain/types";
import {
  buildCountInBeats,
  buildMetronomeBeats,
  createMetronomeAudio,
  type MetronomeBeatEvent,
  type ScheduledMetronomeBeat,
} from "./metronome";
import type { PianoAudioEngine } from "./pianoAudio";

export const MIN_SPEED_MULTIPLIER = 0.25;
export const MAX_SPEED_MULTIPLIER = 1.5;
export const SPEED_PRESETS = [0.25, 0.5, 0.6, 0.75, 0.9, 1.0, 1.25, 1.5] as const;

export type SpeedMultiplier = number;
export type PlaybackSpeed = SpeedMultiplier;
export type PlaybackState = "stopped" | "playing" | "paused";

export function clampSpeedMultiplier(value: number): number {
  if (!Number.isFinite(value)) return 1.0;
  const clamped = Math.min(MAX_SPEED_MULTIPLIER, Math.max(MIN_SPEED_MULTIPLIER, value));
  return Math.round(clamped * 10000) / 10000;
}

export interface CursorSyncTarget {
  sliceId: string;
  measureIndex: number;
  onsetTick: number;
  isGrace: boolean;
  midis: number[];
}

export interface PlaybackFrame {
  scoreSec: number;
  totalDurationSec: number;
  state: PlaybackState;
}

export interface ScheduledPlaybackNote {
  noteUid: string;
  sliceId: string;
  midi: number;
  hand: Hand;
  measureIndex: number;
  onsetTick: number;
  onsetSec: number;
  durationSec: number;
  isGrace: boolean;
}

export interface PlaybackSchedule {
  notes: ScheduledPlaybackNote[];
  slices: OnsetSlice[];
  startScoreSec: number;
  totalDurationSec: number;
}

export interface PlayOptions {
  fromSliceId?: string | null;
  fromScoreSec?: number;
  restart?: boolean;
}

export interface BackgroundTicker {
  start(intervalMs: number, onTick: () => void): void;
  stop(): void;
}

export interface PlaybackEngineDeps {
  audioEngine: PianoAudioEngine;
  requestAnimationFrame?: (cb: FrameRequestCallback) => number;
  cancelAnimationFrame?: (id: number) => void;
  createBackgroundTicker?: () => BackgroundTicker;
  backgroundTickIntervalMs?: number;
  scheduleAheadRealSec?: number;
  onStateChange?: (state: PlaybackState) => void;
  onSliceChange?: (slice: OnsetSlice) => void;
  onCursorSync?: (target: CursorSyncTarget | null) => void;
  onFrame?: (frame: PlaybackFrame | null) => void;
  onMetronomeBeat?: (beat: MetronomeBeatEvent | null) => void;
}

export interface PlaybackEngine {
  getState(): PlaybackState;
  getSpeed(): PlaybackSpeed;
  setSpeed(speed: PlaybackSpeed): void;
  isMetronomeEnabled(): boolean;
  setMetronomeEnabled(enabled: boolean): void;
  isMetronomePaused(): boolean;
  setMetronomePaused(paused: boolean): void;
  triggerMetronomeBeat(event: MetronomeBeatEvent): void;
  getMetronomeVolume(): number;
  setMetronomeVolume(volume: number): void;
  isCountInEnabled(): boolean;
  setCountInEnabled(enabled: boolean): void;
  getAbLoop(): AbLoopBounds;
  setAbLoop(bounds: AbLoopBounds): void;
  playCountIn(
    scoreDoc: ScoreDocument,
    measureIndex: number,
    onComplete: () => void
  ): Promise<void>;
  play(scoreDoc: ScoreDocument, options?: PlayOptions): Promise<void>;
  pause(): void;
  stop(): void;
  dispose(): void;
}

const GRACE_NOTE_PLAYBACK_SEC = 0.09;
const DEFAULT_SCHEDULE_AHEAD_REAL_SEC = 4.0;
const DEFAULT_BACKGROUND_TICK_MS = 250;

/**
 * Creates a background-safe periodic ticker using an inline Web Worker when available
 * (which is not paused when a browser tab goes to the background like `requestAnimationFrame`),
 * falling back to `globalThis.setInterval` in restricted or test environments.
 */
function createDefaultBackgroundTicker(): BackgroundTicker {
  let worker: Worker | null = null;
  let blobUrl: string | null = null;
  let intervalId: ReturnType<typeof globalThis.setInterval> | null = null;

  const stop = () => {
    if (worker) {
      try {
        worker.postMessage({ type: "stop" });
      } catch {
        // ignore if already terminated
      }
      worker.terminate();
      worker = null;
    }
    if (blobUrl !== null && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
    if (intervalId !== null) {
      globalThis.clearInterval(intervalId);
      intervalId = null;
    }
  };

  const start = (intervalMs: number, onTick: () => void) => {
    stop();
    const safeMs = Math.max(50, Math.round(intervalMs));

    if (
      typeof Worker !== "undefined" &&
      typeof Blob !== "undefined" &&
      typeof URL !== "undefined" &&
      typeof URL.createObjectURL === "function"
    ) {
      try {
        const workerSource = [
          "let timerId = null;",
          "self.onmessage = (e) => {",
          "  if (e.data && e.data.type === 'start') {",
          "    if (timerId !== null) clearInterval(timerId);",
          "    timerId = setInterval(() => self.postMessage('tick'), e.data.intervalMs);",
          "  } else if (e.data && e.data.type === 'stop') {",
          "    if (timerId !== null) { clearInterval(timerId); timerId = null; }",
          "  }",
          "};",
        ].join("\n");
        blobUrl = URL.createObjectURL(new Blob([workerSource], { type: "application/javascript" }));
        worker = new Worker(blobUrl);
        let receivedWorkerTick = false;
        worker.onmessage = () => {
          receivedWorkerTick = true;
          onTick();
        };
        worker.onerror = () => {
          if (!receivedWorkerTick) {
            stop();
            intervalId = globalThis.setInterval(onTick, safeMs);
          }
        };
        worker.postMessage({ type: "start", intervalMs: safeMs });
        return;
      } catch {
        stop();
      }
    }

    intervalId = globalThis.setInterval(onTick, safeMs);
  };

  return { start, stop };
}

/**
 * Builds a playback schedule from a ScoreDocument, honoring `<sound tempo>` timings,
 * omitting `TieContinuation` (`isTieStop`) re-strikes while sustaining root notes
 * across their full tie chain, and optionally starting from a selected OnsetSlice.
 */
export function buildPlaybackSchedule(
  scoreDoc: ScoreDocument,
  startFromSliceId?: string | null
): PlaybackSchedule {
  const tieChainEndSecByRootUid = computeTieChainEndByRoot(scoreDoc.noteEvents, "sec");

  const slices = scoreDoc.onsetSlices;
  const startSliceIdx = startFromSliceId
    ? slices.findIndex((s) => s.sliceId === startFromSliceId)
    : -1;
  const startSlice = startSliceIdx >= 0 ? slices[startSliceIdx] : undefined;
  const startScoreSec = startSlice ? startSlice.onsetSec : 0;

  let totalDurationSec = 0;
  const notes: ScheduledPlaybackNote[] = [];

  slices.forEach((slice, idx) => {
    if (startSlice) {
      if (slice.onsetSec < startScoreSec - 1e-6) return;
      if (
        Math.abs(slice.onsetSec - startScoreSec) <= 1e-6 &&
        slice.isGrace &&
        !startSlice.isGrace
      ) {
        return;
      }
      if (
        Math.abs(slice.onsetSec - startScoreSec) <= 1e-6 &&
        slice.isGrace &&
        startSlice.isGrace &&
        slice.onsetTick === startSlice.onsetTick &&
        idx < startSliceIdx
      ) {
        return;
      }
    }

    for (const ev of slice.notes) {
      if (ev.isTieStop) continue;
      const rawEnd = ev.isGrace
        ? ev.onsetSec + GRACE_NOTE_PLAYBACK_SEC
        : tieChainEndSecByRootUid.get(ev.noteUid) ?? ev.onsetSec + ev.durationSec;
      const durationSec = Math.max(0.06, rawEnd - ev.onsetSec);
      totalDurationSec = Math.max(totalDurationSec, ev.onsetSec + durationSec);

      notes.push({
        noteUid: ev.noteUid,
        sliceId: slice.sliceId,
        midi: ev.midi,
        hand: ev.hand,
        measureIndex: ev.measureIndex,
        onsetTick: ev.onsetTick,
        onsetSec: ev.onsetSec,
        durationSec,
        isGrace: ev.isGrace,
      });
    }
  });

  for (const ev of scoreDoc.noteEvents) {
    const end = ev.onsetSec + ev.durationSec;
    if (end > totalDurationSec) totalDurationSec = end;
  }

  notes.sort((a, b) => a.onsetSec - b.onsetSec || a.midi - b.midi);

  return {
    notes,
    slices,
    startScoreSec,
    totalDurationSec,
  };
}

function buildCursorTarget(slices: OnsetSlice[], activeSlice: OnsetSlice): CursorSyncTarget {
  const midis: number[] = [];
  for (const s of slices) {
    if (
      s.measureIndex === activeSlice.measureIndex &&
      s.onsetTick === activeSlice.onsetTick &&
      s.isGrace === activeSlice.isGrace
    ) {
      for (const n of s.notes) {
        midis.push(n.midi);
      }
    }
  }
  return {
    sliceId: activeSlice.sliceId,
    measureIndex: activeSlice.measureIndex,
    onsetTick: activeSlice.onsetTick,
    isGrace: activeSlice.isGrace,
    midis,
  };
}

function findActiveSliceAtScoreSec(
  slices: OnsetSlice[],
  scoreSec: number,
  minSliceIndex: number
): OnsetSlice | null {
  if (slices.length === 0) return null;
  let active: OnsetSlice | null = null;
  for (let i = Math.max(0, minSliceIndex); i < slices.length; i++) {
    const s = slices[i];
    if (s.onsetSec <= scoreSec + 1e-4) {
      active = s;
    } else {
      break;
    }
  }
  return active;
}

/**
 * Coordinates Web Audio note scheduling against `AudioContext.currentTime` and
 * drives smooth `requestAnimationFrame` updates for OSMD cursor & keyboard sync.
 */
export function createPlaybackEngine(deps: PlaybackEngineDeps): PlaybackEngine {
  const requestRaf =
    deps.requestAnimationFrame ?? ((cb: FrameRequestCallback) => globalThis.requestAnimationFrame(cb));
  const cancelRaf =
    deps.cancelAnimationFrame ?? ((id: number) => globalThis.cancelAnimationFrame(id));
  const scheduleAheadRealSec = deps.scheduleAheadRealSec ?? DEFAULT_SCHEDULE_AHEAD_REAL_SEC;
  const backgroundTickIntervalMs = deps.backgroundTickIntervalMs ?? DEFAULT_BACKGROUND_TICK_MS;
  const backgroundTicker = (deps.createBackgroundTicker ?? createDefaultBackgroundTicker)();
  const metronomeAudio = createMetronomeAudio(() => deps.audioEngine.getAudioContext());

  let state: PlaybackState = "stopped";
  let speed: PlaybackSpeed = 1.0;
  let metronomeEnabled = false;
  let metronomePaused = false;
  let countInEnabled = false;
  let abLoop: AbLoopBounds = createDefaultAbLoopBounds(0);
  let runToken = 0;
  let rafId: number | null = null;
  let activeTick: (() => boolean) | null = null;

  let activeDoc: ScoreDocument | null = null;
  let activeSchedule: PlaybackSchedule | null = null;
  let nextNoteIndex = 0;
  let minSliceIndex = 0;
  let anchorAudioTime = 0;
  let anchorScoreSec = 0;
  let pausedScoreSec: number | null = null;
  let lastEmittedSliceId: string | null = null;
  let lastCursorBeatKey: string | null = null;

  interface ScheduledVisualBeat {
    key: string;
    audioTime: number;
    event: MetronomeBeatEvent;
  }
  let activeScoreBeats: ScheduledMetronomeBeat[] = [];
  let nextScoreBeatIndex = 0;
  let visualBeatTimeline: ScheduledVisualBeat[] = [];
  let lastEmittedBeatKey: string | null = null;

  const setState = (next: PlaybackState) => {
    if (state !== next) {
      state = next;
      deps.onStateChange?.(next);
    }
  };

  const clearTimers = () => {
    if (rafId !== null) {
      cancelRaf(rafId);
      rafId = null;
    }
    backgroundTicker.stop();
    activeTick = null;
  };

  const startDrivers = (tick: () => boolean) => {
    clearTimers();
    activeTick = tick;
    const rafStep = () => {
      if (!tick()) return;
      rafId = requestRaf(rafStep);
    };
    rafId = requestRaf(rafStep);
    backgroundTicker.start(backgroundTickIntervalMs, () => {
      tick();
    });
  };

  const handleVisibilityChange = () => {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "visible") {
      if (state === "playing" || activeTick !== null) {
        const ctx = deps.audioEngine.getAudioContext();
        const ctxState = ctx.state as string;
        if ((ctxState === "suspended" || ctxState === "interrupted") && typeof ctx.resume === "function") {
          void ctx.resume().catch(() => {});
        }
        activeTick?.();
      }
    } else if (document.visibilityState === "hidden") {
      if (state === "playing" || activeTick !== null) {
        activeTick?.();
      }
    }
  };

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  const getCurrentScoreSec = (): number => {
    const ctx = deps.audioEngine.getAudioContext();
    const realElapsed = Math.max(0, ctx.currentTime - anchorAudioTime);
    return anchorScoreSec + realElapsed * speed;
  };

  const scheduleUpcomingNotes = () => {
    if (!activeSchedule) return;
    const ctx = deps.audioEngine.getAudioContext();
    const horizonScoreSec =
      anchorScoreSec + (ctx.currentTime + scheduleAheadRealSec - anchorAudioTime) * speed;

    while (nextNoteIndex < activeSchedule.notes.length) {
      const note = activeSchedule.notes[nextNoteIndex];
      if (note.onsetSec > horizonScoreSec + 1e-6) break;

      const audioTime = anchorAudioTime + Math.max(0, note.onsetSec - anchorScoreSec) / speed;
      const audioDuration = Math.max(0.05, note.durationSec / speed);
      deps.audioEngine.triggerNote({
        midi: note.midi,
        time: audioTime,
        duration: audioDuration,
      });
      nextNoteIndex += 1;
    }
  };

  const scheduleUpcomingBeats = () => {
    if (!metronomeEnabled || metronomePaused) return;
    const ctx = deps.audioEngine.getAudioContext();
    const horizonScoreSec =
      anchorScoreSec + (ctx.currentTime + scheduleAheadRealSec - anchorAudioTime) * speed;

    while (nextScoreBeatIndex < activeScoreBeats.length) {
      const beat = activeScoreBeats[nextScoreBeatIndex];
      if (beat.scoreSec > horizonScoreSec + 1e-6) break;

      const audioTime = anchorAudioTime + Math.max(0, beat.scoreSec - anchorScoreSec) / speed;
      metronomeAudio.triggerClick({ time: audioTime, isAccent: beat.isAccent });
      visualBeatTimeline.push({
        key: `score:${beat.measureIndex}:${beat.beatIndex}:${audioTime.toFixed(4)}`,
        audioTime,
        event: {
          measureIndex: beat.measureIndex,
          beatIndex: beat.beatIndex,
          beatNumber: beat.beatNumber,
          totalBeats: beat.totalBeats,
          isAccent: beat.isAccent,
          isCountIn: false,
        },
      });
      nextScoreBeatIndex += 1;
    }
  };

  const emitActiveMetronomeBeat = () => {
    const ctx = deps.audioEngine.getAudioContext();
    const now = ctx.currentTime;
    let latest: ScheduledVisualBeat | null = null;
    for (const item of visualBeatTimeline) {
      if (item.audioTime <= now + 1e-4) {
        latest = item;
      } else {
        break;
      }
    }
    if (latest && latest.key !== lastEmittedBeatKey) {
      lastEmittedBeatKey = latest.key;
      deps.onMetronomeBeat?.(latest.event);
    }
  };

  const emitFrameForState = (scoreSec: number, nextState: PlaybackState) => {
    if (!activeSchedule) return;
    deps.onFrame?.({
      scoreSec,
      totalDurationSec: activeSchedule.totalDurationSec,
      state: nextState,
    });
  };

  const emitSyncForScoreSec = (scoreSec: number) => {
    if (!activeSchedule) return;
    emitFrameForState(scoreSec, "playing");
    const activeSlice = findActiveSliceAtScoreSec(activeSchedule.slices, scoreSec, minSliceIndex);
    if (!activeSlice) return;

    if (activeSlice.sliceId !== lastEmittedSliceId) {
      lastEmittedSliceId = activeSlice.sliceId;
      deps.onSliceChange?.(activeSlice);
    }

    const beatKey = `${activeSlice.measureIndex}:${activeSlice.onsetTick}:${activeSlice.isGrace}`;
    if (beatKey !== lastCursorBeatKey) {
      lastCursorBeatKey = beatKey;
      deps.onCursorSync?.(buildCursorTarget(activeSchedule.slices, activeSlice));
    }
  };

  const resolveStartMeasureIndex = (
    doc: ScoreDocument,
    startScoreSec: number,
    fromSliceId?: string | null
  ): number => {
    if (fromSliceId) {
      const target = doc.onsetSlices.find((s) => s.sliceId === fromSliceId);
      if (target) return target.measureIndex;
    }
    for (let i = doc.measureTimelines.length - 1; i >= 0; i--) {
      if (doc.measureTimelines[i].startSec <= startScoreSec + 1e-4) {
        return doc.measureTimelines[i].measureIndex;
      }
    }
    return 0;
  };

  const resolveLoopRange = (doc: ScoreDocument) => {
    if (!abLoop.enabled || doc.measureTimelines.length === 0) return null;
    const norm = normalizeAbLoopBounds(abLoop, doc.measureTimelines.length);
    const startMeasure = doc.measureTimelines[norm.startMeasureIndex];
    const endMeasure = doc.measureTimelines[norm.endMeasureIndex];
    if (!startMeasure || !endMeasure) return null;
    return {
      startMeasureIndex: norm.startMeasureIndex,
      endMeasureIndex: norm.endMeasureIndex,
      startSec: startMeasure.startSec,
      endSec: endMeasure.endSec,
      loopGap: norm.loopGap,
    };
  };

  const startPlaybackLoop = (
    doc: ScoreDocument,
    startScoreSec: number,
    fromSliceId?: string | null,
    useCountIn = false,
    countInStartAudioTimeOverride?: number
  ) => {
    const loopRange = resolveLoopRange(doc);
    const schedule = buildPlaybackSchedule(doc, fromSliceId);
    // If resuming from a paused timestamp mid-score, filter notes at or after startScoreSec
    if (!fromSliceId && startScoreSec > 0) {
      schedule.notes = schedule.notes.filter((n) => n.onsetSec >= startScoreSec - 1e-4);
      schedule.startScoreSec = startScoreSec;
    }

    if (loopRange) {
      schedule.notes = schedule.notes
        .filter((n) => n.onsetSec < loopRange.endSec - 1e-6)
        .map((n) => ({
          ...n,
          durationSec: Math.min(n.durationSec, Math.max(0.05, loopRange.endSec - n.onsetSec)),
        }));
    }

    activeDoc = doc;
    activeSchedule = schedule;
    nextNoteIndex = 0;
    minSliceIndex = fromSliceId
      ? Math.max(0, doc.onsetSlices.findIndex((s) => s.sliceId === fromSliceId))
      : 0;
    lastEmittedSliceId = null;
    lastCursorBeatKey = null;

    activeScoreBeats = buildMetronomeBeats(doc).filter(
      (b) =>
        b.scoreSec >= startScoreSec - 1e-4 &&
        (!loopRange || b.scoreSec < loopRange.endSec - 1e-4)
    );
    nextScoreBeatIndex = 0;
    visualBeatTimeline = [];
    lastEmittedBeatKey = null;

    const ctx = deps.audioEngine.getAudioContext();
    const countInStartAudioTime = countInStartAudioTimeOverride ?? ctx.currentTime;
    const startMeasureIndex = resolveStartMeasureIndex(doc, startScoreSec, fromSliceId);
    const countIn = useCountIn ? buildCountInBeats(doc, startMeasureIndex, speed) : null;
    const countInDurationRealSec = countIn ? countIn.totalDurationRealSec : 0;

    anchorAudioTime = countInStartAudioTime + countInDurationRealSec;
    anchorScoreSec = startScoreSec;
    pausedScoreSec = null;

    if (countIn) {
      for (const beat of countIn.beats) {
        const audioTime = countInStartAudioTime + beat.offsetRealSec;
        metronomeAudio.triggerClick({ time: audioTime, isAccent: beat.isAccent });
        visualBeatTimeline.push({
          key: `countin:${beat.measureIndex}:${beat.beatIndex}:${audioTime.toFixed(4)}`,
          audioTime,
          event: {
            measureIndex: beat.measureIndex,
            beatIndex: beat.beatIndex,
            beatNumber: beat.beatNumber,
            totalBeats: beat.totalBeats,
            isAccent: beat.isAccent,
            isCountIn: true,
            countdownRemaining: beat.countdownRemaining,
          },
        });
      }
    }

    setState("playing");
    scheduleUpcomingNotes();
    scheduleUpcomingBeats();
    emitActiveMetronomeBeat();

    if (ctx.currentTime >= anchorAudioTime - 1e-6) {
      emitSyncForScoreSec(startScoreSec);
    } else {
      emitFrameForState(startScoreSec, "playing");
    }

    const token = runToken;
    const tickPlayback = (): boolean => {
      if (token !== runToken || state !== "playing" || !activeSchedule || !activeDoc) return false;
      const now = deps.audioEngine.getAudioContext().currentTime;
      scheduleUpcomingNotes();
      scheduleUpcomingBeats();
      emitActiveMetronomeBeat();

      if (now < anchorAudioTime - 1e-6) {
        emitFrameForState(anchorScoreSec, "playing");
        return true;
      }

      const scoreSec = getCurrentScoreSec();
      const activeLoop = resolveLoopRange(activeDoc);
      if (activeLoop && scoreSec >= activeLoop.endSec - 1e-6) {
        const loopEndAudioTime =
          anchorAudioTime + Math.max(0, activeLoop.endSec - anchorScoreSec) / speed;
        startPlaybackLoop(
          activeDoc,
          activeLoop.startSec,
          undefined,
          activeLoop.loopGap,
          loopEndAudioTime
        );
        return false;
      }

      emitSyncForScoreSec(scoreSec);

      if (scoreSec >= activeSchedule.totalDurationSec && nextNoteIndex >= activeSchedule.notes.length) {
        clearTimers();
        activeSchedule = null;
        pausedScoreSec = null;
        lastEmittedBeatKey = null;
        setState("stopped");
        deps.onCursorSync?.(null);
        deps.onFrame?.(null);
        deps.onMetronomeBeat?.(null);
        return false;
      }

      return true;
    };

    startDrivers(tickPlayback);
  };

  return {
    getState: () => state,
    getSpeed: () => speed,

    setSpeed(nextSpeed: PlaybackSpeed) {
      const clamped = clampSpeedMultiplier(nextSpeed);
      if (speed === clamped) return;
      const wasPlaying = state === "playing";
      const resumeDoc = activeDoc;
      const currentScore = wasPlaying ? getCurrentScoreSec() : pausedScoreSec;
      speed = clamped;

      if (wasPlaying && resumeDoc && currentScore !== null) {
        runToken += 1;
        clearTimers();
        deps.audioEngine.stopAll();
        metronomeAudio.cancelPending();
        startPlaybackLoop(resumeDoc, currentScore, undefined, false);
      }
    },

    isMetronomeEnabled: () => metronomeEnabled,

    setMetronomeEnabled(enabled: boolean) {
      if (metronomeEnabled === enabled) return;
      metronomeEnabled = enabled;
      if (state === "playing") {
        if (enabled) {
          const currentScore = getCurrentScoreSec();
          while (
            nextScoreBeatIndex < activeScoreBeats.length &&
            activeScoreBeats[nextScoreBeatIndex].scoreSec < currentScore - 1e-4
          ) {
            nextScoreBeatIndex += 1;
          }
          scheduleUpcomingBeats();
          emitActiveMetronomeBeat();
        } else {
          metronomeAudio.cancelPending();
          const now = deps.audioEngine.getAudioContext().currentTime;
          visualBeatTimeline = visualBeatTimeline.filter(
            (b) => b.event.isCountIn || b.audioTime <= now + 1e-4
          );
          if (now >= anchorAudioTime - 1e-6) {
            deps.onMetronomeBeat?.(null);
          }
        }
      }
    },

    getMetronomeVolume: () => metronomeAudio.getVolume(),

    isMetronomePaused: () => metronomePaused,

    setMetronomePaused(paused: boolean) {
      if (metronomePaused === paused) return;
      metronomePaused = paused;
      if (paused) {
        metronomeAudio.cancelPending();
      } else if (state === "playing" && metronomeEnabled) {
        const currentScore = getCurrentScoreSec();
        while (
          nextScoreBeatIndex < activeScoreBeats.length &&
          activeScoreBeats[nextScoreBeatIndex].scoreSec < currentScore - 1e-4
        ) {
          nextScoreBeatIndex += 1;
        }
        scheduleUpcomingBeats();
        emitActiveMetronomeBeat();
      }
    },

    triggerMetronomeBeat(event: MetronomeBeatEvent) {
      if (!metronomeEnabled || metronomePaused) return;
      const ctx = deps.audioEngine.getAudioContext();
      metronomeAudio.triggerClick({ time: ctx.currentTime, isAccent: event.isAccent });
      deps.onMetronomeBeat?.(event);
    },

    setMetronomeVolume(volume: number) {
      metronomeAudio.setVolume(volume);
    },

    isCountInEnabled: () => countInEnabled,

    setCountInEnabled(enabled: boolean) {
      countInEnabled = enabled;
    },

    getAbLoop: () => abLoop,

    setAbLoop(bounds: AbLoopBounds) {
      const normalized = normalizeAbLoopBounds(
        bounds,
        activeDoc?.measureTimelines.length
      );
      abLoop = normalized;
      if (state === "playing" && activeDoc) {
        const currentScore = getCurrentScoreSec();
        const loopRange = resolveLoopRange(activeDoc);
        let nextScore = currentScore;
        if (loopRange && (currentScore < loopRange.startSec - 1e-4 || currentScore >= loopRange.endSec - 1e-4)) {
          nextScore = loopRange.startSec;
        }
        runToken += 1;
        clearTimers();
        deps.audioEngine.stopAll();
        metronomeAudio.cancelPending();
        startPlaybackLoop(activeDoc, nextScore, undefined, false);
      }
    },

    async playCountIn(scoreDoc: ScoreDocument, measureIndex: number, onComplete: () => void) {
      const token = ++runToken;
      clearTimers();
      metronomeAudio.cancelPending();
      await deps.audioEngine.prepare();
      if (token !== runToken) return;

      const ctx = deps.audioEngine.getAudioContext();
      const startAudioTime = ctx.currentTime;
      const countIn = buildCountInBeats(scoreDoc, measureIndex, speed);
      const endAudioTime = startAudioTime + countIn.totalDurationRealSec;

      visualBeatTimeline = [];
      lastEmittedBeatKey = null;

      for (const beat of countIn.beats) {
        const audioTime = startAudioTime + beat.offsetRealSec;
        metronomeAudio.triggerClick({ time: audioTime, isAccent: beat.isAccent });
        visualBeatTimeline.push({
          key: `countin:${beat.measureIndex}:${beat.beatIndex}:${audioTime.toFixed(4)}`,
          audioTime,
          event: {
            measureIndex: beat.measureIndex,
            beatIndex: beat.beatIndex,
            beatNumber: beat.beatNumber,
            totalBeats: beat.totalBeats,
            isAccent: beat.isAccent,
            isCountIn: true,
            countdownRemaining: beat.countdownRemaining,
          },
        });
      }

      emitActiveMetronomeBeat();

      const tickCountIn = (): boolean => {
        if (token !== runToken) return false;
        const now = deps.audioEngine.getAudioContext().currentTime;
        emitActiveMetronomeBeat();
        if (now >= endAudioTime - 1e-6) {
          clearTimers();
          visualBeatTimeline = [];
          lastEmittedBeatKey = null;
          deps.onMetronomeBeat?.(null);
          onComplete();
          return false;
        }
        return true;
      };

      startDrivers(tickCountIn);
    },

    async play(scoreDoc: ScoreDocument, options?: PlayOptions) {
      const token = ++runToken;
      clearTimers();
      const prevState = state;
      if (prevState === "playing") {
        deps.audioEngine.stopAll();
        metronomeAudio.stopAll();
      } else {
        metronomeAudio.cancelPending();
      }

      await deps.audioEngine.prepare();
      if (token !== runToken) return;

      if (scoreDoc.onsetSlices.length === 0) {
        setState("stopped");
        deps.onCursorSync?.(null);
        deps.onMetronomeBeat?.(null);
        return;
      }

      let startScoreSec = 0;
      let startSliceId: string | null = null;
      let isResumingPaused = false;

      if (options?.fromSliceId) {
        const target = scoreDoc.onsetSlices.find((s) => s.sliceId === options.fromSliceId);
        if (target) {
          startScoreSec = target.onsetSec;
          startSliceId = target.sliceId;
        }
      } else if (typeof options?.fromScoreSec === "number" && Number.isFinite(options.fromScoreSec)) {
        startScoreSec = Math.max(0, options.fromScoreSec);
      } else if (!options?.restart && prevState === "paused" && pausedScoreSec !== null && activeDoc === scoreDoc) {
        startScoreSec = pausedScoreSec;
        isResumingPaused = true;
      }

      const loopRange = resolveLoopRange(scoreDoc);
      if (
        loopRange &&
        (startScoreSec < loopRange.startSec - 1e-4 || startScoreSec >= loopRange.endSec - 1e-4)
      ) {
        startScoreSec = loopRange.startSec;
        startSliceId = null;
      }

      const useCountIn = countInEnabled && !isResumingPaused;
      startPlaybackLoop(scoreDoc, startScoreSec, startSliceId, useCountIn);
    },

    pause() {
      if (state !== "playing") return;
      const scoreSec = getCurrentScoreSec();
      runToken += 1;
      clearTimers();
      deps.audioEngine.stopAll();
      metronomeAudio.stopAll();
      pausedScoreSec = scoreSec;
      lastEmittedBeatKey = null;
      setState("paused");
      emitFrameForState(scoreSec, "paused");
      deps.onMetronomeBeat?.(null);
    },

    stop() {
      runToken += 1;
      clearTimers();
      deps.audioEngine.stopAll();
      metronomeAudio.stopAll();
      activeSchedule = null;
      visualBeatTimeline = [];
      pausedScoreSec = null;
      lastEmittedSliceId = null;
      lastCursorBeatKey = null;
      lastEmittedBeatKey = null;
      setState("stopped");
      deps.onCursorSync?.(null);
      deps.onFrame?.(null);
      deps.onMetronomeBeat?.(null);
    },

    dispose() {
      this.stop();
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      deps.audioEngine.dispose();
    },
  };
}
