import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  type AnchorOverride,
  type AnchorOverrideMode,
  type Finger,
  type Hand,
  type HandSpanProfile,
  type ScoreDocument,
  type SpanPreset,
  type TransitionCue,
} from "./domain/types";
import type { MxlContainer } from "./musicxml/mxl";
import { parseMusicXml } from "./musicxml/parser";
import { exportScoreOutput, loadScoreInput, type ExportFormat } from "./musicxml/scoreSession";
import { applyAnchorOverridesToSlices, localResolveFingering } from "./solver/localResolve";
import { createSolverClient, SolverCancelledError, type SolverClient } from "./workers/solverClient";
import { computeNextAnchorState, useStudioStore } from "./store/useStudioStore";
import { buildMeasureRiskSummaries } from "./components/MarginRiskGutter";
import { NoteAnchorPopover, type PopoverAnchorRect } from "./components/NoteAnchorPopover";
import { UnifiedPiano88 } from "./components/UnifiedPiano88";
import { sortWarningsForNavigation } from "./components/warningUtils";
import {
  ScoreViewer,
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
import {
  createWebMidiController,
  getDefaultRequestMIDIAccess,
  QWERTY_TO_MIDI,
  type MIDIAccessLike,
  type MidiConnectionState,
  type MidiInputEvent,
  type WebMidiController,
} from "./midi/webMidi";
import {
  createPianoAudioEngine,
  type AudioEngineStatus,
  type PianoAudioDeps,
  type PianoAudioEngine,
} from "./audio/pianoAudio";
import {
  createPlaybackEngine,
  type CursorSyncTarget,
  type PlaybackEngine,
  type PlaybackFrame,
  type PlaybackState,
  type SpeedMultiplier,
} from "./audio/playbackEngine";

const SPAN_PRESETS: Array<{ preset: SpanPreset; title: string }> = [
  { preset: "S", title: "Small hand span (0.82x)" },
  { preset: "M", title: "Medium hand span (1.00x)" },
  { preset: "L", title: "Large hand span (1.18x)" },
];

export interface AppAudioDeps extends PianoAudioDeps {
  requestAnimationFrame?: (cb: FrameRequestCallback) => number;
  cancelAnimationFrame?: (id: number) => void;
}

export interface AppMidiDeps {
  requestMIDIAccess?: () => Promise<MIDIAccessLike>;
}

export interface AppProps {
  solverClientFactory?: () => SolverClient;
  scoreRendererFactory?: ScoreRendererFactory;
  audioDeps?: AppAudioDeps;
  midiDeps?: AppMidiDeps;
}

export default function App({
  solverClientFactory = createSolverClient,
  scoreRendererFactory,
  audioDeps,
  midiDeps,
}: AppProps) {
  const solverClientRef = useRef<SolverClient | null>(null);
  const audioEngineRef = useRef<PianoAudioEngine | null>(null);
  const playbackEngineRef = useRef<PlaybackEngine | null>(null);
  const midiControllerRef = useRef<WebMidiController | null>(null);
  const [isResolving, setIsResolving] = useState<boolean>(false);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("stopped");
  const [playbackSpeed, setPlaybackSpeed] = useState<SpeedMultiplier>(1.0);
  const [audioStatus, setAudioStatus] = useState<AudioEngineStatus>("idle");
  const [cursorTarget, setCursorTarget] = useState<CursorSyncTarget | null>(null);
  const [playbackFrame, setPlaybackFrame] = useState<PlaybackFrame | null>(null);
  const [layoutMode, setLayoutMode] = useState<ScoreLayoutMode>("horizontal");
  const [popoverOpen, setPopoverOpen] = useState<boolean>(false);
  const [popoverAnchorRect, setPopoverAnchorRect] = useState<PopoverAnchorRect | null>(null);
  const [diffDropdownOpen, setDiffDropdownOpen] = useState<boolean>(false);
  const [warningNavIndex, setWarningNavIndex] = useState<number>(-1);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
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

  useEffect(() => {
    const audioEngine = createPianoAudioEngine({
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
      onStateChange: setPlaybackState,
      onSliceChange: (slice) => {
        useStudioStore.getState().selectSlice(slice.sliceId);
      },
      onCursorSync: setCursorTarget,
      onFrame: setPlaybackFrame,
    });
    playbackEngineRef.current = engine;
    return () => {
      engine.dispose();
      playbackEngineRef.current = null;
      audioEngineRef.current = null;
    };
  }, [audioDeps]);

  const handleMidiInputEvent = (event: MidiInputEvent) => {
    if (event.type === "noteon") {
      setPressedMidis((prev) => {
        if (prev.has(event.midi)) return prev;
        const next = new Set(prev);
        next.add(event.midi);
        return next;
      });
      if (event.source !== "midi" || midiLocalSoundRef.current) {
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
      return;
    }

    if (event.type === "noteoff") {
      setPressedMidis((prev) => {
        if (!prev.has(event.midi)) return prev;
        const next = new Set(prev);
        next.delete(event.midi);
        return next;
      });
      return;
    }

    if (event.type === "sustain") {
      setSustainPedalPressed(event.pressed);
    }
  };

  const handleMidiInputEventRef = useRef(handleMidiInputEvent);
  handleMidiInputEventRef.current = handleMidiInputEvent;

  useEffect(() => {
    const requestMIDIAccess = midiDeps
      ? midiDeps.requestMIDIAccess
      : getDefaultRequestMIDIAccess();

    const controller = createWebMidiController({
      requestMIDIAccess,
      onStateChange: setMidiState,
      onMidiEvent: (event) => handleMidiInputEventRef.current(event),
    });
    midiControllerRef.current = controller;
    void controller.connect();

    return () => {
      controller.dispose();
      midiControllerRef.current = null;
    };
  }, [midiDeps]);

  const solveAndRender = async (
    nextDoc: ScoreDocument,
    nextRawXml: string,
    nextFileName: string,
    nextFormat: ExportFormat,
    nextMxl: MxlContainer | undefined,
    profile: HandSpanProfile,
    ignoreAnchors: boolean,
    resetHistory: boolean
  ) => {
    if (!solverClientRef.current) return;
    playbackEngineRef.current?.stop();
    const store = useStudioStore.getState();
    store.setStatus("Solving fingerings in Web Worker...");

    const slicesToSolve = resetHistory
      ? nextDoc.onsetSlices
      : applyAnchorOverridesToSlices(
          nextDoc.onsetSlices,
          store.anchors,
          store.removedRawAnchorUids,
          ignoreAnchors
        );

    const result = await solverClientRef.current.solve(slicesToSolve, profile, {
      ignoreExistingFingerings: resetHistory ? ignoreAnchors : false,
    });

    store.setSolvedScore({
      scoreDoc: nextDoc,
      rawXmlText: nextRawXml,
      mxlContainer: nextMxl,
      fileName: nextFileName,
      exportFormat: nextFormat,
      solveResult: result,
      resetHistory,
    });
  };

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
        false
      );
    } catch (err) {
      if (err instanceof SolverCancelledError) {
        return;
      }
      store.setErrorMsg(err instanceof Error ? err.message : String(err));
      store.setStatus("Error");
    }
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !solverClientRef.current) return;

    playbackEngineRef.current?.stop();
    const store = useStudioStore.getState();
    store.setErrorMsg(null);
    store.setStatus("Parsing MusicXML...");

    try {
      const isMxl = file.name.toLowerCase().endsWith(".mxl");
      const session = isMxl
        ? await loadScoreInput({ fileName: file.name, bytes: await file.arrayBuffer() })
        : await loadScoreInput({ fileName: file.name, text: await file.text() });

      await solveAndRender(
        session.scoreDoc,
        session.rawXmlText,
        file.name,
        session.sourceFormat,
        session.mxlContainer,
        store.handSpanProfile,
        store.ignoreExistingFingerings,
        true
      );
    } catch (err) {
      if (err instanceof SolverCancelledError) {
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
      const input = {
        onsetSlices: store.scoreDoc.onsetSlices,
        profile: store.handSpanProfile,
        priorFingerByNoteUid: store.fingerByNoteUid,
        targetNoteUid: noteUid,
        override,
        anchors: nextAnchors,
        removedRawAnchorUids: nextRemoved,
        ignoreExistingFingerings: store.ignoreExistingFingerings,
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

  useEffect(() => {
    setWarningNavIndex(-1);
  }, [solveResult]);

  useEffect(() => {
    if (lastDiff.length === 0) {
      setDiffDropdownOpen(false);
    }
  }, [lastDiff]);

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

  const handleSelectMeasure = (measureIndex: number) => {
    const summary = measureRisks.find((m) => m.measureIndex === measureIndex);
    useStudioStore
      .getState()
      .selectMeasure(measureIndex, summary?.firstWarningSliceId ?? summary?.firstSliceId ?? null);
    setPopoverOpen(false);
    if (playbackState === "playing" && scoreDoc && playbackEngineRef.current) {
      const tl = scoreDoc.measureTimelines[measureIndex];
      if (tl) {
        void playbackEngineRef.current.play(scoreDoc, { fromScoreSec: tl.startSec });
      } else if (summary?.firstSliceId) {
        void playbackEngineRef.current.play(scoreDoc, { fromSliceId: summary.firstSliceId });
      }
    }
  };

  const handleJumpToStart = () => {
    if (!scoreDoc) return;
    setPopoverOpen(false);
    const firstSliceId = onsetSlices[0]?.sliceId ?? null;
    useStudioStore.getState().selectMeasure(0, firstSliceId);
    if (playbackState === "playing" && playbackEngineRef.current) {
      void playbackEngineRef.current.play(scoreDoc, { restart: true });
    } else if (playbackState === "paused") {
      playbackEngineRef.current?.stop();
    }
  };

  const handleSelectSlice = (sliceId: string) => {
    useStudioStore.getState().selectSlice(sliceId);
  };

  const handleSelectNote = (noteUid: string, anchorRect?: PopoverAnchorRect) => {
    if (playbackState !== "stopped") {
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
        if (playbackState === "playing" && scoreDoc && playbackEngineRef.current) {
          void playbackEngineRef.current.play(scoreDoc, { fromSliceId: targetSlice.sliceId });
        }
      }
      return;
    }
    useStudioStore.getState().selectNote(noteUid);
    setPopoverAnchorRect(anchorRect ?? null);
    setPopoverOpen(true);
  };

  useEffect(() => {
    const activeQwertyMidis = new Map<string, number>();

    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Escape") {
        setPopoverOpen(false);
        setDiffDropdownOpen(false);
        setSettingsOpen(false);
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
          handleMidiInputEventRef.current({
            type: "noteon",
            midi: mappedMidi,
            velocity: 96,
            channel: 0,
            portId: "qwerty-keyboard",
            source: "qwerty",
          });
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const keyLower = e.key.toLowerCase();
      const mappedMidi = activeQwertyMidis.get(keyLower) ?? QWERTY_TO_MIDI[keyLower];
      if (mappedMidi !== undefined && activeQwertyMidis.has(keyLower)) {
        activeQwertyMidis.delete(keyLower);
        handleMidiInputEventRef.current({
          type: "noteoff",
          midi: mappedMidi,
          velocity: 0,
          channel: 0,
          portId: "qwerty-keyboard",
          source: "qwerty",
        });
      }
    };

    const onBlur = () => {
      for (const midi of activeQwertyMidis.values()) {
        handleMidiInputEventRef.current({
          type: "noteoff",
          midi,
          velocity: 0,
          channel: 0,
          portId: "qwerty-keyboard",
          source: "qwerty",
        });
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
    void playbackEngineRef.current.play(scoreDoc);
  };

  const handlePlayFromSlice = () => {
    if (!scoreDoc || !selectedSliceId || !playbackEngineRef.current) return;
    setPopoverOpen(false);
    void playbackEngineRef.current.play(scoreDoc, { fromSliceId: selectedSliceId });
  };

  const handlePause = () => {
    playbackEngineRef.current?.pause();
  };

  const handleStop = () => {
    playbackEngineRef.current?.stop();
  };

  const handleSpeedChange = (nextSpeed: SpeedMultiplier) => {
    setPlaybackSpeed(nextSpeed);
    playbackEngineRef.current?.setSpeed(nextSpeed);
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-50 text-slate-900">
      <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold tracking-tight text-slate-900">
              MusicXML Auto-Fingering
            </h1>
            <p className="text-[11px] text-slate-500">
              Browser-local Beam Search DP piano fingering &amp; real-time dual-hand rehearsal
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="cursor-pointer rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
              Upload .musicxml / .mxl
              <input
                type="file"
                accept=".musicxml,.xml,.mxl"
                className="hidden"
                onChange={handleFileChange}
              />
            </label>

            {isSingleStaff && (
              <div
                className="inline-flex rounded-lg border border-slate-300 bg-slate-100 p-0.5 text-xs font-medium"
                role="group"
                aria-label="Single-staff hand assignment"
              >
                <button
                  type="button"
                  onClick={() => void handleSingleStaffHandToggle("RH")}
                  className={`rounded-md px-3 py-1.5 transition ${
                    singleStaffHand === "RH"
                      ? "bg-white text-slate-900 shadow-xs"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  Right Hand
                </button>
                <button
                  type="button"
                  onClick={() => void handleSingleStaffHandToggle("LH")}
                  className={`rounded-md px-3 py-1.5 transition ${
                    singleStaffHand === "LH"
                      ? "bg-white text-slate-900 shadow-xs"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  Left Hand
                </button>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <div
                className="inline-flex rounded-lg border border-slate-300 bg-slate-100 p-0.5 text-xs font-medium"
                role="group"
                aria-label="Hand Span Profile"
              >
                {SPAN_PRESETS.map(({ preset, title }) => (
                  <button
                    key={preset}
                    type="button"
                    title={title}
                    aria-pressed={handSpanProfile.preset === preset}
                    onClick={() =>
                      handleProfileChange({ ...handSpanProfile, preset })
                    }
                    className={`rounded-md px-2.5 py-1.5 transition ${
                      handSpanProfile.preset === preset
                        ? "bg-white text-slate-900 shadow-xs"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>

              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={handSpanProfile.avoidThumbOnBlack}
                  onChange={(e) =>
                    handleProfileChange({
                      ...handSpanProfile,
                      avoidThumbOnBlack: e.target.checked,
                    })
                  }
                  className="rounded border-slate-300 text-slate-900"
                />
                Avoid thumb on black
              </label>

              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={handSpanProfile.preferStablePosition}
                  onChange={(e) =>
                    handleProfileChange({
                      ...handSpanProfile,
                      preferStablePosition: e.target.checked,
                    })
                  }
                  className="rounded border-slate-300 text-slate-900"
                />
                Prefer stable position
              </label>

              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={ignoreExistingFingerings}
                  onChange={(e) => handleIgnoreExistingToggle(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900"
                />
                Ignore original fingerings
              </label>
            </div>

            <div className="inline-flex items-center gap-1.5">
              <button
                type="button"
                data-testid="undo-btn"
                disabled={!canUndo}
                onClick={() => useStudioStore.getState().undo()}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Undo
              </button>
              <button
                type="button"
                data-testid="redo-btn"
                disabled={!canRedo}
                onClick={() => useStudioStore.getState().redo()}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Redo
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <select
                aria-label="Export format"
                value={exportFormat}
                onChange={(e) => useStudioStore.getState().setExportFormat(e.target.value as ExportFormat)}
                disabled={!renderedXml}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="musicxml">.musicxml</option>
                <option value="mxl">.mxl</option>
              </select>

              <button
                type="button"
                disabled={!renderedXml}
                onClick={() => void handleDownload()}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Download .{exportFormat}
              </button>

              <button
                type="button"
                data-testid="header-midi-status-btn"
                onClick={() => setSettingsOpen(true)}
                className={`rounded-lg border px-3 py-2 text-xs font-medium transition hover:opacity-90 ${getMidiStatusBadgeClass(midiState)}`}
              >
                {formatMidiStatusLabel(midiState)} · Settings
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-2 px-4 pt-2 pb-1">
        <div
          data-testid="top-status-warning-bar"
          className="relative flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600"
        >
          <div className="flex flex-wrap items-center gap-3">
            <span>
              <strong>Status:</strong> {status}
            </span>
            {scoreTitle && (
              <span>
                <strong>Score:</strong> {scoreTitle}
              </span>
            )}
            {noteEvents.length > 0 && (
              <span>
                <strong>Notes:</strong> {noteEvents.length}
              </span>
            )}
            {solveResult && (
              <span>
                <strong>Transitions:</strong> {solveResult.transitionCues.length}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {solveResult && (
              <div
                data-testid="compact-warning-bar"
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px]"
              >
                <span className="font-semibold text-red-700">Danger {dangerCount}</span>
                <span className="text-slate-300">·</span>
                <span className="font-semibold text-amber-700">Warn {warnCount}</span>
                {sortedWarnings.length > 0 && (
                  <>
                    <button
                      type="button"
                      data-testid="warning-prev-btn"
                      aria-label="Previous warning"
                      onClick={() => handleStepWarning(-1)}
                      className="ml-1 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-bold text-slate-700 hover:bg-slate-100"
                    >
                      &lt;
                    </button>
                    <button
                      type="button"
                      data-testid="warning-next-btn"
                      aria-label="Next warning"
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
                        m.{sortedWarnings[warningNavIndex].measureIndex + 1}{" "}
                        {sortedWarnings[warningNavIndex].label}
                      </span>
                    )}
                  </>
                )}
              </div>
            )}

            {lastDiff.length > 0 && (
              <div className="relative">
                <button
                  type="button"
                  data-testid="diff-summary-pill"
                  onClick={() => setDiffDropdownOpen((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-full border border-violet-300 bg-violet-50 px-2.5 py-0.5 text-[11px] font-semibold text-violet-800 hover:bg-violet-100"
                >
                  <span className="h-2 w-2 rounded-full bg-violet-600" />
                  Updated {lastDiff.length} note{lastDiff.length === 1 ? "" : "s"}
                </button>
                {diffDropdownOpen && (
                  <div
                    data-testid="diff-dropdown"
                    className="absolute right-0 top-7 z-40 max-h-56 w-64 overflow-y-auto rounded-lg border border-violet-200 bg-white p-2 shadow-lg"
                  >
                    <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-violet-900">
                      <span>Before → After Diff</span>
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
                            m.{d.measureIndex + 1} {d.pitchLabel} ({d.hand})
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

            <span className="hidden text-slate-400 xl:inline">Zero backend · Web Worker DP</span>
          </div>
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="shrink-0 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700"
          >
            <strong>Unable to load score:</strong> {errorMsg}
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
            onLayoutModeChange={setLayoutMode}
            onSelectMeasure={handleSelectMeasure}
            onSelectNote={handleSelectNote}
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
        </div>
      </main>

      {/* Middle Pane: Dedicated Transport & Practice Bar */}
      <TransportPracticeBar
        hasScore={Boolean(scoreDoc && onsetSlices.length > 0)}
        hasSelectedSlice={Boolean(selectedSliceId)}
        playbackState={playbackState}
        speedMultiplier={playbackSpeed}
        baseBpm={scoreDoc?.tempoPoints[0]?.bpm ?? 100}
        audioStatus={audioStatus}
        measureCount={measureCount}
        measureTimelines={scoreDoc?.measureTimelines ?? []}
        activeMeasureIndex={cursorTarget?.measureIndex ?? selectedMeasureIndex}
        midiStatusLabel={formatMidiStatusLabel(midiState)}
        onOpenSettings={() => setSettingsOpen(true)}
        onPlay={handlePlay}
        onPlayFromSlice={handlePlayFromSlice}
        onPause={handlePause}
        onStop={handleStop}
        onJumpToStart={handleJumpToStart}
        onJumpToMeasure={handleSelectMeasure}
        onChangeSpeed={handleSpeedChange}
      />

      {/* Bottom Pane: Full-Width 88-Key Physical Piano & Dual-Hand Posture Simulation */}
      <div data-testid="bottom-piano-pane" className="shrink-0">
        <UnifiedPiano88
          scoreDoc={scoreDoc}
          solveResult={solveResult}
          selectedSliceId={selectedSliceId}
          handSpanProfile={handSpanProfile}
          playbackFrame={playbackFrame}
          pressedMidis={pressedMidis}
          sustainPedalPressed={sustainPedalPressed}
          onSelectSlice={handleSelectSlice}
          onVirtualNoteOn={(midi, velocity = 96) =>
            handleMidiInputEvent({
              type: "noteon",
              midi,
              velocity,
              channel: 0,
              portId: "virtual-keyboard",
              source: "virtual",
            })
          }
          onVirtualNoteOff={(midi) =>
            handleMidiInputEvent({
              type: "noteoff",
              midi,
              velocity: 0,
              channel: 0,
              portId: "virtual-keyboard",
              source: "virtual",
            })
          }
        />
      </div>

      <PracticeSettingsModal
        open={settingsOpen}
        midiState={midiState}
        midiLocalSound={midiLocalSound}
        speedMultiplier={playbackSpeed}
        baseBpm={scoreDoc?.tempoPoints[0]?.bpm ?? 100}
        onSelectDevice={(deviceId) => midiControllerRef.current?.setSelectedDeviceId(deviceId)}
        onToggleLocalSound={setMidiLocalSound}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
