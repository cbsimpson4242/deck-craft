# Deck Craft

![Deck Craft](assets/deck-craft.svg)

An open-source DJ application built around professional workflows, reliable performance, and community ownership.

**Current milestone: the approved reference-style deck face across every layout, over the customizable component canvas and Linux native desktop preview.** Assemble and style existing decks, mixer, browser and smaller parts; save reusable components/workspaces and export a self-contained AI-agent creator kit. Browse local files/folders, build crates and ordered playlists, and play/pause/seek through the separate Rust audio engine. All five approved layouts remain available over the same four-deck session.

**Omarchy is the first target:** user-local installation and native Wayland window launch have been verified on the target desktop, with the native engine reporting audio ready. Full file-chooser/portal interaction, physical audible output and hardware latency still need acceptance there. This is not yet a Serato/Traktor replacement. EQ, FX, loops, sync, beat/key detection, time stretching, signal meters, headphone routing and controller integration are **not implemented**; those controls are disabled in the desktop app.

## Run the native desktop preview

Build prerequisites: Linux x86-64, Node.js >=22.12, Rust >=1.87, a C toolchain, pkg-config and ALSA development headers. Runtime needs the normal compatible Electron desktop libraries and an ALSA default output; PipeWire can provide that output through its ALSA integration. No system package installation is performed automatically.

```sh
npm ci
node node_modules/electron/install.js
npm run build:desktop
npm run desktop
```

The application opens an ordinary desktop window, not a browser tab. Choose **Add files** (multiple selections) or **Add folder** (including subfolders) to populate your library without changing any deck. Select **Load into** A/B/C/D and use the track's load arrow, then press that deck's **Play**. **Open file → Deck A/B/C/D** remains a shortcut for a single file. Imported files stay on the filesystem you selected; no music is uploaded or copied into this repository. Newly loaded and restored tracks are paused. The desktop library defaults to your local tracks; synthetic demo fixtures have their own non-playable collection.

### Your music, crates and playlists

- Use **New crate** for a named collection or **New playlist** for an ordered set. Select tracks, choose the **Add to** destination, and click **Add selected**. A track may belong to several collections without duplicating the source file.
- Choose a collection to view its tracks. Rename/delete collections, remove selected membership, or use the playlist's up/down arrows to save a different order. Playlists are preparation lists, **not automatic continuous playback**.
- Search by filename, or sort by title/duration; playlist order is a separate sort choice. Artist/tag extraction, live folder watching and portable playlist-file export are not implemented.
- Tracks, collection names/membership/order, selected collection and sort choice survive restart. Deck restoration stays paused. Removing an entry or collection never deletes original music. A selected/loaded/loading track cannot be removed from the library until a different source is loaded into its decks, even when the audio output is unavailable or the engine has reconnected.
- Audio output status appears above the workspace. A ready engine is not proof of audible speakers: load your own track and verify your system output. Library import/organization also works with an unavailable output device; transport remains disabled. Import still requires the installed native decoder.
- Each import is bounded to 1,000 candidate audio files, 20,000 traversed entries and bounded folder depth. Symlinks are skipped. A summary reports duplicates, skipped/failed files and truncated batches; use smaller folders if the limit is reached. The library supports at most 200 collections and 20,000 total memberships, within the shared persistence budget below. Selection actions operate on up to 1,000 tracks at a time.

The native engine uses Rodio/CPAL and a bounded PCM ring per deck. File reads, decoding and seek preparation happen on workers, not in the device-facing PCM iterator. Transport positions are based on native media frames consumed, not a browser animation timer. A requested 512-frame device buffer is not a measured hardware-latency guarantee.

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

## One session, five layouts

All five layouts use the selected **Performance console** visual treatment: dark surfaces, larger transport clocks and stable deck identities (A lime, B cyan, C amber, D violet). These colors identify decks; they do not represent frequency analysis or measured signal levels.

Use the **Layout** dropdown:

- **Signal One** — two decks, track overviews, cue banks and side mixer.
- **Signal Wide** — expanded overviews and lower mixing dock.
- **Studio Grid** — collection beside four decks.
- **Studio Linear** — collection beside four horizontal deck lanes.
- **Studio Sync** — pair overviews above four decks; the default. Its name does not imply implemented beat synchronization.

A layout switch never reloads audio or creates another engine. C/D remain present in two-deck views, with status and quick access. Layout, loaded local-track IDs, positions and manual cues persist on this device. Restoring a session never starts playback. Missing or changed files produce errors, not silent substitution with a demo track.

### Build your own workspace

Choose **Customize** or **Layout → Custom canvas** for an initially empty canvas. Click/drag components from the drawer, move their title bars, resize their corners and use the inspector to change colors, corners, density, scale and deck bindings. Save reusable styled components and workspace presets. **Perform** locks layout editing; **Edit** unlocks it. The original Studio Sync default and all five original views are preserved, with editable starter arrangements also available in the builder.

**AI creator kit** exports a design starter, exact versioned schemas, examples, capability reference and standalone validator for any external agent. Paste/open the generated JSON, validate and preview it, then explicitly apply it. This first stage styles existing controls only: no executable plugins or new audio behavior. Effects remain disabled placeholders. Removing a component removes its view, never its playing source. See [custom canvas and agent workflow](docs/CUSTOM-CANVAS.md).

### Themes

Five themes share one ten-token set (surfaces, borders, three text tones, interface accent): **Graphite** (default), **Midnight**, **Ember**, **Orchid** and **Daylight**. The application theme applies to all five layouts; on the custom canvas each component can follow it or choose its own. The Play button, cue blue, deck identity colors and the dark waveform glass do not change with a theme (Daylight uses darker shades of the same deck hues for legibility). No text renders below 10 px. Free color, radius, scale and density controls no longer exist; version 1 designs and canvases still open and convert to themes. Contrast minimums are enforced by tests.

### The deck face

Every deck in all five layouts and the custom canvas uses one compact face: track information and clocks, a scrolling detail waveform with a fixed playhead and cue flags, a full-track overview with played-region shading, a vertical tempo slider, the transport/loop row, an eight-position cue bank and a cue-editing strip. Slots 5–8 are reserved and disabled because the app stores four manual cues. Real controls: Play, Cue, four manual cues, seek, loop-length preset values and the existing UI flags. **CUP, FLX, REV, SYNC/master behavior, loop IN/OUT/looping, tempo processing, cue-type editing and controller mapping are visibly disabled or UI-state only.**

Imported files draw their decoded PCM peaks. Their red/magenta/violet coloring follows **amplitude only** and is a design palette, not low/mid/high-frequency analysis. Synthetic demo decks use a labeled deterministic fixture. A local file without peaks draws no waveform.

Imported waveforms are decoded PCM amplitude overviews, not beat grids or frequency analysis. BPM/key show an em dash for local tracks until real analysis exists. Artwork is a generated placeholder, not extracted album art.

The private library is bounded by 10,000 records **and 16 MiB of serialized UTF-8 JSON**, whichever is reached first; waveforms, paths and collections share that budget. Save/restore use the same limits. At capacity, a visible warning reports that imports/metadata were not saved; playback can continue in the current session, while the previous durable library is left intact. Unsaved imports/metadata will not survive restart. Collection edits and library removals roll back in memory if their save fails. Waveform values are not fabricated or reduced to fit the budget. Existing version-1 libraries are supported. Before rolling back to a pre-0.3 app, back up private state separately: older apps do not preserve collection metadata when they next save the library.

## Browser-only UI and design history

`npm run build` still creates `dist/deck-craft.html`, an offline browser UI with no audio engine. Do not confuse it with the native desktop package. Source UI development can use `python3 -m http.server 4785 --bind 127.0.0.1`; never expose that development file server to a network without a separate review.

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

Native signal/desktop integration additionally uses an explicitly configured isolated audio sink, private display, D-Bus and XDG state. It never implicitly plays through a physical output. The default desktop test injects only the OS file-selection result; decoding, playback, seek, layouts, private persistence and restart use the actual native engine. The real native chooser is a separate opt-in platform test. See [native verification](docs/NATIVE-DESKTOP.md) and the earlier [UI verification](docs/APP-VERIFICATION.md).

## Contributing and safety

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and `AGENTS.md`. Only original or appropriately licensed code/assets belong here. Dependency licenses remain applicable; packaged native dependency notices and the official runtime notices are retained. Keep private endpoints, credentials, actual music, browser profiles, runtime state and operational receipts out of public source.
