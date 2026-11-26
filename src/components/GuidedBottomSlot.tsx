import type { ColdStartProbeEvaluation } from "../guided/coldStartProbe";
import type { GuidedSessionPhase } from "../guided/pianoCommandKeys";
import type { AudiationCueSummary, AudiationPrimingState } from "../guided/transitionFlow";
import type { GuidedBoutSummary } from "../store/useGuidedSessionStore";
import { AcousticProfileSlot } from "./AcousticProfileSlot";
import { AudiationPrimingBar } from "./AudiationPrimingBar";

export interface GuidedBottomSlotProps {
  sessionPhase: GuidedSessionPhase;
  lastBoutSummary: GuidedBoutSummary | null;
  lastProbeResult?: ColdStartProbeEvaluation | null;
  audiationCue: AudiationCueSummary;
  audiationState: AudiationPrimingState | null;
  imageryRemainingSec: number | null;
  onTriggerPreview: () => void;
  onStopPreview: () => void;
  onShowFingerings: () => void;
  onContinueNext: () => void;
  onReplayCurrent: () => void;
  onSelectTroubleMeasure?: (measureIndex: number) => void;
  onMarkHard?: () => void;
}

/**
 * Equal-height horizontal bottom slot that cleanly swaps with the 88-key keyboard area
 * during Audiation Priming ready windows, delayed summary, or on-demand B0/F inspection
 * without ever occluding the upper musical score.
 */
export function GuidedBottomSlot({
  sessionPhase,
  lastBoutSummary,
  lastProbeResult = null,
  audiationCue,
  audiationState,
  imageryRemainingSec,
  onTriggerPreview,
  onStopPreview,
  onShowFingerings,
  onContinueNext,
  onReplayCurrent,
  onSelectTroubleMeasure,
  onMarkHard,
}: GuidedBottomSlotProps) {
  const showAcousticSlot =
    sessionPhase !== "micro-rest" &&
    sessionPhase !== "macro-rest" &&
    Boolean(lastBoutSummary?.acousticProfile);

  return (
    <section
      data-testid="guided-delayed-feedback-panel"
      aria-label="科学练琴底部就绪与汇总槽"
      className="flex min-h-[176px] flex-col justify-between gap-2.5 border-t border-teal-200 bg-white px-4 py-3 text-xs shadow-[0_-4px_12px_rgba(15,23,42,0.05)]"
    >
      {lastBoutSummary && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-1.5 text-[11px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-800">{lastBoutSummary.headline}</span>
            <span className="text-slate-500">{lastBoutSummary.detail}</span>
          </div>
          {lastBoutSummary.markedHard ? (
            <span
              data-testid="guided-marked-hard-badge"
              className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900"
            >
              已标 Hard · 锁速巩固
            </span>
          ) : (
            lastBoutSummary.canMarkHard &&
            onMarkHard && (
              <button
                type="button"
                data-testid="guided-mark-hard-btn"
                onClick={onMarkHard}
                className="min-h-[36px] rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100"
              >
                感觉发紧 → 标 Hard
              </button>
            )
          )}
        </div>
      )}

      {showAcousticSlot && lastBoutSummary?.acousticProfile && (
        <AcousticProfileSlot
          profile={lastBoutSummary.acousticProfile}
          onSelectTroubleMeasure={onSelectTroubleMeasure}
        />
      )}

      {lastProbeResult && !lastProbeResult.passed && (
        <div
          data-testid="cold-probe-result-banner"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950"
        >
          <div className="flex flex-wrap items-center gap-2">
            {lastProbeResult.branchDivergenceDetected && (
              <span
                data-testid="cold-probe-switch-divergence-badge"
                className="rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold text-white"
              >
                {lastProbeResult.flaggedLabel ?? "Switch Point 分支跑偏"}
              </span>
            )}
            <span>{lastProbeResult.reasonSummary}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="cold-probe-retry-a0-btn"
              disabled={!lastProbeResult.canRetryA0}
              onClick={onReplayCurrent}
              className="min-h-[44px] rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              立即重测 1 次 (A0)
            </button>
            <button
              type="button"
              data-testid="cold-probe-continue-c8-btn"
              onClick={onContinueNext}
              className="min-h-[44px] rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700"
            >
              记录并继续 (C8)
            </button>
          </div>
        </div>
      )}

      {sessionPhase === "audiation" ? (
        <AudiationPrimingBar
          cue={audiationCue}
          audiationState={audiationState}
          imageryRemainingSec={imageryRemainingSec}
          onTriggerPreview={onTriggerPreview}
          onStopPreview={onStopPreview}
          onShowFingerings={onShowFingerings}
          onStartNextChunk={onContinueNext}
          onReplayPrevious={onReplayCurrent}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 py-2">
          <div className="space-y-1">
            <div className="font-semibold text-slate-900">
              {lastBoutSummary?.headline ?? "当前组块反馈"}
            </div>
            <div className="text-slate-600">
              {lastBoutSummary?.detail ??
                "Stage 0 落键停顿遥测已严格隔离，不写入连续声学画像；可按 B0 或 F 切回 88 键手型与指法。"}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="guided-back-to-piano-btn"
              onClick={onShowFingerings}
              className="min-h-[44px] min-w-[44px] rounded-lg border border-teal-500 bg-teal-50 px-3 py-2 text-xs font-semibold text-teal-900 hover:bg-teal-100"
            >
              看指法 · 切回 88 键手型 (B0 / F)
            </button>
            <button
              type="button"
              onClick={onReplayCurrent}
              className="min-h-[44px] min-w-[44px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              重练本块 (A0)
            </button>
            <button
              type="button"
              onClick={onContinueNext}
              className="min-h-[44px] min-w-[44px] rounded-lg bg-teal-600 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-700"
            >
              {sessionPhase === "summary" ? "再练一轮 (C8)" : "继续 / 下一块 (C8)"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
