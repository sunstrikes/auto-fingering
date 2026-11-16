import { useMemo } from "react";
import type { ScoreDocument, SolveResult, TransitionCue } from "../domain/types";
import { isBlackKey } from "../solver/keyboard";
import {
  midiToNoteName,
  projectDualTrackState,
  whiteKeyIndexToMidi,
  type HandTrackState,
  type HeldFingerBadge,
  type KeyFingerBadge,
} from "./dualTrackModel";

export interface DualTrackKeyboardProps {
  scoreDoc: ScoreDocument | null;
  solveResult: SolveResult | null;
  selectedSliceId: string | null;
  onSelectSlice?: (sliceId: string) => void;
}

const WHITE_KEY_W = 28;
const WHITE_KEY_H = 74;
const BLACK_KEY_W = 18;
const BLACK_KEY_H = 46;

const LAYER_CUE_TEXT_Y = 14;
const LAYER_CUE_ARC_BASE_Y = 40;
const LAYER_CUE_ARC_PEAK_Y = 22;
const LAYER_POS_Y = 48;
const LAYER_POS_H = 20;
const LAYER_POS_TEXT_Y = 62;
const LAYER_KEYS_Y = 74;
const OCTAVE_LABEL_Y = LAYER_KEYS_Y + WHITE_KEY_H + 13;
const TOTAL_SVG_H = OCTAVE_LABEL_Y + 6;

function cueColor(severity: TransitionCue["severity"]): { stroke: string; bg: string } {
  if (severity === "danger") return { stroke: "#dc2626", bg: "#fee2e2" };
  if (severity === "warn") return { stroke: "#d97706", bg: "#fef3c7" };
  return { stroke: "#2563eb", bg: "#eff6ff" };
}

interface KeyDisplayInfo {
  state: "active" | "held";
  finger: number | undefined;
}

function KeyboardTrackStrip({ track }: { track: HandTrackState }) {
  const isRh = track.hand === "RH";
  const handLabel = isRh ? "Right Hand" : "Left Hand";
  const handColor = isRh ? "#0f766e" : "#4338ca";
  const handActiveKeyFill = isRh ? "#99f6e4" : "#c7d2fe";
  const handPosBg = isRh ? "rgba(15,118,110,0.12)" : "rgba(67,56,202,0.12)";

  const whiteMidis: number[] = [];
  const whiteXByMidi = new Map<number, number>();
  for (let m = track.startMidi; m <= track.endMidi; m++) {
    if (!isBlackKey(m)) {
      whiteXByMidi.set(m, whiteMidis.length * WHITE_KEY_W);
      whiteMidis.push(m);
    }
  }
  const totalW = Math.max(WHITE_KEY_W, whiteMidis.length * WHITE_KEY_W);

  const keyCenterX = (midi: number): number => {
    const clamped = Math.max(track.startMidi, Math.min(track.endMidi, midi));
    if (!isBlackKey(clamped)) {
      return (whiteXByMidi.get(clamped) ?? 0) + WHITE_KEY_W / 2;
    }
    const leftWhiteX = whiteXByMidi.get(clamped - 1);
    if (leftWhiteX !== undefined) {
      return leftWhiteX + WHITE_KEY_W;
    }
    return 0;
  };

  const keyStateMap = new Map<number, KeyDisplayInfo>();
  for (const held of track.heldFingers as HeldFingerBadge[]) {
    keyStateMap.set(held.midi, { state: "held", finger: held.finger });
  }
  for (const active of track.activeKeys as KeyFingerBadge[]) {
    keyStateMap.set(active.midi, { state: "active", finger: active.finger });
  }

  const primaryCue = track.transitionCues[0] ?? null;
  const secondaryCues = track.transitionCues.slice(1);
  const posLowMidi = track.handPosition
    ? whiteKeyIndexToMidi(Math.min(track.handPosition.thumbKey, track.handPosition.pinkyKey))
    : null;
  const posHighMidi = track.handPosition
    ? whiteKeyIndexToMidi(Math.max(track.handPosition.thumbKey, track.handPosition.pinkyKey))
    : null;

  return (
    <div
      data-testid={`keyboard-track-${track.hand}`}
      aria-label={`${handLabel} keyboard track`}
      className="rounded-lg border border-slate-200 bg-slate-50/70 p-2.5"
    >
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center rounded-full px-2.5 py-0.5 font-semibold"
            style={{
              backgroundColor: isRh ? "#ccfbf1" : "#e0e7ff",
              color: handColor,
            }}
          >
            {handLabel}
          </span>
          {posLowMidi !== null && posHighMidi !== null ? (
            <span className="text-slate-600">
              Hand Position: {midiToNoteName(posLowMidi)}–{midiToNoteName(posHighMidi)}
            </span>
          ) : (
            <span className="text-slate-400">Resting</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {secondaryCues.map((arc, idx) => {
            const colors = cueColor(arc.cue.severity);
            return (
              <span
                key={`${arc.cue.type}-${idx}`}
                className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{ backgroundColor: colors.bg, color: colors.stroke }}
              >
                {arc.cue.label}
              </span>
            );
          })}
          {track.heldFingers.length > 0 && (
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] text-slate-700">
              Held: {track.heldFingers.length}
            </span>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <svg
          width={totalW}
          height={TOTAL_SVG_H}
          viewBox={`0 0 ${totalW} ${TOTAL_SVG_H}`}
          className="block select-none"
        >
          {/* Layer 1 (Top): Transition Cue directional arc & label */}
          <g data-layer="transition-cue">
            {primaryCue && (() => {
              const colors = cueColor(primaryCue.cue.severity);
              const fromX = keyCenterX(primaryCue.fromMidi);
              const toX = keyCenterX(primaryCue.toMidi);
              const midX = (fromX + toX) / 2;
              const labelText = primaryCue.cue.label;
              const pillW = Math.min(totalW - 8, Math.max(76, labelText.length * 6.8 + 16));
              const pillCenterX = Math.max(pillW / 2 + 4, Math.min(totalW - pillW / 2 - 4, midX));
              const markerId = `cue-arrow-${track.hand}-${primaryCue.cue.severity}`;

              return (
                <>
                  <defs>
                    <marker
                      id={markerId}
                      markerWidth="6"
                      markerHeight="6"
                      refX="4"
                      refY="3"
                      orient="auto"
                    >
                      <path d="M0,0 L6,3 L0,6 Z" fill={colors.stroke} />
                    </marker>
                  </defs>
                  <rect
                    x={pillCenterX - pillW / 2}
                    y={2}
                    width={pillW}
                    height={17}
                    rx={8.5}
                    fill={colors.bg}
                    stroke={colors.stroke}
                    strokeWidth={1}
                  />
                  <text
                    x={pillCenterX}
                    y={LAYER_CUE_TEXT_Y}
                    textAnchor="middle"
                    fontSize={10.5}
                    fontWeight={700}
                    fill={colors.stroke}
                  >
                    {labelText}
                  </text>
                  {Math.abs(toX - fromX) < 4 ? (
                    <path
                      d={`M ${toX} ${LAYER_CUE_ARC_PEAK_Y} L ${toX} ${LAYER_CUE_ARC_BASE_Y}`}
                      fill="none"
                      stroke={colors.stroke}
                      strokeWidth={2}
                      markerEnd={`url(#${markerId})`}
                    />
                  ) : (
                    <path
                      d={`M ${fromX} ${LAYER_CUE_ARC_BASE_Y} Q ${midX} ${LAYER_CUE_ARC_PEAK_Y} ${toX} ${LAYER_CUE_ARC_BASE_Y}`}
                      fill="none"
                      stroke={colors.stroke}
                      strokeWidth={2}
                      markerEnd={`url(#${markerId})`}
                    />
                  )}
                </>
              );
            })()}
          </g>

          {/* Layer 2 (Middle): Smoothed Hand Position five-finger resting bracket */}
          <g data-layer="hand-position">
            {posLowMidi !== null && posHighMidi !== null && (() => {
              const rawX1 = (whiteXByMidi.get(Math.max(track.startMidi, posLowMidi)) ?? 0) + 1;
              const rawX2 =
                (whiteXByMidi.get(Math.min(track.endMidi, posHighMidi)) ?? totalW - WHITE_KEY_W) +
                WHITE_KEY_W -
                2;
              const x1 = Math.max(2, Math.min(totalW - 26, rawX1));
              const w = Math.max(24, Math.min(totalW - x1 - 2, rawX2 - x1));
              const textX = Math.max(46, Math.min(totalW - 46, x1 + w / 2));
              const label =
                w >= 120
                  ? `${midiToNoteName(posLowMidi)}–${midiToNoteName(posHighMidi)} (1–5)`
                  : `${midiToNoteName(posLowMidi)}–${midiToNoteName(posHighMidi)}`;

              return (
                <>
                  <rect
                    x={x1}
                    y={LAYER_POS_Y}
                    width={w}
                    height={LAYER_POS_H}
                    rx={5}
                    fill={handPosBg}
                    stroke={handColor}
                    strokeWidth={1.5}
                    strokeDasharray="4,2"
                  />
                  <text
                    x={textX}
                    y={LAYER_POS_TEXT_Y}
                    textAnchor="middle"
                    fontSize={10.5}
                    fontWeight={700}
                    fill={handColor}
                  >
                    {label}
                  </text>
                </>
              );
            })()}
          </g>

          {/* Layer 3 (Bottom): Piano keycaps with active 1-5 & dimmed HeldFinger sustain badges */}
          <g data-layer="keyboard-keys">
            {whiteMidis.map((midi) => {
              const x = whiteXByMidi.get(midi)!;
              const info = keyStateMap.get(midi);
              const fill = info
                ? info.state === "held"
                  ? "#e2e8f0"
                  : handActiveKeyFill
                : "#ffffff";

              return (
                <g
                  key={midi}
                  data-midi={midi}
                  data-key-state={info?.state ?? "idle"}
                >
                  <rect
                    x={x}
                    y={LAYER_KEYS_Y}
                    width={WHITE_KEY_W - 1}
                    height={WHITE_KEY_H}
                    rx={3}
                    fill={fill}
                    stroke="#94a3b8"
                    strokeWidth={1}
                  />
                  {midi % 12 === 0 && (
                    <text
                      x={x + WHITE_KEY_W / 2}
                      y={OCTAVE_LABEL_Y}
                      textAnchor="middle"
                      fontSize={10}
                      fill="#64748b"
                    >
                      {midiToNoteName(midi)}
                    </text>
                  )}
                  {info && (
                    <g opacity={info.state === "held" ? 0.72 : 1}>
                      <circle
                        cx={x + WHITE_KEY_W / 2}
                        cy={LAYER_KEYS_Y + WHITE_KEY_H - 16}
                        r={10}
                        fill={info.state === "held" ? "#64748b" : handColor}
                        stroke={info.state === "held" ? "#cbd5e1" : "none"}
                        strokeDasharray={info.state === "held" ? "2,2" : undefined}
                        strokeWidth={info.state === "held" ? 1.5 : 0}
                      />
                      <text
                        x={x + WHITE_KEY_W / 2}
                        y={LAYER_KEYS_Y + WHITE_KEY_H - 12}
                        textAnchor="middle"
                        fontSize={11}
                        fontWeight={700}
                        fill="#ffffff"
                      >
                        {info.finger ?? "?"}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}

            {Array.from({ length: track.endMidi - track.startMidi + 1 }, (_, i) => track.startMidi + i)
              .filter((midi) => isBlackKey(midi))
              .map((midi) => {
                const leftWhiteX = whiteXByMidi.get(midi - 1);
                if (leftWhiteX === undefined) return null;
                const x = leftWhiteX + WHITE_KEY_W - BLACK_KEY_W / 2;
                const info = keyStateMap.get(midi);
                const fill = info
                  ? info.state === "held"
                    ? "#475569"
                    : handColor
                  : "#1e293b";

                return (
                  <g
                    key={midi}
                    data-midi={midi}
                    data-key-state={info?.state ?? "idle"}
                  >
                    <rect
                      x={x}
                      y={LAYER_KEYS_Y}
                      width={BLACK_KEY_W}
                      height={BLACK_KEY_H}
                      rx={3}
                      fill={fill}
                      stroke="#0f172a"
                      strokeWidth={1}
                    />
                    {info && (
                      <g opacity={info.state === "held" ? 0.78 : 1}>
                        <circle
                          cx={x + BLACK_KEY_W / 2}
                          cy={LAYER_KEYS_Y + BLACK_KEY_H - 12}
                          r={8}
                          fill={info.state === "held" ? "#cbd5e1" : "#ffffff"}
                        />
                        <text
                          x={x + BLACK_KEY_W / 2}
                          y={LAYER_KEYS_Y + BLACK_KEY_H - 8.5}
                          textAnchor="middle"
                          fontSize={10}
                          fontWeight={800}
                          fill={info.state === "held" ? "#334155" : handColor}
                        >
                          {info.finger ?? "?"}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
          </g>
        </svg>
      </div>
    </div>
  );
}

/**
 * Bottom dock rendering separated upper Right Hand and lower Left Hand keyboard tracks
 * with three non-overlapping layers (TransitionCue, HandPosition, active & HeldFinger keys).
 */
export function DualTrackKeyboard({
  scoreDoc,
  solveResult,
  selectedSliceId,
  onSelectSlice,
}: DualTrackKeyboardProps) {
  const projected = useMemo(
    () => projectDualTrackState(scoreDoc, solveResult, selectedSliceId),
    [scoreDoc, solveResult, selectedSliceId]
  );

  const slices = scoreDoc?.onsetSlices ?? [];
  const prevSliceId =
    projected.selectedIndex > 0 ? slices[projected.selectedIndex - 1]?.sliceId ?? null : null;
  const nextSliceId =
    projected.selectedIndex >= 0 && projected.selectedIndex < slices.length - 1
      ? slices[projected.selectedIndex + 1]?.sliceId ?? null
      : null;

  return (
    <section
      data-testid="dual-track-keyboard"
      aria-label="Dual-track piano keyboard"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Dual-Track Keyboard</h2>
          {projected.selectedSlice ? (
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
              Measure {projected.selectedSlice.measureIndex + 1} · {projected.selectedSlice.hand} · Slice{" "}
              {projected.selectedIndex + 1} / {projected.totalSlices}
            </span>
          ) : (
            <span className="text-xs text-slate-500">
              Load a score to preview Right Hand and Left Hand tracks
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="hidden items-center gap-3 text-[11px] text-slate-500 sm:flex">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-teal-700" />
              RH 1–5
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-indigo-700" />
              LH 1–5
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-slate-500 opacity-75" />
              Held Finger
            </span>
          </div>

          <div className="inline-flex items-center gap-1.5">
            <button
              type="button"
              disabled={!prevSliceId || !onSelectSlice}
              onClick={() => prevSliceId && onSelectSlice?.(prevSliceId)}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Prev slice
            </button>
            <button
              type="button"
              disabled={!nextSliceId || !onSelectSlice}
              onClick={() => nextSliceId && onSelectSlice?.(nextSliceId)}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Next slice
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <KeyboardTrackStrip track={projected.rh} />
        <KeyboardTrackStrip track={projected.lh} />
      </div>
    </section>
  );
}
