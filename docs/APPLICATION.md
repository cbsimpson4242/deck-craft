# Application UI architecture

## One semantic session

`src/session.js` owns the four decks, mixer/FX settings and collection state as immutable transitions. Each deck keeps a known demo track ID, bounded position/cues, loop state, pitch, Sync, monitoring and mixer values. Selecting a layout changes only `state.layout`; it never constructs a fresh session or rewrites hidden decks.

This is **UI state**, not an audio-engine authority. There is no audio clock or DSP adapter disguised as a working engine. Adding audio later requires a separately designed real-time authority and an actual playback/analysis/hardware evidence rail.

## One persistence owner

`src/store.js` reads/writes the versioned key `deck-craft.ui.v1`. Renderers never call storage. A gesture is reduced to one next snapshot, saved synchronously, then projected into the UI. Invalid actions are rejected; restored data is limited to known identifiers, bounded numbers and supported fields. Opening a saved session always pauses UI transport.

A failed write does not throw away the current session. It leaves state in memory and surfaces an unsaved warning. Corrupt state uses a safe recoverable default without clearing unrelated keys. This is local browser storage, not cloud sync, account data or a cross-window concurrent session manager. File-origin persistence varies by browser; use a stable served origin when that ownership matters.

## Shared components, independent compositions

- `catalog.js`: five stable layout IDs and twelve synthetic demo tracks.
- `components.js`: shared decks, cues, waveform fixtures, transport, mixer, collection and dialogs.
- `views.js`: the five accepted compositions using those same components and state.
- `main.js`: one store subscription and delegated real DOM event handlers. Layout/load changes mount a new composition; ordinary sliders/search/transport update the current view without replacing the active input element.
- Per-layout grid/detail/cue-disclosure options are transient presentation state, separate from the musical session.

Two-deck compositions do not delete or pause C/D. Their preserved status strip exposes their state and quick access. The four-channel mixer remains reachable in every view. The portable application does not contain iframes, prototype HTML documents, model-specific engines or third-party runtime dependencies.

## Visual baseline

`src/approved.css` is copied in full from the approved Round 03 visual system by `scripts/sync-approved-css.mjs`. A hash regression rejects accidental truncation. Historical design files remain unchanged. Application-specific selectors, the layout picker, preserved-deck strip and no-audio notices live in `src/app.css`.

## Build and safety

`index.html` loads native ES modules when served locally. `scripts/build.mjs` composes these known modules and styles into `dist/deck-craft.html`. The bundle has a restrictive offline content policy: no network connections, external resources, form submissions or base-URL overrides. User-visible text is escaped; the collection is synthetic. No install or dependency download is necessary.

Generated builds are ignored by Git. Publication checks audit Git's intended source set, not local caches or browser profiles. Browser tests launch and remove a task-owned Chromium profile and close only that owned process. They do not touch personal browser sessions, T3 services or other projects.
