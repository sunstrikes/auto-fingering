/**
 * THROWAWAY PROTOTYPE (Issue #20): Eye-Hand Span (EHS) dynamic lookahead disappearing-score mask
 * over existing ScoreViewer (OSMD SVG).
 *
 * Plan: Three structurally distinct EHS mask variants (A: Beat-Gate Snap, B: Per-Note SVG Fade,
 * C: Translucent Sliding Curtain), switchable via `?variant=A|B|C` and a floating bottom bar,
 * mounted directly inside the existing Studio route (Sub-shape A, dev-only).
 */

export type EhsVariantKey = "A" | "B" | "C";

export interface EhsVariantMeta {
  key: EhsVariantKey;
  shortName: string;
  title: string;
  hypothesis: string;
}

export const EHS_VARIANTS: readonly EhsVariantMeta[] = [
  {
    key: "A",
    shortName: "拍格瞬隐门",
    title: "A · 拍格瞬隐门 (Beat-Gate Snap)",
    hypothesis: "按拍格边界离散瞬隐，零滑动边缘干扰，用「手位游标 + 视线前沿门」强迫眼手分离。",
  },
  {
    key: "B",
    shortName: "逐音渐隐消散",
    title: "B · 逐音渐隐消散 (Per-Note SVG Fade)",
    hypothesis: "无遮罩方块；直接渐隐 OSMD 音符/符干/符梁 SVG 透明度，五线谱与调号全程清晰锐利。",
  },
  {
    key: "C",
    shortName: "渐隐滑动幕布",
    title: "C · 渐隐滑动幕布 (Sliding Fog Curtain)",
    hypothesis: "60fps 连续羽化半透明幕布 + 前瞻聚焦带；分页模式跨行提前显影，卷轴模式似提词器。",
  },
] as const;

export const EHS_VARIANT_KEYS: readonly EhsVariantKey[] = ["A", "B", "C"];

export type EhsLookaheadPolicy =
  | "fixed-0.5"
  | "fixed-1"
  | "fixed-2"
  | "fixed-bar"
  | "adaptive";

export type EhsPeekMode = "flash" | "hold" | "auto-stall";

export type EhsPeekReason = "b0-key" | "f-key" | "touch" | "auto-stall" | null;

export interface EhsConfig {
  enabled: boolean;
  lookaheadPolicy: EhsLookaheadPolicy;
  peekMode: EhsPeekMode;
  flashDurationMs: number;
  /** Residual opacity (0..0.25) for hidden notes in Variant B or masked veil transparency in A/C */
  ghostResidualOpacity: number;
  /** Mute demo piano notes during continuous playback so pianist hears only real piano + metronome */
  muteDemoPiano: boolean;
  /** Render OSMD measure boxes, clef boundaries, and staffEntry beat anchor dots for alignment audit */
  showAlignmentDebug: boolean;
  /** Hide score during Count-In final lookahead beats vs stay fully open until downbeat */
  preRollMaskDuringCountIn: boolean;
}

export const DEFAULT_EHS_CONFIG: EhsConfig = {
  enabled: true,
  lookaheadPolicy: "fixed-2",
  peekMode: "auto-stall",
  flashDurationMs: 1500,
  ghostResidualOpacity: 0.06,
  muteDemoPiano: false,
  showAlignmentDebug: false,
  preRollMaskDuringCountIn: true,
};

export interface EhsBeatAnchor {
  /** Normalized position within the measure in `[0, 1]` */
  frac: number;
  /** Absolute score beat index (`measureStartBeat + frac * measureBeats`) */
  scoreBeat: number;
  /** Left pixel relative to OSMD container */
  left: number;
  /** Center pixel relative to OSMD container */
  centerX: number;
  /** Right pixel relative to OSMD container */
  right: number;
}

export interface EhsMeasureBox {
  measureIndex: number;
  systemIndex: number;
  /** Full measure bounding box relative to OSMD container (includes clef/key sig if line start) */
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  /** X coordinate where actual note/rest content starts (past clef/key/time signature) */
  contentLeft: number;
  /** Score beat at start of this measure */
  startBeat: number;
  /** Musical beat count of this measure (from MeasureTimeline, adjusted for pickup) */
  beatsInMeasure: number;
  /** Score beat at end of this measure */
  endBeat: number;
  /** Start/end time in seconds from MeasureTimeline */
  startSec: number;
  endSec: number;
  /** Exact OSMD staffEntry horizontal anchor points sorted by frac */
  anchors: EhsBeatAnchor[];
}

export interface EhsSystemRow {
  systemIndex: number;
  measureIndices: number[];
  left: number;
  right: number;
  /** First note content X on this system (after clef/key signature) */
  contentLeft: number;
  top: number;
  bottom: number;
  height: number;
  startBeat: number;
  endBeat: number;
}

export interface EhsGraphicalNoteRef {
  id: string;
  measureIndex: number;
  /** Continuous musical beat in score */
  scoreBeat: number;
  /** Approximate score timestamp in seconds */
  onsetSec: number;
  midi: number | null;
  isRest: boolean;
  noteUid: string | null;
  /** Bounding X center relative to OSMD container */
  centerX: number;
  /** SVG elements belonging to this note (notehead group, stem, beams, ledger lines, ties) */
  svgElements: Element[];
}

export interface EhsExtractedGeometry {
  measures: EhsMeasureBox[];
  systems: EhsSystemRow[];
  notes: EhsGraphicalNoteRef[];
  containerWidth: number;
  containerHeight: number;
  extractMs: number;
  extractedAt: number;
}

export interface EhsPeekState {
  active: boolean;
  holding: boolean;
  reason: EhsPeekReason;
  untilMs: number;
  remainingMs: number;
  /** When auto-stall triggers, spotlight the rescued measure locally */
  rescueMeasureIndex: number | null;
}

export interface EhsAdaptiveTelemetry {
  /** Current adaptive lookahead width in beats (only authoritative when policy === 'adaptive') */
  adaptiveBeats: number;
  /** Direction indicator of last adaptive adjustment */
  trend: "steady" | "expanding" | "contracting";
  /** Most recent MIDI strike onset offset vs steady-tempo expected time (ms; positive = late) */
  lastLagMs: number | null;
  /** Rolling average absolute hesitation lag over recent steps (ms) */
  rollingHesitationMs: number | null;
  /** Matched vs missed steps during current continuous bout */
  matchedSteps: number;
  missedSteps: number;
  consecutiveCleanSteps: number;
  consecutiveMissedSteps: number;
  stallCount: number;
  /** Set of noteUids confirmed struck via MIDI during this bout (for Variant B immediate dissolve) */
  struckNoteUids: ReadonlySet<string>;
  /** Last status note in plain domain Chinese */
  lastEventLabel: string;
}

export interface EhsFrameSnapshot {
  /** Current hand position in continuous score beats (can be negative during Count-In pre-roll) */
  handBeat: number;
  /** Active measure index at hand position */
  handMeasureIndex: number;
  /** Beat offset inside active hand measure (1-based for display, 0-based for math) */
  handBeatInMeasure: number;
  /** Effective lookahead span in beats (after ramp-in & adaptive policy) */
  effectiveLookaheadBeats: number;
  /** Target lookahead span before ramp-in */
  targetLookaheadBeats: number;
  /** Lookahead horizon in continuous score beats (`handBeat + effectiveLookaheadBeats`) */
  frontierBeat: number;
  /** Measure index containing the eye frontier */
  frontierMeasureIndex: number;
  /** Whether we are in Count-In pre-roll */
  isCountIn: boolean;
  /** Whether the mask is currently lifted (peek active or prototype paused) */
  isMasked: boolean;
  /** Current peek state */
  peek: EhsPeekState;
  /** Current adaptive/MIDI state */
  telemetry: EhsAdaptiveTelemetry;
}

export interface EhsPerfMetrics {
  fps: number;
  lastUpdateMs: number;
  avgUpdateMs: number;
  mutatedSvgNodes: number;
}

export function isValidEhsVariant(raw: string | null | undefined): raw is EhsVariantKey {
  return raw === "A" || raw === "B" || raw === "C";
}

export function getEhsVariantMeta(key: EhsVariantKey): EhsVariantMeta {
  return EHS_VARIANTS.find((v) => v.key === key) ?? EHS_VARIANTS[0];
}
