# Performance Console

## Design stance
A higher-contrast instrument panel with stronger deck landmarks and larger transport controls.

## Key choices
- Layout: the same Studio Sync composition and synthetic session in both studies, not a replacement layout.
- Typography: system sans and tabular monospace; performance emphasizes clocks and track titles.
- Color: charcoal with consistent A/B/C/D accents; performance uses greater contrast and saturation.
- Interaction: preview presets; theme switching without resetting the session; A/B and C/D waveform pairs; collection filters/search; four load targets; mock play/pause, seek, cue and Shift-click cue storage; shared mock channel levels and A/B crossfader; mixer drawer; add synthetic source.
- Unimplemented DSP, routing, sync, loops, analysis and meters remain disabled and labeled. No audio, native bridge, files, external resources or persistence are used.

## Trade-offs
- Strong at: Fast recognition of deck identity, clocks and transport.
- Weak at: More visual intensity and competition between panels.

## Best for
Visual comparison before approving changes to the real application.

Open `index.html` directly in a browser. Both files are standalone and offline. Use the A/B buttons to compare without losing mock session state. A preset deliberately resets mock decks; switching the visual direction does not. Seek readouts settle on release; mock playback is a static presentation, not an audio clock. Real application capabilities and all five layouts remain untouched.
