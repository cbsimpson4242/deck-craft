# Deck Craft handoff

Read README.md, PROGRESS.md, SECURITY.md and docs/NATIVE-DESKTOP.md first. Preserve original branding, synthetic fixtures and every historical design file. Never publish private machine/network/account/service details, music, local state or operational receipts.

## Approved direction

All five Round 03 layouts are interchangeable views of one shared four-deck session; Studio Sync is default. The latest approval adds an Omarchy-first native desktop foundation and actual local-file playback, pause and seek. Do not return to choosing a single winning layout or substitute a prototype iframe.

Native source, virtual output and controller-host desktop tests are not target-machine acceptance. Omarchy installation/Wayland/portal/physical output and latency must be verified on the actual target before claiming success there. Other platforms and professional parity remain future work.

## Source authorities

- `native/src/main.rs` owns native deck/transport acknowledgements, generations and source-clock state.
- `native/src/stream.rs` keeps file/decode/seek work off the device-facing PCM iterator using bounded SPSC buffers; retain off-callback resource retirement.
- `desktop/main.cjs`, `policy.cjs`, `preload.cjs` own the local bridge and native selection. Keep sandbox/context isolation, strict frame/command validation and no renderer Node or arbitrary-path API.
- `desktop/library.cjs` owns the private selected-file registry; paths never enter renderer metadata or public artifacts.
- `desktop/audio-client.cjs` owns the child, framing, native generation/sequence, watchdog, sanitized errors and operational-only environment.
- `src/native.js` connects real receipts to the shared UI and prevents stale/superseded playback actions. Never simulate an audio clock or automatically replay after failure/reconnect.
- `src/session.js` owns pure model transitions; `src/store.js` alone owns renderer snapshot persistence. Restore paused.
- `src/workspace.js` owns bounded component/workspace schemas, pure presentation transitions and the offline agent kit. `canvas-view.js` / `canvas-editor.js` render existing shared controls and edit design data only. `canvas.css` is builder-specific. Preserve separate workspace persistence and never turn component JSON into executable HTML/CSS/code or native command bindings.
- `src/components.js`, `views.js`, `main.js` share controls/layouts, not independent deck models.
- `src/approved.css` is the exact historical approved stylesheet. Keep it unchanged; app/native-specific adjustments belong in `app.css` and `native.css`, and builder-specific rules in `canvas.css`.

A layout action must not alter musical state, unload hidden C/D, restart audio or reload the document. Unimplemented DSP/routing/analysis stays disabled and clearly described. Do not label placeholders as real analysis or UI flags as audible output.

## Verification and publication

Run Node tests, Rust tests, installer tests, UI build/bundle syntax, browser regressions and publication checks. For changed native behavior, run actual signal capture and Electron/native integration with an explicit isolated sink; do not select physical output implicitly or run two suites against the same sink concurrently. The default desktop suite injects only OS file selection. The opt-in real GTK chooser is a separate platform lane; preserve known ambient-filesystem cleanup limitations rather than treating it as passed.

Review exact intended source before a public push. Build/package allowlists must exclude ignored audio, private libraries, browser profiles and logs. Generated packages belong in ignored release output, not source. Keep progress in project docs and detailed machine/process receipts outside public Git history.
