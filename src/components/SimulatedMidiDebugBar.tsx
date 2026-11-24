import { useState } from "react";
import type { SimulatedMidiHarness, SimulatedPianoCommand } from "../midi/simulatedMidiHarness";

const COMMAND_KEYS: readonly [SimulatedPianoCommand, string][] = [
  ["a0", "A0"], ["b0", "B0"], ["c8", "C8"], ["pause", "A0+A#0"],
];

export function SimulatedMidiDebugBar({ harness, onPlay }: {
  harness: SimulatedMidiHarness;
  onPlay: () => void;
}) {
  const [pitch, setPitch] = useState("60");
  const midi = Number(pitch);
  const validPitch = pitch !== "" && Number.isInteger(midi) && midi >= 0 && midi <= 127;
  const buttonClass = "rounded border border-slate-400 px-1.5 py-0.5 hover:bg-slate-200 disabled:opacity-40";
  return (
    <div
      data-testid="sim-midi-bar"
      role="group"
      aria-label="Simulated MIDI developer controls"
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-slate-300 bg-slate-100 px-3 py-1 text-xs"
    >
      <strong>Sim MIDI</strong>
      <button type="button" className={buttonClass} data-testid="sim-midi-play" onClick={onPlay}>Play</button>
      <button type="button" className={buttonClass} data-testid="sim-midi-stop" onClick={() => harness.stop()}>Stop</button>
      <label>
        Pitch{" "}
        <input
          type="number"
          data-testid="sim-midi-pitch"
          className="w-14 rounded border border-slate-400 px-1"
          min={0}
          max={127}
          step={1}
          value={pitch}
          onChange={(event) => setPitch(event.currentTarget.value)}
        />
      </label>
      <button type="button" className={buttonClass} data-testid="sim-midi-strike" onClick={() => harness.strike(midi)} disabled={!validPitch}>
        Strike
      </button>
      {COMMAND_KEYS.map(([command, label]) => (
        <button
          key={command}
          type="button"
          className={buttonClass}
          data-testid={`sim-midi-command-${command}`}
          onClick={() => harness.sendCommand(command)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
