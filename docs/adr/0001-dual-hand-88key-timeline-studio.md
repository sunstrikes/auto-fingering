---
status: accepted
---

# Top-Bottom Scrolling Score, Unified 88-Key Piano, and Continuous Dual-Hand Simulation

## Context

The studio previously used a side-by-side workspace (`ScoreViewer` + permanent right-hand `InspectorPanel`) above two cropped, stacked per-hand keyboard strips (`DualTrackKeyboard`). Reviewing fingerings while practicing or following audio playback forced eye jumps across three disconnected zones and concealed where both hands actually sat on a real piano.

## Decision

We adopt a full-viewport top-bottom rehearsal layout:

1. **Scrolling Ribbon Top Pane with Inline Popover (`InspectorPanel` removed):** The score renders as a single continuous horizontal staffline by default (with a toggle to multi-system page layout) and smoothly tracks playback. Editing `1–5` finger anchors moves into an inline popover anchored to the clicked note, while warning navigation (`<` `>`), measure risk ticks (horizontal strip in ribbon mode, vertical gutter in page mode), and optional diff summaries move into a compact header/status strip.
2. **Unified 88-Key Physical Keyboard (`A0–C8`):** Both hands share a single full-width 88-key keyboard instead of cropped dual strips, distinguishing Left Hand (indigo) and Right Hand (teal) via key highlights, split diagonal overlap fills, dual overhead `Hand Position` / `Transition Cue` lanes, and click-to-audition keys.
3. **Continuous `Hand Posture` Dual-Hand Kinematics:** Playback emits continuous `scoreSec` animation frames to drive 2D translucent top-down SVG hands (palm/wrist + 5 fingers) with ~35ms attack/release strikes, pinned `Held Finger`s, ~150ms anticipatory phrase-shift easing, and thumb-under / cross-over layering—distinct from the solver's static phrase-level `Hand Position`.

## Consequences

- Horizontal ribbon rendering gives single-line visual sightreading directly aligned above the 88-key keyboard, requiring manual-scroll detection with a quick recenter control when users inspect ahead mid-playback.
- Removing the permanent sidebar increases score width and relies on accessible note popovers and keyboard shortcuts (`1–5`) rather than an always-open inspector pane.
- Existing solver (`src/solver/`), MusicXML round-trip (`src/musicxml/`), and Web Worker contracts remain unchanged because `Hand Posture` is derived strictly as a read-only projection over `ScoreDocument` + `SolveResult` + continuous playback time.
