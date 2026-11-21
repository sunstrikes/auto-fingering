import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { OpenSheetMusicDisplay, PointF2D, type Cursor } from "opensheetmusicdisplay";
import type { CursorSyncTarget, PlaybackFrame } from "../audio/playbackEngine";
import type { Finger, Hand, NoteEvent, ScoreDocument } from "../domain/types";
import type { NoteDiffEntry } from "../store/useStudioStore";
import { midiToPitchLabel } from "../solver/keyboard";
import {
  MarginRiskGutter,
  type MeasureGeometry,
  type MeasureRiskSummary,
} from "./MarginRiskGutter";
import type { PopoverAnchorRect } from "./NoteAnchorPopover";

export type ScoreLayoutMode = "horizontal" | "page";

export interface AnchorMarkerInfo {
  noteUid: string;
  measureIndex: number;
  midi: number;
  staff?: number;
  onsetTick?: number;
  hand: Hand;
  finger: Finger;
  isConflict: boolean;
}

export interface OsmdNoteHit {
  measureIndex: number;
  midi: number;
  staffId?: number;
  beatOffsetInMeasure?: number;
  measureDurationWholeNotes?: number;
  isTieContinuation?: boolean;
}

export interface AbLoopHighlightRange {
  startMeasureIndex: number;
  endMeasureIndex: number;
}

export type AbPickStep = "idle" | "start" | "end";

export interface ScoreRendererHandle {
  render(
    xmlString: string,
    options?: { layoutMode?: ScoreLayoutMode; zoom?: number }
  ): Promise<{
    measureCount: number;
    measureGeometry: MeasureGeometry[];
  }>;
  setNoteEvents?(noteEvents: NoteEvent[]): void;
  highlightMeasure(measureIndex: number | null): void;
  highlightAbLoop?(range: AbLoopHighlightRange | null): void;
  markAnchoredNotes(anchors: AnchorMarkerInfo[]): void;
  markDiffNotes?(diffs: NoteDiffEntry[]): void;
  highlightSelectedNote?(note: NoteEvent | null): void;
  hitTestNoteAtClientPoint?(clientX: number, clientY: number): OsmdNoteHit | null;
  hitTestMeasureAtClientPoint?(clientX: number, clientY: number): number | null;
  getCursorOffsetX?(): number | null;
  getSelectedNoteRect?(): PopoverAnchorRect | null;
  scrollToMeasure(measureIndex: number, scrollContainer: HTMLElement | null): void;
  syncCursor?: (target: CursorSyncTarget | null) => void;
  dispose(): void;
}

export type ScoreRendererFactory = (container: HTMLElement) => ScoreRendererHandle;

function cursorMatchesTargetMidis(cursor: Cursor, targetMidis: number[]): boolean {
  if (targetMidis.length === 0) return true;
  const notes = cursor.NotesUnderCursor?.() ?? [];
  if (notes.length === 0) return false;
  const targetSet = new Set(targetMidis);
  for (const n of notes) {
    const pitch = n?.Pitch;
    if (!pitch) continue;
    const midi = pitch.getHalfTone() + 12;
    if (targetSet.has(midi)) return true;
  }
  return false;
}

/**
 * Maps an OSMD graphical note hit onto the exact domain NoteEvent by
 * measureIndex, MIDI pitch, tie-continuation state, staff, and normalized beat offset.
 */
export function matchHitToNoteEvent(
  hit: OsmdNoteHit,
  noteEvents: NoteEvent[]
): NoteEvent | null {
  let candidates = noteEvents.filter(
    (n) => n.measureIndex === hit.measureIndex && n.midi === hit.midi
  );
  if (candidates.length === 0) return null;

  if (hit.isTieContinuation !== undefined) {
    const tieMatched = candidates.filter((n) => n.isTieStop === hit.isTieContinuation);
    if (tieMatched.length > 0) candidates = tieMatched;
  }

  if (hit.staffId !== undefined) {
    const staffMatched = candidates.filter((n) => n.staff === hit.staffId);
    if (staffMatched.length > 0) candidates = staffMatched;
  }

  if (candidates.length === 1 || hit.beatOffsetInMeasure === undefined) {
    return candidates[0];
  }

  const measureEvents = noteEvents.filter((n) => n.measureIndex === hit.measureIndex);
  const minTick = measureEvents.reduce((min, n) => Math.min(min, n.onsetTick), Infinity);
  const maxEndTick = measureEvents.reduce(
    (max, n) => Math.max(max, n.onsetTick + Math.max(1, n.durationTick)),
    minTick + 1
  );
  const measureTickSpan = Math.max(1, maxEndTick - minTick);
  const hitRatio =
    hit.measureDurationWholeNotes && hit.measureDurationWholeNotes > 0
      ? hit.beatOffsetInMeasure / hit.measureDurationWholeNotes
      : hit.beatOffsetInMeasure;

  let best = candidates[0];
  let bestDelta = Infinity;
  for (const cand of candidates) {
    const candRatio = (cand.onsetTick - minTick) / measureTickSpan;
    const delta = Math.abs(candRatio - hitRatio);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = cand;
    }
  }
  return best;
}

export interface MatchableScoreItem {
  noteUid: string;
  measureIndex: number;
  midi: number;
  staff?: number;
  onsetTick?: number;
  isTieStop?: boolean;
}

interface GraphicalNoteEntry {
  midi: number;
  staff: number | undefined;
  timestamp: number;
  isTieContinuation: boolean;
  noteSvg: SVGGElement;
  order: number;
}

function isSourceNoteTieContinuation(src: unknown): boolean {
  if (!src || typeof src !== "object") return false;
  const s = src as {
    NoteTies?: Array<{ StartNote?: unknown }>;
    NoteTie?: { StartNote?: unknown };
  };
  return Boolean(
    s.NoteTies?.some((t) => t.StartNote !== src) ||
      (s.NoteTie && s.NoteTie.StartNote !== src)
  );
}

function extractGraphicalNoteStaff(src: unknown, gm: unknown): number | undefined {
  const s = src as
    | {
        ParentStaff?: { Id?: number };
        ParentStaffEntry?: { ParentStaff?: { IdInMusicSystem?: number; Id?: number } };
        ParentVoiceEntry?: { ParentStaff?: { id?: number; Id?: number } };
      }
    | undefined;
  const m = gm as { ParentStaff?: { Id?: number } } | undefined;
  return (
    s?.ParentStaffEntry?.ParentStaff?.IdInMusicSystem ??
    s?.ParentVoiceEntry?.ParentStaff?.id ??
    s?.ParentStaff?.Id ??
    s?.ParentStaffEntry?.ParentStaff?.Id ??
    s?.ParentVoiceEntry?.ParentStaff?.Id ??
    m?.ParentStaff?.Id
  );
}

function collectMeasureGraphicalNotes(row: unknown[]): GraphicalNoteEntry[] {
  const entries: GraphicalNoteEntry[] = [];
  let order = 0;

  for (const gm of row) {
    const gmObj = gm as { staffEntries?: unknown[] } | undefined;
    for (const staffEntry of gmObj?.staffEntries ?? []) {
      const seObj = staffEntry as {
        relInMeasureTimestamp?: { RealValue?: number };
        graphicalVoiceEntries?: unknown[];
      };
      for (const gve of seObj?.graphicalVoiceEntries ?? []) {
        const gveObj = gve as { notes?: unknown[] };
        for (const gNote of gveObj?.notes ?? []) {
          const gn = gNote as {
            sourceNote?: {
              Pitch?: { getHalfTone?: () => number };
              isRest?: () => boolean;
              ParentStaffEntry?: { Timestamp?: { RealValue?: number } };
            };
            getSVGGElement?: () => SVGGElement | undefined;
          };
          const src = gn?.sourceNote;
          if (!src || src.isRest?.() || !src.Pitch?.getHalfTone) continue;
          const noteSvg = gn.getSVGGElement?.();
          if (!noteSvg) continue;

          const timestamp =
            seObj.relInMeasureTimestamp?.RealValue ??
            src.ParentStaffEntry?.Timestamp?.RealValue ??
            order;

          entries.push({
            midi: src.Pitch.getHalfTone() + 12,
            staff: extractGraphicalNoteStaff(src, gm),
            timestamp,
            isTieContinuation: isSourceNoteTieContinuation(src),
            noteSvg,
            order: order++,
          });
        }
      }
    }
  }

  entries.sort(
    (a, b) =>
      a.timestamp - b.timestamp ||
      (a.staff ?? 0) - (b.staff ?? 0) ||
      a.midi - b.midi ||
      a.order - b.order
  );
  return entries;
}

function pickBestGraphicalEntryIndex(
  entries: GraphicalNoteEntry[],
  used: Set<number>,
  midi: number,
  targetStaff: number | undefined,
  targetTieStop: boolean | undefined,
  includeTieStops: boolean
): number {
  const pool: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const entry = entries[i];
    if (!includeTieStops && entry.isTieContinuation) continue;
    if (entry.midi === midi) {
      pool.push(i);
    }
  }
  if (pool.length === 0) return -1;

  let narrowed = pool;
  if (targetTieStop !== undefined) {
    const tieFiltered = narrowed.filter((idx) => entries[idx].isTieContinuation === targetTieStop);
    if (tieFiltered.length > 0) narrowed = tieFiltered;
  }
  if (targetStaff !== undefined) {
    const staffFiltered = narrowed.filter((idx) => entries[idx].staff === targetStaff);
    if (staffFiltered.length > 0) narrowed = staffFiltered;
  }

  return narrowed[0];
}

/**
 * Matches score items (anchors, diffs, or selected note) to exact OSMD SVG noteheads
 * using measureIndex, midi, staff, TieContinuation exclusion, and chronological onset ordering.
 */
export function matchMeasureGraphicalNotes<T extends MatchableScoreItem>(
  measureList: unknown[][] | undefined,
  items: T[],
  noteEvents: NoteEvent[],
  includeTieStops: boolean,
  onMatch: (item: T, noteSvg: SVGGElement) => void
): void {
  if (!measureList || items.length === 0) return;

  const noteByUid = new Map<string, NoteEvent>();
  const eventsByMeasure = new Map<number, NoteEvent[]>();
  for (const ev of noteEvents) {
    noteByUid.set(ev.noteUid, ev);
    const list = eventsByMeasure.get(ev.measureIndex) ?? [];
    list.push(ev);
    eventsByMeasure.set(ev.measureIndex, list);
  }

  const itemsByMeasure = new Map<number, T[]>();
  for (const item of items) {
    const list = itemsByMeasure.get(item.measureIndex) ?? [];
    list.push(item);
    itemsByMeasure.set(item.measureIndex, list);
  }

  for (const [mIdx, measureItems] of itemsByMeasure.entries()) {
    const row = measureList[mIdx];
    if (!row) continue;

    const gEntries = collectMeasureGraphicalNotes(row);
    if (gEntries.length === 0) continue;

    const used = new Set<number>();
    const pendingByUid = new Map<string, T>();
    for (const item of measureItems) {
      const refEvent = noteByUid.get(item.noteUid);
      const isTie = item.isTieStop ?? refEvent?.isTieStop ?? false;
      if (!includeTieStops && isTie) continue;
      pendingByUid.set(item.noteUid, item);
    }

    const measureEvents = eventsByMeasure.get(mIdx);
    if (measureEvents && measureEvents.length > 0) {
      for (const ev of measureEvents) {
        if (!includeTieStops && ev.isTieStop) continue;
        const idx = pickBestGraphicalEntryIndex(
          gEntries,
          used,
          ev.midi,
          ev.staff,
          ev.isTieStop,
          includeTieStops
        );
        if (idx === -1) continue;
        used.add(idx);

        const matchedItem = pendingByUid.get(ev.noteUid);
        if (matchedItem) {
          pendingByUid.delete(ev.noteUid);
          onMatch(matchedItem, gEntries[idx].noteSvg);
        }
      }
    }

    if (pendingByUid.size > 0) {
      const remaining = Array.from(pendingByUid.values()).sort(
        (a, b) => (a.onsetTick ?? 0) - (b.onsetTick ?? 0) || a.midi - b.midi
      );
      for (const item of remaining) {
        const refEvent = noteByUid.get(item.noteUid);
        const idx = pickBestGraphicalEntryIndex(
          gEntries,
          used,
          item.midi,
          item.staff ?? refEvent?.staff,
          item.isTieStop ?? refEvent?.isTieStop ?? false,
          includeTieStops
        );
        if (idx === -1) continue;
        used.add(idx);
        onMatch(item, gEntries[idx].noteSvg);
      }
    }
  }
}

/**
 * Default OpenSheetMusicDisplay renderer adapter for measure geometry,
 * SVG measure highlighting, anchor/diff/selection markers, click hit-testing, playback cursor sync, and scrolling.
 */
export function createOsmdScoreRenderer(container: HTMLElement): ScoreRendererHandle {
  let activeLayoutMode: ScoreLayoutMode = "page";
  const buildOsmd = (mode: ScoreLayoutMode) =>
    new OpenSheetMusicDisplay(container, {
      autoResize: mode === "page",
      backend: "svg",
      drawFingerings: false,
      fingeringPosition: "aboveorbelow",
      followCursor: false, // OSMD scrollIntoView jitters on iPad; scrolling handled by ScoreViewer
      renderSingleHorizontalStaffline: mode === "horizontal",
      drawTitle: mode === "page",
    });

  let osmd = buildOsmd(activeLayoutMode);
  let lastCursorKey: { measureIndex: number; onsetTick: number; isGrace: boolean } | null = null;
  let currentNoteEvents: NoteEvent[] = [];

  const getMeasureSvgElements = (measureIndex: number): SVGGElement[] => {
    const row = osmd.GraphicSheet?.MeasureList?.[measureIndex];
    if (!row) return [];
    const elements: SVGGElement[] = [];
    for (const gm of row) {
      const el = gm?.getSVGGElement?.();
      if (el) elements.push(el);
    }
    return elements;
  };

  const clearElementsByAttr = (markerAttr: string, hostAttr?: string) => {
    container.querySelectorAll(`[${markerAttr}='true']`).forEach((node) => node.remove());
    if (hostAttr) {
      container.querySelectorAll(`[${hostAttr}]`).forEach((node) => node.removeAttribute(hostAttr));
    }
  };

  const iterateMeasureGraphicalNotes = <T extends MatchableScoreItem>(
    items: T[],
    includeTieStops: boolean,
    onMatch: (item: T, noteSvg: SVGGElement) => void
  ) => {
    matchMeasureGraphicalNotes(
      osmd.GraphicSheet?.MeasureList,
      items,
      currentNoteEvents,
      includeTieStops,
      onMatch
    );
  };

  const extractMeasureGeometry = (): MeasureGeometry[] => {
    const measureList = osmd.GraphicSheet?.MeasureList;
    if (!measureList || measureList.length === 0) return [];
    const containerRect = container.getBoundingClientRect();
    const geometry: MeasureGeometry[] = [];

    for (let m = 0; m < measureList.length; m++) {
      const els = getMeasureSvgElements(m);
      if (els.length === 0) continue;
      let minTop = Infinity;
      let maxBottom = -Infinity;
      let minLeft = Infinity;
      let maxRight = -Infinity;
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.height <= 0 && rect.width <= 0) continue;
        const relTop = rect.top - containerRect.top + container.scrollTop;
        const relLeft = rect.left - containerRect.left + container.scrollLeft;
        if (rect.height > 0) {
          minTop = Math.min(minTop, relTop);
          maxBottom = Math.max(maxBottom, relTop + rect.height);
        }
        if (rect.width > 0) {
          minLeft = Math.min(minLeft, relLeft);
          maxRight = Math.max(maxRight, relLeft + rect.width);
        }
      }
      if (Number.isFinite(minTop) && maxBottom > minTop) {
        geometry.push({
          measureIndex: m,
          top: minTop,
          height: maxBottom - minTop,
          left: Number.isFinite(minLeft) ? minLeft : undefined,
          width: Number.isFinite(minLeft) && maxRight > minLeft ? maxRight - minLeft : undefined,
        });
      }
    }
    return geometry;
  };

  return {
    async render(xmlString: string, options?: { layoutMode?: ScoreLayoutMode; zoom?: number }) {
      const nextMode = options?.layoutMode ?? activeLayoutMode;
      if (nextMode !== activeLayoutMode) {
        activeLayoutMode = nextMode;
        container.innerHTML = "";
        osmd = buildOsmd(nextMode);
      }
      if (activeLayoutMode === "horizontal") {
        container.style.width = "max-content";
        container.style.minWidth = "100%";
        osmd.EngravingRules.PageTopMargin = 1;
        osmd.EngravingRules.PageBottomMargin = 1;
        osmd.EngravingRules.PageLeftMargin = 1.5;
        osmd.EngravingRules.PageRightMargin = 1.5;
      } else {
        container.style.width = "";
        container.style.minWidth = "";
        osmd.EngravingRules.PageTopMargin = 4;
        osmd.EngravingRules.PageBottomMargin = 4;
      }
      await osmd.load(xmlString);
      osmd.Zoom = options?.zoom ?? 0.85;
      osmd.render();
      lastCursorKey = null;
      osmd.cursor?.hide();
      const measureList = osmd.GraphicSheet?.MeasureList ?? [];
      return {
        measureCount: measureList.length,
        measureGeometry: extractMeasureGeometry(),
      };
    },

    setNoteEvents(events: NoteEvent[]) {
      currentNoteEvents = events;
    },

    highlightMeasure(measureIndex: number | null) {
      clearElementsByAttr("data-studio-highlight", "data-active-measure");
      if (measureIndex === null) return;
      const els = getMeasureSvgElements(measureIndex);
      for (const g of els) {
        g.setAttribute("data-active-measure", "true");
        if (typeof g.getBBox === "function") {
          try {
            const box = g.getBBox();
            const svgNs = "http://www.w3.org/2000/svg";
            const rect = container.ownerDocument.createElementNS(svgNs, "rect");
            rect.setAttribute("data-studio-highlight", "true");
            rect.setAttribute("x", String(box.x - 4));
            rect.setAttribute("y", String(box.y - 6));
            rect.setAttribute("width", String(Math.max(12, box.width + 8)));
            rect.setAttribute("height", String(Math.max(24, box.height + 12)));
            rect.setAttribute("rx", "6");
            rect.setAttribute("fill", "rgba(37, 99, 235, 0.08)");
            rect.setAttribute("stroke", "#2563eb");
            rect.setAttribute("stroke-width", "1.5");
            rect.setAttribute("stroke-dasharray", "4,3");
            g.insertBefore(rect, g.firstChild);
          } catch {
            // SVG getBBox unavailable in non-layout environments
          }
        }
      }
    },

    highlightAbLoop(range: AbLoopHighlightRange | null) {
      clearElementsByAttr("data-studio-ab-loop", "data-ab-loop-measure");
      if (!range) return;
      const start = Math.max(0, Math.min(range.startMeasureIndex, range.endMeasureIndex));
      const end = Math.max(start, Math.max(range.startMeasureIndex, range.endMeasureIndex));
      for (let m = start; m <= end; m++) {
        const els = getMeasureSvgElements(m);
        for (const g of els) {
          g.setAttribute("data-ab-loop-measure", "true");
          if (typeof g.getBBox === "function") {
            try {
              const box = g.getBBox();
              const svgNs = "http://www.w3.org/2000/svg";
              const rect = container.ownerDocument.createElementNS(svgNs, "rect");
              rect.setAttribute("data-studio-ab-loop", "true");
              rect.setAttribute("x", String(box.x - 2));
              rect.setAttribute("y", String(box.y - 4));
              rect.setAttribute("width", String(Math.max(10, box.width + 4)));
              rect.setAttribute("height", String(Math.max(20, box.height + 8)));
              rect.setAttribute("rx", "4");
              rect.setAttribute("fill", "rgba(79, 70, 229, 0.10)");
              rect.setAttribute("stroke", "rgba(79, 70, 229, 0.45)");
              rect.setAttribute("stroke-width", "1.2");
              g.insertBefore(rect, g.firstChild);
            } catch {
              // SVG getBBox unavailable in non-layout environments
            }
          }
        }
      }
    },

    markAnchoredNotes(anchors: AnchorMarkerInfo[]) {
      clearElementsByAttr("data-studio-anchor-marker", "data-anchor-note");
      iterateMeasureGraphicalNotes(anchors, false, (matched, noteSvg) => {
        noteSvg.setAttribute("data-anchor-note", matched.noteUid);
        if (typeof noteSvg.getBBox === "function") {
          try {
            const box = noteSvg.getBBox();
            const svgNs = "http://www.w3.org/2000/svg";
            const dot = container.ownerDocument.createElementNS(svgNs, "circle");
            dot.setAttribute("data-studio-anchor-marker", "true");
            dot.setAttribute("cx", String(box.x + box.width / 2));
            dot.setAttribute("cy", String(box.y - 6));
            dot.setAttribute("r", "4");
            dot.setAttribute("fill", "#dc2626");
            dot.setAttribute("stroke", "#ffffff");
            dot.setAttribute("stroke-width", "1.2");
            noteSvg.appendChild(dot);
          } catch {
            // ignore non-layout SVG
          }
        }
      });
    },

    markDiffNotes(diffs: NoteDiffEntry[]) {
      clearElementsByAttr("data-studio-diff-marker", "data-diff-note");
      iterateMeasureGraphicalNotes(diffs, false, (matched, noteSvg) => {
        noteSvg.setAttribute("data-diff-note", matched.noteUid);
        if (typeof noteSvg.getBBox === "function") {
          try {
            const box = noteSvg.getBBox();
            const svgNs = "http://www.w3.org/2000/svg";
            const badge = container.ownerDocument.createElementNS(svgNs, "rect");
            badge.setAttribute("data-studio-diff-marker", "true");
            badge.setAttribute("x", String(box.x - 3));
            badge.setAttribute("y", String(box.y - 3));
            badge.setAttribute("width", String(Math.max(14, box.width + 6)));
            badge.setAttribute("height", String(Math.max(14, box.height + 6)));
            badge.setAttribute("rx", "4");
            badge.setAttribute("fill", "rgba(124, 58, 237, 0.14)");
            badge.setAttribute("stroke", "#7c3aed");
            badge.setAttribute("stroke-width", "1.5");
            noteSvg.insertBefore(badge, noteSvg.firstChild);
          } catch {
            // ignore non-layout SVG
          }
        }
      });
    },

    highlightSelectedNote(note: NoteEvent | null) {
      clearElementsByAttr("data-studio-selected-note", "data-selected-note");
      if (!note) return;
      iterateMeasureGraphicalNotes([note], true, (matched, noteSvg) => {
        noteSvg.setAttribute("data-selected-note", matched.noteUid);
        if (typeof noteSvg.getBBox === "function") {
          try {
            const box = noteSvg.getBBox();
            const svgNs = "http://www.w3.org/2000/svg";
            const ring = container.ownerDocument.createElementNS(svgNs, "circle");
            ring.setAttribute("data-studio-selected-note", "true");
            ring.setAttribute("cx", String(box.x + box.width / 2));
            ring.setAttribute("cy", String(box.y + box.height / 2));
            ring.setAttribute("r", String(Math.max(10, Math.max(box.width, box.height) * 0.65)));
            ring.setAttribute("fill", "none");
            ring.setAttribute("stroke", "#2563eb");
            ring.setAttribute("stroke-width", "2");
            noteSvg.appendChild(ring);
          } catch {
            // ignore non-layout SVG
          }
        }
      });
    },

    hitTestNoteAtClientPoint(clientX: number, clientY: number): OsmdNoteHit | null {
      const graphicSheet = osmd.GraphicSheet;
      if (!graphicSheet) return null;
      try {
        const svgPt = graphicSheet.domToSvg(new PointF2D(clientX, clientY));
        const osmdPt = graphicSheet.svgToOsmd(svgPt);
        const gNote = graphicSheet.GetNearestNote(osmdPt, new PointF2D(10, 10));
        if (!gNote || !gNote.sourceNote || gNote.sourceNote.isRest?.() || !gNote.sourceNote.Pitch) {
          return null;
        }
        const pos = gNote.PositionAndShape?.AbsolutePosition;
        if (pos && Math.hypot(pos.x - osmdPt.x, pos.y - osmdPt.y) > 6) {
          return null;
        }
        const src = gNote.sourceNote;
        const isTieContinuation = Boolean(
          src.NoteTies?.some((t) => t.StartNote !== src) ||
            (src.NoteTie && src.NoteTie.StartNote !== src)
        );
        return {
          measureIndex: src.SourceMeasure?.measureListIndex ?? 0,
          midi: src.Pitch.getHalfTone() + 12,
          staffId: src.ParentStaff?.Id,
          beatOffsetInMeasure: src.ParentStaffEntry?.Timestamp?.RealValue,
          measureDurationWholeNotes: src.SourceMeasure?.Duration?.RealValue,
          isTieContinuation,
        };
      } catch {
        return null;
      }
    },

    hitTestMeasureAtClientPoint(clientX: number, clientY: number): number | null {
      const noteHit = this.hitTestNoteAtClientPoint?.(clientX, clientY);
      if (noteHit) return noteHit.measureIndex;

      const measureList = osmd.GraphicSheet?.MeasureList;
      if (!measureList || measureList.length === 0) return null;
      for (let m = 0; m < measureList.length; m++) {
        const els = getMeasureSvgElements(m);
        for (const el of els) {
          const rect = el.getBoundingClientRect();
          if (
            rect.width > 0 &&
            rect.height > 0 &&
            clientX >= rect.left - 4 &&
            clientX <= rect.right + 4 &&
            clientY >= rect.top - 8 &&
            clientY <= rect.bottom + 8
          ) {
            return m;
          }
        }
      }
      return null;
    },

    scrollToMeasure(measureIndex: number, scrollContainer: HTMLElement | null) {
      const els = getMeasureSvgElements(measureIndex);
      const target = els[0];
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
        return;
      }
      const fallback = scrollContainer?.querySelector<HTMLElement>(
        `[data-score-measure-anchor="${measureIndex}"]`
      );
      if (fallback && typeof fallback.scrollIntoView === "function") {
        fallback.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      }
    },

    getCursorOffsetX() {
      const el = osmd.cursor?.cursorElement;
      if (!el || osmd.cursor?.Hidden) return null;
      const left = el.offsetLeft;
      if (typeof left === "number" && left > 0) return left;
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      if (elRect.width <= 0 && elRect.height <= 0) return null;
      return elRect.left - containerRect.left;
    },

    getSelectedNoteRect() {
      const el = container.querySelector<SVGGElement>("[data-selected-note]");
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { left: rect.left + rect.width / 2, top: rect.top, height: Math.max(14, rect.height) };
    },

    syncCursor(target: CursorSyncTarget | null) {
      const cursor = osmd.cursor;
      if (!cursor) return;

      if (!target) {
        cursor.hide();
        lastCursorKey = null;
        return;
      }

      if (
        lastCursorKey &&
        lastCursorKey.measureIndex === target.measureIndex &&
        lastCursorKey.onsetTick === target.onsetTick &&
        lastCursorKey.isGrace === target.isGrace &&
        !cursor.Hidden
      ) {
        return;
      }

      if (cursor.Hidden) {
        cursor.show();
      }

      let iter = cursor.iterator;
      if (!iter) return;

      const movedBackwards =
        lastCursorKey === null ||
        target.measureIndex < lastCursorKey.measureIndex ||
        (target.measureIndex === lastCursorKey.measureIndex &&
          target.onsetTick < lastCursorKey.onsetTick) ||
        iter.EndReached ||
        iter.CurrentMeasureIndex > target.measureIndex;

      if (movedBackwards) {
        cursor.reset();
        iter = cursor.iterator;
      }

      if (!iter) return;

      let steps = 0;
      const MAX_STEPS = 4096;
      while (!iter.EndReached && iter.CurrentMeasureIndex < target.measureIndex && steps < MAX_STEPS) {
        cursor.next();
        steps += 1;
      }

      if (
        !movedBackwards &&
        lastCursorKey !== null &&
        lastCursorKey.measureIndex === target.measureIndex &&
        !iter.EndReached &&
        iter.CurrentMeasureIndex === target.measureIndex
      ) {
        cursor.next();
        steps += 1;
      }

      while (
        !iter.EndReached &&
        iter.CurrentMeasureIndex === target.measureIndex &&
        !cursorMatchesTargetMidis(cursor, target.midis) &&
        steps < MAX_STEPS
      ) {
        cursor.next();
        steps += 1;
      }

      lastCursorKey = {
        measureIndex: target.measureIndex,
        onsetTick: target.onsetTick,
        isGrace: target.isGrace,
      };
    },

    dispose() {
      osmd.cursor?.hide();
      lastCursorKey = null;
      clearElementsByAttr("data-studio-highlight", "data-active-measure");
      clearElementsByAttr("data-studio-ab-loop", "data-ab-loop-measure");
      clearElementsByAttr("data-studio-anchor-marker", "data-anchor-note");
      clearElementsByAttr("data-studio-diff-marker", "data-diff-note");
      clearElementsByAttr("data-studio-selected-note", "data-selected-note");
      container.innerHTML = "";
    },
  };
}

export interface ScoreViewerProps {
  xmlString: string | null;
  scoreDoc?: ScoreDocument | null;
  noteEvents?: NoteEvent[];
  measureRisks?: MeasureRiskSummary[];
  anchoredNotes?: AnchorMarkerInfo[];
  diffNotes?: NoteDiffEntry[];
  selectedMeasureIndex?: number | null;
  selectedSliceId?: string | null;
  selectedNoteUid?: string | null;
  cursorTarget?: CursorSyncTarget | null;
  playbackFrame?: PlaybackFrame | null;
  layoutMode?: ScoreLayoutMode;
  abLoopRange?: AbLoopHighlightRange | null;
  abPickStep?: AbPickStep;
  onLayoutModeChange?: (mode: ScoreLayoutMode) => void;
  onSelectMeasure?: (measureIndex: number) => void;
  onSelectNote?: (noteUid: string, anchorRect?: PopoverAnchorRect) => void;
  onPickAbMeasure?: (measureIndex: number) => void;
  onMeasureGeometryChange?: (geometry: MeasureGeometry[]) => void;
  rendererFactory?: ScoreRendererFactory;
}

/**
 * Renders the MusicXML score canvas via OSMD paired with the horizontal/vertical MarginRiskGutter,
 * anchor & purple Diff indicators, OSMD click hit-testing, continuous horizontal auto-scroll with manual pause, and playback cursor sync.
 */
export function ScoreViewer({
  xmlString,
  scoreDoc = null,
  noteEvents = [],
  measureRisks = [],
  anchoredNotes = [],
  diffNotes = [],
  selectedMeasureIndex = null,
  selectedSliceId = null,
  selectedNoteUid = null,
  cursorTarget = null,
  playbackFrame = null,
  layoutMode = "page",
  abLoopRange = null,
  abPickStep = "idle",
  onLayoutModeChange,
  onSelectMeasure,
  onSelectNote,
  onPickAbMeasure,
  onMeasureGeometryChange,
  rendererFactory = createOsmdScoreRenderer,
}: ScoreViewerProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const osmdContainerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ScoreRendererHandle | null>(null);
  const lastScrolledMeasureRef = useRef<number | null>(null);
  const programmaticScrollUntilRef = useRef<number>(0);

  const [renderError, setRenderError] = useState<string | null>(null);
  const [measureGeometry, setMeasureGeometry] = useState<MeasureGeometry[]>([]);
  const [isRendered, setIsRendered] = useState<boolean>(false);
  const [manualScrollPaused, setManualScrollPaused] = useState<boolean>(false);
  const [scoreZoom, setScoreZoom] = useState<number>(0.85);

  // Build per-measure [startSec, endSec] lookup for smooth intra-measure continuous horizontal scrolling
  const measureTimeBounds = useRef<Map<number, { startSec: number; endSec: number }>>(new Map());
  useEffect(() => {
    const map = new Map<number, { startSec: number; endSec: number }>();
    if (scoreDoc) {
      for (const ev of scoreDoc.noteEvents) {
        const end = ev.onsetSec + Math.max(0.05, ev.durationSec);
        const cur = map.get(ev.measureIndex);
        if (!cur) {
          map.set(ev.measureIndex, { startSec: ev.onsetSec, endSec: end });
        } else {
          cur.startSec = Math.min(cur.startSec, ev.onsetSec);
          cur.endSec = Math.max(cur.endSec, end);
        }
      }
    }
    measureTimeBounds.current = map;
  }, [scoreDoc]);

  useEffect(() => {
    if (!playbackFrame || playbackFrame.state === "stopped") {
      setManualScrollPaused(false);
    }
  }, [playbackFrame?.state]);

  useEffect(() => {
    const container = osmdContainerRef.current;
    if (!container || !xmlString) {
      rendererRef.current?.dispose();
      rendererRef.current = null;
      if (container) container.innerHTML = "";
      setMeasureGeometry([]);
      onMeasureGeometryChange?.([]);
      setIsRendered(false);
      lastScrolledMeasureRef.current = null;
      return;
    }

    let cancelled = false;
    setRenderError(null);
    setIsRendered(false);

    const renderScore = async () => {
      try {
        if (!rendererRef.current) {
          rendererRef.current = rendererFactory(container);
        }
        const info = await rendererRef.current.render(xmlString, {
          layoutMode,
          zoom: scoreZoom,
        });
        if (!cancelled) {
          setMeasureGeometry(info.measureGeometry);
          onMeasureGeometryChange?.(info.measureGeometry);
          setIsRendered(true);
        }
      } catch (err) {
        if (!cancelled) {
          setRenderError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    void renderScore();

    return () => {
      cancelled = true;
    };
  }, [xmlString, layoutMode, scoreZoom, rendererFactory]);

  useEffect(() => {
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [rendererFactory]);

  useEffect(() => {
    if (!isRendered || !rendererRef.current) return;
    rendererRef.current.setNoteEvents?.(noteEvents);
    rendererRef.current.markAnchoredNotes(anchoredNotes);
  }, [isRendered, anchoredNotes, noteEvents]);

  useEffect(() => {
    if (!isRendered || !rendererRef.current) return;
    rendererRef.current.setNoteEvents?.(noteEvents);
    rendererRef.current.markDiffNotes?.(diffNotes);
  }, [isRendered, diffNotes, noteEvents]);

  useEffect(() => {
    if (!isRendered || !rendererRef.current) return;
    rendererRef.current.setNoteEvents?.(noteEvents);
    const selectedNote =
      selectedNoteUid !== null
        ? noteEvents.find((n) => n.noteUid === selectedNoteUid) ?? null
        : null;
    rendererRef.current.highlightSelectedNote?.(selectedNote);
  }, [isRendered, selectedNoteUid, noteEvents]);

  useEffect(() => {
    if (!isRendered || !rendererRef.current) return;
    rendererRef.current.highlightMeasure(selectedMeasureIndex);
    if (
      selectedMeasureIndex !== null &&
      lastScrolledMeasureRef.current !== selectedMeasureIndex &&
      playbackFrame?.state !== "playing"
    ) {
      lastScrolledMeasureRef.current = selectedMeasureIndex;
      rendererRef.current.scrollToMeasure(selectedMeasureIndex, scrollContainerRef.current);
    }
  }, [isRendered, selectedMeasureIndex, playbackFrame?.state]);

  useEffect(() => {
    if (!isRendered || !rendererRef.current) return;
    rendererRef.current.highlightAbLoop?.(abLoopRange ?? null);
  }, [isRendered, abLoopRange]);

  const handleSurfaceClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (abPickStep !== "idle" && onPickAbMeasure) {
      const pickedMeasure =
        rendererRef.current?.hitTestMeasureAtClientPoint?.(event.clientX, event.clientY) ??
        rendererRef.current?.hitTestNoteAtClientPoint?.(event.clientX, event.clientY)?.measureIndex ??
        null;
      if (pickedMeasure !== null) {
        onPickAbMeasure(pickedMeasure);
      }
      return;
    }

    if (!onSelectNote || !rendererRef.current?.hitTestNoteAtClientPoint) return;
    const hit = rendererRef.current.hitTestNoteAtClientPoint(event.clientX, event.clientY);
    if (!hit) return;
    const matched = matchHitToNoteEvent(hit, noteEvents);
    if (matched) {
      onSelectNote(matched.noteUid, {
        left: event.clientX,
        top: event.clientY,
        height: 18,
      });
    }
  };

  useEffect(() => {
    if (!isRendered || !rendererRef.current) return;
    rendererRef.current.syncCursor?.(cursorTarget ?? null);
  }, [isRendered, cursorTarget]);

  // Continuous smooth horizontal scroll tracking during playback (~30% from left edge)
  useEffect(() => {
    if (
      !isRendered ||
      layoutMode !== "horizontal" ||
      !playbackFrame ||
      playbackFrame.state !== "playing" ||
      manualScrollPaused
    ) {
      return;
    }
    const scroller = scrollContainerRef.current;
    if (!scroller) return;

    let targetX: number | null = rendererRef.current?.getCursorOffsetX?.() ?? null;

    if (cursorTarget) {
      const geo = measureGeometry.find((g) => g.measureIndex === cursorTarget.measureIndex);
      const bounds = measureTimeBounds.current.get(cursorTarget.measureIndex);
      if (geo && geo.left !== undefined && geo.width !== undefined && geo.width > 0 && bounds) {
        const span = Math.max(0.1, bounds.endSec - bounds.startSec);
        const ratio = Math.max(0, Math.min(1, (playbackFrame.scoreSec - bounds.startSec) / span));
        const interpX = geo.left + ratio * geo.width;
        targetX = targetX !== null ? targetX * 0.35 + interpX * 0.65 : interpX;
      }
    }

    if (targetX === null) return;
    const desiredScrollLeft = Math.max(0, targetX - scroller.clientWidth * 0.3);
    programmaticScrollUntilRef.current = Date.now() + 80;
    scroller.scrollLeft = desiredScrollLeft;
  }, [isRendered, layoutMode, playbackFrame, manualScrollPaused, cursorTarget, measureGeometry]);

  // Page mode: keep cursor visible with a single vertical scroll only when it leaves the viewport
  useEffect(() => {
    if (!isRendered || layoutMode !== "page" || playbackFrame?.state !== "playing") return;
    const scroller = scrollContainerRef.current;
    const cursorEl = scroller?.querySelector<HTMLElement>("img[id^='cursorImg']");
    if (!scroller || !cursorEl) return;
    const sr = scroller.getBoundingClientRect();
    const cr = cursorEl.getBoundingClientRect();
    if (cr.height <= 0) return;
    if (cr.top < sr.top + 8 || cr.bottom > sr.bottom - 8) {
      programmaticScrollUntilRef.current = Date.now() + 80;
      scroller.scrollTop += cr.top - sr.top - sr.height * 0.25;
    }
  }, [isRendered, layoutMode, playbackFrame?.state, cursorTarget]);

  const markManualScroll = () => {
    if (layoutMode === "horizontal" && playbackFrame?.state === "playing") {
      setManualScrollPaused(true);
    }
  };

  const handleContainerScroll = () => {
    if (Date.now() <= programmaticScrollUntilRef.current) return;
    markManualScroll();
  };

  if (!xmlString) {
    return (
      <div
        data-testid="score-viewer"
        data-layout-mode={layoutMode}
        className="flex h-full min-h-60 flex-1 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-500"
      >
        请上传 <code>.musicxml</code>、<code>.xml</code> 或 <code>.mxl</code> 乐谱文件，即可进行双手钢琴指法推导、滚动阅谱与键盘模拟。
      </div>
    );
  }

  return (
    <div
      data-testid="score-viewer"
      data-layout-mode={layoutMode}
      data-active-measure={selectedMeasureIndex !== null ? String(selectedMeasureIndex) : undefined}
      data-selected-slice={selectedSliceId ?? undefined}
      data-selected-note={selectedNoteUid ?? undefined}
      className="flex min-h-0 flex-1 flex-col rounded-xl border border-slate-200 bg-white p-2 shadow-sm sm:p-2.5"
    >
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-1 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-slate-600">
          <span className="font-semibold text-slate-800">乐谱画布</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800">
            <span className="h-2 w-2 rounded-full bg-amber-400" />
            警告
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] text-red-700">
            <span className="h-2 w-2 rounded-full bg-red-500" />
            高风险
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700">
            <span className="h-2 w-2 rounded-full bg-violet-600" />
            变更
          </span>
          <span className="text-[11px] text-slate-400">点击任意音符可编辑指法</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {manualScrollPaused && playbackFrame?.state === "playing" && (
            <button
              type="button"
              data-testid="recenter-cursor-btn"
              onClick={() => setManualScrollPaused(false)}
              className="rounded-full border border-blue-300 bg-blue-600 px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-xs hover:bg-blue-700"
            >
              回到游标
            </button>
          )}

          <div
            className="inline-flex items-center rounded-md border border-slate-300 bg-slate-100 p-0.5 text-[11px] font-medium"
            role="group"
            aria-label="乐谱缩放"
          >
            <button
              type="button"
              data-testid="score-zoom-out-btn"
              aria-label="缩小乐谱"
              disabled={scoreZoom <= 0.5}
              onClick={() =>
                setScoreZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 100) / 100))
              }
              className="rounded px-1.5 py-0.5 text-slate-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              -
            </button>
            <span
              data-testid="score-zoom-label"
              className="min-w-[36px] text-center text-[11px] text-slate-700"
            >
              {Math.round(scoreZoom * 100)}%
            </span>
            <button
              type="button"
              data-testid="score-zoom-in-btn"
              aria-label="放大乐谱"
              disabled={scoreZoom >= 1.4}
              onClick={() =>
                setScoreZoom((z) => Math.min(1.4, Math.round((z + 0.1) * 100) / 100))
              }
              className="rounded px-1.5 py-0.5 text-slate-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              +
            </button>
          </div>

          {onLayoutModeChange && (
            <div
              className="inline-flex rounded-md border border-slate-300 bg-slate-100 p-0.5 text-[11px] font-medium"
              role="group"
              aria-label="乐谱排版模式"
            >
              <button
                type="button"
                data-testid="layout-horizontal-btn"
                aria-pressed={layoutMode === "horizontal"}
                onClick={() => onLayoutModeChange("horizontal")}
                className={`rounded px-2 py-0.5 transition ${
                  layoutMode === "horizontal"
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                横向卷轴
              </button>
              <button
                type="button"
                data-testid="layout-page-btn"
                aria-pressed={layoutMode === "page"}
                onClick={() => onLayoutModeChange("page")}
                className={`rounded px-2 py-0.5 transition ${
                  layoutMode === "page"
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                多行分页
              </button>
            </div>
          )}

          {selectedMeasureIndex !== null && (
            <span
              data-testid="active-measure-badge"
              className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 font-semibold text-blue-700"
            >
              当前: 第 {selectedMeasureIndex + 1} 小节
            </span>
          )}
        </div>
      </div>

      {anchoredNotes.length > 0 && (
        <div
          data-testid="anchor-indicators"
          className="mb-2 flex items-center gap-1.5 overflow-x-auto rounded-lg border border-red-100 bg-red-50/50 px-2.5 py-1 text-xs"
        >
          <span className="shrink-0 font-semibold text-red-700">
            锚点 ({anchoredNotes.length}):
          </span>
          {anchoredNotes.map((anchor) => (
            <button
              key={anchor.noteUid}
              type="button"
              data-anchor-note-uid={anchor.noteUid}
              onClick={() => {
                if (onSelectNote) {
                  onSelectNote(anchor.noteUid);
                } else {
                  onSelectMeasure?.(anchor.measureIndex);
                }
              }}
              className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition ${
                anchor.isConflict
                  ? "border-red-400 bg-red-100 text-red-800"
                  : "border-red-200 bg-white text-red-700 hover:bg-red-50"
              }`}
              title={`第 ${anchor.measureIndex + 1} 小节 ${midiToPitchLabel(anchor.midi)} 指法锚点: ${anchor.finger}`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-red-600" />
              <span>
                第{anchor.measureIndex + 1}小节 {midiToPitchLabel(anchor.midi)} ({anchor.hand === "RH" ? "右手" : "左手"}): {anchor.finger}
              </span>
            </button>
          ))}
        </div>
      )}

      {renderError && (
        <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          渲染错误: {renderError}
        </div>
      )}

      <div className="flex min-h-0 flex-1 items-stretch gap-2">
        {layoutMode === "page" && measureRisks.length > 0 && (
          <div className="max-h-full overflow-y-auto py-1">
            <MarginRiskGutter
              measures={measureRisks}
              selectedMeasureIndex={selectedMeasureIndex}
              measureGeometry={measureGeometry}
              orientation="vertical"
              onSelectMeasure={(m) => onSelectMeasure?.(m)}
            />
          </div>
        )}

        <div
          ref={scrollContainerRef}
          data-testid="score-scroll-container"
          onWheel={markManualScroll}
          onPointerDown={markManualScroll}
          onScroll={handleContainerScroll}
          className={`relative min-h-0 min-w-0 flex-1 rounded-lg border border-slate-100 ${
            layoutMode === "horizontal"
              ? playbackFrame?.state === "playing"
                ? "overflow-x-auto overflow-y-hidden"
                : "overflow-x-auto overflow-y-auto"
              : "overflow-auto"
          }`}
          style={{ overscrollBehavior: "contain" }}
        >
          {layoutMode === "horizontal" && measureRisks.length > 0 && (
            <div className="sticky top-0 z-10 border-b border-slate-100 bg-white/90 px-2 py-1 backdrop-blur-xs">
              <MarginRiskGutter
                measures={measureRisks}
                selectedMeasureIndex={selectedMeasureIndex}
                measureGeometry={measureGeometry}
                orientation="horizontal"
                onSelectMeasure={(m) => onSelectMeasure?.(m)}
              />
            </div>
          )}

          <div
            ref={osmdContainerRef}
            data-testid="osmd-canvas-surface"
            onClick={handleSurfaceClick}
            className={layoutMode === "horizontal" ? "min-w-full cursor-pointer" : "w-full cursor-pointer"}
          />
        </div>
      </div>
    </div>
  );
}
