# Browser audio backend

`dist/deck-craft.html` is no longer UI-only in a browser that supports the APIs below. It plays audio files you choose **inside your own browser, on your own device**. This is a different engine from the Rust/CPAL desktop engine: it does not claim native DSP, ALSA/PipeWire output, Omarchy acceptance or measured latency. The desktop app keeps using its native bridge unchanged; the browser backend is used only when no native bridge exists.

## What it is

- One `HTMLAudioElement` per deck. The browser media clock owns position, `playbackRate` (tempo, ±8%) and `preservesPitch` (pitch lock). Nothing in the page simulates a clock; the UI position is the element's measured `currentTime`.
- Web Audio gains per deck, an equal-power A/B crossfader and conservative master headroom (same mixing law as the native engine). There is no AudioWorklet and no other secure-context-only API, so it works from a plain-`http://` LAN origin.
- `src/browser-audio.js` implements the same semantic command contract as the native bridge (`load`, `play`, `pause`, `seek`, `tempo`, `master`, `sync`, `level`, `crossfader`, `pick`, `import`, `analyze`, collections, `forget`, `reconnect`), with the same exact field and range validation. It emits the same kind of acknowledged snapshots (engine/source ids, increasing sequence, per-deck load generation) so the shared `NativeSession` and `LibraryController` drive it unmodified. Snapshots carry `backend: "browser"` and honest capabilities; `src/backends.js` supplies the labels, so the UI never presents browser playback as the Rust engine.
- The library UI, five layouts, custom canvas, themes and persistence are the same shared code. Demo fixtures stay synthetic and silent.

## Capabilities

| Feature | Browser backend |
| --- | --- |
| Open files | One or more files, or a folder, through the browser file chooser. Cancel, per-file errors and limits are shown in the library message. |
| Analysis | PCM decoded locally with `decodeAudioData` at 24 kHz (a 200 Hz analysis envelope, matching the native estimator), 512-bin waveform, constant 60–200 BPM grid from the first 60 s, JPEG/PNG artwork from ID3v2.3/2.4, FLAC and MP4/M4A tags. Silence, steady tones and unreliable material get no BPM. |
| Transport | Play, pause, seek, manual cues, levels, crossfader. A newer pause beats a Play that is still starting; Play after the natural end restarts from zero. |
| Tempo / pitch lock | Written to the media element. If the browser has no `preservesPitch`, lock is reported off, the control is disabled and a locked tempo change is refused. It is never shown active when it is not. |
| Master / Sync | Explicit master, then Sync matches effective BPM and aligns beat phase using measured media positions (iterated until the phase error is small). Follows later master tempo changes; cleared by independent play, pause, seek, load or a new master, as in the native engine. |
| Not implemented | EQ, filters, FX, loops, key, meters, headphone routing, controllers. These stay disabled. |

## Privacy and security

- Files never leave the browser: no upload, remote decode, server, account, listener or native HTTP control. The page makes no network request after loading (`connect-src 'none'`); it adds only `media-src blob:` for local object URLs. The native desktop policy is unchanged (its own header CSP keeps `media-src 'none'`, and the bridge-owning window never starts this backend).
- Source paths do not exist in the browser. Tracks have opaque `local-…` ids; titles are file names with control characters removed.
- Embedded artwork is sniffed from magic bytes (declared types and linked URLs are ignored), limited to 2 MiB and 2048×2048, decoded locally and re-encoded as a metadata-free ≤16 KiB PNG thumbnail.
- Identifiers use `crypto.getRandomValues` when `crypto.randomUUID` is unavailable (plain HTTP).
- The AudioContext is created gated by the browser's autoplay policy and resumed synchronously inside the first click or key press. If it later stops running, every deck is paused, the status line says so, and nothing restarts automatically. `pagehide` pauses all decks. Saved sessions always restore paused; no audio starts without a user gesture.

## Persistence and limits

Imported files are stored as Blobs in this browser's IndexedDB, with a metadata document (tracks, waveforms, grids, artwork, crates and playlists). Old native desktop state is separate and untouched. If IndexedDB is unavailable, full, or the metadata cannot be saved, the file is kept **for this session only**, marked as such in the library and the warning line, and must be selected again after a reload. Nothing claims durable playable media in that case. `navigator.storage` is secure-context-only, so there is no quota estimate on plain HTTP: warnings come from the app's own limit and from real quota errors.

| Limit | Value |
| --- | --- |
| File size | 64 MiB |
| Duration | 20 minutes (decode memory stays below about 230 MB, one file at a time) |
| Batch | 100 files and 256 MiB per import |
| Library | 500 tracks, 768 MiB persisted, 384 MiB session-only |

Duplicate files (name, size, modified time) are not added twice. Removing a track from the library deletes its stored copy; a track loaded or loading in a deck cannot be removed.

## Honest limits

- Format support is whatever the browser decodes; unsupported files fail with a visible message. A file that plays but cannot be decoded for analysis is imported without a waveform or BPM.
- The BPM estimator is a port of the native constant-grid estimator and shares its weaknesses: half/double-tempo errors and no result above about 178 BPM were measured on synthetic click tracks (for example 122 and 134 BPM resolve to half tempo). Sync accuracy over time depends on the detected BPM, so a long-running follower can drift by a few milliseconds per ten seconds.
- Time stretching is the browser's own algorithm; its quality and latency vary by browser.
- Hardware output latency is not measured. Behavior was verified in Chromium; other browsers are untested.

## Verification

`npm test` covers analysis, artwork parsing, storage, validation and the transport/sync/failure semantics against in-memory fakes, and drives the shared session over the bridge. `npm run test:browser-audio` is the real-browser lane: it serves `dist/` on a non-loopback plain-HTTP address (not a secure context), drives Chromium with real input events and an injected OS file-chooser selection, and captures the browser's actual output from an explicitly isolated PulseAudio null sink (`PULSE_SERVER`, `DECKCRAFT_TEST_PAREC`, `CHROMIUM_FULL`; optional `FFMPEG` for embedded-art fixtures). It never selects a physical output. Set `DECKCRAFT_EVIDENCE_DIR` to keep results and the raw capture outside the source tree. The older browser and canvas suites run with the audio backend disabled (they cover the UI-only fallback); set `DECKCRAFT_BROWSER_AUDIO=1` to run them against the backend instead.
