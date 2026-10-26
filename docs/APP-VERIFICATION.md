# Application UI verification

## Performance console visual pass

- The selected B treatment is applied to the actual shared application, not an embedded study. All five layouts retain their existing controls and shared state. A/B/C/D accents remain consistent when switching views; colors identify decks, not analyzed frequency bands.
- **47 Node tests, six Rust tests and five installer tests passed.** The added deck-identity regression first rejected the previous layout-dependent palette. Existing native ownership, persistence, warning and authority regressions remain green.
- **UI build and bundled-script syntax passed.** The actual offline build was exercised in Chromium; no source-only style injection is part of the delivered build.
- **25 ordered transitions and 30 responsive cases passed.** Viewports: 1920×1080, 1440×900, 1366×768, 1280×720, 390×844 and 360×844. Assertions include the Performance palette, deck-contained transport/clocks/cues, no collection horizontal overflow, unclipped loading actions, layout picker and four-channel mixer access. Existing reload/restart, paused restore, hidden-deck, persistence and failure checks also passed.
- All five built layouts were visually inspected with synthetic fixtures. A narrow Linear transport defect and collection load-action clipping were corrected and retained in the browser geometry gate. Short windows may scroll vertically rather than compress or conceal deck controls.
- This is a presentation change. Native engine/bridge/session code is unchanged; native signal capture and real-output integration were not rerun for this pass. Browser fixture interactions are not native audio or target-machine installation/physical-output acceptance.

## Earlier UI foundation checks

- **12 Node tests passed.** They cover all ordered layout transitions against a four-deck fixture, immutability, saved preference/session restoration, paused startup, bounded/rejected inputs, cue editing, targeted track loading, malformed snapshots, storage refusal, single persistence ownership, shared renderer output, escaped search text and complete approved-stylesheet integrity.
- **Build and bundled-script syntax passed.** `npm run build` produced the portable app and `node --check dist/bundle-check.mjs` accepted its actual emitted script.
- **25 ordered transitions passed in real Chromium.** Seeded track C with a different track, position, cue, active UI transport/loop, changed deck pitch, EQ/level, crossfader, echo wet/enabled and collection query. All five-to-five switches preserved the exact shared snapshot and document identity. There were no iframes or reloads.
- **Hidden-deck workflow passed.** C's active UI transport state remained visible in two-deck views; quick access returned to Studio Sync with C/D selected without altering the musical snapshot.
- **Reload and full Chromium restart passed.** The selected layout, positions and settings survived. UI transport restored paused, never auto-started. Storage was read back through the actual local browser store.
- **20 responsive cases passed.** Five layouts at 1440, 1280, 390 and 360 CSS-pixel widths, with reachable layout pickers, the expected visible deck count, no page-level horizontal overflow, unclipped precise BPM readouts/expanded cue banks, and a usable four-channel mixer dialog.
- **Failure/safety paths passed.** HTML-like search remained inert after a layout remount; malformed persisted data recovered without clearing an unrelated key; blocked writes kept the chosen UI usable and showed an explicit unsaved warning. No runtime exceptions were observed by the automated browser rail.
- Desktop and phone compositions were visually inspected in the built application. An additional real pointer/keyboard pass selected Signal One using the native dropdown, toggled deck A's UI transport with a pointer, and selected Studio Sync using the native dropdown; transport state remained on.
- The publication checker covers all application JavaScript plus the existing fifteen historical studies and two unchanged reference payloads. It verifies their original bytes/hashes and conservative privacy patterns. Generated builds and private test evidence are excluded from publication.

## Test-first / corrective evidence

The initial layout test failed because the requested layout did not become active. Persistence tests then failed because no durable snapshot/warning was written; both passed after their real implementation. A stylesheet-integrity regression also rejected a truncated initial transfer before the complete approved CSS was copied and visually rechecked. These failed iterations are not presented as passing candidates. A later browser regression reproduced clipped Linear cue pads and a narrow BPM readout; correcting flex sizing and the numeric column width made the exact clipping checks pass at every tested viewport.

## Reproduce

Requires Node.js 22+ and Chromium for browser checks. No npm packages are needed.

```sh
npm test
npm run build
node --check dist/bundle-check.mjs
npm run test:browser
python3 scripts/check_publication.py
```

`DECKCRAFT_EVIDENCE_DIR` optionally stores browser screenshots and a structured report outside the public source. `CHROMIUM` selects the browser executable. The browser rail owns a disposable profile and closes it; it never uses personal browser state.

## Limits

This proves application UI/session/layout behavior, not playable DJ functionality. There is no audio output, waveform analysis, audio clock, DSP, real files, controller or hardware. Browser emulation is not physical-phone/native-app acceptance. Most automated controls activate the actual DOM handlers programmatically, with an additional native pointer/keyboard spot check; gestures and assistive technology are not exhaustively tested. Persistence is device/browser/origin-local, not authenticated or cross-window synchronization.
