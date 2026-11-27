// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaybackEngine, SegmentPlayOptions } from "../src/audio/playbackEngine";
import type { MacroSection, MotorChunk } from "../src/chunking/types";
import type { PracticeStep, ScoreDocument } from "../src/domain/types";
import type { PiecePracticeState } from "../src/guided/motorFsrs";
import { SOFT_INVALIDATION_STABILITY_FACTOR } from "../src/guided/replayInvalidation";
import { useGuidedSessionController, type UseGuidedSessionControllerOptions } from "../src/hooks/useGuidedSessionController";
import { parseMusicXml } from "../src/musicxml/parser";
import { getScoreIdentity } from "../src/persistence/fingerprint";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import type { PieceProfile, PracticeEvent } from "../src/persistence/storagePort";
import { buildPracticeSteps } from "../src/practice/waitingMode";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const FOUR_MEASURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction><sound tempo="120"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>D</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note>
    </measure>
    <measure number="3">
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>A</step><octave>2</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note>
    </measure>
    <measure number="4">
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>B</step><octave>2</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

let mountedRoot: Root | null = null;
let mountedContainer: HTMLElement | null = null;

afterEach(() => {
  if (mountedRoot) {
    act(() => {
      mountedRoot!.unmount();
    });
    mountedRoot = null;
  }
  if (mountedContainer) {
    mountedContainer.remove();
    mountedContainer = null;
  }
});

type ControllerApi = ReturnType<typeof useGuidedSessionController>;

function mountController(initialProps: UseGuidedSessionControllerOptions) {
  let latestApi: ControllerApi | null = null;
  function Harness(props: UseGuidedSessionControllerOptions) {
    latestApi = useGuidedSessionController(props);
    return null;
  }
  mountedContainer = document.createElement("div");
  document.body.appendChild(mountedContainer);
  mountedRoot = createRoot(mountedContainer);
  act(() => {
    mountedRoot!.render(createElement(Harness, initialProps));
  });
  return {
    getApi: () => latestApi!,
    rerender: (nextProps: UseGuidedSessionControllerOptions) => {
      act(() => {
        mountedRoot!.render(createElement(Harness, nextProps));
      });
    },
  };
}

function makeFakePlaybackEngine() {
  const playSegmentCalls: SegmentPlayOptions[] = [];
  const engine = {
    getSpeed: () => 1,
    setSpeed: vi.fn(),
    setCountInEnabled: vi.fn(),
    setMetronomePaused: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    playSegment: vi.fn(async (_doc: ScoreDocument, opts: SegmentPlayOptions) => {
      playSegmentCalls.push(opts);
    }),
  } as unknown as PlaybackEngine;
  return { engine, playSegmentCalls };
}

function makeChunk(
  chunkId: string,
  index: number,
  startMeasureIndex: number,
  endMeasureIndex: number,
  stepCount: number,
  overrides: Partial<MotorChunk> = {},
): MotorChunk {
  const measureCount = endMeasureIndex - startMeasureIndex + 1;
  return {
    chunkId,
    index,
    sectionId: "s0",
    startMeasureIndex,
    endMeasureIndex,
    startCoord: { measureIndex: startMeasureIndex, beatNum: 0, beatDen: 1 },
    endCoord: { measureIndex: endMeasureIndex + 1, beatNum: 0, beatDen: 1 },
    measureCount,
    stepCount,
    densityStepsPerMeasure: stepCount / Math.max(1, measureCount),
    hasAnacrusisLeadIn: false,
    anacrusisBeats: 0,
    overlapFlag: false,
    boundaryConfidence: 1,
    ...overrides,
  };
}

describe("useGuidedSessionController review fixes", () => {
  it("stops continuous play accurately at mid-measure anacrusis endCoord and passes muteTargetHand: true", async () => {
    const scoreDoc = parseMusicXml(FOUR_MEASURE_XML, { DOMParser });
    const practiceSteps: PracticeStep[] = buildPracticeSteps(scoreDoc, "both");

    // Chunk 0 stops at measure 1 beat 3 (3.5s) before an anacrusis pickup at measure 1 beat 3..4
    const motorChunks: MotorChunk[] = [
      makeChunk("chunk-anacrusis-0", 0, 0, 1, 4, {
        sectionId: "sec-0",
        endCoord: { measureIndex: 1, beatNum: 3, beatDen: 1 },
      }),
      makeChunk("chunk-anacrusis-1", 1, 1, 3, 3, {
        sectionId: "sec-0",
        startCoord: { measureIndex: 1, beatNum: 3, beatDen: 1 },
        hasAnacrusisLeadIn: true,
        anacrusisBeats: 1,
      }),
    ];
    const macroSections: MacroSection[] = [
      {
        sectionId: "sec-0",
        index: 0,
        startMeasureIndex: 0,
        endMeasureIndex: 3,
        startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
        endCoord: { measureIndex: 4, beatNum: 0, beatDen: 1 },
        measureCount: 4,
        label: "A",
        boundaryReason: "start",
        chunkIds: ["chunk-anacrusis-0", "chunk-anacrusis-1"],
      },
    ];

    const { engine, playSegmentCalls } = makeFakePlaybackEngine();
    const { getApi } = mountController({
      scoreDoc,
      solveResult: null,
      practiceSteps,
      motorChunks,
      macroSections,
      effectivePracticeMode: "both",
      playbackSpeed: 1,
      playbackEngineRef: { current: engine },
      audioEngineRef: { current: null },
      countInEnabled: true,
      setMidiCaptureMode: vi.fn(),
      resetMidiCapture: vi.fn(),
      syncWaitingToStep: vi.fn(),
      resetWaitingCursor: vi.fn(),
      nowMs: () => 10_000,
      getTimezoneOffsetMin: () => 0,
    });

    act(() => {
      getApi().enterGuidedLaunch();
    });
    act(() => {
      getApi().handleStartSession();
    });

    // Graduate Stage 0 of chunk 0 by completing each step in chunk 0
    const stepCount = getApi().activeChunkSteps.length;
    expect(stepCount).toBe(4); // m0 beat 0 + m1 beats 0, 1, 2 (stops before beat 3!)
    for (let i = 0; i < stepCount; i++) {
      act(() => {
        getApi().handleStage0StepCompleted(i);
      });
    }

    expect(playSegmentCalls.length).toBe(1);
    // Measure 0 is 2.0s, measure 1 beat 3 is 2.0 + 1.5 = 3.5s (NOT 4.0s!)
    expect(playSegmentCalls[0].endScoreSec).toBeCloseTo(3.5, 4);
    expect(playSegmentCalls[0].muteTargetHand).toBe(true);
  });

  it("projects PiecePracticeState via projectPieceStateForScore on load and commit while keeping derivedSnapshots un-projected for Undo", async () => {
    const docV1 = parseMusicXml(FOUR_MEASURE_XML, { DOMParser });
    const xmlV2 = FOUR_MEASURE_XML.replace(
      "<note><pitch><step>C</step><octave>4</octave></pitch>",
      "<note><pitch><step>C</step><alter>1</alter><octave>4</octave></pitch>",
    );
    const docV2 = parseMusicXml(xmlV2, { DOMParser });

    const idV1 = getScoreIdentity(docV1);
    const idV2 = getScoreIdentity(docV2);
    expect(idV1.fingerprint).not.toBe(idV2.fingerprint);

    const motorChunks: MotorChunk[] = [
      makeChunk("c0", 0, 0, 1, 5),
      makeChunk("c1", 1, 2, 3, 2),
    ];
    const macroSections: MacroSection[] = [
      {
        sectionId: "s0",
        index: 0,
        startMeasureIndex: 0,
        endMeasureIndex: 3,
        startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
        endCoord: { measureIndex: 4, beatNum: 0, beatDen: 1 },
        measureCount: 4,
        label: "A",
        boundaryReason: "start",
        chunkIds: ["c0", "c1"],
      },
    ];

    const storage = createInMemoryStorage();
    const profile: PieceProfile = {
      pieceId: "piece-1",
      title: "Test Piece",
      fingerprints: [idV1.fingerprint, idV2.fingerprint],
      measureHashesByFingerprint: {
        [idV1.fingerprint]: idV1.measureHashes,
        [idV2.fingerprint]: idV2.measureHashes,
      },
    };
    const makeEv = (
      eventId: string,
      chunk: MotorChunk,
      ts: number,
      dateKey: string,
    ): PracticeEvent => ({
      eventId,
      pieceId: "piece-1",
      scoreFingerprint: idV1.fingerprint,
      timestampMs: ts,
      localDateKey: dateKey,
      timezoneOffsetMin: 0,
      sessionId: "sess-0",
      boutKind: "chunk",
      startCoord: chunk.startCoord,
      endCoord: chunk.endCoord,
      practiceMode: "both",
      speedMultiplier: 1,
      durationSec: 4,
      passCount: 1,
      wasColdFirstPass: true,
      scaffoldingLevel: 1,
      autoGrade: 4,
      fluency: {
        pitchAccuracy: 1,
        interiorHesitationCount: 0,
        junctionHesitationRatio: 1,
        timingCv: 0.02,
        stallDetected: false,
        dominantHandFaultRatio: { rh: 0, lh: 0 },
        switchBranchMismatch: false,
        reanchorCount: 0,
      },
      measureFaultCounts: {},
    });

    await storage.commit({
      pieceProfiles: [profile],
      practiceEvents: [
        makeEv("ev-c0-1", motorChunks[0], 1_000_000, "2026-11-20"),
        makeEv("ev-c0-2", motorChunks[0], 1_000_000 + 86_400_000, "2026-11-21"),
        makeEv("ev-c1-1", motorChunks[1], 1_000_100, "2026-11-20"),
        makeEv("ev-c1-2", motorChunks[1], 1_000_100 + 86_400_000, "2026-11-21"),
      ],
    });

    const { engine, playSegmentCalls } = makeFakePlaybackEngine();
    const stepsV1 = buildPracticeSteps(docV1, "both");
    const stepsV2 = buildPracticeSteps(docV2, "both");
    const stableNowMs = () => 1_000_000 + 2 * 86_400_000;
    const stableTz = () => 0;
    const stableEmptyChunks: never[] = [];
    const stableSetMidiMode = vi.fn();
    const stableResetMidi = vi.fn();
    const stableSyncWaiting = vi.fn();
    const stableResetCursor = vi.fn();
    const baseOpts = (doc: ScoreDocument, steps: PracticeStep[]): UseGuidedSessionControllerOptions => ({
      scoreDoc: doc,
      solveResult: null,
      practiceSteps: steps,
      motorChunks,
      macroSections,
      chunkJunctions: stableEmptyChunks,
      passageClusters: stableEmptyChunks,
      performanceCues: stableEmptyChunks,
      effectivePracticeMode: "both",
      playbackSpeed: 1,
      playbackEngineRef: { current: engine },
      audioEngineRef: { current: null },
      countInEnabled: true,
      practiceStorage: storage,
      activePieceProfile: profile,
      setMidiCaptureMode: stableSetMidiMode,
      resetMidiCapture: stableResetMidi,
      syncWaitingToStep: stableSyncWaiting,
      resetWaitingCursor: stableResetCursor,
      nowMs: stableNowMs,
      getTimezoneOffsetMin: stableTz,
    });

    const { getApi, rerender } = mountController(baseOpts(docV2, stepsV2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const snapAfterLoad = await storage.get("derivedSnapshots", "piece-1");
    const baseSnapshotState = snapAfterLoad?.state as PiecePracticeState;
    expect(baseSnapshotState.chunkStates["c0"].needsRevisionReview).toBeFalsy();
    const origC0Stability = baseSnapshotState.chunkStates["c0"].stabilityDays;
    const origC1Stability = baseSnapshotState.chunkStates["c1"].stabilityDays;

    // Runtime state on docV2 is soft-invalidated for c0 (measure 0 changed) and untouched for c1
    const projectedOnV2 = getApi().piecePracticeState!;
    expect(projectedOnV2.chunkStates["c0"].needsRevisionReview).toBe(true);
    expect(projectedOnV2.chunkStates["c0"].changedMeasureIndices).toEqual([0]);
    expect(projectedOnV2.chunkStates["c0"].stabilityDays).toBeCloseTo(
      Math.max(0.25, origC0Stability * SOFT_INVALIDATION_STABILITY_FACTOR),
      4,
    );
    expect(projectedOnV2.chunkStates["c1"].needsRevisionReview).toBeFalsy();
    expect(projectedOnV2.chunkStates["c1"].stabilityDays).toBeCloseTo(origC1Stability, 6);

    // Undo back to docV1 restores 100% original stability
    rerender(baseOpts(docV1, stepsV1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const restoredOnV1 = getApi().piecePracticeState!;
    expect(restoredOnV1.chunkStates["c0"].needsRevisionReview).toBeFalsy();
    expect(restoredOnV1.chunkStates["c0"].stabilityDays).toBeCloseTo(origC0Stability, 6);

    // Switch back to docV2 and commit a new bout event -> post-commit projection still preserves soft invalidation on c0
    rerender(baseOpts(docV2, stepsV2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    act(() => {
      getApi().enterGuidedLaunch();
    });
    act(() => {
      getApi().handleStartSession();
    });
    // Complete Stage 0 or skip if skipStage0, then finish playSegment
    if (getApi().sessionPhase === "stage0") {
      const count = getApi().activeChunkSteps.length;
      for (let i = 0; i < count; i++) {
        act(() => {
          getApi().handleStage0StepCompleted(i);
        });
      }
    }
    expect(playSegmentCalls.length).toBeGreaterThan(0);
    await act(async () => {
      playSegmentCalls[playSegmentCalls.length - 1].onSegmentComplete?.();
      await new Promise((r) => setTimeout(r, 30));
    });

    // If the session ran c1 (which had untouched measureHashes), c0 must remain soft-invalidated!
    // And derivedSnapshots must remain un-projected!
    const snapAfterCommit = await storage.get("derivedSnapshots", "piece-1");
    const postCommitBase = snapAfterCommit?.state as PiecePracticeState;
    expect(postCommitBase.chunkStates["c0"].needsRevisionReview).toBeFalsy();
    if (getApi().activeChunk?.chunkId !== "c0") {
      expect(getApi().piecePracticeState!.chunkStates["c0"].needsRevisionReview).toBe(true);
    }
  });

  it("keeps graduated chunks in continuous play on A0 replay-chunk while returning ungraduated Stage-0 chunks to Stage 0", async () => {
    const scoreDoc = parseMusicXml(FOUR_MEASURE_XML, { DOMParser });
    const practiceSteps: PracticeStep[] = buildPracticeSteps(scoreDoc, "both");
    const motorChunks: MotorChunk[] = [
      makeChunk("c0", 0, 0, 1, 5),
      makeChunk("c1", 1, 2, 3, 2),
    ];
    const macroSections: MacroSection[] = [
      {
        sectionId: "s0",
        index: 0,
        startMeasureIndex: 0,
        endMeasureIndex: 3,
        startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
        endCoord: { measureIndex: 4, beatNum: 0, beatDen: 1 },
        measureCount: 4,
        label: "A",
        boundaryReason: "start",
        chunkIds: ["c0", "c1"],
      },
    ];

    const { engine, playSegmentCalls } = makeFakePlaybackEngine();
    const { getApi } = mountController({
      scoreDoc,
      solveResult: null,
      practiceSteps,
      motorChunks,
      macroSections,
      effectivePracticeMode: "both",
      playbackSpeed: 1,
      playbackEngineRef: { current: engine },
      audioEngineRef: { current: null },
      countInEnabled: true,
      setMidiCaptureMode: vi.fn(),
      resetMidiCapture: vi.fn(),
      syncWaitingToStep: vi.fn(),
      resetWaitingCursor: vi.fn(),
      nowMs: () => 50_000,
      getTimezoneOffsetMin: () => 0,
    });

    act(() => {
      getApi().enterGuidedLaunch();
    });
    act(() => {
      getApi().handleStartSession();
    });

    // Graduate Stage 0 of chunk 0 -> now sessionPhase is "playing", unitRuntime.phase is still 0
    const { useGuidedSessionStore } = await import("../src/store/useGuidedSessionStore");
    const count = getApi().activeChunkSteps.length;
    for (let i = 0; i < count; i++) {
      act(() => {
        getApi().handleStage0StepCompleted(i);
      });
    }
    expect(getApi().sessionPhase).toBe("playing");
    const chunkId = getApi().activeChunk!.chunkId;
    expect(useGuidedSessionStore.getState().schedulerState?.units[chunkId]?.phase).toBe(0);

    // Pause ungraduated (phase 0) chunk, then A0 -> returns to Stage 0
    act(() => {
      getApi().executeCommandAction("emergency-pause");
    });
    expect(getApi().sessionPhase).toBe("paused");
    act(() => {
      getApi().executeCommandAction("replay-chunk");
    });
    expect(getApi().sessionPhase).toBe("stage0");

    // Re-graduate Stage 0 and simulate unit having graduated to phase 1 (L1–L3)
    for (let i = 0; i < count; i++) {
      act(() => {
        getApi().handleStage0StepCompleted(i);
      });
    }
    expect(getApi().sessionPhase).toBe("playing");
    const curSched = useGuidedSessionStore.getState().schedulerState!;
    act(() => {
      useGuidedSessionStore.getState().setSchedulerState({
        ...curSched,
        units: {
          ...curSched.units,
          [chunkId]: {
            ...curSched.units[chunkId],
            phase: 1,
            phase0SteadyPassDone: true,
          },
        },
      });
    });
    const playCallsBefore = playSegmentCalls.length;

    // Pause graduated (phase >= 1) chunk, then trigger A0 (replay-chunk) -> must stay in continuous playing!
    act(() => {
      getApi().executeCommandAction("emergency-pause");
    });
    expect(getApi().sessionPhase).toBe("paused");
    act(() => {
      getApi().executeCommandAction("replay-chunk");
    });
    expect(getApi().sessionPhase).toBe("playing");
    expect(getApi().stage0State).toBeNull();
    expect(playSegmentCalls.length).toBe(playCallsBefore + 1);
  });

  it("finishMicroRest transitions cleanly to audiation or summary identically to skipMicroRest", async () => {
    const { useGuidedSessionStore } = await import("../src/store/useGuidedSessionStore");
    const store = useGuidedSessionStore.getState();
    store.reset();
    const chunkA = makeChunk("a", 0, 0, 0, 1);
    const chunkB = makeChunk("b", 1, 1, 1, 1);
    useGuidedSessionStore.setState({
      studioMode: "guided",
      sessionPhase: "micro-rest",
      chunkQueue: [chunkA, chunkB],
      currentQueueIndex: 0,
    });
    useGuidedSessionStore.getState().finishMicroRest(12_345);
    expect(useGuidedSessionStore.getState().sessionPhase).toBe("audiation");
    expect(useGuidedSessionStore.getState().audiationState?.chunkId).toBe("b");

    useGuidedSessionStore.setState({
      sessionPhase: "micro-rest",
      currentQueueIndex: 1,
    });
    useGuidedSessionStore.getState().finishMicroRest(12_999);
    expect(useGuidedSessionStore.getState().sessionPhase).toBe("summary");
    expect(useGuidedSessionStore.getState().audiationState).toBeNull();
    useGuidedSessionStore.getState().reset();
  });
});
