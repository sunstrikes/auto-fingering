import type { Finger, Hand, NoteEvent, OnsetSlice, ScoreDocument } from "../domain/types";

export interface XmlDomDeps {
  DOMParser?: typeof DOMParser;
  XMLSerializer?: typeof XMLSerializer;
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

function directChildrenByTag(parent: Element, tagName: string): Element[] {
  const result: Element[] = [];
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (child.localName === tagName || child.tagName === tagName) {
      result.push(child);
    }
  }
  return result;
}

function firstDirectChild(parent: Element, tagName: string): Element | null {
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (child.localName === tagName || child.tagName === tagName) {
      return child;
    }
  }
  return null;
}

function textOfChild(parent: Element, tagName: string): string | null {
  const child = firstDirectChild(parent, tagName);
  return child ? (child.textContent ?? "").trim() : null;
}

function extractXmlDeclaration(xmlText: string): string {
  const trimmed = xmlText.replace(/^\uFEFF/, "");
  const match = trimmed.match(/^<\?xml\s[^?]*\?>/i);
  return match ? match[0] : '<?xml version="1.0" encoding="UTF-8"?>';
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

function extractAnchorFinger(noteEl: Element): Finger | undefined {
  for (const notations of directChildrenByTag(noteEl, "notations")) {
    for (const technical of directChildrenByTag(notations, "technical")) {
      for (const fingering of directChildrenByTag(technical, "fingering")) {
        if (
          fingering.getAttribute("alternate") === "yes" ||
          fingering.getAttribute("substitution") === "yes"
        ) {
          continue;
        }
        const match = (fingering.textContent ?? "").trim().match(/[1-5]/);
        if (match) {
          return Number.parseInt(match[0], 10) as Finger;
        }
      }
    }
  }
  return undefined;
}

/**
 * Parse a MusicXML string into a lossless ScoreDocument containing the DOM tree,
 * extracted NoteEvents, and grouped OnsetSlices.
 */
export function parseMusicXml(xmlText: string, deps?: XmlDomDeps): ScoreDocument {
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
    }
    totalStaves += partStaves;
  }

  if (totalStaves > 2) {
    throw new Error(`Unsupported piano staff count (${totalStaves}). Maximum 2 staves supported.`);
  }

  const isSingleStaff = totalStaves === 1;
  const globalLcm = computeDivisionsLcm(parts);
  const titleEl = root.querySelector("work > work-title") ?? root.querySelector("movement-title");
  const title = titleEl?.textContent?.trim() || "Untitled Score";

  let defaultSingleStaffHand: Hand = "RH";
  const firstClefSign = textOfChild(
    root.querySelector("measure > attributes > clef") ?? root,
    "sign"
  );
  if (isSingleStaff && firstClefSign === "F") {
    defaultSingleStaffHand = "LH";
  }

  const noteElementsByUid = new Map<string, Element>();
  const noteEvents: NoteEvent[] = [];

  let noteSeq = 0;
  let globalTempoBpm = 100;

  // Phrase tracking per hand across measures
  const phraseIdByHand: Record<Hand, number> = { RH: 0, LH: 0 };
  const pendingPhraseBump: Record<Hand, boolean> = { RH: false, LH: false };
  const lastEndSecByHand: Record<Hand, number | null> = { RH: null, LH: null };
  const onsetSlices: OnsetSlice[] = [];

  const partCount = parts.length;

  parts.forEach((part, partIndex) => {
    const partId = part.getAttribute("id") ?? `P${partIndex + 1}`;
    let divisions = 1;
    let measureStartTick = 0;
    let measureStartSec = 0;
    const handForPart: Hand =
      partCount === 1
        ? defaultSingleStaffHand
        : partIndex === 0
          ? "RH"
          : "LH";

    const measures = directChildrenByTag(part, "measure");
    const rawPartNotes: Array<{
      event: NoteEvent;
      restBefore: boolean;
    }> = [];

    let sawRestSinceLastNote = false;

    measures.forEach((measure, measureIndex) => {
      let cursorTick = measureStartTick;
      let cursorSec = measureStartSec;
      let lastNonChordOnsetTick = cursorTick;
      let lastNonChordOnsetSec = cursorSec;
      let maxMeasureEndTick = measureStartTick;
      let maxMeasureEndSec = measureStartSec;
      let pendingGraceOrder = 0;

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
        } else if (tag === "direction") {
          const sound = child.querySelector("sound[tempo]");
          if (sound) {
            const tempoAttr = sound.getAttribute("tempo");
            const parsedTempo = tempoAttr ? Number.parseFloat(tempoAttr) : NaN;
            if (Number.isFinite(parsedTempo) && parsedTempo > 0) {
              globalTempoBpm = parsedTempo;
            }
          }
        } else if (tag === "sound") {
          const tempoAttr = child.getAttribute("tempo");
          const parsedTempo = tempoAttr ? Number.parseFloat(tempoAttr) : NaN;
          if (Number.isFinite(parsedTempo) && parsedTempo > 0) {
            globalTempoBpm = parsedTempo;
          }
        } else if (tag === "backup" || tag === "forward") {
          const durText = textOfChild(child, "duration");
          const rawDur = durText ? Number.parseInt(durText, 10) : 0;
          const scaledDur = rawDur * (globalLcm / divisions);
          const deltaSec = (rawDur / divisions) * (60 / globalTempoBpm);
          if (tag === "backup") {
            cursorTick = Math.max(measureStartTick, cursorTick - scaledDur);
            cursorSec = Math.max(measureStartSec, cursorSec - deltaSec);
          } else {
            cursorTick += scaledDur;
            cursorSec += deltaSec;
            if (cursorTick > maxMeasureEndTick) {
              maxMeasureEndTick = cursorTick;
              maxMeasureEndSec = cursorSec;
            }
          }
        } else if (tag === "note") {
          const isRest = firstDirectChild(child, "rest") !== null;
          const isGrace = firstDirectChild(child, "grace") !== null;
          const isChord = firstDirectChild(child, "chord") !== null;
          const durText = textOfChild(child, "duration");
          const rawDur = isGrace ? 0 : durText ? Number.parseInt(durText, 10) : 0;
          const scaledDur = isGrace ? 0 : rawDur * (globalLcm / divisions);
          const durSec = isGrace ? 0 : (rawDur / divisions) * (60 / globalTempoBpm);

          const onsetTick = isChord ? lastNonChordOnsetTick : cursorTick;
          const onsetSec = isChord ? lastNonChordOnsetSec : cursorSec;

          if (!isChord && !isGrace) {
            lastNonChordOnsetTick = cursorTick;
            lastNonChordOnsetSec = cursorSec;
            cursorTick += scaledDur;
            cursorSec += durSec;
            if (cursorTick > maxMeasureEndTick) {
              maxMeasureEndTick = cursorTick;
              maxMeasureEndSec = cursorSec;
            }
          }

          if (isRest) {
            sawRestSinceLastNote = true;
            pendingGraceOrder = 0;
            continue;
          }

          const pitchEl = firstDirectChild(child, "pitch");
          if (!pitchEl) {
            continue;
          }

          const staffText = textOfChild(child, "staff");
          const staff = staffText ? Number.parseInt(staffText, 10) : 1;
          const voice = textOfChild(child, "voice") ?? "1";
          const hand: Hand =
            partCount === 1 && !isSingleStaff
              ? staff === 2
                ? "LH"
                : "RH"
              : handForPart;

          const tieEls = directChildrenByTag(child, "tie");
          const isTieStop = tieEls.some((t) => t.getAttribute("type") === "stop");
          const isTieStart = tieEls.some((t) => t.getAttribute("type") === "start");

          const noteUid = `${partId}-m${measureIndex}-n${noteSeq++}`;
          noteElementsByUid.set(noteUid, child);

          const graceOrder = isGrace ? pendingGraceOrder++ : undefined;
          if (!isGrace) {
            pendingGraceOrder = 0;
          }

          const anchorFinger = extractAnchorFinger(child);

          const event: NoteEvent = {
            noteUid,
            measureIndex,
            onsetTick,
            durationTick: scaledDur,
            onsetSec,
            durationSec: durSec,
            midi: pitchToMidi(pitchEl),
            hand,
            voice,
            staff,
            isGrace,
            graceOrder,
            isTieStop,
            isTieStart,
            anchorFinger,
            anchorRawPreserved: anchorFinger !== undefined,
          };

          rawPartNotes.push({
            event,
            restBefore: sawRestSinceLastNote,
          });
          sawRestSinceLastNote = false;
        }
      }

      measureStartTick = maxMeasureEndTick;
      measureStartSec = maxMeasureEndSec;
    });

    for (const item of rawPartNotes) {
      const ev = item.event;
      if (item.restBefore && noteEvents.length > 0) {
        pendingPhraseBump[ev.hand] = true;
      }
      noteEvents.push(ev);
    }
  });

  // Sort noteEvents by onsetTick, grace order, and midi ascending
  noteEvents.sort((a, b) => {
    if (a.onsetTick !== b.onsetTick) return a.onsetTick - b.onsetTick;
    if (a.isGrace !== b.isGrace) return a.isGrace ? -1 : 1;
    if (a.isGrace && b.isGrace) {
      return (a.graceOrder ?? 0) - (b.graceOrder ?? 0);
    }
    return a.midi - b.midi;
  });

  // Reset phrase tracking and build OnsetSlices cleanly
  phraseIdByHand.RH = 0;
  phraseIdByHand.LH = 0;
  lastEndSecByHand.RH = null;
  lastEndSecByHand.LH = null;

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

  // Track rest gaps by comparing expected continuous timeline or silence gap >= 1.5s,
  // plus explicit rests detected in the score.
  // For single-staff / general slices: if gap between previous note endSec and next onsetSec > 0.05s
  // (meaning an explicit rest occurred or silence >= 1.5s), increment phraseId when a rest occurred or gap >= 1.5s.
  // Let's detect explicit rest intervals accurately using noteEvents vs measure timeline:
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

    const prevEnd = lastEndSecByHand[hand];
    if (prevEnd !== null && heldNotes.length === 0) {
      const silenceGapSec = first.onsetSec - prevEnd;
      // An un-held gap > 1e-4 seconds indicates a rest or silence between phrases
      if (silenceGapSec >= 1.5 || (pendingPhraseBump[hand] && silenceGapSec > 1e-4)) {
        phraseIdByHand[hand] += 1;
        pendingPhraseBump[hand] = false;
      }
    }

    const maxEndSec = Math.max(...notes.map((n) => n.onsetSec + n.durationSec));
    if (prevEnd === null || maxEndSec > prevEnd) {
      lastEndSecByHand[hand] = maxEndSec;
    }

    for (const n of notes) {
      if (n.durationTick > 0) {
        activeNotes.push({
          noteUid: n.noteUid,
          hand: n.hand,
          midi: n.midi,
          endTick: n.onsetTick + n.durationTick,
          endSec: n.onsetSec + n.durationSec,
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
    noteEvents,
    onsetSlices,
    isSingleStaff,
    defaultSingleStaffHand,
  };
}
