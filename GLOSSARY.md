# MusicXML Auto-Fingering Tool

Domain glossary for a browser-based tool that automatically deduces piano `1–5` fingerings for MusicXML scores, previews hand positions, supports manual overrides, and exports standard `<fingering>` annotations compatible with `piano.cishoon.top`.

## Language

**Score Document**:
The parsed representation of an uploaded `.musicxml`, `.xml`, or `.mxl` file that preserves the original XML structure for lossless export.
_Avoid_: Sheet file, song data, XML blob

**Note Event**:
A single piano note extracted from a Score Document for fingering deduction, carrying pitch, onset time, duration, Hand Assignment, and tie state.
_Avoid_: Note, key press, pitch item

**Tie Continuation**:
A Note Event linked by a `tie stop` to an immediately preceding note of the same pitch, which sustains sound without requiring a new finger strike.
_Avoid_: Tied note, held note

**Onset Slice**:
All newly struck Note Events for the same hand starting at the exact same musical timestamp (or a zero-duration Grace Note group immediately preceding a beat), excluding Tie Continuations, played together as a single note, interval, or chord.
_Avoid_: Chord group, beat cluster, vertical slice

**Held Finger**:
A Finger Assignment from an earlier Onset Slice that remains physically occupied while its Note Event or Tie Continuation sustains across subsequent Onset Slices, making that finger unavailable until released.
_Avoid_: Occupied finger, locked finger, sustain finger

**Grace Note**:
A zero-duration ornamental Note Event placed immediately before a main Onset Slice that requires its own Finger Assignment without advancing the musical beat timeline.
_Avoid_: Appoggiatura, ornament note, cue note

**Hand Assignment**:
The attribution of a Note Event or Onset Slice to either the Left Hand or Right Hand derived from part, staff, clef, or cross-staff markup.
_Avoid_: Track, voice, channel

**Finger Anchor**:
A fixed `1–5` finger constraint attached to a Note Event—either preserved from an existing MusicXML `<fingering>` tag or pinned by a user edit in the preview UI.
_Avoid_: Fixed finger, pinned note, hint

**Finger Assignment**:
The `1–5` finger number (`1` = thumb, `5` = pinky) assigned to a Note Event by a Finger Anchor or the solver.
_Avoid_: Finger index, key label

**Hand Position**:
The five-key resting span `[thumbKey .. pinkyKey]` implied by a phrase's Finger Assignments, indicating where all five fingers hover over the keyboard.
_Avoid_: Finger window, zone, keyboard box

**Hand Posture**:
The instantaneous physical pose of one hand at a given score moment—comprising palm/wrist center, five individual finger key positions, active key-strike depths, Held Finger anchors, and cross-over or thumb-under offsets—derived from Hand Position and Transition Cues.
_Avoid_: Hand shape, fake hand, animation pose, hand shadow

**Transition Cue**:
A visual indicator marking a technique change or reach warning between consecutive Onset Slices, such as thumb-under, cross-over, wide stretch, or full position shift.
_Avoid_: Move hint, arrow warning

**Hand Span Profile**:
A user-selected physical reach preset (`S`, `M`, `L`) combined with preference flags that parameterize comfortable and maximum finger-pair distances in the solver.
_Avoid_: Hand size, difficulty level

**Measure Timeline**:
The parsed per-measure timing metadata in a Score Document—recording start/end ticks and seconds, active time signature (`beats`/`beat-type`), tempo points, and pickup-measure status—used to drive the metronome, count-in, and A-B Loop.
_Avoid_: Bar map, measure cache, beat array

**Speed Multiplier**:
A continuous scalar (`0.25x–1.5x`, adjustable via presets, steppers, or target BPM input) that proportionally scales all `<sound tempo>` playback speeds without altering the Score Document's native tempo used by the fingering solver.
_Avoid_: Tempo override, BPM clamp, playback pitch

**Studio Mode**:
The top-level workspace selector switching between `Free Studio` (score fingering editing, free audition, manual A-B Loop, and manual Waiting Mode) and `Guided Session` (evidence-based deliberate practice), orthogonal to `Practice Mode`.
_Avoid_: App mode, practice mode, coaching tab

**Guided Session**:
A time-boxed, single-piece deliberate practice session on the active Score Document that orchestrates chunk rotation, micro-rests, and delayed feedback without mutating the score's fingerings.
_Avoid_: Smart loop, AI autoplay, workout dashboard

**Practice Mode**:
The single active-hand practice selector (`Both Hands`, `Right Hand Only` with automatic left-hand accompaniment, or `Left Hand Only` with automatic right-hand accompaniment) governing Waiting Mode target filtering, keyboard emphasis, and browser accompaniment audio.
_Avoid_: Mute/hide flags, channel solo, hand filter

**Practice Step**:
A cross-hand synchronized rehearsal step merging all non-`Tie Continuation` Note Events for the active practice hand(s) that share the same `onsetTick` and grace-note ordering; Waiting Mode advances strictly one Practice Step at a time.
_Avoid_: Single-hand slice, beat chord, playback tick

**Waiting Mode**:
An interactive rehearsal state in which playback pauses at each Practice Step until all required MIDI pitches receive matching `NoteOn` events (accumulated across rolled/arpeggiated arrivals, ignoring `Tie Continuation`s, and flagging wrong notes in red on the 88-key keyboard).
_Avoid_: Follow mode, pause-on-note, auto-step

**Count-In**:
A one-measure pre-roll of metronome clicks played at the current tempo before playback or loop iteration begins (and optionally between A-B Loop repetitions as a Loop Gap).
_Avoid_: Lead-in beep, warmup ticks

**A-B Loop**:
A closed whole-measure range `[measureA, measureB]` (`0-based`) that repeats continuously during playback or Waiting Mode, optionally inserting a one-measure Count-In gap before each restart.
_Avoid_: Slice loop, phrase repeat, segment pin

**MIDI Input Device**:
An external digital piano or controller connected via Web MIDI API (with hot-plug detection and optional virtual keyboard/computer-keyboard fallback) supplying `NoteOn`/`NoteOff` events to Waiting Mode and optional browser synth echo.
_Avoid_: Hardware driver, USB instrument, audio input

**Piano Command Keys**:
Fixed extreme-register 88-key MIDI shortcuts (`A0`, `B0`, `C8` in non-playing windows, plus `A0 + A#0` to pause during active play) that trigger hands-free Guided Session controls without touching the screen.
_Avoid_: Hotkeys, pedal macros, MIDI shortcuts

**Micro-Rest**:
A brief, low-stimulation, hands-off consolidation interval (`10–15 s`) inserted automatically at the end of a practice bout with zero diagnostic data shown to prevent retroactive interference.
_Avoid_: Break screen, cooldown timer, pause modal

**Score Fingerprint**:
A deterministic content hash derived from a Score Document's normalized per-measure onset-and-pitch skeleton, remaining invariant across `<fingering>` edits, file container format, filename, tempo, and non-pitch layout or repair edits.
_Avoid_: File hash, XML MD5, song ID

**Piece Profile**:
The stable logical identity of a practiced piano work that anchors its cross-session progress, Finger Anchor drafts, and one or more linked Score Fingerprints across minor score repairs or revisions.
_Avoid_: Song entry, score record, file ID

**Practice Event**:
An immutable, append-only record of one completed Guided Session bout—capturing aggregated acoustic metrics, fluency outcomes, and timing metadata—that serves as the sole source of truth for spaced-repetition state and conflict-free multi-device merge.
_Avoid_: Telemetry row, practice log, raw MIDI dump

**Macro Section**:
A top-level formal musical section of a piece (typically 4–16 measures, bounded by structural barlines, key changes, or phrase-level novelty) used for whole-piece navigation, repetition leverage summaries, and unlocking cold-start retrieval zones.
_Avoid_: Chapter, Big Part, Form Block

**Motor Chunk**:
An atomic deliberate-practice unit of a piece (density-adapted to 1–4 measures, barline-aligned by default with optional anacrusis lead-in, and manually splittable or mergeable) that remains stable across Practice Modes and persists under a Piece Profile.
_Avoid_: Segment, Piece Slice, Practice Block

**Passage Cluster**:
A group of exact repeats or near-variant passages within a piece paired with a fingering-isomorphism motor-transfer estimate used to highlight high-leverage practice sections and warm-start repeated instances.
_Avoid_: Repeat Group, Pattern Family, Motif Bucket

**Chunk Junction**:
The high-load transition boundary between two adjacent Motor Chunks where fingering hazards, hand-position leaps, bimanual coupling, Switch Point interference, or empirical hesitations concentrate.
_Avoid_: Seam, Stitch Point, Cut Boundary

**Bridge Window**:
A Practice Step-level cross-boundary micro-practice span inside Guided Session (straddling the final 2–3 steps before and initial 2–3 steps after a fragile Chunk Junction) used for focused error-free bridging, strictly separate from Free Studio's whole-measure A-B Loop.
_Avoid_: Micro Loop, Mini A-B, Seam Slice

**Switch Point**:
The divergence point at the end of repeated instances within a Passage Cluster where identical material branches into different continuations, excluded from mastery transfer and prioritized for cold-start retrieval.
_Avoid_: Fork, Branch Note, Diverge Bar

**Performance Cue**:
A sparse hierarchical memory-retrieval landmark placed on the score (classified as Structural, Switch, Basic/Technical, or Expressive) that serves as a zero-run-up starting anchor for random cold-start retrieval probes.
_Avoid_: Bookmark, Pin, Memory Marker, Transition Cue

**Active Rotation Pool**:
The bounded working set of `Motor Chunk`s and active `Chunk Junction`s (typically 3–4, scaled 2–5 by cognitive load) rotated within a `Guided Session` under anti-interference spacing constraints.
_Avoid_: Practice Queue, Deck, Batch List

**Audiation Priming**:
A brief, non-blocking mental listening and `Hand Position` preparation prompt presented in the ready window after a `Micro-Rest` (paired with optional audio preview for unfamiliar chunks) before starting the next `Motor Chunk`.
_Avoid_: Visualization Timer, Forced Pause, Mental Drill

**Early Macro-Rest**:
A single skippable off-keyboard break (~2 min) offered after the opening interleaving rounds (~12–15 min) of longer `Guided Session`s (≥25 min) to amplify overnight motor consolidation.
_Avoid_: Mid-Session Timeout, Long Break, Intermission

**Motor-FSRS**:
The sleep-gated, pure deterministic spaced-repetition reducer over `Practice Event`s that computes cross-day difficulty, retrievability, and `Speed-Conditioned Stability` for `Motor Chunk`s and active `Chunk Junction`s.
_Avoid_: Anki Algorithm, Review Timer, Mastery Score

**Speed-Conditioned Stability**:
A unit's `Motor-FSRS` retention stability anchored to its current `stableSpeed` and `handStage`, which discounts whenever tempo or hands-together difficulty steps up so the new motor regime undergoes fresh overnight consolidation.
_Avoid_: Global Stability, Speed-Free Retention, Decay Rate

**Cold First-Pass Probe**:
The un-warmed first continuous-play attempt of a `Motor Chunk` or `Chunk Junction` after a sleep boundary, used to derive its automatic `Motor-FSRS` rating without warm-up retrieval inflation.
_Avoid_: Warmup Run, Best-of-Three Pass, Diagnostic Test

**Bounded Window Attribution**:
The post-bout lightweight MIDI-to-score matching step for steady-tempo continuous play that assigns `NoteOn` events to expected `Measure Timeline` onsets via asymmetric capture windows, entry-offset calibration, and limited local beat re-anchors without real-time Rubato score following.
_Avoid_: Rubato Alignment, HMM Follower, Live Scoring

**Fading Scaffolding**:
The four-tier progressive visual and rhythmic cue reduction ladder (`L0`–`L3`) derived from a `Motor Chunk`'s `Motor-FSRS` state, stepping down automatically on repeated faults while honoring instant `B0` fingering peek.
_Avoid_: Difficulty Setting, Blind Mode, Hint Toggle

**Acoustic Profile**:
The post-bout, hardware-invariant summary of observable Web MIDI performance dimensions (timing evenness, relative voicing, Goebl-compensated hand sync, non-pedal articulation, and adaptive `CC64` pedal clarity) surfaced as 2–3 status capsules without penalizing `Motor-FSRS` ratings.
_Avoid_: Performance Score, Grade Card, Audio Analysis

**External-Focus Coach**:
The closed-world coaching layer that translates local `Acoustic Profile` evidence into concise sound- and phrasing-oriented cues (banning internal body-mechanics directives), backed by offline templates and optional BYOK/Ollama Structured Outputs.
_Avoid_: AI Chatbot, Technique Critic, Fingering Tutor

**Eye-Hand Span Overlay**:
An opt-in dynamic lookahead masking mode for steady-tempo `Guided Session` continuous play (`L1+`) that progressively fades already-passed notes on the score while spotlighting upcoming beats ahead to train sight-reading lookahead without obstructing staves or barlines.
_Avoid_: Blind Score, Blur Curtain, Disappearing Mode
