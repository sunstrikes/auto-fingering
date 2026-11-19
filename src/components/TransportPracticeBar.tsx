import { useState } from "react";
import type { MetronomeBeatEvent } from "../audio/metronome";
import {
  DEFAULT_PIANO_TIMBRE,
  getPianoTimbrePreset,
  type AudioEngineStatus,
  type PianoTimbreId,
} from "../audio/pianoAudio";
import {
  clampSpeedMultiplier,
  MAX_SPEED_MULTIPLIER,
  MIN_SPEED_MULTIPLIER,
  SPEED_PRESETS,
  type PlaybackState,
  type SpeedMultiplier,
} from "../audio/playbackEngine";
import {
  createDefaultAbLoopBounds,
  normalizeAbLoopBounds,
  type AbLoopBounds,
  type MeasureTimeline,
} from "../domain/types";

export interface TransportPracticeBarProps {
  hasScore: boolean;
  hasSelectedSlice: boolean;
  playbackState: PlaybackState;
  speedMultiplier: SpeedMultiplier;
  baseBpm: number;
  audioStatus: AudioEngineStatus;
  pianoTimbre?: PianoTimbreId;
  measureCount: number;
  measureTimelines: MeasureTimeline[];
  activeMeasureIndex: number | null;
  midiStatusLabel?: string;
  onOpenSettings?: () => void;
  metronomeEnabled?: boolean;
  metronomePaused?: boolean;
  activeMetronomeBeat?: MetronomeBeatEvent | null;
  waitingModeEnabled?: boolean;
  abLoop?: AbLoopBounds;
  onPlay: () => void;
  onPlayFromSlice: () => void;
  onPause: () => void;
  onStop: () => void;
  onJumpToStart: () => void;
  onJumpToMeasure: (measureIndex: number) => void;
  onChangeSpeed: (speed: SpeedMultiplier) => void;
  onToggleMetronome?: () => void;
  onToggleWaitingMode?: () => void;
  onToggleAbLoop?: () => void;
  onChangeAbLoopBounds?: (bounds: AbLoopBounds) => void;
  onClearAbLoop?: () => void;
}

const SPEED_STEP = 0.05;

const AUDIO_STATUS_LABELS: Record<AudioEngineStatus, { text: string; badgeClass: string }> = {
  idle: {
    text: "音频: 待机",
    badgeClass: "border-slate-200 bg-slate-50 text-slate-600",
  },
  loading: {
    text: "音频: 加载中...",
    badgeClass: "border-blue-200 bg-blue-50 text-blue-700",
  },
  samples: {
    text: "音频: 钢琴采样",
    badgeClass: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  synth: {
    text: "音频: 合成器回退",
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
  pianoTimbre = DEFAULT_PIANO_TIMBRE,
  measureCount,
  measureTimelines,
  activeMeasureIndex,
  midiStatusLabel,
  onOpenSettings,
  metronomeEnabled = false,
  metronomePaused = false,
  activeMetronomeBeat = null,
  waitingModeEnabled = false,
  abLoop,
  onPlay,
  onPlayFromSlice,
  onPause,
  onStop,
  onJumpToStart,
  onJumpToMeasure,
  onChangeSpeed,
  onToggleMetronome,
  onToggleWaitingMode,
  onToggleAbLoop,
  onChangeAbLoopBounds,
  onClearAbLoop,
}: TransportPracticeBarProps) {
  const [editingBpm, setEditingBpm] = useState(false);
  const [bpmDraft, setBpmDraft] = useState("");

  const safeBaseBpm = baseBpm > 0 ? baseBpm : 100;
  const effectiveBpm = Math.max(1, Math.round(safeBaseBpm * speedMultiplier));
  const timbrePreset = getPianoTimbrePreset(pianoTimbre);
  const statusInfo = AUDIO_STATUS_LABELS[audioStatus];
  const statusBadgeText =
    audioStatus === "samples" ? `音频: ${timbrePreset.shortLabel}` : statusInfo.text;
  const totalMeasureCount =
    measureTimelines.length > 0 ? measureTimelines.length : measureCount;
  const normalizedLoop = normalizeAbLoopBounds(
    abLoop ?? createDefaultAbLoopBounds(totalMeasureCount),
    totalMeasureCount
  );

  const rulerMeasures: Array<{ measureIndex: number; isPickup: boolean; label: string }> =
    measureTimelines.length > 0
      ? measureTimelines.map((m) => ({
          measureIndex: m.measureIndex,
          isPickup: m.isPickup,
          label: m.isPickup
            ? `第${m.measureIndex + 1}小节 (弱起, ${m.timeBeats}/${m.timeBeatType})`
            : `第${m.measureIndex + 1}小节 (${m.timeBeats}/${m.timeBeatType})`,
        }))
      : Array.from({ length: measureCount }, (_, i) => ({
          measureIndex: i,
          isPickup: false,
          label: `第${i + 1}小节`,
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
      aria-label="播放与练习控制栏"
      className="shrink-0 border-y border-slate-200 bg-white px-3 py-1 sm:px-4"
    >
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2">
        {/* Left: Transport Buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="transport-jump-start-btn"
            disabled={!hasScore}
            onClick={onJumpToStart}
            title="跳回乐谱开头"
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
          >
            ⏮ 开头
          </button>

          <button
            type="button"
            data-testid="audio-play-btn"
            disabled={!hasScore || playbackState === "playing"}
            onClick={onPlay}
            className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {playbackState === "paused" ? "继续" : "播放"}
          </button>

          <button
            type="button"
            data-testid="audio-play-slice-btn"
            disabled={!hasScore || !hasSelectedSlice}
            onClick={onPlayFromSlice}
            title="从当前选中的音符切片开始播放"
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
          >
            从当前
          </button>

          <button
            type="button"
            data-testid="audio-pause-btn"
            disabled={playbackState !== "playing"}
            onClick={onPause}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
          >
            暂停
          </button>

          <button
            type="button"
            data-testid="audio-stop-btn"
            disabled={playbackState === "stopped"}
            onClick={onStop}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
          >
            停止
          </button>
        </div>

        {/* Center: Interactive Measure Ruler */}
        <div
          data-testid="measure-ruler"
          aria-label="小节标尺"
          className="flex min-w-[160px] flex-1 items-center gap-1 overflow-x-auto rounded-md border border-slate-200 bg-slate-50 px-1.5 py-1"
        >
          {rulerMeasures.length === 0 ? (
            <span className="px-2 text-[11px] text-slate-400">加载乐谱后显示小节</span>
          ) : (
            rulerMeasures.map((m) => {
              const isActive = activeMeasureIndex === m.measureIndex;
              const inAbLoop =
                normalizedLoop.enabled &&
                m.measureIndex >= normalizedLoop.startMeasureIndex &&
                m.measureIndex <= normalizedLoop.endMeasureIndex;
              return (
                <button
                  key={m.measureIndex}
                  type="button"
                  data-testid={`measure-ruler-item-${m.measureIndex}`}
                  data-in-ab-loop={inAbLoop ? "true" : "false"}
                  title={`${m.label}${inAbLoop ? " (A-B 循环内)" : ""} · Shift+点击设为 A-B 循环终点`}
                  onClick={(e) => {
                    if (e.shiftKey && onChangeAbLoopBounds) {
                      onChangeAbLoopBounds(
                        normalizeAbLoopBounds(
                          {
                            ...normalizedLoop,
                            endMeasureIndex: m.measureIndex,
                            enabled: true,
                          },
                          totalMeasureCount
                        )
                      );
                      return;
                    }
                    onJumpToMeasure(m.measureIndex);
                  }}
                  className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium transition ${
                    isActive
                      ? "bg-blue-600 text-white shadow-sm"
                      : inAbLoop
                        ? "border border-indigo-400 bg-indigo-50 text-indigo-800 hover:bg-indigo-100"
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
              title="速度降低 0.05x"
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
              title="速度提高 0.05x"
              className="rounded px-1.5 py-0.5 text-xs font-semibold text-slate-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              +
            </button>
          </div>

          {editingBpm ? (
            <input
              type="number"
              data-testid="bpm-input"
              aria-label="目标速度 BPM"
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
              title={`点击输入目标 BPM（原速 ♩=${safeBaseBpm}，当前 ${formatSpeedLabel(speedMultiplier)}）`}
              className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
            >
              ♩={effectiveBpm} ({formatSpeedLabel(speedMultiplier)})
            </button>
          )}

          <span
            data-testid="audio-engine-status"
            title={`当前音色: ${timbrePreset.label}（可在练习设置中切换）`}
            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusInfo.badgeClass}`}
          >
            {statusBadgeText}
          </span>

          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="metronome-toggle-btn"
              aria-pressed={metronomeEnabled}
              onClick={onToggleMetronome}
              title="开关节拍器"
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                metronomeEnabled
                  ? "border-blue-600 bg-blue-600 text-white hover:bg-blue-700"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
              }`}
            >
              节拍器
            </button>

            <span
              data-testid="metronome-beat-indicator"
              data-metronome-paused={metronomeEnabled && metronomePaused ? "true" : "false"}
              aria-live="polite"
              className={`inline-flex min-w-[44px] items-center justify-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold transition ${
                metronomeEnabled && metronomePaused
                  ? "border-amber-300 bg-amber-50 text-amber-700"
                  : activeMetronomeBeat
                    ? activeMetronomeBeat.isAccent
                      ? "border-amber-500 bg-amber-100 text-amber-900"
                      : "border-blue-400 bg-blue-100 text-blue-900"
                    : "border-slate-200 bg-slate-50 text-slate-400"
              }`}
            >
              {metronomeEnabled && metronomePaused
                ? "暂停"
                : activeMetronomeBeat
                  ? `${activeMetronomeBeat.beatNumber}/${activeMetronomeBeat.totalBeats}`
                  : metronomeEnabled
                    ? "就绪"
                    : "关闭"}
            </span>

            {activeMetronomeBeat?.isCountIn && (
              <span
                data-testid="count-in-indicator"
                className="rounded-md border border-indigo-400 bg-indigo-600 px-2 py-0.5 text-[11px] font-bold text-white"
              >
                预备拍: {activeMetronomeBeat.countdownRemaining}
              </span>
            )}
          </div>

          <button
            type="button"
            data-testid="waiting-mode-toggle-btn"
            aria-pressed={waitingModeEnabled}
            onClick={onToggleWaitingMode}
            title="在每个练习步暂停，直到弹奏出匹配的音高"
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
              waitingModeEnabled
                ? "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
            }`}
          >
            等待模式
          </button>

          <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5">
            <button
              type="button"
              data-testid="ab-loop-toggle-btn"
              aria-pressed={normalizedLoop.enabled}
              disabled={!hasScore}
              onClick={onToggleAbLoop}
              title="开关整小节 A-B 循环"
              className={`rounded px-2 py-0.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${
                normalizedLoop.enabled
                  ? "bg-indigo-600 text-white hover:bg-indigo-700"
                  : "bg-white text-slate-700 hover:bg-slate-100"
              }`}
            >
              A-B 循环
            </button>

            <label className="flex items-center gap-0.5 text-[11px] text-slate-600">
              <span>A:</span>
              <select
                data-testid="ab-loop-start-select"
                aria-label="循环起点小节 A"
                disabled={!hasScore}
                value={normalizedLoop.startMeasureIndex}
                onChange={(e) => {
                  const nextA = Number.parseInt(e.target.value, 10);
                  onChangeAbLoopBounds?.(
                    normalizeAbLoopBounds(
                      { ...normalizedLoop, startMeasureIndex: nextA },
                      totalMeasureCount
                    )
                  );
                }}
                className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] text-slate-800 disabled:opacity-45"
              >
                {rulerMeasures.map((m) => (
                  <option key={m.measureIndex} value={m.measureIndex}>
                    第{m.measureIndex + 1}小节
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-0.5 text-[11px] text-slate-600">
              <span>B:</span>
              <select
                data-testid="ab-loop-end-select"
                aria-label="循环终点小节 B"
                disabled={!hasScore}
                value={normalizedLoop.endMeasureIndex}
                onChange={(e) => {
                  const nextB = Number.parseInt(e.target.value, 10);
                  onChangeAbLoopBounds?.(
                    normalizeAbLoopBounds(
                      { ...normalizedLoop, endMeasureIndex: nextB },
                      totalMeasureCount
                    )
                  );
                }}
                className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] text-slate-800 disabled:opacity-45"
              >
                {rulerMeasures.map((m) => (
                  <option key={m.measureIndex} value={m.measureIndex}>
                    第{m.measureIndex + 1}小节
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              data-testid="ab-loop-clear-btn"
              disabled={!hasScore}
              onClick={onClearAbLoop}
              title="清除并重置 A-B 循环"
              className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
            >
              清除
            </button>
          </div>

          <button
            type="button"
            data-testid="practice-settings-btn"
            onClick={() => onOpenSettings?.()}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            {midiStatusLabel ? `练习设置 · ${midiStatusLabel}` : "练习设置"}
          </button>
        </div>
      </div>
    </section>
  );
}
