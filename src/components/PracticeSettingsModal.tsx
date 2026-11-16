import type { SpeedMultiplier } from "../audio/playbackEngine";
import type { MidiConnectionState } from "../midi/webMidi";

export interface PracticeSettingsModalProps {
  open: boolean;
  midiState: MidiConnectionState;
  midiLocalSound: boolean;
  speedMultiplier: SpeedMultiplier;
  baseBpm: number;
  countInEnabled: boolean;
  metronomeVolume: number;
  onSelectDevice: (deviceId: string | null) => void;
  onToggleLocalSound: (enabled: boolean) => void;
  onToggleCountIn: () => void;
  onChangeMetronomeVolume: (volume: number) => void;
  onClose: () => void;
}

export function formatMidiStatusLabel(midiState: MidiConnectionState): string {
  switch (midiState.status) {
    case "connected":
      return `MIDI: ${midiState.devices.length} connected`;
    case "no-devices":
      return "MIDI: No device";
    case "requesting":
      return "MIDI: Connecting...";
    case "denied":
      return "MIDI: Denied";
    case "error":
      return "MIDI: Error";
    case "unsupported":
    default:
      return "MIDI: Unsupported";
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
  metronomeVolume,
  onSelectDevice,
  onToggleLocalSound,
  onToggleCountIn,
  onChangeMetronomeVolume,
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
      aria-label="Practice Settings"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 pb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-900">Practice Settings</h2>
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
            Close
          </button>
        </div>

        <div className="mt-3 space-y-4 text-xs text-slate-700">
          {/* Web MIDI Device Selector */}
          <div className="space-y-1.5">
            <label htmlFor="midi-device-select" className="block font-semibold text-slate-800">
              MIDI Input Device
            </label>
            <select
              id="midi-device-select"
              data-testid="midi-device-select"
              aria-label="MIDI Input Device"
              value={midiState.selectedDeviceId ?? "all"}
              disabled={midiState.status === "unsupported" || midiState.status === "denied"}
              onChange={(e) => onSelectDevice(e.target.value === "all" ? null : e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
            >
              <option value="all">
                All Connected Devices (Merged)
                {midiState.devices.length > 0 ? ` — ${midiState.devices.length} active` : ""}
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
                <div className="font-semibold text-slate-800">MIDI Local Sound</div>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  Route incoming hardware MIDI NoteOn/NoteOff events to the browser piano
                  synthesizer. Keep off when practicing on a digital piano with built-in speakers.
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
                Web MIDI API is unavailable in this browser or non-HTTPS context (e.g. Safari).
                You can still practice using on-screen 88-key clicks or your computer keyboard
                (Z–M and Q–I).
              </p>
            )}
            {midiState.status === "denied" && (
              <p className="mb-2 font-medium text-red-700">
                MIDI permission was denied. Allow MIDI device access in your browser site settings
                and reload, or use on-screen keys / QWERTY shortcuts.
              </p>
            )}
            {midiState.status === "error" && midiState.errorMessage && (
              <p className="mb-2 font-medium text-red-700">{midiState.errorMessage}</p>
            )}
            <div className="font-semibold text-slate-800">USB &amp; Virtual Input Guide</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                Connect your digital piano via USB-B/USB-C cable (or OS Bluetooth MIDI) and power it
                on — devices appear automatically via hot-plug.
              </li>
              <li>Use Chrome, Edge, or Opera over HTTPS (or localhost) for Web MIDI support.</li>
              <li>
                Software fallback: click any key on the 88-key keyboard or press QWERTY keys{" "}
                <span className="font-mono">Z–M</span> / <span className="font-mono">Q–I</span>.
              </li>
            </ul>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <div>
              <div className="font-medium text-slate-900">One-Measure Count-In</div>
              <div className="text-[11px] text-slate-500">
                Play one full measure of clicks before score playback begins
              </div>
            </div>
            <input
              type="checkbox"
              data-testid="count-in-toggle"
              aria-label="One-Measure Count-In"
              checked={countInEnabled}
              onChange={onToggleCountIn}
              className="h-4 w-4 accent-blue-600"
            />
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor="metronome-volume-slider" className="font-medium text-slate-900">
                Metronome Volume
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
            Current base tempo: ♩={Math.round(baseBpm)} · Multiplier:{" "}
            {Number(speedMultiplier.toFixed(2))}x
          </p>
        </div>
      </div>
    </div>
  );
}
