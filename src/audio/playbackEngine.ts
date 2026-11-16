import { computeTieChainEndByRoot } from "../domain/tieUtils";
import type { Hand, OnsetSlice, ScoreDocument } from "../domain/types";
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

export interface PlaybackEngineDeps {
  audioEngine: PianoAudioEngine;
  requestAnimationFrame?: (cb: FrameRequestCallback) => number;
  cancelAnimationFrame?: (id: number) => void;
  scheduleAheadRealSec?: number;
  onStateChange?: (state: PlaybackState) => void;
  onSliceChange?: (slice: OnsetSlice) => void;
  onCursorSync?: (target: CursorSyncTarget | null) => void;
  onFrame?: (frame: PlaybackFrame | null) => void;
}

export interface PlaybackEngine {
  getState(): PlaybackState;
  getSpeed(): PlaybackSpeed;
  setSpeed(speed: PlaybackSpeed): void;
  play(scoreDoc: ScoreDocument, options?: PlayOptions): Promise<void>;
  pause(): void;
  stop(): void;
  dispose(): void;
}

const GRACE_NOTE_PLAYBACK_SEC = 0.09;
const DEFAULT_SCHEDULE_AHEAD_REAL_SEC = 4.0;

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

  let state: PlaybackState = "stopped";
  let speed: PlaybackSpeed = 1.0;
  let runToken = 0;
  let rafId: number | null = null;

  let activeDoc: ScoreDocument | null = null;
  let activeSchedule: PlaybackSchedule | null = null;
  let nextNoteIndex = 0;
  let minSliceIndex = 0;
  let anchorAudioTime = 0;
  let anchorScoreSec = 0;
  let pausedScoreSec: number | null = null;
  let lastEmittedSliceId: string | null = null;
  let lastCursorBeatKey: string | null = null;

  const setState = (next: PlaybackState) => {
    if (state !== next) {
      state = next;
      deps.onStateChange?.(next);
    }
  };

  const clearRaf = () => {
    if (rafId !== null) {
      cancelRaf(rafId);
      rafId = null;
    }
  };

  const getCurrentScoreSec = (): number => {
    const ctx = deps.audioEngine.getAudioContext();
    const realElapsed = Math.max(0, ctx.currentTime - anchorAudioTime);
    return anchorScoreSec + realElapsed * speed;
  };

  const scheduleUpcomingNotes = () => {
    if (!activeSchedule) return;
    const ctx = deps.audioEngine.getAudioContext();
    const horizonScoreSec =
      anchorScoreSec + (Math.max(0, ctx.currentTime - anchorAudioTime) + scheduleAheadRealSec) * speed;

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

  const startPlaybackLoop = (
    doc: ScoreDocument,
    startScoreSec: number,
    fromSliceId?: string | null
  ) => {
    const schedule = buildPlaybackSchedule(doc, fromSliceId);
    // If resuming from a paused timestamp mid-score, filter notes at or after startScoreSec
    if (!fromSliceId && startScoreSec > 0) {
      schedule.notes = schedule.notes.filter((n) => n.onsetSec >= startScoreSec - 1e-4);
      schedule.startScoreSec = startScoreSec;
    }

    activeDoc = doc;
    activeSchedule = schedule;
    nextNoteIndex = 0;
    minSliceIndex = fromSliceId
      ? Math.max(0, doc.onsetSlices.findIndex((s) => s.sliceId === fromSliceId))
      : 0;
    lastEmittedSliceId = null;
    lastCursorBeatKey = null;

    const ctx = deps.audioEngine.getAudioContext();
    anchorAudioTime = ctx.currentTime;
    anchorScoreSec = startScoreSec;
    pausedScoreSec = null;

    setState("playing");
    scheduleUpcomingNotes();
    emitSyncForScoreSec(startScoreSec);

    const token = runToken;
    const step = () => {
      if (token !== runToken || state !== "playing" || !activeSchedule) return;
      const scoreSec = getCurrentScoreSec();
      scheduleUpcomingNotes();
      emitSyncForScoreSec(scoreSec);

      if (scoreSec >= activeSchedule.totalDurationSec && nextNoteIndex >= activeSchedule.notes.length) {
        clearRaf();
        activeSchedule = null;
        pausedScoreSec = null;
        setState("stopped");
        deps.onCursorSync?.(null);
        deps.onFrame?.(null);
        return;
      }

      rafId = requestRaf(step);
    };

    clearRaf();
    rafId = requestRaf(step);
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
        clearRaf();
        deps.audioEngine.stopAll();
        startPlaybackLoop(resumeDoc, currentScore);
      }
    },

    async play(scoreDoc: ScoreDocument, options?: PlayOptions) {
      const token = ++runToken;
      clearRaf();
      if (state === "playing") {
        deps.audioEngine.stopAll();
      }

      await deps.audioEngine.prepare();
      if (token !== runToken) return;

      if (scoreDoc.onsetSlices.length === 0) {
        setState("stopped");
        deps.onCursorSync?.(null);
        return;
      }

      let startScoreSec = 0;
      let startSliceId: string | null = null;

      if (options?.fromSliceId) {
        const target = scoreDoc.onsetSlices.find((s) => s.sliceId === options.fromSliceId);
        if (target) {
          startScoreSec = target.onsetSec;
          startSliceId = target.sliceId;
        }
      } else if (typeof options?.fromScoreSec === "number" && Number.isFinite(options.fromScoreSec)) {
        startScoreSec = Math.max(0, options.fromScoreSec);
      } else if (!options?.restart && state === "paused" && pausedScoreSec !== null && activeDoc === scoreDoc) {
        startScoreSec = pausedScoreSec;
      }

      startPlaybackLoop(scoreDoc, startScoreSec, startSliceId);
    },

    pause() {
      if (state !== "playing") return;
      const scoreSec = getCurrentScoreSec();
      runToken += 1;
      clearRaf();
      deps.audioEngine.stopAll();
      pausedScoreSec = scoreSec;
      setState("paused");
      emitFrameForState(scoreSec, "paused");
    },

    stop() {
      runToken += 1;
      clearRaf();
      deps.audioEngine.stopAll();
      activeSchedule = null;
      pausedScoreSec = null;
      lastEmittedSliceId = null;
      lastCursorBeatKey = null;
      setState("stopped");
      deps.onCursorSync?.(null);
      deps.onFrame?.(null);
    },

    dispose() {
      this.stop();
      deps.audioEngine.dispose();
    },
  };
}
