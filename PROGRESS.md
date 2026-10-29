# Progress

## Current: approved reference deck face applied to every layout

The approved version-3 appearance is now the real deck component in Studio Sync, Studio Grid, Studio Linear, Signal One, Signal Wide and the custom canvas. It changes presentation only: the shared four-deck session, native bridge, persistence and layout switching are unchanged, and C/D remain preserved in two-deck views.

Implemented: compact deck header, scrolling detail waveform with a fixed playhead, cue flags, overview with played shading and start button, vertical tempo slider, transport with lime Play, Cue, disabled CUP/FLX/REV, loop-length presets (existing validated `loopLength`), disabled IN/OUT, an eight-position cue bank (slots 5–8 reserved and inert) and a disabled cue-editing strip. Local files render decoded PCM peaks with amplitude-only palette coloring; demo tracks use a labeled deterministic fixture; local tracks without peaks draw nothing. The canvas deck default height grows to 560 so the whole face fits; starter spacing follows.

Verified on the controller host: 75 Node tests (seven new deck-face regressions), six Rust tests, five installer tests, build and bundle syntax, 25 layout transitions and 30 responsive cases, the canvas suite, all 18 isolated native signal checks and the real Electron/native first-use, paused-restart and offline phases through a private null sink with a fixed ALSA PulseAudio plugin. No physical output, Omarchy portal or hardware latency was tested, and nothing has been installed or pushed. The previously installed target build is unchanged.

Deployment: the committed deck-face source (07a787f) was packaged as release 0.3.1-85a467bb109d and installed user-locally on the Omarchy target through the normal installer. All 186 installed payload files match the package manifest; the desktop bridge and native engine were already byte-identical to the previously installed release, so only the bundled UI changed. The previous release is retained for rollback and a private-state backup was taken first. The app was open and in use, so it was not closed: restart it to load the new release. Launch of the new release, physical output, portal behavior and latency on the target remain unverified.

## Approved visual proof: reference-matched deck and transport

**Appearance approved:** the user reviewed version 3 (`sketches/007-reference-deck/index.html`) and accepted its look. That approves the visual direction only. Applying it to the five layouts, the custom canvas and live waveform data has not started and still needs a go-ahead; the preview remains synthetic and the running app unchanged.

The third visual pass (`index.html`) darkens and saturates the waveform palette toward the supplied reference's red/magenta/violet scheme and refines surfaces, with `index-v1.html` and `index-v2.html` preserved. The synthetic palette is not analysis. The second visual pass retains the composition and adds heavier typography, high-density continuous vector waveform contours, consistent vector icons and more legible control edges. `index-v1.html` preserves the first reviewed proof; `index.html` is the refined candidate. These are still synthetic visual studies, not an audio-analysis or application update.

The user supplied separate deck and transport references and authorized a visual proof before application changes. `sketches/007-reference-deck/index.html` combines the compact metadata/waveform/overview/pitch composition with the transport, loop controls, eight cue positions and slim cue-editing strip. It retains Deck Craft branding and the existing deck identity colors. The supplied screenshots are included only in a private side-by-side review copy, not in source.

This is an offline, synthetic, no-audio preview, not an implementation or deployment. Preview presets, mock play/pause/seek and manual cue interactions do not touch the shared session, library, engine or persistence. The current application has four manual cues: positions 5–8 are visible but disabled in the proof. Meaningful frequency colors, high-resolution scrolling waveform data and the other unsupported processing/editing/mapping controls remain unimplemented. Appearance approval is still pending; all five application layouts, the customizable canvas and historical designs remain unchanged.

Verification: Chromium exercised real pointer Play/Cue, mock seeking/storage, all preview presets and presentation-state preservation; 16 viewport/width-mode combinations had no document overflow or deck-control clipping, with no browser errors or HTTP requests. Desktop comparison, close-up and narrow screenshots were inspected. The unchanged application also passes 68 Node tests, six Rust tests, five installer tests, build/bundle syntax, both browser regression suites and publication checks. No new native signal or target-machine acceptance is claimed for this visual-only proof.

## Current: customizable component canvas and external-agent creator kit

The approved first stage adds presentation customization over existing functionality, not new DSP or executable plugins. **Customize** / **Layout → Custom canvas** opens an initially empty workspace. The five original layouts and Studio Sync default remain intact; the builder offers editable starter arrangements based on them.

Implemented:

- Click/drag deck, mixer, browser, waveform, cue-bank, crossfader and explicitly disabled effects components into one scrollable canvas.
- Move/resize with optional grid snapping, keyboard movement and numerical inspector fields; style colors, corners, density, scale and deck sections; bind existing deck parts to A/B/C/D.
- Independent reusable component templates, named workspace presets, duplicate/remove, bounded Undo/Redo and a locked Perform surface.
- Separate versioned workspace persistence in the existing sole renderer store, with independent persistent save warnings. Layout changes/removal do not alter musical state; restored playback remains paused.
- Strict component/workspace JSON import, explicit validation and inert synthetic preview before apply; actual JSON export/downloads work in the browser and sandboxed Electron app.
- Offline AI creator kit containing instructions, exact schemas, examples, capability reference and an executable dependency-free validator. Any external agent can use it without reverse-engineering application source or receiving private music/library/session data.
- Repository-side kit/validate/static-preview tools and dedicated canvas browser regressions. See `docs/CUSTOM-CANVAS.md` for usage, formats, capacities and limits.

Verification includes real Chromium pointer interactions and file/download workflows, original layout regressions, the exported validator, Rust/installer checks, real native PCM capture and Electron/native integration through an explicit private null sink. The desktop harness checks stable native engine/load generation while canvas views are added/styled/removed, canvas Play/Pause, safe kit download and paused restart. These are controller-host checks, not target-machine or physical-output acceptance.

A user-local compatibility build has also been installed on the target, preserving the newer library implementation and native engine byte-for-byte. The installed manifest, rollback release, ordinary launcher, native Wayland window and child-engine identity were verified. The combined candidate passed 66 Node tests, original/canvas browser regressions, native signal capture and Electron integration with an explicit isolated sink. Live inspection found the installed app already in use, so verification did not interrupt playback or replace the user's current layout. Detailed installation receipts, state backups and screenshots remain private and outside source.

Local source integration preserves the newer library/safety fixes and Performance console treatment. Pre-merge review reproduced a creator-preview/native-selector collision and real-catalog content appearing in browser previews. Preview contents now strip every semantic data attribute and explicitly render synthetic browser fixtures; focused regressions fail on the original defects. The corrected candidate passes 68 Node tests, six Rust tests, five installer tests, build/bundle syntax, both browser suites, all 18 isolated native signal checks and real Electron first-use/restart/offline integration, including validated previews during native reload/play/clock events and after dialog close. These preview corrections are source-only and have not been redeployed.

Future customization work: arbitrary internal control composition, grouping, executable extensions, new controls/DSP, direct agent connections and a built-in AI assistant. Target portal/chooser lifecycle, physical output and hardware-latency acceptance remain pending; installation and a rendered Wayland window do not prove them. No publication or public push is implied by source integration.

## Previous merged-release target deployment

The reviewed merged release is now installed user-locally on the Omarchy target. Its exact package passed checksum/payload verification and isolated installed-app checks for native metadata inspection, collection persistence, paused restart and offline selected-track removal protection. The ordinary desktop entry opens one native Wayland application window with one native engine; the visible UI reports audio ready at 48,000 Hz and restored decks are paused. Independent target readback confirms all 186 payload files, unchanged private library bytes, a private-state backup and the previous release retained for rollback. Detailed deployment receipts remain outside source.

No music playback or hardware-latency test was performed during deployment. The earlier isolated signal/desktop results below remain source-integration evidence; this package smoke check is not a new signal-capture or physical-output acceptance run. Nothing was pushed.

## Local integration verification

The merged source candidate combines the persistent local library and folder-navigation correction with the committed Performance console presentation across all five layouts. The selected-track safety correction below is included; unfinished customizable-canvas work and generated/private artifacts are excluded.

Verification on the combined source passes 57 Node tests, six Rust tests, five installer tests, desktop/UI build and bundle syntax, 25 browser layout transitions, 30 responsive cases and publication checks. Fresh native signal capture passes all 18 checks through an explicit isolated output. Real Electron/native first-use, paused restart and offline/reconnect phases pass, including selected-track removal protection. The independent corrected-task review passed before integration; the merge preserves its backend/session code unchanged and retains the existing presentation source. At this integration checkpoint it had not yet been pushed or redeployed; the subsequent target deployment is recorded above. Neither establishes physical-output, full portal lifecycle or hardware-latency acceptance.

## Pre-commit selected-track safety correction

Review identified an offline-restoration edge case: an empty native deck snapshot could allow removal of a track still selected in the renderer. Selected sources are now retained by bounded main-process deck references before audio readiness is checked, preserved across engine reconnect, and checked alongside native/pending-load references before library removal. The renderer also refuses selected-track removal, and catalog replacement validates its full candidate before changing entries or orphaning a selected deck.

Four focused regressions reproduce/protect the UI, catalog, initialization and IPC boundaries. The real Electron offline lane additionally verifies direct-IPC and UI refusal after restart and engine reconnect. The corrected task branch passes 56 Node tests, six Rust tests and five installer tests, plus the real desktop lane. At this review checkpoint the correction was source-only; it is now included in the merged-release target deployment above, alongside the confirmed 0.3.1 folder-navigation fix.

## Folder-navigation correction (0.3.1)

The Add folder dialog no longer receives an audio-file extension filter. On GTK, that filter made folder rows insensitive and prevented activating them to navigate deeper. A real GTK paired probe reproduced disabled/non-navigable directories with the filter and enabled/navigable directories without it. Audio-file selection retains its audio filter. The Electron integration now rejects folder-picker options containing filters and checks that multi-file selection keeps its audio filter; the pre-fix candidate failed and the corrected candidate passes. The native engine is unchanged.

The 0.3.1 fix was deployed with the latest already-installed presentation update retained, rather than replacing it with an older theme. Its combined bundle passed browser and real Electron/native regressions. Target readback verified the fixed main-process source, installed payload, unchanged native engine and original private library, previous release retention, and a normal desktop-entry launch showing 0.3.1. The user subsequently confirmed folder navigation works; that confirmation and GTK component navigation do not establish full portal lifecycle acceptance. The runtime-composition and deployment receipts remain private.

## Previous milestone: local library, crates and ordered playlists (0.3 preview)

The desktop now exposes multi-file/folder import without loading a deck, real persistent named crates and ordered playlists, search/sort, multi-selection, add/remove membership, rename/delete and playlist order controls in every layout. Local tracks are the default library; synthetic fixtures are separately labeled and not playable. Library removal never deletes original music and refuses sources loaded/loading in decks.

Import uses a bounded native `--inspect` process that validates the selected file identity and decodes metadata without opening an output device. It does not occupy a deck or change ongoing playback. The private registry owns collections and commits their changes atomically, rolling back failed collection edits/removals. Native readiness is shown explicitly, and library import remains usable with output offline.

New verification: 52 Node tests, six Rust tests and five installer tests pass; desktop/UI build and bundle syntax pass. The real Electron/native suite passes file/folder import, duplicate/corrupt handling, collections/order, continuing playback during imports, full paused restart and an output-unavailable import phase. The release engine passes all 18 native signal-capture checks. Browser regressions pass all 25 layout transitions and 20 responsive cases. Native library load/order buttons are checked for visible containment across all five layouts, and actual Electron screenshots were inspected. Publication checks pass. This work does not establish target-machine physical output or latency acceptance. The new native chooser buttons use the OS dialog; the automated default lane substitutes only its selection result, not decoding or transport.

The 0.3 development package was checksum-verified and installed in an isolated home using the pinned official runtime. Its ordinary launcher, real native playback/pause, collection creation and full paused restart were exercised through an isolated output. The installed payload matched its manifest. No existing user installation was replaced. This is a local development snapshot, not a public release or a target-machine acceptance result.

The same verified package was subsequently installed on the actual Omarchy target. The old app closed gracefully, private state was backed up outside source, the previous release was retained, and the original library registry was unchanged. Readback confirmed the installed payload hashes, ordinary desktop-entry launch, a native Wayland window, one native engine and visible 0.3 library controls with audio-ready status. No playback was started for this deployment. Physical audible output, full native chooser/portal interaction and latency remain unverified; detailed operational evidence stays private.

## Previous milestone: Omarchy-first native desktop/audio foundation

The user approved an installed desktop app and first real local-file → deck → play/pause/seek workflow, retaining all five approved layouts and paused restoration. Omarchy Linux is the first target. User-local installation and an ordinary graphical-session launch have now been verified; portal/file-chooser, physical output and hardware-latency acceptance remain pending.

Implemented in the native preview:

- Sandboxed Electron desktop window with one native Rust/Rodio/CPAL child; no network service or renderer Node access.
- Local file import, opaque source IDs, private mode-0600 library, descriptor identity checks and safe format/file errors.
- Four native decks; actual play/pause/seek, manual cues, channel levels and A/B crossfader. Native consumed media frames own position.
- Worker-side streaming decode and seek preparation, bounded PCM rings and off-callback retirement; no file reads in the device-facing PCM iterator.
- PCM-derived local waveforms; unimplemented BPM/key/beat features are not fabricated. Unsupported DSP/routing controls are disabled.
- All five layouts remain selectable without changing native source or generation; C/D survive two-deck views.
- Device-local session/library restoration, always paused. Superseded asynchronous Play cannot resume after a newer Pause.
- User-local, checksum-verified installer/package with menu launcher, versioned releases and rollback; no sudo or system-service changes.

## Entry points

- `npm ci && npm run build:desktop && npm run desktop`: native development build.
- `npm run package:desktop`: small Linux x86-64 app/native-engine package with verified official-runtime download at installation.
- `npm run build`: browser-only UI artifact; still no audio outside the native bridge.
- `docs/NATIVE-DESKTOP.md`: architecture, ownership, test setup and explicit acceptance limits.

## Previous milestone verification

The previous 0.2 candidate passed independent native/security/desktop review and the focused persistent-warning follow-up. Its executed gates: 46 Node tests (including five real-renderer DOM warning scenarios with a mocked native bridge), six Rust tests, five installer safety tests, 25 browser layout transitions and 20 responsive cases. Real native output capture passed 18 checks including actual format decoding, pause/seek/crossfader and engine death. Real Electron integration passed first-use and paused restart phases. That packaged installer and ordinary launcher were exercised in an isolated home; installed payload hashes, real engine death/reconnect and full-package rollback in both directions were verified. Those independent-review/installed-package verdicts do not transfer automatically to the new library candidate above.

The isolated Linux signal lane uses the upstream-corrected PulseAudio ALSA timing-error comparison described in `docs/NATIVE-DESKTOP.md`; stock-driver failures remain recorded separately. That correction is confined to a private test dependency and is not bundled or installed as a system driver. Private execution receipts and review verdicts stay outside public source.

The default desktop suite injects only OS file selection; the engine, files, UI, native controls and persistence are real. An earlier optional GTK chooser run selected and loaded generated audio, but controller cleanup/restore did not complete cleanly. Existing mounts and system services were not changed to make the suite pass. Do not report complete native-chooser lifecycle or target-laptop acceptance from these tests.

## Performance console visual pass — implemented across all five layouts

`sketches/006-console-comparison/index.html` compares a restrained Precision console with a higher-contrast Performance console on the same Studio Sync composition and synthetic mock session. Standalone entry points live in `sketches/006-precision-console/` and `sketches/006-performance-console/`. Theme switching retains the mock decks, cues, levels and crossfader; state presets deliberately reset the mock session. Transport interactions are visual-only, with no simulated advancing audio clock, native bridge, files or persisted app state. Unsupported DSP/routing/analysis stays disabled.

The user selected **B — Performance console**, not a hybrid, then authorized applying it to the working app across all five layouts and subsequently authorized deployment. The application now has darker surfaces, brighter and layout-independent A/B/C/D identities, larger clocks, stronger transport controls and a matching collection/mixer/native import treatment. Styling lives in `src/app.css` and `src/native.css`; `src/components.js` supplies the consistent deck palette. No native, bridge, session, persistence or command behavior was changed. All five compositions, historical designs and the exact approved stylesheet are preserved.

Executed for this pass: 47 Node tests, six Rust tests, five installer tests, UI build/bundle syntax, 25 ordered browser layout transitions and 30 responsive layout cases including short desktop windows and 360/390-pixel widths. Browser checks cover the selected palette, contained transport/clocks/cues, visible collection load actions, mixer access and unchanged session/restoration behavior. All five built layouts were visually inspected with synthetic fixtures. The narrower library initially hid loading actions and a 360-pixel Linear transport overflowed its deck; the final collection sizing and wrapped Linear transport pass the strengthened geometry assertions. This presentation-only pass did not rerun native signal capture or real-output integration; target-machine physical/portal/latency acceptance remains pending.

Deployment preserved a newer already-installed 0.3.0 import/library build rather than replacing it with this branch's older backend. An isolated materialization applied only the UI styles and deck palette; the installed package differs from that baseline only in its bundled HTML. All other payload files, including native engine, import coordinator, bridge and notices, retain their exact hashes. The compatibility candidate passed 53 Node tests and 20 additional mocked-bridge layout/viewport checks covering file/folder imports, crates, playlists and visible load/order controls. The checked package was installed through the user-local installer, the paused app was closed gracefully, and its ordinary desktop entry opened the new release in the actual graphical session. Installed hashes, running app/native identities, the visible new treatment and unchanged library bytes were read back. Private state backup and the previous release are retained. No music playback, portal selection or physical-output/latency test was performed. Detailed deployment receipts remain outside public source. At that deployment checkpoint, the newer backend source had not yet been merged into the presentation branch; the local integration above now combines them.

## Remaining product work

Target Omarchy installation/native-Wayland launch and audio readiness are now smoke-verified. Full native chooser/portal behavior, physical audible output and hardware latency still need acceptance on the target. EQ/FX, loops/sync, beat/key analysis, time stretching, meters, headphone routing, controllers and other platforms remain unimplemented. This is a native playback foundation, not professional-DJ parity.

All historical mockups and original selected-reference hashes remain unchanged. Private machine/network details, runtime registrations, selected music, profiles and operational/process receipts stay outside public source.
