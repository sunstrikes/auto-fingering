export interface MicroRestVeilProps {
  remainingSec: number;
  progress: number;
  reminderMessage: string | null;
  reminderPulseToken: number;
  onSkip: () => void;
}

const RING_RADIUS = 34;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Low-saturation translucent Micro-Rest veil covering the score area with ONLY
 * a breathing countdown ring/text, accidental-keystroke gentle pulse reminder,
 * and >= 44px soft skip button. Strictly zero metrics, scores, charts, or coach text.
 */
export function MicroRestVeil({
  remainingSec,
  progress,
  reminderMessage,
  reminderPulseToken,
  onSkip,
}: MicroRestVeilProps) {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const strokeDashoffset = RING_CIRCUMFERENCE * clampedProgress;

  return (
    <div
      data-testid="guided-micro-rest-veil"
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 rounded-xl bg-slate-900/55 p-6 text-center text-white backdrop-blur-xs"
    >
      <div className="relative flex h-24 w-24 items-center justify-center">
        <svg
          width="88"
          height="88"
          viewBox="0 0 88 88"
          aria-hidden="true"
          className="-rotate-90 animate-pulse"
        >
          <circle
            cx="44"
            cy="44"
            r={RING_RADIUS}
            fill="none"
            stroke="rgba(255,255,255,0.22)"
            strokeWidth="5"
          />
          <circle
            cx="44"
            cy="44"
            r={RING_RADIUS}
            fill="none"
            stroke="rgba(153,246,228,0.9)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={strokeDashoffset}
          />
        </svg>
        <span
          data-testid="guided-micro-rest-countdown"
          className="absolute text-lg font-semibold tabular-nums tracking-tight text-white"
        >
          {Math.max(0, remainingSec)} s
        </span>
      </div>

      <div className="text-sm font-medium tracking-wide text-slate-100">
        清醒微休息 · 双手离开琴键静放
      </div>

      {reminderMessage && (
        <p
          key={reminderPulseToken}
          data-testid="guided-micro-rest-reminder"
          data-pulse-token={reminderPulseToken}
          className="animate-pulse rounded-full border border-amber-200/40 bg-white/15 px-3.5 py-1 text-xs font-medium text-amber-100"
        >
          {reminderMessage}
        </p>
      )}

      <button
        type="button"
        data-testid="guided-skip-micro-rest-btn"
        onClick={onSkip}
        className="min-h-[44px] min-w-[44px] rounded-lg border border-white/40 bg-white/15 px-4 py-2 text-xs font-semibold text-white transition hover:bg-white/25"
      >
        跳过微休息 (C8 / →)
      </button>
    </div>
  );
}
