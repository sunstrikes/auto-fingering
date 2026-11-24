import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { DEFAULT_HAND_SPAN_PROFILE, type ScoreDocument, type ScoreRepairNoteEdit } from "../src/domain/types";
import { parseMusicXml } from "../src/musicxml/parser";
import { applyScoreRepairToXml } from "../src/musicxml/repairWriter";
import { exportScoreOutput, loadScoreInput } from "../src/musicxml/scoreSession";
import { writeFingeringsToScore } from "../src/musicxml/writer";
import { buildNoteCoordIndex, hashSourceFingerings } from "../src/persistence/anchorDrafts";
import { diffMeasureIndices, getScoreIdentity, isSimilarScore } from "../src/persistence/fingerprint";

import { solveFingering } from "../src/solver/solveFingering";
import { createStudioStore } from "../src/store/useStudioStore";

const { DOMParser, XMLSerializer } = new JSDOM("").window;
const parse = (xml: string) => parseMusicXml(xml, { DOMParser });
const onePart = (measures: string) =>
  `<score-partwise version="4.0"><part id="P1">${measures}</part></score-partwise>`;
const corpus = (name: string) => new URL(`../test-corpus/${name}`, import.meta.url);

function repair(xml: string, before: ScoreDocument, ...edits: ScoreRepairNoteEdit[]): ScoreDocument {
  return parse(applyScoreRepairToXml(xml, before, {
    edits,
    optionId: "test",
    strategy: "octave-fold-thin",
    label: "",
    fidelityScore: 0,
    description: "",
    previewSummary: "",
  }, { DOMParser, XMLSerializer }));
}

const REPAIR_XML = onePart(`
  <measure number="1">
    <attributes><divisions>4</divisions><staves>2</staves></attributes>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>12</duration><staff>1</staff></note>
  </measure>
  <measure number="2">
    <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><staff>2</staff></note>
    <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><staff>2</staff></note>
  </measure>
  <measure number="3">
    <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><staff>1</staff></note>
  </measure>`);

const MIXED_CHORD_XML = onePart(`
  <measure number="1">
    <attributes><divisions>4</divisions><staves>2</staves></attributes>
    <note><rest/><duration>1</duration><voice>1</voice><staff>1</staff></note>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
    <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note>
    <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
    <backup><duration>9</duration></backup>
    <note><rest/><duration>1</duration><voice>2</voice><staff>2</staff></note>
    <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note>
    <note><pitch><step>D</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note>
  </measure>`);

describe("Score Document structural metadata", () => {
  it("extracts explicit phrase and form markers without confusing a voice rest with a silent measure", () => {
    const doc = parse(onePart(`
      <measure number="1">
        <attributes><divisions>2</divisions><key><fifths>-2</fifths><mode>minor</mode></key>
          <time><beats>2</beats><beat-type>4</beat-type></time></attributes>
        <barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>
        <direction><direction-type><rehearsal>A</rehearsal></direction-type><sound tempo="120"/></direction>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>
          <notations><fermata/></notations></note>
        <backup><duration>4</duration></backup>
        <note><rest measure="yes"/><duration>4</duration><voice>2</voice></note>
        <barline><bar-style>light-light</bar-style></barline>
      </measure>
      <measure number="2">
        <barline location="left"><ending number="1, 2" type="start"/></barline>
        <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>100</per-minute></metronome></direction-type></direction>
        <note><rest measure="yes"/><duration>4</duration></note>
        <barline location="right"><ending number="1, 2" type="stop"/><repeat direction="backward"/></barline>
      </measure>
      <measure number="3">
        <barline location="left"><ending number="3" type="start"/></barline>
        <note><rest/><duration>4</duration></note>
        <barline><bar-style>light-heavy</bar-style><fermata/></barline>
      </measure>`));

    expect(doc.measureStructuralMeta).toMatchObject([
      {
        measureIndex: 0,
        barlineLeft: "repeat-forward",
        barlineRight: "double",
        rehearsalMark: "A",
        keyFifths: -2,
        keyMode: "minor",
        hasFermata: true,
        hasTempoChange: true,
        hasTimeSigChange: true,
      },
      {
        measureIndex: 1,
        barlineRight: "repeat-backward",
        endingNumbers: [1, 2],
        endingType: "start",
        isFullMeasureRest: true,
        hasTempoChange: true,
      },
      { measureIndex: 2, barlineRight: "final", endingNumbers: [3], hasFermata: true, isFullMeasureRest: true },
    ]);
    expect(doc.measureStructuralMeta?.[0].isFullMeasureRest).not.toBe(true);
  });

  it.each([
    ["repeat-backward", '<repeat direction="backward"/>'],
    ["double", '<bar-style>light-light</bar-style>'],
    ["final", '<bar-style>light-heavy</bar-style>'],
  ])("retains a %s barline after an ending-only barline in another part", (kind, markup) => {
    const doc = parse(`<score-partwise>
      <part id="P1"><measure number="1">
        <note><rest/><duration>1</duration></note>
        <barline location="right"><ending number="1" type="stop"/></barline>
      </measure></part>
      <part id="P2"><measure number="1">
        <note><rest/><duration>1</duration></note>
        <barline location="right">${markup}</barline>
      </measure></part>
    </score-partwise>`);
    expect(doc.measureStructuralMeta?.[0]).toMatchObject({
      barlineRight: kind, endings: [{ location: "right", type: "stop", numbers: [1] }],
    });
  });

  it("uses reduced quarter offsets per part, with shared order for members of a grace chord", () => {
    const makeXml = (scale: number) => `
      <score-partwise>
        <part id="RH">
          <measure number="0">
            <attributes><divisions>${3 * scale}</divisions></attributes>
            <note><pitch><step>C</step><octave>5</octave></pitch><duration>${3 * scale}</duration></note>
          </measure>
          <measure number="1">
            <note><rest/><duration>${2 * scale}</duration></note>
            <note><grace/><pitch><step>C</step><octave>5</octave></pitch></note>
            <note><grace/><chord/><pitch><step>E</step><octave>5</octave></pitch></note>
            <note><grace/><pitch><step>D</step><octave>5</octave></pitch></note>
            <note><pitch><step>C</step><octave>5</octave></pitch><duration>${3 * scale}</duration></note>
          </measure>
        </part>
        <part id="LH">
          <measure number="0">
            <attributes><divisions>${4 * scale}</divisions></attributes>
            <note><rest/><duration>${2 * scale}</duration></note>
          </measure>
          <measure number="1">
            <note><pitch><step>C</step><octave>3</octave></pitch><duration>${4 * scale}</duration></note>
          </measure>
        </part>
      </score-partwise>`;

    for (const scale of [1, 11]) {
      expect(parse(makeXml(scale)).noteEvents.map((note) => note.scoreCoord)).toEqual([
        { measureIndex: 0, beatNum: 0, beatDen: 1 },
        { measureIndex: 1, beatNum: 0, beatDen: 1 },
        { measureIndex: 1, beatNum: 2, beatDen: 3, graceOrder: 0 },
        { measureIndex: 1, beatNum: 2, beatDen: 3, graceOrder: 0 },
        { measureIndex: 1, beatNum: 2, beatDen: 3, graceOrder: 1 },
        { measureIndex: 1, beatNum: 2, beatDen: 3 },
      ]);
    }
  });

  it("reports paired slur spans and distinguishes a barline crossing from a same-measure span", () => {
    const doc = parse(onePart(`
      <measure number="1">
        <attributes><divisions>2</divisions><staves>2</staves></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff>
          <notations><slur type="start" number="2"/></notations></note>
      </measure>
      <measure number="2">
        <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>2</staff>
          <notations><slur type="stop" number="2"/><slur type="start"/></notations></note>
        <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>2</staff>
          <notations><slur type="stop"/><slur type="start" number="3"/></notations></note>
      </measure>`));
    expect(doc.slurSpans).toEqual([
      {
        hand: "RH", voice: "1",
        startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
        endCoord: { measureIndex: 1, beatNum: 0, beatDen: 1 },
        crossesBarline: true,
      },
      {
        hand: "LH", voice: "1",
        startCoord: { measureIndex: 1, beatNum: 0, beatDen: 1 },
        endCoord: { measureIndex: 1, beatNum: 1, beatDen: 1 },
        crossesBarline: false,
      },
    ]);
  });
});

describe("Finger Anchor coordinates", () => {
  it("finds unchanged unisons after an earlier deletion renumbers UIDs and changes the inferred hand", () => {
    const before = parse(REPAIR_XML);
    const after = repair(REPAIR_XML, before, { kind: "remove-note", noteUid: before.noteEvents[0].noteUid });
    const oldIndex = buildNoteCoordIndex(before);
    const newIndex = buildNoteCoordIndex(after);
    expect(before.noteEvents[1].hand).toBe("RH");
    expect(after.noteEvents[0].hand).toBe("LH");

    for (const [occIdx, note] of before.noteEvents.filter((n) => n.measureIndex === 1).entries()) {
      const key = `1:0/1:m:LH:64:${occIdx}`;
      expect(oldIndex.keyByUid.get(note.noteUid)).toBe(key);
      const restored = after.noteEvents.find((n) => n.noteUid === newIndex.uidByKey.get(key));
      expect(restored?.measureIndex).toBe(1);
      expect(restored?.noteUid).not.toBe(note.noteUid);
      expect(newIndex.keyByUid.get(restored!.noteUid)).toBe(key);
    }
  });

  it("detects imported alternate fingering edits without treating export or XML formatting as a new baseline", () => {
    const xml = REPAIR_XML.replace("<staff>1</staff></note>", `<staff>1</staff><notations><technical>
      <fingering placement="above">2</fingering>
      <fingering alternate="yes" placement="above">3</fingering>
    </technical></notations></note>`);
    const doc = parse(xml);
    const sourceHash = hashSourceFingerings(doc);
    writeFingeringsToScore(doc, { [doc.noteEvents[0].noteUid]: 5 }, { ignoreExistingFingerings: true });

    expect(sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSourceFingerings(doc)).toBe(sourceHash);
    expect(hashSourceFingerings(parse(xml.replace('alternate="yes" placement="above">3',
      'placement="above" alternate="yes">  3  ')))).toBe(sourceHash);

    const revised = parse(xml.replace(">3</fingering>", ">4</fingering>"));
    expect(getScoreIdentity(revised)).toEqual(getScoreIdentity(doc));
    expect(hashSourceFingerings(revised)).not.toBe(sourceHash);
  });
});

describe("Score Fingerprint", () => {
  it("hashes the ordered measure skeletons, excluding duplicate MIDI pitches and tie continuations", () => {
    const doc = parse(onePart(`
      <measure number="1">
        <attributes><divisions>2</divisions></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><tie type="start"/></note>
        <note><chord/><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration></note>
      </measure>
      <measure number="2">
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><tie type="stop"/></note>
        <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration></note>
      </measure>`));
    // Independent SHA-256 golden values: the measure JSON payloads are
    // [[0,1,null,[60]]] and [[1,1,null,[64]]], respectively.
    const measureHashes = [
      "073cd1e3ee4f08b9a557dbc2c6a1e2140e1b777b2a5cad7e5e39086deb40ded6",
      "9aae6ab85c7b6df66b7287baf00b10772dcd110105d6d381b06e6ed9d8b404ca",
    ];
    expect(getScoreIdentity(doc)).toEqual({
      measureHashes,
      fingerprint: "57147cb6ac2aa4885b243937c93d6d7969ab834c3675b48015637933b63a947d",
    });
    expect(doc.measureStructuralMeta?.map((meta) => meta.measureHash)).toEqual(measureHashes);
  });

  it("uses multiset overlap with an inclusive 85% threshold and a two-measure count guard", () => {
    const shared = Array<string>(17).fill("repeated-measure");
    const previous = [...shared, "extra-a", "extra-b"];
    expect(isSimilarScore(previous, [...shared, "extra-c"])).toBe(true); // 17 / 20
    expect(isSimilarScore(previous, [...shared.slice(1), "extra-c"])).toBe(false); // 16 / 20
    expect(isSimilarScore([...shared, "x", "y", "z"], shared)).toBe(false); // 17 / 20 but count differs by 3
    expect(isSimilarScore(previous, ["repeated-measure", ...Array<string>(18).fill("extra-b")])).toBe(false);
  });

  it("reports only the measures where pitch and note removal changed the onset-and-pitch skeleton", () => {
    const before = parse(REPAIR_XML);
    const after = repair(REPAIR_XML, before,
      { kind: "remove-note", noteUid: before.noteEvents[0].noteUid },
      { kind: "change-pitch", noteUid: before.noteEvents[3].noteUid, oldMidi: 62, newMidi: 63 },
    );
    const oldIdentity = getScoreIdentity(before);
    const newIdentity = getScoreIdentity(after);
    expect(newIdentity.fingerprint).not.toBe(oldIdentity.fingerprint);
    expect(diffMeasureIndices(oldIdentity.measureHashes, newIdentity.measureHashes)).toEqual([0, 2]);
    expect(newIdentity.measureHashes[1]).toBe(oldIdentity.measureHashes[1]);
  });

  it("publishes the canonical transition when committing a repair", () => {
    const before = parse(REPAIR_XML);
    const after = repair(REPAIR_XML, before,
      { kind: "remove-note", noteUid: before.noteEvents[0].noteUid },
      { kind: "change-pitch", noteUid: before.noteEvents[3].noteUid, oldMidi: 62, newMidi: 63 },
    );
    const store = createStudioStore();
    const xmlDeps = { DOMParser, XMLSerializer };
    store.getState().setSolvedScore({ scoreDoc: before, rawXmlText: REPAIR_XML, fileName: "test.musicxml",
      exportFormat: "musicxml", solveResult: solveFingering(before.onsetSlices, DEFAULT_HAND_SPAN_PROFILE), xmlDeps });
    const transitions: unknown[] = [];
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.lastScoreRepairTransition !== previous.lastScoreRepairTransition) transitions.push(state.lastScoreRepairTransition);
    });
    store.getState().applyScoreRepair({ scoreDoc: after, rawXmlText: new XMLSerializer().serializeToString(after.xmlDoc),
      solveResult: solveFingering(after.onsetSlices, DEFAULT_HAND_SPAN_PROFILE), xmlDeps });
    unsubscribe();
    expect(transitions).toEqual([{ previousFingerprint: getScoreIdentity(before).fingerprint,
      nextFingerprint: getScoreIdentity(after).fingerprint, modifiedMeasureIndices: [0, 2] }]);
  });

  it("remains identical after actual non-pitch repairs on the grand-staff corpus score", () => {
    const xml = readFileSync(corpus("02-grand-staff-arpeggio-chord.musicxml"), "utf8");
    const before = parse(xml);
    const atFirstChord = (midi: number) => before.noteEvents.find((n) => n.onsetTick === 0 && n.midi === midi)!.noteUid;
    const rolled = repair(xml, before, { kind: "add-arpeggiate", noteUid: atFirstChord(60) });
    const moved = repair(xml, before, { kind: "reassign-hand", noteUid: atFirstChord(64), targetHand: "LH" });
    const clipped = repair(xml, before, { kind: "clip-duration", noteUid: atFirstChord(60), newDurationTick: 1 });
    expect(rolled.noteEvents.find((n) => n.onsetTick === 0 && n.midi === 60)?.isArpeggiated).toBe(true);
    expect(moved.noteEvents.find((n) => n.onsetTick === 0 && n.midi === 64)?.writtenHand).toBe("LH");
    expect(clipped.noteEvents.find((n) => n.onsetTick === 0 && n.midi === 60)?.durationTick).toBe(1);
    const identity = getScoreIdentity(before);
    for (const revised of [rolled, moved, clipped]) expect(getScoreIdentity(revised)).toEqual(identity);
  });

  it.each([60, 64])("preserves mixed-duration chord onsets when reassigning MIDI %i", (midi) => {
    const before = parse(MIXED_CHORD_XML);
    const note = before.noteEvents.find((n) => n.midi === midi)!;
    const after = repair(MIXED_CHORD_XML, before, {
      kind: "reassign-hand",
      noteUid: note.noteUid,
      targetHand: "LH",
    });
    expect(after.noteEvents.find((n) => n.midi === midi)?.writtenHand).toBe("LH");
    expect(getScoreIdentity(after)).toEqual(getScoreIdentity(before));
  });

  it.each([60, 64])("preserves mixed-duration chord onsets when clipping MIDI %i", (midi) => {
    const before = parse(MIXED_CHORD_XML);
    const note = before.noteEvents.find((n) => n.midi === midi)!;
    const after = repair(MIXED_CHORD_XML, before, {
      kind: "clip-duration",
      noteUid: note.noteUid,
      newDurationTick: 1,
    });
    expect(after.noteEvents.find((n) => n.midi === midi)?.durationTick).toBe(1);
    expect(getScoreIdentity(after)).toEqual(getScoreIdentity(before));
  });

  it.each([6, 8])("preserves incoming notation ties when clipping a continuation to %i ticks", (newDurationTick) => {
    const tied = (type: string) => `<note><pitch><step>C</step><octave>4</octave></pitch>
      <duration>4</duration><notations><tied type="${type}"/></notations></note>`;
    const xml = onePart(`
      <measure number="1"><attributes><divisions>1</divisions></attributes>${tied("start")}</measure>
      <measure number="2">${tied("continue")}</measure>
      <measure number="3">${tied("stop")}</measure>`);
    const before = parse(xml);
    const after = repair(xml, before, {
      kind: "clip-duration", noteUid: before.noteEvents[0].noteUid, newDurationTick,
    });
    expect(after.noteEvents).toHaveLength(2);
    expect(after.noteEvents[1]).toMatchObject({ isTieStop: true, isTieStart: false, durationTick: newDurationTick - 4 });
    expect(getScoreIdentity(after)).toEqual(getScoreIdentity(before));
  });

  it("preserves the cross-staff corpus identity across MXL, XML, and annotation changes", async () => {
    const fileName = "04-tie-cross-staff-compressed.mxl";
    const before = await loadScoreInput({ fileName, bytes: readFileSync(corpus(fileName)) }, { DOMParser });
    const revised = before.rawXmlText
      .replace(/<work-title>[^<]*<\/work-title>/, "<work-title>Renamed</work-title>")
      .replace(/<(divisions|duration)>(\d+)<\/\1>/g, (_, tag, n) => `<${tag}>${Number(n) * 7}</${tag}>`)
      .replace(/tempo="[^"]+"/g, 'tempo="177"')
      .replace(/<voice>1<\/voice>/g, "<voice>7</voice>")
      .replace(/<fingering([^>]*)>[^<]*<\/fingering>/g, "<fingering$1>3</fingering>")
      .replace(/(<\/attributes>)/, `$1<direction><direction-type><dynamics><f/></dynamics>
        <pedal type="start"/></direction-type><sound tempo="81"/></direction>`);
    const plainOutput = await exportScoreOutput(revised, "musicxml");
    const plain = await loadScoreInput({ fileName: "unrelated.musicxml", text: plainOutput.text }, { DOMParser });
    const compressedOutput = await exportScoreOutput(revised, "mxl");
    const compressed = await loadScoreInput({ fileName: "repacked.mxl", bytes: compressedOutput.bytes }, { DOMParser });
    expect(getScoreIdentity(plain.scoreDoc)).toEqual(getScoreIdentity(before.scoreDoc));
    expect(getScoreIdentity(compressed.scoreDoc)).toEqual(getScoreIdentity(before.scoreDoc));
  });

  it("matches an external micro-revision of the real-world corpus score, not a rewritten passage", () => {
    const xml = readFileSync(corpus("05-realworld-wuchang.musicxml"), "utf8");
    const before = getScoreIdentity(parse(xml));
    const alteredFirstPitch = xml.replace(/<step>[A-G]<\/step>/, "<step>G</step>");
    const microRevision = getScoreIdentity(parse(alteredFirstPitch));
    const farRevision = getScoreIdentity(parse(xml.replace(/<octave>([1-7])<\/octave>/g,
      (_, octave) => `<octave>${Number(octave) + 1}</octave>`)));
    expect(diffMeasureIndices(before.measureHashes, microRevision.measureHashes)).toEqual([0]);
    expect(isSimilarScore(before.measureHashes, microRevision.measureHashes)).toBe(true);
    expect(isSimilarScore(before.measureHashes, farRevision.measureHashes)).toBe(false);
  });
});
