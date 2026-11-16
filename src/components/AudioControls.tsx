import type { AudioEngineStatus } from "../audio/pianoAudio";
import type { PlaybackSpeed, PlaybackState } from "../audio/playbackEngine";

export interface AudioControlsProps {
  hasScore: boolean;
  hasSelectedSlice: boolean;
  playbackState: PlaybackState;
  playbackSpeed: PlaybackSpeed;
  audioStatus: AudioEngineStatus;
  onPlay: () => void;
  onPlayFromSlice: () => void;
  onPause: () => void;
  onStop: () => void;
  onChangeSpeed: (speed: PlaybackSpeed) => void;
}

const SPEED_OPTIONS: PlaybackSpeed[] = [0.5, 0.75, 1.0, 1.25];

const AUDIO_STATUS_LABELS: Record<AudioEngineStatus, { text: string; badgeClass: string }> = {
  idle: {
    text: "Audio: Idle",
    badgeClass: "border-slate-200 bg-slate-50 text-slate-600",
  },
  loading: {
    text: "Audio: Loading...",
    badgeClass: "border-blue-200 bg-blue-50 text-blue-700",
  },
  samples: {
    text: "Audio: Piano Samples",
    badgeClass: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  synth: {
    text: "Audio: Synth Fallback",
    badgeClass: "border-amber-200 bg-amber-50 text-amber-800",
  },
};

/**
 * Top-bar audio auditioning controls: Play, Play from selected slice, Pause, Stop,
 * speed selector (0.5x–1.25x), and lazy-loaded sample / synth fallback status badge.
 */
export function AudioControls({
  hasScore,
  hasSelectedSlice,
  playbackState,
  playbackSpeed,
  audioStatus,
  onPlay,
  onPlayFromSlice,
  onPause,
  onStop,
  onChangeSpeed,
}: AudioControlsProps) {
  const statusInfo = AUDIO_STATUS_LABELS[audioStatus];

  return (
    <div
      data-testid="audio-controls"
      className="flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1"
    >
      <button
        type="button"
        data-testid="audio-play-btn"
        disabled={!hasScore || playbackState === "playing"}
        onClick={onPlay}
        className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-45"
      >
        {playbackState === "paused" ? "Resume" : "Play"}
      </button>

      <button
        type="button"
        data-testid="audio-play-slice-btn"
        disabled={!hasScore || !hasSelectedSlice}
        onClick={onPlayFromSlice}
        title="Play starting from the currently selected slice"
        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
      >
        From Slice
      </button>

      <button
        type="button"
        data-testid="audio-pause-btn"
        disabled={playbackState !== "playing"}
        onClick={onPause}
        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
      >
        Pause
      </button>

      <button
        type="button"
        data-testid="audio-stop-btn"
        disabled={playbackState === "stopped"}
        onClick={onStop}
        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
      >
        Stop
      </button>

      <select
        aria-label="Playback speed"
        data-testid="audio-speed-select"
        value={String(playbackSpeed)}
        onChange={(e) => onChangeSpeed(Number(e.target.value) as PlaybackSpeed)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700"
      >
        {SPEED_OPTIONS.map((spd) => (
          <option key={spd} value={String(spd)}>
            {spd.toFixed(spd === 1 ? 1 : 2).replace(/\.00$/, ".0")}x
          </option>
        ))}
      </select>

      <span
        data-testid="audio-engine-status"
        className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusInfo.badgeClass}`}
      >
        {statusInfo.text}
      </span>
    </div>
  );
}
