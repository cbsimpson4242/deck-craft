# Deck Craft

![Deck Craft](assets/deck-craft.svg)

An open-source DJ application built around professional workflows, reliable performance, and community ownership.

**Current milestone: a ground-up DJ-software console redesign over the customizable component canvas and Linux native desktop preview.** One console shows four deck waveform lanes, two deck panels, a four-channel mixer and the collection; **Build** restyles the component canvas with the same look. Browse local files/folders, build crates and ordered playlists, and play/pause/seek through the separate Rust audio engine. Native channel strips now process gain, three-band EQ and sweep filters, alongside levels and the A/B crossfader.

**Omarchy is the first target:** user-local installation and native Wayland window launch have been verified on the target desktop, with the native engine reporting audio ready. Full file-chooser/portal interaction, physical audible output and hardware latency still need acceptance there. This is not yet a Serato/Traktor replacement. FX, loops, key detection, headphone cue routing and controller integration are **not implemented**; those controls are disabled in the desktop app. Gain, full-kill three-band EQ, the sweep filter, stereo peak meters, L/THRU/R crossfader assignment, tempo, pitch lock, beat-grid sync and the master/slave tempo link are real native controls.

## Run the native desktop preview

Build prerequisites: Linux x86-64, Node.js >=22.12, Rust >=1.87, a C toolchain, pkg-config and ALSA development headers. Runtime needs the normal compatible Electron desktop libraries and an ALSA default output; PipeWire can provide that output through its ALSA integration. No system package installation is performed automatically.

```sh
npm ci
node node_modules/electron/install.js
npm run build:desktop
npm run desktop
```

The application opens an ordinary desktop window, not a browser tab. Choose **Add files** (multiple selections) or **Add folder** (including subfolders) to populate your library without changing any deck. Library rows show artwork, title, measured BPM and time; click a row to select it (Ctrl/⌘-click or Space adds to the selection). **Drag a local track** from the library onto any deck face or waveform (the console's four waveform lanes, the visible deck panels, and Build's deck and waveform components), or select its row and press **Alt+A/B/C/D**, or press a deck panel's **LOAD** chip to load the selected row; then press that deck's **Play**. Every one of these is the same load action: the deck stays paused, nothing starts, and a drop on anything else, or from outside the app, does nothing. Demo fixtures in the desktop library cannot be dragged. **Open file → Deck A/B/C/D** remains a shortcut for a single file. Imported files stay on the filesystem you selected; no music is uploaded or copied into this repository. Newly loaded and restored tracks are paused. The desktop library defaults to your local tracks; synthetic demo fixtures have their own non-playable collection.

### Your music, crates and playlists

- Use **New crate** for a named collection or **New playlist** for an ordered set. Click a track row (Ctrl/⌘-click or Space toggles multiple selections), choose the **Add to** destination, and click **Add selected**. A track may belong to several collections without duplicating the source file.
- Choose a collection to view its tracks. Rename/delete collections, remove selected membership, or use the playlist's up/down arrows to save a different order. Playlists are preparation lists, **not automatic continuous playback**.
- Search by filename, or sort by title/duration; playlist order is a separate sort choice. Artist/tag extraction, live folder watching and portable playlist-file export are not implemented.
- Tracks, collection names/membership/order, selected collection and sort choice survive restart. Deck restoration stays paused. Removing an entry or collection never deletes original music. A selected/loaded/loading track cannot be removed from the library until a different source is loaded into its decks, even when the audio output is unavailable or the engine has reconnected.
- Audio output status is in **Settings** (cog, top right); a band under the header appears only while output is unavailable. A ready engine is not proof of audible speakers: load your own track and verify your system output. Library import/organization also works with an unavailable output device; transport remains disabled. Import still requires the installed native decoder.
- Each import is bounded to 1,000 candidate audio files, 20,000 traversed entries and bounded folder depth. Symlinks are skipped. A summary reports duplicates, skipped/failed files and truncated batches; use smaller folders if the limit is reached. The library supports at most 200 collections and 20,000 total memberships, within the shared persistence budget below. Selection actions operate on up to 1,000 tracks at a time.

### Mixer: gain, EQ and filter (native desktop)

Every deck A–D has GAIN, HI, MID, LOW and FILTER knobs in the console mixer and Build mixer components, plus the channel level fader; each channel can follow L, R or THRU at the crossfader. Knobs are saved as 0–100 with **50 = neutral**; the real values are shown on hover/focus and spoken to screen readers. Double-click a knob (or press Delete/Backspace on it) to return it to 50.

| Knob | 0 | 50 | 100 |
| --- | --- | --- | --- |
| GAIN | −12 dB | 0 dB | +12 dB |
| HI (above 2.5 kHz crossover) | KILL | 0 dB | +12 dB |
| MID (250 Hz–2.5 kHz crossovers) | KILL | 0 dB | +12 dB |
| LOW (below 250 Hz crossover) | KILL | 0 dB | +12 dB |
| FILTER (12 dB/octave, Q 0.8) | low-pass at 100 Hz | **off (exact bypass)** | high-pass at 12 kHz |

Click HI, MID or LOW to kill that band, then click again to restore its previous knob value. Zero removes that band's contribution exactly; all three kills settle to digital silence. The phase-aligned 24 dB/octave Linkwitz-Riley crossover split at 250 Hz / 2.5 kHz has flat magnitude at neutral, with phase rotation. Adjacent bands overlap near the crossovers, so a single kill is not a brick-wall frequency filter. Nonzero EQ retains the existing nominal −24…+12 dB taper; gain retains −12…+12 dB.

The sweep filter remains a low-pass from 20 kHz→100 Hz below centre and a high-pass from 20 Hz→12 kHz above centre, with exact bypass at 50. Changes are smoothed. A paused edit snaps on resume; settings survive seek, reload, end/restart, deck pairs and Build. Saved settings and kill memories restore before paused sources.

Native stereo peak meters read after EQ, sweep filter, trim and channel fader, before crossfader/master headroom. A faded-out playing channel still meters; paused, ended and offline channels are silent. These are peak meters, not calibrated analog VU/loudness measurements. Each channel independently selects L, R or THRU; A/B default L/R, C/D keep THRU until assigned. Assignments persist.

The per-deck safety bound and conservative master headroom remain; the four-deck sum is not limited. FX, headphone cue and master EQ/limiter are not implemented. All native mixer controls wait for a connected, restored engine.

The native engine uses Rodio/CPAL and a bounded PCM ring per deck. File reads, decoding and seek preparation happen on workers, not in the device-facing PCM iterator. Transport positions are based on native media frames consumed, not a browser animation timer. A requested 512-frame device buffer is not a measured hardware-latency guarantee.

## Test native audio without installation

`npm run package:preview` builds a standalone Linux x86-64 archive containing the app and a checksum-verified official Electron runtime. For reviewed development source, use `npm run package:preview -- --allow-dirty`. Extract the generated archive from `release/` and run `./start-preview` as your desktop user. It requires the same Linux desktop/audio libraries as the normal app, but no installer, runtime download, sudo or menu registration.

The preview uses its own release-specific `deck-craft-preview/<release>/` application configuration directory and instance lock, so it can run beside the installed app without changing its library or saved session. Its title identifies it as a preview. Import your own files in the preview; they stay at their original locations. Choose your desktop output, then explicitly press Play to hear actual native tempo, pitch lock and beat sync. The archive includes test steps and a file-integrity manifest. The browser build (see [Browser audio](#browser-audio-and-design-history)) is separate: it plays through the browser's own audio engine, not this native engine.

## User-local installation

```sh
npm run package:desktop
```

Packaging requires a clean, reviewed source tree and a completed desktop build. It creates `release/deck-craft-0.3.1-linux-x64.tar.gz` and a SHA-256 sidecar. Extract the archive and run `python3 install.py` as your desktop user, **not sudo**.

The small package contains the application and native engine. Its installer downloads the pinned official Electron runtime over HTTPS and verifies its SHA-256 before installing it. For an offline install, provide the exact runtime ZIP with `--runtime-zip /path/to/the/verified.zip`.

Only user-local locations are used:

- `~/.local/share/deck-craft/`: versioned releases and an atomic `current` link.
- `~/.local/bin/deck-craft`: launcher.
- `~/.local/share/applications/deck-craft.desktop`: menu entry.
- The platform's application configuration directory: private local library and session state.

An update does not kill a running copy, delete music or clear preferences. Restart the app to use the new release. Roll back with:

```sh
python3 ~/.local/share/deck-craft/installer.py --rollback
```

The installer refuses unrelated launchers, invalid package/runtime checksums and unsafe paths. See [native architecture and acceptance](docs/NATIVE-DESKTOP.md).

### Uninstall (keep music and preferences)

Quit Deck Craft and wait for it to exit; do not uninstall during an install/update/rollback. As the same desktop user, **without sudo**, inspect the following three paths in a file manager with hidden files visible:

1. `~/.local/share/deck-craft/`: it must be the real managed installation directory, not a symlink. Its regular `.managed` file must contain exactly `deck-craft-installer-v1` followed by a newline. Inspect its contents and stop if you put any music or unrelated files there.
2. `~/.local/bin/deck-craft`: it must be the regular launcher with `# deck-craft-managed`, executing `$HOME/.local/share/deck-craft/current/deck-craft`.
3. `~/.local/share/applications/deck-craft.desktop`: it must be the regular menu entry with `# deck-craft-managed` and an `Exec` targeting that launcher.

If a path or its parent has been redirected through an unexpected symlink, or ownership/content does not match, stop and resolve that discrepancy rather than deleting it. After those checks, delete **only the two launcher files and the managed `~/.local/share/deck-craft/` directory** (including its releases/runtime cache). Do not follow the `current` link to delete some other directory, delete a parent directory, or use wildcards. No system packages or services need removal. This removes all installed releases, so rollback is no longer available; reinstalling a verified package is the recovery path.

Selected music remains at its original location and is untouched. Private library IDs, session state and preferences are retained by default in the application configuration directory, separate from the installation. For optional, deliberate state deletion, see [removing private user state](docs/NATIVE-DESKTOP.md#deliberately-remove-private-user-state-optional).

## One session, one console

The console has three workspaces in the top bar: **Perform** (four waveform lanes, two deck panels, the mixer and the collection), **Library** (the collection alone) and **Build** (the component canvas). Decks are A·B or C·D on the console; the pair selector in the mixer switches between them, and all four mixer channels and waveform lanes stay visible. Deck identities are cyan A, pink B, amber C and violet D. These colors identify decks; they do not represent frequency analysis or measured signal levels.

Switching workspace, deck pair, pad bank or theme never reloads audio or creates another engine. Theme, loaded local-track IDs, positions and manual cues persist on this device. Sessions saved under the five earlier layouts restore into the console. Restoring a session never starts playback. Missing or changed files produce errors, not silent substitution with a demo track.

### Compact header and Settings

The top of every workspace and the custom canvas is one slim bar: the Deck Craft brand with its version, **Perform / Library / Build**, an inline status slot and a **Settings** cog at the right. When Settings is closed nothing else occupies the top; the workspace starts directly under the bar. Settings opens a dialog (click or Enter/Space on the cog) that holds the remaining session controls:

- **Session:** the one-session / four-deck note, native-audio status and **Theme**.
- **Audio and files** (desktop app): audio status, **Reconnect audio** (only while output is unavailable), **Add files to library** and **Open file → Deck N**.
- **Tools:** **Effects and cues**.

Esc, the ✕ button or a click outside closes the dialog and returns focus to the cog; Tab stays inside it while it is open. Changing theme keeps the dialog open; opening effects or a file action closes it first. None of this reloads the document, restarts audio or changes musical state. Audio-output errors and save/restore warnings keep their own band, shown only while relevant.

### Build your own workspace

Choose **Build** for an initially empty canvas. Click/drag components from the drawer, drag a title bar to move a component and grab **any edge or corner** (all eight directions, with matching resize cursors) to resize it; Alt plus the arrow keys on a focused title bar also resize by one grid step. Select a component to get compact Duplicate, Save and Remove actions. There is no properties inspector: the canvas uses that width, and component internals keep their current content, sections and bindings; **Theme all** restyles every component. Save reusable components and workspace presets. **Perform** locks layout editing; **Edit** unlocks it. The console stays available in Perform, with editable starter arrangements (Console and Two decks) in the builder.

**AI creator kit** exports a design starter, exact versioned schemas, examples, capability reference and standalone validator for any external agent. Paste/open the generated JSON, validate and preview it, then explicitly apply it. This first stage styles existing controls only: no executable plugins or new audio behavior. Effects remain disabled placeholders. Removing a component removes its view, never its playing source. See [custom canvas and agent workflow](docs/CUSTOM-CANVAS.md).

### Themes

Three themes share one set of tokens (surfaces, borders, three text tones, interface accent, deck hues): **Night** (default), **Ember** and **Studio** (light). The application theme applies to the whole console; on the custom canvas each component can follow it or choose its own. The deck identity hues and the dark waveform glass keep their meaning in every theme (Studio uses darker shades of the same hues for legibility). No text renders below 10 px (`python3 scripts/min-text.py`). Free colors, radius, density and scale are not configurable.

### The deck panel and waveform lanes

Each deck has a waveform lane (scrolling detail with a fixed playhead, cue flags and, where a beat grid was measured, beat marks; plus a seekable full-track overview) and a panel with a progress ring and jog-style platter, transport, a vertical tempo slider, the MASTER / PITCH LOCK / LOAD chips and an eight-pad bank. The pad bank shows four manual cues (slots 5–8 are reserved and disabled) or loop lengths; ROLL, SLICER, loop in and loop out stay disabled. In the desktop app Play, seek, cue positions, tempo (±8%), pitch lock, MASTER, SYNC, gain, full-kill EQ, filter, channel levels and crossfader assignment reach the engine, and native peak meters show actual signal; the BPM readout follows the tempo slider. Loops, channel cue and FX remain disabled. In the in-browser audio backend only Play, seek, cues, levels, the crossfader, tempo, pitch lock (where supported), MASTER and SYNC are real; gain, EQ, filter, meters and assignment stay disabled and say so.

Imported files draw their decoded PCM peaks. Their three nested contours follow **amplitude only** and are tinted by deck; this is a design treatment, not low/mid/high-frequency analysis. Synthetic demo decks use a labeled deterministic fixture. A local file without peaks draws no waveform.

Waveforms are painted for the interval actually on screen, one column per device pixel (up to 4,096 columns per canvas), so zooming never stretches a few thin strokes across gaps. Each time a track is loaded the native engine measures a finer envelope from the same decoded PCM — about 64 bins per second (at most 32,768 bins per track, so very long tracks are coarser), each with an 8-bit **peak** and **RMS** value. The peak sets the outline and the RMS sets the lighter inner core, which keeps heavily compressed masters from reading as a solid block. Digital silence (below about −54 dBFS (half an 8-bit step)) draws nothing, and a single loud bin stays visible at every zoom. The finer envelope is session-only: it is not saved in the private library, so persistence stays at the existing 512 peaks per track. Until it arrives (or if the engine is unavailable) the persisted 512 peaks are drawn, smoothly interpolated for display; at deep zoom that view is coarse because it carries about one value per 0.5 s of a four-minute track.

Imported waveforms show decoded PCM amplitude, with detected beat-grid lines when available; waveform colors are not frequency analysis. Local-track BPM is measured offline. Key remains unavailable. Embedded JPEG/PNG artwork is converted into a small private thumbnail; tracks without supported embedded art use a labeled placeholder.

Hover a main waveform and **scroll up to zoom in, down to zoom out** (1×–32×). This works on the console lanes and on the custom canvas. Zoom follows the playhead and keeps cue flags and timeline seeking aligned; it does not seek, change tempo or affect audio. The small full-track overview stays unzoomed for navigation. Zoom is a temporary per-deck view preference retained across layout changes in the open app, not saved across restarts. Zoom shows more of the measured peak/RMS bins; it never interpolates new detail or adds analysis. Horizontal trackpad scrolling and Ctrl/Command-wheel gestures are left alone.

Grab a main waveform and drag left to scrub later in the track, or right to scrub earlier. Scrub sensitivity follows that waveform's actual wheel-zoom level; its **+ / −** buttons and keyboard +/− change the same viewport. Focus the waveform to use arrows, Shift/Page Up/Down for larger nudges, or Home/End. Zoomed timelines still support click-to-seek at the drawn position; fixed-playhead details ignore a plain tap. The full-track overview keeps its direct seek control.

A paused pointer drag previews until one seek on release and stays paused. A playing drag coalesces interim seeks, allowing only one request in flight, then sends the final release target. Cancellation, view replacement, focus loss, a newer transport/load action or engine failure discard queued targets and clear the preview; an already submitted seek may have completed. This is seeking, not scratch audio or time stretching. Native consumed frames remain the clock: approximately 60 receipts per second while playing, with slower preparation and idle heartbeats. Cached transport painting runs at animation-frame cadence without refreshing the library or Settings on every receipt; it never extrapolates an audio clock.

The private library is bounded by 10,000 records **and 16 MiB of serialized UTF-8 JSON**, whichever is reached first; waveforms, paths and collections share that budget. Save/restore use the same limits. At capacity, a visible warning reports that imports/metadata were not saved; playback can continue in the current session, while the previous durable library is left intact. Unsaved imports/metadata will not survive restart. Collection edits and library removals roll back in memory if their save fails. Waveform values are not fabricated or reduced to fit the budget. Existing version-1 libraries are supported. Before rolling back to a pre-0.3 app, back up private state separately: older apps do not preserve collection metadata when they next save the library.

### BPM, tempo, sync and pitch lock

Imports analyze up to the first 60 seconds of decoded audio without opening an output device. The detector estimates one constant grid from onset periodicity between 60 and 200 BPM; silence, short files and weak/ambiguous periodicity return an unavailable BPM. Half/double-tempo errors and variable-tempo music remain possible; this is not downbeat or musical-key classification. Existing saved tracks can use **Analyze BPM / artwork** (selected rows, or the current collection when no rows are selected), or receive analysis when loaded. Analysis and thumbnails stay in the private library and share its capacity limit.

The tempo slider changes playback speed within **−8% to +8%**. **Pitch lock** is enabled by default and uses worker-side waveform-similarity overlap-add to preserve pitch; switching it off gives ordinary speed/pitch change. This is a basic time stretcher, not an artifact-free professional algorithm. The bounded output queue can delay a setting change by roughly 100 ms, in addition to device buffering. Positions, cues and seeks remain source-media positions.

Choose **MASTER** on a loaded deck, then **SYNC** on another analyzed deck. Sync matches effective BPM and aligns beat phase while preserving whether the target was playing or paused. It rejects unavailable grids, an unchanged master that cannot be confirmed during preparation, and rates outside the slider range. Linked decks follow subsequent master tempo changes within range. Resync after separate starts, pauses, seeks or source changes; sync does not infer musical downbeats or start a paused deck. Native receipts own all transport/settings, and reopening always restores paused.

Embedded artwork is limited to JPEG/PNG images no larger than 2 MiB and 2048 pixels per dimension, re-encoded as a metadata-free 64×64 PNG. Missing, malformed, oversized or unsupported artwork falls back honestly. No external image URL or source path enters the renderer.

## Browser audio and design history

`npm run build` creates `dist/deck-craft.html`. In a browser with media-element and Web Audio support it plays files you choose in that browser, on that device: multi-file import, waveform/BPM/beat-grid/artwork analysis, four-deck play/pause/seek, levels and crossfader, tempo ±8%, pitch lock where the browser supports it, and explicit master + Sync. Files stay in the browser (bounded IndexedDB storage with visible quota warnings, or session-only and marked as such); there is no upload, server or account. It works from a plain-HTTP LAN address because it needs no secure-context-only API. Elsewhere it falls back to the silent synthetic UI and says why. This is a browser engine, not the native Rust/Omarchy engine: latency and target-machine acceptance are not claimed. See [docs/BROWSER-AUDIO.md](docs/BROWSER-AUDIO.md). Gain, EQ, the sweep filter, meters and crossfader assignment are native-only and stay disabled in the browser engine. Source UI development can use `python3 -m http.server 4785 --bind 127.0.0.1`; never expose that development file server to a network without a separate review, and treat any plain-HTTP preview as unauthenticated.

The [Round 03 comparison](designs/round-three/deck-craft-refinements-03.html), [Round 02 exploration](designs/round-two/deck-craft-studies-02.html) and historical [Round 01 comparison](designs/deck-craft-comparison.html) are preserved unchanged.

The new [Precision / Performance visual comparison](sketches/006-console-comparison/index.html) explores two treatments of the same Studio Sync workspace. Open it directly in a browser and switch A/B without resetting the mock session; Empty, Loaded and Playing provide state presets. These offline, synthetic, no-audio studies do not change the desktop app or select a replacement for any of its five layouts.

## Verification

```sh
npm test
npm run test:rust
python3 -m unittest discover -s tests -p 'test_installer.py' -v
npm run build
node --check dist/bundle-check.mjs
npm run test:browser
npm run test:canvas
python3 scripts/check_publication.py
```

Native tempo/beat/artwork signal integration is available as `npm run test:tempo` with the same isolated-sink environment. It captures both speed/pitch modes, source clocks, beat phase, native rejection paths and generated embedded artwork. Any inserted output-driver silence is recorded separately from signal-bearing duration.

Native signal/desktop integration additionally uses an explicitly configured isolated audio sink, private display, D-Bus and XDG state. It never implicitly plays through a physical output. The default desktop test injects only the OS file-selection result; decoding, playback, seek, layouts, private persistence and restart use the actual native engine. The real native chooser is a separate opt-in platform test. See [native verification](docs/NATIVE-DESKTOP.md) and the earlier [UI verification](docs/APP-VERIFICATION.md).

## Contributing and safety

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and `AGENTS.md`. Only original or appropriately licensed code/assets belong here. Dependency licenses remain applicable; packaged native dependency notices and the official runtime notices are retained. Keep private endpoints, credentials, actual music, browser profiles, runtime state and operational receipts out of public source.
