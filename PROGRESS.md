# Progress

## Local integration verification

The merged source candidate combines the persistent local library and folder-navigation correction with the committed Performance console presentation across all five layouts. The selected-track safety correction below is included; unfinished customizable-canvas work and generated/private artifacts are excluded.

Verification on the combined source passes 57 Node tests, six Rust tests, five installer tests, desktop/UI build and bundle syntax, 25 browser layout transitions, 30 responsive cases and publication checks. Fresh native signal capture passes all 18 checks through an explicit isolated output. Real Electron/native first-use, paused restart and offline/reconnect phases pass, including selected-track removal protection. The independent corrected-task review passed before integration; the merge preserves its backend/session code unchanged and retains the existing presentation source. This local integration has not been pushed or redeployed, and does not establish physical-output, full portal lifecycle or hardware-latency acceptance.

## Pre-commit selected-track safety correction

Review identified an offline-restoration edge case: an empty native deck snapshot could allow removal of a track still selected in the renderer. Selected sources are now retained by bounded main-process deck references before audio readiness is checked, preserved across engine reconnect, and checked alongside native/pending-load references before library removal. The renderer also refuses selected-track removal, and catalog replacement validates its full candidate before changing entries or orphaning a selected deck.

Four focused regressions reproduce/protect the UI, catalog, initialization and IPC boundaries. The real Electron offline lane additionally verifies direct-IPC and UI refusal after restart and engine reconnect. The corrected task branch passes 56 Node tests, six Rust tests and five installer tests, plus the real desktop lane. This source-only review correction has not been redeployed to the target; the target retains its confirmed 0.3.1 folder-navigation fix.

## Folder-navigation correction (0.3.1)

The Add folder dialog no longer receives an audio-file extension filter. On GTK, that filter made folder rows insensitive and prevented activating them to navigate deeper. A real GTK paired probe reproduced disabled/non-navigable directories with the filter and enabled/navigable directories without it. Audio-file selection retains its audio filter. The Electron integration now rejects folder-picker options containing filters and checks that multi-file selection keeps its audio filter; the pre-fix candidate failed and the corrected candidate passes. The native engine is unchanged.

The 0.3.1 fix was deployed with the latest already-installed presentation update retained, rather than replacing it with an older theme. Its combined bundle passed browser and real Electron/native regressions. Target readback verified the fixed main-process source, installed payload, unchanged native engine and original private library, previous release retention, and a normal desktop-entry launch showing 0.3.1. The user subsequently confirmed folder navigation works; that confirmation and GTK component navigation do not establish full portal lifecycle acceptance. The runtime-composition and deployment receipts remain private.

## Current: local library, crates and ordered playlists (0.3 preview)

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
