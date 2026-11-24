import { buildNoteCoordIndex, type NoteCoordinates } from "../domain/noteCoordIndex";
import { sha256 } from "../domain/sha256";

const lexCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Snapshot all source fingering tags, including alternates and substitutions. */
export function computeSourceFingeringHash(
  score: NoteCoordinates,
  elementsByUid: ReadonlyMap<string, readonly Element[]>,
): string {
  if (elementsByUid.size === 0) return sha256("[]");
  const { keyByUid } = buildNoteCoordIndex(score);
  const entries = [];
  for (const [uid, elements] of elementsByUid) {
    const key = keyByUid.get(uid);
    if (key === undefined) continue;
    const tags = elements.map((el) => [
      (el.textContent ?? "").trim().replace(/\s+/g, " "),
      Array.from(el.attributes)
        .filter((attr) => attr.namespaceURI !== "http://www.w3.org/2000/xmlns/")
        .map((attr) => [attr.namespaceURI ?? "", attr.localName, attr.value])
        .sort((a, b) => lexCompare(a[0], b[0]) || lexCompare(a[1], b[1])),
    ]);
    entries.push({ key, tags });
  }
  entries.sort((a, b) => lexCompare(a.key, b.key));
  return sha256(JSON.stringify(entries.map(({ key, tags }) => [key, tags])));
}
