export interface EarlyMacroRestVeilProps {
  remainingSec: number;
  onSkip: () => void;
}

/**
 * Skippable ~2 min off-keyboard Early Macro-Rest veil offered once around 12–15 min
 * in 25 / 40 min Guided Sessions (never in 15 min sessions).
 */
export function EarlyMacroRestVeil({ remainingSec, onSkip }: EarlyMacroRestVeilProps) {
  const mins = Math.floor(Math.max(0, remainingSec) / 60);
  const secs = Math.max(0, remainingSec) % 60;
  const formatted = `${mins}:${String(secs).padStart(2, "0")}`;

  return (
    <div
      data-testid="guided-macro-rest-veil"
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 rounded-xl bg-teal-950/70 p-6 text-center text-white backdrop-blur-xs"
    >
      <div
        data-testid="guided-macro-rest-countdown"
        className="text-3xl font-semibold tabular-nums tracking-tight text-teal-100"
      >
        {formatted}
      </div>
      <div className="space-y-1">
        <div className="text-sm font-semibold tracking-wide text-white">
          前期清醒大休息（Early Macro-Rest）· 建议离开琴键放松 ~2 分钟
        </div>
        <p className="text-xs text-teal-100/80">
          已完成开场穿插轮次，短暂离键走动有助于放大跨夜运动记忆巩固。
        </p>
      </div>
      <button
        type="button"
        data-testid="guided-skip-macro-rest-btn"
        onClick={onSkip}
        className="min-h-[44px] min-w-[44px] rounded-lg border border-white/40 bg-white/15 px-4 py-2 text-xs font-semibold text-white transition hover:bg-white/25"
      >
        跳过大休息 (C8 / →)
      </button>
    </div>
  );
}
