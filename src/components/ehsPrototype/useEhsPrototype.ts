import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MetronomeBeatEvent } from "../../audio/metronome";
import type { PlaybackFrame, PlaybackState } from "../../audio/playbackEngine";
import type { PracticeStep, ScoreDocument } from "../../domain/types";
import type { MidiInputEvent } from "../../midi/webMidi";
import { createEhsAdaptiveController } from "./ehsAdaptiveEngine";
import {
  DEFAULT_EHS_CONFIG,
  isValidEhsVariant,
  type EhsConfig,
  type EhsExtractedGeometry,
  type EhsFrameSnapshot,
  type EhsPerfMetrics,
  type EhsVariantKey,
} from "./ehsPrototypeTypes";

export const IS_EHS_PROTOTYPE_ACTIVE = Boolean(
  import.meta.env.DEV && import.meta.env.MODE !== "test"
);

const EMPTY_GEOMETRY: EhsExtractedGeometry = {
  measures: [],
  systems: [],
  notes: [],
  containerWidth: 0,
  containerHeight: 0,
  extractMs: 0,
  extractedAt: 0,
};

const INITIAL_PERF: EhsPerfMetrics = {
  fps: 0,
  lastUpdateMs: 0,
  avgUpdateMs: 0,
  mutatedSvgNodes: 0,
};

function readVariantFromUrl(): { variant: EhsVariantKey; explicitInUrl: boolean } {
  if (typeof window === "undefined") {
    return { variant: "A", explicitInUrl: false };
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("variant");
  if (isValidEhsVariant(raw)) {
    return { variant: raw, explicitInUrl: true };
  }
  return { variant: "A", explicitInUrl: false };
}

function writeVariantToUrl(next: EhsVariantKey): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", next);
    window.history.replaceState(null, "", url.toString());
  } catch {
    // ignore restricted history environments
  }
}

export interface UseEhsPrototypeParams {
  scoreDoc: ScoreDocument | null;
  playbackState: PlaybackState;
  playbackFrame: PlaybackFrame | null;
  playbackSpeed: number;
  waitingModeEnabled: boolean;
  activeMetronomeBeat: MetronomeBeatEvent | null;
  practiceSteps: PracticeStep[];
  selectedMeasureIndex: number | null;
}

export function useEhsPrototype({
  scoreDoc,
  playbackState,
  playbackFrame,
  playbackSpeed,
  waitingModeEnabled,
  activeMetronomeBeat,
  practiceSteps,
  selectedMeasureIndex,
}: UseEhsPrototypeParams) {
  const initialUrl = useMemo(() => readVariantFromUrl(), []);
  const [variant, setVariantState] = useState<EhsVariantKey>(initialUrl.variant);
  const [config, setConfig] = useState<EhsConfig>(DEFAULT_EHS_CONFIG);
  const [geometry, setGeometry] = useState<EhsExtractedGeometry>(EMPTY_GEOMETRY);
  const [perf, setPerf] = useState<EhsPerfMetrics>(INITIAL_PERF);
  const [previewScoreSec, setPreviewScoreSec] = useState<number>(0);
  const [tickVersion, setTickVersion] = useState<number>(0);

  const controllerRef = useRef(createEhsAdaptiveController());
  const configRef = useRef(config);
  configRef.current = config;
  const hasMidiInBoutRef = useRef(false);
  const prevPlaybackStateRef = useRef<PlaybackState>("stopped");

  const setVariant = useCallback((next: EhsVariantKey) => {
    setVariantState(next);
    writeVariantToUrl(next);
  }, []);

  const updateConfig = useCallback((patch: Partial<EhsConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  // Total duration for static preview scrubber
  const totalScoreSec = useMemo(() => {
    if (!scoreDoc || scoreDoc.measureTimelines.length === 0) return 0;
    return scoreDoc.measureTimelines[scoreDoc.measureTimelines.length - 1].endSec;
  }, [scoreDoc]);

  const prevSelectedMeasureRef = useRef<number | null>(null);

  // Pick a clear opening preview beat (Measure 2 Beat 1) whenever a new score loads
  useEffect(() => {
    if (!IS_EHS_PROTOTYPE_ACTIVE) return;
    if (!scoreDoc || scoreDoc.measureTimelines.length === 0) {
      setPreviewScoreSec(0);
      setGeometry(EMPTY_GEOMETRY);
      prevSelectedMeasureRef.current = null;
      return;
    }
    const previewMeasure =
      scoreDoc.measureTimelines[Math.min(1, scoreDoc.measureTimelines.length - 1)];
    setPreviewScoreSec(previewMeasure ? previewMeasure.startSec : 0);
    prevSelectedMeasureRef.current = selectedMeasureIndex;
    controllerRef.current.resetForBout(0);
    hasMidiInBoutRef.current = false;
  }, [scoreDoc]);

  // Keep preview scrubber synced only when the user actively selects a different measure while stopped
  useEffect(() => {
    if (!IS_EHS_PROTOTYPE_ACTIVE || playbackState === "playing" || !scoreDoc) return;
    if (selectedMeasureIndex === null || selectedMeasureIndex === prevSelectedMeasureRef.current) {
      return;
    }
    prevSelectedMeasureRef.current = selectedMeasureIndex;
    const tl = scoreDoc.measureTimelines[selectedMeasureIndex];
    if (tl) {
      setPreviewScoreSec(tl.startSec);
    }
  }, [selectedMeasureIndex, playbackState, scoreDoc]);

  // Reset bout adaptive metrics whenever continuous playback starts fresh
  useEffect(() => {
    if (!IS_EHS_PROTOTYPE_ACTIVE) return;
    const prev = prevPlaybackStateRef.current;
    prevPlaybackStateRef.current = playbackState;
    if (playbackState === "playing" && prev !== "playing") {
      const startSec = playbackFrame?.scoreSec ?? previewScoreSec ?? 0;
      controllerRef.current.resetForBout(startSec);
      hasMidiInBoutRef.current = false;
      setTickVersion((v) => v + 1);
    }
  }, [playbackState, playbackFrame?.scoreSec, previewScoreSec]);

  const isPlaying = playbackState === "playing";
  const effectiveScoreSec = isPlaying
    ? (playbackFrame?.scoreSec ?? previewScoreSec)
    : previewScoreSec;

  const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
  const snapshot: EhsFrameSnapshot = useMemo(() => {
    // tickVersion intentionally read to force re-evaluation on peek countdown/simulation events
    void tickVersion;
    return controllerRef.current.tick({
      nowMs,
      scoreDoc,
      scoreSec: effectiveScoreSec,
      isPlaying,
      speedMultiplier: playbackSpeed,
      activeMetronomeBeat,
      practiceSteps,
      config,
      hasReceivedMidiInBout: hasMidiInBoutRef.current,
    });
  }, [
    tickVersion,
    scoreDoc,
    effectiveScoreSec,
    isPlaying,
    playbackSpeed,
    activeMetronomeBeat,
    practiceSteps,
    config,
  ]);

  // Keep flash peek countdown ticking even when playback is paused/stopped
  useEffect(() => {
    if (!IS_EHS_PROTOTYPE_ACTIVE || !snapshot.peek.active || snapshot.peek.holding) return;
    const id = window.setInterval(() => {
      setTickVersion((v) => v + 1);
    }, 80);
    return () => window.clearInterval(id);
  }, [snapshot.peek.active, snapshot.peek.holding]);

  // Keyboard `F` peek shortcut (honoring ADR-0004/0008, no QWERTY MIDI collision)
  useEffect(() => {
    if (!IS_EHS_PROTOTYPE_ACTIVE) return;
    const isEditable = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const t = el.tagName;
      return t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || el.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (isEditable(e.target)) return;
      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        controllerRef.current.triggerPeek(
          "f-key",
          configRef.current,
          typeof performance !== "undefined" ? performance.now() : Date.now()
        );
        setTickVersion((v) => v + 1);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "f") {
        controllerRef.current.releaseHoldPeek(
          typeof performance !== "undefined" ? performance.now() : Date.now()
        );
        setTickVersion((v) => v + 1);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // Process MIDI events from real 88-key digital piano (B0 peek + continuous hesitation tracking)
  const scoreSecRef = useRef(effectiveScoreSec);
  scoreSecRef.current = effectiveScoreSec;
  const speedRef = useRef(playbackSpeed);
  speedRef.current = playbackSpeed;
  const stepsRef = useRef(practiceSteps);
  stepsRef.current = practiceSteps;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const waitingRef = useRef(waitingModeEnabled);
  waitingRef.current = waitingModeEnabled;
  const handMeasureRef = useRef(snapshot.handMeasureIndex);
  handMeasureRef.current = snapshot.handMeasureIndex;

  const handleMidiEvent = useCallback((event: MidiInputEvent) => {
    if (!IS_EHS_PROTOTYPE_ACTIVE) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();

    // B0 (MIDI 23) permanent peek guarantee (auto-guarded if piece expects MIDI 23 nearby)
    if ((event.type === "noteon" || event.type === "noteoff") && event.midi === 23) {
      const m = handMeasureRef.current;
      const expectsB0Nearby = stepsRef.current.some(
        (s) => Math.abs(s.measureIndex - m) <= 1 && s.expectedMidis.includes(23)
      );
      if (!expectsB0Nearby) {
        if (event.type === "noteon") {
          controllerRef.current.triggerPeek("b0-key", configRef.current, now);
        } else {
          controllerRef.current.releaseHoldPeek(now);
        }
        setTickVersion((v) => v + 1);
        return;
      }
    }

    if (event.type === "noteon" && isPlayingRef.current && !waitingRef.current) {
      hasMidiInBoutRef.current = true;
      controllerRef.current.recordMidiNoteOn({
        midi: event.midi,
        nowMs: now,
        scoreSec: scoreSecRef.current,
        speedMultiplier: speedRef.current,
        practiceSteps: stepsRef.current,
        config: configRef.current,
      });
      setTickVersion((v) => v + 1);
    }
  }, []);

  const triggerTouchPeekDown = useCallback(() => {
    controllerRef.current.triggerPeek(
      "touch",
      configRef.current,
      typeof performance !== "undefined" ? performance.now() : Date.now()
    );
    setTickVersion((v) => v + 1);
  }, []);

  const triggerTouchPeekUp = useCallback(() => {
    controllerRef.current.releaseHoldPeek(
      typeof performance !== "undefined" ? performance.now() : Date.now()
    );
    setTickVersion((v) => v + 1);
  }, []);

  const simulateStall = useCallback(() => {
    controllerRef.current.simulateStall(
      configRef.current,
      typeof performance !== "undefined" ? performance.now() : Date.now(),
      handMeasureRef.current
    );
    setTickVersion((v) => v + 1);
  }, []);

  const simulateFluent = useCallback(() => {
    controllerRef.current.simulateFluentStep(
      typeof performance !== "undefined" ? performance.now() : Date.now()
    );
    setTickVersion((v) => v + 1);
  }, []);

  return {
    isActive: IS_EHS_PROTOTYPE_ACTIVE,
    explicitInUrl: initialUrl.explicitInUrl,
    variant,
    setVariant,
    config,
    updateConfig,
    geometry,
    setGeometry,
    perf,
    setPerf,
    snapshot,
    totalScoreSec,
    previewScoreSec,
    setPreviewScoreSec,
    handleMidiEvent,
    triggerTouchPeekDown,
    triggerTouchPeekUp,
    simulateStall,
    simulateFluent,
  };
}
