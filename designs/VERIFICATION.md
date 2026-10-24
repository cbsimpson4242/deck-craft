# Foundation verification

The initial UI exploration was exercised in Chromium, not only generated.

- Five unique standalone HTML designs and five matching embedded documents.
- Comparison tested at 1440px desktop and 390px / 360px phone viewport widths; all selectors rendered their expected document, with no page-level horizontal overflow.
- All five compositions visually inspected at desktop and phone sizes.
- Embedded demo Play/Pause, pad toggles, collection search and Load A title updates exercised for each design. Searching `Low Orbit` returned one track; searching `Forma` returned two.
- Standalone Play, Sync, Cue reset and pitch label changes exercised for all five designs.
- Focus mode entered/exited; a downloaded standalone design matched its source bytes exactly.
- Inline JavaScript syntax, SVG XML, T3 icon configuration and exact embedded source bytes checked by `scripts/check_publication.py`.
- Files reviewed for credentials and private infrastructure details before initial publication; the pattern checker is not an exhaustive secret scanner.

## Limits

These checks prove prototype rendering and local UI state only. Sliders, EQ, pads and transport are not audio implementations. Load A updates the title only. No real music, waveform analysis, controller input, audio output, latency, actual client sidebar refresh or physical-device acceptance is claimed.
