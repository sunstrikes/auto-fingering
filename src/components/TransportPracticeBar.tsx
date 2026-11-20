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
import {
  groupMeasuresIntoSystems,
  type MeasureGeometry,
  type MeasureRiskSummary,
  type RiskSeverity,
} from "./MarginRiskGutter";
import type { AbPickStep, ScoreLayoutMode } from "./ScoreViewer";

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
  measureRisks?: MeasureRiskSummary[];
  measureGeometry?: MeasureGeometry[];
  layoutMode?: ScoreLayoutMode;
  activeMeasureIndex: number | null;
  midiStatusLabel?: string;
  onOpenSettings?: () => void;
  metronomeEnabled?: boolean;
  metronomePaused?: boolean;
  activeMetronomeBeat?: MetronomeBeatEvent | null;
  waitingModeEnabled?: boolean;
  abLoop?: AbLoopBounds;
  abPickStep?: AbPickStep;
  abPickStartMeasure?: number | null;
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
  onPickAbMeasure?: (measureIndex: number) => void;
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
  measureRisks = [],
  measureGeometry = [],
  layoutMode = "page",
  activeMeasureIndex,
  midiStatusLabel,
  onOpenSettings,
  metronomeEnabled = false,
  metronomePaused = false,
  activeMetronomeBeat = null,
  waitingModeEnabled = false,
  abLoop,
  abPickStep = "idle",
  abPickStartMeasure = null,
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
  onPickAbMeasure,
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

  const riskByMeasure = new Map<number, MeasureRiskSummary>();
  for (const r of measureRisks) {
    riskByMeasure.set(r.measureIndex, r);
  }
  const rulerMeasureByIndex = new Map(rulerMeasures.map((m) => [m.measureIndex, m]));
  const systemGroups = groupMeasuresIntoSystems(totalMeasureCount, measureGeometry, {
    layoutMode,
    fallbackPerRow: 4,
  });

  const RISK_CELL_STYLE: Record<RiskSeverity, string> = {
    none: "bg-slate-100/80 hover:bg-slate-200/80 text-slate-600",
    warn: "bg-amber-200/80 hover:bg-amber-300/80 text-amber-950",
    danger: "bg-red-200/90 hover:bg-red-300/90 text-red-950",
  };

  const abButtonLabel =
    abPickStep === "start"
      ? "选择起点 A"
      : abPickStep === "end"
        ? `选择终点 B${abPickStartMeasure !== null ? ` (A:${abPickStartMeasure + 1})` : ""}`
        : normalizedLoop.enabled
          ? `循环中 ${normalizedLoop.startMeasureIndex + 1}-${normalizedLoop.endMeasureIndex + 1}`
          : "A-B 循环";

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
      className="shrink-0 border-y border-slate-200 bg-white px-3 py-1.5 sm:px-4"
    >
      <div className="mx-auto flex max-w-[1600px] flex-col gap-1.5">
        {/* Top Row: Full-Width System-Segmented Measure Ruler */}
        <div
          data-testid="measure-ruler"
          aria-label="谱行与小节进度条"
          className="flex w-full items-center gap-1.5 overflow-x-auto py-0.5"
        >
          {systemGroups.length === 0 ? (
            <div className="flex h-6 w-full items-center rounded-md border border-slate-200 bg-slate-50 px-2.5 text-[11px] text-slate-400">
              加载乐谱后显示谱行与小节进度
            </div>
          ) : (
            systemGroups.map((group) => {
              const containsActive =
                activeMeasureIndex !== null && group.measureIndices.includes(activeMeasureIndex);
              return (
                <div
                  key={`sys-pill-${group.systemIndex}`}
                  data-testid={`system-pill-${group.systemIndex}`}
                  style={{
                    flexGrow: group.measureIndices.length,
                    flexBasis: 0,
                    minWidth: `${Math.max(28, group.measureIndices.length * 12)}px`,
                  }}
                  className={`relative flex h-6 items-stretch overflow-hidden rounded-md border transition ${
                    containsActive
                      ? "border-blue-500 ring-1 ring-blue-300"
                      : "border-slate-200 bg-slate-100"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none flex shrink-0 items-center px-1 text-[10px] font-bold select-none ${
                      containsActive
                        ? "bg-blue-600 text-white"
                        : "bg-slate-200/90 text-slate-600"
                    }`}
                  >
                    {group.systemIndex + 1}
                  </span>

                  <div className="flex min-w-0 flex-1 items-stretch">
                    {group.measureIndices.map((mIdx, posIdx) => {
                      const meta = rulerMeasureByIndex.get(mIdx) ?? {
                        measureIndex: mIdx,
                        isPickup: false,
                        label: `第${mIdx + 1}小节`,
                      };
                      const risk = riskByMeasure.get(mIdx);
                      const severity: RiskSeverity = risk?.highestSeverity ?? "none";
                      const isActive = activeMeasureIndex === mIdx;
                      const inAbLoop =
                        normalizedLoop.enabled &&
                        mIdx >= normalizedLoop.startMeasureIndex &&
                        mIdx <= normalizedLoop.endMeasureIndex;
                      const isPickStart =
                        abPickStep !== "idle" && abPickStartMeasure === mIdx;
                      const isLastInPill = posIdx === group.measureIndices.length - 1;

                      const riskHint =
                        risk && risk.warningCount > 0
                          ? ` · ${risk.warningCount} 条提示`
                          : "";
                      const actionHint =
                        abPickStep === "start"
                          ? " · 点击设为 A-B 起点"
                          : abPickStep === "end"
                            ? " · 点击设为 A-B 终点"
                            : " · Shift+点击设为 A-B 循环终点";

                      return (
                        <button
                          key={mIdx}
                          type="button"
                          data-testid={`measure-ruler-item-${mIdx}`}
                          data-in-ab-loop={inAbLoop ? "true" : "false"}
                          data-severity={severity}
                          title={`${meta.label}${riskHint}${inAbLoop ? " (A-B 循环内)" : ""}${actionHint}`}
                          aria-label={`${meta.label}${inAbLoop ? " (A-B 循环内)" : ""}`}
                          onClick={(e) => {
                            if (abPickStep !== "idle" && onPickAbMeasure) {
                              onPickAbMeasure(mIdx);
                              return;
                            }
                            if (e.shiftKey && onChangeAbLoopBounds) {
                              onChangeAbLoopBounds(
                                normalizeAbLoopBounds(
                                  {
                                    ...normalizedLoop,
                                    endMeasureIndex: mIdx,
                                    enabled: true,
                                  },
                                  totalMeasureCount
                                )
                              );
                              return;
                            }
                            onJumpToMeasure(mIdx);
                          }}
                          className={`relative min-w-[6px] flex-1 transition focus:outline-none ${
                            !isLastInPill ? "border-r border-slate-300/70" : ""
                          } ${
                            isActive
                              ? "bg-blue-600 text-white"
                              : isPickStart
                                ? "bg-indigo-500 text-white"
                                : inAbLoop
                                  ? "bg-indigo-100/95 ring-1 ring-inset ring-indigo-500"
                                  : RISK_CELL_STYLE[severity]
                          }`}
                        >
                          {severity !== "none" && !isActive && (
                            <span
                              aria-hidden="true"
                              className={`absolute inset-x-0 bottom-0 h-0.5 ${
                                severity === "danger" ? "bg-red-600" : "bg-amber-500"
                              }`}
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Bottom Row: Transport, Speed, Metronome, Waiting Mode, Two-Step A-B Loop & Settings */}
        <div className="flex flex-wrap items-center justify-between gap-2">
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

          {/* Right: Speed Multiplier Presets + Steppers + BPM Editor + Audio Status + Practice Modes + A-B Loop */}
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
              data-pick-step={abPickStep}
              aria-pressed={normalizedLoop.enabled}
              disabled={!hasScore}
              onClick={onToggleAbLoop}
              title={
                abPickStep === "start"
                  ? "请点击谱面或顶部进度条选择循环起点小节（再次点击取消）"
                  : abPickStep === "end"
                    ? "请点击谱面或顶部进度条选择循环终点小节（再次点击取消）"
                    : normalizedLoop.enabled
                      ? "点击关闭 A-B 循环"
                      : "点击进入两步点选 A-B 循环小节"
              }
              className={`rounded px-2 py-0.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${
                abPickStep !== "idle"
                  ? "bg-amber-500 text-white hover:bg-amber-600"
                  : normalizedLoop.enabled
                    ? "bg-indigo-600 text-white hover:bg-indigo-700"
                    : "bg-white text-slate-700 hover:bg-slate-100"
              }`}
            >
              {abButtonLabel}
            </button>

            {(normalizedLoop.enabled || abPickStep !== "idle") && (
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
            )}
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
      </div>
    </section>
  );
}
