import { useState } from "react";
import type {
  ScoreRepairIssueKind,
  ScoreRepairOption,
  ScoreRepairSuggestion,
} from "../domain/types";

export interface ScoreRepairPanelProps {
  suggestions: ScoreRepairSuggestion[];
  isApplying?: boolean;
  onLocateSuggestion: (suggestion: ScoreRepairSuggestion) => void;
  onApplyOption: (suggestion: ScoreRepairSuggestion, option: ScoreRepairOption) => void;
  onApplyAll?: (items: Array<{ suggestion: ScoreRepairSuggestion; option: ScoreRepairOption }>) => void;
  onDismissSuggestion: (repairId: string) => void;
  onClose: () => void;
}

const ISSUE_BADGE_META: Record<
  ScoreRepairIssueKind,
  { text: string; className: string }
> = {
  "chord-over-octave": {
    text: "超八度",
    className: "border-red-200 bg-red-50 text-red-700",
  },
  "held-over-octave": {
    text: "延音粘连超八度",
    className: "border-red-200 bg-red-50 text-red-700",
  },
  "chord-exceeds-5": {
    text: "超五指",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
};

export function ScoreRepairPanel({
  suggestions,
  isApplying = false,
  onLocateSuggestion,
  onApplyOption,
  onApplyAll,
  onDismissSuggestion,
  onClose,
}: ScoreRepairPanelProps) {
  const [selectedOptionByRepairId, setSelectedOptionByRepairId] = useState<
    Record<string, string>
  >({});

  const resolveActiveOption = (suggestion: ScoreRepairSuggestion): ScoreRepairOption | undefined => {
    const chosenId =
      selectedOptionByRepairId[suggestion.repairId] ??
      suggestion.options[0]?.optionId;
    return (
      suggestion.options.find((o) => o.optionId === chosenId) ??
      suggestion.options[0]
    );
  };

  const handleApplyAllClick = () => {
    if (!onApplyAll) return;
    const items = suggestions
      .map((suggestion) => {
        const option = resolveActiveOption(suggestion);
        return option ? { suggestion, option } : null;
      })
      .filter(
        (item): item is { suggestion: ScoreRepairSuggestion; option: ScoreRepairOption } =>
          item !== null
      );
    if (items.length > 0) {
      onApplyAll(items);
    }
  };

  return (
    <div
      data-testid="score-repair-panel"
      className="absolute right-0 top-7 z-40 max-h-[65vh] w-[420px] max-w-[92vw] overflow-y-auto rounded-lg border border-amber-200 bg-white p-2.5 shadow-xl"
    >
      <div className="mb-2 flex items-center justify-between gap-2 border-b border-slate-100 pb-1.5 text-[11px] font-semibold text-slate-900">
        <span>乐谱可演奏性诊断与无损修复（{suggestions.length}）</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid="score-repair-apply-all-btn"
            disabled={isApplying || suggestions.length === 0}
            onClick={handleApplyAllClick}
            className="rounded bg-blue-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isApplying ? "修复中..." : "一键修复"}
          </button>
          <button
            type="button"
            data-testid="score-repair-close-btn"
            onClick={onClose}
            className="rounded px-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="space-y-2.5">
        {suggestions.map((suggestion) => {
          const badge = ISSUE_BADGE_META[suggestion.issueKind];
          const activeOption = resolveActiveOption(suggestion);
          if (!activeOption) return null;

          return (
            <div
              key={suggestion.repairId}
              data-testid={`repair-item-${suggestion.repairId}`}
              className="rounded-lg border border-slate-200 bg-slate-50/70 p-2 text-[11px]"
            >
              <button
                type="button"
                data-testid={`repair-locate-${suggestion.repairId}`}
                onClick={() => onLocateSuggestion(suggestion)}
                className="flex w-full items-start justify-between gap-2 text-left hover:text-blue-700"
                title="点击定位到五线谱与 88 键键盘"
              >
                <span className="font-semibold text-slate-800 hover:underline">
                  {suggestion.summary}
                </span>
                <span
                  className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}
                >
                  {badge.text}
                </span>
              </button>

              <div className="mt-1.5 flex flex-wrap gap-1">
                {suggestion.options.map((opt, idx) => {
                  const isSelected = opt.optionId === activeOption.optionId;
                  return (
                    <button
                      key={opt.optionId}
                      type="button"
                      data-testid={`repair-opt-${opt.optionId}`}
                      aria-pressed={isSelected}
                      onClick={() =>
                        setSelectedOptionByRepairId((prev) => ({
                          ...prev,
                          [suggestion.repairId]: opt.optionId,
                        }))
                      }
                      className={`rounded border px-2 py-0.5 text-[11px] font-medium transition ${
                        isSelected
                          ? "border-blue-600 bg-blue-50 text-blue-800"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900"
                      }`}
                    >
                      {opt.label}
                      {idx === 0 ? " (推荐)" : ""}
                    </button>
                  );
                })}
              </div>

              <div className="mt-1.5 rounded border border-slate-200/80 bg-white px-2 py-1 text-[11px] text-slate-600">
                <div className="font-mono text-[10px] font-semibold text-slate-800">
                  修改预览：{activeOption.previewSummary}
                </div>
                <p className="mt-0.5 leading-snug text-slate-500">
                  {activeOption.description}
                </p>
              </div>

              <div className="mt-2 flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  data-testid={`repair-dismiss-${suggestion.repairId}`}
                  disabled={isApplying}
                  onClick={() => onDismissSuggestion(suggestion.repairId)}
                  className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                >
                  忽略
                </button>
                <button
                  type="button"
                  data-testid={`repair-apply-${suggestion.repairId}`}
                  disabled={isApplying}
                  onClick={() => onApplyOption(suggestion, activeOption)}
                  className="rounded bg-slate-900 px-2.5 py-0.5 text-[11px] font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {isApplying ? "应用中..." : "同意替换"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
