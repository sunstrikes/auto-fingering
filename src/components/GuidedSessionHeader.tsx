import type { MotorChunk } from "../chunking/types";
import type { PracticeMode } from "../domain/types";
import type { GuidedSessionPhase } from "../guided/pianoCommandKeys";
import type { MidiConnectionState } from "../midi/webMidi";
import { formatMidiStatusLabel, getMidiStatusBadgeClass } from "./PracticeSettingsModal";

export interface GuidedSessionHeaderProps {
  pieceTitle: string;
  sessionPhase: GuidedSessionPhase;
  activeChunk: MotorChunk | null;
  queueIndex: number;
  queueLength: number;
  timeBoxMinutes: number;
  remainingMinutes: number;
  effectivePracticeMode: PracticeMode;
  isSingleStaff: boolean;
  midiState: MidiConnectionState;
  onChangePracticeMode: (mode: PracticeMode) => void;
  onSuspendForFingering: () => void;
  onEndSession: () => void;
  onOpenSettings: () => void;
}

const PHASE_LABELS: Record<GuidedSessionPhase, string> = {
  idle: "空闲",
  launch: "准备开练",
  stage0: "Stage 0 · Waiting Mode 落键",
  playing: "定速连贯演奏",
  "micro-rest": "Micro-Rest · 清醒微休息",
  audiation: "Audiation · 待命预演",
  "macro-rest": "Macro-Rest",
  paused: "已暂停",
  suspended: "已挂起",
  summary: "本轮小结",
};

/**
 * Slim in-session header strip for Guided Session: collapses heavy editing chrome
 * while retaining orthogonal PracticeMode switching, Suspend-for-Fingering, and End Session.
 */
export function GuidedSessionHeader({
  pieceTitle,
  sessionPhase,
  activeChunk,
  queueIndex,
  queueLength,
  timeBoxMinutes,
  remainingMinutes,
  effectivePracticeMode,
  isSingleStaff,
  midiState,
  onChangePracticeMode,
  onSuspendForFingering,
  onEndSession,
  onOpenSettings,
}: GuidedSessionHeaderProps) {
  const isPracticing = sessionPhase !== "launch" && sessionPhase !== "idle";

  return (
    <header
      data-testid="guided-session-header"
      data-session-phase={sessionPhase}
      className="shrink-0 border-b border-teal-200 bg-teal-50/60 px-3 py-1 sm:px-4"
    >
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            data-testid="studio-mode-badge"
            className="rounded-full bg-teal-700 px-2 py-0.5 text-[11px] font-semibold text-white"
          >
            Guided Session
          </span>
          <span className="text-xs font-semibold text-slate-900">
            {pieceTitle || "当前乐谱"}
          </span>
          <span
            data-testid="guided-phase-badge"
            className="rounded-md border border-teal-300 bg-white px-2 py-0.5 text-[11px] font-medium text-teal-900"
          >
            {PHASE_LABELS[sessionPhase]}
          </span>
          {isPracticing && activeChunk && (
            <span
              data-testid="guided-active-chunk-label"
              className="rounded-md bg-white/90 px-2 py-0.5 text-[11px] font-medium text-slate-700"
            >
              块 {queueIndex + 1}/{Math.max(1, queueLength)} · m.{activeChunk.startMeasureIndex + 1}
              {activeChunk.endMeasureIndex > activeChunk.startMeasureIndex
                ? `–${activeChunk.endMeasureIndex + 1}`
                : ""}
            </span>
          )}
          <span className="text-[11px] text-slate-600">
            目标 {timeBoxMinutes} min · 剩余 {Math.max(0, remainingMinutes)} min
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {/* Orthogonal Practice Mode selector */}
          <div
            data-testid="practice-mode-selector"
            className="inline-flex shrink-0 rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-medium"
            role="group"
            aria-label="练习模式"
          >
            {(
              [
                { mode: "both" as const, label: "双手" },
                { mode: "rh-only" as const, label: "仅右手" },
                { mode: "lh-only" as const, label: "仅左手" },
              ] as const
            ).map(({ mode, label }) => {
              const isActive = effectivePracticeMode === mode;
              const isLockedOut = isSingleStaff && !isActive;
              return (
                <button
                  key={mode}
                  type="button"
                  data-testid={`practice-mode-${mode}`}
                  aria-pressed={isActive}
                  disabled={isLockedOut}
                  onClick={() => onChangePracticeMode(mode)}
                  className={`whitespace-nowrap rounded-md px-2 py-1 transition ${
                    isActive
                      ? "bg-teal-600 text-white shadow-xs"
                      : "text-slate-600 hover:text-slate-900"
                  } disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {isPracticing && (
            <button
              type="button"
              data-testid="guided-suspend-btn"
              onClick={onSuspendForFingering}
              className="min-h-[44px] min-w-[44px] whitespace-nowrap rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100"
            >
              暂离调指法
            </button>
          )}

          <button
            type="button"
            data-testid="guided-end-session-btn"
            onClick={onEndSession}
            className="min-h-[44px] min-w-[44px] whitespace-nowrap rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            结束本次会话
          </button>

          <button
            type="button"
            data-testid="header-midi-status-btn"
            title={`${formatMidiStatusLabel(midiState)} · 设置`}
            onClick={onOpenSettings}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1 text-xs font-medium transition hover:opacity-90 ${getMidiStatusBadgeClass(midiState)}`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                midiState.status === "connected"
                  ? "bg-emerald-500"
                  : midiState.status === "no-devices" || midiState.status === "requesting"
                    ? "bg-amber-500"
                    : midiState.status === "denied" || midiState.status === "error"
                      ? "bg-red-500"
                      : "bg-slate-400"
              }`}
            />
            <span className="hidden xl:inline">{formatMidiStatusLabel(midiState)} · </span>
            <span>设置</span>
          </button>
        </div>
      </div>
    </header>
  );
}

export interface GuidedResumePillProps {
  remainingMinutes: number;
  queueIndex: number;
  queueLength: number;
  onResume: () => void;
  onEndSession: () => void;
}

/**
 * Persistent Free Studio header pill shown whenever a Guided Session is suspended for Finger Anchor edits.
 */
export function GuidedResumePill({
  remainingMinutes,
  queueIndex,
  queueLength,
  onResume,
  onEndSession,
}: GuidedResumePillProps) {
  return (
    <div
      data-testid="guided-resume-banner"
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-teal-400 bg-teal-50 px-1.5 py-0.5 text-xs"
    >
      <button
        type="button"
        data-testid="guided-resume-pill"
        onClick={onResume}
        className="min-h-[36px] rounded-full bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-teal-700"
      >
        恢复科学练琴 · 块 {queueIndex + 1}/{Math.max(1, queueLength)} · 剩 {Math.max(0, remainingMinutes)} min
      </button>
      <button
        type="button"
        data-testid="guided-end-suspended-btn"
        onClick={onEndSession}
        className="rounded-full px-2 py-1 text-[11px] font-medium text-teal-900 hover:bg-teal-100"
      >
        结束本次会话
      </button>
    </div>
  );
}
