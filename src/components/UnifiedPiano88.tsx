import { useEffect, useMemo, useRef, useState } from "react";
import type { PlaybackFrame } from "../audio/playbackEngine";
import {
  DEFAULT_HAND_SPAN_PROFILE,
  type Finger,
  type Hand,
  type HandSpanProfile,
  type PracticeMode,
  type ScoreDocument,
  type SolveResult,
  type TransitionCue,
} from "../domain/types";
import { isBlackKey, midiToPitchLabel } from "../solver/keyboard";
import { whiteKeyIndexToMidi } from "./dualTrackModel";
import {
  PIANO_MAX_MIDI,
  PIANO_MIN_MIDI,
  PIANO_WHITE_KEY_COUNT,
  buildHandPostureIndex,
  computeDualHandPostureFrameAtTime,
  midiToWhiteUnitX,
  projectDualHandPostureAtSlice,
  type DualHandPostureFrame,
  type FingerPosture,
  type HandPosture,
} from "./handPostureModel";

import {
  PIANO_BLACK_KEY_H,
  PIANO_BLACK_KEY_W,
  PIANO_KEYBED_BOTTOM_Y,
  PIANO_KEYS_Y,
  PIANO_SVG_H,
  PIANO_WHITE_KEY_H,
  PIANO_WHITE_KEY_W,
  computeHandSkeleton,
} from "./handSkeleton";

export interface UnifiedPiano88Props {
  scoreDoc: ScoreDocument | null;
  solveResult: SolveResult | null;
  selectedSliceId: string | null;
  handSpanProfile?: HandSpanProfile;
  playbackFrame?: PlaybackFrame | null;
  practiceMode?: PracticeMode;
  showOverhead?: boolean;
  showFullPalm?: boolean;
  wrongMidis?: ReadonlySet<number>;
  hitMidis?: ReadonlySet<number>;
  pressedMidis?: ReadonlySet<number>;
  sustainPedalPressed?: boolean;
  onSelectSlice?: (sliceId: string) => void;
  onAuditionMidi?: (midi: number) => void;
  onVirtualNoteOn?: (midi: number, velocity?: number) => void;
  onVirtualNoteOff?: (midi: number) => void;
}

const WHITE_KEY_W = PIANO_WHITE_KEY_W;
const WHITE_KEY_H = PIANO_WHITE_KEY_H;
const BLACK_KEY_W = PIANO_BLACK_KEY_W;
const BLACK_KEY_H = PIANO_BLACK_KEY_H;
const SVG_W = PIANO_WHITE_KEY_COUNT * WHITE_KEY_W; // 1248

const RH_LANE_Y = 6;
const LH_LANE_Y = 25;
const FALLBOARD_Y = 46;
const KEYS_Y = PIANO_KEYS_Y;
const SVG_BOTTOM_Y = PIANO_KEYBED_BOTTOM_Y + 2;

const FINGERS: Finger[] = [1, 2, 3, 4, 5];

function cueColors(severity: TransitionCue["severity"]): { stroke: string; bg: string } {
  if (severity === "danger") return { stroke: "#dc2626", bg: "#fee2e2" };
  if (severity === "warn") return { stroke: "#d97706", bg: "#fef3c7" };
  return { stroke: "#2563eb", bg: "#eff6ff" };
}

function handPalette(hand: Hand) {
  if (hand === "RH") {
    return {
      label: "Right Hand",
      primary: "#0f766e",
      activeFill: "#2dd4bf",
      heldFill: "#99f6e4",
      palmGradId: "palm-grad-RH",
      strokeGradId: "hand-stroke-RH",
      fingerPressedGradId: "finger-pressed-RH",
      shadowFill: "rgba(15, 118, 110, 0.12)",
      palmFill: "rgba(20, 184, 166, 0.22)",
      fingerFill: "rgba(20, 184, 166, 0.16)",
      pressedFill: "rgba(13, 148, 136, 0.32)",
      stroke: "#0f766e",
      badgeBg: "#ccfbf1",
      posBg: "rgba(15, 118, 110, 0.16)",
    };
  }
  return {
    label: "Left Hand",
    primary: "#4338ca",
    activeFill: "#818cf8",
    heldFill: "#c7d2fe",
    palmGradId: "palm-grad-LH",
    strokeGradId: "hand-stroke-LH",
    fingerPressedGradId: "finger-pressed-LH",
    shadowFill: "rgba(67, 56, 202, 0.12)",
    palmFill: "rgba(99, 102, 241, 0.20)",
    fingerFill: "rgba(99, 102, 241, 0.15)",
    pressedFill: "rgba(79, 70, 229, 0.30)",
    stroke: "#4338ca",
    badgeBg: "#e0e7ff",
    posBg: "rgba(67, 56, 202, 0.16)",
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function tweenHandPosture(from: HandPosture, to: HandPosture, t: number): HandPosture {
  const fingers = {} as Record<Finger, FingerPosture>;
  for (const f of FINGERS) {
    const a = from.fingers[f];
    const b = to.fingers[f];
    fingers[f] = {
      ...b,
      xUnit: lerp(a.xUnit, b.xUnit, t),
    };
  }
  return {
    ...to,
    palmCenterXUnit: lerp(from.palmCenterXUnit, to.palmCenterXUnit, t),
    palmLiftY: lerp(from.palmLiftY, to.palmLiftY, t),
    palmAngleDeg: lerp(from.palmAngleDeg, to.palmAngleDeg, t),
    fingers,
  };
}

function HandVectorOverlay({
  posture,
  dimmed = false,
}: {
  posture: HandPosture;
  dimmed?: boolean;
}) {
  const pal = handPalette(posture.hand);
  const skeleton = computeHandSkeleton(posture);
  const baseOpacity = posture.isResting ? 0.58 : 0.95;
  const opacity = dimmed ? 0.22 : baseOpacity;
  const scale = skeleton.handScale;

  // Partition fingers so thumb-under (-1) draws behind the unified hand silhouette,
  // normal (0) integrates seamlessly into the silhouette, and cross-over (+1) floats above.
  const underFingers = FINGERS.filter((f) => posture.fingers[f].layerOffset === -1);
  const foregroundFingers = FINGERS.filter((f) => posture.fingers[f].layerOffset !== -1).sort(
    (a, b) => {
      const la = posture.fingers[a].layerOffset;
      const lb = posture.fingers[b].layerOffset;
      if (la !== lb) return la - lb;
      return a - b;
    }
  );

  const renderFingerNode = (f: Finger) => {
    const fp = posture.fingers[f];
    const sk = skeleton.fingers[f];
    const pressed = fp.pressDepth > 0.15;
    const isThumbUnder = fp.layerOffset === -1;
    const isCrossOver = fp.layerOffset === 1;
    const showStandaloneSleeve = isThumbUnder || isCrossOver;

    const badgeR = (pressed ? 6.4 : 4.8) * clampBadgeScale(scale);
    const haloR = 8.8 * clampBadgeScale(scale);

    return (
      <g
        key={f}
        data-testid={`hand-${posture.hand}-finger-${f}`}
        data-press-depth={fp.pressDepth.toFixed(2)}
        data-held={fp.isHeld ? "true" : "false"}
        data-layer-offset={String(fp.layerOffset)}
      >
        {isCrossOver && (
          <path
            d={sk.sleevePath}
            transform="translate(0, 2)"
            fill={pal.shadowFill}
            stroke="none"
          />
        )}

        {showStandaloneSleeve ? (
          <path
            d={sk.sleevePath}
            fill={pressed ? `url(#${pal.fingerPressedGradId})` : pal.fingerFill}
            stroke={fp.isRepairedAnchor ? "#dc2626" : pal.stroke}
            strokeWidth={pressed ? 1.15 : 0.85}
            strokeOpacity={isThumbUnder ? 0.52 : pressed ? 0.72 : 0.5}
            strokeDasharray={isThumbUnder ? "3,2" : undefined}
          />
        ) : (
          (pressed || fp.isRepairedAnchor) && (
            <path
              d={sk.sleevePath}
              fill={pressed ? `url(#${pal.fingerPressedGradId})` : "none"}
              stroke={fp.isRepairedAnchor ? "#dc2626" : "none"}
              strokeWidth={fp.isRepairedAnchor ? 1.1 : 0}
              strokeOpacity={fp.isRepairedAnchor ? 0.78 : 0}
            />
          )
        )}

        {/* Delicate anatomical skin creases & knuckle shading */}
        {sk.joints.map((joint, idx) => (
          <path
            key={idx}
            d={joint.creasePath}
            fill="none"
            stroke={fp.isRepairedAnchor ? "#dc2626" : pal.stroke}
            strokeWidth={joint.kind === "mcp" ? 1.0 : 0.8}
            strokeOpacity={joint.kind === "mcp" ? 0.2 : 0.25}
            strokeLinecap="round"
            data-joint-kind={joint.kind}
          />
        ))}

        {/* Pressed contact halo */}
        {pressed && (
          <circle
            cx={sk.tip.x}
            cy={sk.tip.y}
            r={haloR}
            fill="none"
            stroke={fp.isHeld ? pal.primary : "#ffffff"}
            strokeWidth={1.4}
            opacity={0.78}
          />
        )}

        {/* Fingertip digit badge */}
        <circle
          cx={sk.tip.x}
          cy={sk.tip.y}
          r={badgeR}
          fill={pressed ? pal.primary : "#ffffff"}
          fillOpacity={pressed ? 0.94 : 0.82}
          stroke={fp.isRepairedAnchor ? "#dc2626" : pal.stroke}
          strokeWidth={pressed ? 1.05 : 0.8}
          strokeOpacity={pressed ? 0.95 : 0.55}
        />
        <text
          x={sk.tip.x}
          y={sk.tip.y + (pressed ? 3.0 : 2.5) * clampBadgeScale(scale)}
          textAnchor="middle"
          fontSize={(pressed ? 8.6 : 7.0) * clampBadgeScale(scale)}
          fontWeight={700}
          fill={pressed ? "#ffffff" : pal.stroke}
          opacity={pressed ? 1 : 0.82}
        >
          {f}
        </text>
      </g>
    );
  };

  return (
    <g
      data-testid={`hand-overlay-${posture.hand}`}
      data-crossing-style={posture.crossingStyle}
      data-resting={posture.isResting ? "true" : "false"}
      data-dimmed={dimmed ? "true" : "false"}
      opacity={opacity}
      className="pointer-events-none"
    >
      {/* Thumb-under finger layer renders beneath the palm */}
      {underFingers.map(renderFingerNode)}

      {/* Subtle hover shadow beneath unified hand silhouette */}
      <path
        d={skeleton.unifiedHandPath}
        transform="translate(0, 2.5)"
        fill={pal.shadowFill}
        stroke="none"
      />

      {/* Unified organic translucent hand silhouette with interdigital webbing */}
      <path
        data-testid={`hand-silhouette-${posture.hand}`}
        d={skeleton.unifiedHandPath}
        fill={`url(#${pal.palmGradId})`}
        stroke={`url(#${pal.strokeGradId})`}
        strokeWidth={1.15}
        strokeLinejoin="round"
      />

      {/* Subtle dorsal palm & tendon surface accents */}
      <path
        d={skeleton.thenarCreasePath}
        fill="none"
        stroke={pal.stroke}
        strokeWidth={0.95}
        strokeOpacity={0.18}
        strokeLinecap="round"
      />
      {skeleton.dorsalTendonPaths.map((d, idx) => (
        <path
          key={`tendon-${idx}`}
          d={d}
          fill="none"
          stroke={pal.stroke}
          strokeWidth={0.85}
          strokeOpacity={0.14}
          strokeLinecap="round"
        />
      ))}

      {/* Understated hand tag (LH / RH) */}
      <text
        x={skeleton.labelPos.x}
        y={skeleton.labelPos.y}
        textAnchor="middle"
        fontSize={8.2 * clampBadgeScale(scale)}
        fontWeight={700}
        letterSpacing={0.6}
        fill={pal.stroke}
        fillOpacity={0.72}
        paintOrder="stroke"
        stroke="#ffffff"
        strokeOpacity={0.68}
        strokeWidth={2.2}
        strokeLinejoin="round"
      >
        {posture.hand}
      </text>

      {/* Normal & cross-over fingers */}
      {foregroundFingers.map(renderFingerNode)}
    </g>
  );
}

function clampBadgeScale(handScale: number): number {
  return Math.max(0.86, Math.min(1.14, handScale));
}

function OverheadHandLane({
  posture,
  laneY,
  dimmed = false,
}: {
  posture: HandPosture;
  laneY: number;
  dimmed?: boolean;
}) {
  const pal = handPalette(posture.hand);
  const hp = posture.handPosition;
  const primaryCue = posture.transitionCues[0] ?? null;

  const hpSpan = useMemo(() => {
    if (!hp) return null;
    const loMidi = whiteKeyIndexToMidi(Math.min(hp.thumbKey, hp.pinkyKey));
    const hiMidi = whiteKeyIndexToMidi(Math.max(hp.thumbKey, hp.pinkyKey));
    const x1 = (midiToWhiteUnitX(loMidi) - 0.5) * WHITE_KEY_W + 2;
    const x2 = (midiToWhiteUnitX(hiMidi) + 0.5) * WHITE_KEY_W - 2;
    return {
      x1,
      x2,
      label: `${midiToPitchLabel(loMidi)}–${midiToPitchLabel(hiMidi)}`,
    };
  }, [hp]);

  return (
    <g
      data-testid={`overhead-lane-${posture.hand}`}
      data-dimmed={dimmed ? "true" : "false"}
      opacity={dimmed ? 0.3 : 1}
    >
      {hpSpan && (
        <g>
          <rect
            x={hpSpan.x1}
            y={laneY}
            width={Math.max(WHITE_KEY_W, hpSpan.x2 - hpSpan.x1)}
            height={16}
            rx={4}
            fill={pal.posBg}
            stroke={pal.stroke}
            strokeWidth={1}
            strokeDasharray="3,2"
          />
          <text
            x={(hpSpan.x1 + hpSpan.x2) / 2}
            y={laneY + 11}
            textAnchor="middle"
            fontSize={9}
            fontWeight={600}
            fill={pal.stroke}
          >
            {posture.hand} [{hpSpan.label}]
          </text>
        </g>
      )}

      {primaryCue &&
        (() => {
          const fromX = midiToWhiteUnitX(primaryCue.fromMidi) * WHITE_KEY_W;
          const toX = midiToWhiteUnitX(primaryCue.toMidi) * WHITE_KEY_W;
          const midX = (fromX + toX) / 2;
          const colors = cueColors(primaryCue.cue.severity);
          return (
            <g data-testid={`transition-cue-${posture.hand}`}>
              {Math.abs(toX - fromX) > 4 && (
                <path
                  d={`M ${fromX} ${laneY + 14} Q ${midX} ${Math.max(2, laneY - 3)} ${toX} ${laneY + 14}`}
                  fill="none"
                  stroke={colors.stroke}
                  strokeWidth={1.6}
                  strokeDasharray={primaryCue.isSequential ? undefined : "4,2"}
                />
              )}
              <rect
                x={Math.max(4, Math.min(SVG_W - 110, midX - 48))}
                y={laneY}
                width={96}
                height={15}
                rx={7}
                fill={colors.bg}
                stroke={colors.stroke}
                strokeWidth={0.8}
              />
              <text
                x={Math.max(52, Math.min(SVG_W - 62, midX))}
                y={laneY + 10.5}
                textAnchor="middle"
                fontSize={8.5}
                fontWeight={700}
                fill={colors.stroke}
              >
                {primaryCue.cue.label}
              </text>
            </g>
          );
        })()}
    </g>
  );
}

/**
 * Full-width unified 88-key physical piano (`A0`–`C8`) paired with real-time 2D translucent
 * top-down Left Hand & Right Hand posture simulation (`Hand Posture`).
 */
export function UnifiedPiano88({
  scoreDoc,
  solveResult,
  selectedSliceId,
  handSpanProfile = DEFAULT_HAND_SPAN_PROFILE,
  playbackFrame = null,
  practiceMode = "both",
  showOverhead = true,
  showFullPalm = false,
  wrongMidis,
  hitMidis,
  pressedMidis,
  sustainPedalPressed = false,
  onSelectSlice,
  onAuditionMidi,
  onVirtualNoteOn,
  onVirtualNoteOff,
}: UnifiedPiano88Props) {
  const dimRh = practiceMode === "lh-only";
  const dimLh = practiceMode === "rh-only";
  const [auditionMidi, setAuditionMidi] = useState<number | null>(null);

  const postureIndex = useMemo(() => {
    if (!scoreDoc || !solveResult || scoreDoc.onsetSlices.length === 0) return null;
    return buildHandPostureIndex(scoreDoc, solveResult, handSpanProfile);
  }, [scoreDoc, solveResult, handSpanProfile]);

  const targetFrame = useMemo<DualHandPostureFrame>(() => {
    if (playbackFrame && postureIndex) {
      return computeDualHandPostureFrameAtTime(postureIndex, playbackFrame.scoreSec);
    }
    return projectDualHandPostureAtSlice(scoreDoc, solveResult, selectedSliceId, handSpanProfile);
  }, [playbackFrame, postureIndex, scoreDoc, solveResult, selectedSliceId, handSpanProfile]);

  const [displayFrame, setDisplayFrame] = useState<DualHandPostureFrame>(targetFrame);
  const displayFrameRef = useRef<DualHandPostureFrame>(targetFrame);

  useEffect(() => {
    if (playbackFrame) {
      displayFrameRef.current = targetFrame;
      setDisplayFrame(targetFrame);
      return;
    }

    // Smooth ~180ms static inspect transition between slices when paused/stopped
    const fromFrame = displayFrameRef.current;
    if (
      fromFrame.rh.activeSliceId === targetFrame.rh.activeSliceId &&
      fromFrame.lh.activeSliceId === targetFrame.lh.activeSliceId &&
      fromFrame.rh.isResting === targetFrame.rh.isResting &&
      fromFrame.lh.isResting === targetFrame.lh.isResting
    ) {
      displayFrameRef.current = targetFrame;
      setDisplayFrame(targetFrame);
      return;
    }

    if (typeof globalThis.requestAnimationFrame !== "function") {
      displayFrameRef.current = targetFrame;
      setDisplayFrame(targetFrame);
      return;
    }

    let rafId = 0;
    const durationMs = 180;
    const startMs = globalThis.performance?.now?.() ?? Date.now();

    const step = (now: number) => {
      const elapsed = Math.max(0, (now || Date.now()) - startMs);
      const raw = Math.min(1, elapsed / durationMs);
      const eased = 1 - Math.pow(1 - raw, 3);

      const blended: DualHandPostureFrame = {
        scoreSec: targetFrame.scoreSec,
        activeKeyHighlights: targetFrame.activeKeyHighlights,
        rh: tweenHandPosture(fromFrame.rh, targetFrame.rh, eased),
        lh: tweenHandPosture(fromFrame.lh, targetFrame.lh, eased),
      };
      displayFrameRef.current = blended;
      setDisplayFrame(blended);

      if (raw < 1) {
        rafId = globalThis.requestAnimationFrame(step);
      } else {
        displayFrameRef.current = targetFrame;
        setDisplayFrame(targetFrame);
      }
    };

    rafId = globalThis.requestAnimationFrame(step);
    return () => {
      if (rafId) globalThis.cancelAnimationFrame?.(rafId);
    };
  }, [targetFrame, playbackFrame]);

  // Precompute fixed physical 88-key layout (52 white + 36 black)
  const keysLayout = useMemo(() => {
    const whites: Array<{ midi: number; x: number; label: string | null }> = [];
    const blacks: Array<{ midi: number; x: number }> = [];

    for (let m = PIANO_MIN_MIDI; m <= PIANO_MAX_MIDI; m++) {
      const unitX = midiToWhiteUnitX(m);
      if (!isBlackKey(m)) {
        const x = (unitX - 0.5) * WHITE_KEY_W;
        const pc = ((m % 12) + 12) % 12;
        const label = pc === 0 || m === PIANO_MIN_MIDI ? midiToPitchLabel(m) : null;
        whites.push({ midi: m, x, label });
      } else {
        const x = unitX * WHITE_KEY_W - BLACK_KEY_W / 2;
        blacks.push({ midi: m, x });
      }
    }
    return { whites, blacks };
  }, []);

  const slices = scoreDoc?.onsetSlices ?? [];
  const currentIdx = useMemo(() => {
    if (!selectedSliceId) return slices.length > 0 ? 0 : -1;
    const idx = slices.findIndex((s) => s.sliceId === selectedSliceId);
    return idx >= 0 ? idx : slices.length > 0 ? 0 : -1;
  }, [slices, selectedSliceId]);
  const selectedSlice = currentIdx >= 0 ? slices[currentIdx] : null;
  const rhHandPos = displayFrame.rh.handPosition;
  const lhHandPos = displayFrame.lh.handPosition;

  const handleKeyPress = (midi: number) => {
    setAuditionMidi(midi);
    onVirtualNoteOn?.(midi, 96);
    onAuditionMidi?.(midi);
    window.setTimeout(() => {
      setAuditionMidi((prev) => (prev === midi ? null : prev));
      onVirtualNoteOff?.(midi);
    }, 180);
  };

  const viewBoxTop = showOverhead ? 0 : FALLBOARD_Y;
  const viewBoxBottom = showFullPalm ? PIANO_SVG_H : SVG_BOTTOM_Y;
  const viewBoxHeight = viewBoxBottom - viewBoxTop;

  return (
    <section
      data-testid="unified-piano-88"
      aria-label="88键双手钢琴键盘"
      className={`border-t border-slate-300 bg-white px-3 pt-1.5 shadow-[0_-4px_12px_rgba(15,23,42,0.05)] sm:px-4 ${
        showFullPalm ? "pb-1.5" : "pb-0"
      }`}
    >
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-slate-900">88 键钢琴与双手实时模拟</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700">
            <span className="h-2 w-2 rounded-full bg-indigo-600" />
            左手{" "}
            {lhHandPos
              ? `${midiToPitchLabel(whiteKeyIndexToMidi(Math.min(lhHandPos.thumbKey, lhHandPos.pinkyKey)))}–${midiToPitchLabel(whiteKeyIndexToMidi(Math.max(lhHandPos.thumbKey, lhHandPos.pinkyKey)))}`
              : "休止"}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-teal-50 px-2 py-0.5 font-medium text-teal-800">
            <span className="h-2 w-2 rounded-full bg-teal-600" />
            右手{" "}
            {rhHandPos
              ? `${midiToPitchLabel(whiteKeyIndexToMidi(Math.min(rhHandPos.thumbKey, rhHandPos.pinkyKey)))}–${midiToPitchLabel(whiteKeyIndexToMidi(Math.max(rhHandPos.thumbKey, rhHandPos.pinkyKey)))}`
              : "休止"}
          </span>
          {selectedSlice && (
            <span data-testid="piano-slice-summary" className="text-slate-500">
              第{selectedSlice.measureIndex + 1}小节 · {selectedSlice.hand === "RH" ? "右手" : "左手"} ·{" "}
              {selectedSlice.notes.map((n) => midiToPitchLabel(n.midi)).join("+")}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {sustainPedalPressed && (
            <span
              data-testid="midi-sustain-indicator"
              className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800"
            >
              延音踏板
            </span>
          )}
          <span className="text-[11px] text-slate-400">点击琴键或按 Z–M / Q–I 键试听</span>
          {slices.length > 0 && (
            <>
              <span className="ml-1 text-[11px] text-slate-500">
                切片 {currentIdx + 1}/{slices.length}
              </span>
              <button
                type="button"
                data-testid="slice-prev-btn"
                disabled={currentIdx <= 0}
                onClick={() => {
                  if (currentIdx > 0 && onSelectSlice) {
                    onSelectSlice(slices[currentIdx - 1].sliceId);
                  }
                }}
                className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                上一步
              </button>
              <button
                type="button"
                data-testid="slice-next-btn"
                disabled={currentIdx < 0 || currentIdx >= slices.length - 1}
                onClick={() => {
                  if (currentIdx >= 0 && currentIdx < slices.length - 1 && onSelectSlice) {
                    onSelectSlice(slices[currentIdx + 1].sliceId);
                  }
                }}
                className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                下一步
              </button>
            </>
          )}
        </div>
      </div>

      <div className="overflow-x-auto lg:overflow-x-visible">
        <svg
          width={SVG_W}
          height={viewBoxHeight}
          viewBox={`0 ${viewBoxTop} ${SVG_W} ${viewBoxHeight}`}
          preserveAspectRatio="xMidYMid meet"
          className="block h-auto w-full min-w-[960px] select-none lg:min-w-0"
        >
          <defs>
            <linearGradient id="piano-dual-overlap" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#818cf8" />
              <stop offset="50%" stopColor="#818cf8" />
              <stop offset="50%" stopColor="#2dd4bf" />
              <stop offset="100%" stopColor="#2dd4bf" />
            </linearGradient>
            <linearGradient id="palm-grad-RH" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#14b8a6" stopOpacity={0.26} />
              <stop offset="62%" stopColor="#14b8a6" stopOpacity={0.18} />
              <stop offset="86%" stopColor="#14b8a6" stopOpacity={0.09} />
              <stop offset="100%" stopColor="#14b8a6" stopOpacity={0.03} />
            </linearGradient>
            <linearGradient id="palm-grad-LH" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6366f1" stopOpacity={0.24} />
              <stop offset="62%" stopColor="#6366f1" stopOpacity={0.16} />
              <stop offset="86%" stopColor="#6366f1" stopOpacity={0.08} />
              <stop offset="100%" stopColor="#6366f1" stopOpacity={0.03} />
            </linearGradient>
            <linearGradient id="hand-stroke-RH" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0f766e" stopOpacity={0.62} />
              <stop offset="72%" stopColor="#0f766e" stopOpacity={0.5} />
              <stop offset="100%" stopColor="#0f766e" stopOpacity={0.08} />
            </linearGradient>
            <linearGradient id="hand-stroke-LH" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4338ca" stopOpacity={0.62} />
              <stop offset="72%" stopColor="#4338ca" stopOpacity={0.5} />
              <stop offset="100%" stopColor="#4338ca" stopOpacity={0.08} />
            </linearGradient>
            <linearGradient id="finger-pressed-RH" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0d9488" stopOpacity={0.36} />
              <stop offset="65%" stopColor="#14b8a6" stopOpacity={0.22} />
              <stop offset="100%" stopColor="#14b8a6" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="finger-pressed-LH" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4f46e5" stopOpacity={0.34} />
              <stop offset="65%" stopColor="#6366f1" stopOpacity={0.2} />
              <stop offset="100%" stopColor="#6366f1" stopOpacity={0.02} />
            </linearGradient>
          </defs>

          {/* Overhead Dual Lanes: RH Top, LH Bottom */}
          {showOverhead && (
            <>
              <OverheadHandLane posture={displayFrame.rh} laneY={RH_LANE_Y} dimmed={dimRh} />
              <OverheadHandLane posture={displayFrame.lh} laneY={LH_LANE_Y} dimmed={dimLh} />
            </>
          )}

          {/* Fallboard Divider */}
          <rect
            x={0}
            y={FALLBOARD_Y}
            width={SVG_W}
            height={4}
            fill="#1e293b"
            rx={1}
          />

          {/* 52 White Keys */}
          <g data-layer="white-keys">
            {keysLayout.whites.map(({ midi, x, label }) => {
              const info = displayFrame.activeKeyHighlights.get(midi);
              const isPressed = Boolean(pressedMidis?.has(midi));
              const isAudition = auditionMidi === midi || isPressed;
              const isWrong = wrongMidis?.has(midi) ?? false;
              const isHit = hitMidis?.has(midi) ?? false;
              const isAccompanimentOnly = Boolean(
                (dimLh && info?.lh && !info?.rh) || (dimRh && info?.rh && !info?.lh)
              );
              const isBoth = Boolean(info?.rh && info?.lh);
              const isPedalSustained = Boolean(info?.lhPedalSustained || info?.rhPedalSustained);
              const isPedalOnly = Boolean(
                !isBoth &&
                  ((info?.rh === "held" && info?.rhPedalSustained) ||
                    (info?.lh === "held" && info?.lhPedalSustained))
              );
              let fill = "#ffffff";
              if (isWrong) {
                fill = "#ef4444";
              } else if (isHit) {
                fill = "#86efac";
              } else if (isPressed) {
                fill = "#fde68a";
              } else if (isBoth) {
                fill = "url(#piano-dual-overlap)";
              } else if (info?.rh === "active") {
                fill = dimRh ? "#ccfbf1" : "#5eead4";
              } else if (info?.rh === "held") {
                fill = info?.rhPedalSustained || dimRh ? "#f0fdfa" : "#ccfbf1";
              } else if (info?.lh === "active") {
                fill = dimLh ? "#e0e7ff" : "#a5b4fc";
              } else if (info?.lh === "held") {
                fill = info?.lhPedalSustained || dimLh ? "#eef2ff" : "#e0e7ff";
              } else if (isAudition) {
                fill = "#fde68a";
              }

              const hasPressed = Boolean(info || isAudition || isWrong || isHit);
              const pressShift = info || isPressed || isWrong || isHit ? 2 : 0;

              return (
                <g
                  key={midi}
                  data-testid={`piano-key-${midi}`}
                  data-midi={midi}
                  data-key-rh={info?.rh}
                  data-key-lh={info?.lh}
                  data-pedal-sustained={isPedalSustained ? "true" : undefined}
                  data-wrong-note={isWrong ? "true" : undefined}
                  data-hit-note={isHit ? "true" : undefined}
                  data-accompaniment-dimmed={isAccompanimentOnly ? "true" : undefined}
                  data-key-pressed={isPressed ? "true" : undefined}
                  onClick={() => handleKeyPress(midi)}
                  className="cursor-pointer"
                >
                  <rect
                    x={x}
                    y={KEYS_Y}
                    width={WHITE_KEY_W}
                    height={WHITE_KEY_H + pressShift}
                    fill={fill}
                    stroke={isWrong ? "#991b1b" : info?.isRepairedAnchor ? "#dc2626" : "#94a3b8"}
                    strokeWidth={isWrong || info?.isRepairedAnchor ? 1.8 : 0.9}
                    strokeDasharray={
                      isPedalOnly && !isWrong && !info?.isRepairedAnchor ? "3,2" : undefined
                    }
                    rx={2}
                  />
                  {hasPressed && (
                    <rect
                      x={x + 1}
                      y={KEYS_Y + WHITE_KEY_H - 4}
                      width={WHITE_KEY_W - 2}
                      height={5}
                      fill={
                        isWrong
                          ? "#991b1b"
                          : isHit
                            ? "#15803d"
                            : info?.rh
                              ? "#0f766e"
                              : info?.lh
                                ? "#4338ca"
                                : "#d97706"
                      }
                      opacity={isAccompanimentOnly ? 0.3 : isPedalOnly ? 0.45 : 0.75}
                    />
                  )}
                  {label && (
                    <text
                      x={x + WHITE_KEY_W / 2}
                      y={KEYS_Y + WHITE_KEY_H - 6}
                      textAnchor="middle"
                      fontSize={7.5}
                      fill="#64748b"
                    >
                      {label}
                    </text>
                  )}
                </g>
              );
            })}
          </g>

          {/* 36 Black Keys */}
          <g data-layer="black-keys">
            {keysLayout.blacks.map(({ midi, x }) => {
              const info = displayFrame.activeKeyHighlights.get(midi);
              const isPressed = Boolean(pressedMidis?.has(midi));
              const isAudition = auditionMidi === midi || isPressed;
              const isWrong = wrongMidis?.has(midi) ?? false;
              const isHit = hitMidis?.has(midi) ?? false;
              const isAccompanimentOnly = Boolean(
                (dimLh && info?.lh && !info?.rh) || (dimRh && info?.rh && !info?.lh)
              );
              const isBoth = Boolean(info?.rh && info?.lh);
              const isPedalSustained = Boolean(info?.lhPedalSustained || info?.rhPedalSustained);
              const isPedalOnly = Boolean(
                !isBoth &&
                  ((info?.rh === "held" && info?.rhPedalSustained) ||
                    (info?.lh === "held" && info?.lhPedalSustained))
              );
              let fill = "#0f172a";
              if (isWrong) {
                fill = "#dc2626";
              } else if (isHit) {
                fill = "#16a34a";
              } else if (isPressed) {
                fill = "#f59e0b";
              } else if (isBoth) {
                fill = "url(#piano-dual-overlap)";
              } else if (info?.rh === "active") {
                fill = dimRh ? "#5eead4" : "#0d9488";
              } else if (info?.rh === "held") {
                fill = dimRh ? "#99f6e4" : "#115e59";
              } else if (info?.lh === "active") {
                fill = dimLh ? "#a5b4fc" : "#4f46e5";
              } else if (info?.lh === "held") {
                fill = dimLh ? "#c7d2fe" : info?.lhPedalSustained ? "#4338ca" : "#3730a3";
              } else if (isAudition) {
                fill = "#d97706";
              }

              return (
                <g
                  key={midi}
                  data-testid={`piano-key-${midi}`}
                  data-midi={midi}
                  data-key-rh={info?.rh}
                  data-key-lh={info?.lh}
                  data-pedal-sustained={isPedalSustained ? "true" : undefined}
                  data-wrong-note={isWrong ? "true" : undefined}
                  data-hit-note={isHit ? "true" : undefined}
                  data-accompaniment-dimmed={isAccompanimentOnly ? "true" : undefined}
                  data-key-pressed={isPressed ? "true" : undefined}
                  onClick={() => handleKeyPress(midi)}
                  className="cursor-pointer"
                >
                  <rect
                    x={x}
                    y={KEYS_Y}
                    width={BLACK_KEY_W}
                    height={BLACK_KEY_H + (info || isPressed || isWrong || isHit ? 2 : 0)}
                    rx={2}
                    fill={fill}
                    stroke={isWrong ? "#991b1b" : info?.isRepairedAnchor ? "#f87171" : "#334155"}
                    strokeWidth={isWrong || info?.isRepairedAnchor ? 1.5 : 0.8}
                    strokeDasharray={
                      isPedalOnly && !isWrong && !info?.isRepairedAnchor ? "2,1.5" : undefined
                    }
                  />
                </g>
              );
            })}
          </g>

          {/* 2D Translucent Dual-Hand Posture Simulation Layer */}
          <g data-layer="hand-posture-simulation">
            <HandVectorOverlay posture={displayFrame.lh} dimmed={dimLh} />
            <HandVectorOverlay posture={displayFrame.rh} dimmed={dimRh} />
          </g>
        </svg>
      </div>
    </section>
  );
}
