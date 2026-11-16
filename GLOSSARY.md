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
