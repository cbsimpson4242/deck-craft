# Progress

## Current: Omarchy-first native desktop/audio foundation

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

## Verification status

Exact-candidate independent native/security/desktop review and the focused persistent-warning follow-up passed. Executed gates: 46 Node tests (including five real-renderer DOM warning scenarios with a mocked native bridge), six Rust tests, five installer safety tests, 25 browser layout transitions and 20 responsive cases. Real native output capture passed 18 checks including actual format decoding, pause/seek/crossfader and engine death. Real Electron integration passed first-use and paused restart phases. The actual packaged installer and ordinary launcher were exercised in an isolated home; installed payload hashes, real engine death/reconnect and full-package rollback in both directions were verified.

The isolated Linux signal lane uses the upstream-corrected PulseAudio ALSA timing-error comparison described in `docs/NATIVE-DESKTOP.md`; stock-driver failures remain recorded separately. That correction is confined to a private test dependency and is not bundled or installed as a system driver. Private execution receipts and review verdicts stay outside public source.

The default desktop suite injects only OS file selection; the engine, files, UI, native controls and persistence are real. An earlier optional GTK chooser run selected and loaded generated audio, but controller cleanup/restore did not complete cleanly. Existing mounts and system services were not changed to make the suite pass. Do not report complete native-chooser lifecycle or target-laptop acceptance from these tests.

## Remaining product work

Target Omarchy installation, Wayland/portal behavior, physical output and hardware latency must be verified on the actual target. EQ/FX, loops/sync, beat/key analysis, time stretching, meters, headphone routing, controllers and other platforms remain unimplemented. This is a native playback foundation, not professional-DJ parity.

All historical mockups and original selected-reference hashes remain unchanged. Private machine/network details, runtime registrations, selected music, profiles and operational/process receipts stay outside public source.
