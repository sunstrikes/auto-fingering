import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  createDefaultAbLoopBounds,
  normalizeAbLoopBounds,
  type AbLoopBounds,
  type AnchorOverride,
  type AnchorOverrideMode,
  type Finger,
  type Hand,
  type HandSpanProfile,
  type PracticeMode,
  type PracticeStep,
  type PriorMode,
  type ScoreDocument,
  type ScoreRepairOption,
  type ScoreRepairSuggestion,
  type TransitionCue,
  type WaitingModeState,
} from "./domain/types";
import {
  advanceWaitingHoldProgress,
  buildPracticeSteps,
  createWaitingModeState,
  doesNoteOnMatchPausedStep,
  findAbLoopStepRange,
  handleWaitingNoteOffWithResult,
  handleWaitingNoteOn,
  type WaitingStepAdvanceResult,
} from "./practice/waitingMode";
import {
  buildMeasureErrorSummaries,
  buildPracticeRepeatRecommendations,
  createPracticeAnalyticsState,
  evaluatePracticeProgression,
  recordPracticeStepCompleted,
  recordPracticeStepFault,
  resetCurrentPracticePass,
  type PracticeAnalyticsState,
  type PracticeRepeatRecommendation,
} from "./practice/practiceAnalytics";
import { useScreenWakeLock } from "./practice/useScreenWakeLock";
import type { MxlContainer } from "./musicxml/mxl";
import { parseMusicXml } from "./musicxml/parser";
import {
  applyAllScoreRepairsToXml,
  applyScoreRepairToXml,
  type BatchScoreRepairSelection,
} from "./musicxml/repairWriter";
import { exportScoreOutput, loadScoreInput, type ExportFormat } from "./musicxml/scoreSession";
import { applyAnchorOverridesToSlices, localResolveFingering } from "./solver/localResolve";
import type { PriorLoadProgress } from "./prior/loader";
import { createSolverClient, SolverCancelledError, type SolverClient } from "./workers/solverClient";
import { computeNextAnchorState, useStudioStore } from "./store/useStudioStore";
import { useGuidedSessionStore } from "./store/useGuidedSessionStore";
import type { PracticeStoragePort } from "./persistence/storagePort";
import { remapAnchorState, type AnchorState } from "./persistence/anchorDrafts";
import { usePracticePersistence } from "./hooks/usePracticePersistence";
import { useWorkspaceScoreLifecycle } from "./hooks/useWorkspaceScoreLifecycle";
import { useGuidedSessionController } from "./hooks/useGuidedSessionController";
import { GuidedSessionLaunchCard } from "./components/GuidedSessionLaunchCard";
import { GuidedResumePill, GuidedSessionHeader } from "./components/GuidedSessionHeader";
import { PracticeBackupPanel, ScoreOpenChoice } from "./components/PracticeBackupPanel";
import { buildMeasureRiskSummaries, type MeasureGeometry } from "./components/MarginRiskGutter";
import { NoteAnchorPopover, type PopoverAnchorRect } from "./components/NoteAnchorPopover";
import { ScoreRepairPanel } from "./components/ScoreRepairPanel";
import { UnifiedPiano88 } from "./components/UnifiedPiano88";
import { SimulatedMidiDebugBar } from "./components/SimulatedMidiDebugBar";
import { sortWarningsForNavigation } from "./components/warningUtils";
import {
  ScoreViewer,
  type AbPickStep,
  type AnchorMarkerInfo,
  type ScoreLayoutMode,
  type ScoreRendererFactory,
} from "./components/ScoreViewer";
import { TransportPracticeBar } from "./components/TransportPracticeBar";
import {
  PracticeSettingsModal,
  formatMidiStatusLabel,
  getMidiStatusBadgeClass,
} from "./components/PracticeSettingsModal";
import { createMidiSessionCapture } from "./midi/midiSessionCapture";
import { createSimulatedMidiHarness, type SimulatedMidiStep } from "./midi/simulatedMidiHarness";
import {
  createWebMidiController,
  getDefaultRequestMIDIAccess,
  QWERTY_TO_MIDI,
  createLocalMidiNoteEvent,
  type MIDIAccessLike,
  type MidiConnectionState,
  type MidiInputEvent,
  type WebMidiController,
} from "./midi/webMidi";
import {
  createPianoAudioEngine,
  DEFAULT_PIANO_TIMBRE,
  isValidPianoTimbreId,
  type AudioEngineStatus,
  type PianoAudioDeps,
  type PianoAudioEngine,
  type PianoTimbreId,
} from "./audio/pianoAudio";
import {
  buildMetronomeBeats,
  clampMetronomeVolume,
  type MetronomeBeatEvent,
} from "./audio/metronome";
import {
  clampSpeedMultiplier,
  createPlaybackEngine,
  type CursorSyncTarget,
  type PlaybackEngine,
  type PlaybackFrame,
  type PlaybackState,
  type SpeedMultiplier,
} from "./audio/playbackEngine";
import type { ChunkingClient } from "./workers/chunkingClient";
import { useChunkingAnalysis } from "./hooks/useChunkingAnalysis";

const PIANO_TIMBRE_STORAGE_KEY = "auto-fingering:piano-timbre";

function readStoredPianoTimbre(): PianoTimbreId {
  try {
    const raw = globalThis.localStorage?.getItem(PIANO_TIMBRE_STORAGE_KEY);
    if (isValidPianoTimbreId(raw)) return raw;
  } catch {
    // ignore storage access errors
  }
  return DEFAULT_PIANO_TIMBRE;
}

function writeStoredPianoTimbre(timbre: PianoTimbreId): void {
  try {
    globalThis.localStorage?.setItem(PIANO_TIMBRE_STORAGE_KEY, timbre);
  } catch {
    // ignore storage access errors
  }
}

export interface AppAudioDeps extends PianoAudioDeps {
  requestAnimationFrame?: (cb: FrameRequestCallback) => number;
  cancelAnimationFrame?: (id: number) => void;
}

export interface AppMidiDeps {
  requestMIDIAccess?: () => Promise<MIDIAccessLike>;
}

export interface AppClockDeps {
  nowMs?: () => number;
  getTimezoneOffsetMin?: () => number;
}

export interface AppProps {
  solverClientFactory?: () => SolverClient;
  chunkingClientFactory?: () => ChunkingClient;
  scoreRendererFactory?: ScoreRendererFactory;
  audioDeps?: AppAudioDeps;
  midiDeps?: AppMidiDeps;
  practiceStorage?: PracticeStoragePort | null;
  clockDeps?: AppClockDeps;
}

export default function App({
  solverClientFactory = createSolverClient,
  chunkingClientFactory,
  scoreRendererFactory,
  audioDeps,
  midiDeps,
  practiceStorage,
  clockDeps,
}: AppProps) {
  const nowMs = useCallback(() => clockDeps?.nowMs?.() ?? Date.now(), [clockDeps]);
  const solverClientRef = useRef<SolverClient | null>(null);
  const audioEngineRef = useRef<PianoAudioEngine | null>(null);
  const playbackEngineRef = useRef<PlaybackEngine | null>(null);
  const midiControllerRef = useRef<WebMidiController | null>(null);
  const midiCaptureRef = useRef<ReturnType<typeof createMidiSessionCapture> | null>(null);
  const midiCapture = (midiCaptureRef.current ??= createMidiSessionCapture());
  const simulatedMidiEnabled = new URLSearchParams(globalThis.location?.search).get("simMidi") === "1";
  const simulatedMidi = useMemo(
    () => simulatedMidiEnabled ? createSimulatedMidiHarness() : null,
    [simulatedMidiEnabled]
  );
  const resetMidiCapture = useCallback(() => {
    midiCapture.setTransport("stopped", false);
    simulatedMidi?.stop();
  }, [midiCapture, simulatedMidi]);
  const [isResolving, setIsResolving] = useState<boolean>(false);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("stopped");
  const updatePlaybackState = useCallback((state: PlaybackState) => {
    if (state === "stopped") resetMidiCapture();
    else midiCapture.setTransport(state, useStudioStore.getState().scoreDoc !== null);
    setPlaybackState(state);
  }, [midiCapture, resetMidiCapture]);
  const [playbackSpeed, setPlaybackSpeed] = useState<SpeedMultiplier>(1.0);
  const [metronomeEnabled, setMetronomeEnabled] = useState<boolean>(false);
  const [metronomeVolume, setMetronomeVolume] = useState<number>(0.7);
  const [countInEnabled, setCountInEnabled] = useState<boolean>(false);
  const [activeMetronomeBeat, setActiveMetronomeBeat] = useState<MetronomeBeatEvent | null>(null);
  const [practiceMode, setPracticeMode] = useState<PracticeMode>("both");
  const [waitingModeEnabled, setWaitingModeEnabled] = useState<boolean>(false);
  const setWaitingModeEnabledSync = (enabled: boolean) => {
    midiCapture.setMode(enabled ? "waiting" : "continuous");
    setWaitingModeEnabled(enabled);
  };
  useScreenWakeLock(playbackState === "playing" || waitingModeEnabled);
  const [skipGraceNotes, setSkipGraceNotes] = useState<boolean>(false);
  const [absoluteStrictnessEnabled, setAbsoluteStrictnessEnabled] = useState(false);
  const [strictHoldDurationEnabled, setStrictHoldDurationEnabled] = useState<boolean>(false);
  const [waitingState, setWaitingState] = useState<WaitingModeState>(() => createWaitingModeState(0));
  const waitingStateRef = useRef<WaitingModeState>(waitingState);
  const setWaitingStateSync = (next: WaitingModeState) => {
    waitingStateRef.current = next;
    setWaitingState(next);
  };
  const [flashedWrongMidis, setFlashedWrongMidis] = useState<Set<number>>(() => new Set());
  const wrongKeyFlashTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = wrongKeyFlashTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const [practiceAnalytics, setPracticeAnalytics] = useState<PracticeAnalyticsState>(() =>
    createPracticeAnalyticsState()
  );
  const [practiceReportOpen, setPracticeReportOpen] = useState<boolean>(false);
  const [handsRejoinSpeed, setHandsRejoinSpeed] = useState<{ from: number; to: number } | null>(null);
  const [abLoop, setAbLoop] = useState<AbLoopBounds>(() => createDefaultAbLoopBounds(0));
  const waitingLoopGapActiveRef = useRef<boolean>(false);
  const [audioStatus, setAudioStatus] = useState<AudioEngineStatus>("idle");
  const [pianoTimbre, setPianoTimbre] = useState<PianoTimbreId>(() =>
    audioDeps?.timbre && isValidPianoTimbreId(audioDeps.timbre)
      ? audioDeps.timbre
      : readStoredPianoTimbre()
  );
  const pianoTimbreRef = useRef<PianoTimbreId>(pianoTimbre);
  pianoTimbreRef.current = pianoTimbre;
  const [cursorTarget, setCursorTarget] = useState<CursorSyncTarget | null>(null);
  const [playbackFrame, setPlaybackFrame] = useState<PlaybackFrame | null>(null);
  const [layoutMode, setLayoutMode] = useState<ScoreLayoutMode>("page");
  const [measureGeometry, setMeasureGeometry] = useState<MeasureGeometry[]>([]);
  const [abPickStep, setAbPickStep] = useState<AbPickStep>("idle");
  const [abPickStartMeasure, setAbPickStartMeasure] = useState<number | null>(null);
  const [popoverOpen, setPopoverOpen] = useState<boolean>(false);
  const [popoverAnchorRect, setPopoverAnchorRect] = useState<PopoverAnchorRect | null>(null);
  const [diffDropdownOpen, setDiffDropdownOpen] = useState<boolean>(false);
  const [repairPanelOpen, setRepairPanelOpen] = useState<boolean>(false);
  const [isApplyingRepair, setIsApplyingRepair] = useState<boolean>(false);
  const [dismissedRepairIds, setDismissedRepairIds] = useState<Set<string>>(() => new Set());
  const [warningNavIndex, setWarningNavIndex] = useState<number>(-1);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [showStatusBar, setShowStatusBar] = useState<boolean>(true);
  const [showPianoOverhead, setShowPianoOverhead] = useState<boolean>(false);
  const [showFullPalm, setShowFullPalm] = useState<boolean>(true);
  const [priorLoading, setPriorLoading] = useState<boolean>(false);
  const [priorProgress, setPriorProgress] = useState<PriorLoadProgress | null>(null);
  const [priorFallbackReason, setPriorFallbackReason] = useState<string | null>(null);
  const [midiLocalSound, setMidiLocalSound] = useState<boolean>(false);
  const [midiState, setMidiState] = useState<MidiConnectionState>({
    status: "unsupported",
    devices: [],
    selectedDeviceId: null,
    errorMessage: null,
  });
  const [pressedMidis, setPressedMidis] = useState<Set<number>>(() => new Set());
  const [sustainPedalPressed, setSustainPedalPressed] = useState<boolean>(false);
  const midiLocalSoundRef = useRef<boolean>(midiLocalSound);
  midiLocalSoundRef.current = midiLocalSound;

  const fileName = useStudioStore((s) => s.fileName);
  const scoreTitle = useStudioStore((s) => s.scoreTitle);
  const rawXmlText = useStudioStore((s) => s.rawXmlText);
  const mxlContainer = useStudioStore((s) => s.mxlContainer);
  const exportFormat = useStudioStore((s) => s.exportFormat);
  const isSingleStaff = useStudioStore((s) => s.isSingleStaff);
  const singleStaffHand = useStudioStore((s) => s.singleStaffHand);
  const handSpanProfile = useStudioStore((s) => s.handSpanProfile);
  const ignoreExistingFingerings = useStudioStore((s) => s.ignoreExistingFingerings);
  const priorMode = useStudioStore((s) => s.priorMode);
  const priorLambda = useStudioStore((s) => s.priorLambda);
  const customModelBaseUrl = useStudioStore((s) => s.customModelBaseUrl);
  const scoreDoc = useStudioStore((s) => s.scoreDoc);
  const renderedXml = useStudioStore((s) => s.renderedXml);
  const solveResult = useStudioStore((s) => s.solveResult);
  const fingerByNoteUid = useStudioStore((s) => s.fingerByNoteUid);
  const anchors = useStudioStore((s) => s.anchors);
  const removedRawAnchorUids = useStudioStore((s) => s.removedRawAnchorUids);
  const lastDiff = useStudioStore((s) => s.lastDiff);
  const history = useStudioStore((s) => s.history);
  const selectedNoteUid = useStudioStore((s) => s.selectedNoteUid);
  const selectedSliceId = useStudioStore((s) => s.selectedSliceId);
  const selectedMeasureIndex = useStudioStore((s) => s.selectedMeasureIndex);
  const status = useStudioStore((s) => s.status);
  const errorMsg = useStudioStore((s) => s.errorMsg);

  const cc64CommandEnabled = useGuidedSessionStore((s) => s.cc64CommandEnabled);
  const durablePrefs = useMemo(() => ({
    handSpanProfile, speedMultiplier: playbackSpeed, abLoop, practiceMode, singleStaffHand, ignoreExistingFingerings,
    absoluteStrictnessEnabled, strictHoldDurationEnabled, cc64CommandEnabled,
  }), [handSpanProfile, playbackSpeed, abLoop, practiceMode, singleStaffHand, ignoreExistingFingerings,
    absoluteStrictnessEnabled, strictHoldDurationEnabled, cc64CommandEnabled]);
  const persistence = usePracticePersistence(practiceStorage, durablePrefs, playbackState === "playing");
  const effectivePracticeMode: PracticeMode = isSingleStaff
    ? singleStaffHand === "LH"
      ? "lh-only"
      : "rh-only"
    : practiceMode;
  const chunking = useChunkingAnalysis({
    chunkingClientFactory,
    scoreDoc,
    solveResult,
    practiceMode: effectivePracticeMode,
    updatePieceProfileOverrides: persistence.updatePieceProfileOverrides,
  });
  const [backupOpen, setBackupOpen] = useState(false);

  const [library, setLibrary] = useState<string[]>([]);
  const refreshLibrary = async () => {
    try {
      const res = await fetch("/api/scores");
      if (!res.ok) return;
      const items = (await res.json()) as { name: string }[];
      setLibrary(items.map((i) => i.name));
    } catch {
      /* library API unavailable (e.g. static hosting/tests) */
    }
  };
  useEffect(() => {
    void refreshLibrary();
  }, []);

  useEffect(() => {
    const client = solverClientFactory();
    solverClientRef.current = client;
    return () => {
      client.dispose();
      solverClientRef.current = null;
    };
  }, [solverClientFactory]);

  useEffect(() => {
    return () => {
      useStudioStore.getState().reset();
    };
  }, []);

  // Close the old capture synchronously on score replacement, before another MIDI packet can arrive.
  useEffect(() => {
    const unsubscribe = useStudioStore.subscribe((state, previous) => {
      if (state.scoreDoc !== previous.scoreDoc) resetMidiCapture();
    });
    return () => { unsubscribe(); resetMidiCapture(); };
  }, [resetMidiCapture]);

  useEffect(() => {
    const audioEngine = createPianoAudioEngine({
      timbre: audioDeps?.timbre ?? pianoTimbreRef.current,
      getAudioContext: audioDeps?.getAudioContext,
      loadSmplrPiano: audioDeps?.loadSmplrPiano,
      onStatusChange: (nextStatus) => {
        setAudioStatus(nextStatus);
        audioDeps?.onStatusChange?.(nextStatus);
      },
    });
    audioEngineRef.current = audioEngine;
    const engine = createPlaybackEngine({
      audioEngine,
      requestAnimationFrame: audioDeps?.requestAnimationFrame,
      cancelAnimationFrame: audioDeps?.cancelAnimationFrame,
      onStateChange: updatePlaybackState,
      onSliceChange: (slice) => {
        useStudioStore.getState().selectSlice(slice.sliceId);
      },
      onCursorSync: setCursorTarget,
      onFrame: setPlaybackFrame,
      onMetronomeBeat: setActiveMetronomeBeat,
    });
    playbackEngineRef.current = engine;
    return () => {
      engine.dispose();
      playbackEngineRef.current = null;
      audioEngineRef.current = null;
    };
  }, [audioDeps, updatePlaybackState]);

  const guidedControllerRef = useRef<{
    studioMode: "free" | "guided";
    sessionPhase: string;
    routeGuidedMidiEvent: (event: MidiInputEvent) => { intercepted: boolean };
    routeGuidedKeyboardEvent: (event: KeyboardEvent) => boolean;
    handleStage0WrongNote: (midi: number) => void;
    handleStage0StepCompleted: (stepIdx: number) => void;
    activeChunkSteps: PracticeStep[];
  } | null>(null);

  const handleMidiInputEvent = (event: MidiInputEvent) => {
    midiCapture.record(event);
    const guidedState = guidedControllerRef.current;
    const isGuidedStage0 =
      guidedState?.studioMode === "guided" && guidedState.sessionPhase === "stage0";
    const waitingActive = isGuidedStage0 || waitingModeEnabled;

    if (event.type === "noteon") {
      setPressedMidis((prev) => {
        if (prev.has(event.midi)) return prev;
        const next = new Set(prev);
        next.add(event.midi);
        return next;
      });
      if (guidedState?.studioMode === "guided") {
        const routed = guidedState.routeGuidedMidiEvent(event);
        if (routed.intercepted) {
          return;
        }
      }
      const shouldPlayLocalAudio = waitingActive
        ? midiLocalSoundRef.current
        : event.source !== "midi" || midiLocalSoundRef.current;
      if (shouldPlayLocalAudio) {
        const audio = audioEngineRef.current;
        if (audio) {
          void audio.prepare().then(() => {
            const ctx = audio.getAudioContext();
            audio.triggerNote({
              midi: event.midi,
              time: ctx.currentTime,
              duration: 0.35,
              velocity: event.velocity,
            });
          });
        }
      }
      if (waitingActive) {
        processWaitingNoteOn(event.midi);
      }
      return;
    }

    if (event.type === "noteoff") {
      setPressedMidis((prev) => {
        if (!prev.has(event.midi)) return prev;
        const next = new Set(prev);
        next.delete(event.midi);
        return next;
      });
      if (guidedState?.studioMode === "guided") {
        guidedState.routeGuidedMidiEvent(event);
      }
      if (waitingActive) {
        processWaitingNoteOff(event.midi);
      }
      return;
    }

    if (event.type === "sustain") {
      setSustainPedalPressed(event.pressed);
      if (guidedState?.studioMode === "guided") {
        guidedState.routeGuidedMidiEvent(event);
      }
    }
  };

  const handleMidiInputEventRef = useRef(handleMidiInputEvent);
  handleMidiInputEventRef.current = handleMidiInputEvent;

  useEffect(() => {
    const requestMIDIAccess = simulatedMidi?.requestMIDIAccess ?? (
      midiDeps ? midiDeps.requestMIDIAccess : getDefaultRequestMIDIAccess()
    );

    const controller = createWebMidiController({
      requestMIDIAccess,
      onStateChange: setMidiState,
      onMidiEvent: (event) => handleMidiInputEventRef.current(event),
    });
    midiControllerRef.current = controller;
    void controller.connect();

    return () => {
      controller.dispose();
      simulatedMidi?.stop();
      midiControllerRef.current = null;
    };
  }, [midiDeps, simulatedMidi]);

  const solveScore = async (
    score: ScoreDocument, profile: HandSpanProfile, ignoreAnchors: boolean, state: AnchorState,
  ) => {
    const client = solverClientRef.current;
    if (!client) throw new SolverCancelledError();
    const store = useStudioStore.getState();
    store.setStatus("正在计算指法...");
    const slicesToSolve = applyAnchorOverridesToSlices(score.onsetSlices, state.anchors, state.removedRawAnchorUids, ignoreAnchors);

    const isModelAssist = store.priorMode === "model-assist";
    if (isModelAssist) {
      setPriorLoading(true);
      setPriorFallbackReason(null);
    }

    let result;
    try {
      result = await client.solve(slicesToSolve, profile, {
        ignoreExistingFingerings: false,
        ...(isModelAssist
          ? {
              priorMode: store.priorMode,
              lambda: store.priorLambda,
              ...(store.customModelBaseUrl ? { customModelBaseUrl: store.customModelBaseUrl } : {}),
              onPriorProgress: (prog) => setPriorProgress(prog),
            }
          : {}),
      });
    } finally {
      if (isModelAssist) {
        setPriorLoading(false);
      }
    }

    if (result.priorFallbackReason) {
      setPriorFallbackReason(result.priorFallbackReason);
    } else if (isModelAssist && result.priorUsed) {
      setPriorFallbackReason(null);
    }

    return result;
  };

  const solveAndRender = async (
    nextDoc: ScoreDocument,
    nextRawXml: string,
    nextFileName: string,
    nextFormat: ExportFormat,
    nextMxl: MxlContainer | undefined,
    profile: HandSpanProfile,
    ignoreAnchors: boolean,
  ) => {
    playbackEngineRef.current?.stop();
    const store = useStudioStore.getState();
    const result = await solveScore(nextDoc, profile, ignoreAnchors, store);
    store.setSolvedScore({
      scoreDoc: nextDoc,
      rawXmlText: nextRawXml,
      mxlContainer: nextMxl,
      fileName: nextFileName,
      exportFormat: nextFormat,
      solveResult: result,
    });
  };

  const resetPracticeProgress = () => {
    setPracticeAnalytics(createPracticeAnalyticsState());
    setHandsRejoinSpeed(null);
    setPracticeReportOpen(false);
    chunking.resetAllOverrides();
  };
  const workspaceScores = useWorkspaceScoreLifecycle({
    persistence, durablePrefs, solveScore, resetPracticeProgress,
    restorePreferences(score, saved, profile) {
      const loop = saved?.abLoop ? normalizeAbLoopBounds(saved.abLoop, score.measureCount)
        : createDefaultAbLoopBounds(score.measureCount);
      if (saved?.speedMultiplier !== undefined) {
        const speed = clampSpeedMultiplier(saved.speedMultiplier);
        setPlaybackSpeed(speed);
        playbackEngineRef.current?.setSpeed(speed);
      }
      if (saved?.practiceMode) setPracticeMode(saved.practiceMode);
      if (saved?.absoluteStrictnessEnabled !== undefined) setAbsoluteStrictnessEnabled(saved.absoluteStrictnessEnabled);
      if (saved?.strictHoldDurationEnabled !== undefined) setStrictHoldDurationEnabled(saved.strictHoldDurationEnabled);
      if (saved?.cc64CommandEnabled !== undefined) {
        useGuidedSessionStore.getState().setCc64CommandEnabled(saved.cc64CommandEnabled);
      }
      setAbLoop(loop);
      setAbPickStep("idle");
      setAbPickStartMeasure(null);
      resetPracticeProgress();
      chunking.restoreProfileOverrides(profile);
      playbackEngineRef.current?.setAbLoop(loop);
    },
    stopPlayback() {
      playbackEngineRef.current?.stop();
    },
  });

  const reSolveScore = async (
    xmlText: string,
    singleStaff: boolean,
    handOverride: Hand,
    profile: HandSpanProfile,
    ignoreAnchors: boolean
  ) => {
    const store = useStudioStore.getState();
    store.setErrorMsg(null);
    try {
      const nextDoc = parseMusicXml(
        xmlText,
        singleStaff ? { singleStaffHandOverride: handOverride } : undefined
      );
      await solveAndRender(
        nextDoc,
        xmlText,
        store.fileName,
        store.exportFormat,
        store.mxlContainer,
        profile,
        ignoreAnchors,
      );
    } catch (err) {
      if (err instanceof SolverCancelledError) {
        return;
      }
      store.setErrorMsg(err instanceof Error ? err.message : String(err));
      store.setStatus("错误");
    }
  };

  const handleLibrarySelect = async (name: string) => {
    if (!name) return;
    try {
      const res = await fetch(`/api/scores/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const file = new File([await res.arrayBuffer()], name);
      await loadFile(file, false);
    } catch (err) {
      useStudioStore.getState().clearScoreErrorState(err instanceof Error ? err.message : String(err));
    }
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await loadFile(file, true);
  };

  const loadFile = async (file: File, saveToLibrary: boolean) => {
    if (!solverClientRef.current) return;
    const generation = workspaceScores.beginScoreOpen();
    if (saveToLibrary) {
      void fetch(`/api/scores/${encodeURIComponent(file.name)}`, { method: "PUT", body: file })
        .then(() => refreshLibrary())
        .catch(() => undefined);
    }

    playbackEngineRef.current?.stop();
    useGuidedSessionStore.getState().endSession();
    const store = useStudioStore.getState();
    store.setErrorMsg(null);
    store.setStatus("正在解析 MusicXML...");

    try {
      const isMxl = file.name.toLowerCase().endsWith(".mxl");
      const session = isMxl
        ? await loadScoreInput({ fileName: file.name, bytes: await file.arrayBuffer() })
        : await loadScoreInput({ fileName: file.name, text: await file.text() });

      await workspaceScores.openScoreSession(session, file.name, generation);
    } catch (err) {
      if (err instanceof SolverCancelledError || !workspaceScores.isCurrent(generation)) {
        return;
      }
      store.clearScoreErrorState(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSingleStaffHandToggle = async (nextHand: Hand) => {
    if (!rawXmlText || !isSingleStaff || nextHand === singleStaffHand) return;
    useStudioStore.getState().setSingleStaffHand(nextHand);
    await reSolveScore(
      rawXmlText,
      isSingleStaff,
      nextHand,
      handSpanProfile,
      ignoreExistingFingerings
    );
  };

  const handleProfileChange = (nextProfile: HandSpanProfile) => {
    useStudioStore.getState().setHandSpanProfile(nextProfile);
    if (rawXmlText) {
      void reSolveScore(
        rawXmlText,
        isSingleStaff,
        singleStaffHand,
        nextProfile,
        ignoreExistingFingerings
      );
    }
  };

  const handleIgnoreExistingToggle = (nextIgnore: boolean) => {
    useStudioStore.getState().setIgnoreExistingFingerings(nextIgnore);
    if (rawXmlText) {
      void reSolveScore(
        rawXmlText,
        isSingleStaff,
        singleStaffHand,
        handSpanProfile,
        nextIgnore
      );
    }
  };

  const handlePriorModeChange = (nextMode: PriorMode) => {
    useStudioStore.getState().setPriorMode(nextMode);
    setPriorFallbackReason(null);
    if (nextMode === "model-assist" && !rawXmlText && solverClientRef.current?.preloadPrior) {
      setPriorLoading(true);
      void solverClientRef.current
        .preloadPrior({
          customModelBaseUrl: useStudioStore.getState().customModelBaseUrl || undefined,
          onProgress: (prog) => setPriorProgress(prog),
        })
        .catch((err) => {
          setPriorFallbackReason(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          setPriorLoading(false);
        });
      return;
    }
    if (rawXmlText) {
      void reSolveScore(
        rawXmlText,
        isSingleStaff,
        singleStaffHand,
        handSpanProfile,
        ignoreExistingFingerings
      );
    }
  };

  const handlePriorLambdaChange = (nextLambda: number) => {
    useStudioStore.getState().setPriorLambda(nextLambda);
    if (rawXmlText && useStudioStore.getState().priorMode === "model-assist") {
      void reSolveScore(
        rawXmlText,
        isSingleStaff,
        singleStaffHand,
        handSpanProfile,
        ignoreExistingFingerings
      );
    }
  };

  const handleCustomModelBaseUrlChange = (nextUrl: string) => {
    useStudioStore.getState().setCustomModelBaseUrl(nextUrl);
    if (rawXmlText && useStudioStore.getState().priorMode === "model-assist") {
      void reSolveScore(
        rawXmlText,
        isSingleStaff,
        singleStaffHand,
        handSpanProfile,
        ignoreExistingFingerings
      );
    }
  };

  const runLocalAnchorUpdate = async (
    noteUid: string,
    override: AnchorOverride | null
  ) => {
    const store = useStudioStore.getState();
    if (!store.scoreDoc || !solverClientRef.current) return;
    const targetNote = store.scoreDoc.noteEvents.find((n) => n.noteUid === noteUid);
    if (!targetNote || targetNote.isTieStop) return;

    const { anchors: nextAnchors, removedRawAnchorUids: nextRemoved } = computeNextAnchorState(
      store.anchors,
      store.removedRawAnchorUids,
      targetNote,
      override
    );

    setIsResolving(true);
    try {
      const isModelAssist = store.priorMode === "model-assist";
      const input = {
        onsetSlices: store.scoreDoc.onsetSlices,
        profile: store.handSpanProfile,
        priorFingerByNoteUid: store.fingerByNoteUid,
        targetNoteUid: noteUid,
        override,
        anchors: nextAnchors,
        removedRawAnchorUids: nextRemoved,
        ignoreExistingFingerings: store.ignoreExistingFingerings,
        ...(isModelAssist
          ? {
              priorMode: store.priorMode,
              lambda: store.priorLambda,
              ...(store.customModelBaseUrl
                ? { customModelBaseUrl: store.customModelBaseUrl }
                : {}),
            }
          : {}),
      };
      const result = solverClientRef.current.resolveLocal
        ? await solverClientRef.current.resolveLocal(input)
        : localResolveFingering(input);

      useStudioStore.getState().commitAnchorResolution({
        targetNoteUid: noteUid,
        override,
        result,
      });
    } catch (err) {
      if (!(err instanceof SolverCancelledError)) {
        useStudioStore.getState().setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setIsResolving(false);
    }
  };

  const handleSetAnchor = (noteUid: string, finger: Finger, mode: AnchorOverrideMode) => {
    void runLocalAnchorUpdate(noteUid, { finger, mode });
  };

  const handleRemoveAnchor = (noteUid: string) => {
    void runLocalAnchorUpdate(noteUid, null);
  };

  const handleDownload = async () => {
    if (!renderedXml) return;
    const baseName = fileName.replace(/\.(musicxml|xml|mxl)$/i, "") || "score";
    const output = await exportScoreOutput(renderedXml, exportFormat, mxlContainer);
    const blobPart: BlobPart = output.bytes
      ? new Uint8Array(output.bytes)
      : output.text ?? renderedXml;
    const blob = new Blob([blobPart], { type: output.mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${baseName}-fingered.${output.extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const onsetSlices = scoreDoc?.onsetSlices ?? [];
  const noteEvents = scoreDoc?.noteEvents ?? [];
  const measureCount = scoreDoc?.measureCount ?? 0;

  const measureRisks = useMemo(
    () => buildMeasureRiskSummaries(measureCount, onsetSlices, solveResult?.warnings ?? []),
    [measureCount, onsetSlices, solveResult]
  );

  const anchoredNotes = useMemo<AnchorMarkerInfo[]>(() => {
    const repairedSet = new Set(solveResult?.repairedAnchorUids ?? []);
    const removedSet = new Set(removedRawAnchorUids);
    const markers: AnchorMarkerInfo[] = [];
    for (const ev of noteEvents) {
      if (ev.isTieStop) continue;
      const userAnc = anchors[ev.noteUid];
      if (userAnc) {
        markers.push({
          noteUid: ev.noteUid,
          measureIndex: ev.measureIndex,
          midi: ev.midi,
          staff: ev.staff,
          onsetTick: ev.onsetTick,
          hand: ev.hand,
          finger: userAnc.finger,
          isConflict: repairedSet.has(ev.noteUid),
        });
        continue;
      }
      if (ev.anchorFinger === undefined) continue;
      if (removedSet.has(ev.noteUid)) continue;
      if (ignoreExistingFingerings && ev.anchorRawPreserved) continue;
      markers.push({
        noteUid: ev.noteUid,
        measureIndex: ev.measureIndex,
        midi: ev.midi,
        staff: ev.staff,
        onsetTick: ev.onsetTick,
        hand: ev.hand,
        finger: ev.anchorFinger,
        isConflict: repairedSet.has(ev.noteUid),
      });
    }
    return markers;
  }, [noteEvents, solveResult, anchors, removedRawAnchorUids, ignoreExistingFingerings]);

  const sortedWarnings = useMemo(
    () => sortWarningsForNavigation(solveResult?.warnings ?? [], onsetSlices),
    [solveResult?.warnings, onsetSlices]
  );
  const dangerCount = useMemo(
    () => sortedWarnings.filter((w) => w.severity === "danger").length,
    [sortedWarnings]
  );
  const warnCount = sortedWarnings.length - dangerCount;

  const selectedNote = useMemo(() => {
    if (!selectedNoteUid) return null;
    return noteEvents.find((n) => n.noteUid === selectedNoteUid) ?? null;
  }, [selectedNoteUid, noteEvents]);

  const practiceSteps = useMemo(
    () =>
      scoreDoc
        ? buildPracticeSteps(scoreDoc, effectivePracticeMode, { skipGraceNotes })
        : [],
    [scoreDoc, effectivePracticeMode, skipGraceNotes]
  );

  const measureErrorsByIndex = useMemo(
    () => buildMeasureErrorSummaries(practiceAnalytics, effectivePracticeMode),
    [practiceAnalytics, effectivePracticeMode]
  );

  const repeatRecommendations = useMemo(
    () =>
      buildPracticeRepeatRecommendations(practiceAnalytics, {
        measureCount,
        currentSpeed: playbackSpeed,
        currentPracticeMode: effectivePracticeMode,
        isSingleStaff,
        warnings: solveResult?.warnings ?? [],
      }),
    [
      practiceAnalytics,
      measureCount,
      playbackSpeed,
      effectivePracticeMode,
      isSingleStaff,
      solveResult?.warnings,
    ]
  );

  const totalPracticeFaults = useMemo(() => {
    let total = 0;
    for (const s of measureErrorsByIndex.values()) {
      total += s.totalErrors;
    }
    return total;
  }, [measureErrorsByIndex]);

  const practiceAccuracyPercent = useMemo(() => {
    if (practiceAnalytics.totalStepsCompleted === 0) return 100;
    return Math.round(
      (practiceAnalytics.firstTryCleanSteps / practiceAnalytics.totalStepsCompleted) * 100
    );
  }, [practiceAnalytics.totalStepsCompleted, practiceAnalytics.firstTryCleanSteps]);

  const practiceProgression = useMemo(
    () =>
      evaluatePracticeProgression(practiceAnalytics, {
        measureCount,
        abLoop,
        activeMeasureIndex: cursorTarget?.measureIndex ?? selectedMeasureIndex,
        currentSpeed: playbackSpeed,
        targetSpeed: 1.0,
        currentPracticeMode: effectivePracticeMode,
        isSingleStaff,
      }),
    [
      practiceAnalytics,
      measureCount,
      abLoop,
      cursorTarget?.measureIndex,
      selectedMeasureIndex,
      playbackSpeed,
      effectivePracticeMode,
      isSingleStaff,
    ]
  );

  const handleAdvanceProgressionMeasures = (
    startMeasureIndex: number,
    endMeasureIndex: number
  ) => {
    if (!scoreDoc) return;
    const nextLoop = normalizeAbLoopBounds(
      {
        startMeasureIndex,
        endMeasureIndex,
        enabled: true,
        loopGap: abLoop.loopGap,
      },
      measureCount
    );
    setAbLoop(nextLoop);
    setAbPickStep("idle");
    setAbPickStartMeasure(null);
    playbackEngineRef.current?.setAbLoop(nextLoop);

    const nextSteps = buildPracticeSteps(scoreDoc, effectivePracticeMode, { skipGraceNotes });
    const range = findAbLoopStepRange(nextSteps, nextLoop);
    const startIdx = range ? range.startStepIndex : 0;

    if (!waitingModeEnabled) {
      setWaitingModeEnabledSync(true);
      setMidiLocalSound(false);
    }
    cancelWaitingLoopGapIfActive(false);
    setWaitingStateSync(createWaitingModeState(startIdx));
    updatePlaybackState("playing");
    playbackEngineRef.current?.setMetronomePaused(true);
    syncToPracticeStep(nextSteps[startIdx] ?? null, "playing");
    setPracticeReportOpen(false);
  };

  const changePracticeMode = (mode: PracticeMode) => {
    if (isSingleStaff || mode === effectivePracticeMode) return;
    if (mode === "both") {
      const compensatedSpeed = clampSpeedMultiplier(playbackSpeed * 0.88);
      setPlaybackSpeed(compensatedSpeed);
      playbackEngineRef.current?.setSpeed(compensatedSpeed);
      setHandsRejoinSpeed({ from: playbackSpeed, to: compensatedSpeed });
    } else {
      setHandsRejoinSpeed(null);
    }
    setPracticeMode(mode);
    setPracticeAnalytics(resetCurrentPracticePass);
  };

  const handlePracticeModeChange = (mode: PracticeMode) => {
    if (mode === effectivePracticeMode || isSingleStaff) return;
    changePracticeMode(mode);
    if (!scoreDoc || !waitingModeEnabled) return;
    const nextSteps = buildPracticeSteps(scoreDoc, mode, { skipGraceNotes });
    const range = findAbLoopStepRange(nextSteps, abLoop);
    const measure = cursorTarget?.measureIndex ?? selectedMeasureIndex ?? 0;
    const nextIndex = range?.startStepIndex ?? Math.max(0, nextSteps.findIndex((step) => step.measureIndex >= measure));
    cancelWaitingLoopGapIfActive(playbackState === "playing");
    setWaitingStateSync(createWaitingModeState(nextIndex));
    if (playbackState !== "stopped") {
      syncToPracticeStep(nextSteps[nextIndex] ?? null, playbackState);
    }
  };

  const handleStepUpProgressionHand = () => {
    if (!scoreDoc) return;
    changePracticeMode("both");
    const nextSteps = buildPracticeSteps(scoreDoc, "both", { skipGraceNotes });
    const range = abLoop.enabled ? findAbLoopStepRange(nextSteps, abLoop) : null;
    const startIdx = range
      ? range.startStepIndex
      : Math.max(
          0,
          nextSteps.findIndex((s) => s.measureIndex >= practiceProgression.startMeasureIndex)
        );
    cancelWaitingLoopGapIfActive(false);
    setWaitingStateSync(createWaitingModeState(startIdx));
    updatePlaybackState("playing");
    playbackEngineRef.current?.setMetronomePaused(true);
    syncToPracticeStep(nextSteps[startIdx] ?? null, "playing");
    setPracticeReportOpen(false);
  };

  const handleStepUpProgressionSpeed = () => {
    if (!scoreDoc) return;
    const targetSpd = practiceProgression.recommendedNextSpeedMultiplier ?? 1.0;
    setPlaybackSpeed(targetSpd);
    playbackEngineRef.current?.setSpeed(targetSpd);
    setPracticeAnalytics(resetCurrentPracticePass);
    const range = abLoop.enabled ? findAbLoopStepRange(practiceSteps, abLoop) : null;
    const startIdx = range
      ? range.startStepIndex
      : Math.max(
          0,
          practiceSteps.findIndex((s) => s.measureIndex >= practiceProgression.startMeasureIndex)
        );
    cancelWaitingLoopGapIfActive(false);
    setWaitingStateSync(createWaitingModeState(startIdx));
    updatePlaybackState("playing");
    playbackEngineRef.current?.setMetronomePaused(true);
    syncToPracticeStep(practiceSteps[startIdx] ?? null, "playing");
    setPracticeReportOpen(false);
  };

  const handleApplyRepeatRecommendation = (
    rec: PracticeRepeatRecommendation,
    options: { applySpeedAndMode?: boolean } = {}
  ) => {
    if (!scoreDoc) return;
    const nextMode =
      options.applySpeedAndMode && rec.recommendedPracticeMode
        ? rec.recommendedPracticeMode
        : effectivePracticeMode;

    if (options.applySpeedAndMode && rec.recommendedPracticeMode && !isSingleStaff) {
      changePracticeMode(rec.recommendedPracticeMode);
    }
    if (options.applySpeedAndMode && rec.recommendedSpeedMultiplier !== null) {
      setPlaybackSpeed(rec.recommendedSpeedMultiplier);
      playbackEngineRef.current?.setSpeed(rec.recommendedSpeedMultiplier);
    }
    if (options.applySpeedAndMode && rec.recommendMetronome && !metronomeEnabled) {
      setMetronomeEnabled(true);
      playbackEngineRef.current?.setMetronomeEnabled(true);
    }

    const nextLoop = normalizeAbLoopBounds(
      {
        startMeasureIndex: rec.startMeasureIndex,
        endMeasureIndex: rec.endMeasureIndex,
        enabled: true,
        loopGap: abLoop.loopGap,
      },
      measureCount
    );
    setAbLoop(nextLoop);
    setAbPickStep("idle");
    setAbPickStartMeasure(null);
    playbackEngineRef.current?.setAbLoop(nextLoop);

    const nextSteps = buildPracticeSteps(scoreDoc, nextMode, { skipGraceNotes });
    const range = findAbLoopStepRange(nextSteps, nextLoop);
    const startIdx = range ? range.startStepIndex : 0;

    if (!waitingModeEnabled) {
      setWaitingModeEnabledSync(true);
      setMidiLocalSound(false);
    }
    cancelWaitingLoopGapIfActive(false);
    setWaitingStateSync(createWaitingModeState(startIdx));
    updatePlaybackState("playing");
    playbackEngineRef.current?.setMetronomePaused(true);
    syncToPracticeStep(nextSteps[startIdx] ?? null, "playing");
    setPracticeReportOpen(false);
  };

  const handleResetPracticeAnalytics = () => {
    setPracticeAnalytics(createPracticeAnalyticsState());
    setHandsRejoinSpeed(null);
    setPracticeReportOpen(false);
  };

  const scoreMetronomeBeats = useMemo(
    () => (scoreDoc ? buildMetronomeBeats(scoreDoc) : []),
    [scoreDoc]
  );

  const totalScoreDurationSec = useMemo(() => {
    if (!scoreDoc) return 0;
    let maxEnd = 0;
    for (const ev of scoreDoc.noteEvents) {
      maxEnd = Math.max(maxEnd, ev.onsetSec + ev.durationSec);
    }
    return maxEnd;
  }, [scoreDoc]);

  const syncToPracticeStep = (step: PracticeStep | null, frameState: PlaybackState) => {
    if (!step) {
      setCursorTarget(null);
      setPlaybackFrame(null);
      return;
    }
    if (step.primarySliceId) {
      useStudioStore.getState().selectSlice(step.primarySliceId);
    }
    setCursorTarget({
      sliceId: step.primarySliceId ?? `step-${step.stepIndex}`,
      measureIndex: step.measureIndex,
      onsetTick: step.onsetTick,
      isGrace: step.isGrace,
      midis: step.expectedMidis,
    });
    setPlaybackFrame({
      scoreSec: step.onsetSec,
      totalDurationSec: totalScoreDurationSec,
      state: frameState,
    });
  };

  const guided = useGuidedSessionController({
    scoreDoc,
    practiceSteps,
    motorChunks: chunking.motorChunks,
    macroSections: chunking.macroSections,
    effectivePracticeMode,
    playbackSpeed,
    playbackEngineRef,
    countInEnabled,
    setMidiCaptureMode: (mode) => midiCapture.setMode(mode),
    resetMidiCapture,
    syncWaitingToStep: syncToPracticeStep,
    resetWaitingCursor: (stepIndex = 0) => setWaitingStateSync(createWaitingModeState(stepIndex)),
    nowMs,
  });
  guidedControllerRef.current = guided;

  const playAccompanimentNotes = (step: PracticeStep) => {
    if (effectivePracticeMode === "both" || step.accompanimentNotes.length === 0) return;
    const audio = audioEngineRef.current;
    if (!audio) return;
    void audio.prepare().then(() => {
      const ctx = audio.getAudioContext();
      const now = ctx.currentTime;
      for (const note of step.accompanimentNotes) {
        audio.triggerNote({
          midi: note.midi,
          time: now,
          duration: Math.max(0.08, note.durationSec / playbackSpeed),
        });
      }
    });
  };

  const triggerStepAdvanceMetronome = (step: PracticeStep) => {
    if (!metronomeEnabled || !playbackEngineRef.current) return;
    const beat =
      scoreMetronomeBeats.find(
        (b) => b.measureIndex === step.measureIndex && Math.abs(b.tick - step.onsetTick) < 1e-4
      ) ?? {
        measureIndex: step.measureIndex,
        beatIndex: 0,
        beatNumber: 1,
        totalBeats: scoreDoc?.measureTimelines[step.measureIndex]?.timeBeats ?? 4,
        isAccent: false,
        isCountIn: false,
      };
    playbackEngineRef.current.setMetronomePaused(false);
    playbackEngineRef.current.triggerMetronomeBeat({
      measureIndex: beat.measureIndex,
      beatIndex: beat.beatIndex,
      beatNumber: beat.beatNumber,
      totalBeats: beat.totalBeats,
      isAccent: beat.isAccent,
      isCountIn: false,
    });
    // Re-pause metronome immediately while waiting on the next step
    playbackEngineRef.current.setMetronomePaused(true);
  };

  useEffect(() => {
    setWarningNavIndex(-1);
  }, [solveResult]);

  useEffect(() => {
    setDismissedRepairIds(new Set());
  }, [rawXmlText]);

  useEffect(() => {
    if (lastDiff.length === 0) {
      setDiffDropdownOpen(false);
    }
  }, [lastDiff]);

  const visibleRepairSuggestions = useMemo(
    () =>
      (solveResult?.repairSuggestions ?? []).filter(
        (s) => !dismissedRepairIds.has(s.repairId)
      ),
    [solveResult?.repairSuggestions, dismissedRepairIds]
  );

  const hasHighRiskRepair = useMemo(
    () =>
      visibleRepairSuggestions.some(
        (s) => s.issueKind === "chord-over-octave" || s.issueKind === "held-over-octave"
      ),
    [visibleRepairSuggestions]
  );

  useEffect(() => {
    if (visibleRepairSuggestions.length === 0) {
      setRepairPanelOpen(false);
    }
  }, [visibleRepairSuggestions.length]);

  const handleLocateRepairSuggestion = (suggestion: ScoreRepairSuggestion) => {
    useStudioStore.getState().selectSlice(suggestion.sliceId);
    setPopoverOpen(false);
  };

  const handleDismissRepair = (repairId: string) => {
    setDismissedRepairIds((prev) => {
      const next = new Set(prev);
      next.add(repairId);
      return next;
    });
  };

  const commitRepairedScore = async (
    nextRawXml: string,
    nextDoc: ScoreDocument,
    repairSummary: string
  ) => {
    const store = useStudioStore.getState();
    if (!solverClientRef.current || !store.scoreDoc) return;

    const remapped = remapAnchorState(store.scoreDoc, nextDoc, store);
    const nextResult = await solveScore(nextDoc, store.handSpanProfile, store.ignoreExistingFingerings, remapped);
    store.applyScoreRepair({
      rawXmlText: nextRawXml,
      scoreDoc: nextDoc,
      solveResult: nextResult,
      ...remapped,
      repairSummary,
    });
  };

  const handleApplyRepairOption = async (
    suggestion: ScoreRepairSuggestion,
    option: ScoreRepairOption
  ) => {
    const store = useStudioStore.getState();
    if (!store.rawXmlText || !store.scoreDoc || !solverClientRef.current) return;

    playbackEngineRef.current?.stop();
    setIsApplyingRepair(true);
    try {
      const nextRawXml = applyScoreRepairToXml(store.rawXmlText, store.scoreDoc, option);
      const nextDoc = parseMusicXml(
        nextRawXml,
        store.isSingleStaff ? { singleStaffHandOverride: store.singleStaffHand } : undefined
      );
      await commitRepairedScore(nextRawXml, nextDoc, suggestion.summary);
    } catch (err) {
      if (!(err instanceof SolverCancelledError)) {
        store.setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setIsApplyingRepair(false);
    }
  };

  const handleApplyAllRepairs = async (items: BatchScoreRepairSelection[]) => {
    const store = useStudioStore.getState();
    if (!store.rawXmlText || !store.scoreDoc || !solverClientRef.current || items.length === 0) {
      return;
    }

    playbackEngineRef.current?.stop();
    setIsApplyingRepair(true);
    try {
      const { rawXmlText: nextRawXml, scoreDoc: nextDoc, appliedCount } =
        applyAllScoreRepairsToXml(
          store.rawXmlText,
          store.scoreDoc,
          items,
          store.handSpanProfile,
          dismissedRepairIds,
          store.solveResult?.repairSuggestions
        );
      if (appliedCount > 0) {
        await commitRepairedScore(nextRawXml, nextDoc, `一键修复 ${appliedCount} 处`);
      }
    } catch (err) {
      if (!(err instanceof SolverCancelledError)) {
        store.setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setIsApplyingRepair(false);
    }
  };

  const handleSelectWarning = (cue: TransitionCue) => {
    useStudioStore.getState().selectWarning(cue);
    setPopoverOpen(false);
  };

  const handleStepWarning = (delta: -1 | 1) => {
    if (sortedWarnings.length === 0) return;
    const base = warningNavIndex >= 0 ? warningNavIndex : delta > 0 ? -1 : 0;
    const nextIdx = (base + delta + sortedWarnings.length) % sortedWarnings.length;
    setWarningNavIndex(nextIdx);
    handleSelectWarning(sortedWarnings[nextIdx]);
  };

  const cancelWaitingLoopGapIfActive = (preservePlayingState: boolean) => {
    if (!waitingLoopGapActiveRef.current) return;
    waitingLoopGapActiveRef.current = false;
    playbackEngineRef.current?.stop();
    if (preservePlayingState) {
      updatePlaybackState("playing");
      playbackEngineRef.current?.setMetronomePaused(true);
    }
  };

  const handleSelectMeasure = (measureIndex: number) => {
    const summary = measureRisks.find((m) => m.measureIndex === measureIndex);
    useStudioStore
      .getState()
      .selectMeasure(measureIndex, summary?.firstWarningSliceId ?? summary?.firstSliceId ?? null);
    setPopoverOpen(false);
    const currentPlaybackState = waitingModeEnabled
      ? playbackState
      : (playbackEngineRef.current?.getState() ?? playbackState);
    if (waitingModeEnabled && practiceSteps.length > 0) {
      cancelWaitingLoopGapIfActive(currentPlaybackState === "playing");
      const stepIdx = practiceSteps.findIndex((s) => s.measureIndex >= measureIndex);
      const targetIdx = stepIdx >= 0 ? stepIdx : 0;
      setWaitingStateSync(createWaitingModeState(targetIdx));
      if (currentPlaybackState !== "stopped") {
        syncToPracticeStep(practiceSteps[targetIdx] ?? null, currentPlaybackState);
      }
      return;
    }
    if (currentPlaybackState === "playing" && scoreDoc && playbackEngineRef.current) {
      const tl = scoreDoc.measureTimelines[measureIndex];
      if (tl) {
        void playbackEngineRef.current.play(scoreDoc, { fromScoreSec: tl.startSec });
      } else if (summary?.firstSliceId) {
        void playbackEngineRef.current.play(scoreDoc, { fromSliceId: summary.firstSliceId });
      }
    } else if (currentPlaybackState === "paused") {
      playbackEngineRef.current?.stop();
    }
  };

  const handleJumpToStart = () => {
    if (!scoreDoc) return;
    resetMidiCapture();
    setPopoverOpen(false);
    const firstSliceId = onsetSlices[0]?.sliceId ?? null;
    useStudioStore.getState().selectMeasure(0, firstSliceId);
    const currentPlaybackState = waitingModeEnabled
      ? playbackState
      : (playbackEngineRef.current?.getState() ?? playbackState);
    if (currentPlaybackState === "playing" || (waitingModeEnabled && currentPlaybackState === "paused")) {
      midiCapture.setTransport(currentPlaybackState, true);
    }
    if (waitingModeEnabled) {
      cancelWaitingLoopGapIfActive(currentPlaybackState === "playing");
      setWaitingStateSync(createWaitingModeState(0));
      if (currentPlaybackState !== "stopped") {
        syncToPracticeStep(practiceSteps[0] ?? null, currentPlaybackState);
      }
      return;
    }
    if (currentPlaybackState === "playing" && playbackEngineRef.current) {
      void playbackEngineRef.current.play(scoreDoc, { restart: true });
    } else if (currentPlaybackState === "paused") {
      playbackEngineRef.current?.stop();
    }
  };

  const handleSelectSlice = (sliceId: string) => {
    useStudioStore.getState().selectSlice(sliceId);
  };

  const handleSelectNote = (noteUid: string, anchorRect?: PopoverAnchorRect) => {
    const currentPlaybackState = waitingModeEnabled
      ? playbackState
      : (playbackEngineRef.current?.getState() ?? playbackState);
    if (currentPlaybackState !== "stopped" || waitingModeEnabled) {
      setPopoverOpen(false);
      const clickedNote = noteEvents.find((n) => n.noteUid === noteUid);
      const targetSlice =
        onsetSlices.find((s) => s.notes.some((n) => n.noteUid === noteUid)) ??
        (clickedNote
          ? onsetSlices.find(
              (s) =>
                s.measureIndex === clickedNote.measureIndex &&
                s.onsetTick === clickedNote.onsetTick
            )
          : undefined);
      if (targetSlice) {
        useStudioStore.getState().selectSlice(targetSlice.sliceId);
        if (waitingModeEnabled && practiceSteps.length > 0) {
          cancelWaitingLoopGapIfActive(currentPlaybackState === "playing");
          const stepIdx = practiceSteps.findIndex(
            (s) =>
              s.primarySliceId === targetSlice.sliceId ||
              (s.measureIndex === targetSlice.measureIndex && s.onsetTick >= targetSlice.onsetTick)
          );
          const targetIdx = stepIdx >= 0 ? stepIdx : 0;
          setWaitingStateSync(createWaitingModeState(targetIdx));
          if (currentPlaybackState !== "stopped") {
            syncToPracticeStep(practiceSteps[targetIdx] ?? null, currentPlaybackState);
          }
          return;
        }
        if (currentPlaybackState === "playing" && scoreDoc && playbackEngineRef.current) {
          void playbackEngineRef.current.play(scoreDoc, { fromSliceId: targetSlice.sliceId });
        }
      }
      return;
    }
    useStudioStore.getState().selectNote(noteUid);
    setPopoverAnchorRect(anchorRect ?? null);
    setPopoverOpen(true);
  };

  const getWaitingClockSec = (): number => {
    const audio = audioEngineRef.current;
    if (audio) {
      try {
        return audio.getAudioContext().currentTime;
      } catch {
        // fallback below
      }
    }
    return (globalThis.performance?.now?.() ?? Date.now()) / 1000;
  };

  const applyWaitingAdvanceSideEffects = (result: WaitingStepAdvanceResult) => {
    if (!result.completedStep) return;

    const passCompleted = result.completedScore || result.loopWrapped;
    const nowSec = getWaitingClockSec();
    setPracticeAnalytics((prev) =>
      recordPracticeStepCompleted(prev, {
        completedStep: result.completedStep,
        passCompleted,
        nowSec,
        speedMultiplier: playbackSpeed,
        practiceMode: effectivePracticeMode,
      })
    );

    playAccompanimentNotes(result.completedStep);
    if (result.loopWrapped && result.advancedToStep) {
      if (abLoop.loopGap && scoreDoc && playbackEngineRef.current) {
        waitingLoopGapActiveRef.current = true;
        const norm = normalizeAbLoopBounds(abLoop, scoreDoc.measureCount);
        syncToPracticeStep(result.advancedToStep, "playing");
        void playbackEngineRef.current.playCountIn(scoreDoc, norm.startMeasureIndex, () => {
          if (!waitingLoopGapActiveRef.current) return;
          waitingLoopGapActiveRef.current = false;
          playbackEngineRef.current?.setMetronomePaused(true);
        });
      } else {
        triggerStepAdvanceMetronome(result.advancedToStep);
        syncToPracticeStep(result.advancedToStep, "playing");
      }
    } else if (result.advancedToStep) {
      triggerStepAdvanceMetronome(result.advancedToStep);
      syncToPracticeStep(result.advancedToStep, "playing");
    } else if (result.completedScore) {
      updatePlaybackState("stopped");
      playbackEngineRef.current?.setMetronomePaused(false);
      setActiveMetronomeBeat(null);
      syncToPracticeStep(null, "stopped");
    }
  };

  const processWaitingNoteOn = (midi: number) => {
    const isGuidedStage0 = guided.studioMode === "guided" && guided.sessionPhase === "stage0";
    const activeSteps = isGuidedStage0 ? guided.activeChunkSteps : practiceSteps;
    if ((!waitingModeEnabled && !isGuidedStage0) || activeSteps.length === 0) return;
    if (!isGuidedStage0 && waitingLoopGapActiveRef.current) return;

    const currentWaiting = waitingStateRef.current;
    let isPlayingNow = isGuidedStage0 || playbackState === "playing";
    if (!isGuidedStage0 && playbackState === "paused") {
      const currentStep = activeSteps[currentWaiting.currentStepIndex];
      if (!doesNoteOnMatchPausedStep(currentStep, midi)) {
        return;
      }
      isPlayingNow = true;
      updatePlaybackState("playing");
      playbackEngineRef.current?.setMetronomePaused(true);
      syncToPracticeStep(currentStep, "playing");
    }

    if (!isPlayingNow) return;

    const activeStep = activeSteps[currentWaiting.currentStepIndex];
    const effectiveAbLoop = isGuidedStage0 ? createDefaultAbLoopBounds(0) : abLoop;
    const result = handleWaitingNoteOn(currentWaiting, activeSteps, midi, effectiveAbLoop, {
      absoluteStrictness: isGuidedStage0 ? false : absoluteStrictnessEnabled,
      enforceHoldDuration: isGuidedStage0 ? false : strictHoldDurationEnabled,
      nowSec: getWaitingClockSec(),
      speedMultiplier: playbackSpeed,
    });
    setWaitingStateSync(result.nextState);

    if (result.faultReason === "wrong-note") {
      if (isGuidedStage0 || !absoluteStrictnessEnabled) {
        // Keep quick grazes visible even if NoteOn and NoteOff render together.
        const timers = wrongKeyFlashTimers.current;
        clearTimeout(timers.get(midi));
        setFlashedWrongMidis((prev) => new Set(prev).add(midi));
        timers.set(midi, setTimeout(() => {
          timers.delete(midi);
          setFlashedWrongMidis((prev) => {
            const next = new Set(prev);
            next.delete(midi);
            return next;
          });
        }, 180));
      }
      if (isGuidedStage0) {
        guided.handleStage0WrongNote(midi);
      } else {
        setPracticeAnalytics((prev) =>
          recordPracticeStepFault(prev, activeStep, "wrong-note", midi)
        );
      }
    }

    if (isGuidedStage0) {
      if (result.completedStep) {
        playAccompanimentNotes(result.completedStep);
        guided.handleStage0StepCompleted(currentWaiting.currentStepIndex);
        if (useGuidedSessionStore.getState().sessionPhase === "stage0") {
          if (result.advancedToStep) {
            triggerStepAdvanceMetronome(result.advancedToStep);
            syncToPracticeStep(result.advancedToStep, "playing");
          } else if (result.completedScore) {
            setWaitingStateSync(createWaitingModeState(0));
            syncToPracticeStep(activeSteps[0] ?? null, "playing");
          }
        }
      }
      return;
    }

    applyWaitingAdvanceSideEffects(result);
  };

  const processWaitingNoteOff = (midi: number) => {
    const isGuidedStage0 = guided.studioMode === "guided" && guided.sessionPhase === "stage0";
    const activeSteps = isGuidedStage0 ? guided.activeChunkSteps : practiceSteps;
    if ((!waitingModeEnabled && !isGuidedStage0) || activeSteps.length === 0) return;
    const currentWaiting = waitingStateRef.current;
    const activeStep = activeSteps[currentWaiting.currentStepIndex];
    const res = handleWaitingNoteOffWithResult(currentWaiting, midi, {
      absoluteStrictness: isGuidedStage0 ? false : absoluteStrictnessEnabled,
      enforceHoldDuration: isGuidedStage0 ? false : strictHoldDurationEnabled,
      sustainPedalPressed,
    });
    setWaitingStateSync(res.nextState);
    if (!isGuidedStage0 && res.faultReason === "early-release") {
      setPracticeAnalytics((prev) =>
        recordPracticeStepFault(prev, activeStep, "early-release", midi)
      );
    }
  };

  useEffect(() => {
    if (
      !waitingModeEnabled ||
      playbackState !== "playing" ||
      !waitingState.isHolding ||
      waitingState.tainted
    ) {
      return;
    }

    const reqRaf =
      audioDeps?.requestAnimationFrame ??
      ((cb: FrameRequestCallback) => globalThis.requestAnimationFrame(cb));
    const cancelRaf =
      audioDeps?.cancelAnimationFrame ??
      ((id: number) => globalThis.cancelAnimationFrame(id));

    let rafId = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const nowSec = getWaitingClockSec();
      const currentWaiting = waitingStateRef.current;
      const result = advanceWaitingHoldProgress(currentWaiting, practiceSteps, nowSec, abLoop);
      if (result.nextState !== currentWaiting) {
        setWaitingStateSync(result.nextState);
      }
      if (result.completedStep) {
        applyWaitingAdvanceSideEffects(result);
        return;
      }
      rafId = reqRaf(tick);
    };

    rafId = reqRaf(tick);
    return () => {
      cancelled = true;
      if (rafId) cancelRaf(rafId);
    };
  }, [
    waitingModeEnabled,
    playbackState,
    waitingState,
    practiceSteps,
    abLoop,
    audioDeps,
  ]);
  const togglePlayPauseRef = useRef<() => void>(() => {});

  useEffect(() => {
    const activeQwertyMidis = new Map<string, number>();

    const onKeyDown = (e: KeyboardEvent) => {
      const targetEl = e.target as HTMLElement | null;
      const tag = targetEl?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || targetEl?.isContentEditable) return;
      if (e.key === "Escape") {
        setPopoverOpen(false);
        setDiffDropdownOpen(false);
        setRepairPanelOpen(false);
        setPracticeReportOpen(false);
        setSettingsOpen(false);
        return;
      }
      if (guidedControllerRef.current?.routeGuidedKeyboardEvent(e)) {
        if (e.code === "Space" || e.key === " ") {
          e.preventDefault();
        }
        return;
      }
      if (
        (e.code === "Space" || e.key === " ") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault();
        if (!e.repeat) {
          togglePlayPauseRef.current();
        }
        return;
      }
      if (
        popoverOpen &&
        selectedNote &&
        !selectedNote.isTieStop &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        if (e.key >= "1" && e.key <= "5") {
          const finger = Number(e.key) as Finger;
          const mode = anchors[selectedNote.noteUid]?.mode ?? "phrase";
          handleSetAnchor(selectedNote.noteUid, finger, mode);
          return;
        }
      }

      if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
        const keyLower = e.key.toLowerCase();
        const mappedMidi = QWERTY_TO_MIDI[keyLower];
        if (mappedMidi !== undefined) {
          activeQwertyMidis.set(keyLower, mappedMidi);
          handleMidiInputEventRef.current(createLocalMidiNoteEvent("qwerty", mappedMidi, 96));
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const keyLower = e.key.toLowerCase();
      const mappedMidi = activeQwertyMidis.get(keyLower) ?? QWERTY_TO_MIDI[keyLower];
      if (mappedMidi !== undefined && activeQwertyMidis.has(keyLower)) {
        activeQwertyMidis.delete(keyLower);
        handleMidiInputEventRef.current(createLocalMidiNoteEvent("qwerty", mappedMidi, 0));
      }
    };

    const onBlur = () => {
      for (const midi of activeQwertyMidis.values()) {
        handleMidiInputEventRef.current(createLocalMidiNoteEvent("qwerty", midi, 0));
      }
      activeQwertyMidis.clear();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [popoverOpen, selectedNote, anchors]);

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  const handlePlay = () => {
    if (!scoreDoc || !playbackEngineRef.current) return;
    setPopoverOpen(false);
    if (waitingModeEnabled) {
      if (practiceSteps.length === 0) return;
      cancelWaitingLoopGapIfActive(false);
      const loopRange = findAbLoopStepRange(practiceSteps, abLoop);
      let startIdx = 0;
      if (playbackState === "paused" && waitingState.currentStepIndex < practiceSteps.length) {
        startIdx = waitingState.currentStepIndex;
      } else if (loopRange) {
        startIdx = loopRange.startStepIndex;
      } else if (selectedMeasureIndex !== null && selectedMeasureIndex > 0) {
        const idx = practiceSteps.findIndex((s) => s.measureIndex >= selectedMeasureIndex);
        startIdx = idx >= 0 ? idx : 0;
      }
      setWaitingStateSync(createWaitingModeState(startIdx));
      updatePlaybackState("playing");
      playbackEngineRef.current.setMetronomePaused(true);
      syncToPracticeStep(practiceSteps[startIdx] ?? null, "playing");
      return;
    }
    const currentPlaybackState = playbackEngineRef.current.getState();
    if (currentPlaybackState === "stopped" && selectedMeasureIndex !== null && selectedMeasureIndex > 0) {
      const tl = scoreDoc.measureTimelines[selectedMeasureIndex];
      if (tl) {
        void playbackEngineRef.current.play(scoreDoc, { fromScoreSec: tl.startSec });
        return;
      }
    }
    void playbackEngineRef.current.play(scoreDoc);
  };

  const handlePlayFromSlice = () => {
    if (!scoreDoc || !selectedSliceId || !playbackEngineRef.current) return;
    setPopoverOpen(false);
    if (waitingModeEnabled) {
      if (practiceSteps.length === 0) return;
      cancelWaitingLoopGapIfActive(false);
      const slice = onsetSlices.find((s) => s.sliceId === selectedSliceId);
      const idx = slice
        ? practiceSteps.findIndex(
            (s) =>
              s.primarySliceId === slice.sliceId ||
              (s.measureIndex === slice.measureIndex && s.onsetTick >= slice.onsetTick)
          )
        : 0;
      const startIdx = idx >= 0 ? idx : 0;
      setWaitingStateSync(createWaitingModeState(startIdx));
      updatePlaybackState("playing");
      playbackEngineRef.current.setMetronomePaused(true);
      syncToPracticeStep(practiceSteps[startIdx] ?? null, "playing");
      return;
    }
    void playbackEngineRef.current.play(scoreDoc, { fromSliceId: selectedSliceId });
  };

  const handlePause = () => {
    if (waitingModeEnabled) {
      if (playbackState !== "playing") return;
      updatePlaybackState("paused");
      playbackEngineRef.current?.setMetronomePaused(true);
      syncToPracticeStep(practiceSteps[waitingState.currentStepIndex] ?? null, "paused");
      return;
    }
    playbackEngineRef.current?.pause();
  };

  togglePlayPauseRef.current = () => {
    if (playbackState === "playing") {
      handlePause();
    } else {
      handlePlay();
    }
  };

  const handleStop = () => {
    waitingLoopGapActiveRef.current = false;
    setWaitingStateSync(createWaitingModeState(0));
    resetMidiCapture();
    playbackEngineRef.current?.stop();
    playbackEngineRef.current?.setMetronomePaused(false);
    if (waitingModeEnabled) {
      updatePlaybackState("stopped");
      syncToPracticeStep(null, "stopped");
      setActiveMetronomeBeat(null);
    }
  };

  const updateAbLoop = (next: AbLoopBounds) => {
    const normalized = normalizeAbLoopBounds(next, measureCount);
    setAbLoop(normalized);
    playbackEngineRef.current?.setAbLoop(normalized);
  };

  const handleToggleAbLoop = () => {
    if (abLoop.enabled) {
      updateAbLoop({ ...abLoop, enabled: false });
      setAbPickStep("idle");
      setAbPickStartMeasure(null);
      return;
    }
    if (abPickStep !== "idle") {
      setAbPickStep("idle");
      setAbPickStartMeasure(null);
      return;
    }
    setPopoverOpen(false);
    setAbPickStartMeasure(null);
    setAbPickStep("start");
  };

  const handlePickAbMeasure = (measureIndex: number) => {
    if (abPickStep === "start") {
      setAbPickStartMeasure(measureIndex);
      setAbPickStep("end");
      return;
    }
    if (abPickStep === "end") {
      const start = abPickStartMeasure ?? abLoop.startMeasureIndex;
      updateAbLoop({
        ...abLoop,
        startMeasureIndex: start,
        endMeasureIndex: measureIndex,
        enabled: true,
      });
      setAbPickStep("idle");
      setAbPickStartMeasure(null);
    }
  };

  const handleChangeAbLoopBounds = (bounds: AbLoopBounds) => {
    updateAbLoop(bounds);
  };

  const handleClearAbLoop = () => {
    setAbPickStep("idle");
    setAbPickStartMeasure(null);
    updateAbLoop({
      ...createDefaultAbLoopBounds(measureCount),
      loopGap: abLoop.loopGap,
    });
  };

  const handleToggleLoopGap = () => {
    updateAbLoop({ ...abLoop, loopGap: !abLoop.loopGap });
  };

  const handleToggleWaitingMode = () => {
    const next = !waitingModeEnabled;
    setWaitingModeEnabledSync(next);
    if (next) {
      // Keep MIDI Local Sound off by default whenever Waiting Mode is enabled
      setMidiLocalSound(false);
      setPopoverOpen(false);
      if (playbackEngineRef.current?.getState() === "playing") {
        playbackEngineRef.current.stop();
        const currentIdx = selectedSliceId
          ? Math.max(
              0,
              practiceSteps.findIndex((s) => s.primarySliceId === selectedSliceId)
            )
          : 0;
        setWaitingStateSync(createWaitingModeState(currentIdx));
        updatePlaybackState("playing");
        playbackEngineRef.current.setMetronomePaused(true);
        syncToPracticeStep(practiceSteps[currentIdx] ?? null, "playing");
      }
    } else {
      setWaitingStateSync(createWaitingModeState(0));
      waitingLoopGapActiveRef.current = false;
      playbackEngineRef.current?.stop();
      playbackEngineRef.current?.setMetronomePaused(false);
      updatePlaybackState("stopped");
      syncToPracticeStep(null, "stopped");
      setActiveMetronomeBeat(null);
    }
  };

  const handleToggleSkipGraceNotes = () => {
    setSkipGraceNotes((prev) => !prev);
    setWaitingStateSync(createWaitingModeState(0));
  };

  const handleSpeedChange = (nextSpeed: SpeedMultiplier) => {
    setPlaybackSpeed(nextSpeed);
    playbackEngineRef.current?.setSpeed(nextSpeed);
  };

  const handleToggleMetronome = () => {
    setMetronomeEnabled((prev) => {
      const next = !prev;
      playbackEngineRef.current?.setMetronomeEnabled(next);
      return next;
    });
  };

  const handleChangeMetronomeVolume = (volume: number) => {
    const clamped = clampMetronomeVolume(volume);
    setMetronomeVolume(clamped);
    playbackEngineRef.current?.setMetronomeVolume(clamped);
  };

  const handleToggleCountIn = () => {
    setCountInEnabled((prev) => {
      const next = !prev;
      playbackEngineRef.current?.setCountInEnabled(next);
      return next;
    });
  };

  const handlePlaySimulatedMidi = () => {
    if (!simulatedMidi) return;
    if (practiceSteps.length === 0) {
      simulatedMidi.play([60, 64, 67, 72].map((midi, stepIndex) => ({
        stepIndex,
        onsetMs: stepIndex * 300,
        notes: [{ midi, hand: "RH" }, { midi: 48, hand: "LH" }],
      })));
      return;
    }

    const waitingIndex = waitingStateRef.current.currentStepIndex;
    const startIndex = waitingModeEnabled && waitingIndex < practiceSteps.length ? waitingIndex : 0;
    const startSec = practiceSteps[startIndex].onsetSec;
    const steps: SimulatedMidiStep[] = practiceSteps.slice(startIndex).map((step) => ({
      stepIndex: step.stepIndex,
      onsetMs: (step.onsetSec - startSec) * 1000,
      notes: step.expectedNotes.map((note) => ({
        midi: note.midi,
        hand: note.hand,
        durationMs: Math.max(note.durationSec, step.expectedDurationSec) * 1000,
      })),
    }));
    simulatedMidi.play(steps, { speedMultiplier: playbackSpeed });
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-slate-50 text-slate-900">
      {simulatedMidi && <SimulatedMidiDebugBar harness={simulatedMidi} onPlay={handlePlaySimulatedMidi} />}
      {guided.studioMode === "guided" ? (
        <GuidedSessionHeader
          pieceTitle={scoreTitle || fileName}
          sessionPhase={guided.sessionPhase}
          activeChunk={guided.activeChunk}
          queueIndex={guided.currentQueueIndex}
          queueLength={guided.chunkQueue.length}
          timeBoxMinutes={guided.timeBoxMinutes}
          remainingMinutes={guided.remainingMinutes}
          effectivePracticeMode={effectivePracticeMode}
          isSingleStaff={isSingleStaff}
          midiState={midiState}
          onChangePracticeMode={handlePracticeModeChange}
          onSuspendForFingering={guided.handleSuspendForFingering}
          onEndSession={guided.handleEndSession}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : (
        <header className="shrink-0 border-b border-slate-200 bg-white px-3 py-1.5 sm:px-4">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2 lg:flex-nowrap">
            <div className="shrink-0">
              <h1 className="whitespace-nowrap text-sm font-semibold tracking-tight text-slate-900 sm:text-base">
                MusicXML 钢琴自动指法
              </h1>
              <p className="hidden text-[11px] text-slate-500 2xl:block">
                纯浏览器端 Beam Search DP 钢琴指法推导与双轨实时演练
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 lg:flex-nowrap">
              {guided.sessionPhase === "suspended" && guided.suspendedSnapshot ? (
                <GuidedResumePill
                  remainingMinutes={guided.remainingMinutes}
                  queueIndex={guided.suspendedSnapshot.currentQueueIndex}
                  queueLength={guided.suspendedSnapshot.chunkQueue.length}
                  onResume={guided.handleResumeSuspendedSession}
                  onEndSession={guided.handleEndSession}
                />
              ) : scoreDoc ? (
                <button
                  type="button"
                  data-testid="enter-guided-session-btn"
                  onClick={guided.enterGuidedLaunch}
                  className="shrink-0 whitespace-nowrap rounded-lg border border-teal-500 bg-teal-50 px-2.5 py-1 text-xs font-semibold text-teal-900 hover:bg-teal-100"
                >
                  科学练琴 (Guided)
                </button>
              ) : null}

              <label className="shrink-0 cursor-pointer whitespace-nowrap rounded-lg bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800">
              上传<span className="hidden xl:inline"> .musicxml / .mxl</span>
              <input
                type="file"
                accept=".musicxml,.xml,.mxl"
                className="hidden"
                onChange={handleFileChange}
              />
            </label>

            {persistence.storage && (
              <button type="button" data-testid="practice-backup-open"
                className="shrink-0 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
                onClick={() => { setBackupOpen(true); persistence.dismissReminder(); }}>练习备份</button>
            )}

            {library.length > 0 && (
              <select
                aria-label="已上传乐谱"
                className="max-w-[10rem] shrink-0 rounded-lg border border-slate-300 bg-white px-1.5 py-1 text-xs"
                value=""
                onChange={(e) => void handleLibrarySelect(e.target.value)}
              >
                <option value="">已上传乐谱…</option>
                {library.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            )}

            <div
              data-testid="practice-mode-selector"
              className="inline-flex shrink-0 rounded-lg border border-slate-300 bg-slate-100 p-0.5 text-xs font-medium"
              role="group"
              aria-label="练习模式"
            >
              {(
                [
                  { mode: "both" as const, label: "双手" },
                  { mode: "rh-only" as const, label: "仅右手" },
                  { mode: "lh-only" as const, label: "仅左手" },
                ] as const
              ).map(({ mode, label }) => {
                const isActive = effectivePracticeMode === mode;
                const isLockedOut = isSingleStaff && !isActive;
                return (
                  <button
                    key={mode}
                    type="button"
                    data-testid={`practice-mode-${mode}`}
                    aria-pressed={isActive}
                    disabled={isLockedOut}
                    onClick={() => handlePracticeModeChange(mode)}
                    className={`whitespace-nowrap rounded-md px-2 py-1 transition ${
                      isActive
                        ? "bg-white text-slate-900 shadow-xs"
                        : "text-slate-600 hover:text-slate-900"
                    } disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {isSingleStaff && (
              <div
                className="inline-flex shrink-0 rounded-lg border border-slate-300 bg-slate-100 p-0.5 text-xs font-medium"
                role="group"
                aria-label="单谱表声部手别"
              >
                <button
                  type="button"
                  onClick={() => void handleSingleStaffHandToggle("RH")}
                  className={`whitespace-nowrap rounded-md px-2 py-1 transition ${
                    singleStaffHand === "RH"
                      ? "bg-white text-slate-900 shadow-xs"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  右手
                </button>
                <button
                  type="button"
                  onClick={() => void handleSingleStaffHandToggle("LH")}
                  className={`whitespace-nowrap rounded-md px-2 py-1 transition ${
                    singleStaffHand === "LH"
                      ? "bg-white text-slate-900 shadow-xs"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  左手
                </button>
              </div>
            )}

            <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
              <input
                type="checkbox"
                checked={ignoreExistingFingerings}
                onChange={(e) => handleIgnoreExistingToggle(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900"
              />
              忽略原谱已有指法
            </label>

            <div className="inline-flex shrink-0 items-center gap-1">
              <button
                type="button"
                data-testid="undo-btn"
                disabled={!canUndo}
                onClick={() => useStudioStore.getState().undo()}
                className="whitespace-nowrap rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
              >
                撤销
              </button>
              <button
                type="button"
                data-testid="redo-btn"
                disabled={!canRedo}
                onClick={() => useStudioStore.getState().redo()}
                className="whitespace-nowrap rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
              >
                重做
              </button>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <select
                aria-label="导出格式"
                value={exportFormat}
                onChange={(e) => useStudioStore.getState().setExportFormat(e.target.value as ExportFormat)}
                disabled={!renderedXml}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="musicxml">.musicxml</option>
                <option value="mxl">.mxl</option>
              </select>

              <button
                type="button"
                disabled={!renderedXml}
                title={`下载 .${exportFormat}`}
                onClick={() => void handleDownload()}
                className="whitespace-nowrap rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                下载
              </button>

              <button
                type="button"
                data-testid="header-midi-status-btn"
                onClick={() => setSettingsOpen(true)}
                className={`whitespace-nowrap rounded-lg border px-2.5 py-1 text-xs font-medium transition hover:opacity-90 ${getMidiStatusBadgeClass(midiState)}`}
              >
                {formatMidiStatusLabel(midiState)} · 设置
              </button>
            </div>
          </div>
        </div>
      </header>
      )}

      <main className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-1.5 px-2.5 pt-1.5 pb-1 sm:px-4">
        {scoreDoc && guided.studioMode === "free" && guided.sessionPhase === "idle" && (
          <div
            data-testid="guided-launch-strip"
            className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-teal-200 bg-teal-50/70 px-3 py-1 text-xs text-teal-950"
          >
            <span>
              当前处于 <strong data-testid="free-studio-mode-label">Free Studio</strong> · 可自由修改指法或随时进入科学练琴。
            </span>
            <button
              type="button"
              data-testid="guided-strip-start-btn"
              onClick={guided.enterGuidedLaunch}
              className="rounded-md bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-teal-700"
            >
              开启 Guided Session
            </button>
          </div>
        )}

        {guided.studioMode === "guided" && guided.sessionPhase === "launch" && (
          <GuidedSessionLaunchCard
            pieceTitle={scoreTitle || fileName}
            macroSections={chunking.macroSections}
            motorChunks={chunking.motorChunks}
            passageClusters={chunking.passageClusters}
            chunkJunctions={chunking.chunkJunctions}
            timeBoxMinutes={guided.timeBoxMinutes}
            selectedMacroSectionId={guided.selectedMacroSectionId}
            onSelectTimeBox={guided.setTimeBoxMinutes}
            onSelectMacroSection={guided.setSelectedMacroSectionId}
            onStartSession={guided.handleStartSession}
            onBackToFreeStudio={guided.returnToFreeStudio}
          />
        )}

        {guided.studioMode === "guided" &&
          guided.sessionPhase !== "launch" &&
          guided.sessionPhase !== "idle" &&
          guided.sessionPhase !== "suspended" && (
            <div
              data-testid="guided-control-strip"
              className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-teal-200 bg-white px-3 py-1 text-xs"
            >
              <div className="flex flex-wrap items-center gap-2">
                {guided.dualPitchDisabled && (
                  <span
                    data-testid="guided-dual-pitch-notice"
                    className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-900"
                  >
                    当前块包含 A0+A#0，已自动禁用双键紧急暂停，请使用触控暂停或空格键
                  </span>
                )}
                {guided.commandNotice && (
                  <span
                    data-testid="guided-command-notice"
                    className="rounded bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-900"
                  >
                    {guided.commandNotice}
                  </span>
                )}
                {guided.sessionPhase === "stage0" && guided.stage0State && (
                  <span
                    data-testid="guided-stage0-progress"
                    className="text-[11px] font-medium text-slate-600"
                  >
                    Stage 0 落键步进: {guided.stage0State.currentStepIndex + 1}/
                    {Math.max(1, guided.stage0State.steps.length)} · 尝试{" "}
                    {guided.stage0State.passAttempts + 1}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {guided.sessionPhase === "stage0" || guided.sessionPhase === "playing" ? (
                  <button
                    type="button"
                    data-testid="guided-cmd-pause-btn"
                    onClick={() => guided.executeCommandAction("emergency-pause")}
                    className="min-h-[44px] min-w-[44px] rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
                  >
                    暂停 (A0+A#0 / Space)
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      data-testid="guided-cmd-replay-btn"
                      onClick={() => guided.executeCommandAction("replay-chunk")}
                      className="min-h-[44px] min-w-[44px] rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    >
                      重练本块 (A0 / ←)
                    </button>
                    <button
                      type="button"
                      data-testid="guided-cmd-toggle-view-btn"
                      onClick={() => guided.executeCommandAction("toggle-view")}
                      className="min-h-[44px] min-w-[44px] rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    >
                      {guided.bottomSlotView === "piano" ? "查看延迟反馈 (B0 / F)" : "查看指法与 88 键 (B0 / F)"}
                    </button>
                    <button
                      type="button"
                      data-testid="guided-cmd-continue-btn"
                      onClick={() => guided.executeCommandAction("continue-next")}
                      className="min-h-[44px] min-w-[44px] rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700"
                    >
                      {guided.sessionPhase === "paused"
                        ? "继续 (C8 / Space)"
                        : "下一块 (C8 / →)"}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        {persistence.backupReminder && (
          <aside data-testid="practice-backup-reminder" className="flex shrink-0 items-center gap-2 rounded-md bg-amber-50 px-3 py-1 text-xs text-amber-900">
            <span>浏览器可能会清理本地数据，建议定期备份练习记录。</span>
            <button type="button" className="underline" onClick={() => { setBackupOpen(true); persistence.dismissReminder(); }}>备份</button>
            <button type="button" className="underline" onClick={persistence.dismissReminder}>稍后</button>
          </aside>
        )}
        {persistence.saveError && <p role="status" className="shrink-0 rounded-md bg-amber-50 px-3 py-1 text-xs text-amber-900">
          无法写入本地练习数据，请检查浏览器存储设置或备份已有记录。
        </p>}
        {backupOpen && persistence.storage && <PracticeBackupPanel storage={persistence.storage}
          onClose={() => setBackupOpen(false)} flush={persistence.persistCurrent} onImport={workspaceScores.handleBackupImport}
          onArchive={scoreDoc && persistence.getActive() ? workspaceScores.handleArchivePiece : undefined} />}
        {workspaceScores.openChoice && <ScoreOpenChoice choice={workspaceScores.openChoice} onAnswer={workspaceScores.answerOpenChoice} />}

        {showStatusBar && (guided.studioMode === "free" || guided.sessionPhase === "launch") && (
          <div
            data-testid="top-status-warning-bar"
            className="relative flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600"
          >
          <div className="flex flex-wrap items-center gap-3">
            <span>
              <strong>状态:</strong> {status}
            </span>
            {scoreTitle && (
              <span>
                <strong>乐谱:</strong> {scoreTitle}
              </span>
            )}
            {noteEvents.length > 0 && (
              <span>
                <strong>音符:</strong> {noteEvents.length}
              </span>
            )}
            {solveResult && (
              <span>
                <strong>换指提示:</strong> {solveResult.transitionCues.length}
              </span>
            )}
            {solveResult?.priorUsed && (
              <span
                data-testid="prior-used-badge"
                className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700"
              >
                模型辅助 (λ={priorLambda.toFixed(2)})
              </span>
            )}
            {priorFallbackReason && (
              <span
                data-testid="status-prior-fallback-badge"
                className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800"
              >
                模型先验已回退经典求解
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {solveResult && (
              <div
                data-testid="compact-warning-bar"
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px]"
              >
                <span className="font-semibold text-red-700">高风险 {dangerCount}</span>
                <span className="text-slate-300">·</span>
                <span className="font-semibold text-amber-700">警告 {warnCount}</span>
                {sortedWarnings.length > 0 && (
                  <>
                    <button
                      type="button"
                      data-testid="warning-prev-btn"
                      aria-label="上一条警告"
                      onClick={() => handleStepWarning(-1)}
                      className="ml-1 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-bold text-slate-700 hover:bg-slate-100"
                    >
                      &lt;
                    </button>
                    <button
                      type="button"
                      data-testid="warning-next-btn"
                      aria-label="下一条警告"
                      onClick={() => handleStepWarning(1)}
                      className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-bold text-slate-700 hover:bg-slate-100"
                    >
                      &gt;
                    </button>
                    {warningNavIndex >= 0 && sortedWarnings[warningNavIndex] && (
                      <span
                        data-testid="active-warning-label"
                        className="max-w-52 truncate font-medium text-slate-700"
                      >
                        第{sortedWarnings[warningNavIndex].measureIndex + 1}小节{" "}
                        {sortedWarnings[warningNavIndex].label}
                      </span>
                    )}
                  </>
                )}
              </div>
            )}

            {visibleRepairSuggestions.length > 0 && (
              <div className="relative">
                <button
                  type="button"
                  data-testid="score-repair-toggle-btn"
                  onClick={() => {
                    setRepairPanelOpen((v) => !v);
                    setDiffDropdownOpen(false);
                  }}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition ${
                    hasHighRiskRepair
                      ? "border-red-300 bg-red-50 text-red-700 hover:bg-red-100"
                      : "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      hasHighRiskRepair ? "bg-red-500" : "bg-amber-500"
                    }`}
                  />
                  乐谱修复建议 {visibleRepairSuggestions.length}
                </button>
                {repairPanelOpen && (
                  <ScoreRepairPanel
                    suggestions={visibleRepairSuggestions}
                    isApplying={isApplyingRepair}
                    onLocateSuggestion={handleLocateRepairSuggestion}
                    onApplyOption={(s, opt) => void handleApplyRepairOption(s, opt)}
                    onApplyAll={(items) => void handleApplyAllRepairs(items)}
                    onDismissSuggestion={handleDismissRepair}
                    onClose={() => setRepairPanelOpen(false)}
                  />
                )}
              </div>
            )}

            {(totalPracticeFaults > 0 || practiceAnalytics.completedPasses > 0 || handsRejoinSpeed) && (
              <div className="relative">
                <button
                  type="button"
                  data-testid="practice-report-toggle-btn"
                  aria-expanded={practiceReportOpen}
                  onClick={() => {
                    setPracticeReportOpen((v) => !v);
                    setRepairPanelOpen(false);
                    setDiffDropdownOpen(false);
                  }}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition ${
                    repeatRecommendations.length > 0
                      ? "border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100"
                      : "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      repeatRecommendations.length > 0 ? "bg-rose-500" : "bg-emerald-500"
                    }`}
                  />
                  练习状态 · 已练 {practiceAnalytics.completedPasses} 遍 · 一次准确率 {practiceAccuracyPercent}%
                  {handsRejoinSpeed && " · 合手调速"}
                  {practiceProgression.isFluent
                    ? " · 已流畅"
                    : ""}
                  {repeatRecommendations.length > 0
                    ? ` · ${repeatRecommendations.length} 处易错段`
                    : ""}
                </button>

                {practiceReportOpen && (
                  <div
                    data-testid="practice-report-dropdown"
                    className="absolute right-0 top-7 z-40 w-80 max-w-[92vw] rounded-xl border border-slate-200 bg-white p-3 shadow-xl sm:w-96"
                  >
                    <div className="mb-2 flex items-center justify-between border-b border-slate-100 pb-1.5">
                      <div>
                        <div className="text-xs font-semibold text-slate-900">
                          练习进展与建议
                        </div>
                        <div className="text-[11px] text-slate-500">
                          已完成 {practiceAnalytics.completedPasses} 遍 · 累计失误 {totalPracticeFaults} 次 · 一次准确率{" "}
                          {practiceAccuracyPercent}%
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          data-testid="practice-report-reset-btn"
                          onClick={handleResetPracticeAnalytics}
                          className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 hover:bg-slate-100"
                        >
                          重置统计
                        </button>
                        <button
                          type="button"
                          data-testid="practice-report-close-btn"
                          onClick={() => setPracticeReportOpen(false)}
                          className="rounded px-1 text-slate-400 hover:text-slate-700"
                        >
                          ✕
                        </button>
                      </div>
                    </div>

                    {handsRejoinSpeed && (
                      <p className="mb-2 rounded-lg bg-slate-50 p-2 text-[11px] text-slate-700">
                        切回双手时自动补偿 −12%：{Number(handsRejoinSpeed.from.toFixed(2))}x → {Number(handsRejoinSpeed.to.toFixed(2))}x（受最低速度限制）。
                      </p>
                    )}

                    {/* Optional suggestions for the active exercise range */}
                    <div
                      data-testid="practice-progression-card"
                      data-progression-stage={practiceProgression.stage}
                      className={`mb-2.5 rounded-lg border p-2.5 text-[11px] ${
                        practiceProgression.isFluent
                          ? "border-emerald-300 bg-emerald-50/80 text-emerald-950"
                          : "border-indigo-200 bg-indigo-50/60 text-slate-800"
                      }`}
                    >
                      <div className="font-semibold">{practiceProgression.headline}</div>
                      <p className="mt-1 leading-relaxed opacity-90">
                        {practiceProgression.detail}
                      </p>

                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {practiceProgression.stage === "step-up-hand" && (
                          <button
                            type="button"
                            data-testid="progression-restore-hands-btn"
                            onClick={handleStepUpProgressionHand}
                            className="rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-700"
                          >
                            一键切回「双手合练」
                          </button>
                        )}
                        {practiceProgression.stage === "step-up-speed" && (
                          <button
                            type="button"
                            data-testid="progression-restore-speed-btn"
                            onClick={handleStepUpProgressionSpeed}
                            className="rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-700"
                          >
                            一键提速至{" "}
                            {Number(
                              (
                                practiceProgression.recommendedNextSpeedMultiplier ?? 1
                              ).toFixed(2)
                            )}
                            x
                          </button>
                        )}
                        {practiceProgression.canAdvanceToNextMeasure &&
                          practiceProgression.nextStartMeasureIndex !== null &&
                          practiceProgression.nextEndMeasureIndex !== null && (
                            <>
                              <button
                                type="button"
                                data-testid="progression-next-measure-btn"
                                onClick={() =>
                                  handleAdvanceProgressionMeasures(
                                    practiceProgression.nextStartMeasureIndex!,
                                    practiceProgression.nextEndMeasureIndex!
                                  )
                                }
                                className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${
                                  practiceProgression.stage === "ready-next-measure"
                                    ? "bg-emerald-600 text-white hover:bg-emerald-700"
                                    : "border border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-100"
                                }`}
                              >
                                进入第 {practiceProgression.nextStartMeasureIndex + 1}
                                {practiceProgression.nextEndMeasureIndex >
                                practiceProgression.nextStartMeasureIndex
                                  ? `–${practiceProgression.nextEndMeasureIndex + 1}`
                                  : ""}{" "}
                                小节 →
                              </button>
                              {practiceProgression.bridgeStartMeasureIndex !== null &&
                                practiceProgression.bridgeEndMeasureIndex !== null && (
                                  <button
                                    type="button"
                                    data-testid="progression-bridge-measure-btn"
                                    onClick={() =>
                                      handleAdvanceProgressionMeasures(
                                        practiceProgression.bridgeStartMeasureIndex!,
                                        practiceProgression.bridgeEndMeasureIndex!
                                      )
                                    }
                                    className="rounded-md border border-emerald-300 bg-white px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100"
                                  >
                                    跨小节衔接 (第{" "}
                                    {practiceProgression.bridgeStartMeasureIndex + 1}–
                                    {practiceProgression.bridgeEndMeasureIndex + 1} 小节)
                                  </button>
                                )}
                            </>
                          )}
                      </div>
                    </div>

                    {practiceProgression.sectionPaceSuggestions.length > 0 && (
                      <div className="mb-2.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-[11px] text-slate-700">
                        <div className="font-semibold">分段速度建议</div>
                        <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto">
                          {practiceProgression.sectionPaceSuggestions.map((section) => (
                            <li key={section.startMeasureIndex}>
                              第 {section.startMeasureIndex + 1}
                              {section.endMeasureIndex > section.startMeasureIndex ? `–${section.endMeasureIndex + 1}` : ""}
                              小节可从 {section.practicedSpeed}x 试着提至 {section.suggestedSpeed}x
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {repeatRecommendations.length === 0 ? (
                      <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-2.5 text-[11px] text-emerald-800">
                        目前没有需要单独重练的易错段。
                      </div>
                    ) : (
                      <div className="max-h-72 space-y-2 overflow-y-auto">
                        {repeatRecommendations.map((rec, idx) => (
                          <div
                            key={rec.id}
                            data-testid={`practice-recommendation-${idx}`}
                            className="rounded-lg border border-rose-200 bg-rose-50/40 p-2.5 text-[11px]"
                          >
                            <div className="flex items-center justify-between gap-2 font-semibold text-slate-900">
                              <span>
                                #{idx + 1} {rec.headline}
                              </span>
                            </div>
                            <p className="mt-1 leading-relaxed text-slate-600">
                              {rec.prescription}
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                data-testid={`practice-rec-loop-btn-${idx}`}
                                onClick={() =>
                                  handleApplyRepeatRecommendation(rec, {
                                    applySpeedAndMode: false,
                                  })
                                }
                                className="rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-700"
                              >
                                循环第 {rec.startMeasureIndex + 1}
                                {rec.endMeasureIndex > rec.startMeasureIndex
                                  ? `–${rec.endMeasureIndex + 1}`
                                  : ""}{" "}
                                小节
                              </button>
                              {(rec.recommendedSpeedMultiplier !== null ||
                                rec.recommendedPracticeMode !== null ||
                                rec.recommendMetronome) && (
                                <button
                                  type="button"
                                  data-testid={`practice-rec-guided-btn-${idx}`}
                                  onClick={() =>
                                    handleApplyRepeatRecommendation(rec, {
                                      applySpeedAndMode: true,
                                    })
                                  }
                                  className="rounded-md border border-rose-300 bg-white px-2 py-1 text-[11px] font-medium text-rose-800 hover:bg-rose-100"
                                >
                                  一键应用建议并循环
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {lastDiff.length > 0 && (
              <div className="relative">
                <button
                  type="button"
                  data-testid="diff-summary-pill"
                  onClick={() => {
                    setDiffDropdownOpen((v) => !v);
                    setRepairPanelOpen(false);
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-violet-300 bg-violet-50 px-2.5 py-0.5 text-[11px] font-semibold text-violet-800 hover:bg-violet-100"
                >
                  <span className="h-2 w-2 rounded-full bg-violet-600" />
                  已更新 {lastDiff.length} 个音符
                </button>
                {diffDropdownOpen && (
                  <div
                    data-testid="diff-dropdown"
                    className="absolute right-0 top-7 z-40 max-h-56 w-64 overflow-y-auto rounded-lg border border-violet-200 bg-white p-2 shadow-lg"
                  >
                    <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-violet-900">
                      <span>指法变更对照</span>
                      <button
                        type="button"
                        onClick={() => setDiffDropdownOpen(false)}
                        className="text-slate-400 hover:text-slate-700"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="space-y-1">
                      {lastDiff.map((d) => (
                        <button
                          key={d.noteUid}
                          type="button"
                          data-diff-note-uid={d.noteUid}
                          onClick={() => {
                            handleSelectNote(d.noteUid);
                            setDiffDropdownOpen(false);
                          }}
                          className="flex w-full items-center justify-between rounded border border-violet-100 bg-violet-50/50 px-2 py-1 text-left text-[11px] text-violet-900 hover:bg-violet-100"
                        >
                          <span>
                            第{d.measureIndex + 1}小节 {d.pitchLabel} ({d.hand === "RH" ? "右手" : "左手"})
                          </span>
                          <span className="font-bold">
                            {d.before ?? "—"} → {d.after ?? "—"}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <span className="hidden text-slate-400 xl:inline">纯本地运算 · Web Worker DP</span>
          </div>
          </div>
        )}

        {errorMsg && (
          <div
            role="alert"
            className="shrink-0 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700"
          >
            <strong>无法加载乐谱:</strong> {errorMsg}
          </div>
        )}

        {/* Top Pane: Continuous Scrolling Score Canvas + Inline Note Anchor Popover */}
        <div
          data-testid="top-score-pane"
          className="relative flex min-h-0 flex-1 flex-col"
        >
          <ScoreViewer
            xmlString={renderedXml}
            scoreDoc={scoreDoc}
            noteEvents={noteEvents}
            measureRisks={measureRisks}
            anchoredNotes={anchoredNotes}
            diffNotes={lastDiff}
            selectedMeasureIndex={selectedMeasureIndex}
            selectedSliceId={selectedSliceId}
            selectedNoteUid={selectedNoteUid}
            cursorTarget={cursorTarget}
            playbackFrame={playbackFrame}
            layoutMode={layoutMode}
            abLoopRange={
              abLoop.enabled
                ? {
                    startMeasureIndex: abLoop.startMeasureIndex,
                    endMeasureIndex: abLoop.endMeasureIndex,
                  }
                : null
            }
            abPickStep={abPickStep}
            spotlightChunk={guided.spotlightChunk}
            motorChunks={chunking.motorChunks}
            chunkJunctions={chunking.chunkJunctions}
            performanceCues={chunking.performanceCues}
            chunkEditingEnabled={
              playbackState !== "playing" &&
              (guided.studioMode === "free" || guided.sessionPhase === "launch")
            }
            hasChunkOverrides={chunking.hasChunkOverrides}
            hasCueOverrides={chunking.hasCueOverrides}
            inspectedClusterInstance={
              playbackState === "playing" ? null : chunking.inspectedClusterInstance
            }
            inspectedClusterLabel={chunking.inspectedClusterLabel}
            onLayoutModeChange={setLayoutMode}
            onSelectMeasure={handleSelectMeasure}
            onSelectNote={handleSelectNote}
            onPickAbMeasure={handlePickAbMeasure}
            onMeasureGeometryChange={setMeasureGeometry}
            onSplitChunkAtMeasure={chunking.handleSplitChunkAtMeasure}
            onMergeChunkBoundary={chunking.handleMergeChunkBoundary}
            onResetChunkOverrides={chunking.handleResetChunkOverrides}
            onUpsertCueOverride={chunking.handleUpsertCueOverride}
            onRemoveCueOverride={chunking.handleRemoveCueOverride}
            onResetCueOverrides={chunking.handleResetCueOverrides}
            onCloseInspectCluster={chunking.closeInspectCluster}
            rendererFactory={scoreRendererFactory}
          />

          {popoverOpen && selectedNote && (
            <NoteAnchorPopover
              note={selectedNote}
              fingerByNoteUid={fingerByNoteUid}
              anchors={anchors}
              removedRawAnchorUids={removedRawAnchorUids}
              repairedAnchorUids={solveResult?.repairedAnchorUids ?? []}
              ignoreExistingFingerings={ignoreExistingFingerings}
              isResolving={isResolving}
              anchorRect={popoverAnchorRect}
              onSetAnchor={handleSetAnchor}
              onRemoveAnchor={handleRemoveAnchor}
              onPlayFromHere={handlePlayFromSlice}
              onClose={() => setPopoverOpen(false)}
            />
          )}

          {guided.studioMode === "guided" && guided.sessionPhase === "micro-rest" && (
            <div
              data-testid="guided-micro-rest-veil"
              className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-xl bg-slate-900/55 p-6 text-center text-white backdrop-blur-xs"
            >
              <div className="text-sm font-semibold tracking-wide">
                清醒微休息（Micro-Rest）
              </div>
              <p className="max-w-md text-xs text-slate-200">
                双手离开琴键静放{" "}
                {Math.max(
                  1,
                  Math.ceil(
                    (guided.microRestDurationMs -
                      Math.max(0, nowMs() - (guided.microRestStartedAtMs ?? nowMs()))) /
                      1000,
                  ),
                )}{" "}
                秒，让动作记忆自然巩固。
              </p>
              {guided.microRestReminder && (
                <p
                  data-testid="guided-micro-rest-reminder"
                  className="rounded-md bg-white/15 px-3 py-1 text-xs text-amber-100"
                >
                  {guided.microRestReminder}
                </p>
              )}
              <button
                type="button"
                data-testid="guided-skip-micro-rest-btn"
                onClick={() => guided.executeCommandAction("continue-next")}
                className="min-h-[44px] min-w-[44px] rounded-lg border border-white/40 bg-white/15 px-4 py-2 text-xs font-semibold text-white hover:bg-white/25"
              >
                跳过微休息 (C8 / →)
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Middle Pane: Dedicated Transport & Practice Bar */}
      {(guided.studioMode === "free" || guided.sessionPhase === "launch") && (
      <TransportPracticeBar
        hasScore={Boolean(scoreDoc && onsetSlices.length > 0)}
        hasSelectedSlice={Boolean(selectedSliceId)}
        playbackState={playbackState}
        speedMultiplier={playbackSpeed}
        baseBpm={scoreDoc?.tempoPoints[0]?.bpm ?? 100}
        audioStatus={audioStatus}
        pianoTimbre={pianoTimbre}
        measureCount={measureCount}
        measureTimelines={scoreDoc?.measureTimelines ?? []}
        measureRisks={measureRisks}
        measureErrorsByIndex={measureErrorsByIndex}
        measureGeometry={measureGeometry}
        layoutMode={layoutMode}
        activeMeasureIndex={cursorTarget?.measureIndex ?? selectedMeasureIndex}
        midiStatusLabel={formatMidiStatusLabel(midiState)}
        onOpenSettings={() => setSettingsOpen(true)}
        metronomeEnabled={metronomeEnabled}
        metronomePaused={waitingModeEnabled && playbackState === "playing"}
        activeMetronomeBeat={activeMetronomeBeat}
        waitingModeEnabled={waitingModeEnabled}
        abLoop={abLoop}
        abPickStep={abPickStep}
        abPickStartMeasure={abPickStartMeasure}
        passageClusters={chunking.passageClusters}
        inspectedClusterInstanceId={chunking.inspectedClusterInstanceId}
        onToggleInspectClusterInstance={chunking.toggleInspectClusterInstance}
        onPlay={handlePlay}
        onPlayFromSlice={handlePlayFromSlice}
        onPause={handlePause}
        onStop={handleStop}
        onJumpToStart={handleJumpToStart}
        onJumpToMeasure={handleSelectMeasure}
        onChangeSpeed={handleSpeedChange}
        onToggleMetronome={handleToggleMetronome}
        onToggleWaitingMode={handleToggleWaitingMode}
        onToggleAbLoop={handleToggleAbLoop}
        onPickAbMeasure={handlePickAbMeasure}
        onChangeAbLoopBounds={handleChangeAbLoopBounds}
        onClearAbLoop={handleClearAbLoop}
      />
      )}

      {/* Bottom Pane: Full-Width 88-Key Physical Piano & Dual-Hand Posture Simulation */}
      <div data-testid="bottom-piano-pane" className="shrink-0">
        {guided.studioMode === "guided" && guided.bottomSlotView === "feedback" ? (
          <section
            data-testid="guided-delayed-feedback-panel"
            className="flex flex-wrap items-center justify-between gap-3 border-t border-teal-200 bg-white px-4 py-4 text-xs"
          >
            <div className="space-y-1">
              <div className="font-semibold text-slate-900">
                {guided.lastBoutSummary?.headline ?? "当前组块反馈"}
              </div>
              <div className="text-slate-600">
                {guided.lastBoutSummary?.detail ??
                  "Stage 0 落键停顿遥测已严格隔离，不写入连续声学画像；可按 B0 或 F 切回 88 键手型与指法。"}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="guided-back-to-piano-btn"
                onClick={() => guided.setBottomSlotView("piano")}
                className="min-h-[44px] min-w-[44px] rounded-lg border border-teal-500 bg-teal-50 px-3 py-2 text-xs font-semibold text-teal-900 hover:bg-teal-100"
              >
                切回指法与 88 键手型 (B0 / F)
              </button>
              <button
                type="button"
                onClick={() => guided.executeCommandAction("continue-next")}
                className="min-h-[44px] min-w-[44px] rounded-lg bg-teal-600 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-700"
              >
                继续 / 下一块 (C8)
              </button>
            </div>
          </section>
        ) : (
        <UnifiedPiano88
          scoreDoc={scoreDoc}
          solveResult={solveResult}
          selectedSliceId={selectedSliceId}
          handSpanProfile={handSpanProfile}
          playbackFrame={playbackFrame}
          practiceMode={effectivePracticeMode}
          showOverhead={showPianoOverhead}
          showFullPalm={showFullPalm}
          wrongMidis={
            (guided.studioMode === "guided" && guided.sessionPhase === "stage0") ||
            (waitingModeEnabled && !absoluteStrictnessEnabled)
              ? flashedWrongMidis.size > 0
                ? new Set([...waitingState.wrongMidis, ...flashedWrongMidis])
                : waitingState.wrongMidis
              : waitingState.wrongMidis
          }
          hitMidis={waitingState.hitMidis}
          pressedMidis={pressedMidis}
          sustainPedalPressed={sustainPedalPressed}
          waitingTainted={waitingState.tainted}
          waitingResetReason={waitingState.lastResetReason}
          waitingIsHolding={waitingState.isHolding}
          waitingHoldProgress={waitingState.holdProgress}
          commandKeyBadges={guided.commandKeyBadges}
          onSelectSlice={handleSelectSlice}
          onVirtualNoteOn={(midi, velocity = 96) =>
            handleMidiInputEvent(createLocalMidiNoteEvent("virtual", midi, velocity))
          }
          onVirtualNoteOff={(midi) =>
            handleMidiInputEvent(createLocalMidiNoteEvent("virtual", midi, 0))
          }
        />
        )}
      </div>

      <PracticeSettingsModal
        open={settingsOpen}
        midiState={midiState}
        midiLocalSound={midiLocalSound}
        audioStatus={audioStatus}
        pianoTimbre={pianoTimbre}
        speedMultiplier={playbackSpeed}
        baseBpm={scoreDoc?.tempoPoints[0]?.bpm ?? 100}
        countInEnabled={countInEnabled}
        loopGapEnabled={abLoop.loopGap}
        metronomeVolume={metronomeVolume}
        skipGraceNotes={skipGraceNotes}
        absoluteStrictnessEnabled={absoluteStrictnessEnabled}
        strictHoldDurationEnabled={strictHoldDurationEnabled}
        cc64CommandEnabled={guided.cc64CommandEnabled}
        showStatusBar={showStatusBar}
        showPianoOverhead={showPianoOverhead}
        showFullPalm={showFullPalm}
        handSpanProfile={handSpanProfile}
        priorMode={priorMode}
        priorLambda={priorLambda}
        priorLoading={priorLoading}
        priorProgress={priorProgress}
        priorFallbackReason={priorFallbackReason}
        customModelBaseUrl={customModelBaseUrl}
        onSelectDevice={(deviceId) => midiControllerRef.current?.setSelectedDeviceId(deviceId)}
        onToggleLocalSound={setMidiLocalSound}
        onChangePianoTimbre={(nextTimbre) => {
          setPianoTimbre(nextTimbre);
          writeStoredPianoTimbre(nextTimbre);
          if (playbackEngineRef.current?.getState() === "playing") {
            playbackEngineRef.current.stop();
          }
          const reload = audioEngineRef.current?.setTimbre(nextTimbre);
          if (!reload) {
            setAudioStatus(audioEngineRef.current?.getStatus() ?? "idle");
          }
        }}
        onPreviewTimbre={() => {
          const audio = audioEngineRef.current;
          if (!audio) return;
          void audio.prepare().then(() => {
            const ctx = audio.getAudioContext();
            const t = ctx.currentTime;
            [60, 64, 67, 71].forEach((midi, idx) => {
              audio.triggerNote({
                midi,
                time: t + idx * 0.08,
                duration: 0.9,
                velocity: 84,
              });
            });
          });
        }}
        onToggleCountIn={handleToggleCountIn}
        onToggleLoopGap={handleToggleLoopGap}
        onChangeMetronomeVolume={handleChangeMetronomeVolume}
        onToggleSkipGraceNotes={handleToggleSkipGraceNotes}
        onToggleAbsoluteStrictness={() => {
          setAbsoluteStrictnessEnabled((prev) => !prev);
          setWaitingStateSync(createWaitingModeState(waitingStateRef.current.currentStepIndex));
        }}
        onToggleStrictHoldDuration={() => {
          setStrictHoldDurationEnabled((prev) => !prev);
          setWaitingStateSync(createWaitingModeState(waitingStateRef.current.currentStepIndex));
        }}
        onToggleCc64Command={() => guided.setCc64CommandEnabled(!guided.cc64CommandEnabled)}
        onToggleShowStatusBar={() => setShowStatusBar((v) => !v)}
        onToggleShowPianoOverhead={() => setShowPianoOverhead((v) => !v)}
        onToggleShowFullPalm={() => setShowFullPalm((v) => !v)}
        onChangeHandSpanProfile={handleProfileChange}
        onChangePriorMode={handlePriorModeChange}
        onChangePriorLambda={handlePriorLambdaChange}
        onChangeCustomModelBaseUrl={handleCustomModelBaseUrlChange}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
