import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import type { NoteEvent, ScoreDocument } from "../domain/types";
import {
  buildMeasureBeatSpans,
  computeEhsNoteOpacity,
  type EhsFrameSnapshot,
  type MeasureBeatSpan,
} from "../guided/ehsController";
import type { ScoreLayoutMode } from "./ScoreViewer";

export interface EhsBeatAnchor {
  frac: number;
  scoreBeat: number;
  left: number;
  centerX: number;
  right: number;
}

export interface EhsMeasureBox {
  measureIndex: number;
  systemIndex: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  contentLeft: number;
  startBeat: number;
  beatsInMeasure: number;
  endBeat: number;
  startSec: number;
  endSec: number;
  anchors: EhsBeatAnchor[];
}

export interface EhsSystemRow {
  systemIndex: number;
  measureIndices: number[];
  left: number;
  right: number;
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
  scoreBeat: number;
  onsetSec: number;
  midi: number | null;
  isRest: boolean;
  noteUid: string | null;
  centerX: number;
  beamGroupId: string | null;
  beamElements: Element[];
  svgElements: Element[];
}

export interface EhsExtractedGeometry {
  measures: EhsMeasureBox[];
  systems: EhsSystemRow[];
  notes: EhsGraphicalNoteRef[];
  sharedBeamGroupCount: number;
  containerWidth: number;
  containerHeight: number;
  extractMs: number;
}

export interface EhsNoteVisualState {
  id: string;
  measureIndex: number;
  scoreBeat: number;
  noteUid: string | null;
  midi: number | null;
  opacity: number;
  beamGroupId: string | null;
  beamElementCount: number;
  beamOpacity: number | null;
}

export interface EhsVisualInspection {
  active: boolean;
  isMasked: boolean;
  extractMs: number;
  lastFrameMs: number;
  frameCount: number;
  noteCount: number;
  sharedBeamGroupCount: number;
  measureCount: number;
  systemCount: number;
  measures: Array<{
    measureIndex: number;
    systemIndex: number;
    left: number;
    contentLeft: number;
    right: number;
    top: number;
    bottom: number;
  }>;
  spotlightRect: { x: number; y: number; width: number; height: number; systemIndex: number } | null;
  nextSystemSpotlightRect: { x: number; y: number; width: number; height: number; systemIndex: number } | null;
  rescueMeasureRect: { x: number; y: number; width: number; height: number; measureIndex: number } | null;
  clefZonesProtected: boolean;
  preScrollTargetTop: number | null;
  notes: EhsNoteVisualState[];
}

interface VexNoteLike {
  vfnote?: Array<{ beam?: unknown }>;
  sourceNote?: {
    Pitch?: { getHalfTone?: () => number };
    isRest?: () => boolean;
    NoteBeam?: unknown;
    ParentStaffEntry?: { Timestamp?: { RealValue?: number } };
  };
  PositionAndShape?: { AbsolutePosition?: { x?: number; y?: number } };
  getSVGGElement?: () => SVGGElement | undefined;
  getStemSVG?: () => Element | undefined;
  getBeamSVGs?: () => Element[] | undefined;
  getLedgerLineSVGs?: () => Element[] | undefined;
  getTieSVGs?: () => Element[] | undefined;
  getFlagSVG?: () => Element | undefined;
  getModifierSVGs?: () => Element[] | undefined;
}

interface GraphicalMeasureLike {
  ParentMusicSystem?: unknown;
  parentSourceMeasure?: { Duration?: { RealValue?: number } };
  beginInstructionsWidth?: number;
  stave?: { x?: number; y?: number; width?: number; height?: number };
  getSVGGElement?: () => SVGGElement | undefined;
  staffEntries?: Array<{
    relInMeasureTimestamp?: { RealValue?: number };
    graphicalVoiceEntries?: Array<{
      notes?: VexNoteLike[];
    }>;
  }>;
}

function isFingeringModifierElement(el: Element): boolean {
  return Boolean(
    el.classList?.contains("osmd-fingering") ||
      el.classList?.contains("vf-fingering") ||
      el.getAttribute?.("data-osmd-fingering") === "true",
  );
}

/**
 * Piecewise-linear interpolation mapping a beat fraction in `[0, 1]` inside a measure
 * onto engraved pixel X while respecting clef/key-signature padding (`contentLeft`).
 */
export function fracToMeasureX(box: EhsMeasureBox, frac: number): number {
  const f = Math.max(0, Math.min(1, frac));
  const contentRight = Math.max(box.contentLeft + 6, box.right - 3);
  if (f <= 0) return box.contentLeft;
  if (f >= 1) return contentRight;

  if (box.anchors.length === 0) {
    return box.contentLeft + f * (contentRight - box.contentLeft);
  }

  const pts: Array<{ f: number; x: number }> = [{ f: 0, x: box.contentLeft }];
  let lastX = box.contentLeft;

  for (const a of box.anchors) {
    const af = Math.max(0, Math.min(0.999, a.frac));
    const ax = Math.max(lastX, Math.min(contentRight, a.left - 3));
    if (af <= pts[pts.length - 1].f + 1e-4) {
      continue;
    }
    pts.push({ f: af, x: ax });
    lastX = ax;
  }

  pts.push({ f: 1, x: Math.max(lastX, contentRight) });

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    if (f >= p0.f && f <= p1.f) {
      const span = Math.max(1e-5, p1.f - p0.f);
      const t = (f - p0.f) / span;
      return p0.x + t * (p1.x - p0.x);
    }
  }

  return contentRight;
}

/**
 * Maps a continuous score beat to `{ measure, system, x }` inside extracted OSMD geometry.
 */
export function scoreBeatToCanvasPoint(
  geo: EhsExtractedGeometry,
  scoreBeat: number,
): { measure: EhsMeasureBox; system: EhsSystemRow | null; x: number } | null {
  if (geo.measures.length === 0) return null;

  let measure = geo.measures[geo.measures.length - 1];
  if (scoreBeat <= geo.measures[0].startBeat) {
    measure = geo.measures[0];
  } else {
    for (let i = 0; i < geo.measures.length; i++) {
      const m = geo.measures[i];
      if (scoreBeat < m.endBeat || i === geo.measures.length - 1) {
        measure = m;
        break;
      }
    }
  }

  const frac =
    measure.beatsInMeasure > 0
      ? Math.max(0, Math.min(1, (scoreBeat - measure.startBeat) / measure.beatsInMeasure))
      : 0;
  const x = fracToMeasureX(measure, frac);
  const system = geo.systems.find((s) => s.systemIndex === measure.systemIndex) ?? null;
  return { measure, system, x };
}

/**
 * Extracts measure boxes, system rows, clef-safe `contentLeft` boundaries, and per-note
 * VexFlow SVG references (pooling shared beam SVG elements across all constituent notes).
 */
export function extractEhsOsmdGeometry(
  osmd: OpenSheetMusicDisplay | null,
  container: HTMLElement | null,
  scoreDoc: ScoreDocument | null,
  noteEvents: readonly NoteEvent[],
  layoutMode: ScoreLayoutMode,
): EhsExtractedGeometry {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const empty: EhsExtractedGeometry = {
    measures: [],
    systems: [],
    notes: [],
    sharedBeamGroupCount: 0,
    containerWidth: container?.scrollWidth ?? 0,
    containerHeight: container?.scrollHeight ?? 0,
    extractMs: 0,
  };

  if (!osmd || !container) return empty;
  const measureList = osmd.GraphicSheet?.MeasureList as GraphicalMeasureLike[][] | undefined;
  if (!measureList || measureList.length === 0) return empty;

  const zoom = typeof osmd.Zoom === "number" && osmd.Zoom > 0 ? osmd.Zoom : 1;
  const containerRect = container.getBoundingClientRect();
  const beatSpans: MeasureBeatSpan[] = buildMeasureBeatSpans(scoreDoc);

  const sourceEvents = scoreDoc ? scoreDoc.noteEvents : noteEvents;
  const domainNotesByMeasure = new Map<number, NoteEvent[]>();
  for (const ev of sourceEvents) {
    if (ev.isTieStop) continue;
    const list = domainNotesByMeasure.get(ev.measureIndex) ?? [];
    list.push(ev);
    domainNotesByMeasure.set(ev.measureIndex, list);
  }

  const systemObjectToIdx = new Map<unknown, number>();
  const systemTopBuckets: Array<{ top: number; idx: number }> = [];
  const measures: EhsMeasureBox[] = [];
  const allNotes: EhsGraphicalNoteRef[] = [];
  const beamGroupRegistry = new Map<unknown, { id: string; elements: Set<Element> }>();
  let totalBeamGroupCounter = 0;

  for (let m = 0; m < measureList.length; m++) {
    const row = measureList[m];
    if (!row || row.length === 0) continue;

    const span = beatSpans[m] ?? {
      measureIndex: m,
      startBeat: m * 4,
      beatsInMeasure: 4,
      endBeat: (m + 1) * 4,
      startSec: m * 2,
      endSec: (m + 1) * 2,
      timeBeats: 4,
      timeBeatType: 4,
    };

    let minLeft = Infinity;
    let maxRight = -Infinity;
    let minTop = Infinity;
    let maxBottom = -Infinity;
    let musicSystemObj: unknown = null;
    let measureDurationWhole = 0;
    let maxBeginInstrPx = 0;

    for (const gm of row) {
      if (!gm) continue;
      if (!musicSystemObj && gm.ParentMusicSystem) {
        musicSystemObj = gm.ParentMusicSystem;
      }
      const d = gm.parentSourceMeasure?.Duration?.RealValue;
      if (typeof d === "number" && d > 0) {
        measureDurationWhole = Math.max(measureDurationWhole, d);
      }
      if (typeof gm.beginInstructionsWidth === "number" && gm.beginInstructionsWidth > 0) {
        maxBeginInstrPx = Math.max(maxBeginInstrPx, gm.beginInstructionsWidth * 10 * zoom);
      }

      const el = gm.getSVGGElement?.();
      const rect = el?.getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) {
        const left = rect.left - containerRect.left;
        const top = rect.top - containerRect.top;
        minLeft = Math.min(minLeft, left);
        maxRight = Math.max(maxRight, left + rect.width);
        minTop = Math.min(minTop, top);
        maxBottom = Math.max(maxBottom, top + rect.height);
      } else if (
        gm.stave &&
        typeof gm.stave.x === "number" &&
        typeof gm.stave.y === "number" &&
        typeof gm.stave.width === "number" &&
        gm.stave.width > 0
      ) {
        // JSDOM fallback using OSMD/VexFlow stave coordinates scaled by osmd.Zoom
        const left = gm.stave.x * zoom;
        const top = gm.stave.y * zoom;
        const width = gm.stave.width * zoom;
        const height = Math.max(40 * zoom, (gm.stave.height ?? 50) * zoom);
        minLeft = Math.min(minLeft, left);
        maxRight = Math.max(maxRight, left + width);
        minTop = Math.min(minTop, top);
        maxBottom = Math.max(maxBottom, top + height);
      }
    }

    if (!Number.isFinite(minLeft) || !Number.isFinite(minTop) || maxRight <= minLeft) {
      continue;
    }

    if (measureDurationWhole <= 0) {
      measureDurationWhole = span.beatsInMeasure / Math.max(1, span.timeBeatType || 4);
    }

    let systemIndex = 0;
    if (layoutMode === "horizontal") {
      systemIndex = 0;
    } else if (musicSystemObj) {
      const existing = systemObjectToIdx.get(musicSystemObj);
      if (existing !== undefined) {
        systemIndex = existing;
      } else {
        systemIndex = systemObjectToIdx.size;
        systemObjectToIdx.set(musicSystemObj, systemIndex);
      }
    } else {
      const bucket = systemTopBuckets.find((b) => Math.abs(b.top - minTop) < 32);
      if (bucket) {
        systemIndex = bucket.idx;
      } else {
        systemIndex = systemTopBuckets.length;
        systemTopBuckets.push({ top: minTop, idx: systemIndex });
      }
    }

    const anchorBuckets = new Map<number, { frac: number; left: number; right: number }>();
    const domainPool = domainNotesByMeasure.get(m) ?? [];
    const usedDomainIdx = new Set<number>();
    const measureNoteEntries: Array<{
      ref: EhsGraphicalNoteRef;
      beamKey: unknown;
      svgSet: Set<Element>;
      beamSet: Set<Element>;
    }> = [];
    let noteCounter = 0;

    for (const gm of row) {
      for (const se of gm?.staffEntries ?? []) {
        const relWhole = se.relInMeasureTimestamp?.RealValue ?? 0;
        const frac = Math.max(0, Math.min(0.999, relWhole / Math.max(1e-5, measureDurationWhole)));
        const bucketKey = Math.round(frac * 1000);
        const noteScoreBeat = span.startBeat + frac * span.beatsInMeasure;
        const noteOnsetSec = span.startSec + frac * (span.endSec - span.startSec);

        for (const gve of se.graphicalVoiceEntries ?? []) {
          for (const gNote of gve.notes ?? []) {
            const noteSvg = gNote.getSVGGElement?.();
            if (!noteSvg) continue;

            const nRect = noteSvg.getBoundingClientRect();
            let nLeft: number;
            let nRight: number;
            if (nRect.width > 0 || nRect.height > 0) {
              nLeft = nRect.left - containerRect.left;
              nRight = nLeft + Math.max(8, nRect.width);
            } else if (typeof gNote.PositionAndShape?.AbsolutePosition?.x === "number") {
              nLeft = gNote.PositionAndShape.AbsolutePosition.x * 10 * zoom;
              nRight = nLeft + 10 * zoom;
            } else {
              nLeft = minLeft + maxBeginInstrPx + frac * Math.max(12, maxRight - minLeft - maxBeginInstrPx);
              nRight = nLeft + 10;
            }
            const nCenter = (nLeft + nRight) / 2;

            const existing = anchorBuckets.get(bucketKey);
            if (!existing) {
              anchorBuckets.set(bucketKey, { frac, left: nLeft, right: nRight });
            } else {
              existing.left = Math.min(existing.left, nLeft);
              existing.right = Math.max(existing.right, nRight);
            }

            const src = gNote.sourceNote;
            const isRest = Boolean(src?.isRest?.() || !src?.Pitch?.getHalfTone);
            const midi = !isRest && src?.Pitch?.getHalfTone ? src.Pitch.getHalfTone() + 12 : null;

            let matchedUid: string | null = null;
            if (midi !== null && domainPool.length > 0) {
              let bestIdx = -1;
              let bestDelta = Infinity;
              for (let di = 0; di < domainPool.length; di++) {
                if (usedDomainIdx.has(di)) continue;
                const cand = domainPool[di];
                if (cand.midi !== midi) continue;
                const delta = Math.abs(cand.onsetSec - noteOnsetSec);
                if (delta < bestDelta) {
                  bestDelta = delta;
                  bestIdx = di;
                }
              }
              if (bestIdx !== -1) {
                usedDomainIdx.add(bestIdx);
                matchedUid = domainPool[bestIdx].noteUid;
              }
            }

            const svgSet = new Set<Element>();
            const beamSet = new Set<Element>();
            svgSet.add(noteSvg);

            const beamKey = gNote.vfnote?.[0]?.beam ?? src?.NoteBeam ?? null;

            try {
              const stem = gNote.getStemSVG?.();
              if (stem) svgSet.add(stem);
              const flag = gNote.getFlagSVG?.();
              if (flag) svgSet.add(flag);
              for (const b of gNote.getBeamSVGs?.() ?? []) {
                if (b) {
                  svgSet.add(b);
                  beamSet.add(b);
                }
              }
              for (const l of gNote.getLedgerLineSVGs?.() ?? []) {
                if (l) svgSet.add(l);
              }
              for (const t of gNote.getTieSVGs?.() ?? []) {
                if (t) svgSet.add(t);
              }
              for (const mod of gNote.getModifierSVGs?.() ?? []) {
                if (mod && !isFingeringModifierElement(mod)) {
                  svgSet.add(mod);
                }
              }
            } catch {
              // Some OSMD rests or special notes throw inside individual getters; noteSvg suffices.
            }

            if (beamKey) {
              let entry = beamGroupRegistry.get(beamKey);
              if (!entry) {
                entry = {
                  id: `beam-${totalBeamGroupCounter++}`,
                  elements: new Set<Element>(),
                };
                beamGroupRegistry.set(beamKey, entry);
              }
              for (const b of beamSet) {
                entry.elements.add(b);
              }
            }

            const ref: EhsGraphicalNoteRef = {
              id: `m${m}-n${noteCounter++}`,
              measureIndex: m,
              scoreBeat: noteScoreBeat,
              onsetSec: noteOnsetSec,
              midi,
              isRest,
              noteUid: matchedUid,
              centerX: nCenter,
              beamGroupId: null,
              beamElements: [],
              svgElements: [],
            };
            measureNoteEntries.push({ ref, beamKey, svgSet, beamSet });
          }
        }
      }
    }

    // Attach shared beam SVG elements to every note in the same VexFlow/OSMD beam group
    // so beam max-opacity pooling prevents premature beam fracturing.
    for (const item of measureNoteEntries) {
      if (item.beamKey) {
        const reg = beamGroupRegistry.get(item.beamKey);
        if (reg) {
          item.ref.beamGroupId = reg.id;
          for (const b of reg.elements) {
            item.beamSet.add(b);
            item.svgSet.add(b);
          }
        }
      } else if (item.beamSet.size > 0) {
        item.ref.beamGroupId = `beam-local-${item.ref.id}`;
      }
      item.ref.beamElements = Array.from(item.beamSet);
      item.ref.svgElements = Array.from(item.svgSet);
      allNotes.push(item.ref);
    }

    const anchors: EhsBeatAnchor[] = Array.from(anchorBuckets.values())
      .sort((a, b) => a.frac - b.frac)
      .map((b) => ({
        frac: b.frac,
        scoreBeat: span.startBeat + b.frac * span.beatsInMeasure,
        left: b.left,
        centerX: (b.left + b.right) / 2,
        right: b.right,
      }));

    const firstAnchorLeft = anchors.length > 0 ? anchors[0].left : minLeft + Math.max(10, maxBeginInstrPx);
    const clefGuardLeft = maxBeginInstrPx > 0 ? minLeft + maxBeginInstrPx : minLeft + 4;
    const contentLeft = Math.max(
      minLeft + 4,
      Math.min(maxRight - 10, Math.max(firstAnchorLeft - 7, clefGuardLeft - 2)),
    );

    measures.push({
      measureIndex: m,
      systemIndex,
      left: minLeft,
      right: maxRight,
      top: minTop,
      bottom: maxBottom,
      width: maxRight - minLeft,
      height: maxBottom - minTop,
      contentLeft,
      startBeat: span.startBeat,
      beatsInMeasure: span.beatsInMeasure,
      endBeat: span.endBeat,
      startSec: span.startSec,
      endSec: span.endSec,
      anchors,
    });
  }

  const systemsMap = new Map<number, EhsSystemRow>();
  for (const m of measures) {
    const existing = systemsMap.get(m.systemIndex);
    if (!existing) {
      systemsMap.set(m.systemIndex, {
        systemIndex: m.systemIndex,
        measureIndices: [m.measureIndex],
        left: m.left,
        right: m.right,
        contentLeft: m.contentLeft,
        top: m.top,
        bottom: m.bottom,
        height: m.height,
        startBeat: m.startBeat,
        endBeat: m.endBeat,
      });
    } else {
      existing.measureIndices.push(m.measureIndex);
      existing.left = Math.min(existing.left, m.left);
      existing.right = Math.max(existing.right, m.right);
      existing.top = Math.min(existing.top, m.top);
      existing.bottom = Math.max(existing.bottom, m.bottom);
      existing.height = existing.bottom - existing.top;
      existing.startBeat = Math.min(existing.startBeat, m.startBeat);
      existing.endBeat = Math.max(existing.endBeat, m.endBeat);
    }
  }

  const systems = Array.from(systemsMap.values()).sort((a, b) => a.systemIndex - b.systemIndex);
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();

  let maxRightPx = container.scrollWidth || containerRect.width;
  let maxBottomPx = container.scrollHeight || containerRect.height;
  for (const s of systems) {
    maxRightPx = Math.max(maxRightPx, s.right + 16);
    maxBottomPx = Math.max(maxBottomPx, s.bottom + 16);
  }

  return {
    measures,
    systems,
    notes: allNotes,
    sharedBeamGroupCount: beamGroupRegistry.size,
    containerWidth: maxRightPx,
    containerHeight: maxBottomPx,
    extractMs: Math.round((t1 - t0) * 100) / 100,
  };
}

function setRectAttrs(
  rect: SVGRectElement,
  attrs: { x: number; y: number; width: number; height: number } | null,
  cache: { key: string },
) {
  if (!attrs || attrs.width <= 0 || attrs.height <= 0) {
    if (cache.key !== "hidden") {
      cache.key = "hidden";
      rect.style.display = "none";
    }
    return;
  }
  const rx = Math.round(attrs.x * 10) / 10;
  const ry = Math.round(attrs.y * 10) / 10;
  const rw = Math.round(attrs.width * 10) / 10;
  const rh = Math.round(attrs.height * 10) / 10;
  const nextKey = `${rx},${ry},${rw},${rh}`;
  if (cache.key === nextKey) return;
  if (cache.key === "hidden" || cache.key === "") {
    rect.style.display = "";
  }
  cache.key = nextKey;
  rect.setAttribute("x", String(rx));
  rect.setAttribute("y", String(ry));
  rect.setAttribute("width", String(rw));
  rect.setAttribute("height", String(rh));
}

/**
 * Creates an imperative Hybrid B + C OSMD SVG overlay applier strictly outside React state.
 * Mutates only note/stem/beam/ledger/tie/flag/non-fingering-modifier SVG element opacities
 * (preserving staves, barlines, clefs, key/time signatures at 100%) and updates the lightweight
 * Hybrid C reading spotlight + page pre-scroll in < 1 ms/frame.
 */
export function createEhsOsmdOverlayApplier(container: HTMLElement) {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const lastOpacityByEl = new Map<Element, number>();
  const targetOpacityByEl = new Map<Element, number>();
  const touchedEls = new Set<Element>();

  let overlaySvg: SVGSVGElement | null = null;
  let spotlightRectEl: SVGRectElement | null = null;
  let nextSpotlightRectEl: SVGRectElement | null = null;
  let rescueMeasureRectEl: SVGRectElement | null = null;
  let handCursorLineEl: SVGLineElement | null = null;
  const spotCache = { key: "" };
  const nextSpotCache = { key: "" };
  const rescueCache = { key: "" };
  let lastCursorKey = "";

  let cachedGeoRef: EhsExtractedGeometry | null = null;
  let cachedMeasureSummaries: EhsVisualInspection["measures"] = [];
  let cachedClefZonesProtected = true;
  let cachedNoteOpacities = new Float64Array(0);
  let lastPreScrolledSystemIdx = -1;
  let frameCount = 0;
  let lastInspection: EhsVisualInspection | null = null;

  const ensureOverlayNodes = (geo: EhsExtractedGeometry) => {
    if (!overlaySvg || overlaySvg.parentElement !== container) {
      if (getComputedStyleSafe(container) === "static") {
        container.style.position = "relative";
      }
      const doc = container.ownerDocument;
      overlaySvg = doc.createElementNS(SVG_NS, "svg");
      overlaySvg.setAttribute("data-testid", "ehs-overlay-svg");
      overlaySvg.setAttribute("aria-hidden", "true");
      overlaySvg.style.position = "absolute";
      overlaySvg.style.left = "0";
      overlaySvg.style.top = "0";
      overlaySvg.style.pointerEvents = "none";
      overlaySvg.style.zIndex = "20";
      overlaySvg.style.overflow = "visible";

      const defs = doc.createElementNS(SVG_NS, "defs");
      const grad = doc.createElementNS(SVG_NS, "linearGradient");
      grad.setAttribute("id", "ehs-prod-spotlight");
      grad.setAttribute("x1", "0%");
      grad.setAttribute("y1", "0%");
      grad.setAttribute("x2", "100%");
      grad.setAttribute("y2", "0%");
      const s0 = doc.createElementNS(SVG_NS, "stop");
      s0.setAttribute("offset", "0%");
      s0.setAttribute("stop-color", "#10b981");
      s0.setAttribute("stop-opacity", "0.14");
      const s1 = doc.createElementNS(SVG_NS, "stop");
      s1.setAttribute("offset", "70%");
      s1.setAttribute("stop-color", "#10b981");
      s1.setAttribute("stop-opacity", "0.07");
      const s2 = doc.createElementNS(SVG_NS, "stop");
      s2.setAttribute("offset", "100%");
      s2.setAttribute("stop-color", "#10b981");
      s2.setAttribute("stop-opacity", "0");
      grad.appendChild(s0);
      grad.appendChild(s1);
      grad.appendChild(s2);
      defs.appendChild(grad);
      overlaySvg.appendChild(defs);

      spotlightRectEl = doc.createElementNS(SVG_NS, "rect");
      spotlightRectEl.setAttribute("data-testid", "ehs-spotlight-rect");
      spotlightRectEl.setAttribute("rx", "6");
      spotlightRectEl.setAttribute("fill", "url(#ehs-prod-spotlight)");
      spotlightRectEl.style.display = "none";
      overlaySvg.appendChild(spotlightRectEl);

      nextSpotlightRectEl = doc.createElementNS(SVG_NS, "rect");
      nextSpotlightRectEl.setAttribute("data-testid", "ehs-next-spotlight-rect");
      nextSpotlightRectEl.setAttribute("rx", "6");
      nextSpotlightRectEl.setAttribute("fill", "url(#ehs-prod-spotlight)");
      nextSpotlightRectEl.style.display = "none";
      overlaySvg.appendChild(nextSpotlightRectEl);

      rescueMeasureRectEl = doc.createElementNS(SVG_NS, "rect");
      rescueMeasureRectEl.setAttribute("data-testid", "ehs-rescue-measure-rect");
      rescueMeasureRectEl.setAttribute("rx", "6");
      rescueMeasureRectEl.setAttribute("fill", "rgba(251, 191, 36, 0.14)");
      rescueMeasureRectEl.setAttribute("stroke", "#f59e0b");
      rescueMeasureRectEl.setAttribute("stroke-width", "2");
      rescueMeasureRectEl.setAttribute("stroke-dasharray", "6,3");
      rescueMeasureRectEl.style.display = "none";
      overlaySvg.appendChild(rescueMeasureRectEl);

      handCursorLineEl = doc.createElementNS(SVG_NS, "line");
      handCursorLineEl.setAttribute("data-testid", "ehs-hand-cursor");
      handCursorLineEl.setAttribute("stroke", "rgba(79, 70, 229, 0.42)");
      handCursorLineEl.setAttribute("stroke-width", "1.5");
      handCursorLineEl.style.display = "none";
      overlaySvg.appendChild(handCursorLineEl);

      container.appendChild(overlaySvg);
      overlaySvg.setAttribute("width", String(Math.max(1, Math.ceil(geo.containerWidth))));
      overlaySvg.setAttribute("height", String(Math.max(1, Math.ceil(geo.containerHeight))));
    } else if (cachedGeoRef !== geo) {
      overlaySvg.setAttribute("width", String(Math.max(1, Math.ceil(geo.containerWidth))));
      overlaySvg.setAttribute("height", String(Math.max(1, Math.ceil(geo.containerHeight))));
    }
  };

  const restoreAllNoteOpacities = () => {
    for (const el of touchedEls) {
      const style = (el as SVGElement).style;
      if (style) {
        style.opacity = "";
      }
    }
    touchedEls.clear();
    lastOpacityByEl.clear();
  };

  const hideOverlayVisuals = () => {
    if (spotlightRectEl && spotCache.key !== "hidden") {
      spotCache.key = "hidden";
      spotlightRectEl.style.display = "none";
    }
    if (nextSpotlightRectEl && nextSpotCache.key !== "hidden") {
      nextSpotCache.key = "hidden";
      nextSpotlightRectEl.style.display = "none";
    }
    if (rescueMeasureRectEl && rescueCache.key !== "hidden") {
      rescueCache.key = "hidden";
      rescueMeasureRectEl.style.display = "none";
    }
    if (handCursorLineEl && lastCursorKey !== "hidden") {
      lastCursorKey = "hidden";
      handCursorLineEl.style.display = "none";
    }
  };

  const buildNoteInspectionArray = (geo: EhsExtractedGeometry): EhsNoteVisualState[] => {
    const out: EhsNoteVisualState[] = new Array(geo.notes.length);
    for (let i = 0; i < geo.notes.length; i++) {
      const n = geo.notes[i];
      const op = i < cachedNoteOpacities.length ? cachedNoteOpacities[i] : 1;
      let beamOp: number | null = null;
      if (n.beamElements.length > 0) {
        const recorded = lastOpacityByEl.get(n.beamElements[0]);
        beamOp = recorded !== undefined ? recorded : 1;
      }
      out[i] = {
        id: n.id,
        measureIndex: n.measureIndex,
        scoreBeat: n.scoreBeat,
        noteUid: n.noteUid,
        midi: n.midi,
        opacity: op,
        beamGroupId: n.beamGroupId,
        beamElementCount: n.beamElements.length,
        beamOpacity: beamOp,
      };
    }
    return out;
  };

  return {
    reset() {
      restoreAllNoteOpacities();
      hideOverlayVisuals();
      lastPreScrolledSystemIdx = -1;
      frameCount = 0;
      lastInspection = null;
      if (overlaySvg && overlaySvg.parentElement === container) {
        overlaySvg.remove();
      }
      spotCache.key = "";
      nextSpotCache.key = "";
      rescueCache.key = "";
      lastCursorKey = "";
      cachedGeoRef = null;
      cachedMeasureSummaries = [];
      cachedClefZonesProtected = true;
      overlaySvg = null;
      spotlightRectEl = null;
      nextSpotlightRectEl = null;
      rescueMeasureRectEl = null;
      handCursorLineEl = null;
    },

    applyFrame(
      geo: EhsExtractedGeometry,
      snapshot: EhsFrameSnapshot | null,
      options?: { layoutMode?: ScoreLayoutMode; scrollContainer?: HTMLElement | null },
    ): EhsVisualInspection {
      const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (cachedGeoRef !== geo) {
        cachedMeasureSummaries = geo.measures.map((m) => ({
          measureIndex: m.measureIndex,
          systemIndex: m.systemIndex,
          left: m.left,
          contentLeft: m.contentLeft,
          right: m.right,
          top: m.top,
          bottom: m.bottom,
        }));
        cachedClefZonesProtected =
          geo.measures.length === 0 || geo.measures.every((m) => m.contentLeft > m.left);
      }
      const measureSummaries = cachedMeasureSummaries;
      const clefZonesProtected = cachedClefZonesProtected;

      if (!snapshot || !snapshot.active) {
        restoreAllNoteOpacities();
        hideOverlayVisuals();
        lastPreScrolledSystemIdx = -1;
        cachedGeoRef = geo;
        cachedNoteOpacities = new Float64Array(geo.notes.length).fill(1);
        const dt = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
        const inactive: EhsVisualInspection = {
          active: false,
          isMasked: false,
          extractMs: geo.extractMs,
          lastFrameMs: Math.round(dt * 1000) / 1000,
          frameCount,
          noteCount: geo.notes.length,
          sharedBeamGroupCount: geo.sharedBeamGroupCount,
          measureCount: geo.measures.length,
          systemCount: geo.systems.length,
          measures: measureSummaries,
          spotlightRect: null,
          nextSystemSpotlightRect: null,
          rescueMeasureRect: null,
          clefZonesProtected,
          preScrollTargetTop: null,
          notes: [],
        };
        Object.defineProperty(inactive, "notes", {
          enumerable: true,
          get: () => buildNoteInspectionArray(geo),
        });
        lastInspection = inactive;
        return inactive;
      }

      ensureOverlayNodes(geo);
      cachedGeoRef = geo;
      frameCount += 1;

      if (cachedNoteOpacities.length !== geo.notes.length) {
        cachedNoteOpacities = new Float64Array(geo.notes.length);
      }

      targetOpacityByEl.clear();
      const residual = snapshot.ghostOpacity;
      const struck = snapshot.struckNoteUids;
      const flashedMeasure = snapshot.autoStallMeasureIndex;

      for (let i = 0; i < geo.notes.length; i++) {
        const note = geo.notes[i];
        const rawOp = computeEhsNoteOpacity({
          noteScoreBeat: note.scoreBeat,
          frontierBeat: snapshot.frontierBeat,
          ghostOpacity: residual,
          isStruck: Boolean(note.noteUid && struck.has(note.noteUid)),
          isMasked: snapshot.isMasked,
          isMeasureFlashed: flashedMeasure !== null && note.measureIndex === flashedMeasure,
        });
        const quantized = Math.round(rawOp * 50) / 50;
        cachedNoteOpacities[i] = quantized;

        for (let j = 0; j < note.svgElements.length; j++) {
          const el = note.svgElements[j];
          const prev = targetOpacityByEl.get(el);
          if (prev === undefined || quantized > prev) {
            targetOpacityByEl.set(el, quantized);
          }
        }
      }

      for (const [el, nextOp] of targetOpacityByEl.entries()) {
        if (lastOpacityByEl.get(el) !== nextOp) {
          const style = (el as SVGElement).style;
          if (style) {
            style.opacity = nextOp >= 0.99 ? "" : String(nextOp);
            lastOpacityByEl.set(el, nextOp);
            touchedEls.add(el);
          }
        }
      }

      // Hybrid C: lightweight ~1.5-beat forward reading spotlight with clef-zone protection
      const handPt = scoreBeatToCanvasPoint(geo, Math.max(0, snapshot.handBeat));
      const frontierPt = scoreBeatToCanvasPoint(geo, Math.max(0, snapshot.frontierBeat));
      const spotlightEndPt = scoreBeatToCanvasPoint(geo, Math.max(0, snapshot.spotlightEndBeat));

      let spotlightRect: EhsVisualInspection["spotlightRect"] = null;
      let nextSystemSpotlightRect: EhsVisualInspection["nextSystemSpotlightRect"] = null;
      let rescueMeasureRect: EhsVisualInspection["rescueMeasureRect"] = null;

      if (handPt && handCursorLineEl) {
        const cx = Math.round(handPt.x * 10) / 10;
        const cy1 = Math.round((handPt.measure.top - 8) * 10) / 10;
        const cy2 = Math.round((handPt.measure.bottom + 4) * 10) / 10;
        const cKey = `${cx},${cy1},${cy2}`;
        if (lastCursorKey !== cKey) {
          if (lastCursorKey === "hidden" || lastCursorKey === "") {
            handCursorLineEl.style.display = "";
          }
          lastCursorKey = cKey;
          handCursorLineEl.setAttribute("x1", String(cx));
          handCursorLineEl.setAttribute("y1", String(cy1));
          handCursorLineEl.setAttribute("x2", String(cx));
          handCursorLineEl.setAttribute("y2", String(cy2));
        }
      } else if (handCursorLineEl && lastCursorKey !== "hidden") {
        lastCursorKey = "hidden";
        handCursorLineEl.style.display = "none";
      }

      if (snapshot.isMasked && frontierPt && frontierPt.system && spotlightRectEl) {
        const sys = frontierPt.system;
        const spotStartX = Math.max(sys.contentLeft, Math.min(sys.right, frontierPt.x));
        const spotEndX =
          spotlightEndPt && spotlightEndPt.system?.systemIndex === sys.systemIndex
            ? Math.max(spotStartX + 16, Math.min(sys.right + 4, spotlightEndPt.x))
            : sys.right + 4;
        if (spotEndX > spotStartX + 4) {
          spotlightRect = {
            x: spotStartX,
            y: sys.top - 6,
            width: spotEndX - spotStartX,
            height: sys.height + 12,
            systemIndex: sys.systemIndex,
          };
        }
        setRectAttrs(spotlightRectEl, spotlightRect, spotCache);

        const nextSys = geo.systems.find((s) => s.systemIndex === sys.systemIndex + 1);
        if (
          nextSys &&
          spotlightEndPt &&
          spotlightEndPt.system?.systemIndex === nextSys.systemIndex
        ) {
          const w = Math.max(20, Math.min(nextSys.right - nextSys.contentLeft, spotlightEndPt.x - nextSys.contentLeft));
          nextSystemSpotlightRect = {
            x: nextSys.contentLeft,
            y: nextSys.top - 6,
            width: w,
            height: nextSys.height + 12,
            systemIndex: nextSys.systemIndex,
          };
        }
        if (nextSpotlightRectEl) setRectAttrs(nextSpotlightRectEl, nextSystemSpotlightRect, nextSpotCache);
      } else {
        if (spotlightRectEl && spotCache.key !== "hidden") {
          spotCache.key = "hidden";
          spotlightRectEl.style.display = "none";
        }
        if (nextSpotlightRectEl && nextSpotCache.key !== "hidden") {
          nextSpotCache.key = "hidden";
          nextSpotlightRectEl.style.display = "none";
        }
      }

      if (flashedMeasure !== null && rescueMeasureRectEl) {
        const rm = geo.measures.find((m) => m.measureIndex === flashedMeasure) ?? null;
        if (rm) {
          rescueMeasureRect = {
            x: Math.max(rm.left, rm.contentLeft - 4),
            y: rm.top - 8,
            width: Math.max(12, rm.right - Math.max(rm.left, rm.contentLeft - 4) + 4),
            height: rm.height + 16,
            measureIndex: rm.measureIndex,
          };
        }
        setRectAttrs(rescueMeasureRectEl, rescueMeasureRect, rescueCache);
      } else if (rescueMeasureRectEl && rescueCache.key !== "hidden") {
        rescueCache.key = "hidden";
        rescueMeasureRectEl.style.display = "none";
      }

      // Page-mode next-system smooth auto pre-scroll when approaching current system end
      let preScrollTargetTop: number | null = null;
      const scrollContainer = options?.scrollContainer;
      if (
        options?.layoutMode === "page" &&
        scrollContainer &&
        handPt?.system
      ) {
        const activeSys = handPt.system;
        const nextSys = geo.systems.find((s) => s.systemIndex === activeSys.systemIndex + 1) ?? null;
        if (nextSys) {
          const remainingBeats = activeSys.endBeat - snapshot.handBeat;
          const sysWidth = Math.max(1, activeSys.right - activeSys.contentLeft);
          const xProgress = (handPt.x - activeSys.contentLeft) / sysWidth;
          const nearSystemEnd =
            remainingBeats <= Math.max(1.5, snapshot.lookaheadBeats) || xProgress >= 0.72;
          const viewportBottom = scrollContainer.scrollTop + scrollContainer.clientHeight;
          const nextSystemNeedsScroll =
            nextSys.bottom > viewportBottom - 20 || nextSys.top > viewportBottom - 40;

          if (
            nearSystemEnd &&
            nextSystemNeedsScroll &&
            lastPreScrolledSystemIdx !== activeSys.systemIndex
          ) {
            lastPreScrolledSystemIdx = activeSys.systemIndex;
            const targetTop = Math.max(0, Math.round(activeSys.top - 12));
            preScrollTargetTop = targetTop;
            if (typeof scrollContainer.scrollTo === "function") {
              scrollContainer.scrollTo({ top: targetTop, behavior: "smooth" });
            } else {
              scrollContainer.scrollTop = targetTop;
            }
          }
        }
      }

      const dt = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
      const inspection: EhsVisualInspection = {
        active: true,
        isMasked: snapshot.isMasked,
        extractMs: geo.extractMs,
        lastFrameMs: Math.round(dt * 1000) / 1000,
        frameCount,
        noteCount: geo.notes.length,
        sharedBeamGroupCount: geo.sharedBeamGroupCount,
        measureCount: geo.measures.length,
        systemCount: geo.systems.length,
        measures: measureSummaries,
        spotlightRect,
        nextSystemSpotlightRect,
        rescueMeasureRect,
        clefZonesProtected,
        preScrollTargetTop,
        notes: [],
      };
      Object.defineProperty(inspection, "notes", {
        enumerable: true,
        get: () => buildNoteInspectionArray(geo),
      });
      lastInspection = inspection;
      return inspection;
    },

    getInspection() {
      return lastInspection;
    },
  };
}

function getComputedStyleSafe(el: HTMLElement): string {
  try {
    return el.style?.position || globalThis.getComputedStyle?.(el)?.position || "static";
  } catch {
    return el.style?.position || "static";
  }
}
