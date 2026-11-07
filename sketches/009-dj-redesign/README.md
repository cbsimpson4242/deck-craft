# DJ-software redesign proof

Open `index.html` directly in a browser. It is a self-contained, offline, synthetic visual proof of a ground-up redesign; it is not applied to the application, the native bridge or the session model.

## Direction

A new Perform workspace in the style of modern professional DJ software, designed without reference to the previous layouts, themes or deck face:

- **Waveform stack:** four full-width deck lanes with a zoomed, deck-tinted three-band waveform (lows, mids, highs), beat grid, cue flags, loop region, fixed playhead and a thin seekable overview.
- **Console:** a deck panel on each side (A/C and B/D, switchable) with jog-style platter and progress ring, transport, tempo fader and an eight-pad bank (cues or loop length); a central four-channel mixer with channel faders, meters and a crossfader.
- **Library:** crates, search (`/`), track table with Camelot key badges and one-click load A–D, and a detail pane.
- **Build:** a restyled component canvas (static illustration).
- **Themes:** Night (default), Ember and Studio from one token set. Deck identity colors and waveform glass stay fixed.

## Honesty

`APP-ACCURATE` (default on) dims everything the app cannot do today: EQ, filter, gain, channel cue, sync, loop in/out, roll, slicer and pads 5-8. Turning it off shows the full professional surface for design review only. Meters, motion, waveforms and tempo/key values are synthetic; local files show "analysis pending" instead of tempo. Play animates position in this preview only; there is no audio, native bridge or persistence.

Deep links for review: `#library`, `#build`, `#ember`, `#studio`, `#full` (comma-separated).
