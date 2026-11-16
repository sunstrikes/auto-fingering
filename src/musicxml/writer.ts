import type { Finger, ScoreDocument } from "../domain/types";
import type { XmlDomDeps } from "./parser";

const POST_NOTATIONS_TAGS = new Set(["lyric", "play", "listen"]);

function createNsElement(xmlDoc: Document, tagName: string): Element {
  const ns = xmlDoc.documentElement?.namespaceURI ?? null;
  return xmlDoc.createElementNS(ns, tagName);
}

function findDirectChild(parent: Element, tagName: string): Element | null {
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (child.localName === tagName || child.tagName === tagName) {
      return child;
    }
  }
  return null;
}

function findPrimaryFingering(technicalEl: Element): Element | null {
  for (let i = 0; i < technicalEl.children.length; i++) {
    const child = technicalEl.children[i];
    if (child.localName !== "fingering" && child.tagName !== "fingering") {
      continue;
    }
    if (
      child.getAttribute("alternate") === "yes" ||
      child.getAttribute("substitution") === "yes"
    ) {
      continue;
    }
    return child;
  }
  return null;
}

function insertNotationsInXsdOrder(xmlDoc: Document, noteEl: Element): Element {
  const existing = findDirectChild(noteEl, "notations");
  if (existing) {
    return existing;
  }

  const notationsEl = createNsElement(xmlDoc, "notations");
  let insertBeforeEl: Element | null = null;
  for (let i = 0; i < noteEl.children.length; i++) {
    const child = noteEl.children[i];
    if (POST_NOTATIONS_TAGS.has(child.localName)) {
      insertBeforeEl = child;
      break;
    }
  }

  if (insertBeforeEl) {
    noteEl.insertBefore(notationsEl, insertBeforeEl);
  } else {
    noteEl.appendChild(notationsEl);
  }
  return notationsEl;
}

/**
 * Losslessly write deduced fingerings back into the ScoreDocument DOM tree
 * following MusicXML 4.0 XSD child ordering and namespace rules.
 */
export function writeFingeringsToScore(
  scoreDoc: ScoreDocument,
  fingerByNoteUid: Record<string, Finger>
): void {
  const { xmlDoc, noteElementsByUid, noteEvents } = scoreDoc;

  for (const event of noteEvents) {
    if (event.isTieStop) {
      continue;
    }
    const finger = fingerByNoteUid[event.noteUid];
    if (!finger) {
      continue;
    }
    if (event.anchorRawPreserved && finger === event.anchorFinger) {
      continue;
    }
    const noteEl = noteElementsByUid.get(event.noteUid);
    if (!noteEl) {
      continue;
    }

    const notationsEl = insertNotationsInXsdOrder(xmlDoc, noteEl);
    let technicalEl = findDirectChild(notationsEl, "technical");
    if (!technicalEl) {
      technicalEl = createNsElement(xmlDoc, "technical");
      notationsEl.appendChild(technicalEl);
    }

    const placement = event.hand === "LH" ? "below" : "above";
    let fingeringEl = findPrimaryFingering(technicalEl);
    if (!fingeringEl) {
      fingeringEl = createNsElement(xmlDoc, "fingering");
      fingeringEl.setAttribute("placement", placement);
      technicalEl.appendChild(fingeringEl);
    } else if (!fingeringEl.hasAttribute("placement")) {
      fingeringEl.setAttribute("placement", placement);
    }

    fingeringEl.textContent = String(finger);
  }
}

/**
 * Serialize a ScoreDocument back to a MusicXML string, preserving the original
 * <?xml ...?> declaration and <!DOCTYPE ...> declaration.
 */
export function serializeScoreDocument(
  scoreDoc: ScoreDocument,
  deps?: XmlDomDeps
): string {
  const SerializerCtor = deps?.XMLSerializer ?? globalThis.XMLSerializer;
  if (!SerializerCtor) {
    throw new Error("XMLSerializer is not available in this environment.");
  }

  const serializer = new SerializerCtor();
  let serialized = serializer.serializeToString(scoreDoc.xmlDoc);
  serialized = serialized.replace(/^<\?xml\s[^?]*\?>\s*/i, "");

  return `${scoreDoc.xmlDeclaration}\n${serialized}`;
}
