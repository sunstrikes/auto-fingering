import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import type { NoteEvent, ScoreDocument } from "../../domain/types";
import type { ScoreLayoutMode } from "../ScoreViewer";
import type {
  EhsBeatAnchor,
  EhsExtractedGeometry,
  EhsGraphicalNoteRef,
  EhsMeasureBox,
  EhsSystemRow,
} from "./ehsPrototypeTypes";

export interface MeasureBeatSpan {
  measureIndex: number;
  startBeat: number;
  beatsInMeasure: number;
  endBeat: number;
  startSec: number;
  endSec: number;
  timeBeats: number;
  timeBeatType: number;
}

/**
 * Builds a monotonic continuous beat axis aligned with `MeasureTimeline` and `metronome.ts`.
 */
export function buildMeasureBeatSpans(scoreDoc: ScoreDocument | null): MeasureBeatSpan[] {
  if (!scoreDoc || scoreDoc.measureTimelines.length === 0) return [];
  const tpq = Math.max(1, scoreDoc.ticksPerQuarter || 480);
  const spans: MeasureBeatSpan[] = [];
  let cursorBeat = 0;

  for (const tl of scoreDoc.measureTimelines) {
    const ticksPerBeat = (4 * tpq) / Math.max(1, tl.timeBeatType || 4);
    const rawBeats =
      tl.endTick > tl.startTick ? (tl.endTick - tl.startTick) / ticksPerBeat : tl.timeBeats || 4;
    const beatsInMeasure = Math.max(0.25, Math.round(rawBeats * 1000) / 1000);
    spans.push({
      measureIndex: tl.measureIndex,
      startBeat: cursorBeat,
      beatsInMeasure,
      endBeat: cursorBeat + beatsInMeasure,
      startSec: tl.startSec,
      endSec: Math.max(tl.startSec + 0.05, tl.endSec),
      timeBeats: tl.timeBeats || 4,
      timeBeatType: tl.timeBeatType || 4,
    });
    cursorBeat += beatsInMeasure;
  }

  return spans;
}

/**
 * Converts continuous score time (`scoreSec`) into continuous score beats + measure index.
 */
export function scoreSecToBeat(
  spans: MeasureBeatSpan[],
  scoreSec: number
): { scoreBeat: number; measureIndex: number; beatInMeasure: number; beatsInMeasure: number } {
  if (spans.length === 0) {
    return { scoreBeat: 0, measureIndex: 0, beatInMeasure: 0, beatsInMeasure: 4 };
  }
  const clampedSec = Math.max(0, scoreSec);

  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    if (clampedSec < sp.endSec || i === spans.length - 1) {
      const dur = Math.max(0.05, sp.endSec - sp.startSec);
      const frac = Math.max(0, Math.min(1, (clampedSec - sp.startSec) / dur));
      const beatInMeasure = frac * sp.beatsInMeasure;
      return {
        scoreBeat: sp.startBeat + beatInMeasure,
        measureIndex: sp.measureIndex,
        beatInMeasure,
        beatsInMeasure: sp.beatsInMeasure,
      };
    }
  }

  const last = spans[spans.length - 1];
  return {
    scoreBeat: last.endBeat,
    measureIndex: last.measureIndex,
    beatInMeasure: last.beatsInMeasure,
    beatsInMeasure: last.beatsInMeasure,
  };
}

/**
 * Converts a continuous score beat back into `{ measureIndex, beatInMeasure, frac, scoreSec }`.
 */
export function beatToMeasurePosition(
  spans: MeasureBeatSpan[],
  scoreBeat: number
): { measureIndex: number; beatInMeasure: number; frac: number; scoreSec: number; beatsInMeasure: number } {
  if (spans.length === 0) {
    return { measureIndex: 0, beatInMeasure: 0, frac: 0, scoreSec: 0, beatsInMeasure: 4 };
  }
  if (scoreBeat <= 0) {
    const first = spans[0];
    return {
      measureIndex: first.measureIndex,
      beatInMeasure: 0,
      frac: 0,
      scoreSec: first.startSec,
      beatsInMeasure: first.beatsInMeasure,
    };
  }

  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    if (scoreBeat < sp.endBeat || i === spans.length - 1) {
      const beatInMeasure = Math.max(0, Math.min(sp.beatsInMeasure, scoreBeat - sp.startBeat));
      const frac = sp.beatsInMeasure > 0 ? beatInMeasure / sp.beatsInMeasure : 0;
      return {
        measureIndex: sp.measureIndex,
        beatInMeasure,
        frac,
        scoreSec: sp.startSec + frac * (sp.endSec - sp.startSec),
        beatsInMeasure: sp.beatsInMeasure,
      };
    }
  }

  const last = spans[spans.length - 1];
  return {
    measureIndex: last.measureIndex,
    beatInMeasure: last.beatsInMeasure,
    frac: 1,
    scoreSec: last.endSec,
    beatsInMeasure: last.beatsInMeasure,
  };
}

/**
 * Piecewise-linear interpolation mapping any beat fraction `frac in [0, 1]` inside a measure
 * onto true OSMD engraved pixel X (respecting clef/key-sig padding and non-uniform spacing).
 */
export function fracToMeasureX(box: EhsMeasureBox, frac: number): number {
  const f = Math.max(0, Math.min(1, frac));
  const contentRight = Math.max(box.contentLeft + 6, box.right - 3);
  if (f <= 0) return box.contentLeft;
  if (f >= 1) return contentRight;

  if (box.anchors.length === 0) {
    return box.contentLeft + f * (contentRight - box.contentLeft);
  }

  // Build monotonic control points: (0, contentLeft) -> anchors -> (1, contentRight)
  const pts: Array<{ f: number; x: number }> = [{ f: 0, x: box.contentLeft }];
  let lastX = box.contentLeft;

  for (const a of box.anchors) {
    const af = Math.max(0, Math.min(0.999, a.frac));
    const ax = Math.max(lastX, Math.min(contentRight, a.left - 3));
    if (af <= pts[pts.length - 1].f + 1e-4) {
      // Same timestamp bucket: keep earliest start edge
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
 * Maps a continuous scoreBeat to `{ measureBox, systemRow, x }` inside extracted OSMD geometry.
 */
export function scoreBeatToCanvasPoint(
  geo: EhsExtractedGeometry,
  scoreBeat: number
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

interface VexNoteLike {
  sourceNote?: {
    Pitch?: { getHalfTone?: () => number };
    isRest?: () => boolean;
    ParentStaffEntry?: { Timestamp?: { RealValue?: number } };
  };
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
  getSVGGElement?: () => SVGGElement | undefined;
  staffEntries?: Array<{
    relInMeasureTimestamp?: { RealValue?: number };
    graphicalVoiceEntries?: Array<{
      notes?: VexNoteLike[];
    }>;
  }>;
}

/**
 * Extracts exact pixel-space measure boxes, system rows, staffEntry beat anchors,
 * and per-note VexFlow SVG references from the live rendered OSMD instance.
 */
export function extractEhsOsmdGeometry(
  osmd: OpenSheetMusicDisplay | null,
  container: HTMLElement | null,
  scoreDoc: ScoreDocument | null,
  layoutMode: ScoreLayoutMode
): EhsExtractedGeometry {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const empty: EhsExtractedGeometry = {
    measures: [],
    systems: [],
    notes: [],
    containerWidth: container?.scrollWidth ?? 0,
    containerHeight: container?.scrollHeight ?? 0,
    extractMs: 0,
    extractedAt: t0,
  };

  if (!osmd || !container) return empty;
  const measureList = osmd.GraphicSheet?.MeasureList as GraphicalMeasureLike[][] | undefined;
  if (!measureList || measureList.length === 0) return empty;

  const containerRect = container.getBoundingClientRect();
  const beatSpans = buildMeasureBeatSpans(scoreDoc);

  // Index domain NoteEvents by measure for noteUid lookup (used by Variant B MIDI-struck dissolve)
  const domainNotesByMeasure = new Map<number, NoteEvent[]>();
  if (scoreDoc) {
    for (const ev of scoreDoc.noteEvents) {
      if (ev.isTieStop) continue;
      const list = domainNotesByMeasure.get(ev.measureIndex) ?? [];
      list.push(ev);
      domainNotesByMeasure.set(ev.measureIndex, list);
    }
  }

  const systemObjectToIdx = new Map<unknown, number>();
  const systemTopBuckets: Array<{ top: number; idx: number }> = [];
  const measures: EhsMeasureBox[] = [];
  const allNotes: EhsGraphicalNoteRef[] = [];

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

    for (const gm of row) {
      if (!gm) continue;
      if (!musicSystemObj && gm.ParentMusicSystem) {
        musicSystemObj = gm.ParentMusicSystem;
      }
      const d = gm.parentSourceMeasure?.Duration?.RealValue;
      if (typeof d === "number" && d > 0) {
        measureDurationWhole = Math.max(measureDurationWhole, d);
      }
      const el = gm.getSVGGElement?.();
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;
      const left = rect.left - containerRect.left;
      const top = rect.top - containerRect.top;
      minLeft = Math.min(minLeft, left);
      maxRight = Math.max(maxRight, left + rect.width);
      minTop = Math.min(minTop, top);
      maxBottom = Math.max(maxBottom, top + rect.height);
    }

    if (!Number.isFinite(minLeft) || !Number.isFinite(minTop) || maxRight <= minLeft) {
      continue;
    }

    if (measureDurationWhole <= 0) {
      measureDurationWhole = span.beatsInMeasure / Math.max(1, span.timeBeatType || 4);
    }

    // Determine visual system row index
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

    // Collect staffEntry anchors and VexFlow note SVG references across all staves
    const anchorBuckets = new Map<number, { frac: number; left: number; right: number }>();
    const domainPool = domainNotesByMeasure.get(m) ?? [];
    const usedDomainIdx = new Set<number>();
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
            const nLeft = nRect.left - containerRect.left;
            const nRight = nLeft + Math.max(8, nRect.width);
            const nCenter = (nLeft + nRight) / 2;

            if (nRect.width > 0 || nRect.height > 0) {
              const existing = anchorBuckets.get(bucketKey);
              if (!existing) {
                anchorBuckets.set(bucketKey, { frac, left: nLeft, right: nRight });
              } else {
                existing.left = Math.min(existing.left, nLeft);
                existing.right = Math.max(existing.right, nRight);
              }
            }

            const src = gNote.sourceNote;
            const isRest = Boolean(src?.isRest?.() || !src?.Pitch?.getHalfTone);
            const midi = !isRest && src?.Pitch?.getHalfTone ? src.Pitch.getHalfTone() + 12 : null;

            // Match domain noteUid best-effort by pitch + closest onsetSec
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

            // Collect all VexFlow SVG elements for this note (for Variant B in-place dissolution)
            const svgSet = new Set<Element>();
            svgSet.add(noteSvg);
            try {
              const stem = gNote.getStemSVG?.();
              if (stem) svgSet.add(stem);
              const flag = gNote.getFlagSVG?.();
              if (flag) svgSet.add(flag);
              for (const b of gNote.getBeamSVGs?.() ?? []) {
                if (b) svgSet.add(b);
              }
              for (const l of gNote.getLedgerLineSVGs?.() ?? []) {
                if (l) svgSet.add(l);
              }
              for (const t of gNote.getTieSVGs?.() ?? []) {
                if (t) svgSet.add(t);
              }
              for (const mod of gNote.getModifierSVGs?.() ?? []) {
                if (mod) svgSet.add(mod);
              }
            } catch {
              // Some OSMD rests or special notes throw inside individual getters; noteSvg suffices
            }

            allNotes.push({
              id: `m${m}-n${noteCounter++}`,
              measureIndex: m,
              scoreBeat: noteScoreBeat,
              onsetSec: noteOnsetSec,
              midi,
              isRest,
              noteUid: matchedUid,
              centerX: nCenter,
              svgElements: Array.from(svgSet),
            });
          }
        }
      }
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

    // Preserve clef/key/time signature at start of line by starting contentLeft just before first note
    const firstAnchorLeft = anchors.length > 0 ? anchors[0].left : minLeft + 10;
    const contentLeft = Math.max(minLeft + 4, Math.min(maxRight - 10, firstAnchorLeft - 7));

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

  // Build visual system rows from measures
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
      // contentLeft stays the first measure's contentLeft on this system
      existing.top = Math.min(existing.top, m.top);
      existing.bottom = Math.max(existing.bottom, m.bottom);
      existing.height = existing.bottom - existing.top;
      existing.startBeat = Math.min(existing.startBeat, m.startBeat);
      existing.endBeat = Math.max(existing.endBeat, m.endBeat);
    }
  }

  const systems = Array.from(systemsMap.values()).sort((a, b) => a.systemIndex - b.systemIndex);
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();

  return {
    measures,
    systems,
    notes: allNotes,
    containerWidth: Math.max(container.scrollWidth, containerRect.width),
    containerHeight: Math.max(container.scrollHeight, containerRect.height),
    extractMs: Math.round((t1 - t0) * 100) / 100,
    extractedAt: t1,
  };
}
