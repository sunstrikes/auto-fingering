import { useState } from "react";
import type { ScoreLayoutMode } from "../ScoreViewer";
import {
  getEhsVariantMeta,
  type EhsConfig,
  type EhsExtractedGeometry,
  type EhsFrameSnapshot,
  type EhsLookaheadPolicy,
  type EhsPeekMode,
  type EhsPerfMetrics,
  type EhsVariantKey,
} from "./ehsPrototypeTypes";

export interface EhsPrototypeControlsBarProps {
  variant: EhsVariantKey;
  config: EhsConfig;
  snapshot: EhsFrameSnapshot;
  geometry: EhsExtractedGeometry;
  perf: EhsPerfMetrics;
  layoutMode: ScoreLayoutMode;
  isPlaying: boolean;
  hasScore: boolean;
  totalScoreSec: number;
  previewScoreSec: number;
  midiConnectedCount: number;
  availableScores: string[];
  onChangeConfig: (patch: Partial<EhsConfig>) => void;
  onPreviewScoreSecChange: (sec: number) => void;
  onPeekDown: () => void;
  onPeekUp: () => void;
  onSimulateStall: () => void;
  onSimulateFluent: () => void;
  onQuickLoadScore?: (name: string) => void;
}

const LOOKAHEAD_OPTIONS: Array<{ id: EhsLookaheadPolicy; label: string }> = [
  { id: "fixed-0.5", label: "0.5拍" },
  { id: "fixed-1", label: "1拍" },
  { id: "fixed-2", label: "2拍" },
  { id: "fixed-bar", label: "1小节" },
  { id: "adaptive", label: "自适应" },
];

const PEEK_MODE_OPTIONS: Array<{ id: EhsPeekMode; label: string }> = [
  { id: "flash", label: "闪现1.5s" },
  { id: "hold", label: "按住透视" },
  { id: "auto-stall", label: "卡壳自动闪现" },
];

const GHOST_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: "全隐 0%" },
  { value: 0.06, label: "微透 6%" },
  { value: 0.18, label: "半透 18%" },
];

/**
 * Music-stand-friendly throwaway control strip & live state telemetry HUD for Issue #20.
 * Surfaces all relevant EHS state after every action and variant switch (Prototype Rule #5).
 */
export function EhsPrototypeControlsBar({
  variant,
  config,
  snapshot,
  geometry,
  perf,
  layoutMode,
  isPlaying,
  hasScore,
  totalScoreSec,
  previewScoreSec,
  midiConnectedCount,
  availableScores,
  onChangeConfig,
  onPreviewScoreSecChange,
  onPeekDown,
  onPeekUp,
  onSimulateStall,
  onSimulateFluent,
  onQuickLoadScore,
}: EhsPrototypeControlsBarProps) {
  const [showToolsDrawer, setShowToolsDrawer] = useState(false);
  const variantMeta = getEhsVariantMeta(variant);

  const trendArrow =
    snapshot.telemetry.trend === "expanding"
      ? "↑"
      : snapshot.telemetry.trend === "contracting"
        ? "↓"
        : "·";

  const peekBadge = snapshot.peek.active
    ? snapshot.peek.holding
      ? `透视按住中 (${snapshot.peek.reason ?? "manual"})`
      : `闪现回看 ${(snapshot.peek.remainingMs / 1000).toFixed(1)}s (${
          snapshot.peek.reason === "auto-stall"
            ? "卡壳自动"
            : snapshot.peek.reason === "b0-key"
              ? "B0琴键"
              : "F/触控"
        })`
    : config.enabled
      ? "遮罩生效中"
      : "已暂停对比原谱";

  return (
    <div
      data-testid="ehs-prototype-bar"
      className="mb-1.5 shrink-0 rounded-xl border border-amber-300/80 bg-gradient-to-r from-amber-50/90 via-white to-emerald-50/70 px-2.5 py-1.5 text-xs shadow-xs"
    >
      {/* Row 1: Primary controls for Decision Points 1, 2, 3 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-2 py-0.5 text-[11px] font-bold text-amber-300">
            <span>EHS 原型</span>
            <span className="text-emerald-300">{variantMeta.key}</span>
          </span>

          <button
            type="button"
            data-testid="ehs-toggle-enabled-btn"
            onClick={() => onChangeConfig({ enabled: !config.enabled })}
            className={`rounded-md border px-2 py-1 text-[11px] font-semibold transition ${
              config.enabled
                ? "border-emerald-400 bg-emerald-600 text-white hover:bg-emerald-700"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
            }`}
          >
            {config.enabled ? "遮罩：开" : "遮罩：暂停(原谱)"}
          </button>

          {/* Decision Point 2: Lookahead span policy */}
          <div
            className="inline-flex items-center rounded-md border border-slate-300 bg-slate-100 p-0.5 text-[11px]"
            role="group"
            aria-label="前瞻跨度策略"
          >
            <span className="px-1.5 text-[10px] font-semibold text-slate-500">前瞻</span>
            {LOOKAHEAD_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                data-testid={`ehs-lookahead-${opt.id}`}
                onClick={() => onChangeConfig({ lookaheadPolicy: opt.id })}
                className={`rounded px-1.5 py-0.5 font-medium transition ${
                  config.lookaheadPolicy === opt.id
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Decision Point 3: Peek recovery mode */}
          <div
            className="inline-flex items-center rounded-md border border-slate-300 bg-slate-100 p-0.5 text-[11px]"
            role="group"
            aria-label="出错回看机制"
          >
            <span className="px-1.5 text-[10px] font-semibold text-slate-500">回看</span>
            {PEEK_MODE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                data-testid={`ehs-peek-mode-${opt.id}`}
                onClick={() => onChangeConfig({ peekMode: opt.id })}
                className={`rounded px-1.5 py-0.5 font-medium transition ${
                  config.peekMode === opt.id
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Large music-stand touch target (>= 44px width/comfortable height) for B0 / F peek */}
          <button
            type="button"
            data-testid="ehs-peek-action-btn"
            onPointerDown={(e) => {
              e.preventDefault();
              onPeekDown();
            }}
            onPointerUp={onPeekUp}
            onPointerLeave={onPeekUp}
            className={`inline-flex min-h-[30px] items-center gap-1 rounded-lg border px-3 py-1 text-[11px] font-bold transition select-none ${
              snapshot.peek.active
                ? "border-amber-500 bg-amber-500 text-white shadow-sm"
                : "border-indigo-300 bg-indigo-50 text-indigo-800 hover:bg-indigo-100 active:scale-95"
            }`}
            title="电钢最低白键 B0 (MIDI 23) 或键盘 F 键随时闪现回看"
          >
            <span>👁</span>
            <span>{config.peekMode === "hold" ? "按住透视 (B0/F)" : "闪现回看 (B0/F)"}</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="ehs-mute-demo-btn"
            onClick={() => onChangeConfig({ muteDemoPiano: !config.muteDemoPiano })}
            className={`rounded-md border px-2 py-1 text-[11px] font-medium transition ${
              config.muteDemoPiano
                ? "border-sky-400 bg-sky-600 text-white"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
            title="上电钢琴实弹时开启：静音浏览器示范琴声，仅保留定速节拍器与前瞻遮罩"
          >
            {config.muteDemoPiano ? "🔇 仅节拍器(实弹)" : "🔊 含示范琴声"}
          </button>

          <button
            type="button"
            data-testid="ehs-debug-grid-btn"
            onClick={() => onChangeConfig({ showAlignmentDebug: !config.showAlignmentDebug })}
            className={`rounded-md border px-2 py-1 text-[11px] font-medium transition ${
              config.showAlignmentDebug
                ? "border-amber-400 bg-amber-100 text-amber-900"
                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
            }`}
            title="显示 OSMD 小节框、谱号边界与 staffEntry 拍点对齐锚点"
          >
            对齐网格
          </button>

          <button
            type="button"
            data-testid="ehs-sim-stall-btn"
            onClick={onSimulateStall}
            className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100"
            title="无电钢桌面测试：模拟视奏卡壳 (+340ms)，触发前瞻收缩与卡壳自动闪现"
          >
            !模拟卡壳
          </button>

          <button
            type="button"
            data-testid="ehs-tools-drawer-btn"
            onClick={() => setShowToolsDrawer((v) => !v)}
            className={`rounded-md border px-2 py-1 text-[11px] font-medium transition ${
              showToolsDrawer
                ? "border-slate-700 bg-slate-800 text-white"
                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {showToolsDrawer ? "收起调试 ▴" : "预览/调试 ▾"}
          </button>
        </div>
      </div>

      {/* Compact single-line live state telemetry strip (always visible per Prototype Rule #5) */}
      <div
        data-testid="ehs-state-telemetry"
        className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md bg-slate-900/95 px-2.5 py-0.5 font-mono text-[10px] text-slate-200"
      >
        <span className="font-sans font-semibold text-amber-300">{variantMeta.shortName}</span>
        <span>
          <span className="text-indigo-300">手位:</span> M{snapshot.handMeasureIndex + 1}·B
          {(snapshot.handBeatInMeasure + 1).toFixed(1)}
        </span>
        <span>
          <span className="text-emerald-300">前沿:</span> M{snapshot.frontierMeasureIndex + 1} (+
          {snapshot.effectiveLookaheadBeats.toFixed(2)}拍
          {config.lookaheadPolicy === "adaptive" ? ` ${trendArrow}` : ""})
        </span>
        <span>
          <span className="text-amber-300">回看:</span> {peekBadge}
        </span>
        <span>
          <span className="text-sky-300">MIDI({midiConnectedCount > 0 ? "电钢" : "模拟"}):</span>{" "}
          {snapshot.telemetry.matchedSteps}/{snapshot.telemetry.missedSteps}
          {snapshot.telemetry.lastLagMs !== null
            ? ` ${snapshot.telemetry.lastLagMs >= 0 ? "+" : ""}${snapshot.telemetry.lastLagMs}ms`
            : ""}
        </span>
        <span>
          <span className="text-violet-300">OSMD({layoutMode === "horizontal" ? "卷轴" : "分页"}):</span>{" "}
          {geometry.measures.length}小节/{geometry.systems.length}行/{geometry.notes.length}音符 ·
          抽{geometry.extractMs.toFixed(1)}ms · 帧{perf.avgUpdateMs.toFixed(2)}ms · {perf.fps}fps
        </span>
        <span className="ml-auto text-slate-400">{snapshot.telemetry.lastEventLabel}</span>
      </div>

      {/* Quick score load hint when empty */}
      {!hasScore && availableScores.length > 0 && onQuickLoadScore && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50/70 px-2 py-1 text-[11px] text-blue-900">
          <span className="font-semibold">快速加载已有乐谱试弹：</span>
          {availableScores.slice(0, 4).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onQuickLoadScore(name)}
              className="rounded border border-blue-300 bg-white px-2 py-0.5 font-medium text-blue-800 hover:bg-blue-100"
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {/* Expandable tuning drawer: hypothesis, ghost opacity, static preview scrubber, fluent simulator */}
      {showToolsDrawer && (
        <div className="mt-1.5 flex flex-col gap-1.5 border-t border-amber-200/70 pt-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <span className="max-w-[36rem] text-slate-600">
              <strong className="text-slate-800">{variantMeta.title}：</strong>
              {variantMeta.hypothesis}
            </span>

            <div className="flex flex-wrap items-center gap-1.5">
              <div className="inline-flex items-center rounded border border-slate-200 bg-white p-0.5 text-[10px]">
                <span className="px-1 text-slate-400">遮罩残影</span>
                {GHOST_OPTIONS.map((g) => (
                  <button
                    key={g.value}
                    type="button"
                    onClick={() => onChangeConfig({ ghostResidualOpacity: g.value })}
                    className={`rounded px-1.5 py-0.5 font-medium ${
                      Math.abs(config.ghostResidualOpacity - g.value) < 0.01
                        ? "bg-slate-900 text-white"
                        : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {g.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                data-testid="ehs-sim-fluent-btn"
                onClick={onSimulateFluent}
                className="rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 hover:bg-emerald-100"
                title="无电钢桌面测试：模拟流畅命中 (+45ms)，观察自适应前瞻扩张"
              >
                +模拟流畅
              </button>
            </div>
          </div>

          {hasScore && !isPlaying && totalScoreSec > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white/80 px-2 py-1 text-[11px]">
              <span className="shrink-0 font-semibold text-slate-700">
                静态预览游标（拖动对比 A/B/C 与跨行效果）
              </span>
              <input
                type="range"
                data-testid="ehs-preview-scrubber"
                min={0}
                max={Math.max(1, totalScoreSec)}
                step={0.05}
                value={Math.min(previewScoreSec, totalScoreSec)}
                onChange={(e) => onPreviewScoreSecChange(Number(e.target.value))}
                className="h-1.5 flex-1 cursor-pointer accent-emerald-600"
              />
              <span className="shrink-0 font-mono text-[10px] text-slate-500">
                {previewScoreSec.toFixed(1)}s / {totalScoreSec.toFixed(1)}s
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
