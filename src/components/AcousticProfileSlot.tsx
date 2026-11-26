import type {
  AcousticProfileResult,
  AcousticStatus,
} from "../guided/acousticProfile";

export interface AcousticProfileSlotProps {
  profile: AcousticProfileResult;
  onSelectTroubleMeasure?: (measureIndex: number) => void;
  compact?: boolean;
}

const CAPSULE_STYLE: Record<AcousticStatus, { container: string; dot: string }> = {
  green: {
    container: "border-emerald-300 bg-emerald-50 text-emerald-900",
    dot: "bg-emerald-500",
  },
  amber: {
    container: "border-amber-300 bg-amber-50 text-amber-950",
    dot: "bg-amber-500",
  },
  red: {
    container: "border-rose-300 bg-rose-50 text-rose-950",
    dot: "bg-rose-500",
  },
};

/**
 * Stand-glanceable (<= 3 s) Acoustic Profile summary strip: 2-3 adaptive
 * green/amber/red status capsules + clickable trouble-measure hotspot strip.
 * Never displays 0-100 composite scores or multi-chart dashboards.
 */
export function AcousticProfileSlot({
  profile,
  onSelectTroubleMeasure,
  compact = false,
}: AcousticProfileSlotProps) {
  return (
    <div
      data-testid="acoustic-profile-slot"
      className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        {profile.capsules.map((capsule) => {
          const style = CAPSULE_STYLE[capsule.status];
          return (
            <span
              key={capsule.id}
              data-testid={`acoustic-capsule-${capsule.id}`}
              data-status={capsule.status}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${style.container}`}
            >
              <span className={`h-2 w-2 rounded-full ${style.dot}`} aria-hidden="true" />
              <span>{capsule.label}</span>
              <span className="font-mono font-medium opacity-90">{capsule.valueText}</span>
              {capsule.detailText && (
                <span className="rounded bg-white/70 px-1 text-[10px] font-medium opacity-85">
                  {capsule.detailText}
                </span>
              )}
            </span>
          );
        })}
      </div>

      {profile.troubleMeasures.length > 0 && (
        <div
          data-testid="acoustic-hotspot-strip"
          className="flex flex-wrap items-center gap-1.5 pt-0.5"
        >
          <span className="text-[11px] font-medium text-slate-600">问题小节热区（点击看指法）：</span>
          {profile.troubleMeasures.map((tm) => (
            <button
              key={tm.measureIndex}
              type="button"
              data-testid={`acoustic-hotspot-measure-${tm.measureIndex}`}
              data-severity={tm.severity}
              title={tm.reasons.join("；")}
              onClick={() => onSelectTroubleMeasure?.(tm.measureIndex)}
              className={`inline-flex items-center gap-1 rounded-md border px-2.5 font-semibold transition ${
                compact ? "min-h-[32px] py-1 text-[11px]" : "min-h-[44px] py-1.5 text-xs"
              } ${
                tm.severity === "red"
                  ? "border-rose-300 bg-rose-100 text-rose-900 hover:bg-rose-200"
                  : "border-amber-300 bg-amber-100 text-amber-950 hover:bg-amber-200"
              }`}
            >
              <span>第 {tm.measureIndex + 1} 小节</span>
              <span className="text-[10px] font-normal opacity-80">
                · {tm.reasons[0]}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
