# Progress

## Pre-commit selected-track safety correction

Review identified an offline-restoration edge case: an empty native deck snapshot could allow removal of a track still selected in the renderer. Selected sources are now retained by bounded main-process deck references before audio readiness is checked, preserved across engine reconnect, and checked alongside native/pending-load references before library removal. The renderer also refuses selected-track removal, and catalog replacement validates its full candidate before changing entries or orphaning a selected deck.

Four focused regressions reproduce/protect the UI, catalog, initialization and IPC boundaries. The real Electron offline lane additionally verifies direct-IPC and UI refusal after restart and engine reconnect. The corrected task branch passes 56 Node tests, six Rust tests and five installer tests, plus the real desktop lane. This source-only review correction has not been redeployed to the target; the target retains its confirmed 0.3.1 folder-navigation fix.

## Folder-navigation correction (0.3.1)

The Add folder dialog no longer receives an audio-file extension filter. On GTK, that filter made folder rows insensitive and prevented activating them to navigate deeper. A real GTK paired probe reproduced disabled/non-navigable directories with the filter and enabled/navigable directories without it. Audio-file selection retains its audio filter. The Electron integration now rejects folder-picker options containing filters and checks that multi-file selection keeps its audio filter; the pre-fix candidate failed and the corrected candidate passes. The native engine is unchanged.

The 0.3.1 fix was deployed with the latest already-installed presentation update retained, rather than replacing it with an older theme. Its combined bundle passed browser and real Electron/native regressions. Target readback verified the fixed main-process source, installed payload, unchanged native engine and original private library, previous release retention, and a normal desktop-entry launch showing 0.3.1. Actual user navigation through the native picker remains a confirmation step; GTK component navigation is not full portal lifecycle acceptance. The runtime-composition and deployment receipts remain private.

## Current: local library, crates and ordered playlists (0.3 preview)

The desktop now exposes multi-file/folder import without loading a deck, real persistent named crates and ordered playlists, search/sort, multi-selection, add/remove membership, rename/delete and playlist order controls in every layout. Local tracks are the default library; synthetic fixtures are separately labeled and not playable. Library removal never deletes original music and refuses sources loaded/loading in decks.

Import uses a bounded native `--inspect` process that validates the selected file identity and decodes metadata without opening an output device. It does not occupy a deck or change ongoing playback. The private registry owns collections and commits their changes atomically, rolling back failed collection edits/removals. Native readiness is shown explicitly, and library import remains usable with output offline.

New verification: 52 Node tests, six Rust tests and five installer tests pass; desktop/UI build and bundle syntax pass. The real Electron/native suite passes file/folder import, duplicate/corrupt handling, collections/order, continuing playback during imports, full paused restart and an output-unavailable import phase. The release engine passes all 18 native signal-capture checks. Browser regressions pass all 25 layout transitions and 20 responsive cases. Native library load/order buttons are checked for visible containment across all five layouts, and actual Electron screenshots were inspected. Publication checks pass. This work does not establish target-machine physical output or latency acceptance. The new native chooser buttons use the OS dialog; the automated default lane substitutes only its selection result, not decoding or transport.

The 0.3 development package was checksum-verified and installed in an isolated home using the pinned official runtime. Its ordinary launcher, real native playback/pause, collection creation and full paused restart were exercised through an isolated output. The installed payload matched its manifest. No existing user installation was replaced. This is a local development snapshot, not a public release or a target-machine acceptance result.

The same verified package was subsequently installed on the actual Omarchy target. The old app closed gracefully, private state was backed up outside source, the previous release was retained, and the original library registry was unchanged. Readback confirmed the installed payload hashes, ordinary desktop-entry launch, a native Wayland window, one native engine and visible 0.3 library controls with audio-ready status. No playback was started for this deployment. Physical audible output, full native chooser/portal interaction and latency remain unverified; detailed operational evidence stays private.

## Previous milestone: Omarchy-first native desktop/audio foundation

The user approved an installed desktop app and first real local-file → deck → play/pause/seek workflow, retaining all five approved layouts and paused restoration. Omarchy Linux is the first target; native hardware acceptance remains pending while the target machine is unavailable.

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

## Remaining product work

Target Omarchy installation/native-Wayland launch and audio readiness are now smoke-verified. Full native chooser/portal behavior, physical audible output and hardware latency still need acceptance on the target. EQ/FX, loops/sync, beat/key analysis, time stretching, meters, headphone routing, controllers and other platforms remain unimplemented. This is a native playback foundation, not professional-DJ parity.

All historical mockups and original selected-reference hashes remain unchanged. Private machine/network details, runtime registrations, selected music, profiles and operational/process receipts stay outside public source.
