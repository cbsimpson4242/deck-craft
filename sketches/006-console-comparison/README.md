# Precision / Performance visual comparison

Open `index.html` directly in a browser. It is self-contained and offline; no build or server is needed. A and B switch styling on the same mock session without resetting its state. Empty, Loaded and Playing intentionally reset that mock session.

Standalone entry points are also available at `../006-precision-console/index.html` and `../006-performance-console/index.html`.

Both show the same Studio Sync workspace, original synthetic track fixtures, command inventory and explicit no-audio labeling. Supported study interactions: theme switch, three preview states, collection search/filter, A/B/C/D loading, adding one synthetic source, paired waveform selection, mock play/pause/seek/cue and Shift-click cue storage, four levels, A/B crossfader and mixer dialog. DSP/routing/analysis placeholders stay disabled. No actual import, playback, decoding, analysis, native bridge or session persistence is involved. Mock playback never advances a simulated audio clock.

These are visual studies, not replacements for any of the five live layouts. Creating the studies did not change the application or authorize implementation; the later selection and application authorization are recorded below. The original approved stylesheet and every earlier design remain unchanged.

## Selected direction

The user selected **B — Performance console** after reviewing both examples, then separately authorized application implementation and deployment. Its darker surfaces, brighter deck identification, larger clocks and stronger transport controls are implemented in the shared application styles, not as an A/B hybrid or an iframe. All five layouts and the shared session are preserved. Deployment retained the newer installed import/library backend and changed only the bundled presentation. The standalone study files remain no-audio examples; actual installation/launch verification does not establish physical-audio acceptance.
