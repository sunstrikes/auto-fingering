import type {
  EhsActiveLookaheadPreset,
  EhsGhostOpacity,
  EhsProgressionPrompt,
} from "../guided/ehsController";
import type { ScaffoldingLevel } from "../guided/fadingScaffolding";
import type { GuidedSessionPhase } from "../guided/pianoCommandKeys";

export interface EhsControlStripProps {
  scaffoldingLevel: ScaffoldingLevel;
  sessionPhase: GuidedSessionPhase;
  ehsEnabled: boolean;
  ehsLookaheadPreset: EhsActiveLookaheadPreset;
  ehsGhostOpacity: EhsGhostOpacity;
  progressionPrompt: EhsProgressionPrompt | null;
  onToggleEhs: (enabled: boolean) => void;
  onChangePreset: (preset: EhsActiveLookaheadPreset) => void;
  onChangeGhostOpacity: (opacity: EhsGhostOpacity) => void;
  onAcceptProgression: () => void;
  onDismissProgression: () => void;
}

const PRESETS: readonly { id: EhsActiveLookaheadPreset; label: string }[] = [
  { id: "1-beat", label: "1拍" },
  { id: "2-beats", label: "2拍" },
  { id: "1-bar", label: "1小节" },
];

/**
 * Slim Guided Session EHS Overlay strip: strictly hidden/unavailable in L0 Stage 0,
 * exposing L1+ opt-in toggle, fixed lookahead preset selector, ghost ink toggle, and
 * bout-to-bout progression banner.
 */
export function EhsControlStrip({
  scaffoldingLevel,
  sessionPhase,
  ehsEnabled,
  ehsLookaheadPreset,
  ehsGhostOpacity,
  progressionPrompt,
  onToggleEhs,
  onChangePreset,
  onChangeGhostOpacity,
  onAcceptProgression,
  onDismissProgression,
}: EhsControlStripProps) {
  if (scaffoldingLevel < 1) {
    return null;
  }

  const showProgression = progressionPrompt !== null && sessionPhase !== "playing";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <label className="inline-flex cursor-pointer items-center gap-1 rounded border border-teal-200 bg-teal-50/70 px-2 py-0.5 text-[11px] font-medium text-teal-900">
        <input
          type="checkbox"
          data-testid="guided-ehs-toggle"
          checked={ehsEnabled}
          onChange={(e) => onToggleEhs(e.target.checked)}
          className="h-3 w-3 accent-teal-600"
        />
        <span>EHS 前瞻遮罩</span>
      </label>

      {ehsEnabled && (
        <>
          <div
            data-testid="guided-ehs-preset-group"
            role="group"
            aria-label="EHS 固定前瞻跨度"
            className="inline-flex rounded border border-slate-200 bg-slate-50 p-0.5 text-[11px]"
          >
            {PRESETS.map((p) => {
              const active = ehsLookaheadPreset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`guided-ehs-preset-${p.id}`}
                  aria-pressed={active}
                  disabled={sessionPhase === "playing"}
                  onClick={() => onChangePreset(p.id)}
                  className={`rounded px-1.5 py-0.5 font-medium transition ${
                    active
                      ? "bg-teal-600 text-white"
                      : "text-slate-600 hover:text-slate-900"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            data-testid="guided-ehs-ghost-toggle"
            onClick={() => onChangeGhostOpacity(ehsGhostOpacity === 0 ? 0.06 : 0)}
            className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
          >
            残影 {ehsGhostOpacity === 0 ? "0%" : "6%"}
          </button>
        </>
      )}

      {showProgression && progressionPrompt && (
        <div
          data-testid="guided-ehs-progression-banner"
          className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-900"
        >
          <span>{progressionPrompt.message}</span>
          <button
            type="button"
            data-testid="guided-ehs-progression-accept-btn"
            onClick={onAcceptProgression}
            className="rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-emerald-700"
          >
            升档
          </button>
          <button
            type="button"
            data-testid="guided-ehs-progression-dismiss-btn"
            onClick={onDismissProgression}
            className="rounded border border-emerald-300 bg-white px-1.5 py-0.5 text-[11px] text-emerald-800 hover:bg-emerald-100"
          >
            暂不
          </button>
        </div>
      )}
    </div>
  );
}
