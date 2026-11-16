import type {
  Finger,
  Hand,
  MeasureTimeline,
  NoteEvent,
  OnsetSlice,
  ScoreDocument,
  TempoPoint,
  TimeSignaturePoint,
} from "../domain/types";
import {
  findDirectChild as firstDirectChild,
  findDirectChildren as directChildrenByTag,
  textOfDirectChild as textOfChild,
} from "./xmlHelpers";

export interface XmlDomDeps {
  DOMParser?: typeof DOMParser;
  XMLSerializer?: typeof XMLSerializer;
}

export interface ParseMusicXmlOptions extends XmlDomDeps {
  singleStaffHandOverride?: Hand;
}

const STEP_TO_SEMITONE: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}

function extractXmlDeclaration(xmlText: string): string {
  const trimmed = xmlText.replace(/^\uFEFF/, "");
  const match = trimmed.match(/^<\?xml\s[^?]*\?>/i);
  return match ? match[0] : '<?xml version="1.0" encoding="UTF-8"?>';
}

function normalizeTempoPoints(tempoPoints: TempoPoint[]): TempoPoint[] {
  const sorted = [...tempoPoints].sort((a, b) => a.tick - b.tick);
  const timeline: TempoPoint[] = [{ tick: 0, bpm: 100 }];
  for (const pt of sorted) {
    const last = timeline[timeline.length - 1];
    if (pt.tick <= last.tick) {
      last.bpm = pt.bpm;
    } else {
      timeline.push({ tick: pt.tick, bpm: pt.bpm });
    }
  }
  return timeline;
}

function normalizeTimeSignaturePoints(points: TimeSignaturePoint[]): TimeSignaturePoint[] {
  const sorted = [...points].sort((a, b) => a.tick - b.tick);
  const timeline: TimeSignaturePoint[] = [{ tick: 0, beats: 4, beatType: 4 }];
  for (const pt of sorted) {
    const last = timeline[timeline.length - 1];
    if (pt.tick <= last.tick) {
      last.beats = pt.beats;
      last.beatType = pt.beatType;
    } else {
      timeline.push({ tick: pt.tick, beats: pt.beats, beatType: pt.beatType });
    }
  }
  return timeline;
}

function buildTickToSecMapper(
  timeline: TempoPoint[],
  ticksPerQuarter: number
): (tick: number) => number {
  // Precompute cumulative seconds at each tempo change point
  const prefixSec: number[] = [0];
  for (let i = 1; i < timeline.length; i++) {
    const prev = timeline[i - 1];
    const curr = timeline[i];
    const deltaQuarters = (curr.tick - prev.tick) / ticksPerQuarter;
    prefixSec.push(prefixSec[i - 1] + deltaQuarters * (60 / prev.bpm));
  }

  return (tick: number): number => {
    if (tick <= 0) return 0;
    let lo = 0;
    let hi = timeline.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (timeline[mid].tick <= tick) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const seg = timeline[lo];
    const deltaQuarters = (tick - seg.tick) / ticksPerQuarter;
    return prefixSec[lo] + deltaQuarters * (60 / seg.bpm);
  };
}

function computeDivisionsLcm(parts: Element[]): number {
  let currentLcm = 1;
  for (const part of parts) {
    for (const measure of directChildrenByTag(part, "measure")) {
      for (const attrs of directChildrenByTag(measure, "attributes")) {
        const divText = textOfChild(attrs, "divisions");
        if (divText) {
          const divVal = Number.parseInt(divText, 10);
          if (Number.isFinite(divVal) && divVal > 0) {
            currentLcm = lcm(currentLcm, divVal);
          }
        }
      }
    }
  }
  return currentLcm;
}

function pitchToMidi(pitchEl: Element): number {
  const step = (textOfChild(pitchEl, "step") ?? "C").toUpperCase();
  const alterText = textOfChild(pitchEl, "alter");
  const octaveText = textOfChild(pitchEl, "octave") ?? "4";
  const alter = alterText ? Number.parseFloat(alterText) : 0;
  const octave = Number.parseInt(octaveText, 10);
  const semitone = STEP_TO_SEMITONE[step] ?? 0;
  return (octave + 1) * 12 + semitone + Math.round(alter);
}

function extractAnchorFingers(noteEl: Element): {
  anchorFinger?: Finger;
  anchorExitFinger?: Finger;
  fingeringEl?: Element;
} {
  for (const notations of directChildrenByTag(noteEl, "notations")) {
    for (const technical of directChildrenByTag(notations, "technical")) {
      for (const fingering of directChildrenByTag(technical, "fingering")) {
        if (
          fingering.getAttribute("alternate") === "yes" ||
          fingering.getAttribute("substitution") === "yes"
        ) {
          continue;
        }
        const match = (fingering.textContent ?? "")
          .trim()
          .match(/^([1-5])(?:\s*-\s*(?:[1-5]\s*-\s*)*([1-5]))?(?![0-9])/);
        if (match) {
          return {
            anchorFinger: Number.parseInt(match[1], 10) as Finger,
            anchorExitFinger: match[2]
              ? (Number.parseInt(match[2], 10) as Finger)
              : undefined,
            fingeringEl: fingering,
          };
        }
      }
    }
  }
  return {};
}

function extractTieState(noteEl: Element): { isTieStop: boolean; isTieStart: boolean } {
  const tieEls = directChildrenByTag(noteEl, "tie");
  if (tieEls.length > 0) {
    return {
      isTieStop: tieEls.some((t) => t.getAttribute("type") === "stop"),
      isTieStart: tieEls.some((t) => t.getAttribute("type") === "start"),
    };
  }
  const tiedEls: Element[] = [];
  for (const notations of directChildrenByTag(noteEl, "notations")) {
    for (const tied of directChildrenByTag(notations, "tied")) {
      tiedEls.push(tied);
    }
  }
  return {
    isTieStop: tiedEls.some((t) => {
      const type = t.getAttribute("type");
      return type === "stop" || type === "continue";
    }),
    isTieStart: tiedEls.some((t) => {
      const type = t.getAttribute("type");
      return type === "start" || type === "continue";
    }),
  };
}

function getFirstMeasureClefSign(part: Element): string | null {
  const firstMeasure = firstDirectChild(part, "measure");
  if (!firstMeasure) return null;
  for (const attrs of directChildrenByTag(firstMeasure, "attributes")) {
    const clef = firstDirectChild(attrs, "clef");
    if (clef) {
      const sign = textOfChild(clef, "sign");
      if (sign) return sign.toUpperCase();
    }
  }
  return null;
}

/**
 * Parse a MusicXML string into a lossless ScoreDocument containing the DOM tree,
 * extracted NoteEvents, and grouped OnsetSlices.
 */
export function parseMusicXml(xmlText: string, deps?: ParseMusicXmlOptions): ScoreDocument {
  const ParserCtor = deps?.DOMParser ?? globalThis.DOMParser;
  if (!ParserCtor) {
    throw new Error("DOMParser is not available in this environment.");
  }

  const xmlDeclaration = extractXmlDeclaration(xmlText);
  const parser = new ParserCtor();
  const xmlDoc = parser.parseFromString(xmlText, "application/xml");

  const parserError = xmlDoc.querySelector("parsererror");
  if (parserError) {
    throw new Error(`Invalid MusicXML: ${parserError.textContent?.trim() ?? "XML parse error"}`);
  }

  const root = xmlDoc.documentElement;
  if (!root || root.localName === "score-timewise") {
    throw new Error("Only <score-partwise> MusicXML documents are supported.");
  }
  if (root.localName !== "score-partwise") {
    throw new Error(`Unexpected MusicXML root element <${root.localName}>.`);
  }

  const parts = directChildrenByTag(root, "part");
  if (parts.length === 0) {
    throw new Error("MusicXML document contains no <part> elements.");
  }

  let totalStaves = 0;
  for (const part of parts) {
    let partStaves = 1;
    for (const measure of directChildrenByTag(part, "measure")) {
      for (const attrs of directChildrenByTag(measure, "attributes")) {
        const stavesText = textOfChild(attrs, "staves");
        if (stavesText) {
          const parsed = Number.parseInt(stavesText, 10);
          if (Number.isFinite(parsed) && parsed > partStaves) {
            partStaves = parsed;
          }
        }
      }
      for (const noteEl of directChildrenByTag(measure, "note")) {
        const staffText = textOfChild(noteEl, "staff");
        if (staffText) {
          const parsed = Number.parseInt(staffText, 10);
          if (Number.isFinite(parsed) && parsed > partStaves) {
            partStaves = parsed;
          }
        }
      }
    }
    totalStaves += partStaves;
  }

  if (totalStaves > 2) {
    throw new Error(
      `Unsupported score with ${totalStaves} staves. Only 1- or 2-staff piano <score-partwise> documents (maximum 2 staves) are supported.`
    );
  }

  const isSingleStaff = totalStaves === 1;
  const globalLcm = computeDivisionsLcm(parts);
  const titleEl = root.querySelector("work > work-title") ?? root.querySelector("movement-title");
  const title = titleEl?.textContent?.trim() || "Untitled Score";

  let defaultSingleStaffHand: Hand = "RH";
  const firstClefSign = getFirstMeasureClefSign(parts[0]);
  if (isSingleStaff && firstClefSign === "F") {
    defaultSingleStaffHand = "LH";
  }
  const activeSingleStaffHand: Hand =
    deps?.singleStaffHandOverride ?? defaultSingleStaffHand;

  const swapDualParts =
    parts.length === 2 &&
    getFirstMeasureClefSign(parts[0]) === "F" &&
    getFirstMeasureClefSign(parts[1]) === "G";

  const noteElementsByUid = new Map<string, Element>();
  const originalFingeringByUid = new Map<string, Element>();
  const noteEvents: NoteEvent[] = [];

  let noteSeq = 0;
  const tempoPoints: TempoPoint[] = [];
  const timeSignaturePoints: TimeSignaturePoint[] = [];
  const rawMeasureTimelines: Array<{
    measureIndex: number;
    startTick: number;
    endTick: number;
    timeBeats: number;
    timeBeatType: number;
  }> = [];
  const measureBoundaryBefore = new Set<number>();

  // Phrase tracking per hand across measures
  const phraseIdByHand: Record<Hand, number> = { RH: 0, LH: 0 };
  const lastEndSecByHand: Record<Hand, number | null> = { RH: null, LH: null };
  const lastMeasureByHand: Record<Hand, number | null> = { RH: null, LH: null };
  const onsetSlices: OnsetSlice[] = [];

  const partCount = parts.length;
  const rawNotes: Array<{
    partId: string;
    event: NoteEvent;
    endTick: number;
    wholeRestBefore: boolean;
  }> = [];

  let measureCount = 0;
  parts.forEach((part, partIndex) => {
    const partId = part.getAttribute("id") ?? `P${partIndex + 1}`;
    let divisions = 1;
    let timeBeats = 4;
    let timeBeatType = 4;
    let measureStartTick = 0;
    const handForPart: Hand =
      partCount === 1
        ? activeSingleStaffHand
        : swapDualParts
          ? partIndex === 0
            ? "LH"
            : "RH"
          : partIndex === 0
            ? "RH"
            : "LH";

    const measures = directChildrenByTag(part, "measure");
    if (measures.length > measureCount) {
      measureCount = measures.length;
    }
    const sawWholeRestByStaff = new Map<number, boolean>();
    const consecutiveRestTicksByStaff = new Map<number, number>();

    measures.forEach((measure, measureIndex) => {
      let cursorTick = measureStartTick;
      let lastNonChordOnsetTick = cursorTick;
      let lastGraceOnsetTick = cursorTick;
      let maxMeasureEndTick = measureStartTick;
      let pendingGraceOrder = 0;
      let lastGraceOrder = 0;

      for (let i = 0; i < measure.children.length; i++) {
        const child = measure.children[i];
        const tag = child.localName;

        if (tag === "attributes") {
          const divText = textOfChild(child, "divisions");
          if (divText) {
            const parsed = Number.parseInt(divText, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
              divisions = parsed;
            }
          }
          const timeEl = firstDirectChild(child, "time");
          if (timeEl) {
            const beatsText = textOfChild(timeEl, "beats");
            const beatTypeText = textOfChild(timeEl, "beat-type");
            const parsedBeats = beatsText ? Number.parseInt(beatsText, 10) : NaN;
            const parsedBeatType = beatTypeText ? Number.parseInt(beatTypeText, 10) : NaN;
            if (
              Number.isFinite(parsedBeats) &&
              parsedBeats > 0 &&
              Number.isFinite(parsedBeatType) &&
              parsedBeatType > 0
            ) {
              timeBeats = parsedBeats;
              timeBeatType = parsedBeatType;
              if (partIndex === 0) {
                timeSignaturePoints.push({
                  tick: measureStartTick,
                  beats: parsedBeats,
                  beatType: parsedBeatType,
                });
              }
            }
          }
        } else if (tag === "barline") {
          const repeatEl = firstDirectChild(child, "repeat");
          if (repeatEl && repeatEl.getAttribute("direction") === "backward") {
            measureBoundaryBefore.add(measureIndex + 1);
          }
          const endingEl = firstDirectChild(child, "ending");
          if (endingEl) {
            const endingType = endingEl.getAttribute("type");
            if (endingType === "start" && measureIndex > 0) {
              measureBoundaryBefore.add(measureIndex);
            } else if (endingType === "stop" || endingType === "discontinue") {
              measureBoundaryBefore.add(measureIndex + 1);
            }
          }
        } else if (tag === "direction") {
          const sound = child.querySelector("sound[tempo]");
          if (sound) {
            const tempoAttr = sound.getAttribute("tempo");
            const parsedTempo = tempoAttr ? Number.parseFloat(tempoAttr) : NaN;
            if (Number.isFinite(parsedTempo) && parsedTempo > 0) {
              tempoPoints.push({ tick: cursorTick, bpm: parsedTempo });
            }
          }
        } else if (tag === "sound") {
          const tempoAttr = child.getAttribute("tempo");
          const parsedTempo = tempoAttr ? Number.parseFloat(tempoAttr) : NaN;
          if (Number.isFinite(parsedTempo) && parsedTempo > 0) {
            tempoPoints.push({ tick: cursorTick, bpm: parsedTempo });
          }
        } else if (tag === "backup" || tag === "forward") {
          const durText = textOfChild(child, "duration");
          const rawDur = durText ? Number.parseInt(durText, 10) : 0;
          const scaledDur = rawDur * (globalLcm / divisions);
          pendingGraceOrder = 0;
          if (tag === "backup") {
            cursorTick = Math.max(measureStartTick, cursorTick - scaledDur);
            consecutiveRestTicksByStaff.clear();
          } else {
            cursorTick += scaledDur;
            if (cursorTick > maxMeasureEndTick) {
              maxMeasureEndTick = cursorTick;
            }
          }
        } else if (tag === "note") {
          const restEl = firstDirectChild(child, "rest");
          const isRest = restEl !== null;
          const isGrace = firstDirectChild(child, "grace") !== null;
          const isChord = firstDirectChild(child, "chord") !== null;
          const durText = textOfChild(child, "duration");
          const rawDur = isGrace ? 0 : durText ? Number.parseInt(durText, 10) : 0;
          const scaledDur = isGrace ? 0 : rawDur * (globalLcm / divisions);

          let onsetTick: number;
          let graceOrder: number | undefined;

          if (isGrace) {
            if (isChord) {
              onsetTick = lastGraceOnsetTick;
              graceOrder = lastGraceOrder;
            } else {
              onsetTick = cursorTick;
              lastGraceOnsetTick = cursorTick;
              lastGraceOrder = pendingGraceOrder;
              graceOrder = pendingGraceOrder++;
            }
          } else {
            onsetTick = isChord ? lastNonChordOnsetTick : cursorTick;
            if (!isChord) {
              lastNonChordOnsetTick = cursorTick;
              cursorTick += scaledDur;
              if (cursorTick > maxMeasureEndTick) {
                maxMeasureEndTick = cursorTick;
              }
            }
            pendingGraceOrder = 0;
          }

          const staffText = textOfChild(child, "staff");
          const staff = staffText ? Number.parseInt(staffText, 10) : 1;

          if (isRest) {
            const expectedMeasureTicks = (timeBeats * 4 * globalLcm) / timeBeatType;
            const prevRestTicks = consecutiveRestTicksByStaff.get(staff) ?? 0;
            const nextRestTicks = prevRestTicks + scaledDur;
            consecutiveRestTicksByStaff.set(staff, nextRestTicks);
            if (
              restEl.getAttribute("measure") === "yes" ||
              (expectedMeasureTicks > 0 && nextRestTicks >= expectedMeasureTicks)
            ) {
              sawWholeRestByStaff.set(staff, true);
            }
            pendingGraceOrder = 0;
            continue;
          }

          const pitchEl = firstDirectChild(child, "pitch");
          if (!pitchEl) {
            continue;
          }

          const voice = textOfChild(child, "voice") ?? "1";
          const hand: Hand =
            partCount === 1 && !isSingleStaff
              ? staff === 2
                ? "LH"
                : "RH"
              : handForPart;

          const { isTieStop, isTieStart } = extractTieState(child);

          const noteUid = `${partId}-m${measureIndex}-n${noteSeq++}`;
          noteElementsByUid.set(noteUid, child);

          const { anchorFinger, anchorExitFinger, fingeringEl } = extractAnchorFingers(child);
          if (fingeringEl) {
            originalFingeringByUid.set(noteUid, fingeringEl.cloneNode(true) as Element);
          }

          const event: NoteEvent = {
            noteUid,
            measureIndex,
            onsetTick,
            durationTick: scaledDur,
            onsetSec: 0,
            durationSec: 0,
            midi: pitchToMidi(pitchEl),
            hand,
            voice,
            staff,
            isGrace,
            graceOrder,
            isTieStop,
            isTieStart,
            anchorFinger,
            anchorExitFinger,
            anchorRawPreserved: anchorFinger !== undefined,
          };

          rawNotes.push({
            partId,
            event,
            endTick: onsetTick + scaledDur,
            wholeRestBefore: sawWholeRestByStaff.get(staff) ?? false,
          });
          sawWholeRestByStaff.set(staff, false);
          consecutiveRestTicksByStaff.set(staff, 0);
        }
      }

      if (partIndex === 0) {
        rawMeasureTimelines.push({
          measureIndex,
          startTick: measureStartTick,
          endTick: maxMeasureEndTick,
          timeBeats,
          timeBeatType,
        });
      } else if (rawMeasureTimelines[measureIndex]) {
        if (maxMeasureEndTick > rawMeasureTimelines[measureIndex].endTick) {
          rawMeasureTimelines[measureIndex].endTick = maxMeasureEndTick;
        }
      }

      measureStartTick = maxMeasureEndTick;
    });
  });

  // Cross-staff >= 70% primary staff rule per (partId, voice) on single-part 2-staff scores
  if (partCount === 1 && !isSingleStaff) {
    const voiceStats = new Map<
      string,
      { dur1: number; dur2: number; count1: number; count2: number }
    >();
    for (const item of rawNotes) {
      const key = `${item.partId}:${item.event.voice}`;
      let st = voiceStats.get(key);
      if (!st) {
        st = { dur1: 0, dur2: 0, count1: 0, count2: 0 };
        voiceStats.set(key, st);
      }
      if (item.event.staff === 2) {
        st.dur2 += item.event.durationTick;
        st.count2 += 1;
      } else {
        st.dur1 += item.event.durationTick;
        st.count1 += 1;
      }
    }

    const dominantHandByVoice = new Map<string, Hand>();
    for (const [key, st] of voiceStats.entries()) {
      const totalDur = st.dur1 + st.dur2;
      const totalCount = st.count1 + st.count2;
      const share1 = totalDur > 0 ? st.dur1 / totalDur : st.count1 / Math.max(1, totalCount);
      const share2 = totalDur > 0 ? st.dur2 / totalDur : st.count2 / Math.max(1, totalCount);
      if (share1 >= 0.7) {
        dominantHandByVoice.set(key, "RH");
      } else if (share2 >= 0.7) {
        dominantHandByVoice.set(key, "LH");
      }
    }

    for (const item of rawNotes) {
      const key = `${item.partId}:${item.event.voice}`;
      const domHand = dominantHandByVoice.get(key);
      if (domHand) {
        item.event.hand = domHand;
      }
    }
  }

  const normalizedTempoPoints = normalizeTempoPoints(tempoPoints);
  const normalizedTimeSigPoints = normalizeTimeSignaturePoints(timeSignaturePoints);
  const tickToSec = buildTickToSecMapper(normalizedTempoPoints, globalLcm);

  const measureTimelines: MeasureTimeline[] = rawMeasureTimelines.map((m) => {
    const nominalTicks = (m.timeBeats * 4 * globalLcm) / m.timeBeatType;
    const actualTicks = m.endTick - m.startTick;
    return {
      measureIndex: m.measureIndex,
      startTick: m.startTick,
      endTick: m.endTick,
      startSec: tickToSec(m.startTick),
      endSec: tickToSec(m.endTick),
      timeBeats: m.timeBeats,
      timeBeatType: m.timeBeatType,
      isPickup: actualTicks > 0 && actualTicks < nominalTicks,
    };
  });
  const wholeRestBeforeByUid = new Map<string, boolean>();
  for (const item of rawNotes) {
    const startSec = tickToSec(item.event.onsetTick);
    const endSec = tickToSec(item.endTick);
    item.event.onsetSec = startSec;
    item.event.durationSec = Math.max(0, endSec - startSec);
    noteEvents.push(item.event);
    wholeRestBeforeByUid.set(item.event.noteUid, item.wholeRestBefore);
  }

  // Sort noteEvents by onsetTick, grace order, and midi ascending
  noteEvents.sort((a, b) => {
    if (a.onsetTick !== b.onsetTick) return a.onsetTick - b.onsetTick;
    if (a.isGrace !== b.isGrace) return a.isGrace ? -1 : 1;
    if (a.isGrace && b.isGrace) {
      return (a.graceOrder ?? 0) - (b.graceOrder ?? 0);
    }
    return a.midi - b.midi;
  });

  // Link TieContinuation chains to their struck root NoteEvent and compute full sustain endTick/endSec
  interface TieChain {
    rootUid: string;
    voiceKey: string;
    handKey: string;
    endTick: number;
    endSec: number;
  }
  const openTieByVoice = new Map<string, TieChain>();
  const openTieByHand = new Map<string, TieChain>();
  const chainEndTickByRootUid = new Map<string, number>();
  const chainEndSecByRootUid = new Map<string, number>();

  for (const ev of noteEvents) {
    if (ev.isGrace) continue;
    const voiceKey = `${ev.hand}:${ev.voice}:${ev.midi}`;
    const handKey = `${ev.hand}:${ev.midi}`;
    const evEndTick = ev.onsetTick + ev.durationTick;
    const evEndSec = ev.onsetSec + ev.durationSec;

    if (ev.isTieStop) {
      const chain = openTieByVoice.get(voiceKey) ?? openTieByHand.get(handKey);
      if (chain) {
        ev.tieChainRootUid = chain.rootUid;
        chain.endTick = Math.max(chain.endTick, evEndTick);
        chain.endSec = Math.max(chain.endSec, evEndSec);
        chainEndTickByRootUid.set(chain.rootUid, chain.endTick);
        chainEndSecByRootUid.set(chain.rootUid, chain.endSec);
        if (!ev.isTieStart) {
          if (openTieByVoice.get(chain.voiceKey) === chain) {
            openTieByVoice.delete(chain.voiceKey);
          }
          if (openTieByHand.get(chain.handKey) === chain) {
            openTieByHand.delete(chain.handKey);
          }
        }
      }
    } else if (ev.isTieStart) {
      const chain: TieChain = {
        rootUid: ev.noteUid,
        voiceKey,
        handKey,
        endTick: evEndTick,
        endSec: evEndSec,
      };
      openTieByVoice.set(voiceKey, chain);
      openTieByHand.set(handKey, chain);
      chainEndTickByRootUid.set(ev.noteUid, evEndTick);
      chainEndSecByRootUid.set(ev.noteUid, evEndSec);
    }
  }

  const sliceBuckets = new Map<string, NoteEvent[]>();
  const sliceOrder: string[] = [];

  for (const ev of noteEvents) {
    if (ev.isTieStop) {
      continue;
    }
    const graceKey = ev.isGrace ? `g${ev.graceOrder ?? 0}` : "m";
    const bucketKey = `${ev.hand}:${ev.onsetTick}:${graceKey}`;
    let bucket = sliceBuckets.get(bucketKey);
    if (!bucket) {
      bucket = [];
      sliceBuckets.set(bucketKey, bucket);
      sliceOrder.push(bucketKey);
    }
    bucket.push(ev);
  }

  const activeNotes: Array<{ noteUid: string; hand: Hand; midi: number; endTick: number; endSec: number }> = [];

  sliceOrder.forEach((key, idx) => {
    const notes = sliceBuckets.get(key)!;
    notes.sort((a, b) => a.midi - b.midi);
    const first = notes[0];
    const hand = first.hand;

    // Remove released notes for this hand
    const heldNotes: OnsetSlice["heldNotes"] = [];
    for (let i = activeNotes.length - 1; i >= 0; i--) {
      if (activeNotes[i].endTick <= first.onsetTick) {
        activeNotes.splice(i, 1);
      } else if (activeNotes[i].hand === hand) {
        heldNotes.push({
          noteUid: activeNotes[i].noteUid,
          midi: activeNotes[i].midi,
          endTick: activeNotes[i].endTick,
        });
      }
    }

    const prevMeasure = lastMeasureByHand[hand];
    let hasMeasureBoundary = false;
    if (prevMeasure !== null && first.measureIndex > prevMeasure) {
      for (let m = prevMeasure + 1; m <= first.measureIndex; m++) {
        if (measureBoundaryBefore.has(m)) {
          hasMeasureBoundary = true;
          break;
        }
      }
    }

    const prevEnd = lastEndSecByHand[hand];
    const hadWholeRestBefore = notes.some((n) => wholeRestBeforeByUid.get(n.noteUid));
    if (hasMeasureBoundary) {
      phraseIdByHand[hand] += 1;
    } else if (prevEnd !== null && heldNotes.length === 0) {
      const silenceGapSec = first.onsetSec - prevEnd;
      if (silenceGapSec >= 1.5 || (hadWholeRestBefore && silenceGapSec > 1e-4)) {
        phraseIdByHand[hand] += 1;
      }
    }

    lastMeasureByHand[hand] = first.measureIndex;
    const maxEndSec = Math.max(
      ...notes.map((n) => chainEndSecByRootUid.get(n.noteUid) ?? n.onsetSec + n.durationSec)
    );
    if (prevEnd === null || maxEndSec > prevEnd) {
      lastEndSecByHand[hand] = maxEndSec;
    }

    for (const n of notes) {
      if (n.durationTick > 0) {
        const endTick = chainEndTickByRootUid.get(n.noteUid) ?? n.onsetTick + n.durationTick;
        const endSec = chainEndSecByRootUid.get(n.noteUid) ?? n.onsetSec + n.durationSec;
        activeNotes.push({
          noteUid: n.noteUid,
          hand: n.hand,
          midi: n.midi,
          endTick,
          endSec,
        });
      }
    }

    onsetSlices.push({
      sliceId: `slice-${idx}`,
      hand,
      measureIndex: first.measureIndex,
      onsetTick: first.onsetTick,
      onsetSec: first.onsetSec,
      isGrace: first.isGrace,
      phraseId: phraseIdByHand[hand],
      notes,
      heldNotes,
    });
  });

  return {
    title,
    xmlDoc,
    xmlDeclaration,
    noteElementsByUid,
    originalFingeringByUid,
    noteEvents,
    onsetSlices,
    isSingleStaff,
    defaultSingleStaffHand,
    measureCount,
    ticksPerQuarter: globalLcm,
    tempoPoints: normalizedTempoPoints,
    timeSignaturePoints: normalizedTimeSigPoints,
    measureTimelines,
  };
}
