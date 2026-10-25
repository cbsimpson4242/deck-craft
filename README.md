# Deck Craft

![Deck Craft](assets/deck-craft.svg)

An open-source DJ software project built around professional workflows, reliable performance, and community ownership.

**Current milestone: a working application UI foundation with five switchable layouts and one shared four-deck session. No audio engine, actual playback, waveform analysis, effects processing or hardware support is implemented yet.** Serato, Traktor and other professional tools are workflow benchmarks, not affiliations or claims of parity.

## Run the application UI

Requires Node.js 22 or newer. There are no npm dependencies and no install step.

```sh
npm test
npm run build
```

Open `dist/deck-craft.html` in a modern browser. This portable application file contains the same application modules and styles, works offline, and makes no external requests. It is **not** the old prototype comparison and does not embed other pages or iframes.

For source development, serve the repository root on loopback, for example `python3 -m http.server 4785 --bind 127.0.0.1`, and open its `index.html`. Do not expose a development file server to a network without a separate security review.

## One session, five layouts

Use the **Layout** dropdown inside the app:

- **Signal One** — two decks, aligned waveforms, visible cue banks and a side mixer.
- **Signal Wide** — expanded waveform alignment and a lower mixing dock.
- **Studio Grid** — a persistent collection beside a four-deck grid.
- **Studio Linear** — a persistent collection beside four horizontal deck lanes.
- **Studio Sync** — shared pair alignment above four decks; the default.

Switching changes only the view. Loaded demo tracks, positions, cues, loops, pitch, Sync, monitor state, mixer settings, FX settings and collection state remain in the shared model. C/D remain intact in two-deck layouts, with status, transport-state controls and a quick return to four decks. The global mixer exposes all four channels from any layout.

The browser remembers layout and session settings in a versioned, local snapshot. Reload/reopen restores transport **paused**, never auto-started. Preferences are per browser/profile and storage origin; file-URL storage behavior is browser-dependent. Changing browser, URL/origin or file location can use a different store. Nothing is sent to an account or server. Blocked storage leaves the current UI usable and displays an explicit unsaved warning.

## Scope of controls

All tracks, covers and waveforms are original synthetic fixtures. UI transport does not advance from an audio clock or produce sound. Waveforms can seek the UI position but are not track analysis. Mixer/FX controls update shared settings, not DSP. Click a cue pad to seek its position; Shift-click/right-click or use the mixer's cue editor to store the current UI position. Use Load into to choose A/B/C/D before loading a demo track.

There is no personal music import, audio device access, real-time engine, controller mapping, native package, login or network backend in this milestone.

## Verification

```sh
npm test
npm run build
npm run test:browser
python3 scripts/check_publication.py
```

Browser tests additionally require Chromium (`CHROMIUM` may specify its executable). They use a disposable profile, not personal browser state. See [application verification](docs/APP-VERIFICATION.md) and [architecture](docs/APPLICATION.md).

## Preserved design studies

The user approved all five Round 03 layouts as selectable application views. The [Round 03 comparison](designs/round-three/deck-craft-refinements-03.html), [Round 02 exploration](designs/round-two/deck-craft-studies-02.html) and historical [Round 01 comparison](designs/deck-craft-comparison.html) remain unchanged. They are design history, not the application entry point.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and `AGENTS.md`. Original code/assets only; evaluate third-party licenses before reuse. The MIT license applies to this repository, not to any future dependency whose license must be separately respected. Keep private deployment details, credentials, personal music, browser state and operational receipts out of public source.
