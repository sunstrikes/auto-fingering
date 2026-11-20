import type {
  HandSpanProfile,
  NoteEvent,
  ScoreDocument,
  ScoreRepairOption,
  ScoreRepairSuggestion,
} from "../domain/types";
import { analyzeScoreRepairSuggestions } from "../solver/scoreRepair";
import { parseMusicXml, type XmlDomDeps } from "./parser";
import { serializeScoreDocument } from "./writer";
import {
  createNsElement,
  findDirectChild,
  findDirectChildren,
  textOfDirectChild,
} from "./xmlHelpers";

const NOTE_TAG_ORDER = [
  "grace",
  "cue",
  "chord",
  "pitch",
  "unpitched",
  "rest",
  "duration",
  "tie",
  "instrument",
  "footnote",
  "level",
  "voice",
  "type",
  "dot",
  "accidental",
  "time-modification",
  "stem",
  "notehead",
  "notehead-text",
  "staff",
  "beam",
  "notations",
  "lyric",
  "play",
  "listen",
];

const NOTATIONS_TAG_ORDER = [
  "footnote",
  "level",
  "tied",
  "slur",
  "tuplet",
  "glissando",
  "slide",
  "ornaments",
  "technical",
  "articulations",
  "dynamics",
  "fermata",
  "arpeggiate",
  "non-arpeggiate",
  "accidental-mark",
  "other-notation",
];

const NOTE_ORDER_MAP = new Map(NOTE_TAG_ORDER.map((tag, idx) => [tag, idx]));
const NOTATIONS_ORDER_MAP = new Map(NOTATIONS_TAG_ORDER.map((tag, idx) => [tag, idx]));

const SHARP_SPELLING: Array<{ step: string; alter: number }> = [
  { step: "C", alter: 0 },
  { step: "C", alter: 1 },
  { step: "D", alter: 0 },
  { step: "D", alter: 1 },
  { step: "E", alter: 0 },
  { step: "F", alter: 0 },
  { step: "F", alter: 1 },
  { step: "G", alter: 0 },
  { step: "G", alter: 1 },
  { step: "A", alter: 0 },
  { step: "A", alter: 1 },
  { step: "B", alter: 0 },
];

const FLAT_SPELLING: Array<{ step: string; alter: number }> = [
  { step: "C", alter: 0 },
  { step: "D", alter: -1 },
  { step: "D", alter: 0 },
  { step: "E", alter: -1 },
  { step: "E", alter: 0 },
  { step: "F", alter: 0 },
  { step: "G", alter: -1 },
  { step: "G", alter: 0 },
  { step: "A", alter: -1 },
  { step: "A", alter: 0 },
  { step: "B", alter: -1 },
  { step: "B", alter: 0 },
];

const NOTE_TYPE_QUARTERS: Array<{ type: string; quarters: number }> = [
  { type: "whole", quarters: 4 },
  { type: "half", quarters: 2 },
  { type: "quarter", quarters: 1 },
  { type: "eighth", quarters: 0.5 },
  { type: "16th", quarters: 0.25 },
  { type: "32nd", quarters: 0.125 },
  { type: "64th", quarters: 0.0625 },
  { type: "128th", quarters: 0.03125 },
];

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

function insertChildInOrder(
  parent: Element,
  child: Element,
  orderMap: Map<string, number>
): void {
  const targetRank = orderMap.get(child.localName) ?? 999;
  for (let i = 0; i < parent.children.length; i++) {
    const existing = parent.children[i];
    const rank = orderMap.get(existing.localName) ?? 999;
    if (rank > targetRank) {
      parent.insertBefore(child, existing);
      return;
    }
  }
  parent.appendChild(child);
}

function insertAfter(parent: Element, newNode: Element, refNode: Element | null): void {
  if (refNode && refNode.parentElement === parent) {
    parent.insertBefore(newNode, refNode.nextSibling);
  } else if (parent.firstChild) {
    parent.insertBefore(newNode, parent.firstChild);
  } else {
    parent.appendChild(newNode);
  }
}

function ensureDirectTextChild(
  xmlDoc: Document,
  parent: Element,
  tagName: string,
  text: string,
  orderMap: Map<string, number>
): Element {
  let el = findDirectChild(parent, tagName);
  if (!el) {
    el = createNsElement(xmlDoc, tagName);
    insertChildInOrder(parent, el, orderMap);
  }
  el.textContent = text;
  return el;
}

function ensureNotationsEl(xmlDoc: Document, noteEl: Element): Element {
  const existing = findDirectChild(noteEl, "notations");
  if (existing) return existing;
  const notationsEl = createNsElement(xmlDoc, "notations");
  insertChildInOrder(noteEl, notationsEl, NOTE_ORDER_MAP);
  return notationsEl;
}

function durationToTypeAndDots(
  xmlDur: number,
  divisions: number
): { type: string; dots: number } | null {
  if (xmlDur <= 0 || divisions <= 0) return null;
  const targetQuarters = xmlDur / divisions;
  for (const entry of NOTE_TYPE_QUARTERS) {
    for (const dots of [0, 1, 2]) {
      const factor = dots === 0 ? 1 : dots === 1 ? 1.5 : 1.75;
      if (Math.abs(entry.quarters * factor - targetQuarters) < 1e-7) {
        return { type: entry.type, dots };
      }
    }
  }
  return null;
}

function setNoteDurationAndType(
  xmlDoc: Document,
  noteEl: Element,
  xmlDur: number,
  divisions: number
): void {
  ensureDirectTextChild(xmlDoc, noteEl, "duration", String(xmlDur), NOTE_ORDER_MAP);
  for (const dotEl of findDirectChildren(noteEl, "dot")) {
    dotEl.parentNode?.removeChild(dotEl);
  }
  const typeAndDots = durationToTypeAndDots(xmlDur, divisions);
  if (typeAndDots) {
    ensureDirectTextChild(xmlDoc, noteEl, "type", typeAndDots.type, NOTE_ORDER_MAP);
    for (let d = 0; d < typeAndDots.dots; d++) {
      insertChildInOrder(noteEl, createNsElement(xmlDoc, "dot"), NOTE_ORDER_MAP);
    }
  } else {
    const oldType = findDirectChild(noteEl, "type");
    oldType?.parentNode?.removeChild(oldType);
  }
}

function stripTieMarks(noteEl: Element, mode: "all" | "start" | "stop"): void {
  for (const tieEl of findDirectChildren(noteEl, "tie")) {
    const type = tieEl.getAttribute("type");
    if (mode === "all" || type === mode) {
      tieEl.parentNode?.removeChild(tieEl);
    }
  }
  for (const notations of findDirectChildren(noteEl, "notations")) {
    for (const tiedEl of findDirectChildren(notations, "tied")) {
      const type = tiedEl.getAttribute("type");
      if (
        mode === "all" ||
        type === mode ||
        type === "continue"
      ) {
        tiedEl.parentNode?.removeChild(tiedEl);
      }
    }
    if (notations.children.length === 0) {
      notations.parentNode?.removeChild(notations);
    }
  }
}

function removePrimaryFingering(noteEl: Element): void {
  const notations = findDirectChild(noteEl, "notations");
  if (!notations) return;
  const technical = findDirectChild(notations, "technical");
  if (!technical) return;
  for (const f of findDirectChildren(technical, "fingering")) {
    if (f.getAttribute("alternate") !== "yes" && f.getAttribute("substitution") !== "yes") {
      technical.removeChild(f);
    }
  }
  if (technical.children.length === 0) {
    notations.removeChild(technical);
  }
  if (notations.children.length === 0) {
    noteEl.removeChild(notations);
  }
}

function nextNoteSibling(noteEl: Element): Element | null {
  let cursor = noteEl.nextElementSibling;
  while (cursor) {
    if (cursor.localName === "note") return cursor;
    if (cursor.localName === "backup" || cursor.localName === "forward") return null;
    cursor = cursor.nextElementSibling;
  }
  return null;
}

function findChordTail(noteEl: Element): Element {
  let tail = noteEl;
  let next = nextNoteSibling(tail);
  while (next && findDirectChild(next, "chord") !== null) {
    tail = next;
    next = nextNoteSibling(tail);
  }
  return tail;
}

function convertNoteElToRest(xmlDoc: Document, noteEl: Element): void {
  const tagsToRemove = [
    "grace",
    "chord",
    "pitch",
    "unpitched",
    "tie",
    "accidental",
    "stem",
    "notehead",
    "notehead-text",
    "beam",
    "notations",
    "lyric",
  ];
  for (const tag of tagsToRemove) {
    for (const child of findDirectChildren(noteEl, tag)) {
      noteEl.removeChild(child);
    }
  }
  if (!findDirectChild(noteEl, "rest")) {
    insertChildInOrder(noteEl, createNsElement(xmlDoc, "rest"), NOTE_ORDER_MAP);
  }
}

function buildRestNoteEl(
  xmlDoc: Document,
  xmlDur: number,
  divisions: number,
  voice: string,
  staff: number | null
): Element {
  const restNote = createNsElement(xmlDoc, "note");
  restNote.appendChild(createNsElement(xmlDoc, "rest"));
  setNoteDurationAndType(xmlDoc, restNote, xmlDur, divisions);
  ensureDirectTextChild(xmlDoc, restNote, "voice", voice, NOTE_ORDER_MAP);
  if (staff !== null) {
    ensureDirectTextChild(xmlDoc, restNote, "staff", String(staff), NOTE_ORDER_MAP);
  }
  return restNote;
}

function removeNoteSafely(
  xmlDoc: Document,
  noteEl: Element,
  event: NoteEvent | undefined,
  freshDoc: ScoreDocument,
  cascadeTieChain: boolean
): void {
  if (!noteEl.parentNode) return;
  const hasChord = findDirectChild(noteEl, "chord") !== null;
  if (hasChord) {
    noteEl.parentNode.removeChild(noteEl);
  } else {
    const nextNote = nextNoteSibling(noteEl);
    const nextChordEl = nextNote ? findDirectChild(nextNote, "chord") : null;
    if (nextNote && nextChordEl) {
      nextNote.removeChild(nextChordEl);
      noteEl.parentNode.removeChild(noteEl);
    } else {
      convertNoteElToRest(xmlDoc, noteEl);
    }
  }

  if (cascadeTieChain && event?.isTieStart) {
    for (const cont of freshDoc.noteEvents) {
      if (cont.tieChainRootUid === event.noteUid) {
        const contEl = freshDoc.noteElementsByUid.get(cont.noteUid);
        if (contEl) {
          stripTieMarks(contEl, "all");
          removeNoteSafely(xmlDoc, contEl, cont, freshDoc, false);
        }
      }
    }
  }
}

function applyPitchToNoteEl(
  xmlDoc: Document,
  noteEl: Element,
  newMidi: number,
  oldMidi: number,
  fifths: number
): void {
  const pitchEl = findDirectChild(noteEl, "pitch");
  if (!pitchEl) return;

  const newOctave = Math.floor(newMidi / 12) - 1;
  const oldPc = ((oldMidi % 12) + 12) % 12;
  const newPc = ((newMidi % 12) + 12) % 12;

  if (oldPc === newPc) {
    let octEl = findDirectChild(pitchEl, "octave");
    if (!octEl) {
      octEl = createNsElement(xmlDoc, "octave");
      pitchEl.appendChild(octEl);
    }
    octEl.textContent = String(newOctave);
  } else {
    const spelling = (fifths < 0 ? FLAT_SPELLING : SHARP_SPELLING)[newPc];
    let stepEl = findDirectChild(pitchEl, "step");
    if (!stepEl) {
      stepEl = createNsElement(xmlDoc, "step");
      pitchEl.insertBefore(stepEl, pitchEl.firstChild);
    }
    stepEl.textContent = spelling.step;

    let alterEl = findDirectChild(pitchEl, "alter");
    if (spelling.alter !== 0) {
      if (!alterEl) {
        alterEl = createNsElement(xmlDoc, "alter");
        pitchEl.insertBefore(alterEl, findDirectChild(pitchEl, "octave"));
      }
      alterEl.textContent = String(spelling.alter);
    } else if (alterEl) {
      pitchEl.removeChild(alterEl);
    }

    let octEl = findDirectChild(pitchEl, "octave");
    if (!octEl) {
      octEl = createNsElement(xmlDoc, "octave");
      pitchEl.appendChild(octEl);
    }
    octEl.textContent = String(newOctave);
  }

  for (const acc of findDirectChildren(noteEl, "accidental")) {
    noteEl.removeChild(acc);
  }
}

function pickSafeVoiceForPart(partEl: Element): string {
  const usedVoices = new Set<string>();
  for (const measure of findDirectChildren(partEl, "measure")) {
    for (const noteEl of findDirectChildren(measure, "note")) {
      const v = textOfDirectChild(noteEl, "voice");
      if (v) usedVoices.add(v);
    }
  }
  for (let candidate = 3; candidate <= 99; candidate++) {
    const v = String(candidate);
    if (!usedVoices.has(v)) return v;
  }
  return "99";
}

function multiplyMeasureDivisions(
  xmlDoc: Document,
  measureEl: Element,
  currentDivisions: number,
  factor: number
): number {
  if (factor <= 1) return currentDivisions;
  const nextDivisions = currentDivisions * factor;

  let attrsEl = findDirectChild(measureEl, "attributes");
  if (!attrsEl) {
    attrsEl = createNsElement(xmlDoc, "attributes");
    measureEl.insertBefore(attrsEl, measureEl.firstChild);
  }
  let divEl = findDirectChild(attrsEl, "divisions");
  if (!divEl) {
    divEl = createNsElement(xmlDoc, "divisions");
    attrsEl.insertBefore(divEl, attrsEl.firstChild);
  }
  divEl.textContent = String(nextDivisions);

  for (let i = 0; i < measureEl.children.length; i++) {
    const child = measureEl.children[i];
    if (child.localName === "note" || child.localName === "backup" || child.localName === "forward") {
      const durEl = findDirectChild(child, "duration");
      if (durEl) {
        const val = Number.parseInt((durEl.textContent ?? "").trim(), 10);
        if (Number.isFinite(val)) {
          durEl.textContent = String(val * factor);
        }
      }
    }
  }

  // If the next measure didn't redefine <divisions>, preserve currentDivisions in it
  const nextMeasure = measureEl.nextElementSibling;
  if (nextMeasure && nextMeasure.localName === "measure") {
    const nextHasDiv = findDirectChildren(nextMeasure, "attributes").some(
      (a) => findDirectChild(a, "divisions") !== null
    );
    if (!nextHasDiv) {
      let nextAttrs = findDirectChild(nextMeasure, "attributes");
      if (!nextAttrs) {
        nextAttrs = createNsElement(xmlDoc, "attributes");
        nextMeasure.insertBefore(nextAttrs, nextMeasure.firstChild);
      }
      const nextDivEl = createNsElement(xmlDoc, "divisions");
      nextDivEl.textContent = String(currentDivisions);
      nextAttrs.insertBefore(nextDivEl, nextAttrs.firstChild);
    }
  }

  return nextDivisions;
}

interface MeasureContext {
  partEl: Element;
  measureEl: Element;
  divisions: number;
  fifths: number;
}

function buildMeasureContexts(xmlDoc: Document): Map<Element, MeasureContext> {
  const contexts = new Map<Element, MeasureContext>();
  const root = xmlDoc.documentElement;
  for (const partEl of findDirectChildren(root, "part")) {
    let divisions = 1;
    let fifths = 0;
    for (const measureEl of findDirectChildren(partEl, "measure")) {
      for (const attrsEl of findDirectChildren(measureEl, "attributes")) {
        const divText = textOfDirectChild(attrsEl, "divisions");
        if (divText) {
          const parsed = Number.parseInt(divText, 10);
          if (Number.isFinite(parsed) && parsed > 0) divisions = parsed;
        }
        const keyEl = findDirectChild(attrsEl, "key");
        if (keyEl) {
          const fifthsText = textOfDirectChild(keyEl, "fifths");
          if (fifthsText) {
            const parsed = Number.parseInt(fifthsText, 10);
            if (Number.isFinite(parsed)) fifths = parsed;
          }
        }
      }
      contexts.set(measureEl, { partEl, measureEl, divisions, fifths });
    }
  }
  return contexts;
}

/**
 * Losslessly applies a user-confirmed `ScoreRepairOption` to a fresh copy of `rawXmlText`
 * following MusicXML 4.0 XSD child ordering, namespace integrity, and strict tick conservation.
 */
export function applyScoreRepairToXml(
  rawXmlText: string,
  scoreDoc: ScoreDocument,
  option: ScoreRepairOption,
  deps?: XmlDomDeps
): string {
  const freshDoc = parseMusicXml(rawXmlText, {
    ...deps,
    ...(scoreDoc.isSingleStaff ? { singleStaffHandOverride: scoreDoc.defaultSingleStaffHand } : {}),
  });
  const { xmlDoc } = freshDoc;
  const noteByUid = new Map<string, NoteEvent>();
  for (const ev of freshDoc.noteEvents) {
    noteByUid.set(ev.noteUid, ev);
  }

  const measureCtxMap = buildMeasureContexts(xmlDoc);
  const partCount = findDirectChildren(xmlDoc.documentElement, "part").length;
  const pathBInsertedByBeat = new Map<
    string,
    { lastNoteEl: Element; voice: string; staff: number }
  >();

  for (const edit of option.edits) {
    const noteEl = freshDoc.noteElementsByUid.get(edit.noteUid);
    const event = noteByUid.get(edit.noteUid);
    if (!noteEl || !event) continue;

    if (edit.kind === "add-arpeggiate") {
      const notationsEl = ensureNotationsEl(xmlDoc, noteEl);
      if (!findDirectChild(notationsEl, "arpeggiate")) {
        insertChildInOrder(
          notationsEl,
          createNsElement(xmlDoc, "arpeggiate"),
          NOTATIONS_ORDER_MAP
        );
      }
    } else if (edit.kind === "change-pitch") {
      const measureEl = noteEl.parentElement;
      const fifths = measureEl ? measureCtxMap.get(measureEl)?.fifths ?? 0 : 0;
      applyPitchToNoteEl(xmlDoc, noteEl, edit.newMidi, edit.oldMidi, fifths);
      if (event.isTieStart) {
        for (const cont of freshDoc.noteEvents) {
          if (cont.tieChainRootUid === event.noteUid) {
            const contEl = freshDoc.noteElementsByUid.get(cont.noteUid);
            const contMeasure = contEl?.parentElement;
            const contFifths = contMeasure
              ? measureCtxMap.get(contMeasure)?.fifths ?? fifths
              : fifths;
            if (contEl) {
              applyPitchToNoteEl(xmlDoc, contEl, edit.newMidi, edit.oldMidi, contFifths);
            }
          }
        }
      }
    } else if (edit.kind === "remove-note") {
      removeNoteSafely(xmlDoc, noteEl, event, freshDoc, true);
    } else if (edit.kind === "reassign-hand") {
      if (freshDoc.isSingleStaff) continue;
      const targetStaff = edit.targetHand === "LH" ? 2 : 1;
      const targetAnchorEvent = freshDoc.noteEvents.find(
        (n) =>
          n.measureIndex === event.measureIndex &&
          n.onsetTick === event.onsetTick &&
          n.hand === edit.targetHand &&
          !n.isGrace &&
          !n.isTieStop &&
          n.durationTick === event.durationTick
      );

      if (targetAnchorEvent) {
        const targetAnchorEl = freshDoc.noteElementsByUid.get(targetAnchorEvent.noteUid);
        if (!targetAnchorEl || !targetAnchorEl.parentElement) continue;

        const cloned = noteEl.cloneNode(true) as Element;
        for (const tag of ["stem", "beam", "accidental"]) {
          for (const ch of findDirectChildren(cloned, tag)) cloned.removeChild(ch);
        }
        removePrimaryFingering(cloned);
        if (!findDirectChild(cloned, "chord")) {
          insertChildInOrder(cloned, createNsElement(xmlDoc, "chord"), NOTE_ORDER_MAP);
        }
        const targetVoice = textOfDirectChild(targetAnchorEl, "voice") ?? targetAnchorEvent.voice;
        ensureDirectTextChild(xmlDoc, cloned, "voice", targetVoice, NOTE_ORDER_MAP);
        const targetDur = textOfDirectChild(targetAnchorEl, "duration");
        if (targetDur) {
          ensureDirectTextChild(xmlDoc, cloned, "duration", targetDur, NOTE_ORDER_MAP);
        }
        const targetStaffText = textOfDirectChild(targetAnchorEl, "staff");
        if (targetStaffText) {
          ensureDirectTextChild(xmlDoc, cloned, "staff", targetStaffText, NOTE_ORDER_MAP);
        } else if (partCount === 1) {
          ensureDirectTextChild(xmlDoc, cloned, "staff", String(targetStaff), NOTE_ORDER_MAP);
        } else {
          const oldStaffEl = findDirectChild(cloned, "staff");
          if (oldStaffEl) cloned.removeChild(oldStaffEl);
        }

        const chordTail = findChordTail(targetAnchorEl);
        const targetParent = chordTail.parentElement!;
        removeNoteSafely(xmlDoc, noteEl, event, freshDoc, false);
        insertAfter(targetParent, cloned, chordTail);
      } else if (partCount === 1 && noteEl.parentElement) {
        const measureEl = noteEl.parentElement;
        const partEl = measureEl.parentElement;
        if (!partEl) continue;

        const durText = textOfDirectChild(noteEl, "duration") ?? "1";
        const hasChord = findDirectChild(noteEl, "chord") !== null;
        const nextNote = nextNoteSibling(noteEl);
        const nextHasChord = nextNote !== null && findDirectChild(nextNote, "chord") !== null;
        const isSolo = !hasChord && !nextHasChord;

        let anchorAfter: Element | null;
        if (isSolo) {
          anchorAfter = noteEl; // convertNoteElToRest keeps noteEl in-place as a <rest/>
        } else {
          const tail = findChordTail(noteEl);
          anchorAfter = tail === noteEl ? noteEl.previousElementSibling : tail;
        }

        const cloned = noteEl.cloneNode(true) as Element;
        for (const tag of ["chord", "stem", "beam", "accidental"]) {
          for (const ch of findDirectChildren(cloned, tag)) cloned.removeChild(ch);
        }
        removePrimaryFingering(cloned);

        removeNoteSafely(xmlDoc, noteEl, event, freshDoc, false);

        const beatKey = `${event.measureIndex}:${event.onsetTick}:${edit.targetHand}`;
        const existingGroup = pathBInsertedByBeat.get(beatKey);
        if (existingGroup) {
          insertChildInOrder(cloned, createNsElement(xmlDoc, "chord"), NOTE_ORDER_MAP);
          ensureDirectTextChild(xmlDoc, cloned, "voice", existingGroup.voice, NOTE_ORDER_MAP);
          ensureDirectTextChild(
            xmlDoc,
            cloned,
            "staff",
            String(existingGroup.staff),
            NOTE_ORDER_MAP
          );
          insertAfter(measureEl, cloned, existingGroup.lastNoteEl);
          existingGroup.lastNoteEl = cloned;
        } else {
          const safeVoice = pickSafeVoiceForPart(partEl);
          ensureDirectTextChild(xmlDoc, cloned, "voice", safeVoice, NOTE_ORDER_MAP);
          ensureDirectTextChild(xmlDoc, cloned, "staff", String(targetStaff), NOTE_ORDER_MAP);
          const backupEl = createNsElement(xmlDoc, "backup");
          const backupDur = createNsElement(xmlDoc, "duration");
          backupDur.textContent = durText;
          backupEl.appendChild(backupDur);
          insertAfter(measureEl, backupEl, anchorAfter);
          insertAfter(measureEl, cloned, backupEl);
          pathBInsertedByBeat.set(beatKey, {
            lastNoteEl: cloned,
            voice: safeVoice,
            staff: targetStaff,
          });
        }
      }
    } else if (edit.kind === "clip-duration") {
      const chain: NoteEvent[] = [
        event,
        ...freshDoc.noteEvents
          .filter((n) => n.tieChainRootUid === event.noteUid)
          .sort((a, b) => a.onsetTick - b.onsetTick),
      ];
      const clipEndTick = event.onsetTick + edit.newDurationTick;
      const globalLcm = freshDoc.ticksPerQuarter;

      for (const seg of chain) {
        const segEl = freshDoc.noteElementsByUid.get(seg.noteUid);
        if (!segEl || !segEl.parentElement) continue;
        const measureEl = segEl.parentElement;
        const ctx = measureCtxMap.get(measureEl);
        if (!ctx) continue;

        const segStart = seg.onsetTick;
        const segEnd = seg.onsetTick + seg.durationTick;

        if (segEnd <= clipEndTick) {
          if (segEnd === clipEndTick && seg.isTieStart) {
            stripTieMarks(segEl, "start");
          }
          continue;
        }

        if (segStart >= clipEndTick) {
          stripTieMarks(segEl, "all");
          removeNoteSafely(xmlDoc, segEl, seg, freshDoc, false);
          continue;
        }

        // Clip boundary falls strictly inside this segment
        const keepTicks = clipEndTick - segStart;
        const restTicks = segEnd - clipEndTick;

        const f1 = globalLcm / gcd(globalLcm, keepTicks * ctx.divisions);
        const f2 = globalLcm / gcd(globalLcm, restTicks * ctx.divisions);
        const neededFactor = lcm(f1, f2);
        if (neededFactor > 1) {
          ctx.divisions = multiplyMeasureDivisions(xmlDoc, measureEl, ctx.divisions, neededFactor);
        }

        const keepXmlDur = Math.round((keepTicks * ctx.divisions) / globalLcm);
        const restXmlDur = Math.round((restTicks * ctx.divisions) / globalLcm);
        const origXmlDur = keepXmlDur + restXmlDur;

        stripTieMarks(segEl, "start");
        const hasChord = findDirectChild(segEl, "chord") !== null;
        const nextNote = nextNoteSibling(segEl);
        const nextHasChord = nextNote !== null && findDirectChild(nextNote, "chord") !== null;
        const inChord = hasChord || nextHasChord;

        const staffVal = findDirectChild(segEl, "staff") ? seg.staff : null;

        if (!inChord) {
          setNoteDurationAndType(xmlDoc, segEl, keepXmlDur, ctx.divisions);
          const restEl = buildRestNoteEl(xmlDoc, restXmlDur, ctx.divisions, seg.voice, staffVal);
          insertAfter(measureEl, restEl, segEl);
        } else {
          const chordTail = findChordTail(segEl);
          const insertAfterEl = chordTail === segEl ? segEl.previousElementSibling : chordTail;
          if (!hasChord && nextHasChord && nextNote) {
            const nextChordEl = findDirectChild(nextNote, "chord");
            if (nextChordEl) nextNote.removeChild(nextChordEl);
          } else if (hasChord) {
            const oldChord = findDirectChild(segEl, "chord");
            if (oldChord) segEl.removeChild(oldChord);
          }

          const safeVoice = pickSafeVoiceForPart(ctx.partEl);
          ensureDirectTextChild(xmlDoc, segEl, "voice", safeVoice, NOTE_ORDER_MAP);
          setNoteDurationAndType(xmlDoc, segEl, keepXmlDur, ctx.divisions);

          const backupEl = createNsElement(xmlDoc, "backup");
          const backupDur = createNsElement(xmlDoc, "duration");
          backupDur.textContent = String(origXmlDur);
          backupEl.appendChild(backupDur);

          const restEl = buildRestNoteEl(xmlDoc, restXmlDur, ctx.divisions, safeVoice, staffVal);

          insertAfter(measureEl, backupEl, insertAfterEl);
          insertAfter(measureEl, segEl, backupEl);
          insertAfter(measureEl, restEl, segEl);
        }
      }
    }
  }

  return serializeScoreDocument(freshDoc, deps);
}

export interface BatchScoreRepairSelection {
  suggestion: ScoreRepairSuggestion;
  option: ScoreRepairOption;
}

export interface BatchScoreRepairResult {
  rawXmlText: string;
  scoreDoc: ScoreDocument;
  appliedCount: number;
}

function getSuggestionKey(s: ScoreRepairSuggestion): string {
  return `${s.measureIndex}:${s.onsetTick}:${s.hand}:${s.issueKind}`;
}

export interface RepairVerification {
  /** Original issue is gone after applying the option. */
  resolved: boolean;
  /** Keys of suggestions that did not exist before (regressions). */
  introduced: string[];
  /** Resulting score text/doc when the option applies cleanly. */
  rawXmlText: string;
  scoreDoc: ScoreDocument;
}

/**
 * Closed-loop check: applies the option to a copy of the score, re-parses and
 * re-analyzes it. An option is only trustworthy if it resolves the targeted
 * issue without creating any new repair suggestion.
 */
export function verifyScoreRepairOption(
  rawXmlText: string,
  scoreDoc: ScoreDocument,
  suggestion: ScoreRepairSuggestion,
  option: ScoreRepairOption,
  profile: HandSpanProfile,
  deps?: XmlDomDeps
): RepairVerification | null {
  let nextXml: string;
  let nextDoc: ScoreDocument;
  try {
    nextXml = applyScoreRepairToXml(rawXmlText, scoreDoc, option, deps);
    if (nextXml === rawXmlText) return null;
    nextDoc = parseMusicXml(nextXml, {
      ...deps,
      ...(scoreDoc.isSingleStaff
        ? { singleStaffHandOverride: scoreDoc.defaultSingleStaffHand }
        : {}),
    });
  } catch {
    return null;
  }
  const before = new Set(
    analyzeScoreRepairSuggestions(scoreDoc.onsetSlices, profile).map(getSuggestionKey)
  );
  const after = analyzeScoreRepairSuggestions(nextDoc.onsetSlices, profile).map(
    getSuggestionKey
  );
  const targetKey = getSuggestionKey(suggestion);
  return {
    resolved: !after.includes(targetKey),
    introduced: after.filter((k) => !before.has(k)),
    rawXmlText: nextXml,
    scoreDoc: nextDoc,
  };
}

/**
 * Applies all selected (non-dismissed) repair suggestions sequentially, re-parsing and
 * re-analyzing after each mutation so note UIDs, measure divisions, and cross-hand
 * interactions remain consistent across multiple repairs.
 */
export function applyAllScoreRepairsToXml(
  rawXmlText: string,
  scoreDoc: ScoreDocument,
  selections: BatchScoreRepairSelection[],
  profile: HandSpanProfile,
  dismissedRepairIds?: ReadonlySet<string>,
  allInitialSuggestions?: ScoreRepairSuggestion[],
  deps?: XmlDomDeps
): BatchScoreRepairResult {
  if (selections.length === 0) {
    return { rawXmlText, scoreDoc, appliedCount: 0 };
  }

  const selectedOptionByKey = new Map<string, ScoreRepairOption>();
  for (const { suggestion, option } of selections) {
    selectedOptionByKey.set(getSuggestionKey(suggestion), option);
  }

  const skippedKeys = new Set<string>();
  if (dismissedRepairIds && allInitialSuggestions) {
    for (const s of allInitialSuggestions) {
      if (dismissedRepairIds.has(s.repairId)) {
        skippedKeys.add(getSuggestionKey(s));
      }
    }
  }

  let currentXml = rawXmlText;
  let currentDoc = scoreDoc;
  let appliedCount = 0;
  const attemptsByKey = new Map<string, number>();
  const maxIterations = Math.max(selections.length * 2 + 5, 20);

  for (let iter = 0; iter < maxIterations; iter++) {
    const freshSuggestions = analyzeScoreRepairSuggestions(currentDoc.onsetSlices, profile);
    const nextSug = freshSuggestions.find(
      (s) => !skippedKeys.has(getSuggestionKey(s)) && !dismissedRepairIds?.has(s.repairId)
    );
    if (!nextSug) break;

    const key = getSuggestionKey(nextSug);
    const attempts = attemptsByKey.get(key) ?? 0;
    if (attempts >= 2) {
      skippedKeys.add(key);
      continue;
    }
    attemptsByKey.set(key, attempts + 1);

    const preferred = selectedOptionByKey.get(key);
    const ordered = [...nextSug.options];
    if (preferred) {
      const idx = ordered.findIndex(
        (o) => o.strategy === preferred.strategy && o.label === preferred.label
      );
      const alt = idx >= 0 ? idx : ordered.findIndex((o) => o.strategy === preferred.strategy);
      if (alt > 0) ordered.unshift(...ordered.splice(alt, 1));
    }

    // Closed loop: pick the first option that resolves the issue without regressions.
    let verified: RepairVerification | null = null;
    for (const candidate of ordered) {
      const v = verifyScoreRepairOption(currentXml, currentDoc, nextSug, candidate, profile, deps);
      if (v && v.resolved && v.introduced.length === 0) {
        verified = v;
        break;
      }
    }
    if (!verified) {
      skippedKeys.add(key);
      continue;
    }
    const nextXml = verified.rawXmlText;

    currentXml = nextXml;
    currentDoc = verified.scoreDoc;
    appliedCount++;
  }

  return { rawXmlText: currentXml, scoreDoc: currentDoc, appliedCount };
}
