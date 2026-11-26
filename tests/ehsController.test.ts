import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  buildMeasureBeatSpans,
  computeEhsNoteOpacity,
  createEhsController,
  EHS_FLASH_DURATION_MS,
  getNextEhsPreset,
  getPresetBeats,
  isEhsEligibleLevel,
  recordEhsBoutProgression,
  resolveEffectiveEhsPreset,
  scoreSecToBeat,
  type EhsConfig,
  type EhsProgressionState,
} from "../src/guided/ehsController";
import { createEmptyUnitState } from "../src/guided/motorFsrs";
import {
  createPeekKeyExemptionPredicate,
  deriveScaffoldingPolicy,
} from "../src/guided/fadingScaffolding";
import { attributeContinuousBout } from "../src/guided/boundedAttribution";
import { createPianoCommandRouter, PIANO_COMMAND_MIDI } from "../src/guided/pianoCommandKeys";
import { createPracticeBackup, importPracticeBackup } from "../src/persistence/backupMerge";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import { GLOBAL_WORKSPACE } from "../src/persistence/storagePort";
import { parseMusicXml } from "../src/musicxml/parser";
import { buildPracticeSteps } from "../src/practice/waitingMode";

const DOMParserCtor = new JSDOM().window.DOMParser;

const SAMPLE_TWO_BAR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="2">
      <attributes>
        <time><beats>3</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>A</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>B</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

describe("ehsController pure beat mapping, presets, L1+ gating & opacity", () => {
  it("maps MeasureTimelines to continuous beats and resolves fixed lookahead presets", () => {
    const scoreDoc = parseMusicXml(SAMPLE_TWO_BAR_XML, { DOMParser: DOMParserCtor });
    const spans = buildMeasureBeatSpans(scoreDoc);

    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({
      measureIndex: 0,
      startBeat: 0,
      beatsInMeasure: 4,
      endBeat: 4,
      startSec: 0,
      endSec: 2,
    });
    expect(spans[1]).toMatchObject({
      measureIndex: 1,
      startBeat: 4,
      beatsInMeasure: 3,
      endBeat: 7,
      startSec: 2,
      endSec: 3.5,
    });

    // At 120 BPM, 1 beat = 0.5s
    expect(scoreSecToBeat(spans, 0.75)).toEqual({
      scoreBeat: 1.5,
      measureIndex: 0,
      beatInMeasure: 1.5,
      beatsInMeasure: 4,
    });
    expect(scoreSecToBeat(spans, 2.5)).toEqual({
      scoreBeat: 5,
      measureIndex: 1,
      beatInMeasure: 1,
      beatsInMeasure: 3,
    });

    expect(getPresetBeats("off", 4)).toBe(0);
    expect(getPresetBeats("1-beat", 4)).toBe(1);
    expect(getPresetBeats("2-beats", 4)).toBe(2);
    expect(getPresetBeats("1-bar", 4)).toBe(4);
    expect(getPresetBeats("1-bar", 3)).toBe(3);
  });

  it("gates EHS strictly to L1+ continuous play (disabled at L0 Stage 0) and defaults to off", () => {
    expect(isEhsEligibleLevel(0)).toBe(false);
    expect(isEhsEligibleLevel(1)).toBe(true);
    expect(isEhsEligibleLevel(2)).toBe(true);
    expect(isEhsEligibleLevel(3)).toBe(true);

    expect(
      resolveEffectiveEhsPreset({ enabled: false, preset: "2-beats", scaffoldingLevel: 2 }),
    ).toBe("off");
    expect(
      resolveEffectiveEhsPreset({ enabled: true, preset: "2-beats", scaffoldingLevel: 0 }),
    ).toBe("off");
    expect(
      resolveEffectiveEhsPreset({ enabled: true, preset: "2-beats", scaffoldingLevel: 1 }),
    ).toBe("2-beats");
    expect(
      resolveEffectiveEhsPreset({ enabled: true, preset: "1-bar", scaffoldingLevel: 3 }),
    ).toBe("1-bar");
  });

  it("computes per-note opacity dissolving passed/struck notes to 0 or 0.06 ghost ink", () => {
    // Passed note (aheadBeats <= 0) dissolves to ghostOpacity (0 or 0.06)
    expect(
      computeEhsNoteOpacity({
        noteScoreBeat: 2.0,
        frontierBeat: 2.0,
        ghostOpacity: 0,
        isMasked: true,
      }),
    ).toBe(0);
    expect(
      computeEhsNoteOpacity({
        noteScoreBeat: 1.5,
        frontierBeat: 2.0,
        ghostOpacity: 0.06,
        isMasked: true,
      }),
    ).toBe(0.06);

    // Upcoming note inside fade ramp (0 < aheadBeats < 0.85) smoothly transitions between ghost and 1
    const midFade = computeEhsNoteOpacity({
      noteScoreBeat: 2.425,
      frontierBeat: 2.0,
      ghostOpacity: 0.06,
      isMasked: true,
    });
    expect(midFade).toBeGreaterThan(0.06);
    expect(midFade).toBeLessThan(1);

    // Upcoming note beyond fade width stays 100% sharp
    expect(
      computeEhsNoteOpacity({
        noteScoreBeat: 3.0,
        frontierBeat: 2.0,
        ghostOpacity: 0.06,
        isMasked: true,
      }),
    ).toBe(1);

    // MIDI-struck note dissolves immediately even if ahead of frontier
    expect(
      computeEhsNoteOpacity({
        noteScoreBeat: 3.0,
        frontierBeat: 2.0,
        ghostOpacity: 0.06,
        isStruck: true,
        isMasked: true,
      }),
    ).toBe(0.06);

    // Manual peek (isMasked: false) or local auto-stall measure flash reveals full opacity
    expect(
      computeEhsNoteOpacity({
        noteScoreBeat: 1.0,
        frontierBeat: 2.0,
        ghostOpacity: 0,
        isStruck: true,
        isMasked: false,
      }),
    ).toBe(1);
    expect(
      computeEhsNoteOpacity({
        noteScoreBeat: 1.0,
        frontierBeat: 2.0,
        ghostOpacity: 0,
        isMasked: true,
        isMeasureFlashed: true,
      }),
    ).toBe(1);
  });

  it("keeps lookahead preset strictly fixed intra-bout without rubber-banding jitter and suggests bout-to-bout progression", () => {
    const scoreDoc = parseMusicXml(SAMPLE_TWO_BAR_XML, { DOMParser: DOMParserCtor });
    const steps = buildPracticeSteps(scoreDoc, "both");
    const ctrl = createEhsController();
    const config: EhsConfig = {
      enabled: true,
      preset: "2-beats",
      ghostOpacity: 0.06,
      autoStallFlashEnabled: true,
    };

    ctrl.resetForBout({ startScoreSec: 0 });
    // Before MIDI or after clean hits or after late hesitation, lookaheadBeats stays strictly 2
    const snap0 = ctrl.tick({
      nowMs: 1000,
      scoreDoc,
      scoreSec: 0.1,
      isPlaying: true,
      speedMultiplier: 1,
      practiceSteps: steps,
      config,
      scaffoldingLevel: 1,
      manualPeekActive: false,
    });
    expect(snap0.lookaheadBeats).toBe(2);
    expect(snap0.frontierBeat).toBeCloseTo(0.2 + 2, 4);

    // Late hit (+250ms hesitation) must NOT shrink lookaheadBeats
    ctrl.recordMidiNoteOn({
      midi: 72,
      nowMs: 1250,
      scoreSec: 0.25,
      speedMultiplier: 1,
      practiceSteps: steps,
    });
    const snap1 = ctrl.tick({
      nowMs: 1500,
      scoreDoc,
      scoreSec: 0.5,
      isPlaying: true,
      speedMultiplier: 1,
      practiceSteps: steps,
      config,
      scaffoldingLevel: 1,
      manualPeekActive: false,
    });
    expect(snap1.lookaheadBeats).toBe(2);

    // Bout-to-bout progression: 1-beat -> 2-beats -> 1-bar after 2 consecutive smooth passes
    expect(getNextEhsPreset("1-beat")).toBe("2-beats");
    expect(getNextEhsPreset("2-beats")).toBe("1-bar");
    expect(getNextEhsPreset("1-bar")).toBeNull();

    let prog: EhsProgressionState = { preset: "1-beat", consecutiveSmoothPasses: 0 };
    const r1 = recordEhsBoutProgression(prog, {
      ehsActive: true,
      autoGrade: 3,
      pitchAccuracy: 1,
      interiorHesitationCount: 0,
      stallDetected: false,
    });
    expect(r1.prompt).toBeNull();
    prog = r1.nextState;
    expect(prog.consecutiveSmoothPasses).toBe(1);

    // Non-smooth pass resets streak
    const rInterrupted = recordEhsBoutProgression(prog, {
      ehsActive: true,
      autoGrade: 2,
      pitchAccuracy: 0.9,
      interiorHesitationCount: 1,
      stallDetected: false,
    });
    expect(rInterrupted.prompt).toBeNull();
    expect(rInterrupted.nextState.consecutiveSmoothPasses).toBe(0);

    // 2 consecutive smooth passes emits prompt 1-beat -> 2-beats
    const r2a = recordEhsBoutProgression(rInterrupted.nextState, {
      ehsActive: true,
      autoGrade: 4,
      pitchAccuracy: 1,
      interiorHesitationCount: 0,
      stallDetected: false,
    });
    const r2b = recordEhsBoutProgression(r2a.nextState, {
      ehsActive: true,
      autoGrade: 3,
      pitchAccuracy: 0.98,
      interiorHesitationCount: 0,
      stallDetected: false,
    });
    expect(r2b.prompt).toMatchObject({
      fromPreset: "1-beat",
      toPreset: "2-beats",
      consecutiveSmoothPasses: 2,
    });
  });

  it("triggers 1.5s local measure auto-stall flash after >= 2 consecutive missed steps (and respects opt-out)", () => {
    const scoreDoc = parseMusicXml(SAMPLE_TWO_BAR_XML, { DOMParser: DOMParserCtor });
    const steps = buildPracticeSteps(scoreDoc, "both");
    const ctrl = createEhsController();
    const baseConfig: EhsConfig = {
      enabled: true,
      preset: "2-beats",
      ghostOpacity: 0.06,
      autoStallFlashEnabled: true,
    };

    ctrl.resetForBout({ startScoreSec: 0 });
    // Strike step 0 (C5 at t=0s) so MIDI activity is active in bout
    ctrl.recordMidiNoteOn({
      midi: 72,
      nowMs: 1000,
      scoreSec: 0.02,
      speedMultiplier: 1,
      practiceSteps: steps,
    });

    // Advance past step 1 (D5 at 0.5s) -> only 1 missed step, no flash yet
    const after1Miss = ctrl.tick({
      nowMs: 1900,
      scoreDoc,
      scoreSec: 0.9,
      isPlaying: true,
      speedMultiplier: 1,
      practiceSteps: steps,
      config: baseConfig,
      scaffoldingLevel: 1,
      manualPeekActive: false,
    });
    expect(after1Miss.consecutiveMissedSteps).toBe(1);
    expect(after1Miss.autoStallMeasureIndex).toBeNull();

    // Advance past step 2 (E5 at 1.0s) -> 2 consecutive missed steps triggers 1500ms local measure flash!
    const after2Miss = ctrl.tick({
      nowMs: 2400,
      scoreDoc,
      scoreSec: 1.4,
      isPlaying: true,
      speedMultiplier: 1,
      practiceSteps: steps,
      config: baseConfig,
      scaffoldingLevel: 1,
      manualPeekActive: false,
    });
    expect(after2Miss.autoStallMeasureIndex).toBe(0);
    expect(after2Miss.autoStallRemainingMs).toBe(EHS_FLASH_DURATION_MS);
    expect(after2Miss.stallFlashCount).toBe(1);
    expect(after2Miss.isMasked).toBe(true); // Only local measure 0 flashes; global mask remains active

    // Still active at +1000ms, expired at +1500ms
    const midFlash = ctrl.tick({
      nowMs: 3400,
      scoreDoc,
      scoreSec: 1.45,
      isPlaying: true,
      speedMultiplier: 1,
      practiceSteps: steps,
      config: baseConfig,
      scaffoldingLevel: 1,
      manualPeekActive: false,
    });
    expect(midFlash.autoStallMeasureIndex).toBe(0);
    expect(midFlash.autoStallRemainingMs).toBe(500);

    const afterExpiry = ctrl.tick({
      nowMs: 3900,
      scoreDoc,
      scoreSec: 1.48,
      isPlaying: true,
      speedMultiplier: 1,
      practiceSteps: steps,
      config: baseConfig,
      scaffoldingLevel: 1,
      manualPeekActive: false,
    });
    expect(afterExpiry.autoStallMeasureIndex).toBeNull();
    expect(afterExpiry.autoStallRemainingMs).toBe(0);

    // Opt-out: autoStallFlashEnabled = false suppresses local flash
    ctrl.resetForBout({ startScoreSec: 0 });
    ctrl.recordMidiNoteOn({
      midi: 72,
      nowMs: 5000,
      scoreSec: 0.02,
      speedMultiplier: 1,
      practiceSteps: steps,
    });
    const optOutSnap = ctrl.tick({
      nowMs: 6500,
      scoreDoc,
      scoreSec: 1.4,
      isPlaying: true,
      speedMultiplier: 1,
      practiceSteps: steps,
      config: { ...baseConfig, autoStallFlashEnabled: false },
      scaffoldingLevel: 1,
      manualPeekActive: false,
    });
    expect(optOutSnap.consecutiveMissedSteps).toBe(2);
    expect(optOutSnap.autoStallMeasureIndex).toBeNull();
  });

  it("enables B0/F 1.5s peek and attribution exemption on L1+ when ehsOverlayActive is true without replacing L3", () => {
    const baseUnit = createEmptyUnitState({
      unitId: "c1",
      unitKind: "chunk",
      startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
      endCoord: { measureIndex: 1, beatNum: 0, beatDen: 1 },
      measureIndices: [0],
      targetSpeed: 1.0,
    });
    // L1 with ehsOverlayActive: cuesObscured=true, level stays 1
    const l1WithEhs = deriveScaffoldingPolicy(
      {
        ...baseUnit,
        reviewCount: 1,
        sleepConsolidatedNights: 0,
        stableSpeed: 0.65,
        targetSpeed: 0.75,
        handStage: "both",
        lastEffectiveGrade: 3,
      },
      { ehsOverlayActive: true },
    );
    expect(l1WithEhs.level).toBe(1);
    expect(l1WithEhs.cuesObscured).toBe(true);

    // L3 remains L3 even with ehsOverlayActive (EHS never replaces L3)
    const l3WithEhs = deriveScaffoldingPolicy(
      {
        ...baseUnit,
        reviewCount: 4,
        sleepConsolidatedNights: 2,
        stableSpeed: 0.95,
        targetSpeed: 1.0,
        handStage: "both",
        lastEffectiveGrade: 3,
      },
      { ehsOverlayActive: true },
    );
    expect(l3WithEhs.level).toBe(3);
    expect(l3WithEhs.scoreFingeringMode).toBe("none");
    expect(l3WithEhs.useCountInOnlyMetronome).toBe(true);

    // B0 collision guard + Bounded Window Attribution exemption
    const router = createPianoCommandRouter();
    const peekRes = router.routeMidi(
      { type: "noteon", midi: PIANO_COMMAND_MIDI.B0, velocity: 70, timeStampMs: 1200, source: "midi", channel: 0, portId: "p1" },
      {
        phase: "playing",
        firstTargetMidis: [72],
        chunkMidis: [72, 74, 76],
        cc64CommandEnabled: false,
        cuesObscured: l1WithEhs.cuesObscured,
      },
    );
    expect(peekRes.action).toBe("peek-fingerings");

    const blockedRes = router.routeMidi(
      { type: "noteon", midi: PIANO_COMMAND_MIDI.B0, velocity: 70, timeStampMs: 1200, source: "midi", channel: 0, portId: "p1" },
      {
        phase: "playing",
        firstTargetMidis: [23],
        chunkMidis: [23, 72],
        cc64CommandEnabled: false,
        cuesObscured: l1WithEhs.cuesObscured,
      },
    );
    expect(blockedRes.action).toBe("none");
    expect(blockedRes.b0PeekDisabled).toBe(true);

    // Attribution exempts B0 peek strike
    const scoreDoc = parseMusicXml(SAMPLE_TWO_BAR_XML, { DOMParser: DOMParserCtor });
    const steps = buildPracticeSteps(scoreDoc, "both").slice(0, 2);
    const attr = attributeContinuousBout({
      clockAnchor: {
        t0PerfMs: 1000,
        audioStartTimeSec: 0,
        startScoreSec: 0,
        endScoreSec: 1,
        speedMultiplier: 1,
      },
      expectedSteps: steps,
      midiEvents: [
        { type: "noteon", midi: 72, velocity: 80, timeStampMs: 1000, source: "midi", channel: 0, portId: "p1" },
        { type: "noteon", midi: PIANO_COMMAND_MIDI.B0, velocity: 65, timeStampMs: 1200, source: "midi", channel: 0, portId: "p1" },
        { type: "noteon", midi: 74, velocity: 80, timeStampMs: 1500, source: "midi", channel: 0, portId: "p1" },
      ],
      measureTimelines: scoreDoc.measureTimelines,
      practiceMode: "both",
      isExemptPeekKey: createPeekKeyExemptionPredicate([1200]),
    });
    expect(attr.extraEvents).toHaveLength(0);
    expect(attr.filteredExemptCount).toBe(1);
    expect(attr.fluency.pitchAccuracy).toBe(1);
  });

  it("persists and merges EHS WorkspacePrefs (ehsEnabled, ehsLookaheadPreset, ehsGhostOpacity, ehsAutoStallFlashEnabled)", async () => {
    const srcStorage = createInMemoryStorage();
    await srcStorage.commit({
      workspacePrefs: [
        {
          scopeKey: GLOBAL_WORKSPACE,
          ehsEnabled: true,
          ehsLookaheadPreset: "1-bar",
          ehsGhostOpacity: 0,
          ehsAutoStallFlashEnabled: false,
          updatedAtMs: 5000,
        },
      ],
    });

    const backup = await createPracticeBackup(srcStorage);
    const dstStorage = createInMemoryStorage();
    await importPracticeBackup(dstStorage, backup.metadataOnlyJson);

    const restored = await dstStorage.get("workspacePrefs", GLOBAL_WORKSPACE);
    expect(restored).toMatchObject({
      ehsEnabled: true,
      ehsLookaheadPreset: "1-bar",
      ehsGhostOpacity: 0,
      ehsAutoStallFlashEnabled: false,
    });

    // Rejects invalid EHS pref values during backup parse
    const tampered = JSON.parse(backup.metadataOnlyJson);
    tampered.workspacePrefs[0].ehsGhostOpacity = 0.5;
    await expect(
      importPracticeBackup(createInMemoryStorage(), JSON.stringify(tampered)),
    ).rejects.toThrow();
  });
});
