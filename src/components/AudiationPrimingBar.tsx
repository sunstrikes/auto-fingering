import type { AudiationCueSummary, AudiationPrimingState } from "../guided/transitionFlow";

export interface AudiationPrimingBarProps {
  cue: AudiationCueSummary;
  audiationState: AudiationPrimingState | null;
  imageryRemainingSec: number | null;
  onTriggerPreview: () => void;
  onStopPreview: () => void;
  onShowFingerings: () => void;
  onStartNextChunk: () => void;
  onReplayPrevious: () => void;
}

/**
 * Non-blocking Audiation Priming ready-window strip rendered inside the equal-height
 * bottom slot immediately after Micro-Rest. Displays the single-line audiation &
 * HandPosition prompt, optional soft audio preview trigger/status, optional non-blocking
 * 10 s imagery timer, and >= 44px B0 / F "看指法" toggle.
 */
export function AudiationPrimingBar({
  cue,
  audiationState,
  imageryRemainingSec,
  onTriggerPreview,
  onStopPreview,
  onShowFingerings,
  onStartNextChunk,
  onReplayPrevious,
}: AudiationPrimingBarProps) {
  const previewStatus = audiationState?.previewStatus ?? "idle";
  const isPlayingPreview = previewStatus === "playing";

  return (
    <div data-testid="audiation-priming-bar" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-teal-100 px-2.5 py-0.5 text-[11px] font-semibold text-teal-900">
            Audiation Priming · 就绪窗
          </span>
          {cue.measureRangeLabel && (
            <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
              下一块 {cue.measureRangeLabel}
            </span>
          )}
          <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
            {cue.isUnfamiliar ? `生疏块 (${cue.historicalPassCount}/2 遍)` : `已练 ${cue.historicalPassCount} 遍`}
          </span>
          {imageryRemainingSec !== null && (
            <span
              data-testid="audiation-imagery-timer"
              className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-800 tabular-nums"
            >
              意象引导 {imageryRemainingSec} s（非阻塞）
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            data-testid="audiation-preview-status"
            data-preview-status={previewStatus}
            className="text-[11px] text-slate-500"
          >
            {isPlayingPreview
              ? "正在轻声范奏（按 C8 或首音即刻打断开弹）"
              : previewStatus === "interrupted"
                ? "范奏已即时打断"
                : previewStatus === "completed"
                  ? "范奏已播放"
                  : cue.shouldAutoPreview
                    ? "生疏块将轻声范奏"
                    : "可随时点击试听"}
          </span>
          {isPlayingPreview ? (
            <button
              type="button"
              data-testid="audiation-stop-preview-btn"
              onClick={onStopPreview}
              className="min-h-[44px] min-w-[44px] rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
            >
              停止试听
            </button>
          ) : (
            <button
              type="button"
              data-testid="audiation-preview-btn"
              onClick={onTriggerPreview}
              className="min-h-[44px] min-w-[44px] rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              轻声试听范奏
            </button>
          )}
        </div>
      </div>

      <div
        data-testid="audiation-single-line-cue"
        className="truncate rounded-lg border border-teal-100 bg-teal-50/60 px-3 py-2 text-xs font-medium text-teal-950"
        title={cue.singleLinePrompt}
      >
        {cue.singleLinePrompt}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-slate-500">
          免手控：A0 重练上一块 · B0/F 随时看指法 · C8 或弹响下一块首音立即开弹
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="guided-back-to-piano-btn"
            onClick={onShowFingerings}
            className="min-h-[44px] min-w-[44px] rounded-lg border border-teal-500 bg-teal-50 px-3 py-2 text-xs font-semibold text-teal-900 hover:bg-teal-100"
          >
            看指法 (B0 / F)
          </button>
          <button
            type="button"
            data-testid="audiation-replay-btn"
            onClick={onReplayPrevious}
            className="min-h-[44px] min-w-[44px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            重练本块 (A0)
          </button>
          <button
            type="button"
            data-testid="audiation-start-btn"
            onClick={onStartNextChunk}
            className="min-h-[44px] min-w-[44px] rounded-lg bg-teal-600 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-700"
          >
            开始下一块 (C8)
          </button>
        </div>
      </div>
    </div>
  );
}
