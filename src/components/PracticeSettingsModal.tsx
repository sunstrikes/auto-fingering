import type { SpeedMultiplier } from "../audio/playbackEngine";
import type { MidiConnectionState } from "../midi/webMidi";

export interface PracticeSettingsModalProps {
  open: boolean;
  midiState: MidiConnectionState;
  midiLocalSound: boolean;
  speedMultiplier: SpeedMultiplier;
  baseBpm: number;
  countInEnabled: boolean;
  loopGapEnabled?: boolean;
  metronomeVolume: number;
  skipGraceNotes?: boolean;
  onSelectDevice: (deviceId: string | null) => void;
  onToggleLocalSound: (enabled: boolean) => void;
  onToggleCountIn: () => void;
  onToggleLoopGap?: () => void;
  onChangeMetronomeVolume: (volume: number) => void;
  onToggleSkipGraceNotes?: () => void;
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
  speedMultiplier,
  baseBpm,
  countInEnabled,
  loopGapEnabled = false,
  metronomeVolume,
  skipGraceNotes = false,
  onSelectDevice,
  onToggleLocalSound,
  onToggleCountIn,
  onToggleLoopGap,
  onChangeMetronomeVolume,
  onToggleSkipGraceNotes,
  onClose,
}: PracticeSettingsModalProps) {
  if (!open) return null;

  const statusLabel = formatMidiStatusLabel(midiState);
  const badgeClass = getMidiStatusBadgeClass(midiState);

  return (
    <div
      data-testid="practice-settings-modal"
      role="dialog"
      aria-modal="true"
      aria-label="练习设置"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 pb-2">
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
            className="rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
          >
            关闭
          </button>
        </div>

        <div className="mt-3 space-y-4 text-xs text-slate-700">
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
                  将外接硬件 MIDI 键盘的 NoteOn/NoteOff 事件路由到浏览器钢琴合成器。若使用自带扬声器的电钢琴练习，建议保持关闭。
                </p>
              </div>
            </label>
          </div>

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

          <p className="text-[11px] text-slate-400">
            当前基准速度: ♩={Math.round(baseBpm)} · 倍速:{" "}
            {Number(speedMultiplier.toFixed(2))}x
          </p>
        </div>
      </div>
    </div>
  );
}
