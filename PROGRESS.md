# Progress

## Current: Omarchy-first native desktop/audio foundation

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

## Verification status

Exact-candidate independent native/security/desktop review and the focused persistent-warning follow-up passed. Executed gates: 46 Node tests (including five real-renderer DOM warning scenarios with a mocked native bridge), six Rust tests, five installer safety tests, 25 browser layout transitions and 20 responsive cases. Real native output capture passed 18 checks including actual format decoding, pause/seek/crossfader and engine death. Real Electron integration passed first-use and paused restart phases. The actual packaged installer and ordinary launcher were exercised in an isolated home; installed payload hashes, real engine death/reconnect and full-package rollback in both directions were verified.

The isolated Linux signal lane uses the upstream-corrected PulseAudio ALSA timing-error comparison described in `docs/NATIVE-DESKTOP.md`; stock-driver failures remain recorded separately. That correction is confined to a private test dependency and is not bundled or installed as a system driver. Private execution receipts and review verdicts stay outside public source.

The default desktop suite injects only OS file selection; the engine, files, UI, native controls and persistence are real. An earlier optional GTK chooser run selected and loaded generated audio, but controller cleanup/restore did not complete cleanly. Existing mounts and system services were not changed to make the suite pass. Do not report complete native-chooser lifecycle or target-laptop acceptance from these tests.

## Performance console visual pass — implemented across all five layouts

`sketches/006-console-comparison/index.html` compares a restrained Precision console with a higher-contrast Performance console on the same Studio Sync composition and synthetic mock session. Standalone entry points live in `sketches/006-precision-console/` and `sketches/006-performance-console/`. Theme switching retains the mock decks, cues, levels and crossfader; state presets deliberately reset the mock session. Transport interactions are visual-only, with no simulated advancing audio clock, native bridge, files or persisted app state. Unsupported DSP/routing/analysis stays disabled.

The user selected **B — Performance console**, not a hybrid, then authorized applying it to the working app across all five layouts and subsequently authorized deployment. The application now has darker surfaces, brighter and layout-independent A/B/C/D identities, larger clocks, stronger transport controls and a matching collection/mixer/native import treatment. Styling lives in `src/app.css` and `src/native.css`; `src/components.js` supplies the consistent deck palette. No native, bridge, session, persistence or command behavior was changed. All five compositions, historical designs and the exact approved stylesheet are preserved.

Executed for this pass: 47 Node tests, six Rust tests, five installer tests, UI build/bundle syntax, 25 ordered browser layout transitions and 30 responsive layout cases including short desktop windows and 360/390-pixel widths. Browser checks cover the selected palette, contained transport/clocks/cues, visible collection load actions, mixer access and unchanged session/restoration behavior. All five built layouts were visually inspected with synthetic fixtures. The narrower library initially hid loading actions and a 360-pixel Linear transport overflowed its deck; the final collection sizing and wrapped Linear transport pass the strengthened geometry assertions. This presentation-only pass did not rerun native signal capture or real-output integration; target-machine physical/portal/latency acceptance remains pending.

Deployment preserved a newer already-installed 0.3.0 import/library build rather than replacing it with this branch's older backend. An isolated materialization applied only the UI styles and deck palette; the installed package differs from that baseline only in its bundled HTML. All other payload files, including native engine, import coordinator, bridge and notices, retain their exact hashes. The compatibility candidate passed 53 Node tests and 20 additional mocked-bridge layout/viewport checks covering file/folder imports, crates, playlists and visible load/order controls. The checked package was installed through the user-local installer, the paused app was closed gracefully, and its ordinary desktop entry opened the new release in the actual graphical session. Installed hashes, running app/native identities, the visible new treatment and unchanged library bytes were read back. Private state backup and the previous release are retained. No music playback, portal selection or physical-output/latency test was performed. Detailed deployment receipts remain outside public source; the newer backend source has not been merged into this presentation branch.

## Remaining product work

Omarchy installation and ordinary graphical-session launch are verified; native file-chooser/portal behavior, physical output and hardware latency still need target acceptance. EQ/FX, loops/sync, beat/key analysis, time stretching, meters, headphone routing, controllers and other platforms remain unimplemented. This is a native playback foundation, not professional-DJ parity.

All historical mockups and original selected-reference hashes remain unchanged. Private machine/network details, runtime registrations, selected music, profiles and operational/process receipts stay outside public source.
