import type { CoachResult } from "../coach/types";

export interface ExternalFocusCoachCardProps {
  coachResult: CoachResult | null;
  loading?: boolean;
  remoteConfigured?: boolean;
  onTriggerCoach?: () => void;
}

/**
 * Stand-glanceable External-Focus Coach card.
 * Strictly renders escaped React plain-text nodes (zero raw HTML injection)
 * and keeps on-demand trigger non-blocking so C8 / continue is never delayed.
 */
export function ExternalFocusCoachCard({
  coachResult,
  loading = false,
  remoteConfigured = false,
  onTriggerCoach,
}: ExternalFocusCoachCardProps) {
  if (!coachResult) return null;

  const { response, source, diagnostic } = coachResult;
  const sourceBadge =
    source === "llm"
      ? "BYOK / Ollama 外部注意教练"
      : source === "fallback"
        ? "本地模板（已静默回退）"
        : "0 ms 本地外部注意模板";

  return (
    <div
      data-testid="external-focus-coach-card"
      className="flex flex-col gap-1.5 rounded-lg border border-teal-200 bg-teal-50/50 px-3 py-2 text-xs text-slate-800"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-semibold text-teal-950">外部注意教练</span>
          <span
            data-testid="coach-source-badge"
            className="rounded-full border border-teal-200 bg-white px-2 py-0.5 text-[10px] font-medium text-teal-800"
          >
            {sourceBadge}
          </span>
        </div>

        {onTriggerCoach && (
          <button
            type="button"
            data-testid="coach-trigger-btn"
            disabled={loading}
            onClick={onTriggerCoach}
            className="min-h-[32px] rounded-md border border-teal-400 bg-white px-2.5 py-1 text-[11px] font-semibold text-teal-900 hover:bg-teal-100 disabled:cursor-wait disabled:opacity-60"
          >
            {loading
              ? "生成点评中（可按 C8 直接继续）..."
              : remoteConfigured
                ? "获取 AI 外部注意点评 (G)"
                : "刷新外部注意提示 (G)"}
          </button>
        )}
      </div>

      <p data-testid="coach-praise-text" className="font-medium text-emerald-900">
        {response.praise}
      </p>

      {response.focusCues.length > 0 && (
        <ul className="space-y-1">
          {response.focusCues.map((cue) => (
            <li
              key={cue.evidenceId}
              data-testid={`coach-focus-cue-${cue.evidenceId}`}
              className="flex items-start gap-1.5 text-[11px] text-slate-800"
            >
              <span className="shrink-0 rounded bg-teal-100 px-1.5 py-0.5 text-[10px] font-semibold text-teal-900">
                m.{cue.measures.join("–")}
              </span>
              <span>{cue.soundCue}</span>
            </li>
          ))}
        </ul>
      )}

      <div
        data-testid="coach-next-goal-text"
        className="rounded border border-teal-200/70 bg-white/80 px-2 py-1 text-[11px] text-slate-700"
      >
        <span className="font-semibold text-teal-900">下一遍听觉目标：</span>
        <span>{response.nextPassListeningGoal}</span>
      </div>

      {diagnostic && (
        <div
          data-testid="coach-card-diagnostic"
          className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] text-amber-900"
        >
          <span className="font-semibold">{diagnostic.title}：</span>
          <span>{diagnostic.message}</span>
        </div>
      )}
    </div>
  );
}
