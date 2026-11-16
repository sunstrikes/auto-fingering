import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { OpenSheetMusicDisplay, PointF2D, type Cursor } from "opensheetmusicdisplay";
import type { CursorSyncTarget } from "../audio/playbackEngine";
import type { Finger, Hand, NoteEvent } from "../domain/types";
import type { NoteDiffEntry } from "../store/useStudioStore";
import { midiToPitchLabel } from "../solver/keyboard";
import {
  MarginRiskGutter,
  type MeasureGeometry,
  type MeasureRiskSummary,
} from "./MarginRiskGutter";

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

export interface ScoreRendererHandle {
  render(xmlString: string): Promise<{
    measureCount: number;
    measureGeometry: MeasureGeometry[];
  }>;
  setNoteEvents?(noteEvents: NoteEvent[]): void;
  highlightMeasure(measureIndex: number | null): void;
  markAnchoredNotes(anchors: AnchorMarkerInfo[]): void;
  markDiffNotes?(diffs: NoteDiffEntry[]): void;
  highlightSelectedNote?(note: NoteEvent | null): void;
  hitTestNoteAtClientPoint?(clientX: number, clientY: number): OsmdNoteHit | null;
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
  const osmd = new OpenSheetMusicDisplay(container, {
    autoResize: true,
    backend: "svg",
    drawFingerings: true,
    fingeringPosition: "aboveorbelow",
    followCursor: true,
  });
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
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.height <= 0) continue;
        const relTop = rect.top - containerRect.top + container.scrollTop;
        minTop = Math.min(minTop, relTop);
        maxBottom = Math.max(maxBottom, relTop + rect.height);
      }
      if (Number.isFinite(minTop) && maxBottom > minTop) {
        geometry.push({
          measureIndex: m,
          top: minTop,
          height: maxBottom - minTop,
        });
      }
    }
    return geometry;
  };

  return {
    async render(xmlString: string) {
      await osmd.load(xmlString);
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

    scrollToMeasure(measureIndex: number, scrollContainer: HTMLElement | null) {
      const els = getMeasureSvgElements(measureIndex);
      const target = els[0];
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const fallback = scrollContainer?.querySelector<HTMLElement>(
        `[data-score-measure-anchor="${measureIndex}"]`
      );
      if (fallback && typeof fallback.scrollIntoView === "function") {
        fallback.scrollIntoView({ behavior: "smooth", block: "center" });
      }
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
      clearElementsByAttr("data-studio-anchor-marker", "data-anchor-note");
      clearElementsByAttr("data-studio-diff-marker", "data-diff-note");
      clearElementsByAttr("data-studio-selected-note", "data-selected-note");
      container.innerHTML = "";
    },
  };
}

export interface ScoreViewerProps {
  xmlString: string | null;
  noteEvents?: NoteEvent[];
  measureRisks?: MeasureRiskSummary[];
  anchoredNotes?: AnchorMarkerInfo[];
  diffNotes?: NoteDiffEntry[];
  selectedMeasureIndex?: number | null;
  selectedSliceId?: string | null;
  selectedNoteUid?: string | null;
  cursorTarget?: CursorSyncTarget | null;
  onSelectMeasure?: (measureIndex: number) => void;
  onSelectNote?: (noteUid: string) => void;
  rendererFactory?: ScoreRendererFactory;
}

/**
 * Renders the MusicXML score canvas via OSMD paired with the left-edge MarginRiskGutter,
 * anchor & purple Diff indicators, OSMD click hit-testing, active measure highlights, playback cursor sync, and scroll support.
 */
export function ScoreViewer({
  xmlString,
  noteEvents = [],
  measureRisks = [],
  anchoredNotes = [],
  diffNotes = [],
  selectedMeasureIndex = null,
  selectedSliceId = null,
  selectedNoteUid = null,
  cursorTarget = null,
  onSelectMeasure,
  onSelectNote,
  rendererFactory = createOsmdScoreRenderer,
}: ScoreViewerProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const osmdContainerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ScoreRendererHandle | null>(null);
  const lastScrolledMeasureRef = useRef<number | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [measureGeometry, setMeasureGeometry] = useState<MeasureGeometry[]>([]);
  const [isRendered, setIsRendered] = useState<boolean>(false);

  useEffect(() => {
    const container = osmdContainerRef.current;
    if (!container || !xmlString) {
      rendererRef.current?.dispose();
      rendererRef.current = null;
      if (container) container.innerHTML = "";
      setMeasureGeometry([]);
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
        const info = await rendererRef.current.render(xmlString);
        if (!cancelled) {
          setMeasureGeometry(info.measureGeometry);
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
  }, [xmlString, rendererFactory]);

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
    if (selectedMeasureIndex !== null && lastScrolledMeasureRef.current !== selectedMeasureIndex) {
      lastScrolledMeasureRef.current = selectedMeasureIndex;
      rendererRef.current.scrollToMeasure(selectedMeasureIndex, scrollContainerRef.current);
    }
  }, [isRendered, selectedMeasureIndex]);

  const handleSurfaceClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onSelectNote || !rendererRef.current?.hitTestNoteAtClientPoint) return;
    const hit = rendererRef.current.hitTestNoteAtClientPoint(event.clientX, event.clientY);
    if (!hit) return;
    const matched = matchHitToNoteEvent(hit, noteEvents);
    if (matched) {
      onSelectNote(matched.noteUid);
    }
  };

  useEffect(() => {
    if (!isRendered || !rendererRef.current) return;
    rendererRef.current.syncCursor?.(cursorTarget ?? null);
  }, [isRendered, cursorTarget]);

  if (!xmlString) {
    return (
      <div
        data-testid="score-viewer"
        className="flex min-h-80 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-500"
      >
        Upload a <code>.musicxml</code>, <code>.xml</code>, or <code>.mxl</code> file to deduce and preview piano fingerings.
      </div>
    );
  }

  return (
    <div
      data-testid="score-viewer"
      data-active-measure={selectedMeasureIndex !== null ? String(selectedMeasureIndex) : undefined}
      data-selected-slice={selectedSliceId ?? undefined}
      data-selected-note={selectedNoteUid ?? undefined}
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-slate-600">
          <span className="font-semibold text-slate-800">Score Canvas</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800">
            <span className="h-2 w-2 rounded-full bg-amber-400" />
            Warn
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] text-red-700">
            <span className="h-2 w-2 rounded-full bg-red-500" />
            Danger
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700">
            <span className="h-2 w-2 rounded-full bg-violet-600" />
            Diff
          </span>
          <span className="text-[11px] text-slate-400">Click any notehead to edit fingering</span>
        </div>

        {selectedMeasureIndex !== null && (
          <span
            data-testid="active-measure-badge"
            className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 font-semibold text-blue-700"
          >
            Active: m.{selectedMeasureIndex + 1}
          </span>
        )}
      </div>

      {anchoredNotes.length > 0 && (
        <div
          data-testid="anchor-indicators"
          className="mb-3 flex flex-wrap items-center gap-1.5 rounded-lg border border-red-100 bg-red-50/50 px-3 py-2 text-xs"
        >
          <span className="font-semibold text-red-700">
            Anchors ({anchoredNotes.length}):
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
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition ${
                anchor.isConflict
                  ? "border-red-400 bg-red-100 text-red-800"
                  : "border-red-200 bg-white text-red-700 hover:bg-red-50"
              }`}
              title={`Finger anchor ${anchor.finger} on ${midiToPitchLabel(anchor.midi)} in measure ${anchor.measureIndex + 1}`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-red-600" />
              <span>
                m.{anchor.measureIndex + 1} {midiToPitchLabel(anchor.midi)} ({anchor.hand}): {anchor.finger}
              </span>
            </button>
          ))}
        </div>
      )}

      {diffNotes.length > 0 && (
        <div
          data-testid="diff-indicators"
          className="mb-3 flex flex-wrap items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50/70 px-3 py-2 text-xs"
        >
          <span className="rounded bg-violet-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
            Diff
          </span>
          <span className="font-semibold text-violet-900">
            Changed ({diffNotes.length}):
          </span>
          {diffNotes.map((d) => (
            <button
              key={d.noteUid}
              type="button"
              data-diff-note-uid={d.noteUid}
              onClick={() => onSelectNote?.(d.noteUid)}
              className="inline-flex items-center gap-1 rounded-full border border-violet-300 bg-white px-2 py-0.5 text-[11px] font-medium text-violet-800 hover:bg-violet-100"
            >
              <span>
                m.{d.measureIndex + 1} {d.pitchLabel} ({d.hand}): {d.before ?? "—"} → {d.after ?? "—"}
              </span>
            </button>
          ))}
        </div>
      )}

      {renderError && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Render error: {renderError}
        </div>
      )}

      <div className="flex items-start gap-2.5">
        {measureRisks.length > 0 && (
          <MarginRiskGutter
            measures={measureRisks}
            selectedMeasureIndex={selectedMeasureIndex}
            measureGeometry={measureGeometry}
            onSelectMeasure={(m) => onSelectMeasure?.(m)}
          />
        )}

        <div
          ref={scrollContainerRef}
          data-testid="score-scroll-container"
          className="relative max-h-[75vh] min-w-0 flex-1 overflow-auto rounded-lg border border-slate-100"
        >
          <div
            ref={osmdContainerRef}
            data-testid="osmd-canvas-surface"
            onClick={handleSurfaceClick}
            className="w-full cursor-pointer"
          />
        </div>
      </div>
    </div>
  );
}
