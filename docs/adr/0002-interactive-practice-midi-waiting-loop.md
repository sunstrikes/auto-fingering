---
status: accepted
---

# Interactive Practice Studio: Metronome, Web MIDI, Tempo Scaling, Waiting Mode, and Whole-Measure A-B Loop

## Context

Following [ADR 0001](./0001-dual-hand-88key-timeline-studio.md), the application provides a top-bottom scrolling score, an 88-key physical keyboard, and continuous dual-hand posture simulation, alongside basic audition playback at discrete speeds (`0.5x`, `0.75x`, `1.0x`, `1.25x`). However, `SPEC.md` originally excluded real-instrument practice workflows (`Waiting Mode`, `A-B Loop`, `Web MIDI`), `ScoreDocument` discarded parsed time signatures, measure boundaries, and tempo change points, and `OnsetSlice` remained strictly single-handed—making cross-hand chord waiting impossible without a dedicated rehearsal step model.

Inspired by the rehearsal ergonomics of `https://piano.cishoon.top` while preserving lossless MusicXML fingering editing and solver determinism, we expand the tool from a pure fingering editor into an interactive fingering and piano practice studio.

## Decision

1. **Unified `Practice Mode` Selector (Instead of Separate Mute/Hide Toggles):**
   - Replace per-hand mute + hide combinations with a single three-way `Practice Mode`: `Both Hands` (`both`), `Right Hand Only` (`rh-only`, left hand plays as browser accompaniment), and `Left Hand Only` (`lh-only`, right hand plays as browser accompaniment). Single-staff scores automatically lock to their assigned hand.
   - Keyboard visuals keep full target cues on the active practice hand(s) and dim accompaniment-hand cues without mutating the underlying MusicXML score or exported `<fingering>` tags.

2. **Proportional `Speed Multiplier` with Solver Isolation:**
   - Playback speed supports quick presets (`0.25x`, `0.5x`, `0.6x`, `0.75x`, `0.9x`, `1.0x`, `1.25x`, `1.5x`), `-` / `+` fine steppers, and direct target BPM entry (`♩=BPM`).
   - Entering a target BPM computes a global `Speed Multiplier = targetBpm / baseBpm` that proportionally scales every `<sound tempo>` segment in the score, preserving mid-piece ritardandos/tempo shifts.
   - The fingering solver (`src/solver/`) always uses the score's native `onsetSec` so slowing down for practice never causes fingerings to jump.

3. **Explicit `Measure Timeline` & Dedicated Web Audio Metronome with `Count-In`:**
   - Extend `ScoreDocument` (via `src/musicxml/parser.ts`) to retain `ticksPerQuarter`, `tempoPoints`, `timeSignaturePoints`, and `measureTimelines` (`startTick`, `endTick`, `startSec`, `endSec`, `timeBeats`, `timeBeatType`, `isPickup`).
   - Synthesize metronome accent/sub-beat clicks on dedicated Web Audio gain/oscillator nodes isolated from `PianoAudioEngine.stopAll()` so note cutoffs never silence clicks.
   - Support an independent metronome toggle and an optional 1-measure `Count-In` before playback starts. When `Waiting Mode` stalls waiting for user input, the metronome pauses rather than ticking against the learner.

4. **Hot-Plug Web MIDI Input (`src/midi/`) with Local Echo Toggle & Software Fallback:**
   - Use the browser Web MIDI API (`navigator.requestMIDIAccess()`) with hot-plug `onstatechange` listeners, defaulting to merging all connected MIDI inputs (with a port selector to pin a single device) and clear graceful degradation on unsupported browsers (e.g., Safari or non-HTTPS contexts).
   - Provide a `MIDI Local Sound` (`midiLocalSound`) toggle: off by default when `Waiting Mode` is active so a digital piano's own speakers sound without doubling, and toggleable on for silent MIDI controllers.
   - Allow clicking the on-screen 88-key keyboard or mapped computer keyboard keys to emit synthetic `NoteOn`/`NoteOff` events for hardware-free practice and testing.

5. **Cross-Hand `Practice Step` & Cumulative `Waiting Mode`:**
   - Derive an ordered sequence of `Practice Step`s by grouping active-hand `OnsetSlice`s sharing `(onsetTick, isGrace, graceOrder)`, omitting `Tie Continuation`s (`isTieStop`).
   - `Waiting Mode` uses **cumulative hit matching**: notes in a chord/step may arrive rolled (`NoteOn` marks each expected MIDI pitch as hit until the step completes); repeated identical pitches require a fresh `NoteOn` so held keys cannot bleed through; wrong pitches flash red on the 88-key keyboard without clearing already-hit notes; pressing the current cursor's notes while paused starts Waiting Mode playback from that position.
   - `Grace Note`s wait sequentially before their main beat by default, with a setting (`skipGraceInWaitingMode`) to auto-advance over them.

6. **Whole-Measure `A-B Loop` & Transport/Practice Bar Layout:**
   - `A-B Loop` operates on a closed whole-measure range `[startMeasureIndex, endMeasureIndex]` (`0-based`, auto-normalized `A <= B`) with an optional `Loop Gap` (1-measure empty metronome bar between repetitions) and no automatic speed ramping.
   - Place a compact **Transport & Practice Bar** (measure/A-B ruler, Jump-to-Start, Play/Pause, speed presets + BPM editor, Metronome, Waiting Mode, A-B Loop) between the top score pane and the bottom 88-key keyboard, keeping the top header focused on file I/O, solver span/preferences, Undo/Redo, `Practice Mode`, and Settings/MIDI status.
   - Prevent click-target collisions: clicking a score note while `stopped` opens `NoteAnchorPopover` for fingering edits; clicking the score during active playback or `Waiting Mode` jumps the rehearsal cursor without popping up the fingering editor.

## Consequences

- `ScoreDocument` gains lightweight timeline metadata (`measureTimelines`, `tempoPoints`, `timeSignaturePoints`, `ticksPerQuarter`) without breaking Web Worker serialization (`src/workers/` still receives only `onsetSlices` + `HandSpanProfile`).
- All audio, MIDI, and timing state remains testable in Vitest via injected `AudioContext`, `MIDIAccess`, and synthetic `NoteOn`/`NoteOff` event providers.
- Clicking a note during `stopped` keeps the fast fingering-edit workflow intact while moving practice transport controls closer to the visual keyboard and measure ruler.
