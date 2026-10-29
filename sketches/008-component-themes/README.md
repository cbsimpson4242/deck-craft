# Component themes (design proof)

Offline, static and synthetic: no audio, storage, network or connection to the running app. Open `index.html` directly.

## Design stance
One shared token set; a theme changes only those tokens, so any component can use any theme and the page stays cohesive.

## What a theme changes (ten tokens)
Page background, panel, raised control, raised hover, inset well, border line, three text tones (primary, secondary, disabled/tertiary), the interface accent (selection, focus, toggles, brand mark) with its readable ink color, and shadow depth.

## Fixed in every theme
Lime Play button, blue cue markers, deck identity colors A/B/C/D, and the dark waveform glass with its red-to-violet palette. Corner radius, type scale and density are design constants, not options.

## Themes
Graphite (current look, default), Midnight, Ember, Orchid, Daylight. The page computes contrast per theme; every theme meets: primary text 7:1, secondary text 4.5:1, disabled text 3:1 on raised controls, accent 3:1 on panels, accent ink 4.5:1.

## Page contents
1. Rules for what themes may and may not change.
2. Every component (deck, mixer, collection browser, waveform, cue bank, crossfader, effects) in every theme.
3. A mixed canvas with a per-component theme selector, an app theme selector and "Apply to all components".

## Honest states shown
Unavailable controls (CUP, FLX, REV, loop IN/OUT, EQ/gain knobs, headphone routing, effects, sync, cue slots 5–8) remain disabled in every theme. A local file with no tempo shows "BPM — analysis pending" instead of the former empty lime box. Waveform color is a design palette over a synthetic fixture, not frequency analysis.

## Review aid
`#only-0` … `#only-4` shows one theme block; `#only-mixed` shows the mixed canvas.

## Not approved by this proof
Implementation, removal of free-styling fields, migration of saved canvases, creator-kit changes, and deployment.
