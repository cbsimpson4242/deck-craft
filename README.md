# Deck Craft

![Deck Craft](assets/deck-craft.svg)

An open-source DJ application built around professional workflows, reliable performance, and community ownership.

**Current milestone: a Linux desktop preview with a separate native Rust audio engine.** Import local audio, load a deck, play/pause/seek, store manual cues, change channel levels and use the A/B crossfader. All five approved layouts share the same four-deck session.

**Omarchy is the first target:** user-local installation and ordinary graphical-session launch have been exercised. Native file-chooser/portal behavior, physical output and hardware latency still need acceptance on the target machine. This is not yet a Serato/Traktor replacement. EQ, FX, loops, sync, beat/key detection, time stretching, signal meters, headphone routing and controller integration are **not implemented**; those controls are disabled in the desktop app.

## Run the native desktop preview

Build prerequisites: Linux x86-64, Node.js >=22.12, Rust >=1.87, a C toolchain, pkg-config and ALSA development headers. Runtime needs the normal compatible Electron desktop libraries and an ALSA default output; PipeWire can provide that output through its ALSA integration. No system package installation is performed automatically.

```sh
npm ci
npm run build:desktop
npm run desktop
```

The application opens an ordinary desktop window, not a browser tab. Choose **Import audio → Deck A**, or first change **Load into** to B/C/D. Imported files stay on the filesystem you selected; no music is uploaded or copied into this repository. Newly loaded and restored tracks are paused. Demo rows are explicitly synthetic fixtures without audio.

The native engine uses Rodio/CPAL and a bounded PCM ring per deck. File reads, decoding and seek preparation happen on workers, not in the device-facing PCM iterator. Transport positions are based on native media frames consumed, not a browser animation timer. A requested 512-frame device buffer is not a measured hardware-latency guarantee.

## User-local installation

```sh
npm run package:desktop
```

Packaging requires a clean, reviewed source tree and a completed desktop build. It creates `release/deck-craft-0.2.0-linux-x64.tar.gz` and a SHA-256 sidecar. Extract the archive and run `python3 install.py` as your desktop user, **not sudo**.

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

Imported waveforms are decoded PCM amplitude overviews, not beat grids or frequency analysis. BPM/key show an em dash for local tracks until real analysis exists. Artwork is a generated placeholder, not extracted album art.

The private library is bounded by 10,000 records **and 16 MiB of serialized UTF-8 JSON**, whichever is reached first; waveform and path sizes affect capacity. Save/restore use the same limits. At capacity, a visible warning reports that changes were not saved; playback can continue in the current session, while the previous durable library is left intact. Unsaved imports/metadata will not survive restart. Waveform values are not fabricated or reduced to fit the budget.

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
python3 scripts/check_publication.py
```

Native signal/desktop integration additionally uses an explicitly configured isolated audio sink, private display, D-Bus and XDG state. It never implicitly plays through a physical output. The default desktop test injects only the OS file-selection result; decoding, playback, seek, layouts, private persistence and restart use the actual native engine. The real native chooser is a separate opt-in platform test. See [native verification](docs/NATIVE-DESKTOP.md) and the earlier [UI verification](docs/APP-VERIFICATION.md).

## Contributing and safety

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and `AGENTS.md`. Only original or appropriately licensed code/assets belong here. Dependency licenses remain applicable; packaged native dependency notices and the official runtime notices are retained. Keep private endpoints, credentials, actual music, browser profiles, runtime state and operational receipts out of public source.
