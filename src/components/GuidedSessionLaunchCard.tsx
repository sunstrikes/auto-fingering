import type {
  ChunkJunction,
  MacroSection,
  MotorChunk,
  PassageCluster,
} from "../chunking/types";
import type { SessionPlan } from "../guided/sessionPlanner";
import type { GuidedTimeBoxMinutes } from "../store/useGuidedSessionStore";

export interface GuidedSessionLaunchCardProps {
  pieceTitle: string;
  macroSections: MacroSection[];
  motorChunks: MotorChunk[];
  passageClusters: PassageCluster[];
  chunkJunctions: ChunkJunction[];
  sessionPlan?: SessionPlan | null;
  timeBoxMinutes: GuidedTimeBoxMinutes;
  selectedMacroSectionId: string | null;
  onSelectTimeBox: (minutes: GuidedTimeBoxMinutes) => void;
  onSelectMacroSection: (sectionId: string | null) => void;
  onStartSession: () => void;
  onStartQuickTriage?: () => void;
  onBackToFreeStudio: () => void;
  onFocusChunkEditor?: () => void;
}

const TIME_BOX_OPTIONS: readonly GuidedTimeBoxMinutes[] = [15, 25, 40];

/**
 * Single-piece Guided Session launch card: configures time-box preset (15 / 25 / 40 min),
 * MacroSection filter, PassageCluster repetition leverage summary, initial MotorChunk queue
 * preview, and pre-launch chunk/cue editing access without any multi-piece dashboard.
 */
export function GuidedSessionLaunchCard({
  pieceTitle,
  macroSections,
  motorChunks,
  passageClusters,
  chunkJunctions,
  sessionPlan = null,
  timeBoxMinutes,
  selectedMacroSectionId,
  onSelectTimeBox,
  onSelectMacroSection,
  onStartSession,
  onStartQuickTriage,
  onBackToFreeStudio,
  onFocusChunkEditor,
}: GuidedSessionLaunchCardProps) {
  const filteredChunks =
    selectedMacroSectionId !== null
      ? motorChunks.filter((c) => c.sectionId === selectedMacroSectionId)
      : motorChunks;
  const previewChunks =
    sessionPlan && sessionPlan.items.length > 0
      ? sessionPlan.items.slice(0, 6).map((item) => item.chunk)
      : (filteredChunks.length > 0 ? filteredChunks : motorChunks).slice(0, 6);

  const highRiskCount = chunkJunctions.filter((j) => j.isHighRisk).length;
  const totalSavedMeasures = passageClusters.reduce((sum, cluster) => {
    const first = cluster.instances[0];
    const protoMeasures = first ? first.endMeasureIndex - first.startMeasureIndex + 1 : 0;
    return sum + Math.max(0, cluster.totalCoveredMeasures - protoMeasures);
  }, 0);
  const topLeverage = passageClusters.reduce((best, c) => Math.max(best, c.leverageRatio), 1);

  return (
    <section
      data-testid="guided-launch-card"
      aria-label="科学练琴启动卡"
      className="shrink-0 rounded-xl border border-teal-200 bg-white p-3 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-semibold text-teal-800">
              Guided Session
            </span>
            <h2 className="text-sm font-semibold text-slate-900">
              {pieceTitle || "当前乐谱"} · 单曲科学练琴排课
            </h2>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            单曲时长制 · 先 Stage 0 友好落键（1 遍 ≥90% 或 2 分钟上限自动毕业），再转定速连贯与微休息。
          </p>
        </div>

        <div className="flex items-center gap-2">
          {onFocusChunkEditor && (
            <button
              type="button"
              data-testid="guided-launch-edit-chunks-btn"
              onClick={onFocusChunkEditor}
              className="min-h-[44px] min-w-[44px] rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              调整组块 / 检索锚点
            </button>
          )}
          <button
            type="button"
            data-testid="guided-launch-back-free-btn"
            onClick={onBackToFreeStudio}
            className="min-h-[44px] min-w-[44px] rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            返回 Free Studio
          </button>
        </div>
      </div>

      <div className="mt-2.5 grid gap-3 md:grid-cols-3">
        {/* Time-box preset */}
        <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-2">
          <div className="text-[11px] font-semibold text-slate-700">练琴时长预设</div>
          <div className="mt-1.5 flex items-center gap-1.5" role="group" aria-label="练琴时长">
            {TIME_BOX_OPTIONS.map((mins) => {
              const active = timeBoxMinutes === mins;
              return (
                <button
                  key={mins}
                  type="button"
                  data-testid={`guided-timebox-${mins}`}
                  aria-pressed={active}
                  onClick={() => onSelectTimeBox(mins)}
                  className={`min-h-[44px] min-w-[44px] flex-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                    active
                      ? "border-teal-600 bg-teal-600 text-white shadow-xs"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {mins} min
                </button>
              );
            })}
          </div>
        </div>

        {/* PassageCluster repetition leverage summary */}
        <div
          data-testid="guided-leverage-summary"
          className="rounded-lg border border-slate-200 bg-slate-50/70 p-2"
        >
          <div className="text-[11px] font-semibold text-slate-700">高杠杆重复摘要</div>
          {passageClusters.length > 0 ? (
            <div className="mt-1.5 space-y-1 text-xs text-slate-700">
              <div className="flex items-center justify-between">
                <span>识别 {passageClusters.length} 组 Passage Cluster</span>
                <span className="rounded bg-teal-100 px-1.5 py-0.5 text-[11px] font-semibold text-teal-800">
                  最高 {topLeverage.toFixed(1)}× 复用
                </span>
              </div>
              <div className="text-[11px] text-slate-500">
                可复用约 {totalSavedMeasures} 个重复小节 · 高危接缝 {highRiskCount} 处
              </div>
            </div>
          ) : (
            <div className="mt-1.5 text-xs text-slate-500">
              当前片段无大段重复簇 · 识别 {motorChunks.length} 个 Motor Chunk，高危接缝 {highRiskCount} 处
            </div>
          )}
        </div>

        {/* MacroSection selector */}
        <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-2">
          <label
            htmlFor="guided-macro-section-select"
            className="block text-[11px] font-semibold text-slate-700"
          >
            Macro Section 范围
          </label>
          <select
            id="guided-macro-section-select"
            data-testid="guided-macro-section-select"
            value={selectedMacroSectionId ?? "__all__"}
            onChange={(e) =>
              onSelectMacroSection(e.target.value === "__all__" ? null : e.target.value)
            }
            className="mt-1.5 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
          >
            <option value="__all__">
              全曲（{macroSections.length} 个乐段 / {motorChunks.length} 块）
            </option>
            {macroSections.map((sec) => (
              <option key={sec.sectionId} value={sec.sectionId}>
                {sec.label}（m.{sec.startMeasureIndex + 1}–{sec.endMeasureIndex + 1} ·{" "}
                {sec.chunkIds.length} 块）
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Initial queue preview + primary CTA */}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 pt-1">
        <div
          data-testid="guided-queue-preview"
          className="flex flex-wrap items-center gap-1.5 text-xs"
        >
          <span className="font-medium text-slate-600">排课队列预览:</span>
          {previewChunks.length === 0 ? (
            <span className="text-slate-400">正在生成组块队列…</span>
          ) : (
            previewChunks.map((chunk, idx) => (
              <span
                key={`${chunk.chunkId}-${idx}`}
                data-testid={`guided-preview-chunk-${chunk.chunkId}`}
                className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                  idx === 0
                    ? "border-teal-300 bg-teal-50 text-teal-900"
                    : "border-slate-200 bg-slate-50 text-slate-700"
                }`}
              >
                块{chunk.index + 1} m.{chunk.startMeasureIndex + 1}
                {chunk.endMeasureIndex > chunk.startMeasureIndex
                  ? `–${chunk.endMeasureIndex + 1}`
                  : ""}
              </span>
            ))
          )}
          {filteredChunks.length > previewChunks.length && (
            <span className="text-[11px] text-slate-500">
              +{filteredChunks.length - previewChunks.length} 块
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onStartQuickTriage && (
            <button
              type="button"
              data-testid="guided-quick-triage-btn"
              disabled={motorChunks.length === 0}
              onClick={onStartQuickTriage}
              className="min-h-[44px] min-w-[44px] rounded-lg border border-teal-500 bg-teal-50 px-3 py-2 text-xs font-semibold text-teal-900 hover:bg-teal-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              全曲快速分诊（1 遍体检）
            </button>
          )}
          <button
            type="button"
            data-testid="guided-start-session-btn"
            disabled={previewChunks.length === 0}
            onClick={onStartSession}
            className="min-h-[44px] min-w-[44px] rounded-lg bg-teal-600 px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            开始 {timeBoxMinutes} 分钟科学练琴（或按 C8 / 弹奏首音）
          </button>
        </div>
      </div>

      {sessionPlan && (
        <div
          data-testid="guided-session-plan-summary"
          className="mt-2 rounded-lg border border-teal-100 bg-teal-50/50 px-2.5 py-1.5 text-[11px] text-teal-900"
        >
          {sessionPlan.summaryText}
        </div>
      )}
    </section>
  );
}
