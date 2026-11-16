import { useState } from "react";
import type { AudioEngineStatus } from "../audio/pianoAudio";
import {
  clampSpeedMultiplier,
  MAX_SPEED_MULTIPLIER,
  MIN_SPEED_MULTIPLIER,
  SPEED_PRESETS,
  type PlaybackState,
  type SpeedMultiplier,
} from "../audio/playbackEngine";
import type { MeasureTimeline } from "../domain/types";

export interface TransportPracticeBarProps {
  hasScore: boolean;
  hasSelectedSlice: boolean;
  playbackState: PlaybackState;
  speedMultiplier: SpeedMultiplier;
  baseBpm: number;
  audioStatus: AudioEngineStatus;
  measureCount: number;
  measureTimelines: MeasureTimeline[];
  activeMeasureIndex: number | null;
  onPlay: () => void;
  onPlayFromSlice: () => void;
  onPause: () => void;
  onStop: () => void;
  onJumpToStart: () => void;
  onJumpToMeasure: (measureIndex: number) => void;
  onChangeSpeed: (speed: SpeedMultiplier) => void;
}

const SPEED_STEP = 0.05;

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

function formatSpeedLabel(spd: number): string {
  return `${Number(spd.toFixed(2))}x`;
}

/**
 * Dedicated Transport & Practice Bar placed between the score pane and 88-key keyboard.
 * Houses the interactive measure ruler, transport buttons, continuous Speed Multiplier
 * presets/steppers/BPM editor, audio status badge, and Practice Settings modal shell.
 */
export function TransportPracticeBar({
  hasScore,
  hasSelectedSlice,
  playbackState,
  speedMultiplier,
  baseBpm,
  audioStatus,
  measureCount,
  measureTimelines,
  activeMeasureIndex,
  onPlay,
  onPlayFromSlice,
  onPause,
  onStop,
  onJumpToStart,
  onJumpToMeasure,
  onChangeSpeed,
}: TransportPracticeBarProps) {
  const [editingBpm, setEditingBpm] = useState(false);
  const [bpmDraft, setBpmDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const safeBaseBpm = baseBpm > 0 ? baseBpm : 100;
  const effectiveBpm = Math.max(1, Math.round(safeBaseBpm * speedMultiplier));
  const statusInfo = AUDIO_STATUS_LABELS[audioStatus];

  const rulerMeasures: Array<{ measureIndex: number; isPickup: boolean; label: string }> =
    measureTimelines.length > 0
      ? measureTimelines.map((m) => ({
          measureIndex: m.measureIndex,
          isPickup: m.isPickup,
          label: m.isPickup
            ? `m.${m.measureIndex + 1} (pickup, ${m.timeBeats}/${m.timeBeatType})`
            : `m.${m.measureIndex + 1} (${m.timeBeats}/${m.timeBeatType})`,
        }))
      : Array.from({ length: measureCount }, (_, i) => ({
          measureIndex: i,
          isPickup: false,
          label: `m.${i + 1}`,
        }));

  const beginEditBpm = () => {
    setBpmDraft(String(effectiveBpm));
    setEditingBpm(true);
  };

  const commitBpm = () => {
    const parsed = Number.parseFloat(bpmDraft);
    if (Number.isFinite(parsed) && parsed > 0) {
      onChangeSpeed(clampSpeedMultiplier(parsed / safeBaseBpm));
    }
    setEditingBpm(false);
  };

  return (
    <section
      data-testid="transport-practice-bar"
      aria-label="Transport and practice bar"
      className="shrink-0 border-y border-slate-200 bg-white px-4 py-1.5"
    >
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2">
        {/* Left: Transport Buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="transport-jump-start-btn"
            disabled={!hasScore}
            onClick={onJumpToStart}
            title="Jump to start of score"
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
          >
            ⏮ Start
          </button>

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
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
          >
            From Slice
          </button>

          <button
            type="button"
            data-testid="audio-pause-btn"
            disabled={playbackState !== "playing"}
            onClick={onPause}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
          >
            Pause
          </button>

          <button
            type="button"
            data-testid="audio-stop-btn"
            disabled={playbackState === "stopped"}
            onClick={onStop}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
          >
            Stop
          </button>
        </div>

        {/* Center: Interactive Measure Ruler */}
        <div
          data-testid="measure-ruler"
          aria-label="Measure ruler"
          className="flex min-w-[160px] flex-1 items-center gap-1 overflow-x-auto rounded-md border border-slate-200 bg-slate-50 px-1.5 py-1"
        >
          {rulerMeasures.length === 0 ? (
            <span className="px-2 text-[11px] text-slate-400">Load a score to view measures</span>
          ) : (
            rulerMeasures.map((m) => {
              const isActive = activeMeasureIndex === m.measureIndex;
              return (
                <button
                  key={m.measureIndex}
                  type="button"
                  data-testid={`measure-ruler-item-${m.measureIndex}`}
                  title={m.label}
                  onClick={() => onJumpToMeasure(m.measureIndex)}
                  className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium transition ${
                    isActive
                      ? "bg-blue-600 text-white shadow-sm"
                      : m.isPickup
                        ? "border border-dashed border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
                        : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {m.measureIndex + 1}
                  {m.isPickup ? "·p" : ""}
                </button>
              );
            })
          )}
        </div>

        {/* Right: Speed Multiplier Presets + Steppers + BPM Editor + Audio Status + Settings */}
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-0.5 rounded-md border border-slate-200 bg-slate-50 p-0.5">
            <button
              type="button"
              data-testid="speed-step-down-btn"
              disabled={speedMultiplier <= MIN_SPEED_MULTIPLIER + 1e-4}
              onClick={() => onChangeSpeed(clampSpeedMultiplier(speedMultiplier - SPEED_STEP))}
              title="Decrease speed by 0.05x"
              className="rounded px-1.5 py-0.5 text-xs font-semibold text-slate-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              -
            </button>

            {SPEED_PRESETS.map((spd) => {
              const isSelected = Math.abs(speedMultiplier - spd) < 1e-4;
              return (
                <button
                  key={spd}
                  type="button"
                  data-testid={`speed-preset-${spd}`}
                  aria-pressed={isSelected}
                  onClick={() => onChangeSpeed(spd)}
                  className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                    isSelected
                      ? "bg-slate-900 text-white"
                      : "text-slate-600 hover:bg-white hover:text-slate-900"
                  }`}
                >
                  {formatSpeedLabel(spd)}
                </button>
              );
            })}

            <button
              type="button"
              data-testid="speed-step-up-btn"
              disabled={speedMultiplier >= MAX_SPEED_MULTIPLIER - 1e-4}
              onClick={() => onChangeSpeed(clampSpeedMultiplier(speedMultiplier + SPEED_STEP))}
              title="Increase speed by 0.05x"
              className="rounded px-1.5 py-0.5 text-xs font-semibold text-slate-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              +
            </button>
          </div>

          {editingBpm ? (
            <input
              type="number"
              data-testid="bpm-input"
              aria-label="Target BPM"
              autoFocus
              min={10}
              max={400}
              value={bpmDraft}
              onChange={(e) => setBpmDraft(e.target.value)}
              onBlur={commitBpm}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitBpm();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditingBpm(false);
                }
              }}
              className="w-20 rounded-md border border-blue-400 bg-white px-2 py-0.5 text-xs font-semibold text-slate-800 outline-none"
            />
          ) : (
            <button
              type="button"
              data-testid="bpm-readout-btn"
              onClick={beginEditBpm}
              title={`Click to enter target BPM (base ♩=${safeBaseBpm}, current ${formatSpeedLabel(speedMultiplier)})`}
              className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
            >
              ♩={effectiveBpm} ({formatSpeedLabel(speedMultiplier)})
            </button>
          )}

          <span
            data-testid="audio-engine-status"
            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusInfo.badgeClass}`}
          >
            {statusInfo.text}
          </span>

          <button
            type="button"
            data-testid="practice-settings-btn"
            onClick={() => setSettingsOpen(true)}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            Practice Settings
          </button>
        </div>
      </div>

      {settingsOpen && (
        <div
          data-testid="practice-settings-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Practice Settings"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <h2 className="text-sm font-semibold text-slate-900">Practice Settings</h2>
              <button
                type="button"
                data-testid="practice-settings-close-btn"
                onClick={() => setSettingsOpen(false)}
                className="rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
              >
                Close
              </button>
            </div>
            <div className="mt-3 space-y-2 text-xs text-slate-600">
              <p>
                Configure metronome, Web MIDI input device, local sound echo, and Waiting Mode
                options here.
              </p>
              <p className="text-[11px] text-slate-400">
                Current base tempo: ♩={safeBaseBpm} · Multiplier: {formatSpeedLabel(speedMultiplier)}
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
