# Progress

## Current milestone: shared-state application UI

The user approved retaining **all five Round 03 layouts** inside the actual app, then approved implementation of the application UI/layout system with audio work explicitly separate.

Implemented:

- Signal One, Signal Wide, Studio Grid, Studio Linear and Studio Sync as in-app layouts; Studio Sync default.
- One shared four-deck model, shared renderer components and delegated application event handlers. No iframe or separate document/application per layout.
- Layout changes preserve loaded demo tracks, positions, cues, loop state/length, pitch, Sync, monitor flags, gain/EQ/filter/level, crossfader, FX settings and collection state.
- Two-deck views retain C/D with a visible status strip, UI transport controls and quick four-deck access. Global mixer exposes all four decks.
- Versioned local persistence for device/browser choice and session settings. Restores paused. Malformed data recovers safely; write refusal preserves in-memory state and displays an unsaved warning.
- Dependency-free browser UI, module source entry point and reproducible offline single-file application build.

## Entry points

- `npm run build` produces `dist/deck-craft.html`; open it in a modern browser.
- `index.html` is the module-source entry point when served on loopback.
- README.md documents controls and limits; `docs/APPLICATION.md` maps the authorities.

## Verification

See `docs/APP-VERIFICATION.md`. Unit tests, bundled-script syntax, real Chromium transition/restart/persistence checks, responsive geometry and publication scanning were exercised. Historical design documents and selected references remain byte-identical.

## Scope boundary / next meaningful work

This milestone is the application UI foundation, **not** a playable DJ engine. All tracks/waveforms/art remain synthetic. UI Play does not produce audio or run a simulated audio clock. FX/mixer values are shared settings without processing. No personal music import, device/controller access, native package or network backend has been added.

Next product decision: audio engine/platform and the first real load → play → seek → mix vertical slice. That work has not been approved or implemented here. Do not keep iterating layouts as if the user still needs to select a single winner.

## Design history

Round 01 was rejected. Signal and Studio from Round 02 were selected for refinement. All five Round 03 refinements were accepted as selectable layouts. Preserve all rounds and reference hashes; they remain design evidence, not executable application owners.

Private runtime registration, local browser profiles and detailed operational receipts stay outside this public repository.
