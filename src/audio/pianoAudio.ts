export type AudioEngineStatus = "idle" | "loading" | "samples" | "synth";

export type PianoTimbreId =
  | "ep-fluid-ep1"
  | "ep-musyng-ep1"
  | "ep-fluid-ep2"
  | "ep-cp80"
  | "ep-wurlitzer"
  | "ep-tx81z"
  | "grand-splendid";

export interface PianoTimbrePreset {
  id: PianoTimbreId;
  label: string;
  shortLabel: string;
  kind: "electric" | "acoustic";
  source: "soundfont" | "electric-piano" | "splendid-grand";
  kit?: "FluidR3_GM" | "MusyngKite";
  instrument?: string;
}

export const DEFAULT_PIANO_TIMBRE: PianoTimbreId = "grand-splendid";

export const PIANO_TIMBRE_PRESETS: readonly PianoTimbrePreset[] = [
  {
    id: "grand-splendid",
    label: "原声三角钢琴 (Splendid Grand)",
    shortLabel: "Splendid 三角钢",
    kind: "acoustic",
    source: "splendid-grand",
  },
  {
    id: "ep-fluid-ep1",
    label: "电钢琴 1 · Rhodes (FluidR3_GM)",
    shortLabel: "FluidR3 电钢 1",
    kind: "electric",
    source: "soundfont",
    kit: "FluidR3_GM",
    instrument: "electric_piano_1",
  },
  {
    id: "ep-musyng-ep1",
    label: "电钢琴 1 · Rhodes (MusyngKite)",
    shortLabel: "MusyngKite 电钢 1",
    kind: "electric",
    source: "soundfont",
    kit: "MusyngKite",
    instrument: "electric_piano_1",
  },
  {
    id: "ep-fluid-ep2",
    label: "电钢琴 2 · FM / 合唱电钢 (FluidR3_GM)",
    shortLabel: "FluidR3 电钢 2",
    kind: "electric",
    source: "soundfont",
    kit: "FluidR3_GM",
    instrument: "electric_piano_2",
  },
  {
    id: "ep-cp80",
    label: "Yamaha CP-80 舞台电钢 (SFZ 采样)",
    shortLabel: "Yamaha CP-80",
    kind: "electric",
    source: "electric-piano",
    instrument: "CP80",
  },
  {
    id: "ep-wurlitzer",
    label: "Wurlitzer EP200 复古电钢 (SFZ 采样)",
    shortLabel: "Wurlitzer EP200",
    kind: "electric",
    source: "electric-piano",
    instrument: "WurlitzerEP200",
  },
  {
    id: "ep-tx81z",
    label: "Yamaha TX81Z FM 电钢 (SFZ 采样)",
    shortLabel: "Yamaha TX81Z",
    kind: "electric",
    source: "electric-piano",
    instrument: "TX81Z",
  },
] as const;

export function isValidPianoTimbreId(value: unknown): value is PianoTimbreId {
  return typeof value === "string" && PIANO_TIMBRE_PRESETS.some((p) => p.id === value);
}

export function getPianoTimbrePreset(id: PianoTimbreId): PianoTimbrePreset {
  return PIANO_TIMBRE_PRESETS.find((p) => p.id === id) ?? PIANO_TIMBRE_PRESETS[0];
}

export interface TriggerNoteParams {
  midi: number;
  time: number;
  duration: number;
  velocity?: number;
}

export interface SmplrPianoLike {
  load?: Promise<unknown>;
  ready?: Promise<unknown>;
  scheduler?: { stop?: () => void };
  start(event: { note: number; time?: number; duration?: number; velocity?: number }): unknown;
  stop(target?: unknown): void;
  disconnect?(): void;
}

export interface PianoAudioEngine {
  getStatus(): AudioEngineStatus;
  getTimbre(): PianoTimbreId;
  setTimbre(timbre: PianoTimbreId): Promise<"samples" | "synth"> | null;
  getAudioContext(): AudioContext;
  prepare(): Promise<"samples" | "synth">;
  triggerNote(params: TriggerNoteParams): void;
  stopAll(): void;
  dispose(): void;
}

export interface PianoAudioDeps {
  timbre?: PianoTimbreId;
  getAudioContext?: () => AudioContext;
  loadSmplrPiano?: (ctx: AudioContext, timbre: PianoTimbreId) => Promise<SmplrPianoLike>;
  onStatusChange?: (status: AudioEngineStatus) => void;
}

const LIGHTWEIGHT_PIANO_NOTES = [24, 36, 48, 60, 72, 84, 96];
export const SAMPLE_LOAD_TIMEOUT_MS = 20_000;

function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

interface ActiveSynthVoice {
  oscillators: OscillatorNode[];
  envelopeGain: GainNode;
  stopTime: number;
}

const HARMONICS: Array<{ ratio: number; type: OscillatorType; level: number }> = [
  { ratio: 1, type: "triangle", level: 0.72 },
  { ratio: 2, type: "sine", level: 0.24 },
  { ratio: 3, type: "sine", level: 0.1 },
];

/**
 * Pure Web Audio API harmonic-envelope piano synthesizer used as a zero-dependency
 * offline fallback when sample loading fails or is unavailable.
 */
function createSynthPiano(ctx: AudioContext) {
  const activeVoices = new Set<ActiveSynthVoice>();

  const pruneFinishedVoices = (now: number) => {
    for (const voice of activeVoices) {
      if (voice.stopTime <= now) {
        activeVoices.delete(voice);
      }
    }
  };

  return {
    triggerNote({ midi, time, duration, velocity = 88 }: TriggerNoteParams) {
      const startTime = Math.max(ctx.currentTime, time);
      pruneFinishedVoices(ctx.currentTime);

      const freq = midiToFrequency(midi);
      const safeDuration = Math.max(0.06, duration);
      const releaseSec = Math.min(0.35, Math.max(0.14, safeDuration * 0.35));
      const releaseStart = startTime + safeDuration;
      const stopTime = releaseStart + releaseSec;
      const peakGain = Math.min(0.28, Math.max(0.03, (velocity / 127) * 0.22));

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(Math.min(7200, Math.max(900, freq * 6)), startTime);
      filter.Q.value = 0.7;

      const envGain = ctx.createGain();
      envGain.gain.setValueAtTime(0.0001, startTime);
      envGain.gain.linearRampToValueAtTime(peakGain, startTime + 0.008);
      envGain.gain.exponentialRampToValueAtTime(
        Math.max(0.0005, peakGain * 0.38),
        startTime + Math.min(safeDuration, 0.18)
      );
      envGain.gain.setValueAtTime(Math.max(0.0005, peakGain * 0.38), releaseStart);
      envGain.gain.exponentialRampToValueAtTime(0.0001, stopTime);

      filter.connect(envGain);
      envGain.connect(ctx.destination);

      const oscillators: OscillatorNode[] = [];
      for (const h of HARMONICS) {
        const osc = ctx.createOscillator();
        osc.type = h.type;
        osc.frequency.setValueAtTime(freq * h.ratio, startTime);

        const partialGain = ctx.createGain();
        partialGain.gain.setValueAtTime(h.level, startTime);
        osc.connect(partialGain);
        partialGain.connect(filter);

        osc.start(startTime);
        osc.stop(stopTime + 0.01);
        oscillators.push(osc);
      }

      const voice: ActiveSynthVoice = {
        oscillators,
        envelopeGain: envGain,
        stopTime: stopTime + 0.02,
      };
      activeVoices.add(voice);
    },

    stopAll() {
      const now = ctx.currentTime;
      for (const voice of activeVoices) {
        try {
          voice.envelopeGain.gain.cancelScheduledValues(now);
          voice.envelopeGain.gain.setValueAtTime(0.0001, now);
        } catch {
          // ignore mocked or closed audio nodes
        }
        try {
          voice.envelopeGain.disconnect?.();
        } catch {
          // ignore mocked or closed audio nodes
        }
        for (const osc of voice.oscillators) {
          try {
            osc.stop(now + 0.01);
          } catch {
            // ignore already stopped oscillator
          }
        }
      }
      activeVoices.clear();
    },
  };
}

type SmplrStorage = import("smplr").Storage;

let sharedSmplrStorage: SmplrStorage | null = null;

async function getSmplrStorage(): Promise<SmplrStorage> {
  if (sharedSmplrStorage) return sharedSmplrStorage;
  const { CacheStorage, HttpStorage } = await import("smplr");
  if (typeof window !== "undefined" && "caches" in window) {
    try {
      sharedSmplrStorage = new CacheStorage("auto-fingering-smplr");
      return sharedSmplrStorage;
    } catch {
      sharedSmplrStorage = HttpStorage;
      return sharedSmplrStorage;
    }
  }
  sharedSmplrStorage = HttpStorage;
  return sharedSmplrStorage;
}

export async function defaultLoadSmplrPiano(
  ctx: AudioContext,
  timbre: PianoTimbreId = DEFAULT_PIANO_TIMBRE
): Promise<SmplrPianoLike> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new Error("Browser is offline.");
  }

  const preset = getPianoTimbrePreset(timbre);
  const storage = await getSmplrStorage();
  let piano: SmplrPianoLike;

  if (preset.source === "soundfont") {
    const { Soundfont } = await import("smplr");
    piano = new Soundfont(ctx, {
      kit: preset.kit ?? "FluidR3_GM",
      instrument: preset.instrument ?? "electric_piano_1",
      storage,
    });
  } else if (preset.source === "electric-piano") {
    const { ElectricPiano } = await import("smplr");
    piano = new ElectricPiano(ctx, {
      instrument: preset.instrument ?? "CP80",
      storage,
    });
  } else {
    const { SplendidGrandPiano } = await import("smplr");
    piano = new SplendidGrandPiano(ctx, {
      notesToLoad: {
        notes: LIGHTWEIGHT_PIANO_NOTES,
        fallback: "nearest",
      },
      decayTime: 0.4,
      storage,
    });
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      piano.ready ?? piano.load ?? Promise.resolve(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Sample load timeout")),
          SAMPLE_LOAD_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
  return piano;
}

function createBrowserAudioContext(): AudioContext {
  const AudioCtx =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("Web Audio API AudioContext is unavailable in this environment.");
  }
  return new AudioCtx();
}

/**
 * Creates a lazy-loading piano audio engine that defers all sample fetching until
 * `prepare()` is invoked and seamlessly falls back to a built-in Web Audio harmonic
 * synthesizer if sample loading fails or the browser is offline.
 */
export function createPianoAudioEngine(deps?: PianoAudioDeps): PianoAudioEngine {
  let status: AudioEngineStatus = "idle";
  let currentTimbre: PianoTimbreId =
    deps?.timbre && isValidPianoTimbreId(deps.timbre) ? deps.timbre : DEFAULT_PIANO_TIMBRE;
  let audioCtx: AudioContext | null = null;
  let smplrPiano: SmplrPianoLike | null = null;
  let synthPiano: ReturnType<typeof createSynthPiano> | null = null;
  let preparePromise: Promise<"samples" | "synth"> | null = null;
  let loadToken = 0;

  interface TrackedSmplrStop {
    stop: () => void;
    endTime: number;
  }
  const activeSmplrStops = new Set<TrackedSmplrStop>();

  const pruneSmplrStops = (now: number) => {
    for (const entry of activeSmplrStops) {
      if (entry.endTime <= now) {
        activeSmplrStops.delete(entry);
      }
    }
  };

  const stopSmplrVoices = () => {
    // smplr.stop() only stops already-dispatched voices and leaves future notes queued in scheduler
    smplrPiano?.scheduler?.stop?.();
    for (const entry of activeSmplrStops) {
      try {
        entry.stop();
      } catch {
        // ignore already stopped or disposed note handle
      }
    }
    activeSmplrStops.clear();
    smplrPiano?.stop();
  };

  const disposeSmplrInstance = () => {
    stopSmplrVoices();
    try {
      smplrPiano?.disconnect?.();
    } catch {
      // ignore disconnect failures on mocked or closed instances
    }
    smplrPiano = null;
  };

  const setStatus = (next: AudioEngineStatus) => {
    if (status !== next) {
      status = next;
      deps?.onStatusChange?.(next);
    }
  };

  const ensureAudioContext = (): AudioContext => {
    if (!audioCtx) {
      audioCtx = deps?.getAudioContext ? deps.getAudioContext() : createBrowserAudioContext();
    }
    return audioCtx;
  };

  const ensureSynth = (): ReturnType<typeof createSynthPiano> => {
    if (!synthPiano) {
      synthPiano = createSynthPiano(ensureAudioContext());
    }
    return synthPiano;
  };

  const resumeContextIfNeeded = async (ctx: AudioContext): Promise<void> => {
    const ctxState = ctx.state as string;
    if ((ctxState === "suspended" || ctxState === "interrupted") && typeof ctx.resume === "function") {
      try {
        await ctx.resume();
      } catch {
        // proceed even if resume is restricted in tests or autoplay-blocked environments
      }
    }
  };

  const prepare = async (): Promise<"samples" | "synth"> => {
    if (status === "samples" && smplrPiano) {
      await resumeContextIfNeeded(ensureAudioContext());
      return "samples";
    }
    if (status === "synth") {
      await resumeContextIfNeeded(ensureAudioContext());
      return "synth";
    }
    if (preparePromise) return preparePromise;

    const myToken = ++loadToken;
    const targetTimbre = currentTimbre;

    preparePromise = (async () => {
      const ctx = ensureAudioContext();
      await resumeContextIfNeeded(ctx);
      if (myToken !== loadToken) {
        return status === "samples" ? "samples" : "synth";
      }
      setStatus("loading");
      try {
        const loader = deps?.loadSmplrPiano ?? defaultLoadSmplrPiano;
        const piano = await loader(ctx, targetTimbre);
        if (myToken !== loadToken) {
          piano.disconnect?.();
          return status === "samples" ? "samples" : "synth";
        }
        if (piano.ready) {
          await piano.ready;
        } else if (piano.load) {
          await piano.load;
        }
        if (myToken !== loadToken) {
          piano.disconnect?.();
          return status === "samples" ? "samples" : "synth";
        }
        smplrPiano = piano;
        setStatus("samples");
        return "samples" as const;
      } catch {
        if (myToken !== loadToken) {
          return status === "samples" ? "samples" : "synth";
        }
        smplrPiano = null;
        ensureSynth();
        setStatus("synth");
        return "synth" as const;
      }
    })();

    return preparePromise;
  };

  return {
    getStatus: () => status,
    getTimbre: () => currentTimbre,

    setTimbre(timbre: PianoTimbreId) {
      const nextTimbre = isValidPianoTimbreId(timbre) ? timbre : DEFAULT_PIANO_TIMBRE;
      if (currentTimbre === nextTimbre && status !== "synth") {
        return status === "idle" ? null : prepare();
      }
      const shouldReload = status !== "idle";
      currentTimbre = nextTimbre;
      loadToken += 1;
      preparePromise = null;
      disposeSmplrInstance();
      synthPiano?.stopAll();

      if (!shouldReload) {
        return null;
      }
      status = "idle";
      return prepare();
    },

    getAudioContext: () => ensureAudioContext(),

    prepare,

    triggerNote(params: TriggerNoteParams) {
      if (status === "samples" && smplrPiano) {
        const ctx = ensureAudioContext();
        pruneSmplrStops(ctx.currentTime);
        const safeDuration = Math.max(0.05, params.duration);
        const stopHandle = smplrPiano.start({
          note: params.midi,
          time: params.time,
          duration: safeDuration,
          velocity: params.velocity ?? 88,
        });
        if (typeof stopHandle === "function") {
          activeSmplrStops.add({
            stop: stopHandle as () => void,
            endTime: Math.max(ctx.currentTime, params.time) + safeDuration + 1.0,
          });
        }
        return;
      }
      ensureSynth().triggerNote(params);
    },

    stopAll() {
      stopSmplrVoices();
      synthPiano?.stopAll();
    },

    dispose() {
      loadToken += 1;
      preparePromise = null;
      disposeSmplrInstance();
      synthPiano?.stopAll();
      synthPiano = null;
    },
  };
}
