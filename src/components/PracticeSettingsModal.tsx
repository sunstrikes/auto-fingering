import { useEffect } from "react";
import {
  DEFAULT_PIANO_TIMBRE,
  PIANO_TIMBRE_PRESETS,
  type AudioEngineStatus,
  type PianoTimbreId,
} from "../audio/pianoAudio";
import type { SpeedMultiplier } from "../audio/playbackEngine";
import type { HandSpanProfile, PriorMode, SpanPreset } from "../domain/types";
import type { MidiConnectionState } from "../midi/webMidi";
import type { PriorLoadProgress } from "../prior/loader";

const SPAN_PRESETS: Array<{ preset: SpanPreset; title: string }> = [
  { preset: "S", title: "小手型（偏保守跨度，0.82×）" },
  { preset: "M", title: "标准手型（1.00×）" },
  { preset: "L", title: "大手型（上限纯八度，放宽八度内内指跨度，1.18×）" },
];

export interface PracticeSettingsModalProps {
  open: boolean;
  midiState: MidiConnectionState;
  midiLocalSound: boolean;
  audioStatus?: AudioEngineStatus;
  pianoTimbre?: PianoTimbreId;
  speedMultiplier: SpeedMultiplier;
  baseBpm: number;
  countInEnabled: boolean;
  loopGapEnabled?: boolean;
  metronomeVolume: number;
  skipGraceNotes?: boolean;
  absoluteStrictnessEnabled?: boolean;
  strictHoldDurationEnabled?: boolean;
  cc64CommandEnabled?: boolean;
  microRestDurationSec?: number;
  audiationPreviewMode?: "auto-unfamiliar" | "manual";
  audiationImageryTimerEnabled?: boolean;
  showStatusBar?: boolean;
  showPianoOverhead?: boolean;
  showFullPalm?: boolean;
  handSpanProfile?: HandSpanProfile;
  priorMode?: PriorMode;
  priorLambda?: number;
  priorLoading?: boolean;
  priorProgress?: PriorLoadProgress | null;
  priorFallbackReason?: string | null;
  customModelBaseUrl?: string;
  onSelectDevice: (deviceId: string | null) => void;
  onToggleLocalSound: (enabled: boolean) => void;
  onChangePianoTimbre?: (timbre: PianoTimbreId) => void;
  onPreviewTimbre?: () => void;
  onToggleCountIn: () => void;
  onToggleLoopGap?: () => void;
  onChangeMetronomeVolume: (volume: number) => void;
  onToggleSkipGraceNotes?: () => void;
  onToggleAbsoluteStrictness?: () => void;
  onToggleStrictHoldDuration?: () => void;
  onToggleCc64Command?: () => void;
  onChangeMicroRestDurationSec?: (sec: number) => void;
  onChangeAudiationPreviewMode?: (mode: "auto-unfamiliar" | "manual") => void;
  onToggleAudiationImageryTimer?: () => void;
  onToggleShowStatusBar?: () => void;
  onToggleShowPianoOverhead?: () => void;
  onToggleShowFullPalm?: () => void;
  onChangeHandSpanProfile?: (profile: HandSpanProfile) => void;
  onChangePriorMode?: (mode: PriorMode) => void;
  onChangePriorLambda?: (lambda: number) => void;
  onChangeCustomModelBaseUrl?: (url: string) => void;
  onClose: () => void;
}

export function formatMidiStatusLabel(midiState: MidiConnectionState): string {
  switch (midiState.status) {
    case "connected":
      return `MIDI: 已连接 ${midiState.devices.length} 台`;
    case "no-devices":
      return "MIDI: 未检测到设备";
    case "requesting":
      return "MIDI: 连接中...";
    case "denied":
      return "MIDI: 权限被拒绝";
    case "error":
      return "MIDI: 错误";
    case "unsupported":
    default:
      return "MIDI: 不支持";
  }
}

export function getMidiStatusBadgeClass(midiState: MidiConnectionState): string {
  switch (midiState.status) {
    case "connected":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "no-devices":
    case "requesting":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "denied":
    case "error":
      return "border-red-200 bg-red-50 text-red-700";
    case "unsupported":
    default:
      return "border-slate-200 bg-slate-100 text-slate-600";
  }
}

export function PracticeSettingsModal({
  open,
  midiState,
  midiLocalSound,
  audioStatus = "idle",
  pianoTimbre = DEFAULT_PIANO_TIMBRE,
  speedMultiplier,
  baseBpm,
  countInEnabled,
  loopGapEnabled = false,
  metronomeVolume,
  skipGraceNotes = false,
  absoluteStrictnessEnabled = false,
  strictHoldDurationEnabled = false,
  cc64CommandEnabled = false,
  microRestDurationSec = 12,
  audiationPreviewMode = "auto-unfamiliar",
  audiationImageryTimerEnabled = false,
  showStatusBar = true,
  showPianoOverhead = true,
  showFullPalm = true,
  handSpanProfile,
  priorMode = "model-assist",
  priorLambda = 0.85,
  priorLoading = false,
  priorProgress = null,
  priorFallbackReason = null,
  customModelBaseUrl = "",
  onSelectDevice,
  onToggleLocalSound,
  onChangePianoTimbre,
  onPreviewTimbre,
  onToggleCountIn,
  onToggleLoopGap,
  onChangeMetronomeVolume,
  onToggleSkipGraceNotes,
  onToggleAbsoluteStrictness,
  onToggleStrictHoldDuration,
  onToggleCc64Command,
  onChangeMicroRestDurationSec,
  onChangeAudiationPreviewMode,
  onToggleAudiationImageryTimer,
  onToggleShowStatusBar,
  onToggleShowPianoOverhead,
  onToggleShowFullPalm,
  onChangeHandSpanProfile,
  onChangePriorMode,
  onChangePriorLambda,
  onChangeCustomModelBaseUrl,
  onClose,
}: PracticeSettingsModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const statusLabel = formatMidiStatusLabel(midiState);
  const badgeClass = getMidiStatusBadgeClass(midiState);

  return (
    <div
      data-testid="practice-settings-modal"
      role="dialog"
      aria-modal="true"
      aria-label="练习设置"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <div className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-900">练习设置</h2>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${badgeClass}`}>
              {statusLabel}
            </span>
          </div>
          <button
            type="button"
            data-testid="practice-settings-close-btn"
            onClick={onClose}
            className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
          >
            关闭
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3 text-xs text-slate-700">
          {/* Web MIDI Device Selector */}
          <div className="space-y-1.5">
            <label htmlFor="midi-device-select" className="block font-semibold text-slate-800">
              MIDI 输入设备
            </label>
            <select
              id="midi-device-select"
              data-testid="midi-device-select"
              aria-label="MIDI 输入设备"
              value={midiState.selectedDeviceId ?? "all"}
              disabled={midiState.status === "unsupported" || midiState.status === "denied"}
              onChange={(e) => onSelectDevice(e.target.value === "all" ? null : e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
            >
              <option value="all">
                全部已连接设备（合并）
                {midiState.devices.length > 0 ? ` — ${midiState.devices.length} 台在线` : ""}
              </option>
              {midiState.devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                  {device.manufacturer ? ` (${device.manufacturer})` : ""}
                </option>
              ))}
            </select>
          </div>

          {/* MIDI Local Sound Toggle */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                data-testid="midi-local-sound-toggle"
                checked={midiLocalSound}
                onChange={(e) => onToggleLocalSound(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-slate-900"
              />
              <div>
                <div className="font-semibold text-slate-800">MIDI 本地发声</div>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  将外接硬件 MIDI 键盘的 NoteOn/NoteOff 事件路由到浏览器电钢/钢琴音源。若使用自带扬声器的电钢琴练习，建议保持关闭。
                </p>
              </div>
            </label>
          </div>

          {/* Piano / Electric Piano Timbre Selector */}
          {onChangePianoTimbre && (
            <div className="space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="piano-timbre-select" className="font-semibold text-slate-800">
                  播放与本地 MIDI 音色
                </label>
                <span
                  data-testid="settings-audio-status"
                  className="text-[11px] font-medium text-slate-500"
                >
                  {audioStatus === "loading"
                    ? "采样加载中..."
                    : audioStatus === "samples"
                      ? "采样已就绪"
                      : audioStatus === "synth"
                        ? "已回退合成器（可切换重试）"
                        : "首次播放时懒加载"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <select
                  id="piano-timbre-select"
                  data-testid="piano-timbre-select"
                  aria-label="播放与本地 MIDI 音色"
                  value={pianoTimbre}
                  onChange={(e) => onChangePianoTimbre(e.target.value as PianoTimbreId)}
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
                >
                  {PIANO_TIMBRE_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
                {onPreviewTimbre && (
                  <button
                    type="button"
                    data-testid="piano-timbre-preview-btn"
                    onClick={onPreviewTimbre}
                    className="shrink-0 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                  >
                    试听
                  </button>
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                默认使用在线原声三角钢琴 (Splendid Grand) 采样，首次加载后会在浏览器本地缓存；切换电钢或其它音色后可点击「试听」即时加载。
              </p>
            </div>
          )}

          {/* Unsupported / Denied / USB Connection Guide */}
          <div
            data-testid="midi-usb-guide"
            className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-600"
          >
            {midiState.status === "unsupported" && (
              <p className="mb-2 font-medium text-amber-800">
                Web MIDI API 在当前浏览器或非 HTTPS 环境下不可用（例如 Safari）。您仍可通过点击屏幕上的 88 键钢琴或使用电脑键盘（Z–M 与 Q–I）进行练习。
              </p>
            )}
            {midiState.status === "denied" && (
              <p className="mb-2 font-medium text-red-700">
                MIDI 权限被拒绝。请在浏览器站点设置中允许访问 MIDI 设备后刷新页面，或使用屏幕琴键 / 电脑键盘快捷键。
              </p>
            )}
            {midiState.status === "error" && midiState.errorMessage && (
              <p className="mb-2 font-medium text-red-700">{midiState.errorMessage}</p>
            )}
            <div className="font-semibold text-slate-800">USB 与虚拟输入连接指南</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                通过 USB-B/USB-C 数据线（或系统蓝牙 MIDI）连接电钢琴并开机，设备将自动热插拔识别。
              </li>
              <li>请在 HTTPS（或 localhost）环境下使用 Chrome、Edge 或 Opera 以获得 Web MIDI 支持。</li>
              <li>
                软件回退方案：点击屏幕上的 88 键琴键，或按电脑键盘{" "}
                <span className="font-mono">Z–M</span> / <span className="font-mono">Q–I</span> 键。
              </li>
            </ul>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <div>
              <div className="font-medium text-slate-900">一小节预备拍</div>
              <div className="text-[11px] text-slate-500">
                在乐谱开始播放前先播放一整小节节拍器提示音
              </div>
            </div>
            <input
              type="checkbox"
              data-testid="count-in-toggle"
              aria-label="一小节预备拍"
              checked={countInEnabled}
              onChange={onToggleCountIn}
              className="h-4 w-4 accent-blue-600"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <div>
              <div className="font-medium text-slate-900">循环间隔（一小节预备拍）</div>
              <div className="text-[11px] text-slate-500">
                每次 A-B 循环回到起点前，按 A 小节拍号插入一整小节预备拍
              </div>
            </div>
            <input
              type="checkbox"
              data-testid="loop-gap-toggle"
              aria-label="循环间隔（一小节预备拍）"
              checked={loopGapEnabled}
              onChange={() => onToggleLoopGap?.()}
              className="h-4 w-4 accent-blue-600"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <div>
              <div className="font-medium text-slate-900">等待模式自动跳过装饰音</div>
              <div className="text-[11px] text-slate-500">
                自动跳过倚音/装饰音，仅在主拍音符处等待弹奏
              </div>
            </div>
            <input
              type="checkbox"
              data-testid="skip-grace-notes-toggle"
              aria-label="等待模式自动跳过装饰音"
              checked={skipGraceNotes}
              onChange={() => onToggleSkipGraceNotes?.()}
              className="h-4 w-4 accent-blue-600"
            />
          </div>

          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <div>
              <div className="font-medium text-slate-900">等待模式绝对严格重置</div>
              <div className="text-[11px] text-slate-500">
                默认保留已弹对的音。开启后，弹错音会清空当前和弦的命中，需松开所有键重弹。
              </div>
            </div>
            <input
              type="checkbox"
              data-testid="absolute-strictness-toggle"
              aria-label="等待模式绝对严格重置"
              checked={absoluteStrictnessEnabled}
              onChange={() => onToggleAbsoluteStrictness?.()}
              className="h-4 w-4 accent-blue-600"
            />
          </label>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <div>
              <div className="font-medium text-slate-900">等待模式严格时值保持验证</div>
              <div className="text-[11px] text-slate-500">
                按下正确琴键后需按住达到音符理论时值的 80% 才推进下一步；提前松手需松开所有键重弹。
              </div>
            </div>
            <input
              type="checkbox"
              data-testid="strict-hold-duration-toggle"
              aria-label="等待模式严格时值保持验证"
              checked={strictHoldDurationEnabled}
              onChange={() => onToggleStrictHoldDuration?.()}
              className="h-4 w-4 accent-blue-600"
            />
          </div>

          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <div>
              <div className="font-medium text-slate-900">Guided Session 允许 CC64 延音踏板触发继续</div>
              <div className="text-[11px] text-slate-500">
                默认关闭（防乐句延音误触）。开启后在非演奏空窗踩下 CC64 踏板可等价 C8 继续/下一块。
              </div>
            </div>
            <input
              type="checkbox"
              data-testid="cc64-command-toggle"
              aria-label="Guided Session 允许 CC64 延音踏板触发继续"
              checked={cc64CommandEnabled}
              onChange={() => onToggleCc64Command?.()}
              className="h-4 w-4 accent-teal-600"
            />
          </label>

          {/* Guided Session Transition Gap (Micro-Rest + Audiation Priming) */}
          <div className="space-y-2.5 rounded-lg border border-teal-200/80 bg-teal-50/40 p-2.5">
            <div className="font-semibold text-teal-950">科学练琴过渡间隙（Micro-Rest &amp; Audiation）</div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <label htmlFor="micro-rest-duration-slider" className="font-medium text-slate-900">
                  清醒微休息（Micro-Rest）时长
                </label>
                <span
                  data-testid="micro-rest-duration-value"
                  className="text-[11px] font-semibold text-teal-800"
                >
                  {microRestDurationSec} s
                </span>
              </div>
              <input
                id="micro-rest-duration-slider"
                data-testid="micro-rest-duration-slider"
                type="range"
                min={10}
                max={15}
                step={1}
                value={microRestDurationSec}
                onChange={(e) => onChangeMicroRestDurationSec?.(Number.parseInt(e.target.value, 10))}
                className="w-full accent-teal-600"
              />
              <div className="mt-0.5 text-[11px] text-slate-500">
                默认 12 s（可调 10–15 s），休息期间严格零数据，按 C8 可随时跳过。
              </div>
            </div>

            <div className="space-y-1 border-t border-teal-200/60 pt-2">
              <label htmlFor="audiation-preview-mode-select" className="block font-medium text-slate-900">
                Audiation Priming 音频范奏触发
              </label>
              <select
                id="audiation-preview-mode-select"
                data-testid="audiation-preview-mode-select"
                aria-label="Audiation Priming 音频范奏触发"
                value={audiationPreviewMode}
                onChange={(e) =>
                  onChangeAudiationPreviewMode?.(e.target.value as "auto-unfamiliar" | "manual")
                }
                className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
              >
                <option value="auto-unfamiliar">生疏块（&lt; 2 遍）自动轻声范奏（击键即停）</option>
                <option value="manual">仅手动点击试听</option>
              </select>
            </div>

            <label className="flex cursor-pointer items-center justify-between gap-3 border-t border-teal-200/60 pt-2">
              <div>
                <div className="font-medium text-slate-900">开启 10 s 进阶意象引导计时（非阻塞）</div>
                <div className="text-[11px] text-slate-500">
                  默认关闭。开启后在就绪窗显示 10 s 默听与手位意象计时参考，随时可按 C8 或首音打断开始。
                </div>
              </div>
              <input
                type="checkbox"
                data-testid="audiation-imagery-timer-toggle"
                aria-label="开启 10 s 进阶意象引导计时"
                checked={audiationImageryTimerEnabled}
                onChange={() => onToggleAudiationImageryTimer?.()}
                className="h-4 w-4 shrink-0 accent-teal-600"
              />
            </label>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor="metronome-volume-slider" className="font-medium text-slate-900">
                节拍器音量
              </label>
              <span className="text-[11px] font-semibold text-slate-600">
                {Math.round(metronomeVolume * 100)}%
              </span>
            </div>
            <input
              id="metronome-volume-slider"
              data-testid="metronome-volume-slider"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={metronomeVolume}
              onChange={(e) => onChangeMetronomeVolume(Number.parseFloat(e.target.value))}
              className="w-full accent-blue-600"
            />
          </div>

          {handSpanProfile && onChangeHandSpanProfile && (
            <div className="space-y-2.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="font-semibold text-slate-800">手型大小与指法求解偏好</div>
                  <div className="text-[11px] text-slate-500">
                    调整手掌跨度预设（S/M/L）与自动指法倾向
                  </div>
                </div>
                <div
                  className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-medium"
                  role="group"
                  aria-label="手型跨度预设"
                >
                  {SPAN_PRESETS.map(({ preset, title }) => (
                    <button
                      key={preset}
                      type="button"
                      title={title}
                      aria-pressed={handSpanProfile.preset === preset}
                      onClick={() =>
                        onChangeHandSpanProfile({ ...handSpanProfile, preset })
                      }
                      className={`rounded-md px-2.5 py-1 transition ${
                        handSpanProfile.preset === preset
                          ? "bg-slate-900 text-white shadow-xs"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex cursor-pointer items-center justify-between gap-3 border-t border-slate-200/70 pt-2">
                <span className="font-medium text-slate-900">尽量避免大拇指弹黑键</span>
                <input
                  type="checkbox"
                  data-testid="avoid-thumb-black-toggle"
                  checked={handSpanProfile.avoidThumbOnBlack}
                  onChange={(e) =>
                    onChangeHandSpanProfile({
                      ...handSpanProfile,
                      avoidThumbOnBlack: e.target.checked,
                    })
                  }
                  className="h-4 w-4 shrink-0 accent-blue-600"
                />
              </label>

              <label className="flex cursor-pointer items-center justify-between gap-3 border-t border-slate-200/70 pt-2">
                <span className="font-medium text-slate-900">优先保持手位稳定</span>
                <input
                  type="checkbox"
                  data-testid="prefer-stable-position-toggle"
                  checked={handSpanProfile.preferStablePosition}
                  onChange={(e) =>
                    onChangeHandSpanProfile({
                      ...handSpanProfile,
                      preferStablePosition: e.target.checked,
                    })
                  }
                  className="h-4 w-4 shrink-0 accent-blue-600"
                />
              </label>

              {onChangePriorMode && (
                <div className="space-y-2 border-t border-slate-200/70 pt-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="font-semibold text-slate-800">指法风格</div>
                      <div className="text-[11px] text-slate-500">
                        模型辅助仅在物理合规候选间作软先验重排，P0 物理跨度与锚点保持一票否决
                      </div>
                    </div>
                    <div
                      data-testid="prior-mode-selector"
                      className="inline-flex shrink-0 rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-medium"
                      role="group"
                      aria-label="指法风格"
                    >
                      <button
                        type="button"
                        data-testid="prior-mode-classic-btn"
                        aria-pressed={priorMode === "classic"}
                        onClick={() => onChangePriorMode("classic")}
                        className={`rounded-md px-2.5 py-1 transition ${
                          priorMode === "classic"
                            ? "bg-slate-900 text-white shadow-xs"
                            : "text-slate-600 hover:text-slate-900"
                        }`}
                      >
                        经典
                      </button>
                      <button
                        type="button"
                        data-testid="prior-mode-assist-btn"
                        aria-pressed={priorMode === "model-assist"}
                        onClick={() => onChangePriorMode("model-assist")}
                        className={`rounded-md px-2.5 py-1 transition ${
                          priorMode === "model-assist"
                            ? "bg-slate-900 text-white shadow-xs"
                            : "text-slate-600 hover:text-slate-900"
                        }`}
                      >
                        模型辅助(Beta)
                      </button>
                    </div>
                  </div>

                  {priorMode === "model-assist" && (
                    <div
                      data-testid="prior-assist-controls"
                      className="space-y-2 rounded-lg border border-slate-200 bg-white p-2.5"
                    >
                      <div className="flex items-center justify-between">
                        <label htmlFor="prior-lambda-slider" className="font-medium text-slate-900">
                          模型先验强度 (λ)
                        </label>
                        <span
                          data-testid="prior-lambda-label"
                          className="text-[11px] font-semibold text-slate-700"
                        >
                          {priorLambda <= 0.5
                            ? "轻度辅助"
                            : priorLambda <= 1.1
                              ? "辅助(默认)"
                              : "模型主导"}{" "}
                          · λ={priorLambda.toFixed(2)}
                        </span>
                      </div>
                      <input
                        id="prior-lambda-slider"
                        data-testid="prior-lambda-slider"
                        type="range"
                        min={0.1}
                        max={2.0}
                        step={0.05}
                        value={priorLambda}
                        onChange={(e) =>
                          onChangePriorLambda?.(Number.parseFloat(e.target.value))
                        }
                        className="w-full accent-blue-600"
                      />

                      {(priorLoading || priorProgress) && (
                        <div
                          data-testid="prior-download-progress"
                          className="text-[11px] text-slate-600"
                        >
                          {priorLoading
                            ? `正在加载预训练指法先验权重 (~0.8 MB)... ${
                                priorProgress && priorProgress.totalBytes > 0
                                  ? `${Math.round(
                                      (priorProgress.loadedBytes / priorProgress.totalBytes) * 100
                                    )}% (${Math.round(priorProgress.loadedBytes / 1024)} / ${Math.round(
                                      priorProgress.totalBytes / 1024
                                    )} KB)`
                                  : ""
                              }`
                            : priorProgress
                              ? `预训练指法先验已就绪 (${Math.round(
                                  priorProgress.totalBytes / 1024
                                )} KB)`
                              : null}
                        </div>
                      )}

                      {priorFallbackReason && (
                        <div
                          data-testid="prior-fallback-alert"
                          className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800"
                        >
                          模型先验加载失败，已静默回退至经典启发式求解：{priorFallbackReason}
                        </div>
                      )}

                      {onChangeCustomModelBaseUrl && (
                        <div className="pt-1">
                          <label
                            htmlFor="prior-custom-url-input"
                            className="block text-[11px] font-medium text-slate-600"
                          >
                            自定义模型权重地址（可选，留空使用内置权重）
                          </label>
                          <input
                            id="prior-custom-url-input"
                            data-testid="prior-custom-url-input"
                            type="text"
                            placeholder="/models"
                            value={customModelBaseUrl}
                            onChange={(e) => onChangeCustomModelBaseUrl(e.target.value)}
                            className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <div className="font-semibold text-slate-800">界面显示与布局</div>
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <div>
                <div className="font-medium text-slate-900">显示顶部状态与风险栏</div>
                <div className="text-[11px] text-slate-500">
                  显示或隐藏乐谱上方的指法统计、高风险/警告计数及本地运算提示栏
                </div>
              </div>
              <input
                type="checkbox"
                data-testid="show-status-bar-toggle"
                aria-label="显示顶部状态与风险栏"
                checked={showStatusBar}
                onChange={() => onToggleShowStatusBar?.()}
                className="h-4 w-4 shrink-0 accent-blue-600"
              />
            </label>
            <label className="flex cursor-pointer items-center justify-between gap-3 border-t border-slate-200/70 pt-2">
              <div>
                <div className="font-medium text-slate-900">显示键盘上方手位与换指提示</div>
                <div className="text-[11px] text-slate-500">
                  显示或隐藏 88 键琴键上方的手位区间（RH/LH）与换指提示条（Position shift）
                </div>
              </div>
              <input
                type="checkbox"
                data-testid="show-piano-overhead-toggle"
                aria-label="显示键盘上方手位与换指提示"
                checked={showPianoOverhead}
                onChange={() => onToggleShowPianoOverhead?.()}
                className="h-4 w-4 shrink-0 accent-blue-600"
              />
            </label>
            <label className="flex cursor-pointer items-center justify-between gap-3 border-t border-slate-200/70 pt-2">
              <div>
                <div className="font-medium text-slate-900">显示键盘下方完整手掌</div>
                <div className="text-[11px] text-slate-500">
                  开启后显示琴键下方的完整手掌与手腕；关闭时键盘下沿对齐屏幕底端，为乐谱留出更多空间
                </div>
              </div>
              <input
                type="checkbox"
                data-testid="show-full-palm-toggle"
                aria-label="显示键盘下方完整手掌"
                checked={showFullPalm}
                onChange={() => onToggleShowFullPalm?.()}
                className="h-4 w-4 shrink-0 accent-blue-600"
              />
            </label>
          </div>

          <p className="text-[11px] text-slate-400">
            当前基准速度: ♩={Math.round(baseBpm)} · 倍速:{" "}
            {Number(speedMultiplier.toFixed(2))}x
          </p>
        </div>
      </div>
    </div>
  );
}
