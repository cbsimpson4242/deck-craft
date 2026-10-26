# Native desktop foundation

## Acceptance and limits

The approved first vertical slice is an installed Omarchy desktop app that opens local audio, loads a deck and actually plays, pauses and seeks through the default output, retaining all five views and shared state.

The implementation is a **Linux preview**. Source, native signal output and desktop integration can be tested independently of the target machine. User-local installation and an ordinary application-menu launch in the actual Omarchy graphical session have now been verified for the visual update. The existing newer import/library backend was preserved byte-for-byte, the saved library remained unchanged, and restoration stayed paused. Native file-chooser/portal behavior, actual physical output and hardware latency remain pending. Other operating systems and professional-DJ parity are not claimed.

Supported first-slice controls: import a local source, load A/B/C/D, play/pause, seek, manual cue positions, channel levels and an equal-power A/B crossfader. C/D feed the same master directly. Master headroom is deliberately conservative; this is not a calibrated loudness or limiter implementation. Gain/EQ/filter, FX, sync, time stretch, loops, beat/key detection, VU meters, headphone cue routing and hardware mappings are disabled/unimplemented.

## Authority boundaries

- `desktop/main.cjs`: owns the single app window, native file selection, private library, native child and allowlisted IPC.
- `desktop/policy.cjs`: admits exact semantic request shapes only, from the intended main frame at the exact app URL. It does not expose paths, shell commands or arbitrary engine commands.
- `desktop/preload.cjs`: context-isolated, sandboxed bridge. Node/process/Electron APIs are not exposed to page code.
- `desktop/library.cjs`: selected-source registry, opaque UUID IDs and descriptor identity. Absolute source paths live only in private user-local state; renderer metadata contains basenames, IDs and audio properties. Atomic library writes use mode 0600; application storage is mode 0700.
- `desktop/audio-client.cjs`: explicit native executable, positive operational environment allowlist, bounded JSON-line frames, request correlation, generation/sequence validation, disconnect handling and a heartbeat watchdog. No network listener or automatic command replay.
- `native/src/main.rs`: audio/transport authority. Four decks, transactional staged loads, per-deck load ownership, bounded preparation admission, native sample-frame positions and acknowledgement snapshots.
- `native/src/stream.rs`: file reads/decoding/seek preparation on workers; bounded SPSC PCM queues to the device-facing iterator. Empty queues output zero without advancing media position, while underrun counters record the event. Buffer destruction is retired off the device-facing iterator. Rodio/CPAL still has its own internal machinery; this is not a claim of hard-real-time certification.
- `src/native.js`: maps accepted native receipts to the shared UI model. Old replies cannot rewind state or resurrect an old engine; a newer Pause supersedes an asynchronous Play preparation. Layout renderers never start another backend.
- `src/store.js`: sole renderer snapshot owner. Live positions are checkpointed; explicit paused seeks and transport changes persist immediately. Reopening always restores paused.

Before native decoding, regular-file type and selected descriptor identity are checked (device, inode, size, modification time). Nonblocking opens prevent a substituted FIFO from hanging before validation. Changed/missing/unsupported sources are rejected instead of silently replacing another deck. Input size, duration, channels, sample rate and control values are bounded.

The app window uses a private app scheme, hash-authorized script CSP, denied external requests/permissions/navigation/popups, no webviews and no renderer Node integration. The desktop has no HTTP server, telemetry or cloud library sync. Selecting a file on an OS-mounted network drive still uses that filesystem; the app does not upload music.

## Packaging and installation

`npm run build:desktop` builds the offline UI and native release engine, remapping builder-home compiler paths. `npm run package:desktop` requires reviewed clean source and emits a small application/native-engine archive plus SHA-256. Its manifest records source commit, file hashes/modes, installer hash and the exact official Electron runtime URL/hash.

The installer verifies package files and the runtime ZIP, extracts into an owned staging release, creates user-local launchers and switches `current` atomically. Prior releases remain available for rollback; it does not delete music, change OS volume, install system packages, create a system service or restart an existing copy. Runtime ZIP entries, package paths and existing launchers are checked before use. Dependency notices are preserved.

User state is never included in a package. Packaging uses an explicit runtime-source/asset allowlist rather than copying a working directory with ignored logs or audio files.

### Library persistence capacity

Both writing and restoring enforce at most 10,000 records and 16 MiB of serialized UTF-8 JSON. The byte limit includes paths, metadata and the decoded 512-value waveform arrays, not just track count. Snapshot construction stops at the byte budget before opening a temporary file; restoration bounds the actual read as well as checking file size. Waveform amplitudes retain their decoded resolution. Only known private record fields are persisted; paths never enter renderer metadata.

An oversized metadata/waveform update or import returns a failed save with a capacity warning through the existing desktop warning path. It remains usable in memory for this session but does not replace the previous saved registry. A later snapshot within budget may save normally. Successful writes still use a private temporary file, file sync and atomic rename; save failure does not erase the previous durable file. Existing version-1 libraries within these limits remain supported. An already-oversized legacy file is not automatically repaired or deleted; restoration reports failure, and recovery requires a separate deliberate backup/re-import decision.

### Manual uninstall

Follow the [checked manual removal instructions in README](../README.md#uninstall-keep-music-and-preferences). Quit the app first and avoid concurrent installation or rollback. Verify the managed-root marker and both managed launchers, including their targets and lack of unexpected symlinks, before removing anything. Remove only the managed `~/.local/share/deck-craft/` root, `~/.local/bin/deck-craft` and `~/.local/share/applications/deck-craft.desktop`. Stop if they contain unrelated/custom data or do not match the installer. Music is never an uninstall target. Private user state is intentionally retained, and no system packages/services are removed. Rollback is not uninstall.

### Deliberately remove private user state (optional)

This is **separate from uninstall**, not a default cleanup step. With Deck Craft fully closed, first back up any preferences/session/library registry you want to retain. On Linux the production app explicitly uses the `deck-craft` subdirectory of Electron's application configuration directory: normally `~/.config/deck-craft/`, or `$XDG_CONFIG_HOME/deck-craft/` if that variable was set when the app ran. A development/test launch may explicitly override user data; do not guess or delete a test/custom directory as part of production uninstall.

Inspect the exact real application-state directory in a file manager, confirm ownership and contents, and stop on unexpected symlinks or unrelated files. Only after deliberately deciding to discard the library registry, preferences, cues and saved session, delete that specific `deck-craft` state directory, **not its parent configuration directory**. This removes the private `library.json` path/opaque-ID registry and Electron's stored renderer session/preferences/cache. Saved opaque IDs cannot be recovered without a backup; importing music again creates new IDs. Do not delete the files named inside `library.json`: those are original music sources, not application-state files. State deletion does not delete music or remove an installed app.

## Executed verification

The development gates include actual generated WAV, MP3, FLAC, Ogg Vorbis, AAC/M4A, ADTS AAC, AIFF and ALAC/M4A decode/paused-seek checks. Recoverable driver notices (XRuns, real-time promotion refusal, already-rerouted default output) do not masquerade as a disconnected device; genuine invalidation/disconnection remains fail-closed.

## Isolated Linux test-driver prerequisite

Older ALSA PulseAudio plugins (including the stock 1.2.12 test transport) compare the negative `pa_stream_get_latency` error with positive `PA_ERR_NODATA`. That can turn temporarily unavailable timing into `snd_pcm_avail_delay` I/O errors during startup. Use a transport containing the [upstream negative-error comparison fix](https://github.com/alsa-project/alsa-plugins/blob/master/pulse/pcm_pulse.c) for the isolated null-sink lane. Driver-only paired runs reproduced failures with the old plugin and passed with the source-built fixed plugin, without changing the installed app. This is a test dependency, not an application-bundled driver; no system audio configuration was modified and genuine output errors remain fail-closed. A passing patched-fixture test does not replace actual Omarchy/PipeWire/physical-output acceptance.

The development gates include:

- Model, persistence, view-fidelity, IPC authority, private library and stale/native-owner regression tests.
- Native protocol/validation and actual PCM decode tests in Rust.
- User-local install/update/idempotence/rollback and invalid-payload/runtime/path/launcher tests in Python. Those safety unit tests deliberately use tiny fixture archives; they are not app execution evidence.
- Real native signal integration through an isolated Unix PulseAudio null sink: generated WAV decode; advancing native frames; pause; seek from a 440 Hz region to an 880 Hz region verified from captured PCM; real crossfader mute; natural end/restart; rejected corrupt replacement; unchanged other decks; waveform peaks; process death causing measured silence and no replay.
- Actual Electron window/bridge with the native engine: 25 layout transitions retain the same playing source/generation, manual cue/seek/pause, independent second-deck load, and full application restart restoring local source IDs/positions/cues/layout paused. Renderer Node/process access, extra IPC fields and arbitrary commands are rejected.
- The earlier browser-only transition/persistence/responsive regression suite remains required.

### Native test setup

`npm run test:native` expects `ALSA_CONFIG_PATH`, a `PULSE_SERVER` Unix socket, and `DECKCRAFT_TEST_PAREC` pointing to the capture tool. The configured server must provide the isolated `deckcraft_test` null sink and monitor. No physical device is chosen implicitly. `DECKCRAFT_TEST_ENGINE` can select the release binary; `DECKCRAFT_EVIDENCE_DIR` keeps reports/captured data outside public source. Do not run signal and desktop suites concurrently against the same sink.

`npm run test:desktop` additionally uses Xvfb, Python 3 and a private D-Bus daemon. Its default injects only the OS file-selection result; all native file validation, decode, audio state, UI controls, persistence and restart are real. Set `DECKCRAFT_TEST_NATIVE_DIALOG=1` to automate the actual GTK chooser with xdotool. No test unmounts or repairs an existing filesystem.

### Environment caveat from the real chooser test

The real GTK chooser successfully selected generated audio, and the native UI loaded/played/paused/sought it across all layouts. Clean shutdown of that optional lane was blocked by an existing unrelated unresponsive FUSE/network filesystem during GTK volume discovery. Subsequent full restart tests used explicit fixture selection and passed; this distinction must not be erased or described as full native-chooser lifecycle acceptance. The existing mount was not changed. Operational diagnostics/process identities are private and excluded from this repository.

An actual Omarchy/Wayland/portal and physical-output check is still required. Virtual-sink results are not proof of laptop speakers, interface routing, controller support, low latency or professional reliability.
