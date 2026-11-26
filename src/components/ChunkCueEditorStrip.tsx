import { useState } from "react";
import type { ScoreCoord } from "../domain/types";
import type {
  ChunkJunction,
  MotorChunk,
  PassageInstance,
  PerformanceCue,
  PerformanceCueKind,
  PerformanceCueOverrideEntry,
} from "../chunking/types";

export interface ChunkCueEditorStripProps {
  motorChunks: MotorChunk[];
  chunkJunctions: ChunkJunction[];
  performanceCues: PerformanceCue[];
  selectedMeasureIndex: number | null;
  measureCount: number;
  chunkEditingEnabled: boolean;
  hasChunkOverrides: boolean;
  hasCueOverrides: boolean;
  inspectedClusterInstance: PassageInstance | null;
  inspectedClusterLabel: string | null;
  onSplitChunkAtMeasure?: (measureIndex: number) => void;
  onMergeChunkBoundary?: (boundaryCoord: ScoreCoord) => void;
  onResetChunkOverrides?: () => void;
  onUpsertCueOverride?: (entry: PerformanceCueOverrideEntry) => void;
  onRemoveCueOverride?: (coord: ScoreCoord, kind?: PerformanceCueKind) => void;
  onResetCueOverrides?: () => void;
  onCloseInspectCluster?: () => void;
}

const CUE_KIND_LABELS: Record<PerformanceCueKind, string> = {
  switch: "分叉",
  structural: "结构",
  technical: "技术",
  expressive: "表情",
};

/**
 * Renders interactive barline Split/Merge MotorChunk controls, sparse PerformanceCue
 * Pin/Add/Hide/Edit-label controls (with reset-to-auto), and on-demand Variant Diff banner
 * inside ScoreViewer without laying down permanent background tints during normal play.
 */
export function ChunkCueEditorStrip({
  motorChunks,
  chunkJunctions,
  performanceCues,
  selectedMeasureIndex,
  measureCount,
  chunkEditingEnabled,
  hasChunkOverrides,
  hasCueOverrides,
  inspectedClusterInstance,
  inspectedClusterLabel,
  onSplitChunkAtMeasure,
  onMergeChunkBoundary,
  onResetChunkOverrides,
  onUpsertCueOverride,
  onResetCueOverrides,
  onCloseInspectCluster,
}: ChunkCueEditorStripProps) {
  const [editingCueId, setEditingCueId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [showCollapsedCues, setShowCollapsedCues] = useState(false);
  const [addingCue, setAddingCue] = useState(false);
  const [newCueMeasureOneBased, setNewCueMeasureOneBased] = useState<number>(1);
  const [newCueKind, setNewCueKind] = useState<PerformanceCueKind>("technical");
  const [newCueLabel, setNewCueLabel] = useState("");

  const hasHiddenOrCollapsed = performanceCues.some((c) => c.collapsed || c.hidden);
  const visibleCues = performanceCues.filter(
    (c) => !c.hidden && (!c.collapsed || showCollapsedCues),
  );
  const hiddenCues = performanceCues.filter((c) => c.hidden);

  const junctionByBoundaryMeasure = new Map<number, ChunkJunction>();
  for (const j of chunkJunctions) {
    junctionByBoundaryMeasure.set(j.measureIndex, j);
  }

  return (
    <>
      {inspectedClusterInstance && (
        <div
          data-testid="variant-diff-banner"
          className="mb-1.5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-teal-300 bg-teal-50/75 px-2.5 py-1.5 text-xs text-teal-950"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-teal-800">
              变奏对照 {inspectedClusterLabel ?? inspectedClusterInstance.instanceId}
            </span>
            <span>
              m.{inspectedClusterInstance.startMeasureIndex + 1}–
              {inspectedClusterInstance.endMeasureIndex + 1}
            </span>
            <span className="rounded bg-teal-100 px-1.5 py-0.5 font-medium text-teal-800">
              MotorReuse {Math.round(inspectedClusterInstance.motorReuse * 100)}%
            </span>
            {inspectedClusterInstance.transpositionSemitones !== 0 && (
              <span className="rounded bg-white px-1.5 py-0.5 text-[11px] text-teal-800">
                移调 {inspectedClusterInstance.transpositionSemitones > 0 ? "+" : ""}
                {inspectedClusterInstance.transpositionSemitones} 半音
              </span>
            )}
            {inspectedClusterInstance.diffCoords.length === 0 ? (
              <span className="text-[11px] text-teal-700">完全同构重复</span>
            ) : (
              <div className="flex flex-wrap items-center gap-1">
                {inspectedClusterInstance.diffCoords.slice(0, 6).map((diff, idx) => (
                  <span
                    key={`${diff.measureIndex}-${idx}`}
                    data-testid={`variant-diff-item-${idx}`}
                    className="rounded border border-teal-200 bg-white px-1.5 py-0.5 text-[11px] text-teal-900"
                  >
                    {diff.description}
                  </span>
                ))}
                {inspectedClusterInstance.diffCoords.length > 6 && (
                  <span className="text-[11px] text-teal-700">
                    +{inspectedClusterInstance.diffCoords.length - 6} 处差异
                  </span>
                )}
              </div>
            )}
          </div>
          {onCloseInspectCluster && (
            <button
              type="button"
              data-testid="variant-diff-close-btn"
              onClick={onCloseInspectCluster}
              className="rounded border border-teal-300 bg-white px-2 py-0.5 text-[11px] font-medium text-teal-800 hover:bg-teal-100"
            >
              关闭对照
            </button>
          )}
        </div>
      )}

      {chunkEditingEnabled && motorChunks.length > 0 && (
        <div
          data-testid="motor-chunk-strip"
          className="mb-1.5 flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-slate-50/80 px-2 py-1 text-[11px]"
        >
          <span className="mr-1 font-semibold text-slate-700">组块拆合:</span>
          {motorChunks.map((chunk, idx) => {
            const nextChunk = motorChunks[idx + 1];
            const boundaryMeasure = nextChunk?.startCoord.measureIndex ?? -1;
            const junction =
              boundaryMeasure >= 0 ? junctionByBoundaryMeasure.get(boundaryMeasure) : undefined;
            const interiorBarlines: number[] = [];
            for (let m = chunk.startMeasureIndex + 1; m <= chunk.endMeasureIndex; m++) {
              interiorBarlines.push(m);
            }
            return (
              <div key={chunk.chunkId} className="inline-flex items-center gap-1">
                <span
                  data-testid={`motor-chunk-pill-${chunk.chunkId}`}
                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium ${
                    chunk.userPinned
                      ? "border-teal-300 bg-teal-50 text-teal-900"
                      : "border-slate-200 bg-white text-slate-700"
                  }`}
                >
                  <span>
                    块{chunk.index + 1} m.{chunk.startMeasureIndex + 1}
                    {chunk.endMeasureIndex > chunk.startMeasureIndex
                      ? `–${chunk.endMeasureIndex + 1}`
                      : ""}
                  </span>
                  {chunk.userPinned && (
                    <span
                      data-testid={`chunk-pinned-badge-${chunk.chunkId}`}
                      className="rounded bg-teal-600 px-1 text-[10px] text-white"
                    >
                      已固定
                    </span>
                  )}
                  {interiorBarlines.map((m) => (
                    <button
                      key={`split-${m}`}
                      type="button"
                      data-testid={`chunk-barline-split-${m}`}
                      onClick={() => onSplitChunkAtMeasure?.(m)}
                      title={`在第 ${m + 1} 小节线处拆分`}
                      className="rounded border border-slate-300 bg-slate-100 px-1 text-[10px] text-slate-700 hover:border-teal-500 hover:bg-teal-50 hover:text-teal-800"
                    >
                      | 拆m.{m + 1}
                    </button>
                  ))}
                </span>

                {nextChunk && (
                  <button
                    type="button"
                    data-testid={`chunk-barline-merge-${boundaryMeasure}`}
                    onClick={() => onMergeChunkBoundary?.(nextChunk.startCoord)}
                    title={`合并第 ${boundaryMeasure + 1} 小节线两侧组块`}
                    className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-medium transition ${
                      junction?.isHighRisk
                        ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
                        : "border-slate-300 bg-white text-slate-600 hover:border-teal-500 hover:bg-teal-50 hover:text-teal-800"
                    }`}
                  >
                    <span>⇄ 合</span>
                    {junction?.isHighRisk && (
                      <span className="font-semibold">
                        R:{Math.round(junction.priorRisk * 100)}%
                      </span>
                    )}
                  </button>
                )}
              </div>
            );
          })}
          {hasChunkOverrides && onResetChunkOverrides && (
            <button
              type="button"
              data-testid="reset-chunk-overrides-btn"
              onClick={onResetChunkOverrides}
              className="ml-auto rounded border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-700 hover:bg-slate-100"
            >
              还原自动分组
            </button>
          )}
        </div>
      )}

      {chunkEditingEnabled && (performanceCues.length > 0 || motorChunks.length > 0) && (
        <div
          data-testid="performance-cue-bar"
          className="mb-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px]"
        >
          <span className="font-semibold text-slate-700">检索锚点:</span>

          {visibleCues.map((cue) => {
            const isEditing = editingCueId === cue.cueId;
            return (
              <div
                key={cue.cueId}
                data-testid={`performance-cue-item-${cue.cueId}`}
                className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 ${
                  cue.userPinned
                    ? "border-teal-300 bg-teal-50/60 text-teal-950"
                    : "border-slate-200 bg-slate-50 text-slate-700"
                }`}
              >
                <span className="rounded bg-slate-200/80 px-1 text-[10px] font-semibold">
                  {CUE_KIND_LABELS[cue.kind]} · m.{cue.measureIndex + 1}
                </span>

                {isEditing ? (
                  <span className="inline-flex items-center gap-1">
                    <input
                      type="text"
                      data-testid={`cue-label-input-${cue.cueId}`}
                      value={labelDraft}
                      maxLength={32}
                      onChange={(e) => setLabelDraft(e.target.value)}
                      placeholder="简短口诀"
                      className="w-28 rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px]"
                    />
                    <button
                      type="button"
                      data-testid={`cue-label-save-btn-${cue.cueId}`}
                      onClick={() => {
                        onUpsertCueOverride?.({
                          coord: cue.coord,
                          kind: cue.kind,
                          pinned: true,
                          customLabel: labelDraft.trim(),
                        });
                        setEditingCueId(null);
                      }}
                      className="rounded bg-teal-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-teal-700"
                    >
                      保存
                    </button>
                  </span>
                ) : (
                  <span className="font-medium">{cue.customLabel ?? cue.label}</span>
                )}

                <button
                  type="button"
                  data-testid={`cue-pin-btn-${cue.cueId}`}
                  onClick={() =>
                    onUpsertCueOverride?.({
                      coord: cue.coord,
                      kind: cue.kind,
                      pinned: !cue.userPinned,
                    })
                  }
                  title={cue.userPinned ? "取消固定" : "固定锚点"}
                  className="rounded px-1 text-[10px] text-slate-600 hover:bg-slate-200"
                >
                  {cue.userPinned ? "已钉" : "Pin"}
                </button>
                <button
                  type="button"
                  data-testid={`cue-edit-label-btn-${cue.cueId}`}
                  onClick={() => {
                    setEditingCueId(cue.cueId);
                    setLabelDraft(cue.customLabel ?? cue.label);
                  }}
                  className="rounded px-1 text-[10px] text-slate-600 hover:bg-slate-200"
                >
                  改口诀
                </button>
                <button
                  type="button"
                  data-testid={`cue-hide-btn-${cue.cueId}`}
                  onClick={() =>
                    onUpsertCueOverride?.({
                      coord: cue.coord,
                      kind: cue.kind,
                      hidden: true,
                    })
                  }
                  className="rounded px-1 text-[10px] text-slate-500 hover:bg-slate-200"
                >
                  隐藏
                </button>
              </div>
            );
          })}

          {showCollapsedCues &&
            hiddenCues.map((cue) => (
              <div
                key={`hidden-${cue.cueId}`}
                className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 bg-slate-50 px-1.5 py-0.5 text-slate-500"
              >
                <span>
                  m.{cue.measureIndex + 1} {cue.customLabel ?? cue.label} (已隐藏)
                </span>
                <button
                  type="button"
                  data-testid={`cue-unhide-btn-${cue.cueId}`}
                  onClick={() =>
                    onUpsertCueOverride?.({
                      coord: cue.coord,
                      kind: cue.kind,
                      hidden: false,
                    })
                  }
                  className="rounded bg-white px-1 text-[10px] text-slate-700 hover:bg-slate-200"
                >
                  显示
                </button>
              </div>
            ))}

          {hasHiddenOrCollapsed && (
            <button
              type="button"
              data-testid="cue-show-collapsed-btn"
              onClick={() => setShowCollapsedCues((v) => !v)}
              className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-100"
            >
              {showCollapsedCues ? "收起折叠/隐藏" : "展开表情/隐藏"}
            </button>
          )}

          {addingCue ? (
            <div className="inline-flex flex-wrap items-center gap-1 rounded border border-teal-200 bg-teal-50/50 px-1.5 py-0.5">
              <label className="inline-flex items-center gap-1 text-[10px] text-slate-700">
                小节
                <input
                  type="number"
                  data-testid="cue-add-measure-input"
                  min={1}
                  max={Math.max(1, measureCount)}
                  value={newCueMeasureOneBased}
                  onChange={(e) =>
                    setNewCueMeasureOneBased(Math.max(1, Number(e.target.value) || 1))
                  }
                  className="w-12 rounded border border-slate-300 bg-white px-1 py-0.5 text-[10px]"
                />
              </label>
              <select
                data-testid="cue-add-kind-select"
                value={newCueKind}
                onChange={(e) => setNewCueKind(e.target.value as PerformanceCueKind)}
                className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[10px]"
              >
                <option value="technical">技术</option>
                <option value="structural">结构</option>
                <option value="expressive">表情</option>
              </select>
              <input
                type="text"
                data-testid="cue-add-label-input"
                value={newCueLabel}
                maxLength={32}
                onChange={(e) => setNewCueLabel(e.target.value)}
                placeholder="输入记忆口诀"
                className="w-28 rounded border border-slate-300 bg-white px-1 py-0.5 text-[10px]"
              />
              <button
                type="button"
                data-testid="cue-add-submit-btn"
                onClick={() => {
                  const targetM = Math.max(
                    0,
                    Math.min(Math.max(0, measureCount - 1), newCueMeasureOneBased - 1),
                  );
                  onUpsertCueOverride?.({
                    coord: { measureIndex: targetM, beatNum: 0, beatDen: 1 },
                    kind: newCueKind,
                    pinned: true,
                    customLabel: newCueLabel.trim() || `m.${targetM + 1} 锚点`,
                  });
                  setNewCueLabel("");
                  setAddingCue(false);
                }}
                className="rounded bg-teal-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-teal-700"
              >
                添加
              </button>
              <button
                type="button"
                onClick={() => setAddingCue(false)}
                className="rounded px-1 text-[10px] text-slate-600 hover:bg-slate-200"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              data-testid="cue-add-toggle-btn"
              onClick={() => {
                setNewCueMeasureOneBased((selectedMeasureIndex ?? 0) + 1);
                setAddingCue(true);
              }}
              className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-700 hover:bg-slate-100"
            >
              + 新增锚点
            </button>
          )}

          {hasCueOverrides && onResetCueOverrides && (
            <button
              type="button"
              data-testid="reset-cue-overrides-btn"
              onClick={onResetCueOverrides}
              className="ml-auto rounded border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-700 hover:bg-slate-100"
            >
              还原默认锚点
            </button>
          )}
        </div>
      )}
    </>
  );
}
